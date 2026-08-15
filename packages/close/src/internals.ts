/**
 * The shared reads every close service performs, in one place.
 *
 * `collectChecklistItems` is the important one: it is the single definition of
 * "what this close asked for", and it is called by the dashboard, by the finalize
 * gate and by the period hard-close gate. Three copies of that query would be
 * three chances for the dashboard to show a state the gate does not enforce —
 * which is precisely the defect this package exists to close.
 */
import { PoolClient } from 'pg';
import { AppError, notFound } from '@acct/domain';
import {
  deriveReadiness,
  reconciliationSatisfaction,
  taskSatisfaction,
  type ChecklistItem,
  type Readiness,
} from './readiness';

export interface CloseRunRow {
  id: string;
  tenant_id: string;
  legal_entity_id: string;
  accounting_book_id: string;
  accounting_period_id: string;
  template_id: string | null;
  version: number;
  status: string;
  readiness_percent: string;
  started_by: string | null;
  started_at: string;
  completed_at: string | null;
  reopened_at: string | null;
  reopened_by: string | null;
  reopen_reason: string | null;
}

const RUN_COLUMNS = `id, tenant_id, legal_entity_id, accounting_book_id, accounting_period_id,
                     template_id, version, status::text AS status,
                     readiness_percent::text AS readiness_percent,
                     started_by, started_at, completed_at,
                     reopened_at, reopened_by, reopen_reason`;

export async function loadCloseRun(
  client: PoolClient,
  id: string,
  lock: 'FOR UPDATE' | '' = '',
): Promise<CloseRunRow> {
  const { rows } = await client.query<CloseRunRow>(
    `SELECT ${RUN_COLUMNS} FROM close_runs WHERE id = $1 ${lock}`,
    [id],
  );
  const run = rows[0];
  if (!run) throw notFound('Close run', id);
  return run;
}

export interface PeriodRow {
  id: string;
  tenant_id: string;
  legal_entity_id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: string;
  closed_by: string | null;
  closed_at: string | null;
}

export async function loadPeriod(client: PoolClient, id: string): Promise<PeriodRow> {
  const { rows } = await client.query<PeriodRow>(
    `SELECT id, tenant_id, legal_entity_id, name, start_date::text AS start_date,
            end_date::text AS end_date, status::text AS status, closed_by, closed_at
       FROM accounting_periods WHERE id = $1`,
    [id],
  );
  const period = rows[0];
  if (!period) throw notFound('Accounting period', id);
  return period;
}

export interface BookRow {
  id: string;
  tenant_id: string;
  legal_entity_id: string;
  code: string;
  name: string;
  base_currency: string;
  status: string;
}

export async function loadBook(client: PoolClient, id: string): Promise<BookRow> {
  const { rows } = await client.query<BookRow>(
    `SELECT id, tenant_id, legal_entity_id, code, name, base_currency, status::text AS status
       FROM accounting_books WHERE id = $1`,
    [id],
  );
  const book = rows[0];
  if (!book) throw notFound('Accounting book', id);
  return book;
}

/**
 * The accounts a period's close must reconcile.
 *
 * Two populations, deliberately, because "a period needs no configured
 * reconciliations" was half of what made completeness vacuous:
 *
 *   - every ACTIVE control account of the entity (`accounts.is_control`), which is
 *     what Gate D is about: a subledger and the control account it rolls into
 *     either agree or the difference is an explicit reconciling item;
 *   - any account a tenant has explicitly opted in with
 *     `settings->>'requires_reconciliation' = 'true'` — a suspense, clearing or
 *     payroll-liability account that is not a control account but that nobody
 *     should close a month over without looking at.
 *
 * The first population is the one that cannot be configured away: marking an
 * account as a control account is what makes it one, and a chart with no control
 * accounts and no checklist is caught by the vacuity rule instead of passing.
 */
export interface RequiredReconciliationRow {
  account_id: string;
  account_code: string;
  account_name: string;
  is_control: boolean;
  reconciliation_id: string | null;
  status: string | null;
  prepared_by: string | null;
  approved_by: string | null;
  difference: string | null;
  /** The GL balance right now, on the same basis the reconciliation recorded. */
  gl_balance_now: string;
  /** True when the ledger has moved since the reconciliation recorded its GL side. */
  stale: boolean;
}

export async function loadRequiredReconciliations(
  client: PoolClient,
  run: Pick<CloseRunRow, 'legal_entity_id' | 'accounting_book_id' | 'accounting_period_id'>,
): Promise<RequiredReconciliationRow[]> {
  // The staleness comparison is made in SQL, between two `numeric` values. It is
  // a monetary comparison, and it never becomes a JavaScript number (ADR-0006 §1).
  //
  // Why it exists: a reconciliation certified on the 3rd against a GL balance that
  // a late journal moved on the 5th is not evidence about the period as it now
  // stands. Nothing prevents that posting — the period is still open, which is the
  // whole reason a close run exists — so the close has to notice.
  const { rows } = await client.query<RequiredReconciliationRow>(
    `WITH cutoff AS (
        SELECT fy.start_date AS fy_start, p.period_no
          FROM accounting_periods p
          JOIN fiscal_years fy ON fy.id = p.fiscal_year_id
         WHERE p.id = $3
      ),
      balances AS (
        SELECT l.account_id, sum(l.base_debit - l.base_credit) AS balance
          FROM journal_lines l
          JOIN journal_entries e ON e.id = l.journal_entry_id
          JOIN accounting_periods p ON p.id = l.accounting_period_id
          JOIN fiscal_years fy ON fy.id = p.fiscal_year_id
          CROSS JOIN cutoff c
         WHERE l.accounting_book_id = $2
           AND e.status IN ('POSTED', 'REVERSED')
           AND (fy.start_date, p.period_no) <= (c.fy_start, c.period_no)
         GROUP BY l.account_id
      )
      SELECT a.id            AS account_id,
             a.code          AS account_code,
             a.name          AS account_name,
             a.is_control,
             r.id            AS reconciliation_id,
             r.status::text  AS status,
             r.prepared_by,
             r.approved_by,
             r.difference::text AS difference,
             coalesce(b.balance, 0)::text AS gl_balance_now,
             (r.id IS NOT NULL AND r.gl_balance IS DISTINCT FROM coalesce(b.balance, 0)) AS stale
        FROM accounts a
        LEFT JOIN account_reconciliations r
               ON r.account_id = a.id
              AND r.accounting_book_id = $2
              AND r.accounting_period_id = $3
        LEFT JOIN balances b ON b.account_id = a.id
       WHERE a.legal_entity_id = $1
         AND a.status = 'ACTIVE'
         AND (a.is_control OR coalesce(a.settings->>'requires_reconciliation', 'false') = 'true')
       ORDER BY a.code`,
    [run.legal_entity_id, run.accounting_book_id, run.accounting_period_id],
  );
  return rows;
}

export interface CloseTaskRow {
  id: string;
  close_run_id: string;
  sequence: number;
  code: string;
  name: string;
  task_type: string;
  owner_user_id: string | null;
  required: boolean;
  status: string;
  depends_on_task_id: string | null;
  depends_on_code: string | null;
  depends_on_status: string | null;
  due_at: string | null;
  evidence: unknown;
  waived_by: string | null;
  waived_reason: string | null;
  completed_by: string | null;
  completed_at: string | null;
}

export async function loadCloseTasks(
  client: PoolClient,
  closeRunId: string,
): Promise<CloseTaskRow[]> {
  const { rows } = await client.query<CloseTaskRow>(
    `SELECT t.id, t.close_run_id, t.sequence, t.code, t.name, t.task_type, t.owner_user_id,
            t.required, t.status::text AS status, t.depends_on_task_id,
            d.code AS depends_on_code, d.status::text AS depends_on_status,
            t.due_at, t.evidence, t.waived_by, t.waived_reason, t.completed_by, t.completed_at
       FROM close_tasks t
       LEFT JOIN close_tasks d ON d.id = t.depends_on_task_id
      WHERE t.close_run_id = $1
      ORDER BY t.sequence, t.code`,
    [closeRunId],
  );
  return rows;
}

export interface ChecklistSnapshot {
  readonly items: readonly ChecklistItem[];
  readonly tasks: readonly CloseTaskRow[];
  readonly reconciliations: readonly RequiredReconciliationRow[];
  readonly readiness: Readiness;
}

/**
 * Everything this close asked for, derived now — never read from
 * `readiness_percent`.
 *
 * The stored column is a materialisation for listing and for anyone reading the
 * table directly; every decision recomputes, because between the write and the
 * decision a reconciliation can be reopened, a task can be added by a regenerated
 * checklist, and an account can be marked as a control account.
 */
export async function collectChecklist(
  client: PoolClient,
  run: Pick<CloseRunRow, 'id' | 'legal_entity_id' | 'accounting_book_id' | 'accounting_period_id'>,
): Promise<ChecklistSnapshot> {
  const tasks = await loadCloseTasks(client, run.id);
  const reconciliations = await loadRequiredReconciliations(client, run);

  const items: ChecklistItem[] = [
    ...tasks.map((t): ChecklistItem => {
      const verdict = taskSatisfaction(t);
      return {
        kind: 'TASK',
        reference: t.code,
        label: t.name,
        required: t.required,
        satisfied: verdict.satisfied,
        state: t.status,
        unsatisfiedBecause: verdict.because,
      };
    }),
    ...reconciliations.map((r): ChecklistItem => {
      const verdict = reconciliationSatisfaction(r);
      return {
        kind: 'RECONCILIATION',
        reference: r.account_code,
        label: r.account_name,
        // A control account is not optional: Gate D's claim is about the control
        // accounts, so an entity cannot make its own reconciliation advisory.
        required: true,
        satisfied: verdict.satisfied,
        state: r.status ?? 'MISSING',
        unsatisfiedBecause: verdict.because,
      };
    }),
  ];

  return { items, tasks, reconciliations, readiness: deriveReadiness(items) };
}

/**
 * Writes the derived percentage back onto the run, and moves OPEN -> IN_PROGRESS
 * -> READY with it.
 *
 * Never touches a COMPLETED or REOPENED run: those two are decisions, and a
 * recomputation is not allowed to undo one. `close_runs_completed_uq` also depends
 * on COMPLETED meaning what it says.
 */
export async function persistReadiness(
  client: PoolClient,
  run: CloseRunRow,
  readiness: Readiness,
): Promise<{ status: string; readiness_percent: string }> {
  if (run.status === 'COMPLETED' || run.status === 'REOPENED') {
    return { status: run.status, readiness_percent: readiness.readinessPercent };
  }
  const status = readiness.complete
    ? 'READY'
    : readiness.requiredSatisfied > 0 || readiness.waivedCount > 0
      ? 'IN_PROGRESS'
      : 'OPEN';

  const { rows } = await client.query<{ status: string; readiness_percent: string }>(
    `UPDATE close_runs
        SET readiness_percent = $2::numeric, status = $3::close_run_status
      WHERE id = $1
      RETURNING status::text AS status, readiness_percent::text AS readiness_percent`,
    [run.id, readiness.readinessPercent, status],
  );
  return rows[0]!;
}

/**
 * The close run's own scope, restated as a refusal rather than left to a foreign
 * key.
 *
 * `cr_entity_scope_fk` and friends would catch a cross-tenant reference at INSERT
 * with CROSS_ENTITY_REFERENCE, which is correct but arrives without saying which
 * of the four ids was the wrong one.
 */
export function assertSameEntity(
  what: string,
  expected: string,
  actual: string,
  detail: Record<string, unknown> = {},
): void {
  if (expected !== actual) {
    throw new AppError(
      'CROSS_ENTITY_REFERENCE',
      `${what} belongs to legal entity ${actual}, not ${expected}. A close is scoped to one ` +
        `entity, one book and one period (ADR-0002).`,
      { details: { expected, actual, ...detail } },
    );
  }
}

export function assertSameTenant(what: string, expected: string, actual: string): void {
  if (expected !== actual) {
    throw new AppError('TENANT_MISMATCH', `${what} belongs to another tenant.`, {
      details: { expected, actual },
    });
  }
}
