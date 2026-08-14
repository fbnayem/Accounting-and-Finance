import { Pool, PoolClient } from 'pg';
import {
  AppError,
  D,
  MONEY_SCALE,
  evaluateBudgetControl,
  assertEntityPermission,
  type BudgetControlPolicy,
  type BudgetControlVerdict,
  type TenantPrincipal,
} from '@acct/domain';
import { readInTenant } from '@acct/database';

/**
 * Budget control — doc 10's "Available = Approved Budget - Actual Posted -
 * Open Commitments - Pending Approved Spend", with the arithmetic in
 * @acct/domain's `evaluateBudgetControl` so this file only has to answer where
 * each term comes from:
 *
 *   Approved  — the ACTIVE budget's lines for this (period, account).
 *   Actual    — posted `journal_lines`, at read time (exit criterion 6; never
 *               a stored document total).
 *   Open commitments — `commitments.open_amount`, OPEN/PARTIALLY_RELIEVED.
 *   Pending approved spend — APPROVED-but-unposted vendor bill lines.
 *
 * GET /budget-control/check calls `check`; but a GET that nothing consults is
 * advisory by construction (F-106's original defect), so the evaluation is also
 * exposed as `evaluateInTransaction`/`assertSpendAllowed` for the mutation path
 * that actually spends — purchase order approval — to call inside its own
 * transaction.
 */

export interface BudgetControlQuery {
  readonly legalEntityId: string;
  readonly accountingBookId: string;
  readonly accountingPeriodId: string;
  readonly accountId: string;
  /** The spend being contemplated. Must not already be posted or committed. */
  readonly amount: string;
  /** Optional: pin the budget instead of resolving the ACTIVE one. */
  readonly budgetId?: string | undefined;
}

export interface BudgetControlResult {
  readonly budget_id: string | null;
  readonly budget_name: string | null;
  readonly budget_version: number | null;
  readonly policy: BudgetControlPolicy;
  readonly decision: BudgetControlVerdict['decision'];
  readonly approved_budget: string;
  readonly actual_posted: string;
  readonly open_commitments: string;
  readonly pending_approved_spend: string;
  readonly available: string;
  readonly proposed_spend: string;
  readonly available_after: string;
  readonly over_budget: boolean;
  readonly over_budget_by: string;
  readonly warn_threshold_pct: string | null;
  readonly explanation: string;
  readonly source: 'journal_lines';
}

export class BudgetControlService {
  constructor(private readonly pool: Pool) {}

  /** The GET — same evaluation, read-only transaction. */
  async check(principal: TenantPrincipal, query: BudgetControlQuery): Promise<BudgetControlResult> {
    return readInTenant(this.pool, principal, async ({ client }) =>
      this.evaluateInTransaction(client, principal, query),
    );
  }

  /**
   * The evaluation itself, callable from inside a mutation's transaction so the
   * decision and the spend it gates commit or roll back together.
   */
  async evaluateInTransaction(
    client: PoolClient,
    principal: TenantPrincipal,
    query: BudgetControlQuery,
  ): Promise<BudgetControlResult> {
    // budget.view, not a mutation permission: reading what the budget allows is
    // a view of the budget. The mutation that acts on the verdict asserts its
    // own permission (purchase_order.approve, vendor_bill.post, ...) itself.
    assertEntityPermission(principal, 'budget.view', query.legalEntityId);

    const proposed = D(query.amount);

    const budget = await this.resolveBudget(client, query);
    if (!budget) {
      // An account the budget owner did not budget is not thereby forbidden —
      // enforcing BLOCK on every unbudgeted account would freeze payroll the
      // day someone budgets only travel. No line, nothing to enforce; say so.
      return {
        budget_id: null,
        budget_name: null,
        budget_version: null,
        policy: 'INFORMATIONAL',
        decision: 'PROCEED',
        approved_budget: '0.00000000',
        actual_posted: '0.00000000',
        open_commitments: '0.00000000',
        pending_approved_spend: '0.00000000',
        available: '0.00000000',
        proposed_spend: proposed.toFixed(MONEY_SCALE),
        available_after: proposed.negate().toFixed(MONEY_SCALE),
        over_budget: false,
        over_budget_by: '0.00000000',
        warn_threshold_pct: null,
        explanation:
          'No ACTIVE budget has a line for this account and period, so budget control has ' +
          'nothing to enforce here.',
        source: 'journal_lines',
      };
    }

    // Exit criterion 6: the actual is a sum over posted journal lines, signed
    // debit-positive because commitments and bills measure spend the same way.
    const { rows: actual } = await client.query<{ amount: string }>(
      `SELECT coalesce(sum(l.base_debit - l.base_credit), 0)::text AS amount
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id
        WHERE e.status = 'POSTED'
          AND l.accounting_book_id = $1
          AND l.accounting_period_id = $2
          AND l.account_id = $3`,
      [query.accountingBookId, query.accountingPeriodId, query.accountId],
    );

    const { rows: committed } = await client.query<{ amount: string }>(
      `SELECT coalesce(sum(open_amount), 0)::text AS amount
         FROM commitments
        WHERE accounting_book_id = $1 AND accounting_period_id = $2 AND account_id = $3
          AND status IN ('OPEN','PARTIALLY_RELIEVED')`,
      [query.accountingBookId, query.accountingPeriodId, query.accountId],
    );

    // "Pending Approved Spend": bills that carry approval but no journal yet.
    // Net of tax, matching commitments — recoverable tax is a receivable, not
    // spend, and two consumption terms measuring different things double-count.
    const { rows: pending } = await client.query<{ amount: string }>(
      `SELECT coalesce(sum(bl.net_amount), 0)::text AS amount
         FROM vendor_bill_lines bl
         JOIN vendor_bills b ON b.id = bl.vendor_bill_id
         JOIN accounting_periods p ON p.id = $2
        WHERE b.status = 'APPROVED'
          AND b.accounting_book_id = $1
          AND bl.destination_account_id = $3
          AND b.posting_date BETWEEN p.start_date AND p.end_date`,
      [query.accountingBookId, query.accountingPeriodId, query.accountId],
    );

    const verdict = evaluateBudgetControl({
      policy: budget.control_policy as BudgetControlPolicy,
      warnThresholdPct:
        budget.control_threshold_pct === null ? null : D(budget.control_threshold_pct),
      approvedBudget: D(budget.approved_amount),
      actualPosted: D(actual[0]?.amount ?? '0'),
      openCommitments: D(committed[0]?.amount ?? '0'),
      pendingApprovedSpend: D(pending[0]?.amount ?? '0'),
      proposedSpend: proposed,
    });

    return {
      budget_id: budget.id,
      budget_name: budget.name,
      budget_version: budget.version,
      policy: verdict.policy,
      decision: verdict.decision,
      approved_budget: verdict.approvedBudget.toFixed(MONEY_SCALE),
      actual_posted: verdict.actualPosted.toFixed(MONEY_SCALE),
      open_commitments: verdict.openCommitments.toFixed(MONEY_SCALE),
      pending_approved_spend: verdict.pendingApprovedSpend.toFixed(MONEY_SCALE),
      available: verdict.available.toFixed(MONEY_SCALE),
      proposed_spend: verdict.proposedSpend.toFixed(MONEY_SCALE),
      available_after: verdict.availableAfter.toFixed(MONEY_SCALE),
      over_budget: verdict.overBudget,
      over_budget_by: verdict.overBudgetBy.toFixed(MONEY_SCALE),
      warn_threshold_pct:
        verdict.warnThresholdPct === null ? null : verdict.warnThresholdPct.toString(),
      explanation: verdict.explanation,
      source: 'journal_lines',
    };
  }

  /**
   * The enforcement wrapper for mutation paths: evaluates, and refuses when the
   * policy says refuse. BLOCK is a 422 and REQUIRE_OVERRIDE a 403 — the second
   * is deliberately the approval shape, because doc 10's override is a person
   * with authority saying yes, not a retry.
   *
   * WARN and PROCEED return the verdict for the caller to surface; no event is
   * published here because a refusal throws, and an outbox row written in a
   * transaction that then rolls back was never written at all.
   */
  async assertSpendAllowed(
    client: PoolClient,
    principal: TenantPrincipal,
    query: BudgetControlQuery,
  ): Promise<BudgetControlResult> {
    const result = await this.evaluateInTransaction(client, principal, query);
    if (result.decision === 'BLOCK') {
      throw new AppError('VALIDATION_FAILED', `BUDGET_BLOCKED: ${result.explanation}`, {
        details: { ...result },
      });
    }
    if (result.decision === 'OVERRIDE_REQUIRED') {
      throw new AppError('APPROVAL_REQUIRED', `BUDGET_OVERRIDE_REQUIRED: ${result.explanation}`, {
        details: { ...result },
      });
    }
    return result;
  }

  /**
   * One ACTIVE budget's line total for this (period, account), or null when no
   * ACTIVE budget covers it. Two ACTIVE budgets covering the same cell is a
   * question this method refuses to answer by picking one: which budget
   * controls spending is a configuration decision, not a coin toss.
   */
  private async resolveBudget(
    client: PoolClient,
    query: BudgetControlQuery,
  ): Promise<{
    id: string;
    name: string;
    version: number;
    control_policy: string;
    control_threshold_pct: string | null;
    approved_amount: string;
  } | null> {
    const { rows } = await client.query<{
      id: string;
      name: string;
      version: number;
      control_policy: string;
      control_threshold_pct: string | null;
      approved_amount: string;
    }>(
      `SELECT b.id, b.name, b.version, b.control_policy::text AS control_policy,
              b.control_threshold_pct::text AS control_threshold_pct,
              sum(l.amount)::text AS approved_amount
         FROM budgets b
         JOIN budget_lines l ON l.budget_id = b.id
        WHERE ($4::uuid IS NULL OR b.id = $4)
          AND ($4::uuid IS NOT NULL OR b.status = 'ACTIVE')
          AND b.legal_entity_id = $1 AND b.accounting_book_id = $2
          AND l.accounting_period_id = $3 AND l.account_id = $5
        GROUP BY b.id, b.name, b.version, b.control_policy, b.control_threshold_pct`,
      [
        query.legalEntityId,
        query.accountingBookId,
        query.accountingPeriodId,
        query.budgetId ?? null,
        query.accountId,
      ],
    );
    if (rows.length > 1) {
      throw new AppError(
        'VALIDATION_FAILED',
        `${rows.length} ACTIVE budgets cover this account and period ` +
          `(${rows.map((r) => `${r.name} v${r.version}`).join(', ')}); pass budgetId to say ` +
          'which one controls.',
        { details: { budget_ids: rows.map((r) => r.id) } },
      );
    }
    return rows[0] ?? null;
  }
}
