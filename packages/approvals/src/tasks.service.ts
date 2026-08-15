/**
 * The task inbox and the four approval actions — `listApprovalTasks`,
 * `approveTask`, `rejectTask`, `requestTaskChanges`, `delegateTask`, plus the
 * unified inbox `listTasks` and `completeTask`.
 *
 * doc 14: "APPROVE, REJECT, REQUEST_CHANGES, DELEGATE where permitted. Decision
 * records actor, timestamp, comment, IP/session context and relevant document
 * version."
 *
 * -----------------------------------------------------------------------------
 * Delegation: whose authority?
 * -----------------------------------------------------------------------------
 * The DELEGATOR's, exercised in the delegate's own name, and only within the
 * delegation's scope, window and amount cap — and the delegate must additionally
 * hold `approval.approve` in that entity in their own right.
 *
 * Both halves are load-bearing:
 *
 *   - It must be the delegator's authority, because the workflow resolved the
 *     delegator as the approver. If the delegate acted on their own authority,
 *     the step would be satisfied by somebody the workflow never chose, and an
 *     amount-banded workflow would be defeated by delegating the large approvals
 *     to a junior. The step row says so literally: `approver_user_id` stays the
 *     delegator and `decided_by` becomes the delegate, so the row reads
 *     "assigned to X, decided by Y" without any interpretation.
 *   - The delegate must still hold the permission, because doc 14 says "User
 *     still needs current permission to act". Delegation moves a task; it does
 *     not mint authorization.
 *
 * And SoD is evaluated against BOTH people (`assertSegregationOfDuties` takes
 * `actorId` and `authorityOf`), because otherwise delegation is a laundering
 * route around maker/checker — which is exactly what doc 14 forbids when it says
 * "Delegation cannot violate segregation-of-duties".
 *
 * The delegator is NOT stripped of the task. A temporary delegation is cover,
 * not a transfer, and a delegator who comes back early must be able to act.
 */
import type { Pool, PoolClient } from 'pg';
import {
  AppError,
  assertEntityPermission,
  assertPermission,
  entityScopeFilter,
  uuidv7,
  type RequestContext,
  type TenantPrincipal,
} from '@acct/domain';
import { publish, readInTenant, recordAudit, writeInTenant } from '@acct/database';
import { parseDefinition, type WorkflowDefinition } from './definition';
import {
  activateStep,
  cancelRequest,
  closeTasksForSteps,
  loadRequestDetail,
  lockRequest,
} from './engine.service';
import {
  gatedResource,
  loadResourceFacts,
  recordApprovalOnResource,
  releaseResource,
} from './resources';
import {
  approversSoFar,
  assertDualApproval,
  assertSegregationOfDuties,
  delegationPermits,
  notActionableBecause,
  refuseNotActionable,
  stepOutcome,
  type DelegationGrant,
  type StepState,
} from './steps';

interface StepRow {
  id: string;
  tenant_id: string;
  approval_request_id: string;
  step_no: number;
  is_parallel: boolean;
  approver_user_id: string | null;
  approver_role_id: string | null;
  resolved_from: string | null;
  status: string;
  decision: string | null;
  decided_by: string | null;
  expires_at: string | null;
}

function toStepState(row: StepRow): StepState {
  return {
    id: row.id,
    stepNo: row.step_no,
    isParallel: row.is_parallel,
    approverUserId: row.approver_user_id,
    approverRoleId: row.approver_role_id,
    resolvedFrom: row.resolved_from,
    status: row.status as StepState['status'],
    decision: row.decision as StepState['decision'],
    decidedBy: row.decided_by,
    expiresAt: row.expires_at,
  };
}

function assertScoped(
  principal: TenantPrincipal,
  permission: string,
  legalEntityId: string | null,
): void {
  if (legalEntityId) assertEntityPermission(principal, permission, legalEntityId);
  else assertPermission(principal, permission);
}

export interface DecisionInput {
  readonly comment?: string | null;
}

export interface DelegateInput {
  readonly delegateUserId: string;
  readonly reason?: string | null;
  /** ISO timestamp the delegation ends. Defaults to 30 days out. */
  readonly validTo?: string | null;
  /** Exact decimal string. A cap the delegate may not approve above. */
  readonly maxAmount?: string | null;
}

export class ApprovalTaskService {
  constructor(private readonly pool: Pool) {}

  // -------------------------------------------------------------------------
  // Inbox
  // -------------------------------------------------------------------------

  /**
   * GET /approval-tasks.
   *
   * By default: the steps this caller can act on right now. `request_id` widens
   * it to the whole decision history of one request, which is what makes the
   * audit history doc 21 asks for readable through the route the contract
   * publishes rather than through a route it does not.
   */
  async listApprovalTasks(
    principal: TenantPrincipal,
    query: {
      requestId?: string | undefined;
      resourceType?: string | undefined;
      resourceId?: string | undefined;
      status?: string | undefined;
      mine?: boolean | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      assertPermission(principal, 'approval.view');

      const params: unknown[] = [principal.tenantId];
      const where: string[] = ['s.tenant_id = $1'];

      const mine = query.mine ?? query.requestId === undefined;
      if (mine) {
        params.push(principal.userId);
        // Only the step that can be acted on NOW. A later serial step is
        // materialised from the start (doc 14: resolved approvers are recorded
        // on the instance) and showing it to its approver would be an inbox
        // full of work nobody may do yet.
        where.push(`s.step_no = (SELECT min(p.step_no) FROM approval_steps p
                                  WHERE p.approval_request_id = s.approval_request_id
                                    AND p.status = 'PENDING')`);
        where.push(`(
             s.approver_user_id = $2
          OR (s.approver_role_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM memberships m
                 WHERE m.tenant_id = s.tenant_id AND m.user_id = $2
                   AND m.role_id = s.approver_role_id
                   AND m.status = 'ACTIVE' AND m.suspended_at IS NULL
                   AND (m.legal_entity_id IS NULL OR m.legal_entity_id = r.legal_entity_id)))
          OR EXISTS (
                SELECT 1 FROM delegations d
                 WHERE d.tenant_id = s.tenant_id
                   AND d.delegator_user_id = s.approver_user_id
                   AND d.delegate_user_id = $2
                   AND d.valid_from <= now() AND d.valid_to > now()
                   AND (d.scope_resource_type IS NULL OR d.scope_resource_type = r.resource_type)
                   AND (d.legal_entity_id IS NULL OR d.legal_entity_id = r.legal_entity_id))
        )`);
      }
      if (query.requestId) {
        params.push(query.requestId);
        where.push(`s.approval_request_id = $${params.length}`);
      }
      if (query.resourceType) {
        params.push(query.resourceType);
        where.push(`r.resource_type = $${params.length}`);
      }
      if (query.resourceId) {
        params.push(query.resourceId);
        where.push(`r.resource_id = $${params.length}`);
      }
      if (query.status) {
        params.push(query.status);
        where.push(`s.status = $${params.length}::approval_status`);
      } else if (query.requestId === undefined) {
        where.push(`s.status = 'PENDING'`);
        where.push(`r.status = 'PENDING'`);
      }

      const scope = entityScopeFilter(
        principal,
        { legalEntityId: 'r.legal_entity_id' },
        params.length + 1,
      );
      params.push(...scope.params);
      where.push(`(r.legal_entity_id IS NULL OR ${scope.sql})`);

      const { rows } = await client.query(
        `SELECT s.id, s.approval_request_id, s.step_no, s.is_parallel,
                s.status::text AS status, s.decision::text AS decision,
                s.decided_by, s.decided_at, s.decision_reason,
                s.approver_user_id, s.approver_role_id, s.resolved_from,
                s.expires_at, s.escalated_at,
                r.resource_type, r.resource_id, r.legal_entity_id,
                r.status::text AS request_status, r.requested_by, r.requested_at,
                r.workflow_version,
                w.code AS workflow_code, w.name AS workflow_name,
                -- Read out of jsonb as TEXT. A monetary value that goes through
                -- JSON.parse is a binary float by the time anyone sees it, and
                -- the amount an approver is shown is the amount they are
                -- approving (ADR-0006 §1).
                r.snapshot -> 'resource' ->> 'reference' AS reference,
                r.snapshot -> 'resource' ->> 'amount'    AS amount,
                r.snapshot -> 'resource' ->> 'currency'  AS currency,
                (s.step_no = (SELECT min(p.step_no) FROM approval_steps p
                               WHERE p.approval_request_id = s.approval_request_id
                                 AND p.status = 'PENDING')) AS is_active,
                (s.expires_at IS NOT NULL AND s.expires_at <= now()) AS is_expired
           FROM approval_steps s
           JOIN approval_requests r  ON r.id = s.approval_request_id
           JOIN approval_workflows w ON w.id = r.approval_workflow_id
          WHERE ${where.join(' AND ')}
          ORDER BY r.requested_at, s.step_no, s.id`,
        params,
      );
      return { data: rows };
    });
  }

  // -------------------------------------------------------------------------
  // Decisions
  // -------------------------------------------------------------------------

  async approve(principal: TenantPrincipal, stepId: string, input: DecisionInput = {}) {
    return this.decide(principal, stepId, 'APPROVE', input);
  }

  async reject(principal: TenantPrincipal, stepId: string, input: DecisionInput = {}) {
    if (!input.comment?.trim()) {
      throw new AppError(
        'VALIDATION_FAILED',
        'A rejection needs a reason. The person who has to fix the document is reading it, and ' +
          '"rejected" on its own tells them nothing.',
      );
    }
    return this.decide(principal, stepId, 'REJECT', input);
  }

  async requestChanges(principal: TenantPrincipal, stepId: string, input: DecisionInput = {}) {
    if (!input.comment?.trim()) {
      throw new AppError(
        'VALIDATION_FAILED',
        'Requesting changes needs a comment saying which changes.',
      );
    }
    return this.decide(principal, stepId, 'REQUEST_CHANGES', input);
  }

  private async decide(
    principal: TenantPrincipal,
    stepId: string,
    decision: 'APPROVE' | 'REJECT' | 'REQUEST_CHANGES',
    input: DecisionInput,
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const ctx = await this.loadDecisionContext(client, principal, stepId, 'approval.approve');

      // The document must not have moved since approval was requested. doc 14:
      // "Editing a submitted document can invalidate previous approvals." Any
      // change to its optimistic-lock version counts: an approver who was shown
      // 20,000 must not find they approved 40,000.
      //
      // Checked for APPROVE only, deliberately. REJECT and REQUEST_CHANGES are
      // the right answers to a document that changed underneath its approval,
      // and blocking them too would leave the request unapprovable, unrejectable
      // and permanently in somebody's inbox. The refusal below cannot cancel the
      // request as a side effect either: it throws, and a throw rolls back the
      // transaction it is in, so the "cancellation" would be undone and the
      // message would be describing something that did not happen.
      if (
        decision === 'APPROVE' &&
        ctx.request.document_version !== null &&
        ctx.facts.version !== ctx.request.document_version
      ) {
        throw new AppError(
          'VALIDATION_FAILED',
          `${ctx.adapter.label} ${ctx.facts.reference} has been edited since approval was ` +
            `requested (version ${ctx.request.document_version} became ${ctx.facts.version}), so ` +
            `the approvals collected so far no longer describe what you are being asked to sign. ` +
            `Reject it or request changes, or have the requester withdraw the request, and submit ` +
            `the document again.`,
          { details: { requestId: ctx.request.id } },
        );
      }

      if (decision === 'APPROVE') {
        assertSegregationOfDuties({
          preparedBy: ctx.facts.preparedBy,
          requestedBy: ctx.request.requested_by,
          actorId: principal.userId,
          authorityOf: ctx.authorityOf,
          priorApprovers: approversSoFar(ctx.steps),
          requireDistinctApprovers: ctx.definition.requireDistinctApprovers,
          reference: `${ctx.adapter.label} ${ctx.facts.reference}`,
        });
      }

      const stepStatus =
        decision === 'APPROVE' ? 'APPROVED' : decision === 'REJECT' ? 'REJECTED' : 'CANCELLED';

      await client.query(
        `UPDATE approval_steps
            SET status = $2::approval_status,
                decision = $3::approval_decision,
                decision_reason = $4,
                decided_by = $5,
                decided_at = now(),
                ip_address = $6::inet,
                -- A session id that is not a live session would break the foreign
                -- key and lose the decision. The subquery records it when it is
                -- real and NULL when it is not, which is the honest answer.
                session_id = (SELECT id FROM sessions WHERE id = $7::uuid)
          WHERE id = $1 AND status = 'PENDING'`,
        [
          stepId,
          stepStatus,
          decision,
          input.comment?.trim() ?? null,
          principal.userId,
          context.ipAddress ?? null,
          principal.sessionId,
        ],
      );

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: ctx.request.legal_entity_id,
        action: `approval.${decision.toLowerCase()}`,
        resourceType: 'approval_step',
        resourceId: stepId,
        reason: input.comment?.trim() ?? null,
        after: {
          approval_request_id: ctx.request.id,
          step_no: ctx.step.stepNo,
          decision,
          decided_by: principal.userId,
          authority_of: ctx.authorityOf,
          resource_type: ctx.request.resource_type,
          resource_id: ctx.request.resource_id,
        },
      });

      if (decision === 'REJECT') return this.finishRejected(client, context, principal, ctx, input);
      if (decision === 'REQUEST_CHANGES') {
        await cancelRequest(client, context, principal.tenantId, {
          requestId: ctx.request.id,
          legalEntityId: ctx.request.legal_entity_id,
          adapter: ctx.adapter,
          resourceId: ctx.request.resource_id,
          reason: input.comment!.trim(),
          action: 'approval.changes_requested',
        });
        // The requester gets the work back as an inbox item. Without it, "changes
        // requested" is a state the document sits in and nobody is told about.
        await this.openFollowUpTask(client, context, principal.tenantId, {
          legalEntityId: ctx.request.legal_entity_id,
          ownerUserId: ctx.request.requested_by,
          requestId: ctx.request.id,
          title: `Changes requested on ${ctx.adapter.label.toLowerCase()} ${ctx.facts.reference}`,
          description: input.comment!.trim(),
        });
        return {
          id: stepId,
          approval_request_id: ctx.request.id,
          decision,
          request_status: 'CANCELLED',
          resource_status: ctx.adapter.returnStatus,
        };
      }

      return this.advanceAfterApproval(client, context, principal, ctx);
    });
  }

  /**
   * A rejection ends the request, whatever else is outstanding.
   *
   * Deterministic by construction: `stepOutcome` lets one REJECT dominate any
   * number of APPROVEs in the same parallel step, so the answer does not depend
   * on the order two approvers happened to click (doc 14 acceptance criterion).
   */
  private async finishRejected(
    client: PoolClient,
    context: RequestContext,
    principal: TenantPrincipal,
    ctx: DecisionContext,
    input: DecisionInput,
  ) {
    const { rows: cancelled } = await client.query<{ id: string }>(
      `UPDATE approval_steps SET status = 'CANCELLED'
        WHERE approval_request_id = $1 AND status = 'PENDING'
      RETURNING id`,
      [ctx.request.id],
    );
    await client.query(
      `UPDATE approval_requests SET status = 'REJECTED', completed_at = now() WHERE id = $1`,
      [ctx.request.id],
    );
    await closeTasksForSteps(
      client,
      context,
      principal.tenantId,
      ctx.request.legal_entity_id,
      [ctx.step.id, ...cancelled.map((c) => c.id)],
      'CANCELLED',
    );
    await releaseResource(client, ctx.adapter, ctx.request.resource_id, 'REJECTED');

    await publish(client, context, {
      eventType: 'approval.rejected',
      aggregateType: 'approval_request',
      aggregateId: ctx.request.id,
      tenantId: principal.tenantId,
      legalEntityId: ctx.request.legal_entity_id,
      payload: {
        resource_type: ctx.request.resource_type,
        resource_id: ctx.request.resource_id,
        rejected_by: principal.userId,
        step_no: ctx.step.stepNo,
        reason: input.comment?.trim() ?? null,
      },
    });
    await publish(client, context, {
      eventType: 'workflow.completed',
      aggregateType: 'approval_request',
      aggregateId: ctx.request.id,
      tenantId: principal.tenantId,
      legalEntityId: ctx.request.legal_entity_id,
      payload: { outcome: 'REJECTED' },
    });

    return {
      id: ctx.step.id,
      approval_request_id: ctx.request.id,
      decision: 'REJECT',
      request_status: 'REJECTED',
      resource_status: ctx.adapter.returnStatus,
    };
  }

  private async advanceAfterApproval(
    client: PoolClient,
    context: RequestContext,
    principal: TenantPrincipal,
    ctx: DecisionContext,
  ) {
    const steps = await loadSteps(client, ctx.request.id);
    const stepDef = ctx.definition.steps.find((s) => s.stepNo === ctx.step.stepNo);
    const quorum = stepDef?.quorum ?? 1;
    const rowsAtStep = steps.filter((s) => s.stepNo === ctx.step.stepNo);
    const outcome = stepOutcome(rowsAtStep, quorum);

    if (outcome !== 'SATISFIED') {
      const approvals = new Set(
        rowsAtStep.filter((s) => s.status === 'APPROVED').map((s) => s.decidedBy),
      ).size;
      return {
        id: ctx.step.id,
        approval_request_id: ctx.request.id,
        decision: 'APPROVE',
        request_status: 'PENDING',
        step_no: ctx.step.stepNo,
        approvals,
        quorum,
      };
    }

    // Quorum reached: the outstanding slots in this step are closed rather than
    // left open. A parallel step of three with a quorum of two leaves the third
    // approver a task they can no longer act on, and an inbox that lies is an
    // inbox people stop reading.
    const { rows: superseded } = await client.query<{ id: string }>(
      `UPDATE approval_steps SET status = 'CANCELLED'
        WHERE approval_request_id = $1 AND step_no = $2 AND status = 'PENDING'
      RETURNING id`,
      [ctx.request.id, ctx.step.stepNo],
    );
    await closeTasksForSteps(
      client,
      context,
      principal.tenantId,
      ctx.request.legal_entity_id,
      [ctx.step.id],
      'COMPLETED',
    );
    await closeTasksForSteps(
      client,
      context,
      principal.tenantId,
      ctx.request.legal_entity_id,
      superseded.map((s) => s.id),
      'CANCELLED',
    );

    const nextStep = ctx.definition.steps.find((s) => s.stepNo > ctx.step.stepNo);
    if (nextStep) {
      await activateStep(client, context, principal.tenantId, {
        requestId: ctx.request.id,
        stepNo: nextStep.stepNo,
        definition: ctx.definition,
        legalEntityId: ctx.request.legal_entity_id,
        title: `Approve ${ctx.adapter.label.toLowerCase()} ${ctx.facts.reference}`,
        description: `${ctx.facts.amount} ${ctx.facts.currency} — step ${nextStep.stepNo}`,
      });
      return {
        id: ctx.step.id,
        approval_request_id: ctx.request.id,
        decision: 'APPROVE',
        request_status: 'PENDING',
        step_no: ctx.step.stepNo,
        next_step_no: nextStep.stepNo,
      };
    }

    // Terminal. Everything from here writes the approval onto the document.
    const finalSteps = await loadSteps(client, ctx.request.id);
    const approvers = approversSoFar(finalSteps);
    const threshold = await dualApprovalThreshold(
      client,
      principal.tenantId,
      ctx.request.resource_type,
      ctx.request.legal_entity_id,
    );
    assertDualApproval({
      threshold,
      amount: ctx.facts.amount,
      currency: ctx.facts.currency,
      preparedBy: ctx.facts.preparedBy,
      approvers,
      reference: `${ctx.adapter.label} ${ctx.facts.reference}`,
    });

    // The write the whole engine exists to justify. `je_maker_checker` and 0049's
    // deferred trigger read this column; if the rules above were wrong, the
    // database refuses the statement rather than trusting them.
    await recordApprovalOnResource(client, ctx.adapter, ctx.request.resource_id, principal.userId);
    await client.query(
      `UPDATE approval_requests SET status = 'APPROVED', completed_at = now() WHERE id = $1`,
      [ctx.request.id],
    );

    await publish(client, context, {
      eventType: 'approval.approved',
      aggregateType: 'approval_request',
      aggregateId: ctx.request.id,
      tenantId: principal.tenantId,
      legalEntityId: ctx.request.legal_entity_id,
      payload: {
        resource_type: ctx.request.resource_type,
        resource_id: ctx.request.resource_id,
        approvers,
        amount: ctx.facts.amount,
        currency: ctx.facts.currency,
      },
    });
    await publish(client, context, {
      eventType: 'workflow.completed',
      aggregateType: 'approval_request',
      aggregateId: ctx.request.id,
      tenantId: principal.tenantId,
      legalEntityId: ctx.request.legal_entity_id,
      payload: { outcome: 'APPROVED' },
    });
    await recordAudit(client, context, {
      tenantId: principal.tenantId,
      legalEntityId: ctx.request.legal_entity_id,
      action: 'approval.completed',
      resourceType: 'approval_request',
      resourceId: ctx.request.id,
      after: {
        status: 'APPROVED',
        approvers,
        resource_status: ctx.adapter.approvedStatus,
        approved_by: principal.userId,
      },
    });

    return {
      id: ctx.step.id,
      approval_request_id: ctx.request.id,
      decision: 'APPROVE',
      request_status: 'APPROVED',
      resource_status: ctx.adapter.approvedStatus,
      approvers,
    };
  }

  // -------------------------------------------------------------------------
  // Delegation
  // -------------------------------------------------------------------------

  async delegate(principal: TenantPrincipal, stepId: string, input: DelegateInput) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const ctx = await this.loadDecisionContext(client, principal, stepId, 'approval.delegate');

      if (ctx.authorityOf !== principal.userId) {
        throw new AppError(
          'FORBIDDEN',
          "You are acting on somebody else's delegated authority, so you cannot delegate this " +
            'task onward. A chain of delegations makes "who was responsible for this approval" ' +
            'unanswerable, which is the one question the record exists to answer.',
        );
      }
      if (input.delegateUserId === principal.userId) {
        throw new AppError('VALIDATION_FAILED', 'You cannot delegate a task to yourself.');
      }

      // doc 14: "Delegation cannot violate segregation-of-duties." Checked before
      // the delegation is created, not when the delegate tries to act, so the
      // refusal names the reason to the person who can do something about it.
      if (ctx.facts.preparedBy === null) {
        throw new AppError(
          'SEGREGATION_OF_DUTIES',
          `${ctx.adapter.label} ${ctx.facts.reference} records no preparer, so no delegate can be ` +
            'shown to be someone other than the person who prepared it.',
        );
      }
      if (
        input.delegateUserId === ctx.facts.preparedBy ||
        input.delegateUserId === ctx.request.requested_by
      ) {
        throw new AppError(
          'SEGREGATION_OF_DUTIES',
          `That person prepared or requested ${ctx.adapter.label.toLowerCase()} ` +
            `${ctx.facts.reference}, so delegating its approval to them would let the maker ` +
            'approve their own work. Delegation cannot violate segregation of duties (doc 14).',
        );
      }

      // "User still needs current permission to act." A delegation to somebody
      // who cannot approve creates a task nobody can clear.
      const { rows: permitted } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM memberships m
           JOIN role_permissions rp ON rp.role_id = m.role_id
          WHERE m.tenant_id = $1 AND m.user_id = $2
            AND m.status = 'ACTIVE' AND m.suspended_at IS NULL
            AND rp.permission_code = 'approval.approve'
            AND ($3::uuid IS NULL OR m.legal_entity_id IS NULL OR m.legal_entity_id = $3)`,
        [principal.tenantId, input.delegateUserId, ctx.request.legal_entity_id],
      );
      if (permitted[0]?.n === '0') {
        throw new AppError(
          'VALIDATION_FAILED',
          'That person does not hold approval.approve in this legal entity, so the delegated task ' +
            'would sit in their inbox unactionable. Delegation moves a task; it does not grant ' +
            'the permission to decide it (doc 14).',
        );
      }

      const validTo = input.validTo ?? new Date(Date.now() + 30 * 24 * 3_600_000).toISOString();

      // One active delegation per delegator per scope. `delegations_no_overlap`
      // says the same thing as an exclusion constraint; asking first means the
      // caller gets an explanation instead of a constraint name. Reusing an
      // existing grant to the SAME delegate is what makes delegating three tasks
      // in a row work.
      const { rows: existing } = await client.query<{
        id: string;
        delegate_user_id: string;
        valid_to: string;
      }>(
        `SELECT id, delegate_user_id, valid_to::text AS valid_to
           FROM delegations
          WHERE tenant_id = $1 AND delegator_user_id = $2
            AND coalesce(scope_resource_type, '*') = $3
            AND valid_from <= now() AND valid_to > now()
          ORDER BY valid_from DESC
          LIMIT 1`,
        [principal.tenantId, principal.userId, ctx.request.resource_type],
      );
      const active = existing[0];
      let delegationId: string;
      if (active && active.delegate_user_id !== input.delegateUserId) {
        throw new AppError(
          'VALIDATION_FAILED',
          `You already have an active delegation of ${ctx.request.resource_type} approvals to ` +
            `another user until ${active.valid_to}. Two people holding one person's approval ` +
            'authority at the same instant makes "who was covering" unanswerable. End the ' +
            'existing delegation before starting another.',
          { details: { delegationId: active.id } },
        );
      }
      if (active) {
        delegationId = active.id;
      } else {
        delegationId = uuidv7();
        await client.query(
          `INSERT INTO delegations
             (id, tenant_id, delegator_user_id, delegate_user_id, scope_resource_type,
              legal_entity_id, max_amount, valid_from, valid_to, reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,now(),$8::timestamptz,$9)`,
          [
            delegationId,
            principal.tenantId,
            principal.userId,
            input.delegateUserId,
            ctx.request.resource_type,
            ctx.request.legal_entity_id,
            // Exact decimal string straight into numeric(24,8). It is never a
            // JavaScript number at any point (ADR-0006 §1).
            input.maxAmount ?? null,
            validTo,
            input.reason ?? null,
          ],
        );
      }

      // The step row is untouched: `approver_user_id` stays the delegator, which
      // is what records whose authority the decision will carry. What moves is
      // the inbox item.
      await client.query(
        `UPDATE tasks
            SET owner_user_id = $3,
                description = coalesce(description, '') || $4
          WHERE tenant_id = $1 AND source_type = 'APPROVAL' AND source_id = $2
            AND status IN ('OPEN','IN_PROGRESS','ESCALATED')`,
        [
          principal.tenantId,
          stepId,
          input.delegateUserId,
          ` [delegated by ${principal.userId}${input.reason ? `: ${input.reason}` : ''}]`,
        ],
      );

      await publish(client, context, {
        eventType: 'approval.delegated',
        aggregateType: 'approval_request',
        aggregateId: ctx.request.id,
        tenantId: principal.tenantId,
        legalEntityId: ctx.request.legal_entity_id,
        payload: {
          approval_step_id: stepId,
          delegator_user_id: principal.userId,
          delegate_user_id: input.delegateUserId,
          delegation_id: delegationId,
          valid_to: validTo,
          max_amount: input.maxAmount ?? null,
        },
      });
      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: ctx.request.legal_entity_id,
        action: 'approval.delegated',
        resourceType: 'approval_step',
        resourceId: stepId,
        reason: input.reason ?? null,
        after: {
          delegation_id: delegationId,
          delegate_user_id: input.delegateUserId,
          authority_remains_with: principal.userId,
          valid_to: validTo,
          max_amount: input.maxAmount ?? null,
        },
      });

      return {
        id: stepId,
        approval_request_id: ctx.request.id,
        delegation_id: delegationId,
        delegate_user_id: input.delegateUserId,
        valid_to: validTo,
        max_amount: input.maxAmount ?? null,
        // Stated in the response because it is the fact people get wrong: the
        // delegate decides, the delegator's authority is what is exercised, and
        // the delegator can still act themselves.
        authority_of: principal.userId,
      };
    });
  }

  // -------------------------------------------------------------------------
  // The unified inbox — doc 14's ten source types
  // -------------------------------------------------------------------------

  async listTasks(
    principal: TenantPrincipal,
    query: {
      status?: string | undefined;
      sourceType?: string | undefined;
      legalEntityId?: string | undefined;
      mine?: boolean | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      assertPermission(principal, 'task.view');
      const params: unknown[] = [principal.tenantId, principal.userId];
      const where: string[] = ['t.tenant_id = $1'];

      if (query.mine ?? true) {
        where.push(`(
             t.owner_user_id = $2
          OR (t.owner_role_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM memberships m
                 WHERE m.tenant_id = t.tenant_id AND m.user_id = $2 AND m.role_id = t.owner_role_id
                   AND m.status = 'ACTIVE' AND m.suspended_at IS NULL
                   AND (m.legal_entity_id IS NULL OR m.legal_entity_id = t.legal_entity_id)))
        )`);
      }
      if (query.status) {
        params.push(query.status);
        where.push(`t.status = $${params.length}::task_status`);
      } else {
        where.push(`t.status IN ('OPEN','IN_PROGRESS','ESCALATED')`);
      }
      if (query.sourceType) {
        params.push(query.sourceType);
        where.push(`t.source_type = $${params.length}`);
      }
      if (query.legalEntityId) {
        params.push(query.legalEntityId);
        where.push(`t.legal_entity_id = $${params.length}`);
      }
      const scope = entityScopeFilter(
        principal,
        { legalEntityId: 't.legal_entity_id' },
        params.length + 1,
      );
      params.push(...scope.params);
      where.push(`(t.legal_entity_id IS NULL OR ${scope.sql})`);

      const { rows } = await client.query(
        `SELECT t.id, t.legal_entity_id, t.source_type, t.source_id, t.title, t.description,
                t.owner_user_id, t.owner_role_id, t.priority::text AS priority,
                t.status::text AS status, t.due_at, t.tags, t.completed_by, t.completed_at,
                t.created_at,
                (t.due_at IS NOT NULL AND t.due_at <= now() AND t.status IN ('OPEN','IN_PROGRESS'))
                  AS is_overdue
           FROM tasks t
          WHERE ${where.join(' AND ')}
          ORDER BY t.due_at NULLS LAST, t.created_at`,
        params,
      );
      return { data: rows };
    });
  }

  /**
   * POST /tasks/{id}/complete.
   *
   * An APPROVAL task is deliberately NOT completable here. Marking it done would
   * take the approval out of the inbox while the request it belongs to is still
   * open and the document still parked — an approval that looks dealt with and
   * has decided nothing. It is completed by deciding it, and this refusal says
   * where.
   */
  async completeTask(
    principal: TenantPrincipal,
    id: string,
    input: { evidence?: Record<string, unknown> | null; note?: string | null } = {},
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows } = await client.query<{
        id: string;
        tenant_id: string;
        legal_entity_id: string | null;
        source_type: string;
        source_id: string | null;
        status: string;
        owner_user_id: string | null;
        owner_role_id: string | null;
      }>(
        `SELECT id, tenant_id, legal_entity_id, source_type, source_id,
                status::text AS status, owner_user_id, owner_role_id
           FROM tasks WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [id, principal.tenantId],
      );
      const task = rows[0];
      if (!task) throw new AppError('NOT_FOUND', `Task ${id} was not found.`);
      assertScoped(principal, 'task.complete', task.legal_entity_id);

      if (task.status === 'COMPLETED') {
        return { id, status: 'COMPLETED', already_completed: true };
      }
      if (task.status === 'CANCELLED') {
        throw new AppError('VALIDATION_FAILED', `Task ${id} is CANCELLED and cannot be completed.`);
      }
      if (task.source_type === 'APPROVAL') {
        throw new AppError(
          'APPROVAL_REQUIRED',
          `Task ${id} is an approval. It is completed by deciding it — POST ` +
            `/approval-tasks/${task.source_id}/approve, /reject or /request-changes — not by ` +
            `marking it done. Closing it here would clear it from the inbox while the document ` +
            `it belongs to is still waiting for a decision.`,
          { details: { approvalStepId: task.source_id } },
        );
      }

      const { rows: updated } = await client.query(
        `UPDATE tasks
            SET status = 'COMPLETED', completed_by = $2, completed_at = now(),
                completion_evidence = $3::jsonb
          WHERE id = $1
        RETURNING id, status::text AS status, completed_by, completed_at, completion_evidence`,
        [
          id,
          principal.userId,
          JSON.stringify({ ...(input.evidence ?? {}), note: input.note ?? null }),
        ],
      );

      // `task.completed` is entity-scoped in contracts/events.yaml and `publish`
      // refuses an entity-scoped event with no entity on the envelope (F-041) —
      // while `tasks.legal_entity_id` is nullable. A task with no entity is
      // therefore completable and not announceable. The audit entry below is
      // written either way, so the fact is never lost; the mismatch between the
      // column's nullability and the event's scope is reported rather than
      // papered over by inventing an entity.
      if (task.legal_entity_id) {
        await publish(client, context, {
          eventType: 'task.completed',
          aggregateType: 'task',
          aggregateId: id,
          tenantId: principal.tenantId,
          legalEntityId: task.legal_entity_id,
          payload: { source_type: task.source_type, completed_by: principal.userId },
        });
      }
      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: task.legal_entity_id,
        action: 'task.completed',
        resourceType: 'task',
        resourceId: id,
        before: { status: task.status },
        after: updated[0] as Record<string, unknown>,
      });
      return updated[0];
    });
  }

  // -------------------------------------------------------------------------
  // Shared
  // -------------------------------------------------------------------------

  private async openFollowUpTask(
    client: PoolClient,
    context: RequestContext,
    tenantId: string,
    params: {
      legalEntityId: string | null;
      ownerUserId: string | null;
      requestId: string;
      title: string;
      description: string;
    },
  ): Promise<void> {
    if (!params.ownerUserId) return;
    const id = uuidv7();
    await client.query(
      `INSERT INTO tasks
         (id, tenant_id, legal_entity_id, source_type, source_id, title, description,
          owner_user_id, priority, status, tags)
       VALUES ($1,$2,$3,'MISSING_DOCUMENT',$4,$5,$6,$7,'HIGH','OPEN',$8::text[])`,
      [
        id,
        tenantId,
        params.legalEntityId,
        params.requestId,
        params.title,
        params.description,
        params.ownerUserId,
        [`approval_request:${params.requestId}`, 'changes_requested'],
      ],
    );
    await publish(client, context, {
      eventType: 'task.created',
      aggregateType: 'task',
      aggregateId: id,
      tenantId,
      legalEntityId: params.legalEntityId,
      payload: { source_type: 'MISSING_DOCUMENT', approval_request_id: params.requestId },
    });
  }

  /**
   * Everything a decision needs, loaded under the request's row lock.
   *
   * The lock is taken on the REQUEST and not on the step, deliberately: two
   * approvers of a parallel step must serialise against each other so that a
   * quorum of two cannot be reached three times, and locking the step each of
   * them holds would let both through. ADR-0004's rule that the lock order is
   * load-bearing, applied to a two-row hierarchy.
   */
  private async loadDecisionContext(
    client: PoolClient,
    principal: TenantPrincipal,
    stepId: string,
    permission: string,
  ): Promise<DecisionContext> {
    const { rows: located } = await client.query<{ approval_request_id: string }>(
      `SELECT approval_request_id FROM approval_steps WHERE id = $1 AND tenant_id = $2`,
      [stepId, principal.tenantId],
    );
    if (!located[0]) throw new AppError('NOT_FOUND', `Approval task ${stepId} was not found.`);

    const locked = await lockRequest(client, located[0].approval_request_id);
    if (!locked || locked.tenant_id !== principal.tenantId) {
      throw new AppError('NOT_FOUND', `Approval task ${stepId} was not found.`);
    }
    const request = await loadRequestDetail(client, located[0].approval_request_id);
    assertScoped(principal, permission, request.legal_entity_id);

    if (request.status !== 'PENDING') {
      throw new AppError(
        'VALIDATION_FAILED',
        `That approval request is already ${request.status}, so this task can no longer be acted ` +
          `on.`,
        { details: { status: request.status } },
      );
    }

    const steps = await loadSteps(client, request.id);
    const step = steps.find((s) => s.id === stepId);
    if (!step) throw new AppError('NOT_FOUND', `Approval task ${stepId} was not found.`);

    const blocked = notActionableBecause({ step, steps, now: new Date() });
    if (blocked) throw refuseNotActionable(blocked, step.stepNo);

    const adapter = gatedResource(request.resource_type);
    const facts = await loadResourceFacts(client, adapter, request.resource_id, {
      forUpdate: true,
    });

    // The instance is judged by the definition it STARTED with, not by whatever
    // the workflow says today. doc 14: "A running instance retains the version it
    // started with." A republish cannot reach this request because this request
    // does not read the workflow table.
    const snapshot = request.snapshot as { workflow?: { definition?: unknown } } | null;
    const definition = parseDefinition(snapshot?.workflow?.definition ?? { steps: [] });

    const authorityOf = await resolveAuthority(client, {
      principal,
      step,
      request,
      amount: facts.amount,
    });

    return { request, steps, step, adapter, facts, definition, authorityOf };
  }
}

interface DecisionContext {
  readonly request: Awaited<ReturnType<typeof loadRequestDetail>>;
  readonly steps: readonly StepState[];
  readonly step: StepState;
  readonly adapter: ReturnType<typeof gatedResource>;
  readonly facts: Awaited<ReturnType<typeof loadResourceFacts>>;
  readonly definition: WorkflowDefinition;
  /** Whose authority the actor is exercising — themselves, or a delegator. */
  readonly authorityOf: string;
}

async function loadSteps(client: PoolClient, requestId: string): Promise<StepState[]> {
  const { rows } = await client.query<StepRow>(
    `SELECT id, tenant_id, approval_request_id, step_no, is_parallel,
            approver_user_id, approver_role_id, resolved_from,
            status::text AS status, decision::text AS decision, decided_by,
            expires_at::text AS expires_at
       FROM approval_steps
      WHERE approval_request_id = $1
      ORDER BY step_no, id`,
    [requestId],
  );
  return rows.map(toStepState);
}

/**
 * May this person act on this step, and on whose authority?
 *
 * Three ways in, and no fourth:
 *   - they ARE the named approver;
 *   - the step names a ROLE and they hold it in a membership covering the entity;
 *   - the named approver has delegated to them, within scope, window and cap.
 *
 * Anything else is FORBIDDEN. Note what is NOT a way in: holding
 * `approval.approve` somewhere in the tenant. The permission is necessary and it
 * is checked separately; it is not sufficient, or every approver in the tenant
 * could decide every task and the workflow's approver resolution would be
 * decoration.
 */
async function resolveAuthority(
  client: PoolClient,
  params: {
    principal: TenantPrincipal;
    step: StepState;
    request: Awaited<ReturnType<typeof loadRequestDetail>>;
    amount: string;
  },
): Promise<string> {
  const { principal, step, request } = params;

  if (step.approverUserId === principal.userId) return principal.userId;

  if (step.approverRoleId !== null) {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM memberships m
        WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.role_id = $3
          AND m.status = 'ACTIVE' AND m.suspended_at IS NULL
          AND ($4::uuid IS NULL OR m.legal_entity_id IS NULL OR m.legal_entity_id = $4)`,
      [principal.tenantId, principal.userId, step.approverRoleId, request.legal_entity_id],
    );
    if (rows[0]?.n !== '0') return principal.userId;
  }

  if (step.approverUserId !== null) {
    const { rows } = await client.query<{
      id: string;
      delegator_user_id: string;
      delegate_user_id: string;
      scope_resource_type: string | null;
      legal_entity_id: string | null;
      max_amount: string | null;
      valid_from: string;
      valid_to: string;
    }>(
      `SELECT id, delegator_user_id, delegate_user_id, scope_resource_type, legal_entity_id,
              -- numeric::text, so the cap is compared as an exact decimal and
              -- never as a float (ADR-0006 §1).
              max_amount::text AS max_amount,
              valid_from::text AS valid_from, valid_to::text AS valid_to
         FROM delegations
        WHERE tenant_id = $1 AND delegator_user_id = $2 AND delegate_user_id = $3`,
      [principal.tenantId, step.approverUserId, principal.userId],
    );
    const grants: DelegationGrant[] = rows.map((r) => ({
      id: r.id,
      delegatorUserId: r.delegator_user_id,
      delegateUserId: r.delegate_user_id,
      scopeResourceType: r.scope_resource_type,
      legalEntityId: r.legal_entity_id,
      maxAmount: r.max_amount,
      validFrom: r.valid_from,
      validTo: r.valid_to,
    }));
    const answer = delegationPermits({
      grants,
      delegatorUserId: step.approverUserId,
      actorId: principal.userId,
      resourceType: request.resource_type,
      legalEntityId: request.legal_entity_id ?? '',
      amount: params.amount,
      now: new Date(),
    });
    if (answer.permitted) return step.approverUserId;
    throw new AppError(
      'FORBIDDEN',
      `This approval task is assigned to somebody else and ${answer.reason}. Approval authority ` +
        `is not transferable by holding the approval permission — the workflow resolved who may ` +
        `decide this step, and that decision is the control.`,
      { details: { stepId: step.id } },
    );
  }

  throw new AppError(
    'FORBIDDEN',
    'This approval task is not assigned to you, and no delegation names you.',
    { details: { stepId: step.id } },
  );
}

/**
 * `segregation_rules.threshold_amount` for DUAL_APPROVAL_OVER_THRESHOLD.
 *
 * Read as text, compared as an exact decimal. Returns null when the tenant has
 * not configured the rule, which is the permissive answer — the base
 * maker/checker rule is NOT optional and is enforced regardless, because the
 * database's own CHECK constraints state it too.
 */
async function dualApprovalThreshold(
  client: PoolClient,
  tenantId: string,
  resourceType: string,
  legalEntityId: string | null,
): Promise<string | null> {
  const { rows } = await client.query<{ threshold_amount: string | null }>(
    `SELECT threshold_amount::text AS threshold_amount
       FROM segregation_rules
      WHERE tenant_id = $1
        AND status = 'ACTIVE'
        AND rule_type = 'DUAL_APPROVAL_OVER_THRESHOLD'
        AND (resource_type IS NULL OR resource_type = $2)
        AND (legal_entity_id IS NULL OR legal_entity_id = $3)
        AND threshold_amount IS NOT NULL
      ORDER BY (resource_type IS NOT NULL) DESC, (legal_entity_id IS NOT NULL) DESC,
               threshold_amount
      LIMIT 1`,
    [tenantId, resourceType, legalEntityId],
  );
  return rows[0]?.threshold_amount ?? null;
}
