/**
 * Close readiness — the derivation the dashboard displays and the finalize gate
 * refuses on.
 *
 * `close_runs.readiness_percent` has existed since 0016 as a stored number with
 * nothing deriving it: whatever was written into it was what the dashboard showed,
 * and the hard close of the period never read it at all. Two separate defects, and
 * this file fixes the first one. A percentage nobody computes is a decoration; a
 * dashboard that displays a status without gating anything is a display, not a
 * control.
 *
 * Three rules are expressed here rather than in SQL, because they are the rules a
 * reviewer has to be able to read against the criterion:
 *
 *   1. **Nothing configured is nought per cent, never a hundred.** The audit's
 *      finding was that "completeness is vacuous — a close run needs no template
 *      and a period needs no configured reconciliations", so a run with no items
 *      was trivially complete. An empty checklist means the question was never
 *      asked, and the answer to a question nobody asked is not "yes". `configured`
 *      is false in that case and `assertReadyToFinalize` refuses by name.
 *
 *   2. **A NULL comparison passes, so it is checked explicitly.** A task marked
 *      WAIVED whose `waived_by` is NULL, or a reconciliation marked CERTIFIED whose
 *      `prepared_by` or `approved_by` is NULL, is NOT satisfied. `close_tasks_waived_has_reason`
 *      and `recon_sod` are both satisfied by a NULL — `approved_by <> prepared_by`
 *      against a NULL preparer is NULL, which a CHECK accepts — so the row can exist
 *      and must not count. The caller building these items is responsible for
 *      passing the NULL-safety through; `unsatisfiedBecause` records which rule
 *      rejected it so the refusal can say so.
 *
 *   3. **Optional items are reported and never gate.** A run whose optional tasks
 *      are open is finalizable; the gate is about the required set, and a control
 *      that refuses work nobody required is an outage rather than a control.
 *
 * Pure: no database, no clock. The percentage is exact decimal (ADR-0006 §1) at the
 * scale `close_runs.readiness_percent` stores, numeric(7,4).
 */
import { AppError, D } from '@acct/domain';

/** The scale of `close_runs.readiness_percent`. */
export const READINESS_SCALE = 4;

export type ChecklistItemKind = 'TASK' | 'RECONCILIATION';

/**
 * One thing the close asked for, and whether it was done.
 *
 * `state` is the raw state from the database — 'OPEN', 'CERTIFIED', 'MISSING' —
 * and `satisfied` is the decision. They are separate fields on purpose: a
 * CERTIFIED reconciliation with no preparer is state CERTIFIED and satisfied
 * false, and a refusal that could only print the state would say the item was
 * certified while refusing to accept it.
 */
export interface ChecklistItem {
  readonly kind: ChecklistItemKind;
  /** Task code, or account code for a reconciliation — what a person types into a search box. */
  readonly reference: string;
  readonly label: string;
  readonly required: boolean;
  readonly satisfied: boolean;
  readonly state: string;
  /** Why an item that looks done is not counted. Empty when it is genuinely done. */
  readonly unsatisfiedBecause?: string | undefined;
}

export interface Readiness {
  /** Required items, of both kinds. */
  readonly requiredTotal: number;
  readonly requiredSatisfied: number;
  /** numeric(7,4)-compatible decimal string. 0.0000 when nothing is configured. */
  readonly readinessPercent: string;
  /**
   * False when the run asked for nothing at all: no required checklist task and no
   * account configured for reconciliation. Completeness over an empty set is the
   * failure mode this codebase keeps meeting, so it is a distinct field rather
   * than an inference from `requiredTotal === 0` at each call site.
   */
  readonly configured: boolean;
  readonly complete: boolean;
  readonly blocking: readonly ChecklistItem[];
  readonly waivedCount: number;
  readonly optionalOutstanding: number;
}

export function deriveReadiness(items: readonly ChecklistItem[]): Readiness {
  const required = items.filter((i) => i.required);
  const satisfied = required.filter((i) => i.satisfied);
  const blocking = required.filter((i) => !i.satisfied);
  const configured = required.length > 0;

  // Exact decimal, not floating point: this value goes into numeric(7,4) and is
  // read back by the dashboard. 0/0 is 0 here rather than an error or a 100 —
  // see rule 1.
  const readinessPercent = configured
    ? D(satisfied.length).mul(D(100)).div(D(required.length), READINESS_SCALE).toString()
    : D(0, READINESS_SCALE).toString();

  return {
    requiredTotal: required.length,
    requiredSatisfied: satisfied.length,
    readinessPercent,
    configured,
    complete: configured && blocking.length === 0,
    blocking,
    waivedCount: items.filter((i) => i.state === 'WAIVED' && i.satisfied).length,
    optionalOutstanding: items.filter((i) => !i.required && !i.satisfied).length,
  };
}

/** The first few blocking items, rendered for an error message a person must act on. */
export function describeBlocking(blocking: readonly ChecklistItem[], limit = 5): string {
  const shown = blocking.slice(0, limit).map((i) => {
    const kind = i.kind === 'TASK' ? 'task' : 'reconciliation';
    const why = i.unsatisfiedBecause ? ` — ${i.unsatisfiedBecause}` : '';
    return `${kind} ${i.reference} (${i.state}${why})`;
  });
  const rest = blocking.length - shown.length;
  return shown.join('; ') + (rest > 0 ? `; and ${rest} more` : '');
}

export interface FinalizeSubject {
  /** What is being refused — a close run id, or a period name at hard close. */
  readonly subject: string;
  /** The route or act the caller was attempting, named in the refusal. */
  readonly act: string;
  /** Where the caller configures the missing checklist, when nothing is configured. */
  readonly configureHint: string;
}

/**
 * Throws unless this close is genuinely complete.
 *
 * `AppError.details` is log-only, so everything the caller has to act on is in the
 * MESSAGE: what is blocking, and — when nothing is configured — that nothing is,
 * which is a different problem with a different remedy.
 */
export function assertReadyToFinalize(readiness: Readiness, subject: FinalizeSubject): void {
  if (!readiness.configured) {
    throw new AppError(
      'VALIDATION_FAILED',
      `${subject.act} refused: ${subject.subject} has no required checklist task and no account ` +
        `configured for reconciliation, so "everything is complete" would be true only because ` +
        `nothing was asked for. ${subject.configureHint}`,
      { details: { subject: subject.subject, required_total: 0 } },
    );
  }
  if (readiness.blocking.length > 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      `${subject.act} refused: ${readiness.requiredSatisfied} of ${readiness.requiredTotal} ` +
        `required items on ${subject.subject} are complete (${readiness.readinessPercent}%). ` +
        `Outstanding: ${describeBlocking(readiness.blocking)}.`,
      {
        details: {
          subject: subject.subject,
          required_total: readiness.requiredTotal,
          required_satisfied: readiness.requiredSatisfied,
          blocking: readiness.blocking.map((i) => `${i.kind}:${i.reference}:${i.state}`),
        },
      },
    );
  }
}

/**
 * Whether a close task counts as done — NULL-safe, and the only place that decides.
 *
 * WAIVED is the override doc 12 allows ("blocked while required tasks are
 * incomplete unless an override workflow exists"), and an override is only an
 * override when somebody's name is on it. `close_tasks_waived_has_reason` requires
 * the reason and nothing requires the waiver, so a row waived by nobody is
 * possible in the database and is refused here.
 */
export function taskSatisfaction(task: {
  status: string;
  completed_by: string | null;
  waived_by: string | null;
  waived_reason: string | null;
}): { satisfied: boolean; because?: string } {
  if (task.status === 'COMPLETED') {
    if (task.completed_by === null) {
      return { satisfied: false, because: 'marked COMPLETED with no completing user recorded' };
    }
    return { satisfied: true };
  }
  if (task.status === 'WAIVED') {
    if (task.waived_by === null) {
      return { satisfied: false, because: 'waived with no waiving user recorded' };
    }
    if (task.waived_reason === null || task.waived_reason.trim() === '') {
      return { satisfied: false, because: 'waived with no reason recorded' };
    }
    return { satisfied: true };
  }
  return { satisfied: false };
}

/**
 * Whether an account reconciliation counts as done — NULL-safe.
 *
 * `recon_sod` is `approved_by IS NULL OR approved_by <> prepared_by`, which a row
 * with a NULL preparer satisfies: the comparison is NULL and a CHECK accepts NULL.
 * So a CERTIFIED reconciliation prepared by nobody exists as far as the schema is
 * concerned, and it must not close a period.
 */
export function reconciliationSatisfaction(recon: {
  status: string | null;
  prepared_by: string | null;
  approved_by: string | null;
  /** True when the ledger has moved since the GL side was recorded. */
  stale?: boolean | undefined;
}): { satisfied: boolean; because?: string } {
  if (recon.status === null) return { satisfied: false, because: 'no reconciliation prepared' };
  if (recon.status !== 'CERTIFIED' && recon.status !== 'APPROVED') return { satisfied: false };
  if (recon.stale === true) {
    return {
      satisfied: false,
      because:
        'the general ledger has moved since this was certified, so it no longer reconciles the ' +
        'balance the period now carries — prepare and certify it again',
    };
  }
  if (recon.prepared_by === null) {
    return {
      satisfied: false,
      because:
        'certified against no preparer, so nothing shows the certifier and the preparer are different people',
    };
  }
  if (recon.approved_by === null) {
    return { satisfied: false, because: 'certified with no certifying user recorded' };
  }
  if (recon.approved_by === recon.prepared_by) {
    return { satisfied: false, because: 'prepared and certified by the same person' };
  }
  return { satisfied: true };
}
