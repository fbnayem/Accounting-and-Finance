/**
 * Budget control — doc 10 "Budgets" and "Budget control", computed pure.
 *
 * doc 10's formula, verbatim:
 *
 *   Available = Approved Budget - Actual Posted - Open Commitments - Pending Approved Spend
 *
 * F-106 found that /budget-control/check had no substrate, so the blueprint's
 * block/warn/override policy could only ever have been advisory. The arithmetic
 * lives here, pure, so that the enforcement point and the Available Budget report
 * cannot disagree about what "available" means — they call the same function.
 */

import { D, type Decimal, MONEY_SCALE } from './decimal';
import { AppError } from './errors';

// ---------------------------------------------------------------------------
// Budget control (doc 10 "Budget control")
// ---------------------------------------------------------------------------

/** Mirrors `budget_control_policy` in 0000_extensions_and_types.sql, exactly. */
export const BUDGET_CONTROL_POLICIES = [
  'INFORMATIONAL',
  'WARN',
  'BLOCK',
  'REQUIRE_OVERRIDE',
] as const;
export type BudgetControlPolicy = (typeof BUDGET_CONTROL_POLICIES)[number];

export interface BudgetControlInput {
  readonly policy: BudgetControlPolicy;
  /**
   * `budgets.control_threshold_pct` — the percentage of approved budget at which
   * WARN speaks. Nullable in the schema (F-310: the blueprint shipped no
   * default), so it is nullable here rather than invented.
   */
  readonly warnThresholdPct?: Decimal | null;
  readonly approvedBudget: Decimal;
  readonly actualPosted: Decimal;
  readonly openCommitments: Decimal;
  readonly pendingApprovedSpend: Decimal;
  /**
   * The spend being checked now. It must not already be counted in any of the
   * three consumption terms, or it is charged against the budget twice.
   */
  readonly proposedSpend: Decimal;
}

export type BudgetControlDecision = 'PROCEED' | 'WARN' | 'BLOCK' | 'OVERRIDE_REQUIRED';

/**
 * Every term of doc 10's formula, not just the answer. "Over budget" without by
 * how much, against what, and which term consumed it is not actionable — the
 * available figure is the number a person is going to argue with, and the
 * argument is settled by seeing whether it was actuals, commitments or pending
 * spend that ate it.
 */
export interface BudgetControlVerdict {
  readonly policy: BudgetControlPolicy;
  readonly approvedBudget: Decimal;
  readonly actualPosted: Decimal;
  readonly openCommitments: Decimal;
  readonly pendingApprovedSpend: Decimal;
  /** doc 10: Approved − Actual − Open Commitments − Pending. Before this spend. */
  readonly available: Decimal;
  readonly proposedSpend: Decimal;
  /** `available` − `proposedSpend`: what would remain if this spend proceeds. */
  readonly availableAfter: Decimal;
  readonly overBudget: boolean;
  /** How far over: −availableAfter when over budget, zero otherwise. */
  readonly overBudgetBy: Decimal;
  readonly warnThresholdPct: Decimal | null;
  /** approvedBudget × pct ÷ 100 — the threshold as money, comparable to spend. */
  readonly warnThresholdAmount: Decimal | null;
  readonly decision: BudgetControlDecision;
  /** The whole formula as a sentence, for logs and refusal messages. */
  readonly explanation: string;
}

/**
 * Evaluates one proposed spend against doc 10's four policies.
 *
 * Boundary semantics, because the boundaries are where the arguments happen:
 * a spend that lands available exactly at zero is not "over budget" (BLOCK and
 * REQUIRE_OVERRIDE let it through), and consumption exactly at the WARN
 * threshold is not "above a threshold" (doc 10's words), so it does not warn.
 *
 * Returns a verdict rather than throwing: which decisions are refusals — and
 * whether an override permission converts one — is the caller's policy, and a
 * pure function that throws on BLOCK could never serve the Available Budget
 * report or the informational check.
 */
export function evaluateBudgetControl(input: BudgetControlInput): BudgetControlVerdict {
  const approvedBudget = input.approvedBudget.rescale(MONEY_SCALE);
  const actualPosted = input.actualPosted.rescale(MONEY_SCALE);
  const openCommitments = input.openCommitments.rescale(MONEY_SCALE);
  const pendingApprovedSpend = input.pendingApprovedSpend.rescale(MONEY_SCALE);
  const proposedSpend = input.proposedSpend.rescale(MONEY_SCALE);

  const available = approvedBudget
    .sub(actualPosted)
    .sub(openCommitments)
    .sub(pendingApprovedSpend)
    .rescale(MONEY_SCALE);
  const availableAfter = available.sub(proposedSpend).rescale(MONEY_SCALE);
  const overBudget = availableAfter.isNegative();
  const overBudgetBy = overBudget ? availableAfter.negate() : D('0', MONEY_SCALE);

  const warnThresholdPct = input.warnThresholdPct ?? null;
  const warnThresholdAmount =
    warnThresholdPct === null
      ? null
      : approvedBudget.mul(warnThresholdPct).div(D('100'), MONEY_SCALE);

  let decision: BudgetControlDecision;
  switch (input.policy) {
    case 'INFORMATIONAL':
      // doc 10: "informational only". The numbers are still reported in full —
      // this policy changes what happens, not what is true.
      decision = 'PROCEED';
      break;
    case 'WARN': {
      // Consumption including this spend, compared against the threshold as an
      // amount rather than as a ratio: dividing by an approved budget of zero
      // has no answer, but a threshold of zero money does.
      const consumedAfter = approvedBudget.sub(availableAfter);
      // A NULL threshold warns only once actually over budget (100%). Inventing
      // a stricter default here would fire warnings no budget owner configured.
      const threshold = warnThresholdAmount ?? approvedBudget;
      decision = consumedAfter.gt(threshold) ? 'WARN' : 'PROCEED';
      break;
    }
    case 'BLOCK':
      decision = overBudget ? 'BLOCK' : 'PROCEED';
      break;
    case 'REQUIRE_OVERRIDE':
      decision = overBudget ? 'OVERRIDE_REQUIRED' : 'PROCEED';
      break;
  }

  const explanation =
    `available ${available.toString()} = approved ${approvedBudget.toString()}` +
    ` - actual posted ${actualPosted.toString()}` +
    ` - open commitments ${openCommitments.toString()}` +
    ` - pending approved spend ${pendingApprovedSpend.toString()};` +
    ` proposed spend ${proposedSpend.toString()} leaves ${availableAfter.toString()}` +
    (overBudget ? ` — over budget by ${overBudgetBy.toString()}.` : '.');

  return {
    policy: input.policy,
    approvedBudget,
    actualPosted,
    openCommitments,
    pendingApprovedSpend,
    available,
    proposedSpend,
    availableAfter,
    overBudget,
    overBudgetBy,
    warnThresholdPct,
    warnThresholdAmount,
    decision,
    explanation,
  };
}

// ---------------------------------------------------------------------------
// Commitment relief (doc 10 "Commitments may come from approved requisitions
// and/or purchase orders. Cancel/close releases remaining commitment.")
// ---------------------------------------------------------------------------

/** Mirrors `commitment_status` in 0000_extensions_and_types.sql, exactly. */
export const COMMITMENT_STATUSES = ['OPEN', 'PARTIALLY_RELIEVED', 'RELIEVED', 'CANCELLED'] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

export interface CommitmentState {
  readonly id: string;
  readonly committedAmount: Decimal;
  readonly relievedAmount: Decimal;
  readonly status: CommitmentStatus;
}

export interface RelievedCommitment {
  readonly id: string;
  readonly committedAmount: Decimal;
  readonly relievedAmount: Decimal;
  /** committed − relieved — derived here exactly as `commitments_open_derived` derives it. */
  readonly openAmount: Decimal;
  readonly status: Extract<CommitmentStatus, 'PARTIALLY_RELIEVED' | 'RELIEVED'>;
}

/**
 * Relieves part or all of a commitment: billing against a PO relieves what the
 * bill consumed; closing or cancelling a PO relieves the whole open amount
 * (doc 10 acceptance: "Closing/canceling PO releases unused commitment").
 *
 * The database CHECKs (`commitments_relieved_bounded`, `commitments_open_derived`)
 * would refuse an over-relief a moment later, but a caller told "constraint
 * violated" cannot act on it — so the refusal happens here, naming what was
 * attempted against what remained. Status is derived alongside open_amount so
 * the pair cannot drift: a row claiming PARTIALLY_RELIEVED with nothing open is
 * a bug this function makes unrepresentable.
 */
export function relieveCommitment(
  commitment: CommitmentState,
  amount: Decimal,
): RelievedCommitment {
  const committed = commitment.committedAmount.rescale(MONEY_SCALE);
  const alreadyRelieved = commitment.relievedAmount.rescale(MONEY_SCALE);
  const open = committed.sub(alreadyRelieved).rescale(MONEY_SCALE);
  const relief = amount.rescale(MONEY_SCALE);

  if (committed.isNegative() || alreadyRelieved.isNegative() || alreadyRelieved.gt(committed)) {
    // A row like this cannot have come through the CHECKs, so this is not a bad
    // request to bounce back at the caller — it is our invariant broken, and it
    // must surface as a 500, not a 422 blaming whoever asked.
    throw new AppError(
      'INTERNAL',
      `commitment ${commitment.id} is in an impossible state: committed ${committed.toString()}, ` +
        `relieved ${alreadyRelieved.toString()}.`,
      { safeToExpose: false },
    );
  }

  if (commitment.status === 'RELIEVED' || commitment.status === 'CANCELLED') {
    throw new AppError(
      'VALIDATION_FAILED',
      `COMMITMENT_NOT_OPEN: commitment ${commitment.id} is ${commitment.status}; ` +
        `there is nothing left to relieve.`,
      { details: { commitmentId: commitment.id, status: commitment.status } },
    );
  }

  if (!relief.isPositive()) {
    // Zero relieves nothing and a negative amount would grow the commitment —
    // re-committing is a new commitment row, not a negative relief of this one.
    throw new AppError(
      'VALIDATION_FAILED',
      `COMMITMENT_RELIEF_NOT_POSITIVE: cannot relieve ${relief.toString()} of commitment ` +
        `${commitment.id}; relief must be a positive amount.`,
      { details: { commitmentId: commitment.id, attempted: relief.toString() } },
    );
  }

  if (relief.gt(open)) {
    throw new AppError(
      'OVER_ALLOCATION',
      `COMMITMENT_OVER_RELIEF: relieving ${relief.toString()} exceeds the ${open.toString()} ` +
        `open on commitment ${commitment.id} (committed ${committed.toString()}, ` +
        `already relieved ${alreadyRelieved.toString()}).`,
      {
        details: {
          commitmentId: commitment.id,
          attempted: relief.toString(),
          open: open.toString(),
          committed: committed.toString(),
          already_relieved: alreadyRelieved.toString(),
        },
      },
    );
  }

  const relievedAmount = alreadyRelieved.add(relief).rescale(MONEY_SCALE);
  const openAmount = committed.sub(relievedAmount).rescale(MONEY_SCALE);
  return {
    id: commitment.id,
    committedAmount: committed,
    relievedAmount,
    openAmount,
    status: openAmount.isZero() ? 'RELIEVED' : 'PARTIALLY_RELIEVED',
  };
}
