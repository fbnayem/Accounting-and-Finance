/**
 * The gate between the close run and the period.
 *
 * The audit's first Phase 6 finding: "hard-closing a period is COMPLETELY
 * DECOUPLED from the close run, so the dashboard cannot gate anything." Both halves
 * of that sentence were true — `transitionPeriod` in finance-setup checks the
 * status transition, the permission, the reason and that earlier periods are
 * closed, and it has never looked at `close_runs` at all. A period could therefore
 * be hard-closed with every checklist task open and every control account
 * unreconciled, and the close dashboard would go on showing the outstanding work
 * beside a period nobody could post to any more.
 *
 * `assertPeriodReadyForHardClose` is that missing check, written here rather than
 * in finance-setup because the rule is close's rule and because two copies of
 * "what complete means" is how the dashboard and the gate come to disagree.
 * finance-setup calls it — one line, in the integration notes.
 *
 * Two properties matter more than the check itself:
 *
 *   - **Absence is a refusal.** A period with NO close run at all is not ready;
 *     it is unproven. The vacuous reading — nothing configured, therefore nothing
 *     outstanding, therefore complete — is the failure this codebase keeps meeting,
 *     and it is refused explicitly at every level here: no book, no run, no
 *     required item.
 *   - **It re-derives.** A close run finalized last week whose reconciliation was
 *     reopened yesterday is not complete today, and the gate says so, because it
 *     recomputes rather than reading `status = 'COMPLETED'` and stopping.
 */
import { PoolClient } from 'pg';
import { AppError } from '@acct/domain';
import { collectChecklist, loadPeriod, type CloseRunRow } from './internals';
import { describeBlocking } from './readiness';
import {
  APPROVAL_RESOURCE,
  assertReopenApproved,
  type ApprovalFact,
  type ApprovalReader,
} from './approvals';

export interface BookCloseState {
  readonly accountingBookId: string;
  readonly bookCode: string;
  readonly closeRunId: string | null;
  readonly closeRunStatus: string | null;
  readonly readinessPercent: string;
  readonly requiredTotal: number;
  readonly requiredSatisfied: number;
  readonly complete: boolean;
}

export interface PeriodCloseReadiness {
  readonly accountingPeriodId: string;
  readonly periodName: string;
  readonly books: readonly BookCloseState[];
  readonly ready: boolean;
}

/**
 * The state of every book's close for a period — the dashboard's answer to "may
 * this period be hard-closed", computed the same way the refusal is.
 */
export async function periodCloseReadiness(
  client: PoolClient,
  accountingPeriodId: string,
): Promise<PeriodCloseReadiness> {
  const period = await loadPeriod(client, accountingPeriodId);

  const { rows: books } = await client.query<{ id: string; code: string }>(
    `SELECT id, code FROM accounting_books
      WHERE legal_entity_id = $1 AND status = 'ACTIVE'
      ORDER BY code`,
    [period.legal_entity_id],
  );

  const states: BookCloseState[] = [];
  for (const book of books) {
    const { rows: runs } = await client.query<
      Pick<
        CloseRunRow,
        'id' | 'legal_entity_id' | 'accounting_book_id' | 'accounting_period_id' | 'status'
      >
    >(
      `SELECT id, legal_entity_id, accounting_book_id, accounting_period_id, status::text AS status
         FROM close_runs
        WHERE accounting_book_id = $1 AND accounting_period_id = $2 AND status = 'COMPLETED'
        LIMIT 1`,
      [book.id, accountingPeriodId],
    );
    const run = runs[0];
    if (!run) {
      const { rows: latest } = await client.query<{ id: string; status: string }>(
        `SELECT id, status::text AS status FROM close_runs
          WHERE accounting_book_id = $1 AND accounting_period_id = $2
          ORDER BY version DESC LIMIT 1`,
        [book.id, accountingPeriodId],
      );
      states.push({
        accountingBookId: book.id,
        bookCode: book.code,
        closeRunId: latest[0]?.id ?? null,
        closeRunStatus: latest[0]?.status ?? null,
        readinessPercent: '0.0000',
        requiredTotal: 0,
        requiredSatisfied: 0,
        complete: false,
      });
      continue;
    }
    const checklist = await collectChecklist(client, run);
    states.push({
      accountingBookId: book.id,
      bookCode: book.code,
      closeRunId: run.id,
      closeRunStatus: run.status,
      readinessPercent: checklist.readiness.readinessPercent,
      requiredTotal: checklist.readiness.requiredTotal,
      requiredSatisfied: checklist.readiness.requiredSatisfied,
      complete: checklist.readiness.complete,
    });
  }

  return {
    accountingPeriodId,
    periodName: period.name,
    books: states,
    ready: states.length > 0 && states.every((s) => s.complete),
  };
}

/**
 * Throws unless every active book of the period's entity has a COMPLETED close run
 * whose checklist and reconciliations are complete right now.
 *
 * Called from `FinanceSetupService.transitionPeriod` when `to === 'HARD_CLOSED'`,
 * inside the same transaction that holds `FOR UPDATE` on the period — so a task
 * cannot be un-completed between the check and the close.
 */
export async function assertPeriodReadyForHardClose(
  client: PoolClient,
  accountingPeriodId: string,
): Promise<PeriodCloseReadiness> {
  const period = await loadPeriod(client, accountingPeriodId);
  const readiness = await periodCloseReadiness(client, accountingPeriodId);

  if (readiness.books.length === 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Hard-closing ${period.name} is refused: the entity has no active accounting book, so there ` +
        `is no close to prove complete. A period nothing was closed against cannot be signed off ` +
        `as closed.`,
      { details: { accounting_period_id: accountingPeriodId } },
    );
  }

  const missing = readiness.books.filter(
    (b) => b.closeRunId === null || b.closeRunStatus !== 'COMPLETED',
  );
  if (missing.length > 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Hard-closing ${period.name} is refused: no completed close run for book(s) ` +
        `${missing.map((b) => b.bookCode).join(', ')}. doc 21 Phase 6 requires the close dashboard ` +
        `to prove the configured reconciliations and checklists complete before the hard close; ` +
        `create the close run (POST /close-runs), work it, and finalize it ` +
        `(POST /close-runs/{id}/finalize) first.`,
      {
        details: {
          accounting_period_id: accountingPeriodId,
          books: missing.map((b) => ({ book: b.bookCode, status: b.closeRunStatus })),
        },
      },
    );
  }

  // A COMPLETED run whose work has since come undone. Re-derived rather than
  // trusted: a certified reconciliation can be reopened, and a regenerated
  // checklist can add a task, after the close was finalized.
  for (const book of readiness.books) {
    if (book.complete) continue;
    const { rows } = await client.query<
      Pick<
        CloseRunRow,
        'id' | 'legal_entity_id' | 'accounting_book_id' | 'accounting_period_id' | 'status'
      >
    >(
      `SELECT id, legal_entity_id, accounting_book_id, accounting_period_id, status::text AS status
         FROM close_runs WHERE id = $1`,
      [book.closeRunId],
    );
    const run = rows[0];
    const checklist = run ? await collectChecklist(client, run) : null;
    throw new AppError(
      'VALIDATION_FAILED',
      `Hard-closing ${period.name} is refused: close run ${book.closeRunId} for book ` +
        `${book.bookCode} is recorded COMPLETED but is not complete now — ` +
        `${book.requiredSatisfied} of ${book.requiredTotal} required items ` +
        `(${book.readinessPercent}%)` +
        (checklist && checklist.readiness.blocking.length > 0
          ? `. Outstanding: ${describeBlocking(checklist.readiness.blocking)}`
          : checklist && !checklist.readiness.configured
            ? '. Nothing is configured for this close, so its completeness proves nothing'
            : '') +
        `. Reopen the close, finish the work, and finalize it again.`,
      { details: { accounting_period_id: accountingPeriodId, close_run_id: book.closeRunId } },
    );
  }

  return readiness;
}

/**
 * Throws unless reopening this period has been approved by a third person.
 *
 * The other half of exit criterion "reopening a period is privileged, approved and
 * audited", for the calendar period rather than the close run. finance-setup calls
 * it from `transitionPeriod` when `to === 'OPEN'`.
 *
 * `accounting_periods.closed_by` is the person being overruled, and it is a real
 * column, so unlike the close run there is nothing to reconstruct — but it is
 * nullable, and a NULL there is refused rather than treated as "nobody to be
 * different from".
 */
export async function assertPeriodReopenApproved(
  client: PoolClient,
  approvals: ApprovalReader,
  input: { tenantId: string; accountingPeriodId: string; actorId: string | null },
): Promise<ApprovalFact> {
  const period = await loadPeriod(client, input.accountingPeriodId);

  const facts = await approvals.approvalsFor(client, {
    tenantId: input.tenantId,
    resourceType: APPROVAL_RESOURCE.accountingPeriod,
    resourceId: input.accountingPeriodId,
    since: period.closed_at,
  });

  return assertReopenApproved(facts, {
    subject: `period ${period.name}`,
    actorId: input.actorId,
    supersedes: { role: 'closed this period', userId: period.closed_by },
    since: period.closed_at,
    requestHint:
      'Raise an approval request against resource_type "accounting_period" for this period and ' +
      'have somebody other than the person who closed it decide it ' +
      '(POST /approval-tasks/{id}/approve), then retry.',
  });
}
