/**
 * The approval half of "reopening a period is privileged, approved and audited".
 *
 * The Phase 6 audit's finding was exact: a reopen is permissioned (accounting_period.reopen,
 * close.reopen), MFA-gated (both are high-risk, so ADR-0005 §3 demands re-authentication),
 * reasoned (`close_runs_reopen_has_reason`, and finance-setup refuses a reasonless
 * transition) and audited (`accounting_period.reopened` is recorded and chained).
 * It is not APPROVED. "Permissioned" and "approved" are different claims: the first
 * says the actor may do it, the second says somebody else agreed they should — and
 * the exit criterion says approved.
 *
 * This file is the seam, not the engine. It does exactly two things:
 *
 *   - READS the decision facts out of `approval_requests` / `approval_steps`, which
 *     0017 built and 0050 made tenant-safe, through a port (`ApprovalReader`) so
 *     `@acct/approvals` can replace the implementation without any caller changing.
 *     The query matches what that package's `decide` path writes exactly — step
 *     status APPROVED, decision APPROVE, `decided_by`, `decided_at`, request status
 *     APPROVED — so an approval taken through POST /approval-tasks/{id}/approve is
 *     visible here with no adapter in between;
 *   - ASSERTS the four conditions that make a decision an approval of THIS act.
 *
 * What it deliberately does NOT do is raise the approval request. Creating an
 * `approval_requests` row means selecting the tenant's published workflow version
 * for the resource type, resolving its approver steps and honouring its
 * `segregation_rules` — that is the approval engine's work, and a second
 * implementation of it here would be a second definition of who may approve what.
 * `@acct/approvals` cannot raise one for a close run yet: its `GATED_RESOURCES`
 * registry covers JOURNAL, INVOICE and VENDOR_BILL, and `requestApprovalInTransaction`
 * resolves the resource through that registry. Its own comment names close reopens
 * as deliberately absent for now. See INTEGRATION NOTES.
 *
 * The refusal when no approval exists is deliberate and is not a soft failure. An
 * unconfigured approval workflow must not read as "approval not required" — that is
 * the same vacuity that let an empty checklist prove a close was complete.
 */
import { PoolClient } from 'pg';
import { AppError } from '@acct/domain';

/**
 * `approval_requests.resource_type` values this package reads.
 *
 * Upper snake case to match `@acct/approvals`' `GATED_RESOURCES` convention
 * (JOURNAL, INVOICE, VENDOR_BILL). The two packages have to agree on this string
 * or the engine writes a request the gate cannot find, and a gate that finds
 * nothing refuses everything.
 */
export const APPROVAL_RESOURCE = {
  closeRun: 'CLOSE_RUN',
  accountingPeriod: 'ACCOUNTING_PERIOD',
  financialSnapshot: 'FINANCIAL_SNAPSHOT',
} as const;

export interface ApprovalFact {
  readonly requestId: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly workflowId: string;
  readonly workflowVersion: number;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly decisionReason: string | null;
}

export interface ApprovalQuery {
  readonly tenantId: string;
  readonly resourceType: string;
  readonly resourceId: string;
  /** Only decisions at or after this instant count. Null accepts any. */
  readonly since?: string | null;
}

/** The port. `@acct/approvals` should satisfy this and add the write half. */
export interface ApprovalReader {
  approvalsFor(client: PoolClient, query: ApprovalQuery): Promise<ApprovalFact[]>;
}

/**
 * Reads decided approvals from the tables 0017 created.
 *
 * Every NULL that could make a comparison vacuous is excluded in the WHERE clause
 * rather than checked afterwards: a step with `decided_by IS NULL` is not evidence
 * that anybody approved anything, and `decided_by <> $actor` against it would be
 * NULL — which passes.
 */
export class ApprovalRequestReader implements ApprovalReader {
  async approvalsFor(client: PoolClient, query: ApprovalQuery): Promise<ApprovalFact[]> {
    const { rows } = await client.query<{
      request_id: string;
      resource_type: string;
      resource_id: string;
      workflow_id: string;
      workflow_version: number;
      decided_by: string;
      decided_at: string;
      decision_reason: string | null;
    }>(
      `SELECT r.id AS request_id, r.resource_type, r.resource_id::text AS resource_id,
              r.approval_workflow_id AS workflow_id, r.workflow_version,
              s.decided_by::text AS decided_by, s.decided_at, s.decision_reason
         FROM approval_requests r
         JOIN approval_steps s ON s.approval_request_id = r.id
        WHERE r.tenant_id = $1
          AND r.resource_type = $2
          AND r.resource_id = $3::uuid
          AND r.status = 'APPROVED'
          AND s.status = 'APPROVED'
          AND s.decision = 'APPROVE'
          AND s.decided_by IS NOT NULL
          AND s.decided_at IS NOT NULL
          AND ($4::timestamptz IS NULL OR s.decided_at >= $4::timestamptz)
        ORDER BY s.decided_at DESC`,
      [query.tenantId, query.resourceType, query.resourceId, query.since ?? null],
    );
    return rows.map((r) => ({
      requestId: r.request_id,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      workflowId: r.workflow_id,
      workflowVersion: r.workflow_version,
      decidedBy: r.decided_by,
      decidedAt: r.decided_at,
      decisionReason: r.decision_reason,
    }));
  }
}

export interface ReopenApprovalRequirement {
  /** What is being reopened, named in every refusal: "close run <id>", "period 2028-01". */
  readonly subject: string;
  /** The person asking to reopen. Null is refused — see below. */
  readonly actorId: string | null;
  /**
   * The person whose decision is being superseded — whoever finalized the close or
   * hard-closed the period. Their own approval does not count.
   *
   * `undefined` means "there is no such person for this act"; `null` means "there
   * should be one and the record does not say who", which is refused. The two are
   * different facts and collapsing them is how a missing record becomes a pass.
   */
  readonly supersedes?: { readonly role: string; readonly userId: string | null } | undefined;
  /** The approval must be at or after this instant — typically the finalize. */
  readonly since?: string | null;
  /** Where a caller goes to get the approval. Named in the refusal, since details are log-only. */
  readonly requestHint: string;
}

/**
 * Returns the approval that authorises this reopen, or throws.
 *
 * The four conditions, each of which has failed somewhere in this codebase before:
 *
 *   1. There is a decided approval at all — otherwise APPROVAL_REQUIRED, naming how
 *      to obtain one. Absence is never consent.
 *   2. The actor is known. An anonymous reopen cannot be compared with anybody.
 *   3. The approver is not the actor. Self-approval is the oldest way to satisfy a
 *      maker/checker control while defeating it.
 *   4. The approver is not the person being overruled, and that person is known.
 *      `supersedes.userId === null` is refused rather than passed: a comparison
 *      against NULL is NULL, and NULL is not "different people".
 */
export function assertReopenApproved(
  approvals: readonly ApprovalFact[],
  requirement: ReopenApprovalRequirement,
): ApprovalFact {
  if (requirement.actorId === null) {
    throw new AppError(
      'SEGREGATION_OF_DUTIES',
      `Reopening ${requirement.subject} records no acting user, so nothing can show that the ` +
        `approver and the person reopening are different people.`,
    );
  }

  if (requirement.supersedes && requirement.supersedes.userId === null) {
    throw new AppError(
      'SEGREGATION_OF_DUTIES',
      `Reopening ${requirement.subject} is refused because the record does not say who ` +
        `${requirement.supersedes.role}. An approval is only a control if it can be shown to come ` +
        `from someone other than the person being overruled, and against an unknown person that ` +
        `comparison is neither true nor false.`,
    );
  }

  if (approvals.length === 0) {
    throw new AppError(
      'APPROVAL_REQUIRED',
      `Reopening ${requirement.subject} has not been approved. doc 21 Phase 6 requires a reopen ` +
        `workflow with privileged approval, so holding the permission is not sufficient. ` +
        `${requirement.requestHint}`,
      { details: { subject: requirement.subject } },
    );
  }

  const usable = approvals.filter(
    (a) =>
      a.decidedBy !== requirement.actorId &&
      (!requirement.supersedes || a.decidedBy !== requirement.supersedes.userId),
  );

  const chosen = usable[0];
  if (!chosen) {
    const selfApproved = approvals.some((a) => a.decidedBy === requirement.actorId);
    throw new AppError(
      'SEGREGATION_OF_DUTIES',
      selfApproved
        ? `Reopening ${requirement.subject} was approved by the person requesting it. The approval ` +
            `has to come from somebody else (doc 14 maker/checker).`
        : `Reopening ${requirement.subject} was approved only by the person who ` +
            `${requirement.supersedes?.role ?? 'made the decision being reopened'}. The approval has ` +
            `to come from a third person.`,
      { details: { subject: requirement.subject, approvals: approvals.map((a) => a.decidedBy) } },
    );
  }
  return chosen;
}
