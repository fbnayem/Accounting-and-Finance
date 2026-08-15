/**
 * The approval engine: raising a request, materialising its steps, and the gate
 * a posting path asks before it turns a document into an accounting fact.
 *
 * -----------------------------------------------------------------------------
 * What actually prevents a bypass
 * -----------------------------------------------------------------------------
 * Phase 6's exit criterion is "approval bypass attempts fail at API/domain
 * layer", so the question is not what this engine can express but what it stops.
 * Three mechanisms, in decreasing order of how hard they are to get round:
 *
 *   1. **The database, for journals.** Migration 0049 installs a DEFERRABLE
 *      INITIALLY DEFERRED constraint trigger that fires at COMMIT of the posting
 *      transaction: a journal at or above the book's `journal_approval_threshold`
 *      cannot reach POSTED unless `approved_by` is set, and `je_maker_checker`
 *      refuses `approved_by` unless the preparer is KNOWN and different. No
 *      application path can avoid it, including one that never heard of this
 *      package. What this engine adds is the legitimate way that column gets
 *      filled — through a workflow, by resolved approvers, with the decision
 *      recorded.
 *
 *   2. **The parked state, for subledger documents.** `requestApproval` moves an
 *      invoice or a bill into `PENDING_APPROVAL`, and `AR.postInvoice` /
 *      `AP.postVendorBill` already refuse to post from that status. Before this
 *      package nothing in the platform could enter that state, so the guard above
 *      it had never once fired. The document leaves the state only through a
 *      completed request, a rejection or an explicit withdrawal.
 *
 *   3. **`assertApprovalSatisfied`, for everything else.** A posting path calls
 *      it inside its own transaction and it refuses when a request is open, when
 *      the last request was rejected, or when a workflow governs the document and
 *      no request was ever raised. This is the mechanism that covers conditions
 *      other than the journal threshold — and it is the one that is only as good
 *      as its call sites, so every call site it needs is named in the integration
 *      notes rather than assumed. A registered intention is not an executed one.
 */
import type { Pool, PoolClient } from 'pg';
import {
  AppError,
  assertTenantScope,
  uuidv7,
  type RequestContext,
  type TenantPrincipal,
} from '@acct/domain';
import { publish, recordAudit, writeInTenant } from '@acct/database';
import {
  matchesConditions,
  conditionSpecificity,
  serializeConditions,
  type ConditionFacts,
} from './conditions';
import { serializeDefinition, type StepDefinition, type WorkflowDefinition } from './definition';
import {
  gatedResource,
  loadResourceFacts,
  parkForApproval,
  releaseResource,
  type GatedResource,
  type ResourceFacts,
} from './resources';
import { selectGoverningWorkflow, type StoredWorkflow } from './workflows.service';

export interface RequestApprovalInput {
  readonly resourceType: string;
  readonly resourceId: string;
  readonly reason?: string | null;
  /** Facts the document does not carry but the caller knows (doc 14 conditions). */
  readonly riskFlags?: readonly string[];
  readonly exceptionStates?: readonly string[];
}

export type RequestApprovalResult =
  | { readonly required: false; readonly reason: string }
  | {
      readonly required: true;
      readonly requestId: string;
      readonly workflowId: string;
      readonly workflowCode: string;
      readonly workflowVersion: number;
      readonly steps: number;
      readonly activeStepNo: number;
      readonly status: string;
    };

interface OpenRequestRow {
  id: string;
  tenant_id: string;
  status: string;
  workflow_version: number;
  approval_workflow_id: string;
}

export class ApprovalEngine {
  constructor(private readonly pool: Pool) {}

  /**
   * Raise an approval request against a document.
   *
   * There is deliberately no HTTP route for this: doc 14's acceptance criterion
   * is that "calling a post/pay endpoint directly cannot bypass active approval
   * workflow", which is a property of the DOMAIN COMMAND that submits the
   * document, not of a separate button. The submitting command calls
   * `requestApprovalInTransaction` inside its own transaction so that the
   * document's move into the gated state and the request that explains it commit
   * together or not at all.
   */
  async requestApproval(
    principal: TenantPrincipal,
    input: RequestApprovalInput,
  ): Promise<RequestApprovalResult> {
    return writeInTenant(this.pool, principal, async ({ client, context }) =>
      requestApprovalInTransaction(client, context, principal, input),
    );
  }

  /**
   * Withdraw an open request and return the document to its previous state.
   *
   * The request becomes CANCELLED, never deleted: Gate C revokes DELETE on
   * `approval_requests` and `approval_steps` precisely so that "this was asked
   * for and then withdrawn" stays answerable.
   */
  async withdraw(principal: TenantPrincipal, requestId: string, reason: string) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const locked = await lockRequest(client, requestId);
      assertTenantScope(principal, locked, 'approval_request', requestId);
      const request = locked!;
      if (request.status !== 'PENDING') {
        throw new AppError(
          'VALIDATION_FAILED',
          `Approval request ${requestId} is ${request.status}; only a PENDING request can be withdrawn.`,
        );
      }
      const detail = await loadRequestDetail(client, requestId);
      const adapter = gatedResource(detail.resource_type);

      if (detail.requested_by !== principal.userId) {
        throw new AppError(
          'FORBIDDEN',
          'Only the person who requested the approval can withdraw it. An approver who wants it ' +
            'stopped rejects it or requests changes, both of which are recorded decisions.',
        );
      }

      await cancelRequest(client, context, principal.tenantId, {
        requestId,
        legalEntityId: detail.legal_entity_id,
        adapter,
        resourceId: detail.resource_id,
        reason,
        action: 'approval_request.withdrawn',
      });
      return { id: requestId, status: 'CANCELLED', reason };
    });
  }

  /**
   * Expiry and escalation.
   *
   * Driven by the worker, not by a request: an expiry is something that happens
   * when nobody is looking, which is exactly why it must not be able to approve
   * anything. See `applyEscalation` — every action it can take adds an approver,
   * reassigns one, reminds one or cancels the request. There is no action that
   * completes an approval, and `escalation_rules.action`'s CHECK constraint
   * cannot express one either.
   */
  async sweepExpirations(principal: TenantPrincipal, options: { limit?: number } = {}) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows } = await client.query<{
        step_id: string;
        request_id: string;
        step_no: number;
        expires_at: string;
        legal_entity_id: string | null;
        resource_type: string;
        resource_id: string;
        approval_workflow_id: string;
        snapshot: unknown;
      }>(
        `SELECT s.id AS step_id, s.approval_request_id AS request_id, s.step_no,
                s.expires_at::text AS expires_at,
                r.legal_entity_id, r.resource_type, r.resource_id,
                r.approval_workflow_id, r.snapshot
           FROM approval_steps s
           JOIN approval_requests r ON r.id = s.approval_request_id
          WHERE s.tenant_id = $1
            AND s.status = 'PENDING'
            AND r.status = 'PENDING'
            AND s.expires_at IS NOT NULL
            AND s.expires_at <= now()
            AND s.escalated_at IS NULL
          ORDER BY s.expires_at
          LIMIT $2`,
        [principal.tenantId, options.limit ?? 100],
      );

      const escalated: Array<{ step_id: string; action: string }> = [];
      for (const row of rows) {
        const snapshot = row.snapshot as { workflow?: { definition?: unknown } } | null;
        const definition = snapshot?.workflow?.definition as
          { steps?: Array<{ step_no?: number; on_expiry?: string }> } | undefined;
        const stepDef = definition?.steps?.find((s) => s.step_no === row.step_no);
        // BLOCK is the default and it does nothing: the step stays expired and
        // unapprovable, the request stays PENDING, and the document stays parked.
        // That is the fail-closed half, and it needs no code.
        if (stepDef?.on_expiry !== 'ESCALATE') continue;

        const action = await applyEscalation(client, context, principal, {
          stepId: row.step_id,
          requestId: row.request_id,
          stepNo: row.step_no,
          workflowId: row.approval_workflow_id,
          legalEntityId: row.legal_entity_id,
          resourceType: row.resource_type,
          resourceId: row.resource_id,
        });
        if (action) escalated.push({ step_id: row.step_id, action });
      }

      return { scanned: rows.length, escalated };
    });
  }
}

// ---------------------------------------------------------------------------
// Raising a request
// ---------------------------------------------------------------------------

/**
 * The transactional form, for a domain command that is already writing.
 *
 * Returns `{ required: false }` when no published workflow matches, so the
 * calling command carries on exactly as it does today. That answer is the reason
 * this is safe to wire into every submit path at once: a tenant with no
 * workflows configured sees no behaviour change at all.
 */
export async function requestApprovalInTransaction(
  client: PoolClient,
  context: RequestContext,
  principal: TenantPrincipal,
  input: RequestApprovalInput,
): Promise<RequestApprovalResult> {
  const adapter = gatedResource(input.resourceType);
  const facts = await loadResourceFacts(client, adapter, input.resourceId, { forUpdate: true });
  assertTenantScope(principal, { tenant_id: facts.tenantId }, adapter.label, input.resourceId);

  // An open request already covers this document. Returning it rather than
  // raising a second one keeps `x-idempotency` retries and double submits from
  // producing two chains of approvers for one document.
  const existing = await findOpenRequest(client, principal.tenantId, adapter, input.resourceId);
  if (existing) {
    return {
      required: true,
      requestId: existing.id,
      workflowId: existing.approval_workflow_id,
      workflowCode: '(existing)',
      workflowVersion: existing.workflow_version,
      steps: 0,
      activeStepNo: 0,
      status: existing.status,
    };
  }

  if (!adapter.requestableFrom.includes(facts.status)) {
    throw new AppError(
      'VALIDATION_FAILED',
      `${adapter.label} ${facts.reference} is ${facts.status}; approval can only be requested from ` +
        `${adapter.requestableFrom.join(' or ')}.`,
      { details: { status: facts.status } },
    );
  }

  const conditionFacts = toConditionFacts(adapter, facts, input);
  const candidates = await selectGoverningWorkflow(
    client,
    principal.tenantId,
    adapter.resourceType,
    facts.legalEntityId,
    new Date(),
  );
  const workflow = chooseWorkflow(candidates, conditionFacts);
  if (!workflow) {
    return {
      required: false,
      reason:
        candidates.length === 0
          ? `no published ${adapter.resourceType} workflow is in force for this entity`
          : `no published ${adapter.resourceType} workflow's conditions match this document`,
    };
  }

  const now = new Date();
  const requestId = uuidv7();
  const snapshot = {
    workflow: {
      id: workflow.id,
      code: workflow.code,
      name: workflow.name,
      version: workflow.version,
      // The snapshot is what a running instance is judged by — see the note in
      // `workflows.service.ts`. Money inside it is a string, for the same reason
      // it is a string in the table it was copied from.
      conditions: serializeConditions(workflow.conditions),
      definition: serializeDefinition(workflow.definition),
    },
    resource: {
      resource_type: adapter.resourceType,
      reference: facts.reference,
      amount: facts.amount,
      currency: facts.currency,
      prepared_by: facts.preparedBy,
      status_before: facts.status,
      version: facts.version,
      account_ids: facts.accountIds,
      counterparty_id: facts.counterpartyId,
    },
    requested: {
      reason: input.reason ?? null,
      risk_flags: input.riskFlags ?? [],
      exception_states: input.exceptionStates ?? [],
    },
  };

  await client.query(
    `INSERT INTO approval_requests
       (id, tenant_id, legal_entity_id, approval_workflow_id, workflow_version,
        resource_type, resource_id, status, requested_by, requested_at,
        document_version, snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',$8, now(), $9::bigint, $10::jsonb)`,
    [
      requestId,
      principal.tenantId,
      facts.legalEntityId,
      workflow.id,
      workflow.version,
      adapter.resourceType,
      facts.id,
      principal.userId,
      facts.version,
      JSON.stringify(snapshot),
    ],
  );

  await materialiseSteps(client, {
    requestId,
    tenantId: principal.tenantId,
    definition: workflow.definition,
    now,
  });
  await activateStep(client, context, principal.tenantId, {
    requestId,
    stepNo: 1,
    definition: workflow.definition,
    legalEntityId: facts.legalEntityId,
    title: `Approve ${adapter.label.toLowerCase()} ${facts.reference}`,
    description:
      `${facts.amount} ${facts.currency} — workflow ${workflow.code} v${workflow.version}` +
      (input.reason ? `. ${input.reason}` : ''),
  });

  await parkForApproval(client, adapter, facts.id);

  await publish(client, context, {
    eventType: 'workflow.started',
    aggregateType: 'approval_request',
    aggregateId: requestId,
    tenantId: principal.tenantId,
    legalEntityId: facts.legalEntityId,
    payload: {
      workflow_code: workflow.code,
      workflow_version: workflow.version,
      resource_type: adapter.resourceType,
      resource_id: facts.id,
    },
  });
  await publish(client, context, {
    eventType: 'approval.requested',
    aggregateType: 'approval_request',
    aggregateId: requestId,
    tenantId: principal.tenantId,
    legalEntityId: facts.legalEntityId,
    payload: {
      resource_type: adapter.resourceType,
      resource_id: facts.id,
      // Exact decimal string on the wire, never a JSON number (ADR-0006 §1).
      amount: facts.amount,
      currency: facts.currency,
      steps: workflow.definition.steps.length,
    },
  });
  await recordAudit(client, context, {
    tenantId: principal.tenantId,
    legalEntityId: facts.legalEntityId,
    action: 'approval.requested',
    resourceType: 'approval_request',
    resourceId: requestId,
    reason: input.reason ?? null,
    after: {
      resource_type: adapter.resourceType,
      resource_id: facts.id,
      workflow: `${workflow.code} v${workflow.version}`,
      parked_status: adapter.pendingStatus,
    },
  });

  return {
    required: true,
    requestId,
    workflowId: workflow.id,
    workflowCode: workflow.code,
    workflowVersion: workflow.version,
    steps: workflow.definition.steps.length,
    activeStepNo: 1,
    status: 'PENDING',
  };
}

export function toConditionFacts(
  adapter: GatedResource,
  facts: ResourceFacts,
  input: Pick<RequestApprovalInput, 'riskFlags' | 'exceptionStates'>,
): ConditionFacts {
  return {
    amount: facts.amount,
    currency: facts.currency,
    legalEntityId: facts.legalEntityId,
    branchId: facts.branchId,
    accountIds: facts.accountIds,
    counterpartyId: facts.counterpartyId,
    departmentId: null,
    projectId: facts.projectId,
    sourceType: adapter.resourceType,
    riskFlags: input.riskFlags ?? [],
    exceptionStates: input.exceptionStates ?? [],
  };
}

/** Deterministic selection — see `selectGoverningWorkflow`'s contract. */
export function chooseWorkflow(
  candidates: readonly StoredWorkflow[],
  facts: ConditionFacts,
): StoredWorkflow | null {
  const matching = candidates.filter((w) => matchesConditions(w.conditions, facts).matched);
  if (matching.length === 0) return null;
  const ranked = [...matching].sort((a, b) => {
    const entity = Number(b.legalEntityId !== null) - Number(a.legalEntityId !== null);
    if (entity !== 0) return entity;
    const specificity = conditionSpecificity(b.conditions) - conditionSpecificity(a.conditions);
    if (specificity !== 0) return specificity;
    if (b.version !== a.version) return b.version - a.version;
    return a.code.localeCompare(b.code);
  });
  return ranked[0] ?? null;
}

async function findOpenRequest(
  client: PoolClient,
  tenantId: string,
  adapter: GatedResource,
  resourceId: string,
): Promise<OpenRequestRow | null> {
  const { rows } = await client.query<OpenRequestRow>(
    `SELECT id, tenant_id, status::text AS status, workflow_version, approval_workflow_id
       FROM approval_requests
      WHERE tenant_id = $1 AND resource_type = $2 AND resource_id = $3 AND status = 'PENDING'
      ORDER BY requested_at DESC
      LIMIT 1`,
    [tenantId, adapter.resourceType, resourceId],
  );
  return rows[0] ?? null;
}

/**
 * Writes every step of the workflow, not only the first.
 *
 * doc 14: "Resolved approvers are recorded on the instance." A later step's rows
 * therefore exist from the start — which means `activeStepNo` in `steps.ts` has
 * to be what stops them being decided early, and it is.
 *
 * `expires_at` is set only when a step becomes ACTIVE. Starting every clock at
 * request time would expire step 3 while step 1 was still legitimately waiting.
 */
async function materialiseSteps(
  client: PoolClient,
  params: {
    requestId: string;
    tenantId: string;
    definition: WorkflowDefinition;
    now: Date;
  },
): Promise<void> {
  for (const step of params.definition.steps) {
    for (const approver of step.approvers) {
      await client.query(
        `INSERT INTO approval_steps
           (id, tenant_id, approval_request_id, step_no, is_parallel,
            approver_user_id, approver_role_id, resolved_from, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING')`,
        [
          uuidv7(),
          params.tenantId,
          params.requestId,
          step.stepNo,
          step.mode === 'PARALLEL',
          approver.resolvedFrom === 'NAMED_USER' ? approver.userId : null,
          approver.resolvedFrom === 'ROLE' ? approver.roleId : null,
          approver.resolvedFrom,
        ],
      );
    }
  }
}

/**
 * Starts a step's clock and puts it in its approvers' inboxes.
 *
 * Called for step 1 at request time and for step n+1 when step n is satisfied.
 */
export async function activateStep(
  client: PoolClient,
  context: RequestContext,
  tenantId: string,
  params: {
    requestId: string;
    stepNo: number;
    definition: WorkflowDefinition;
    legalEntityId: string | null;
    title: string;
    description: string;
  },
): Promise<void> {
  const step: StepDefinition | undefined = params.definition.steps.find(
    (s) => s.stepNo === params.stepNo,
  );
  if (!step) return;

  const expires =
    step.expiresAfterHours === null
      ? null
      : new Date(Date.now() + step.expiresAfterHours * 3_600_000).toISOString();

  const { rows } = await client.query<{
    id: string;
    approver_user_id: string | null;
    approver_role_id: string | null;
  }>(
    `UPDATE approval_steps
        SET expires_at = $3::timestamptz
      WHERE approval_request_id = $1 AND step_no = $2 AND status = 'PENDING'
    RETURNING id, approver_user_id, approver_role_id`,
    [params.requestId, params.stepNo, expires],
  );

  for (const row of rows) {
    await client.query(
      `INSERT INTO tasks
         (id, tenant_id, legal_entity_id, source_type, source_id, title, description,
          owner_user_id, owner_role_id, priority, status, due_at, tags)
       VALUES ($1,$2,$3,'APPROVAL',$4,$5,$6,$7,$8,'NORMAL','OPEN',$9::timestamptz,$10::text[])`,
      [
        uuidv7(),
        tenantId,
        params.legalEntityId,
        // The step, not the request: a task is one person's unit of work, and a
        // parallel step has several. Closing "the task for this decision" needs
        // the step to be what the task points at.
        row.id,
        params.title,
        params.description,
        row.approver_user_id,
        row.approver_role_id,
        expires,
        [`approval_request:${params.requestId}`, `step:${params.stepNo}`],
      ],
    );
    await publish(client, context, {
      eventType: 'approval.assigned',
      aggregateType: 'approval_request',
      aggregateId: params.requestId,
      tenantId,
      legalEntityId: params.legalEntityId,
      payload: {
        step_no: params.stepNo,
        approval_step_id: row.id,
        approver_user_id: row.approver_user_id,
        approver_role_id: row.approver_role_id,
        expires_at: expires,
      },
    });
    await publish(client, context, {
      eventType: 'task.created',
      aggregateType: 'task',
      aggregateId: row.id,
      tenantId,
      legalEntityId: params.legalEntityId,
      payload: {
        source_type: 'APPROVAL',
        approval_request_id: params.requestId,
        title: params.title,
      },
    });
  }
}

/** Closes the inbox items belonging to a set of steps. */
export async function closeTasksForSteps(
  client: PoolClient,
  context: RequestContext,
  tenantId: string,
  legalEntityId: string | null,
  stepIds: readonly string[],
  outcome: 'COMPLETED' | 'CANCELLED',
): Promise<void> {
  if (stepIds.length === 0) return;
  const { rows } = await client.query<{ id: string }>(
    `UPDATE tasks
        SET status = $3::task_status,
            completed_at = CASE WHEN $3 = 'COMPLETED' THEN now() ELSE completed_at END
      WHERE tenant_id = $1 AND source_type = 'APPROVAL' AND source_id = ANY($2::uuid[])
        AND status IN ('OPEN','IN_PROGRESS','ESCALATED')
    RETURNING id`,
    [tenantId, stepIds, outcome],
  );
  for (const row of rows) {
    if (outcome !== 'COMPLETED') continue;
    await publish(client, context, {
      eventType: 'task.completed',
      aggregateType: 'task',
      aggregateId: row.id,
      tenantId,
      legalEntityId,
      payload: { source_type: 'APPROVAL' },
    });
  }
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

export async function cancelRequest(
  client: PoolClient,
  context: RequestContext,
  tenantId: string,
  params: {
    requestId: string;
    legalEntityId: string | null;
    adapter: GatedResource;
    resourceId: string;
    reason: string;
    action: string;
  },
): Promise<void> {
  const { rows: steps } = await client.query<{ id: string }>(
    `UPDATE approval_steps
        SET status = 'CANCELLED'
      WHERE approval_request_id = $1 AND status = 'PENDING'
    RETURNING id`,
    [params.requestId],
  );
  await client.query(
    `UPDATE approval_requests SET status = 'CANCELLED', completed_at = now() WHERE id = $1`,
    [params.requestId],
  );
  await closeTasksForSteps(
    client,
    context,
    tenantId,
    params.legalEntityId,
    steps.map((s) => s.id),
    'CANCELLED',
  );
  await releaseResource(client, params.adapter, params.resourceId, 'CANCELLED');

  await publish(client, context, {
    eventType: 'approval.cancelled',
    aggregateType: 'approval_request',
    aggregateId: params.requestId,
    tenantId,
    legalEntityId: params.legalEntityId,
    payload: { reason: params.reason, resource_id: params.resourceId },
  });
  await publish(client, context, {
    eventType: 'workflow.completed',
    aggregateType: 'approval_request',
    aggregateId: params.requestId,
    tenantId,
    legalEntityId: params.legalEntityId,
    payload: { outcome: 'CANCELLED' },
  });
  await recordAudit(client, context, {
    tenantId,
    legalEntityId: params.legalEntityId,
    action: params.action,
    resourceType: 'approval_request',
    resourceId: params.requestId,
    reason: params.reason,
    after: { status: 'CANCELLED', released_to: params.adapter.returnStatus },
  });
}

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

async function applyEscalation(
  client: PoolClient,
  context: RequestContext,
  principal: TenantPrincipal,
  params: {
    stepId: string;
    requestId: string;
    stepNo: number;
    workflowId: string;
    legalEntityId: string | null;
    resourceType: string;
    resourceId: string;
  },
): Promise<string | null> {
  const { rows } = await client.query<{
    id: string;
    action: string;
    target_role_id: string | null;
    target_user_id: string | null;
  }>(
    `SELECT e.id, e.action, e.target_role_id, e.target_user_id
       FROM escalation_rules e
       JOIN approval_steps s ON s.id = $2
      WHERE e.tenant_id = $1
        AND e.status = 'ACTIVE'
        AND (e.approval_workflow_id = $3 OR e.approval_workflow_id IS NULL)
        AND now() >= s.expires_at + e.after_interval
      ORDER BY (e.approval_workflow_id IS NOT NULL) DESC, e.after_interval
      LIMIT 1`,
    [principal.tenantId, params.stepId, params.workflowId],
  );
  const rule = rows[0];
  if (!rule) return null;

  await client.query(`UPDATE approval_steps SET escalated_at = now() WHERE id = $1`, [
    params.stepId,
  ]);

  const addRow = async (): Promise<string> => {
    const id = uuidv7();
    await client.query(
      `INSERT INTO approval_steps
         (id, tenant_id, approval_request_id, step_no, is_parallel,
          approver_user_id, approver_role_id, resolved_from, status, expires_at)
       SELECT $1, $2, $3, $4, s.is_parallel, $5, $6, 'CUSTOM', 'PENDING', NULL
         FROM approval_steps s WHERE s.id = $7`,
      [
        id,
        principal.tenantId,
        params.requestId,
        params.stepNo,
        rule.target_user_id,
        rule.target_role_id,
        params.stepId,
      ],
    );
    await client.query(
      `INSERT INTO tasks
         (id, tenant_id, legal_entity_id, source_type, source_id, title, description,
          owner_user_id, owner_role_id, priority, status, tags)
       VALUES ($1,$2,$3,'APPROVAL',$4,$5,$6,$7,$8,'HIGH','OPEN',$9::text[])`,
      [
        uuidv7(),
        principal.tenantId,
        params.legalEntityId,
        id,
        `Escalated approval — ${params.resourceType} ${params.resourceId}`,
        `Step ${params.stepNo} expired and was escalated by rule ${rule.id}.`,
        rule.target_user_id,
        rule.target_role_id,
        [`approval_request:${params.requestId}`, `step:${params.stepNo}`, 'escalated'],
      ],
    );
    return id;
  };

  switch (rule.action) {
    case 'REMIND':
    case 'ADD_WATCHER':
      await client.query(
        `INSERT INTO tasks
           (id, tenant_id, legal_entity_id, source_type, source_id, title, description,
            owner_user_id, owner_role_id, priority, status, tags)
         SELECT $1, $2, $3, 'APPROVAL', s.id,
                $4, $5,
                coalesce($6::uuid, s.approver_user_id), coalesce($7::uuid, s.approver_role_id),
                'HIGH', 'OPEN', $8::text[]
           FROM approval_steps s WHERE s.id = $9`,
        [
          uuidv7(),
          principal.tenantId,
          params.legalEntityId,
          rule.action === 'REMIND' ? 'Overdue approval' : 'Approval watch',
          `Step ${params.stepNo} of approval request ${params.requestId} is overdue.`,
          rule.target_user_id,
          rule.target_role_id,
          [`approval_request:${params.requestId}`, `step:${params.stepNo}`, 'escalated'],
          params.stepId,
        ],
      );
      break;
    case 'ADD_APPROVER':
      if (!rule.target_user_id && !rule.target_role_id) return null;
      await addRow();
      break;
    case 'REASSIGN': {
      if (!rule.target_user_id && !rule.target_role_id) return null;
      await client.query(
        `UPDATE approval_steps
            SET status = 'CANCELLED', decision_reason = $2
          WHERE id = $1 AND status = 'PENDING'`,
        [params.stepId, `Reassigned by escalation rule ${rule.id} after expiry.`],
      );
      await closeTasksForSteps(
        client,
        context,
        principal.tenantId,
        params.legalEntityId,
        [params.stepId],
        'CANCELLED',
      );
      await addRow();
      break;
    }
    case 'CANCEL':
      await cancelRequest(client, context, principal.tenantId, {
        requestId: params.requestId,
        legalEntityId: params.legalEntityId,
        adapter: gatedResource(params.resourceType),
        resourceId: params.resourceId,
        reason: `Escalation rule ${rule.id} cancelled the request after step ${params.stepNo} expired.`,
        action: 'approval.escalated_cancel',
      });
      break;
    default:
      return null;
  }

  await publish(client, context, {
    eventType: 'approval.escalated',
    aggregateType: 'approval_request',
    aggregateId: params.requestId,
    tenantId: principal.tenantId,
    legalEntityId: params.legalEntityId,
    payload: { step_no: params.stepNo, action: rule.action, rule_id: rule.id },
  });
  await recordAudit(client, context, {
    tenantId: principal.tenantId,
    legalEntityId: params.legalEntityId,
    action: 'approval.escalated',
    resourceType: 'approval_request',
    resourceId: params.requestId,
    after: { step_no: params.stepNo, action: rule.action, rule_id: rule.id },
  });
  return rule.action;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface ApprovalGateInput {
  readonly tenantId: string;
  readonly resourceType: string;
  readonly resourceId: string;
  /** What the caller is about to do, quoted back in the refusal. */
  readonly action?: string;
  readonly riskFlags?: readonly string[];
  readonly exceptionStates?: readonly string[];
}

/**
 * Refuses unless this document may proceed.
 *
 * Called by a posting or payment path INSIDE its own transaction, immediately
 * before the write it guards — F-106: a check outside that transaction is a
 * race, not a guard.
 *
 * It refuses in four situations, and the fourth is the one that matters most:
 *
 *   1. a request is still PENDING — the approvers have not finished;
 *   2. the last request was REJECTED — somebody said no;
 *   3. the last request was CANCELLED — it was withdrawn or escalated away, so
 *      nothing decided it;
 *   4. **no request was ever raised, and a published workflow governs this
 *      document.** Without this clause, the whole engine is bypassed by simply
 *      never asking it anything, which is what "bypass attempt" most often
 *      means in practice.
 *
 * And it permits in exactly two: an APPROVED request, or no governing workflow.
 * A control that only refuses is indistinguishable from one that refuses
 * everything, so both halves are tested.
 */
export async function assertApprovalSatisfied(
  client: PoolClient,
  input: ApprovalGateInput,
): Promise<void> {
  const adapter = gatedResource(input.resourceType);
  const action = input.action ?? 'posted';

  const { rows } = await client.query<{ id: string; status: string; requested_at: string }>(
    `SELECT id, status::text AS status, requested_at::text AS requested_at
       FROM approval_requests
      WHERE tenant_id = $1 AND resource_type = $2 AND resource_id = $3
      ORDER BY requested_at DESC
      LIMIT 1`,
    [input.tenantId, adapter.resourceType, input.resourceId],
  );
  const latest = rows[0];

  if (latest?.status === 'APPROVED') return;

  if (latest?.status === 'PENDING') {
    throw new AppError(
      'APPROVAL_REQUIRED',
      `${adapter.label} ${input.resourceId} is waiting for approval and cannot be ${action}. ` +
        `Approval request ${latest.id} is still open; it must be approved by its remaining ` +
        `approvers first (GET /approval-tasks lists them).`,
      { details: { requestId: latest.id, status: latest.status } },
    );
  }
  if (latest?.status === 'REJECTED') {
    throw new AppError(
      'APPROVAL_REQUIRED',
      `${adapter.label} ${input.resourceId} was REJECTED by its approvers on request ${latest.id} ` +
        `and cannot be ${action}. Correct it and request approval again.`,
      { details: { requestId: latest.id } },
    );
  }
  if (latest?.status === 'CANCELLED') {
    throw new AppError(
      'APPROVAL_REQUIRED',
      `The approval request on ${adapter.label.toLowerCase()} ${input.resourceId} was cancelled ` +
        `without a decision, so nothing has approved it and it cannot be ${action}. Request ` +
        `approval again.`,
      { details: { requestId: latest.id } },
    );
  }

  // No request at all. That is only acceptable if no workflow would have
  // demanded one — evaluated against the document as it stands NOW, so editing a
  // document up over a threshold after submitting it does not slip through.
  const facts = await loadResourceFacts(client, adapter, input.resourceId);
  const candidates = await selectGoverningWorkflow(
    client,
    input.tenantId,
    adapter.resourceType,
    facts.legalEntityId,
    new Date(),
  );
  const workflow = chooseWorkflow(
    candidates,
    toConditionFacts(adapter, facts, {
      riskFlags: input.riskFlags ?? [],
      exceptionStates: input.exceptionStates ?? [],
    }),
  );
  if (!workflow) return;

  throw new AppError(
    'APPROVAL_REQUIRED',
    `${adapter.label} ${facts.reference} totals ${facts.amount} ${facts.currency} and falls under ` +
      `approval workflow ${workflow.code} v${workflow.version}, which no approval request has ever ` +
      `been raised against. It cannot be ${action} until it has been submitted for approval and ` +
      `approved.`,
    {
      details: {
        workflow: workflow.code,
        version: workflow.version,
        amount: facts.amount,
        resourceId: facts.id,
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Shared loaders
// ---------------------------------------------------------------------------

export interface RequestDetailRow {
  id: string;
  tenant_id: string;
  legal_entity_id: string | null;
  approval_workflow_id: string;
  workflow_version: number;
  resource_type: string;
  resource_id: string;
  status: string;
  requested_by: string | null;
  document_version: string | null;
  snapshot: unknown;
}

export async function lockRequest(
  client: PoolClient,
  requestId: string,
): Promise<{ id: string; tenant_id: string; status: string } | null> {
  const { rows } = await client.query<{ id: string; tenant_id: string; status: string }>(
    `SELECT id, tenant_id, status::text AS status
       FROM approval_requests WHERE id = $1 FOR UPDATE`,
    [requestId],
  );
  return rows[0] ?? null;
}

export async function loadRequestDetail(
  client: PoolClient,
  requestId: string,
): Promise<RequestDetailRow> {
  const { rows } = await client.query<RequestDetailRow>(
    `SELECT id, tenant_id, legal_entity_id, approval_workflow_id, workflow_version,
            resource_type, resource_id, status::text AS status, requested_by,
            document_version::text AS document_version, snapshot
       FROM approval_requests WHERE id = $1`,
    [requestId],
  );
  const row = rows[0];
  if (!row) throw new AppError('NOT_FOUND', `Approval request ${requestId} was not found.`);
  return row;
}
