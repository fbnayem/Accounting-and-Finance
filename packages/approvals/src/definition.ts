/**
 * Workflow definitions — the ordered/parallel steps and how their approvers are
 * resolved (doc 14 "Workflow definition" and "Approver resolution").
 *
 * A published definition is immutable (0017's `guard_published_workflow`) and a
 * running instance keeps the version it started with (`approval_requests`
 * carries `workflow_version` and a full `snapshot`). So this file is where a bad
 * definition has to be caught: once published it cannot be edited, and once a
 * request has started under it the snapshot has already been taken.
 *
 * The strictest rule here is the one about approver resolution methods that the
 * schema cannot actually resolve. `approval_steps.resolved_from` permits
 * MANAGER, DEPARTMENT_OWNER, PROJECT_MANAGER and AMOUNT_AUTHORITY, and there is
 * no manager column on `users`, no owner on a cost centre and no amount-authority
 * table anywhere in the schema. Accepting such a step would produce a request
 * with a step nobody can act on — a document parked in PENDING_APPROVAL for ever,
 * which is an outage wearing a control's clothing. They are refused at
 * definition time, with the reason, rather than discovered at 3pm on a close day.
 */
import { AppError } from '@acct/domain';

export type StepMode = 'SERIAL' | 'PARALLEL';

/** The resolution methods this schema can actually answer. */
export const SUPPORTED_RESOLUTION = ['NAMED_USER', 'ROLE'] as const;
/** In `approval_steps.resolved_from`, and unsupported — see the file comment. */
export const UNSUPPORTED_RESOLUTION = [
  'MANAGER',
  'DEPARTMENT_OWNER',
  'PROJECT_MANAGER',
  'AMOUNT_AUTHORITY',
] as const;

export type ApproverSpec =
  | { readonly resolvedFrom: 'NAMED_USER'; readonly userId: string }
  | { readonly resolvedFrom: 'ROLE'; readonly roleId: string };

export interface StepDefinition {
  readonly stepNo: number;
  readonly mode: StepMode;
  /** How many distinct APPROVE decisions this step needs. SERIAL is always 1. */
  readonly quorum: number;
  readonly approvers: readonly ApproverSpec[];
  /** Hours from the moment the step becomes ACTIVE. Null = never expires. */
  readonly expiresAfterHours: number | null;
  /**
   * What an expiry does. Neither value approves anything — see `steps.ts`.
   * BLOCK leaves the step expired and unapprovable; ESCALATE additionally makes
   * it eligible for `escalation_rules` on the next sweep.
   */
  readonly onExpiry: 'BLOCK' | 'ESCALATE';
}

export interface WorkflowDefinition {
  readonly steps: readonly StepDefinition[];
  /**
   * doc 14 "rejection/request-change behavior". A rejection always terminates
   * the instance — there is no configuration in which one approver's rejection
   * is overridden by a later approver's approval, because that would make the
   * outcome depend on decision order.
   */
  readonly onReject: 'TERMINATE';
  readonly onRequestChanges: 'RETURN_TO_REQUESTER';
  /**
   * Whether one person may satisfy two different steps of the same request.
   * Default true: a two-step approval that one person can complete alone is a
   * one-step approval with extra clicks.
   */
  readonly requireDistinctApprovers: boolean;
}

function fail(message: string, details?: Record<string, unknown>): never {
  throw new AppError('VALIDATION_FAILED', message, details ? { details } : {});
}

function parseApprover(raw: unknown, stepNo: number, index: number): ApproverSpec {
  if (typeof raw !== 'object' || raw === null) {
    fail(`Step ${stepNo} approver ${index + 1} must be an object.`);
  }
  const spec = raw as Record<string, unknown>;
  const method = spec['resolved_from'] ?? spec['resolvedFrom'];
  if (typeof method !== 'string') {
    fail(
      `Step ${stepNo} approver ${index + 1} has no resolved_from. Use ` +
        `${SUPPORTED_RESOLUTION.join(' or ')}.`,
    );
  }
  if ((UNSUPPORTED_RESOLUTION as readonly string[]).includes(method)) {
    fail(
      `Step ${stepNo} approver ${index + 1} resolves from ${method}, which this schema cannot ` +
        `answer: there is no manager on users, no owner on a cost centre, no project manager ` +
        `column and no amount-authority table. A step that resolves to nobody parks the document ` +
        `in PENDING_APPROVAL permanently, so it is refused here rather than at the moment someone ` +
        `needs the document posted. Use ${SUPPORTED_RESOLUTION.join(' or ')}.`,
      { resolvedFrom: method, stepNo },
    );
  }
  if (method === 'NAMED_USER') {
    const userId = spec['user_id'] ?? spec['userId'];
    if (typeof userId !== 'string' || userId.trim() === '') {
      fail(`Step ${stepNo} approver ${index + 1} is a NAMED_USER with no user_id.`);
    }
    return { resolvedFrom: 'NAMED_USER', userId: (userId as string).trim() };
  }
  if (method === 'ROLE') {
    const roleId = spec['role_id'] ?? spec['roleId'];
    if (typeof roleId !== 'string' || roleId.trim() === '') {
      fail(`Step ${stepNo} approver ${index + 1} is a ROLE with no role_id.`);
    }
    return { resolvedFrom: 'ROLE', roleId: (roleId as string).trim() };
  }
  return fail(
    `Step ${stepNo} approver ${index + 1} resolves from "${method}", which is not a resolution ` +
      `method. Use ${SUPPORTED_RESOLUTION.join(' or ')}.`,
  );
}

function parseStep(raw: unknown, expectedStepNo: number): StepDefinition {
  if (typeof raw !== 'object' || raw === null) fail(`Step ${expectedStepNo} must be an object.`);
  const step = raw as Record<string, unknown>;

  const declared = step['step_no'] ?? step['stepNo'];
  const stepNo = declared === undefined ? expectedStepNo : declared;
  if (typeof stepNo !== 'number' || !Number.isInteger(stepNo)) {
    fail(`Step ${expectedStepNo} has a non-integer step_no.`);
  }
  if (stepNo !== expectedStepNo) {
    fail(
      `Steps must be numbered 1..n in order; found step_no ${String(stepNo)} where ` +
        `${expectedStepNo} was expected. A gap or a repeat makes "which step is active" ` +
        `ambiguous, and serial ordering is the whole control.`,
    );
  }

  const modeRaw = step['mode'] ?? 'SERIAL';
  if (modeRaw !== 'SERIAL' && modeRaw !== 'PARALLEL') {
    fail(`Step ${expectedStepNo} mode must be SERIAL or PARALLEL.`);
  }
  const mode = modeRaw as StepMode;

  const approversRaw = step['approvers'];
  if (!Array.isArray(approversRaw) || approversRaw.length === 0) {
    fail(`Step ${expectedStepNo} has no approvers. A step nobody can act on blocks for ever.`);
  }
  const approvers = approversRaw.map((a, i) => parseApprover(a, expectedStepNo, i));

  const namedUsers = approvers.filter((a) => a.resolvedFrom === 'NAMED_USER').map((a) => a.userId);
  if (new Set(namedUsers).size !== namedUsers.length) {
    fail(
      `Step ${expectedStepNo} names the same user twice. Two slots for one person would let one ` +
        `approval count twice toward a quorum.`,
    );
  }
  const roles = approvers.filter((a) => a.resolvedFrom === 'ROLE').map((a) => a.roleId);
  if (new Set(roles).size !== roles.length) {
    fail(`Step ${expectedStepNo} names the same role twice.`);
  }

  const quorumRaw = step['quorum'] ?? (mode === 'PARALLEL' ? 1 : 1);
  if (typeof quorumRaw !== 'number' || !Number.isInteger(quorumRaw) || quorumRaw < 1) {
    fail(`Step ${expectedStepNo} quorum must be a positive integer.`);
  }
  const quorum = quorumRaw as number;
  if (mode === 'SERIAL' && quorum !== 1) {
    fail(
      `Step ${expectedStepNo} is SERIAL with quorum ${quorum}. A serial step is one decision by ` +
        `one approver; use mode PARALLEL to require several.`,
    );
  }
  if (quorum > approvers.length) {
    fail(
      `Step ${expectedStepNo} needs ${quorum} approvals from ${approvers.length} approver slot(s), ` +
        `which can never be satisfied.`,
    );
  }
  // A quorum above one counted against ROLE slots is not countable: one role slot
  // can be satisfied by any of its holders, so "2 of 2" where both slots are the
  // same kind of role is really "2 people from that role" — which the step rows
  // cannot express, because there is one row per slot.
  if (quorum > 1 && roles.length > 0 && namedUsers.length + roles.length < quorum) {
    fail(
      `Step ${expectedStepNo} cannot reach a quorum of ${quorum}: it has ${namedUsers.length + roles.length} ` +
        `approver slot(s) and each slot admits exactly one decision.`,
    );
  }

  const expiresRaw = step['expires_after_hours'] ?? step['expiresAfterHours'] ?? null;
  if (expiresRaw !== null) {
    if (typeof expiresRaw !== 'number' || !Number.isFinite(expiresRaw) || expiresRaw <= 0) {
      fail(`Step ${expectedStepNo} expires_after_hours must be a positive number of hours.`);
    }
  }

  const onExpiryRaw = step['on_expiry'] ?? step['onExpiry'] ?? 'BLOCK';
  if (onExpiryRaw !== 'BLOCK' && onExpiryRaw !== 'ESCALATE') {
    fail(
      `Step ${expectedStepNo} on_expiry must be BLOCK or ESCALATE. There is deliberately no ` +
        `AUTO_APPROVE: an approval that grants itself by the passage of time is not an approval, ` +
        `and doc 14's escalation actions (REMIND, ADD_WATCHER, REASSIGN, ADD_APPROVER, CANCEL) ` +
        `contain no such option either.`,
    );
  }

  return {
    stepNo: expectedStepNo,
    mode,
    quorum,
    approvers,
    expiresAfterHours: expiresRaw === null ? null : (expiresRaw as number),
    onExpiry: onExpiryRaw as 'BLOCK' | 'ESCALATE',
  };
}

export function parseDefinition(raw: unknown): WorkflowDefinition {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail('A workflow definition must be an object with a steps array.');
  }
  const def = raw as Record<string, unknown>;
  const stepsRaw = def['steps'];
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    fail(
      'A workflow definition needs at least one step. A workflow with no steps would approve ' +
        'every document it matched, instantly, which is worse than having no workflow at all.',
    );
  }
  if (stepsRaw.length > 20) fail('A workflow definition is limited to 20 steps.');

  const steps = stepsRaw.map((s, i) => parseStep(s, i + 1));

  const onReject = def['on_reject'] ?? def['onReject'] ?? 'TERMINATE';
  if (onReject !== 'TERMINATE') {
    fail(
      'on_reject must be TERMINATE. Any other rule makes the outcome depend on the order the ' +
        'approvers happened to click, and doc 14 requires parallel rejection behaviour to be ' +
        'deterministic.',
    );
  }
  const onRequestChanges =
    def['on_request_changes'] ?? def['onRequestChanges'] ?? 'RETURN_TO_REQUESTER';
  if (onRequestChanges !== 'RETURN_TO_REQUESTER') {
    fail('on_request_changes must be RETURN_TO_REQUESTER.');
  }

  const distinctRaw = def['require_distinct_approvers'] ?? def['requireDistinctApprovers'] ?? true;
  if (typeof distinctRaw !== 'boolean') {
    fail('require_distinct_approvers must be true or false.');
  }

  return {
    steps,
    onReject: 'TERMINATE',
    onRequestChanges: 'RETURN_TO_REQUESTER',
    requireDistinctApprovers: distinctRaw as boolean,
  };
}

/** The canonical jsonb form. Round-trips through `parseDefinition` unchanged. */
export function serializeDefinition(definition: WorkflowDefinition): Record<string, unknown> {
  return {
    steps: definition.steps.map((s) => ({
      step_no: s.stepNo,
      mode: s.mode,
      quorum: s.quorum,
      approvers: s.approvers.map((a) =>
        a.resolvedFrom === 'NAMED_USER'
          ? { resolved_from: 'NAMED_USER', user_id: a.userId }
          : { resolved_from: 'ROLE', role_id: a.roleId },
      ),
      expires_after_hours: s.expiresAfterHours,
      on_expiry: s.onExpiry,
    })),
    on_reject: definition.onReject,
    on_request_changes: definition.onRequestChanges,
    require_distinct_approvers: definition.requireDistinctApprovers,
  };
}

export function stepDefinition(
  definition: WorkflowDefinition,
  stepNo: number,
): StepDefinition | undefined {
  return definition.steps.find((s) => s.stepNo === stepNo);
}
