/**
 * The step state machine and the segregation-of-duties rules.
 *
 * Pure, and separate from the service, for the reason `packages/ledger/src/
 * approval.ts` gives about the journal threshold: Gate F says "approval
 * thresholds and conditions pass boundary tests", and a rule that needs a
 * database, a workflow and three users to reach cannot be given a table of
 * cases. Everything here is decided from values.
 *
 * Two things this file refuses to do, both deliberate:
 *
 *   - It never treats an expiry as an approval. `isActionable` returns false for
 *     an expired step, so the request stays PENDING and its document stays parked.
 *     Failing CLOSED means a stuck document that a human unblocks; failing OPEN
 *     means an unreviewed payment. Only one of those is recoverable.
 *   - It never lets a NULL stand in for a satisfied rule. Every maker/checker
 *     comparison below is written so an unknown preparer REFUSES, because
 *     `approver <> preparer` against a NULL preparer is NULL, and this codebase
 *     has now met that failure in a CHECK constraint (`pr_maker_checker`), in a
 *     service and in a test that asserted nothing.
 */
import { AppError, D } from '@acct/domain';

export type StepStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'NOT_REQUIRED';
export type Decision = 'APPROVE' | 'REJECT' | 'REQUEST_CHANGES' | 'DELEGATE';

export interface StepState {
  readonly id: string;
  readonly stepNo: number;
  readonly isParallel: boolean;
  readonly approverUserId: string | null;
  readonly approverRoleId: string | null;
  readonly resolvedFrom: string | null;
  readonly status: StepStatus;
  readonly decision: Decision | null;
  readonly decidedBy: string | null;
  /** ISO timestamp, or null when the step has no clock running. */
  readonly expiresAt: string | null;
}

/**
 * The step number that may be decided right now.
 *
 * The lowest step number that still has a PENDING row. Steps are materialised in
 * full at request time — doc 14: "Resolved approvers are recorded on the
 * instance" — so a later step's rows exist from the start and must not be
 * actionable. Deciding step 3 before step 1 is the simplest possible approval
 * bypass and `isActionable` is what refuses it.
 */
export function activeStepNo(steps: readonly StepState[]): number | null {
  const pending = steps.filter((s) => s.status === 'PENDING').map((s) => s.stepNo);
  return pending.length === 0 ? null : Math.min(...pending);
}

export interface ActionabilityInput {
  readonly step: StepState;
  readonly steps: readonly StepState[];
  readonly now: Date;
}

export type NotActionable =
  | { readonly kind: 'DECIDED'; readonly status: StepStatus }
  | { readonly kind: 'NOT_ACTIVE'; readonly activeStepNo: number | null }
  | { readonly kind: 'EXPIRED'; readonly expiredAt: string };

/** Null when the step may be decided; otherwise why not. */
export function notActionableBecause({
  step,
  steps,
  now,
}: ActionabilityInput): NotActionable | null {
  if (step.status !== 'PENDING') return { kind: 'DECIDED', status: step.status };
  const active = activeStepNo(steps);
  if (active !== step.stepNo) return { kind: 'NOT_ACTIVE', activeStepNo: active };
  if (step.expiresAt !== null && new Date(step.expiresAt).getTime() <= now.getTime()) {
    return { kind: 'EXPIRED', expiredAt: step.expiresAt };
  }
  return null;
}

export function isActionable(input: ActionabilityInput): boolean {
  return notActionableBecause(input) === null;
}

/**
 * Turns the refusal into the message the caller acts on.
 *
 * `AppError.details` is log-only, so everything the caller needs is in the text.
 */
export function refuseNotActionable(reason: NotActionable, stepNo: number): AppError {
  if (reason.kind === 'DECIDED') {
    return new AppError(
      'VALIDATION_FAILED',
      `This approval step is already ${reason.status} and cannot be decided again.`,
      { details: { status: reason.status } },
    );
  }
  if (reason.kind === 'NOT_ACTIVE') {
    return new AppError(
      'VALIDATION_FAILED',
      `Approval step ${stepNo} is not the step awaiting a decision; step ` +
        `${reason.activeStepNo === null ? '(none)' : reason.activeStepNo} is. A serial workflow is ` +
        `decided in order, and approving a later step first would skip the approvers before it.`,
      { details: { stepNo, activeStepNo: reason.activeStepNo } },
    );
  }
  return new AppError(
    'VALIDATION_FAILED',
    `This approval task expired at ${reason.expiredAt} and can no longer be decided. It has NOT ` +
      `been approved by expiring — the document stays unposted until the task is escalated or ` +
      `reassigned, or the request is withdrawn and raised again.`,
    { details: { expiredAt: reason.expiredAt } },
  );
}

// ---------------------------------------------------------------------------
// Step and request outcomes
// ---------------------------------------------------------------------------

export type StepOutcome = 'PENDING' | 'SATISFIED' | 'REJECTED';

/**
 * The outcome of one step number, given every row that belongs to it.
 *
 * Deterministic in both directions, which is doc 14's acceptance criterion for
 * parallel behaviour:
 *   - one REJECT anywhere in the step rejects the step, whatever else happened.
 *     Rejection dominates because the alternative — last decision wins — makes
 *     the outcome depend on the order two people happened to click.
 *   - otherwise, `quorum` distinct APPROVE decisions satisfy it.
 */
export function stepOutcome(rows: readonly StepState[], quorum: number): StepOutcome {
  if (rows.some((r) => r.status === 'REJECTED')) return 'REJECTED';
  const approvers = new Set(
    rows.filter((r) => r.status === 'APPROVED' && r.decidedBy !== null).map((r) => r.decidedBy!),
  );
  return approvers.size >= quorum ? 'SATISFIED' : 'PENDING';
}

/** Every distinct person who has approved anywhere on this request. */
export function approversSoFar(steps: readonly StepState[]): readonly string[] {
  return [
    ...new Set(
      steps
        .filter((s) => s.status === 'APPROVED' && s.decision === 'APPROVE' && s.decidedBy !== null)
        .map((s) => s.decidedBy!),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Segregation of duties
// ---------------------------------------------------------------------------

export interface SodFacts {
  /** `created_by` on the document. NULL means unknown, which REFUSES. */
  readonly preparedBy: string | null;
  /** `approval_requests.requested_by`. NULL means unknown, which REFUSES. */
  readonly requestedBy: string | null;
  /** Who is acting now. */
  readonly actorId: string;
  /**
   * Whose authority the actor is exercising. Equal to `actorId` for a direct
   * approver; the delegator's id when the actor holds a delegation.
   */
  readonly authorityOf: string;
  /** Distinct people who have already approved this request. */
  readonly priorApprovers: readonly string[];
  /** True when the workflow forbids one person satisfying two steps. */
  readonly requireDistinctApprovers: boolean;
  /** A reference the message can quote — an entry number, a document number. */
  readonly reference: string;
}

function sod(message: string, details: Record<string, unknown>): AppError {
  return new AppError('SEGREGATION_OF_DUTIES', message, { details });
}

/**
 * Throws unless this person may record this approval.
 *
 * doc 14's configurable constraints, in the order they can be decided from these
 * facts. Every one of them is written so that an unknown value refuses.
 */
export function assertSegregationOfDuties(facts: SodFacts): void {
  // 1. The preparer must be KNOWN. This is the NULL-safety half, and it is the
  //    whole reason `je_maker_checker` was rewritten in 0049: without it, a
  //    document with no recorded preparer accepts any approver — including the
  //    person who wrote it — and does so silently, because the comparison
  //    evaluates to NULL and a NULL is not a refusal.
  if (facts.preparedBy === null) {
    throw sod(
      `${facts.reference} records no preparer, so nothing can show that the approver is a ` +
        `different person. An approval against an unknown preparer is not a control (doc 14 ` +
        `maker/checker). Record who prepared the document, then request approval again.`,
      { reference: facts.reference },
    );
  }
  if (facts.requestedBy === null) {
    throw sod(
      `The approval request on ${facts.reference} records no requester, so the approver cannot be ` +
        `shown to be someone other than the person who asked for it.`,
      { reference: facts.reference },
    );
  }

  // 2. Preparer and approver must differ — and so must the person whose
  //    authority is being exercised, or delegating a task to the preparer would
  //    launder the rule that the delegation is explicitly forbidden to violate
  //    ("Delegation cannot violate segregation-of-duties", doc 14).
  if (facts.actorId === facts.preparedBy) {
    throw sod(
      `You prepared ${facts.reference}, so you cannot approve it. Gate F requires the preparer and ` +
        `the approver to be different people (doc 14 maker/checker).`,
      { reference: facts.reference, userId: facts.actorId },
    );
  }
  if (facts.authorityOf === facts.preparedBy) {
    throw sod(
      `This step is assigned to the person who prepared ${facts.reference}, so acting on their ` +
        `authority — even as their delegate — would let the preparer approve their own document. ` +
        `Delegation cannot violate segregation of duties (doc 14).`,
      { reference: facts.reference, authorityOf: facts.authorityOf },
    );
  }

  // 3. The requester is a maker too: submitting a document for approval is part
  //    of preparing it, so the person who submitted cannot also be the one who
  //    signs it off.
  if (facts.actorId === facts.requestedBy) {
    throw sod(`You requested approval of ${facts.reference}, so you cannot also approve it.`, {
      reference: facts.reference,
      userId: facts.actorId,
    });
  }

  // 4. One person, one approval per request. Without this, a two-step workflow
  //    is satisfied by one person clicking twice, which is a one-step workflow
  //    with a longer audit trail.
  if (facts.requireDistinctApprovers && facts.priorApprovers.includes(facts.actorId)) {
    throw sod(
      `You have already approved ${facts.reference} at an earlier step. This workflow requires each ` +
        `step to be approved by a different person.`,
      { reference: facts.reference, userId: facts.actorId },
    );
  }
}

export interface DualApprovalFacts {
  /** `segregation_rules.threshold_amount`, or null when the rule is not configured. */
  readonly threshold: string | null;
  /** The document's exact value as a decimal string. */
  readonly amount: string;
  readonly currency: string;
  readonly preparedBy: string | null;
  readonly approvers: readonly string[];
  readonly reference: string;
}

/**
 * doc 14: "payment over threshold requires two distinct approvals".
 *
 * Checked when the last step completes rather than per step, because that is
 * when the question "how many distinct people approved this" has its final
 * answer. `>=` on the threshold, matching `meetsApprovalThreshold` in
 * `@acct/ledger` — one convention for every threshold in the platform.
 */
export function assertDualApproval(facts: DualApprovalFacts): void {
  if (facts.threshold === null) return;
  if (D(facts.amount).abs().lt(D(facts.threshold).abs())) return;

  const distinct = new Set(facts.approvers);
  if (facts.preparedBy === null) {
    throw sod(
      `${facts.reference} needs two distinct approvals at ${facts.amount} ${facts.currency}, and it ` +
        `records no preparer, so neither approval can be shown to have come from someone other ` +
        `than the person who prepared it.`,
      { reference: facts.reference },
    );
  }
  if (distinct.has(facts.preparedBy)) {
    throw sod(
      `${facts.reference} was approved by the person who prepared it, which no number of further ` +
        `approvals repairs.`,
      { reference: facts.reference },
    );
  }
  if (distinct.size < 2) {
    throw new AppError(
      'APPROVAL_REQUIRED',
      `${facts.reference} totals ${facts.amount} ${facts.currency}, at or above the dual-approval ` +
        `threshold of ${facts.threshold} ${facts.currency}, and carries ${distinct.size} approval. ` +
        `Two distinct approvals are required, neither of them from the person who prepared it ` +
        `(doc 14 segregation of duties).`,
      {
        details: {
          reference: facts.reference,
          amount: facts.amount,
          threshold: facts.threshold,
          approvals: distinct.size,
        },
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Delegation
// ---------------------------------------------------------------------------

export interface DelegationGrant {
  readonly id: string;
  readonly delegatorUserId: string;
  readonly delegateUserId: string;
  readonly scopeResourceType: string | null;
  readonly legalEntityId: string | null;
  /** Exact decimal string, or null for no cap. */
  readonly maxAmount: string | null;
  readonly validFrom: string;
  readonly validTo: string;
}

export interface DelegationQuestion {
  readonly grants: readonly DelegationGrant[];
  readonly delegatorUserId: string;
  readonly actorId: string;
  readonly resourceType: string;
  readonly legalEntityId: string;
  readonly amount: string;
  readonly now: Date;
}

export type DelegationAnswer =
  | { readonly permitted: true; readonly grant: DelegationGrant }
  | { readonly permitted: false; readonly reason: string };

/**
 * May this actor exercise that approver's authority right now?
 *
 * The window, the scope and the amount cap are all checked, and the amount cap
 * is compared with exact decimals: a delegation capped at 5,000 must not admit a
 * 5,000.01 approval because a float said the two were close enough.
 */
export function delegationPermits(q: DelegationQuestion): DelegationAnswer {
  const candidates = q.grants.filter(
    (g) => g.delegatorUserId === q.delegatorUserId && g.delegateUserId === q.actorId,
  );
  if (candidates.length === 0) {
    return {
      permitted: false,
      reason: 'no delegation from that approver names you as their delegate',
    };
  }
  const now = q.now.getTime();
  for (const grant of candidates) {
    if (new Date(grant.validFrom).getTime() > now) continue;
    if (new Date(grant.validTo).getTime() <= now) continue;
    if (grant.scopeResourceType !== null && grant.scopeResourceType !== q.resourceType) continue;
    if (grant.legalEntityId !== null && grant.legalEntityId !== q.legalEntityId) continue;
    if (grant.maxAmount !== null && D(q.amount).abs().gt(D(grant.maxAmount))) {
      return {
        permitted: false,
        reason:
          `the delegation is capped at ${grant.maxAmount} and this document is ${q.amount}. A ` +
          `delegation that grew with the amount would be a way to route a large approval to a ` +
          `junior approver`,
      };
    }
    return { permitted: true, grant };
  }
  return {
    permitted: false,
    reason: 'the delegation naming you is not in force for this document, entity or moment',
  };
}
