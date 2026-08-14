import { Pool, PoolClient } from 'pg';
import {
  AppError,
  notFound,
  uuidv7,
  D,
  BUDGET_CONTROL_POLICIES,
  assertEntityPermission,
  type TenantPrincipal,
} from '@acct/domain';
import { writeInTenant, readInTenant, recordAudit, publish } from '@acct/database';
import { computeVariance, type VarianceSourceRow } from './variance';

/**
 * Budgets — doc 10 "Budgets", and two rules that decide everything here:
 *
 * 1. "Never overwrite approved budget. Revision creates a new version while
 *    preserving Original Budget and Current Approved Budget." An approved
 *    budget's lines are immutable (guard_budget_lines_versioned, 0043);
 *    `reviseBudget` copies to version+1 and never touches the old amounts.
 *
 * 2. Phase 5 exit criterion 6: "Budget actuals derive from posted ledger, not
 *    duplicated transaction totals." Every actual figure in this file is a sum
 *    over `journal_lines` joined to POSTED `journal_entries`, computed at read
 *    time. `budget_lines` has `amount` and no `actual_amount`, deliberately: a
 *    stored actual is a number that can disagree with the ledger, and the
 *    ledger is right.
 */

/** Mirrors the CHECK on budgets.scenario in 0014, exactly. */
const SCENARIOS = new Set(['BASE', 'BEST', 'WORST', 'CUSTOM']);

/** Mirrors `budget_status` in 0000_extensions_and_types.sql, exactly. */
const BUDGET_STATUSES = new Set(['DRAFT', 'REVIEW', 'APPROVED', 'ACTIVE', 'SUPERSEDED', 'CLOSED']);

export interface BudgetLineInput {
  readonly accountingPeriodId: string;
  readonly accountId: string;
  readonly amount: string;
}

/**
 * Per (period, account): the budget's amount and the posted-ledger actual,
 * signed by the account's normal balance so revenue budgets and expense budgets
 * both read as positive consumption instead of asking the reader to remember
 * which sign a credit is.
 */
const VARIANCE_SQL = `
  WITH lines AS (
    SELECT bl.accounting_period_id, bl.account_id, sum(bl.amount) AS budget_amount
      FROM budget_lines bl
     WHERE bl.budget_id = $1
     GROUP BY 1, 2
  )
  SELECT ln.account_id, a.code AS account_code, a.name AS account_name,
         ln.accounting_period_id, p.name AS period_name, p.period_no,
         ln.budget_amount::text AS budget_amount,
         coalesce(act.amount, 0)::text AS actual_amount,
         coalesce(cmt.amount, 0)::text AS open_commitments
    FROM lines ln
    JOIN accounts a ON a.id = ln.account_id
    JOIN accounting_periods p ON p.id = ln.accounting_period_id
    LEFT JOIN LATERAL (
      SELECT sum(CASE WHEN a.normal_balance = 'CREDIT' THEN l.base_credit - l.base_debit
                      ELSE l.base_debit - l.base_credit END) AS amount
        FROM journal_lines l
        JOIN journal_entries e ON e.id = l.journal_entry_id
       WHERE e.status = 'POSTED'
         AND l.accounting_book_id = $2
         AND l.accounting_period_id = ln.accounting_period_id
         AND l.account_id = ln.account_id
    ) act ON true
    LEFT JOIN LATERAL (
      SELECT sum(c.open_amount) AS amount
        FROM commitments c
       WHERE c.accounting_book_id = $2
         AND c.accounting_period_id = ln.accounting_period_id
         AND c.account_id = ln.account_id
         AND c.status IN ('OPEN','PARTIALLY_RELIEVED')
    ) cmt ON true
   ORDER BY p.period_no, a.code`;

export class BudgetsService {
  constructor(private readonly pool: Pool) {}

  async createBudget(
    principal: TenantPrincipal,
    input: {
      legalEntityId: string;
      accountingBookId: string;
      fiscalYearId: string;
      name: string;
      currency: string;
      scenario?: string | undefined;
      controlPolicy?: string | undefined;
      controlThresholdPct?: string | null | undefined;
      ownerUserId?: string | null | undefined;
      lines: readonly BudgetLineInput[];
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      assertEntityPermission(principal, 'budget.create', input.legalEntityId);

      const scenario = input.scenario ?? 'BASE';
      if (!SCENARIOS.has(scenario)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `"${scenario}" is not a budget scenario: ${[...SCENARIOS].join(', ')}.`,
        );
      }
      const controlPolicy = input.controlPolicy ?? 'INFORMATIONAL';
      if (!(BUDGET_CONTROL_POLICIES as readonly string[]).includes(controlPolicy)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `"${controlPolicy}" is not a budget control policy: ` +
            `${BUDGET_CONTROL_POLICIES.join(', ')}.`,
        );
      }
      // Lines arrive with the header because there is no add-line route, and
      // once approved the lines are frozen — a budget created empty could never
      // become anything but an empty approved budget.
      if (input.lines.length === 0) {
        throw new AppError('VALIDATION_FAILED', 'A budget needs at least one line.');
      }

      await this.validateLines(client, {
        legalEntityId: input.legalEntityId,
        fiscalYearId: input.fiscalYearId,
        lines: input.lines,
      });

      const id = uuidv7();
      const { rows } = await client.query(
        `INSERT INTO budgets
           (id, tenant_id, legal_entity_id, accounting_book_id, fiscal_year_id, name, version,
            scenario, currency, control_policy, control_threshold_pct, owner_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9::budget_control_policy,$10::numeric,$11)
         RETURNING id, legal_entity_id, accounting_book_id, fiscal_year_id, name, version,
                   scenario, currency, status::text AS status, control_policy::text AS control_policy,
                   control_threshold_pct::text AS control_threshold_pct, owner_user_id,
                   supersedes_budget_id, created_at`,
        [
          id,
          principal.tenantId,
          input.legalEntityId,
          input.accountingBookId,
          input.fiscalYearId,
          input.name,
          scenario,
          input.currency,
          controlPolicy,
          input.controlThresholdPct ?? null,
          input.ownerUserId ?? null,
        ],
      );

      await this.insertLines(client, {
        budgetId: id,
        tenantId: principal.tenantId,
        legalEntityId: input.legalEntityId,
        currency: input.currency,
        lines: input.lines,
      });

      await publish(client, context, {
        eventType: 'budget.created',
        aggregateType: 'budget',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: input.legalEntityId,
        accountingBookId: input.accountingBookId,
        payload: { name: input.name, version: 1, line_count: input.lines.length },
      });
      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        action: 'budget.created',
        resourceType: 'budget',
        resourceId: id,
        after: rows[0] as Record<string, unknown>,
      });

      return { ...rows[0], line_count: input.lines.length };
    });
  }

  /** F-814: `{ data }`, never a bare array — see BankAccountsService.listAccounts. */
  async listBudgets(
    principal: TenantPrincipal,
    query: {
      legalEntityId?: string | undefined;
      accountingBookId?: string | undefined;
      fiscalYearId?: string | undefined;
      status?: string | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      if (query.status && !BUDGET_STATUSES.has(query.status)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `"${query.status}" is not a budget status: ${[...BUDGET_STATUSES].join(', ')}.`,
        );
      }
      const { rows } = await client.query(
        `SELECT b.id, b.legal_entity_id, b.accounting_book_id, b.fiscal_year_id, b.name,
                b.version, b.scenario, b.currency, b.status::text AS status,
                b.control_policy::text AS control_policy,
                b.control_threshold_pct::text AS control_threshold_pct,
                b.supersedes_budget_id, b.approved_by, b.approved_at, b.created_at,
                (SELECT coalesce(sum(l.amount), 0)::text FROM budget_lines l
                  WHERE l.budget_id = b.id) AS total_amount,
                (SELECT count(*) FROM budget_lines l WHERE l.budget_id = b.id)::int AS line_count
           FROM budgets b
          WHERE ($1::uuid IS NULL OR b.legal_entity_id = $1)
            AND ($2::uuid IS NULL OR b.accounting_book_id = $2)
            AND ($3::uuid IS NULL OR b.fiscal_year_id = $3)
            AND ($4::budget_status IS NULL OR b.status = $4::budget_status)
          ORDER BY b.name, b.version DESC`,
        [
          query.legalEntityId ?? null,
          query.accountingBookId ?? null,
          query.fiscalYearId ?? null,
          query.status ?? null,
        ],
      );
      return { data: rows };
    });
  }

  /**
   * DRAFT/REVIEW → ACTIVE. ACTIVE rather than APPROVED because ACTIVE is what
   * doc 10 calls the "Current Approved Budget" — the version budget control and
   * variance read — and `budgets_one_active_idx` holds there to exactly one per
   * (entity, book, name). Any version currently ACTIVE under the same name is
   * superseded FIRST: the partial unique index sees each row as it changes, so
   * activating before superseding would trip it mid-transaction.
   */
  async approveBudget(principal: TenantPrincipal, id: string) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows: existing } = await client.query<{
        id: string;
        legal_entity_id: string;
        accounting_book_id: string;
        name: string;
        version: number;
        status: string;
      }>(
        `SELECT id, legal_entity_id, accounting_book_id, name, version, status::text AS status
           FROM budgets WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const budget = existing[0];
      if (!budget) throw notFound('budget', id);
      assertEntityPermission(principal, 'budget.approve', budget.legal_entity_id);

      if (budget.status !== 'DRAFT' && budget.status !== 'REVIEW') {
        throw new AppError(
          'VALIDATION_FAILED',
          `Budget ${budget.name} v${budget.version} is ${budget.status}; only a DRAFT or ` +
            'REVIEW budget can be approved. A change to an approved budget is a revision (doc 10).',
        );
      }

      const { rows: superseded } = await client.query<{ id: string; version: number }>(
        `UPDATE budgets SET status = 'SUPERSEDED'
          WHERE legal_entity_id = $1 AND accounting_book_id = $2 AND name = $3
            AND status = 'ACTIVE' AND id <> $4
        RETURNING id, version`,
        [budget.legal_entity_id, budget.accounting_book_id, budget.name, id],
      );

      const { rows } = await client.query(
        `UPDATE budgets SET status = 'ACTIVE', approved_by = $2, approved_at = now()
          WHERE id = $1
        RETURNING id, legal_entity_id, accounting_book_id, fiscal_year_id, name, version,
                  scenario, currency, status::text AS status, control_policy::text AS control_policy,
                  supersedes_budget_id, approved_by, approved_at`,
        [id, principal.userId],
      );

      for (const old of superseded) {
        await publish(client, context, {
          eventType: 'budget.superseded',
          aggregateType: 'budget',
          aggregateId: old.id,
          tenantId: principal.tenantId,
          legalEntityId: budget.legal_entity_id,
          accountingBookId: budget.accounting_book_id,
          payload: { superseded_by: id, version: old.version },
        });
      }
      await publish(client, context, {
        eventType: 'budget.approved',
        aggregateType: 'budget',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: budget.legal_entity_id,
        accountingBookId: budget.accounting_book_id,
        payload: { name: budget.name, version: budget.version },
      });
      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        action: 'budget.approved',
        resourceType: 'budget',
        resourceId: id,
        before: budget as unknown as Record<string, unknown>,
        after: rows[0] as Record<string, unknown>,
      });

      return rows[0];
    });
  }

  /**
   * doc 10: "Never overwrite approved budget. Revision creates a new version
   * while preserving Original Budget and Current Approved Budget."
   *
   * So: the old version and its lines are never edited — they stay as the
   * record of what was approved, reachable through `supersedes_budget_id` back
   * to version 1, the Original Budget. The new version is born DRAFT (so
   * `budgets_one_active_idx` cannot be violated at any point in this
   * transaction) and must go through `approveBudget` like any other, because a
   * revision that skipped approval would be an unapproved number wearing an
   * approved budget's name.
   */
  async reviseBudget(
    principal: TenantPrincipal,
    id: string,
    input: {
      scenario?: string | undefined;
      controlPolicy?: string | undefined;
      controlThresholdPct?: string | null | undefined;
      ownerUserId?: string | undefined;
      /** Replaces the line set entirely when given; omitted means copy the old lines. */
      lines?: readonly BudgetLineInput[] | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows: existing } = await client.query<{
        id: string;
        legal_entity_id: string;
        accounting_book_id: string;
        fiscal_year_id: string;
        name: string;
        version: number;
        scenario: string;
        currency: string;
        status: string;
        control_policy: string;
        control_threshold_pct: string | null;
        owner_user_id: string | null;
      }>(
        `SELECT id, legal_entity_id, accounting_book_id, fiscal_year_id, name, version, scenario,
                currency, status::text AS status, control_policy::text AS control_policy,
                control_threshold_pct::text AS control_threshold_pct, owner_user_id
           FROM budgets WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const old = existing[0];
      if (!old) throw notFound('budget', id);
      assertEntityPermission(principal, 'budget.revise', old.legal_entity_id);

      if (old.status !== 'APPROVED' && old.status !== 'ACTIVE') {
        throw new AppError(
          'VALIDATION_FAILED',
          `Budget ${old.name} v${old.version} is ${old.status}. Revision exists to change an ` +
            'approved budget without overwriting it (doc 10); a draft has nothing to preserve.',
        );
      }

      const scenario = input.scenario ?? old.scenario;
      if (!SCENARIOS.has(scenario)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `"${scenario}" is not a budget scenario: ${[...SCENARIOS].join(', ')}.`,
        );
      }
      const controlPolicy = input.controlPolicy ?? old.control_policy;
      if (!(BUDGET_CONTROL_POLICIES as readonly string[]).includes(controlPolicy)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `"${controlPolicy}" is not a budget control policy: ` +
            `${BUDGET_CONTROL_POLICIES.join(', ')}.`,
        );
      }

      let lines: readonly BudgetLineInput[];
      if (input.lines) {
        if (input.lines.length === 0) {
          throw new AppError('VALIDATION_FAILED', 'A revision needs at least one line.');
        }
        await this.validateLines(client, {
          legalEntityId: old.legal_entity_id,
          fiscalYearId: old.fiscal_year_id,
          lines: input.lines,
        });
        lines = input.lines;
      } else {
        const { rows: oldLines } = await client.query<{
          accounting_period_id: string;
          account_id: string;
          amount: string;
        }>(
          `SELECT accounting_period_id, account_id, amount::text AS amount
             FROM budget_lines WHERE budget_id = $1`,
          [id],
        );
        lines = oldLines.map((l) => ({
          accountingPeriodId: l.accounting_period_id,
          accountId: l.account_id,
          amount: l.amount,
        }));
      }

      const newId = uuidv7();
      // The FOR UPDATE on the old row serializes revisions of the same version;
      // two racing revisions of one budget both computing version+1 resolve as
      // one success and one unique-constraint 409, which is the right answer.
      const { rows } = await client.query(
        `INSERT INTO budgets
           (id, tenant_id, legal_entity_id, accounting_book_id, fiscal_year_id, name, version,
            scenario, currency, control_policy, control_threshold_pct, owner_user_id,
            supersedes_budget_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::budget_control_policy,$11::numeric,$12,$13)
         RETURNING id, legal_entity_id, accounting_book_id, fiscal_year_id, name, version,
                   scenario, currency, status::text AS status, control_policy::text AS control_policy,
                   control_threshold_pct::text AS control_threshold_pct, owner_user_id,
                   supersedes_budget_id, created_at`,
        [
          newId,
          principal.tenantId,
          old.legal_entity_id,
          old.accounting_book_id,
          old.fiscal_year_id,
          old.name,
          old.version + 1,
          scenario,
          old.currency,
          controlPolicy,
          input.controlThresholdPct !== undefined
            ? input.controlThresholdPct
            : old.control_threshold_pct,
          input.ownerUserId ?? old.owner_user_id,
          id,
        ],
      );

      await this.insertLines(client, {
        budgetId: newId,
        tenantId: principal.tenantId,
        legalEntityId: old.legal_entity_id,
        currency: old.currency,
        lines,
      });

      // Superseded, not deleted and not edited: the row and its lines remain
      // exactly as approved (the 0043 guards refuse anything else), which is
      // what makes "what did we approve in March" answerable in December.
      await client.query(`UPDATE budgets SET status = 'SUPERSEDED' WHERE id = $1`, [id]);

      await publish(client, context, {
        eventType: 'budget.revised',
        aggregateType: 'budget',
        aggregateId: newId,
        tenantId: principal.tenantId,
        legalEntityId: old.legal_entity_id,
        accountingBookId: old.accounting_book_id,
        payload: { name: old.name, version: old.version + 1, supersedes: id },
      });
      await publish(client, context, {
        eventType: 'budget.superseded',
        aggregateType: 'budget',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: old.legal_entity_id,
        accountingBookId: old.accounting_book_id,
        payload: { superseded_by: newId, version: old.version },
      });
      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        action: 'budget.revised',
        resourceType: 'budget',
        resourceId: newId,
        before: old as unknown as Record<string, unknown>,
        after: rows[0] as Record<string, unknown>,
      });

      return { ...rows[0], line_count: lines.length };
    });
  }

  /**
   * Exit criterion 6 lives here: every actual is a read-time sum over posted
   * journal lines (`source: 'journal_lines'`, the same claim the aging reports
   * make), never a stored total.
   */
  async getBudgetVariance(principal: TenantPrincipal, id: string) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const budget = await this.loadBudgetHeader(client, id);
      assertEntityPermission(principal, 'budget.view', budget.legal_entity_id);

      const { rows } = await client.query<VarianceSourceRow>(VARIANCE_SQL, [
        id,
        budget.accounting_book_id,
      ]);

      const { rows: book } = await client.query<{ base_currency: string }>(
        `SELECT base_currency FROM accounting_books WHERE id = $1`,
        [budget.accounting_book_id],
      );

      return {
        budget_id: budget.id,
        name: budget.name,
        version: budget.version,
        status: budget.status,
        // Both named so a budget entered in a currency other than the book's
        // base is a visible mismatch, not a silently unconverted comparison —
        // actuals are base-currency sums and this service converts nothing.
        budget_currency: budget.currency,
        actuals_currency: book[0]?.base_currency ?? null,
        source: 'journal_lines',
        ...computeVariance(rows),
      };
    });
  }

  /**
   * The report form of the same computation, against the Current Approved
   * Budget — resolved, not guessed: an ambiguous filter is an error naming the
   * candidates, because a report that silently picked one of two active
   * budgets would be authoritative-looking and wrong.
   */
  async getBudgetVsActual(
    principal: TenantPrincipal,
    query: {
      legalEntityId: string;
      accountingBookId: string;
      budgetId?: string | undefined;
      fiscalYearId?: string | undefined;
      name?: string | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      assertEntityPermission(principal, 'report.view', query.legalEntityId);

      let budget: Awaited<ReturnType<BudgetsService['loadBudgetHeader']>>;
      if (query.budgetId) {
        budget = await this.loadBudgetHeader(client, query.budgetId);
        if (
          budget.legal_entity_id !== query.legalEntityId ||
          budget.accounting_book_id !== query.accountingBookId
        ) {
          throw notFound('budget', query.budgetId);
        }
      } else {
        const { rows: candidates } = await client.query<{
          id: string;
          name: string;
          version: number;
        }>(
          `SELECT id, name, version FROM budgets
            WHERE legal_entity_id = $1 AND accounting_book_id = $2 AND status = 'ACTIVE'
              AND ($3::uuid IS NULL OR fiscal_year_id = $3)
              AND ($4::text IS NULL OR name = $4)
            ORDER BY name`,
          [
            query.legalEntityId,
            query.accountingBookId,
            query.fiscalYearId ?? null,
            query.name ?? null,
          ],
        );
        if (candidates.length === 0) {
          throw new AppError(
            'VALIDATION_FAILED',
            'No ACTIVE budget matches these filters; approve a budget or pass budgetId.',
          );
        }
        if (candidates.length > 1) {
          throw new AppError(
            'VALIDATION_FAILED',
            `${candidates.length} ACTIVE budgets match: ` +
              `${candidates.map((c) => `${c.name} v${c.version}`).join(', ')}. ` +
              'Narrow by name or pass budgetId.',
            { details: { budget_ids: candidates.map((c) => c.id) } },
          );
        }
        budget = await this.loadBudgetHeader(client, candidates[0]!.id);
      }

      const { rows } = await client.query<VarianceSourceRow>(VARIANCE_SQL, [
        budget.id,
        budget.accounting_book_id,
      ]);
      const { rows: book } = await client.query<{ base_currency: string }>(
        `SELECT base_currency FROM accounting_books WHERE id = $1`,
        [budget.accounting_book_id],
      );

      return {
        budget: {
          id: budget.id,
          name: budget.name,
          version: budget.version,
          status: budget.status,
          currency: budget.currency,
        },
        actuals_currency: book[0]?.base_currency ?? null,
        source: 'journal_lines',
        ...computeVariance(rows),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Shared internals
  // -------------------------------------------------------------------------

  private async loadBudgetHeader(client: PoolClient, id: string) {
    const { rows } = await client.query<{
      id: string;
      legal_entity_id: string;
      accounting_book_id: string;
      fiscal_year_id: string;
      name: string;
      version: number;
      currency: string;
      status: string;
    }>(
      `SELECT id, legal_entity_id, accounting_book_id, fiscal_year_id, name, version, currency,
              status::text AS status
         FROM budgets WHERE id = $1`,
      [id],
    );
    if (!rows[0]) throw notFound('budget', id);
    return rows[0];
  }

  /**
   * Two checks the composite FKs cannot make:
   *
   * - Every period must belong to the budget's fiscal year. The scope FK only
   *   pins the entity, so a line could reference next year's July — and then
   *   never meet an actual, because variance joins on the line's own period.
   * - Every account must be a posting account. Actuals derive from
   *   journal_lines, which carry only posting accounts; a heading line would
   *   compare its amount against a permanent zero.
   */
  private async validateLines(
    client: PoolClient,
    input: {
      legalEntityId: string;
      fiscalYearId: string;
      lines: readonly BudgetLineInput[];
    },
  ): Promise<void> {
    for (const line of input.lines) {
      // Parsed up front: a malformed amount must be a 422 naming itself, not a
      // numeric-cast failure surfacing as a 500 (F-810).
      D(line.amount);
    }

    const periodIds = [...new Set(input.lines.map((l) => l.accountingPeriodId))];
    const { rows: periods } = await client.query<{ id: string }>(
      `SELECT id FROM accounting_periods WHERE id = ANY($1::uuid[]) AND fiscal_year_id = $2`,
      [periodIds, input.fiscalYearId],
    );
    const validPeriods = new Set(periods.map((p) => p.id));
    const strayPeriods = periodIds.filter((p) => !validPeriods.has(p));
    if (strayPeriods.length > 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        `${strayPeriods.length} budget line period(s) do not belong to the budget's fiscal year.`,
        { details: { accounting_period_ids: strayPeriods } },
      );
    }

    const accountIds = [...new Set(input.lines.map((l) => l.accountId))];
    const { rows: accounts } = await client.query<{ id: string }>(
      `SELECT id FROM accounts
        WHERE id = ANY($1::uuid[]) AND legal_entity_id = $2 AND is_posting`,
      [accountIds, input.legalEntityId],
    );
    const postable = new Set(accounts.map((a) => a.id));
    const strayAccounts = accountIds.filter((a) => !postable.has(a));
    if (strayAccounts.length > 0) {
      throw new AppError(
        'ACCOUNT_NOT_POSTABLE',
        `${strayAccounts.length} budget line account(s) are headings or belong to another ` +
          'entity; actuals can only ever land on posting accounts of this entity.',
        { details: { account_ids: strayAccounts } },
      );
    }
  }

  private async insertLines(
    client: PoolClient,
    input: {
      budgetId: string;
      tenantId: string;
      legalEntityId: string;
      currency: string;
      lines: readonly BudgetLineInput[];
    },
  ): Promise<void> {
    for (const line of input.lines) {
      await client.query(
        `INSERT INTO budget_lines
           (id, budget_id, tenant_id, legal_entity_id, accounting_period_id, account_id,
            amount, currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,$8)`,
        [
          uuidv7(),
          input.budgetId,
          input.tenantId,
          input.legalEntityId,
          line.accountingPeriodId,
          line.accountId,
          // Line currency is the budget's, not an input: one budget, one
          // currency (0014's shape), and a per-line override would make the
          // header total meaningless.
          D(line.amount).toString(),
          input.currency,
        ],
      );
    }
  }
}
