import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { ApprovalTaskService, ApprovalWorkflowService } from '@acct/approvals';
import { Operation } from '../common/operation';
import { code, decimalString, name, parse, uuid } from '../common/validation';
import type { AuthenticatedRequest } from '../common/auth.guard';
import { tenantPrincipal } from '../common/request';

/**
 * doc 14's Workflow surface — the ten operations the contract tags `Workflow` in
 * phase 6.
 *
 * One controller, because they are one subject: a workflow definition, the tasks
 * it produces, and the inbox those tasks land in. Splitting the inbox from the
 * decisions would put `/tasks` somewhere other than the approval that refuses to
 * be completed from it.
 *
 * Each handler declares only WHICH operation it is. That matters more here than
 * anywhere else in the API, because the three authorities involved are
 * deliberately different and the contract is where the difference is recorded:
 *
 *   approval.view      GET  /approval-tasks
 *   approval.approve   POST /approval-tasks/{id}/approve, /reject, /request-changes
 *   approval.delegate  POST /approval-tasks/{id}/delegate
 *   workflow.view      GET  /approval-workflows
 *   workflow.manage    POST /approval-workflows, /approval-workflows/{id}/publish
 *   task.view          GET  /tasks
 *   task.complete      POST /tasks/{id}/complete
 *
 * Not one of those strings appears below. `PermissionGuard` reads them from the
 * generated contract at request time, so a handler cannot claim the wrong one —
 * and moving delegation onto `approval.approve` (which is what hardcoding tends
 * to produce, since it is the neighbouring handler's permission) would make
 * "may hand my approvals to someone else" ungrantable separately from "may
 * approve", which is the separation F-921 exists to keep.
 *
 * `ApprovalTaskService` re-checks the same permission against the target LEGAL
 * ENTITY inside the transaction. Both halves are needed: the guard knows the
 * operation but not yet the entity, and the service knows the entity.
 *
 * Bodies are validated for SHAPE only. The rules that make a decision valid —
 * a rejection needs a reason, conditions must be exact decimals, a step must
 * resolve to somebody — live in `@acct/approvals` where the transaction and the
 * document facts are, and where every caller meets them rather than only the
 * ones that came through HTTP. Duplicating them here would be a second place for
 * them to drift, and would preempt refusal messages written for the person who
 * has to act on them.
 */

/**
 * A query flag. `z.coerce.boolean()` is NOT used: `Boolean('false')` is `true`,
 * so `?mine=false` would silently mean `mine=true`.
 */
const flag = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

/** `approval_status` (0000). Filtered in SQL as `$n::approval_status`. */
const approvalStatus = z.enum(['NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']);

/** `task_status` (0000). */
const taskStatus = z.enum(['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'ESCALATED']);

/**
 * doc 14's ten source types, as `tasks_source_type_check` spells them.
 *
 * Constrained rather than passed through: an unrecognised `source_type` filters
 * to nothing, and an empty inbox reads as "no work outstanding" rather than as a
 * typo. A filter that answers "nothing" for a question it did not understand is
 * the same vacuity as a gate that measures nothing.
 */
const taskSourceType = z.enum([
  'APPROVAL',
  'BANK_RECONCILIATION',
  'BILL_MATCH',
  'MISSING_DOCUMENT',
  'COLLECTIONS',
  'CLOSE',
  'TAX_EXCEPTION',
  'AI_REVIEW',
  'INTEGRATION_FAILURE',
  'MIGRATION_ERROR',
]);

/** An ISO-8601 instant. Offsets allowed; the column is `timestamptz`. */
const timestamp = z.string().trim().datetime({ offset: true });

/**
 * `approval_requests.resource_type` / `approval_workflows.resource_type`.
 *
 * Upper snake case, because that is what every writer of the column uses —
 * `GATED_RESOURCES` (JOURNAL, INVOICE, VENDOR_BILL) and `@acct/close`'s
 * `APPROVAL_RESOURCE` (CLOSE_RUN, ACCOUNTING_PERIOD, FINANCIAL_SNAPSHOT). A
 * workflow published against `journal` would match no document ever while
 * appearing configured, which is the failure this shape check exists to stop.
 * The set itself is not enumerated here: which resource types are gated is the
 * engine's registry to state, and copying it into the HTTP layer would make a
 * second list to keep in step.
 */
const resourceType = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'upper snake case, e.g. VENDOR_BILL');

/** A decision comment. Required for REJECT and REQUEST_CHANGES — by the service. */
const DecisionBody = z.object({
  comment: z.string().trim().min(1).max(4000).nullish(),
});

@Controller()
export class ApprovalsController {
  constructor(
    @Inject(ApprovalWorkflowService) private readonly workflows: ApprovalWorkflowService,
    @Inject(ApprovalTaskService) private readonly tasks: ApprovalTaskService,
  ) {}

  // --- workflow definitions -------------------------------------------------

  @Get('approval-workflows')
  @Operation('listApprovalWorkflows')
  async listWorkflows(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(
      z.object({
        resource_type: resourceType.optional(),
        code: code.optional(),
        published_only: flag,
      }),
      query,
    );
    return this.workflows.list(tenantPrincipal(req), {
      resourceType: q.resource_type,
      code: q.code,
      publishedOnly: q.published_only,
    });
  }

  /**
   * A new, unpublished version. It governs nothing until it is published.
   *
   * `conditions` and `definition` are handed on as raw JSON. That is deliberate:
   * `parseConditions` refuses a JSON number for `min_amount`/`max_amount` with the
   * reason (ADR-0006 §1 — a threshold rounded by a binary float admits the
   * transaction it exists to stop), and `parseDefinition` refuses a resolution
   * method this schema cannot answer. Re-declaring either shape in zod risks
   * accepting `10000.55` as a number here and never reaching the refusal.
   */
  @Post('approval-workflows')
  @Operation('createApprovalWorkflow')
  async createWorkflow(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const b = parse(
      z.object({
        resource_type: resourceType,
        code,
        name,
        legal_entity_id: uuid.nullish(),
        valid_from: timestamp.nullish(),
        valid_to: timestamp.nullish(),
        conditions: z.record(z.unknown()).nullish(),
        definition: z.record(z.unknown()),
      }),
      body,
    );
    return this.workflows.create(tenantPrincipal(req), {
      resourceType: b.resource_type,
      code: b.code,
      name: b.name,
      legalEntityId: b.legal_entity_id,
      validFrom: b.valid_from,
      validTo: b.valid_to,
      conditions: b.conditions,
      definition: b.definition,
    });
  }

  @Post('approval-workflows/:id/publish')
  @Operation('publishApprovalWorkflow')
  async publishWorkflow(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.workflows.publish(tenantPrincipal(req), parse(uuid, id));
  }

  // --- the approval inbox ---------------------------------------------------

  /**
   * By default the steps this caller can act on now; with `request_id`, the whole
   * decision history of one request — which is where doc 21's "approval task inbox
   * AND audit history" second half is read.
   *
   * `mine` is passed through undefined rather than defaulted, because the service
   * defaults it from `request_id`: asking for one request's history means the
   * whole history, not the part of it addressed to you.
   */
  @Get('approval-tasks')
  @Operation('listApprovalTasks')
  async listApprovalTasks(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(
      z.object({
        request_id: uuid.optional(),
        resource_type: resourceType.optional(),
        resource_id: uuid.optional(),
        status: approvalStatus.optional(),
        mine: flag,
      }),
      query,
    );
    return this.tasks.listApprovalTasks(tenantPrincipal(req), {
      requestId: q.request_id,
      resourceType: q.resource_type,
      resourceId: q.resource_id,
      status: q.status,
      mine: q.mine,
    });
  }

  @Post('approval-tasks/:id/approve')
  @Operation('approveTask')
  async approveTask(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(DecisionBody, body);
    return this.tasks.approve(tenantPrincipal(req), parse(uuid, id), { comment: b.comment });
  }

  /**
   * The comment is not made mandatory here even though a rejection needs one.
   * `ApprovalTaskService.reject` refuses without it, and it refuses in the words
   * the person who has to fix the document needs to read; a zod `required` would
   * answer `field_errors: [{field: "comment"}]` and reach that explanation never.
   */
  @Post('approval-tasks/:id/reject')
  @Operation('rejectTask')
  async rejectTask(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(DecisionBody, body);
    return this.tasks.reject(tenantPrincipal(req), parse(uuid, id), { comment: b.comment });
  }

  @Post('approval-tasks/:id/request-changes')
  @Operation('requestTaskChanges')
  async requestTaskChanges(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(DecisionBody, body);
    return this.tasks.requestChanges(tenantPrincipal(req), parse(uuid, id), { comment: b.comment });
  }

  /**
   * Delegation — `approval.delegate`, which is not `approval.approve`.
   *
   * `max_amount` is an exact decimal string and is never a JavaScript number at
   * any point: it is a cap the delegate may not approve above, compared with
   * exact decimals in `delegationPermits`, and a cap that had been through a
   * binary float would be a cap that admits the approval it was set to stop.
   * A negative cap is refused: `D(amount).abs().gt(D(cap))` is true for every
   * amount against a negative cap, so it would create a delegation that permits
   * nothing while reading as a delegation — the same shape as an empty condition
   * list, which `parseConditions` refuses for the same reason.
   */
  @Post('approval-tasks/:id/delegate')
  @Operation('delegateTask')
  async delegateTask(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(
      z.object({
        delegate_user_id: uuid,
        reason: z.string().trim().min(1).max(1000).nullish(),
        // `delegations` CHECKs `valid_to > valid_from` and the row is inserted
        // with `valid_from = now()`. Refused here so the caller reads why rather
        // than a constraint name.
        valid_to: timestamp
          .refine(
            (v) => new Date(v).getTime() > Date.now(),
            'must be in the future — a delegation that has already ended covers nobody',
          )
          .nullish(),
        max_amount: decimalString
          .refine(
            (v) => !v.startsWith('-'),
            'a delegation cap cannot be negative; omit it for no cap',
          )
          .nullish(),
      }),
      body,
    );
    return this.tasks.delegate(tenantPrincipal(req), parse(uuid, id), {
      delegateUserId: b.delegate_user_id,
      reason: b.reason,
      validTo: b.valid_to,
      maxAmount: b.max_amount,
    });
  }

  // --- the unified inbox ----------------------------------------------------

  @Get('tasks')
  @Operation('listTasks')
  async listTasks(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(
      z.object({
        status: taskStatus.optional(),
        source_type: taskSourceType.optional(),
        legal_entity_id: uuid.optional(),
        mine: flag,
      }),
      query,
    );
    return this.tasks.listTasks(tenantPrincipal(req), {
      status: q.status,
      sourceType: q.source_type,
      legalEntityId: q.legal_entity_id,
      mine: q.mine,
    });
  }

  /**
   * An APPROVAL task is not completable here — the service refuses and says where
   * to decide it instead. Marking one done would clear it from the inbox while
   * the document it belongs to is still parked waiting for a decision.
   */
  @Post('tasks/:id/complete')
  @Operation('completeTask')
  async completeTask(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(
      z.object({
        evidence: z.record(z.unknown()).nullish(),
        note: z.string().trim().min(1).max(2000).nullish(),
      }),
      body,
    );
    return this.tasks.completeTask(tenantPrincipal(req), parse(uuid, id), {
      evidence: b.evidence,
      note: b.note,
    });
  }
}
