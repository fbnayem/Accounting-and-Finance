/**
 * The journal approval threshold, and the maker/checker rule that goes with it.
 *
 * `accounting_policies.journal_approval_threshold` shipped in Phase 0, was read
 * into `BookContext.journalApprovalThreshold` in Phase 2, and was compared to
 * nothing until migration 0049. A tenant could set it, watch it persist, and get
 * no enforcement at all — so Phase 6's exit criterion, "approval bypass attempts
 * fail at API/domain layer", had nothing to bypass.
 *
 * The decision lives here rather than inline in `commitPosting` for two reasons.
 * The first is that a boundary rule deserves cases of its own: Gate F says
 * "approval thresholds and conditions pass boundary tests", and a rule embedded
 * in a method that needs a database, a period lock and a balanced journal to
 * reach cannot be given a table of amounts. The second is that the database says
 * the same thing (0049's `assert_journal_approval`), and when two layers state
 * one rule the only way they stay the same rule is if each is small enough to
 * read against the other.
 *
 * Both halves matter equally. A control that refuses everything is not a control
 * — it is an outage — so `under the threshold, no approval` is as much a part of
 * the specification as `at or over it, approval required`, and both are tested.
 */
import { AppError, D } from '@acct/domain';

export interface JournalApprovalFacts {
  /**
   * The book's effective `journal_approval_threshold`, or null when the tenant
   * has not configured one.
   *
   * NULL is the shipped default and must stay permissive. Treating an unset
   * threshold as zero would demand approval for every journal in every tenant on
   * the estate the moment this shipped, which is not enforcement, it is a stop.
   */
  readonly threshold: string | null;
  /** The journal's absolute value in the book's base currency, as an exact decimal string. */
  readonly amount: string;
  readonly currency: string;
  /** `journal_entries.created_by`. */
  readonly preparedBy: string | null;
  /** `journal_entries.approved_by`. */
  readonly approvedBy: string | null;
  /** Entry number if it has one, else its id — the reference a caller can quote. */
  readonly reference: string;
  /**
   * True when this entry reverses one that carries an approval of its own.
   *
   * doc 01 rule 4 corrects posted history by reversal, and no route approves a
   * reversal: it is created and posted by a single command. Requiring a fresh
   * approval would leave every approved journal impossible to reverse. The
   * exemption is narrow and mirrors 0049's — it counts only when the entry being
   * reversed actually carries an approval, so a large entry claiming to reverse a
   * small unapproved one is still refused.
   */
  readonly reversesApprovedEntry?: boolean | undefined;
}

/**
 * "Meets or exceeds" — `>=`, so the threshold itself is inside the control.
 *
 * A tenant who writes 10000 means "ten thousand needs approving". Reading it as
 * `>` puts the single most common round number a person will test with on the
 * permissive side, and the tenant discovers the boundary is off by one cent at
 * the audit rather than at the demo.
 */
export function meetsApprovalThreshold(threshold: string | null, amount: string): boolean {
  if (threshold === null) return false;
  return D(amount).abs().gte(D(threshold).abs());
}

/**
 * Throws unless this journal may become POSTED.
 *
 * Called inside the posting transaction, before the status flip. The database
 * repeats the check at COMMIT; this one exists so the caller gets an actionable
 * message rather than a mapped constraint violation, and so the refusal names
 * the two numbers the caller has to reconcile.
 */
export function assertJournalApproval(facts: JournalApprovalFacts): void {
  // Maker/checker is unconditional: it is a statement about approvals, not about
  // large approvals. The same rule is `je_maker_checker` in the database.
  if (facts.approvedBy !== null) {
    if (facts.preparedBy === null) {
      throw new AppError(
        'SEGREGATION_OF_DUTIES',
        `Journal ${facts.reference} records an approval but no preparer, so nothing can show the ` +
          'approver and the preparer are different people. An approval against an unknown ' +
          'preparer is not a control (doc 14 maker/checker).',
        { details: { journal: facts.reference, approved_by: facts.approvedBy } },
      );
    }
    if (facts.preparedBy === facts.approvedBy) {
      throw new AppError(
        'SEGREGATION_OF_DUTIES',
        `Journal ${facts.reference} was prepared and approved by the same person. Gate F requires ` +
          'the two to be different people (doc 14 maker/checker).',
        { details: { journal: facts.reference, user_id: facts.approvedBy } },
      );
    }
  }

  if (!meetsApprovalThreshold(facts.threshold, facts.amount)) return;
  if (facts.approvedBy !== null) return;
  if (facts.reversesApprovedEntry === true) return;

  // The threshold and the amount are both in the MESSAGE, not only in `details`.
  // `AppError.details` is log-only — it never reaches the response body — so a
  // caller who has to act on this refusal would otherwise learn nothing from it
  // beyond the word "approval".
  throw new AppError(
    'APPROVAL_REQUIRED',
    `Journal ${facts.reference} totals ${facts.amount} ${facts.currency}, at or above this ` +
      `entity's journal approval threshold of ${facts.threshold} ${facts.currency}. It cannot ` +
      'post until someone other than the person who prepared it approves it ' +
      '(POST /journals/{id}/submit, then POST /journals/{id}/approve).',
    {
      details: {
        journal: facts.reference,
        amount: facts.amount,
        threshold: facts.threshold,
        currency: facts.currency,
      },
    },
  );
}
