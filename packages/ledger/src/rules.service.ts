/**
 * Posting rule versions, simulation, recurring journals and opening balances.
 *
 * These four sit together because they share one idea: each of them produces a
 * journal that some other process will post later, and none of them may post it by
 * a different route. Simulation runs the resolution and stops; the recurring
 * template and the opening balance set produce drafts. The posting itself is always
 * `JournalService.post`, which is what keeps "every posted journal balances" a
 * statement about one code path rather than four.
 */
import { Pool, PoolClient } from 'pg';
import {
  AppError,
  accountingEquation,
  evaluatePostingRule,
  notFound,
  parsePostingRule,
  uuidv7,
  type AccountTypeCode,
  type AccountingEvent,
  type PostingRuleDefinition,
} from '@acct/domain';
import { publish, recordAudit } from '@acct/database';
import { readInTenant, writeInTenant } from '@acct/database';
import { assertEntityPermission, entityScope, type TenantPrincipal } from '@acct/domain';
import { PostingService } from './posting.service';
import { JournalService, type JournalLineInput } from './journal.service';

export class LedgerRulesService {
  constructor(
    private readonly pool: Pool,
    private readonly posting: PostingService,
    private readonly journals: JournalService,
  ) {}

  // -------------------------------------------------------------------------
  // Posting rule versions (F-610)
  // -------------------------------------------------------------------------

  async listPostingRuleVersions(
    principal: TenantPrincipal,
    filters: {
      legalEntityId?: string | undefined;
      accountingBookId?: string | undefined;
      eventType?: string | undefined;
      on?: string | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const where = ['r.tenant_id = $1'];
      const params: unknown[] = [principal.tenantId];
      if (filters.legalEntityId) {
        assertEntityPermission(principal, 'posting_rule.view', filters.legalEntityId);
        params.push(filters.legalEntityId);
        where.push(`r.legal_entity_id = $${params.length}`);
      } else {
        const scope = entityScope(principal);
        if (scope.kind === 'ENTITIES') {
          params.push(scope.legalEntityIds);
          where.push(`r.legal_entity_id = ANY($${params.length}::uuid[])`);
        }
      }
      if (filters.accountingBookId) {
        params.push(filters.accountingBookId);
        where.push(`r.accounting_book_id = $${params.length}`);
      }
      if (filters.eventType) {
        params.push(filters.eventType);
        where.push(`r.event_type = $${params.length}`);
      }
      if (filters.on) {
        params.push(filters.on);
        where.push(
          `r.valid_from <= $${params.length}::timestamptz ` +
            `AND (r.valid_to IS NULL OR r.valid_to > $${params.length}::timestamptz)`,
        );
      }
      const { rows } = await client.query(
        `SELECT r.id, r.legal_entity_id, r.accounting_book_id, r.event_type, r.version,
                r.valid_from, r.valid_to, r.framework, r.status, r.rule_definition, r.created_at,
                (SELECT count(*) FROM journal_entries e WHERE e.posting_rule_version_id = r.id)::int
                  AS entries_posted
           FROM posting_rule_versions r
          WHERE ${where.join(' AND ')}
          ORDER BY r.event_type, r.valid_from DESC
          LIMIT 500`,
        params,
      );
      return { data: rows };
    });
  }

  /**
   * doc 01 rule 7: rules are versioned and effective-dated, and a historical
   * document keeps the version it used.
   *
   * The overlap exclusion constraint in 0005 is what makes resolution
   * deterministic, so the previous version is closed off at the new one's start
   * rather than left running — otherwise the INSERT is simply rejected, which is
   * correct but unhelpful. Closing it here means "supersede" is one call.
   */
  async createPostingRuleVersion(
    principal: TenantPrincipal,
    input: {
      accountingBookId: string;
      eventType: string;
      validFrom: string;
      ruleDefinition: unknown;
      framework?: string | undefined;
      supersede?: boolean | undefined;
    },
  ) {
    // Parsed before anything is written: a rule that fails at posting time fails
    // during a month-end close, on a document somebody has already approved.
    const rule: PostingRuleDefinition = parsePostingRule(input.ruleDefinition);
    if (rule.event_type !== input.eventType) {
      throw new AppError(
        'VALIDATION_FAILED',
        `The rule declares event_type ${rule.event_type} but the request says ${input.eventType}.`,
        { fieldErrors: [{ field: 'event_type', code: 'MISMATCH', message: 'does not match' }] },
      );
    }

    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows: books } = await client.query<{ legal_entity_id: string }>(
        `SELECT legal_entity_id FROM accounting_books WHERE id = $1 AND tenant_id = $2`,
        [input.accountingBookId, principal.tenantId],
      );
      const book = books[0];
      if (!book) throw notFound('Accounting book', input.accountingBookId);
      assertEntityPermission(principal, 'posting_rule.manage', book.legal_entity_id);

      const { rows: current } = await client.query<{ id: string; version: number }>(
        `SELECT id, version FROM posting_rule_versions
          WHERE accounting_book_id = $1 AND event_type = $2
            AND (valid_to IS NULL OR valid_to > $3::timestamptz)
          ORDER BY version DESC
          FOR UPDATE`,
        [input.accountingBookId, input.eventType, input.validFrom],
      );
      if (current.length > 0) {
        if (!input.supersede) {
          throw new AppError(
            'VALIDATION_FAILED',
            `Version ${current[0]!.version} of ${input.eventType} is still effective at ` +
              `${input.validFrom}. Two effective versions would make rule resolution ` +
              'non-deterministic (F-010). Pass supersede=true to close the previous one.',
            { details: { current_version: current[0]!.version } },
          );
        }
        await client.query(
          `UPDATE posting_rule_versions SET valid_to = $2::timestamptz
            WHERE id = ANY($1::uuid[]) AND (valid_to IS NULL OR valid_to > $2::timestamptz)`,
          [current.map((r) => r.id), input.validFrom],
        );
      }

      const { rows: versions } = await client.query<{ next: number }>(
        `SELECT coalesce(max(version), 0) + 1 AS next FROM posting_rule_versions
          WHERE accounting_book_id = $1 AND event_type = $2`,
        [input.accountingBookId, input.eventType],
      );
      const version = versions[0]!.next;

      const id = uuidv7();
      const { rows } = await client.query(
        `INSERT INTO posting_rule_versions (id, tenant_id, legal_entity_id, accounting_book_id,
                                            event_type, version, valid_from, rule_definition,
                                            framework)
         VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8::jsonb,$9)
         RETURNING id, legal_entity_id, accounting_book_id, event_type, version, valid_from,
                   valid_to, framework, status, rule_definition`,
        [
          id,
          principal.tenantId,
          book.legal_entity_id,
          input.accountingBookId,
          input.eventType,
          version,
          input.validFrom,
          JSON.stringify(rule),
          input.framework ?? 'IFRS',
        ],
      );

      await recordAudit(client, context, {
        action: 'posting_rule.version_created',
        resourceType: 'posting_rule_version',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: book.legal_entity_id,
        after: { event_type: input.eventType, version, valid_from: input.validFrom },
      });
      return rows[0]!;
    });
  }

  /**
   * doc 03: "Posting simulation endpoint … returns the journal that would be
   * created. Writes nothing."
   *
   * Same resolution, same preparation, same balance rules as the real thing —
   * `evaluatePostingRule` then `PostingService.prepare` — because a simulation that
   * runs different code is a simulation of something else. It reads inside a
   * read-only transaction, so it cannot write even by accident.
   */
  async simulate(
    principal: TenantPrincipal,
    input: {
      accountingBookId: string;
      eventType: string;
      postingDate: string;
      payload: Record<string, unknown>;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const book = await this.posting.loadBookContext(
        client,
        principal,
        input.accountingBookId,
        input.postingDate,
      );
      assertEntityPermission(principal, 'journal.view', book.legalEntityId);

      const version = await this.resolveRuleVersion(
        client,
        input.accountingBookId,
        input.eventType,
        input.postingDate,
      );
      const rule = parsePostingRule(version.rule_definition);
      const resolution = await this.ruleContext(client, book.legalEntityId, book.baseCurrency);

      const event: AccountingEvent = {
        eventType: input.eventType,
        legalEntityId: book.legalEntityId,
        accountingBookId: book.bookId,
        postingDate: input.postingDate,
        sourceType: 'SIMULATION',
        payload: input.payload,
      };

      const draftLines = evaluatePostingRule(rule, event, resolution);
      const prepared = await this.posting.prepare(client, book, draftLines);
      const period = await this.posting.resolvePeriod(client, principal, {
        legalEntityId: book.legalEntityId,
        postingDate: input.postingDate,
      });

      return {
        posting_rule_version: {
          id: version.id,
          event_type: version.event_type,
          version: version.version,
          valid_from: version.valid_from,
          framework: version.framework,
        },
        accounting_period: { id: period.id, name: period.name, status: period.status },
        base_currency: prepared.baseCurrency,
        total_debit: prepared.totalBaseDebit,
        total_credit: prepared.totalBaseCredit,
        rounding_adjustment: prepared.roundingAdjustment,
        // Named so the caller can see the check it would fail before it fails it.
        requires_post_control: prepared.controlAccounts.length > 0,
        lines: prepared.lines,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Recurring journals
  // -------------------------------------------------------------------------

  async listRecurringJournals(
    principal: TenantPrincipal,
    filters: { legalEntityId?: string | undefined },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const where = ['t.tenant_id = $1'];
      const params: unknown[] = [principal.tenantId];
      if (filters.legalEntityId) {
        assertEntityPermission(principal, 'journal.view', filters.legalEntityId);
        params.push(filters.legalEntityId);
        where.push(`t.legal_entity_id = $${params.length}`);
      } else {
        const scope = entityScope(principal);
        if (scope.kind === 'ENTITIES') {
          params.push(scope.legalEntityIds);
          where.push(`t.legal_entity_id = ANY($${params.length}::uuid[])`);
        }
      }
      const { rows } = await client.query(
        `SELECT t.id, t.legal_entity_id, t.accounting_book_id, t.journal_id, t.name, t.version,
                t.frequency, t.start_date::text AS start_date, t.end_date::text AS end_date,
                t.next_run_date::text AS next_run_date, t.auto_post, t.requires_approval,
                t.line_template, t.status,
                (SELECT count(*) FROM recurring_journal_occurrences o WHERE o.template_id = t.id)::int
                  AS occurrence_count
           FROM recurring_journal_templates t
          WHERE ${where.join(' AND ')}
          ORDER BY t.name
          LIMIT 500`,
        params,
      );
      return { data: rows };
    });
  }

  async createRecurringJournal(
    principal: TenantPrincipal,
    input: {
      accountingBookId: string;
      journalId: string;
      name: string;
      frequency: string;
      startDate: string;
      endDate?: string | undefined;
      autoPost?: boolean | undefined;
      requiresApproval?: boolean | undefined;
      lines: readonly JournalLineInput[];
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const book = await this.posting.loadBookContext(
        client,
        principal,
        input.accountingBookId,
        input.startDate,
      );
      assertEntityPermission(principal, 'journal.create', book.legalEntityId);

      // The template is validated against the chart now, not on the night the
      // worker first runs it. A recurring template that names an archived account
      // fails at 02:00 on the first of the month otherwise.
      const prepared = await this.posting.prepare(
        client,
        book,
        input.lines.map((l, i) => ({ ...l, lineNo: i + 1 })),
      );

      const id = uuidv7();
      const { rows } = await client.query(
        `INSERT INTO recurring_journal_templates (id, tenant_id, legal_entity_id,
                                                  accounting_book_id, journal_id, name, frequency,
                                                  start_date, end_date, next_run_date, auto_post,
                                                  requires_approval, line_template)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9::date,$8::date,$10,$11,$12::jsonb)
         RETURNING id, legal_entity_id, accounting_book_id, journal_id, name, version, frequency,
                   start_date::text AS start_date, end_date::text AS end_date,
                   next_run_date::text AS next_run_date, auto_post, requires_approval,
                   line_template, status`,
        [
          id,
          principal.tenantId,
          book.legalEntityId,
          input.accountingBookId,
          input.journalId,
          input.name,
          input.frequency,
          input.startDate,
          input.endDate ?? null,
          input.autoPost ?? false,
          input.requiresApproval ?? true,
          JSON.stringify({ lines: input.lines }),
        ],
      );

      await recordAudit(client, context, {
        action: 'recurring_journal.created',
        resourceType: 'recurring_journal_template',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: book.legalEntityId,
        after: { name: input.name, frequency: input.frequency, lines: prepared.lines.length },
      });
      return { ...rows[0]!, preview: { lines: prepared.lines, balanced: true } };
    });
  }

  // -------------------------------------------------------------------------
  // Opening balances (F-613)
  // -------------------------------------------------------------------------

  async listOpeningBalanceSets(
    principal: TenantPrincipal,
    filters: { legalEntityId?: string | undefined },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const where = ['s.tenant_id = $1'];
      const params: unknown[] = [principal.tenantId];
      if (filters.legalEntityId) {
        assertEntityPermission(principal, 'opening_balance.view', filters.legalEntityId);
        params.push(filters.legalEntityId);
        where.push(`s.legal_entity_id = $${params.length}`);
      } else {
        const scope = entityScope(principal);
        if (scope.kind === 'ENTITIES') {
          params.push(scope.legalEntityIds);
          where.push(`s.legal_entity_id = ANY($${params.length}::uuid[])`);
        }
      }
      const { rows } = await client.query(
        `SELECT s.id, s.legal_entity_id, s.accounting_book_id, s.as_of_date::text AS as_of_date,
                s.total_debit::text AS total_debit, s.total_credit::text AS total_credit,
                s.journal_entry_id, s.status, s.created_at,
                e.entry_number, e.status::text AS journal_status
           FROM opening_balance_sets s
           LEFT JOIN journal_entries e ON e.id = s.journal_entry_id
          WHERE ${where.join(' AND ')}
          ORDER BY s.as_of_date DESC
          LIMIT 200`,
        params,
      );
      return { data: rows };
    });
  }

  /**
   * doc 21 Phase 2: "Opening Trial Balance imports and validates
   * Assets = Liabilities + Equity."
   *
   * Validated in the only form that is true for a mid-year cutover — see
   * `accountingEquation` in @acct/domain. The set and its draft journal are created
   * together; posting is a separate, explicitly permitted step, because an opening
   * balance is the one journal nobody can reverse their way out of cheaply.
   */
  async createOpeningBalanceSet(
    principal: TenantPrincipal,
    input: {
      accountingBookId: string;
      journalId: string;
      asOfDate: string;
      lines: readonly JournalLineInput[];
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const book = await this.posting.loadBookContext(
        client,
        principal,
        input.accountingBookId,
        input.asOfDate,
      );
      assertEntityPermission(principal, 'opening_balance.manage', book.legalEntityId);

      const existing = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM opening_balance_sets
          WHERE accounting_book_id = $1 AND status IN ('DRAFT', 'VALIDATED', 'POSTED')`,
        [input.accountingBookId],
      );
      if (existing.rows[0]) {
        throw new AppError(
          'VALIDATION_FAILED',
          `This book already has a ${existing.rows[0].status} opening balance set. A second one ` +
            'would restate the starting position of a ledger that already has one.',
          { details: { opening_balance_set_id: existing.rows[0].id } },
        );
      }

      const prepared = await this.posting.prepare(
        client,
        book,
        input.lines.map((l, i) => ({ ...l, lineNo: i + 1 })),
      );
      const equation = accountingEquation(
        prepared.lines.map((l) => ({
          accountType: l.accountType as AccountTypeCode,
          debit: l.baseDebit,
          credit: l.baseCredit,
        })),
      );

      const draft = await this.journals.createDraft(principal, {
        accountingBookId: input.accountingBookId,
        journalId: input.journalId,
        postingDate: input.asOfDate,
        description: `Opening balances as at ${input.asOfDate}`,
        sourceType: 'OPENING_BALANCE',
        lines: input.lines,
      });

      const id = uuidv7();
      const { rows } = await client.query(
        `INSERT INTO opening_balance_sets (id, tenant_id, legal_entity_id, accounting_book_id,
                                           as_of_date, total_debit, total_credit, journal_entry_id,
                                           status)
         VALUES ($1,$2,$3,$4,$5::date,$6::numeric,$7::numeric,$8,'VALIDATED')
         RETURNING id, legal_entity_id, accounting_book_id, as_of_date::text AS as_of_date,
                   total_debit::text AS total_debit, total_credit::text AS total_credit,
                   journal_entry_id, status`,
        [
          id,
          principal.tenantId,
          book.legalEntityId,
          input.accountingBookId,
          input.asOfDate,
          prepared.totalBaseDebit,
          prepared.totalBaseCredit,
          (draft as { id: string }).id,
        ],
      );

      await recordAudit(client, context, {
        action: 'opening_balance.created',
        resourceType: 'opening_balance_set',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: book.legalEntityId,
        after: { as_of_date: input.asOfDate, equation, lines: prepared.lines.length },
      });

      return { ...rows[0]!, equation, lines: prepared.lines };
    });
  }

  async postOpeningBalanceSet(principal: TenantPrincipal, id: string) {
    const set = await readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query<{
        id: string;
        legal_entity_id: string;
        journal_entry_id: string | null;
        status: string;
      }>(
        `SELECT id, legal_entity_id, journal_entry_id, status FROM opening_balance_sets
          WHERE id = $1 AND tenant_id = $2`,
        [id, principal.tenantId],
      );
      if (!rows[0]) throw notFound('Opening balance set', id);
      return rows[0];
    });

    assertEntityPermission(principal, 'opening_balance.manage', set.legal_entity_id);
    if (set.status === 'POSTED') return set;
    if (set.status !== 'VALIDATED' || !set.journal_entry_id) {
      throw new AppError(
        'VALIDATION_FAILED',
        `This opening balance set is ${set.status} and has no validated journal to post.`,
      );
    }

    // Posted through the ordinary path on purpose: the period lock, the number
    // allocation, the control-account permission and the deferred balance assertion
    // all apply. An opening balance that skipped them would be the one journal in
    // the system nobody had checked.
    const posted = await this.journals.post(principal, set.journal_entry_id, {});

    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows } = await client.query(
        `UPDATE opening_balance_sets SET status = 'POSTED' WHERE id = $1 AND tenant_id = $2
          RETURNING id, legal_entity_id, accounting_book_id, as_of_date::text AS as_of_date,
                    total_debit::text AS total_debit, total_credit::text AS total_credit,
                    journal_entry_id, status`,
        [id, principal.tenantId],
      );
      await publish(client, context, {
        eventType: 'journal.posted',
        aggregateType: 'opening_balance_set',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: set.legal_entity_id,
        payload: { opening_balance_set_id: id, journal_entry_id: set.journal_entry_id },
      });
      await recordAudit(client, context, {
        action: 'opening_balance.posted',
        resourceType: 'opening_balance_set',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: set.legal_entity_id,
        after: { journal_entry_id: set.journal_entry_id },
      });
      return { ...rows[0]!, journal: posted };
    });
  }

  // -------------------------------------------------------------------------

  /** doc 03 step 5, and F-010's reason for the overlap constraint. */
  private async resolveRuleVersion(
    client: PoolClient,
    bookId: string,
    eventType: string,
    on: string,
  ): Promise<{
    id: string;
    event_type: string;
    version: number;
    valid_from: string;
    framework: string;
    rule_definition: unknown;
  }> {
    const { rows } = await client.query<{
      id: string;
      event_type: string;
      version: number;
      valid_from: string;
      framework: string;
      rule_definition: unknown;
    }>(
      `SELECT id, event_type, version, valid_from, framework, rule_definition
         FROM posting_rule_versions
        WHERE accounting_book_id = $1 AND event_type = $2 AND status = 'ACTIVE'
          AND valid_from <= $3::timestamptz
          AND (valid_to IS NULL OR valid_to > $3::timestamptz)`,
      [bookId, eventType, on],
    );
    if (!rows[0]) {
      throw new AppError(
        'POSTING_RULE_MISSING',
        `No posting rule for ${eventType} is effective on ${on} in this book. Rules are ` +
          'effective-dated (doc 01 rule 7), so a posting before the rule starts has no ' +
          'treatment to apply.',
        { details: { event_type: eventType, on, accounting_book_id: bookId } },
      );
    }
    // The exclusion constraint guarantees at most one, so no tie-break is needed —
    // and if that ever changed, this would return the wrong one silently, which is
    // why F-010 was raised against a schema that permitted two.
    return rows[0];
  }

  private async ruleContext(client: PoolClient, legalEntityId: string, baseCurrency: string) {
    const { rows: policies } = await client.query<Record<string, string | null>>(
      `SELECT ar_control_account_id, ap_control_account_id, cash_clearing_account_id,
              payment_clearing_account_id, retained_earnings_account_id,
              current_year_earnings_account_id, rounding_account_id,
              realized_fx_gain_account_id, realized_fx_loss_account_id,
              unrealized_fx_gain_account_id, unrealized_fx_loss_account_id,
              bad_debt_account_id, customer_advance_account_id, vendor_advance_account_id,
              grni_account_id, suspense_account_id
         FROM accounting_policies
        WHERE legal_entity_id = $1
        ORDER BY version DESC
        LIMIT 1`,
      [legalEntityId],
    );
    const { rows: accounts } = await client.query<{ id: string; code: string }>(
      `SELECT id, code FROM accounts WHERE legal_entity_id = $1 AND status = 'ACTIVE'`,
      [legalEntityId],
    );
    return {
      policyAccounts: policies[0] ?? {},
      accountsByCode: new Map(accounts.map((a) => [a.code, a.id])),
      baseCurrency,
    };
  }
}
