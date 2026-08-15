/**
 * Versioned workflow definitions — `createApprovalWorkflow`,
 * `publishApprovalWorkflow`, `listApprovalWorkflows`.
 *
 * doc 14: "Published workflow versions are immutable. New changes create a new
 * version. A running instance retains the version it started with."
 *
 * Three separate mechanisms make that sentence true, and they fail independently:
 *
 *   1. `guard_published_workflow` (0017) refuses any UPDATE that changes a
 *      published row's definition, conditions, version or resource type. So
 *      "immutable" is not a convention this service keeps.
 *   2. `approval_workflows_no_overlap` (0017) refuses two published versions of
 *      one workflow being effective at the same instant for the same scope. So
 *      "which version governs a document raised now" always has exactly one
 *      answer. `publish` closes the outgoing version's validity in the same
 *      transaction, which is what keeps the constraint satisfiable.
 *   3. A running instance does not read this table at all. It reads the SNAPSHOT
 *      taken into `approval_requests.snapshot` when it started. A republish
 *      therefore cannot reach a pending approval even through a defect, because
 *      the pending approval is not looking.
 *
 * The rule this file adds on top of the schema is that a workflow may not be
 * PUBLISHED with a step that resolves to nobody. A step naming a role no one
 * holds, or a user who is not a member of the tenant, produces a request that
 * cannot be decided and therefore a document that can never be posted. Refusing
 * it here costs a validation error; discovering it at a month end costs a close.
 */
import type { Pool, PoolClient } from 'pg';
import {
  AppError,
  assertEntityPermission,
  assertPermission,
  assertTenantScope,
  entityScopeFilter,
  notFound,
  uuidv7,
  type TenantPrincipal,
} from '@acct/domain';
import { readInTenant, recordAudit, writeInTenant } from '@acct/database';
import {
  parseConditions,
  parseStoredConditions,
  serializeConditions,
  type WorkflowConditions,
} from './conditions';
import {
  parseDefinition,
  serializeDefinition,
  type WorkflowDefinition,
  type ApproverSpec,
} from './definition';

export interface CreateWorkflowInput {
  readonly resourceType: string;
  readonly code: string;
  readonly name: string;
  readonly legalEntityId?: string | null;
  /** ISO timestamp. Defaults to now at publish time if omitted. */
  readonly validFrom?: string | null;
  readonly validTo?: string | null;
  readonly conditions?: unknown;
  readonly definition: unknown;
}

export interface StoredWorkflow {
  readonly id: string;
  readonly tenantId: string;
  readonly legalEntityId: string | null;
  readonly resourceType: string;
  readonly code: string;
  readonly name: string;
  readonly version: number;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly publishedAt: string | null;
  readonly conditions: WorkflowConditions;
  readonly definition: WorkflowDefinition;
}

interface WorkflowRow {
  id: string;
  tenant_id: string;
  legal_entity_id: string | null;
  resource_type: string;
  code: string;
  name: string;
  version: number;
  valid_from: string;
  valid_to: string | null;
  published_at: string | null;
  conditions: unknown;
  definition: unknown;
  /**
   * `conditions ->> 'min_amount'`, taken as TEXT in SQL and never through
   * `JSON.parse`. See the long note at the head of `conditions.ts`: this is the
   * read half of keeping a monetary condition exact, and it is exact even for a
   * row somebody wrote by hand with a JSON number, because PostgreSQL renders a
   * jsonb number from `numeric`.
   */
  min_amount: string | null;
  max_amount: string | null;
}

/** The projection every read here uses. */
const WORKFLOW_COLUMNS = `w.id, w.tenant_id, w.legal_entity_id, w.resource_type, w.code, w.name,
        w.version, w.valid_from, w.valid_to, w.published_at, w.conditions, w.definition,
        w.conditions ->> 'min_amount' AS min_amount,
        w.conditions ->> 'max_amount' AS max_amount`;

export function toStoredWorkflow(row: WorkflowRow): StoredWorkflow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    legalEntityId: row.legal_entity_id,
    resourceType: row.resource_type,
    code: row.code,
    name: row.name,
    version: row.version,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    publishedAt: row.published_at,
    conditions: parseStoredConditions(row.conditions, {
      minAmount: row.min_amount,
      maxAmount: row.max_amount,
    }),
    definition: parseDefinition(row.definition),
  };
}

/** The wire shape — money as strings, everything snake_case. */
export function presentWorkflow(w: StoredWorkflow): Record<string, unknown> {
  return {
    id: w.id,
    legal_entity_id: w.legalEntityId,
    resource_type: w.resourceType,
    code: w.code,
    name: w.name,
    version: w.version,
    valid_from: w.validFrom,
    valid_to: w.validTo,
    published_at: w.publishedAt,
    status: w.publishedAt === null ? 'DRAFT' : 'PUBLISHED',
    conditions: serializeConditions(w.conditions),
    definition: serializeDefinition(w.definition),
  };
}

export class ApprovalWorkflowService {
  constructor(private readonly pool: Pool) {}

  /**
   * A new workflow version. Unpublished, therefore not yet governing anything.
   *
   * The version number is allocated here rather than supplied: a caller who
   * chooses their own version can reuse one, and `UNIQUE (tenant_id,
   * resource_type, code, version)` would report that as a conflict long after
   * the user believed they had made an edit.
   */
  async create(principal: TenantPrincipal, input: CreateWorkflowInput) {
    const conditions = parseConditions(input.conditions ?? {});
    const definition = parseDefinition(input.definition);

    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      if (input.legalEntityId) {
        assertEntityPermission(principal, 'workflow.manage', input.legalEntityId);
      } else {
        assertPermission(principal, 'workflow.manage');
      }

      const { rows: existing } = await client.query<{ next: number }>(
        `SELECT coalesce(max(version), 0) + 1 AS next
           FROM approval_workflows
          WHERE tenant_id = $1 AND resource_type = $2 AND code = $3`,
        [principal.tenantId, input.resourceType, input.code],
      );
      const version = existing[0]?.next ?? 1;
      const id = uuidv7();
      const validFrom = input.validFrom ?? new Date().toISOString();

      const { rows } = await client.query<WorkflowRow>(
        `INSERT INTO approval_workflows
           (id, tenant_id, legal_entity_id, resource_type, code, name, version,
            valid_from, valid_to, conditions, definition)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::timestamptz,$10::jsonb,$11::jsonb)
         RETURNING id, tenant_id, legal_entity_id, resource_type, code, name, version,
                   valid_from, valid_to, published_at, conditions, definition,
                   conditions ->> 'min_amount' AS min_amount,
                   conditions ->> 'max_amount' AS max_amount`,
        [
          id,
          principal.tenantId,
          input.legalEntityId ?? null,
          input.resourceType,
          input.code,
          input.name,
          version,
          validFrom,
          input.validTo ?? null,
          JSON.stringify(serializeConditions(conditions)),
          JSON.stringify(serializeDefinition(definition)),
        ],
      );

      const stored = toStoredWorkflow(rows[0]!);
      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: input.legalEntityId ?? null,
        action: 'approval_workflow.created',
        resourceType: 'approval_workflow',
        resourceId: id,
        after: presentWorkflow(stored),
      });
      return presentWorkflow(stored);
    });
  }

  /**
   * Publish. From this instant the version governs new requests, and its
   * definition can never change again.
   */
  async publish(principal: TenantPrincipal, id: string) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      await client.query(`SELECT 1 FROM approval_workflows WHERE id = $1 FOR UPDATE`, [id]);
      const { rows } = await client.query<WorkflowRow>(
        `SELECT ${WORKFLOW_COLUMNS} FROM approval_workflows w WHERE w.id = $1`,
        [id],
      );
      const row = rows[0];
      assertTenantScope(principal, row, 'approval_workflow', id);
      const workflow = toStoredWorkflow(row!);

      if (workflow.legalEntityId) {
        assertEntityPermission(principal, 'workflow.manage', workflow.legalEntityId);
      } else {
        assertPermission(principal, 'workflow.manage');
      }

      // Idempotent: `x-idempotency: required` on this route means a retry must
      // return the same answer rather than a conflict.
      if (workflow.publishedAt !== null) return presentWorkflow(workflow);

      await assertApproversResolvable(client, principal.tenantId, workflow);

      const effectiveFrom = new Date(
        Math.max(new Date(workflow.validFrom).getTime(), Date.now()),
      ).toISOString();

      // Close the outgoing version at the instant this one starts. Without this
      // the exclusion constraint refuses the publish, and doc 14's "new changes
      // create a new version" would be unreachable after the first publish.
      const { rowCount: superseded } = await client.query(
        `UPDATE approval_workflows
            SET valid_to = $1::timestamptz
          WHERE tenant_id = $2 AND resource_type = $3 AND code = $4
            AND coalesce(legal_entity_id, '00000000-0000-0000-0000-000000000000'::uuid)
              = coalesce($5::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
            AND published_at IS NOT NULL
            AND id <> $6
            AND valid_from < $1::timestamptz
            AND (valid_to IS NULL OR valid_to > $1::timestamptz)`,
        [
          effectiveFrom,
          principal.tenantId,
          workflow.resourceType,
          workflow.code,
          workflow.legalEntityId,
          id,
        ],
      );

      const { rows: published } = await client.query<WorkflowRow>(
        `UPDATE approval_workflows
            SET published_at = now(), valid_from = $2::timestamptz
          WHERE id = $1
        RETURNING id, tenant_id, legal_entity_id, resource_type, code, name, version,
                  valid_from, valid_to, published_at, conditions, definition,
                  conditions ->> 'min_amount' AS min_amount,
                  conditions ->> 'max_amount' AS max_amount`,
        [id, effectiveFrom],
      );
      const result = toStoredWorkflow(published[0]!);

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: workflow.legalEntityId,
        action: 'approval_workflow.published',
        resourceType: 'approval_workflow',
        resourceId: id,
        before: { published_at: null },
        after: {
          published_at: result.publishedAt,
          version: result.version,
          superseded_versions: superseded,
        },
      });

      return {
        ...presentWorkflow(result),
        // Named in the response because it is the fact a caller most needs after
        // publishing: the previous version stopped governing NEW requests at this
        // instant, and requests already in flight under it did not move.
        superseded_versions: superseded,
      };
    });
  }

  async list(
    principal: TenantPrincipal,
    query: {
      resourceType?: string | undefined;
      code?: string | undefined;
      publishedOnly?: boolean | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const params: unknown[] = [principal.tenantId];
      const where: string[] = ['w.tenant_id = $1'];
      if (query.resourceType) {
        params.push(query.resourceType);
        where.push(`w.resource_type = $${params.length}`);
      }
      if (query.code) {
        params.push(query.code);
        where.push(`w.code = $${params.length}`);
      }
      if (query.publishedOnly) where.push('w.published_at IS NOT NULL');

      // A tenant-wide workflow (legal_entity_id NULL) governs every entity, so an
      // entity-restricted user must be able to see it; the scope filter applies
      // only to workflows that name an entity.
      const scope = entityScopeFilter(
        principal,
        { legalEntityId: 'w.legal_entity_id' },
        params.length + 1,
      );
      params.push(...scope.params);
      where.push(`(w.legal_entity_id IS NULL OR ${scope.sql})`);

      const { rows } = await client.query<WorkflowRow>(
        `SELECT ${WORKFLOW_COLUMNS}
           FROM approval_workflows w
          WHERE ${where.join(' AND ')}
          ORDER BY w.resource_type, w.code, w.version DESC`,
        params,
      );
      return { data: rows.map((r) => presentWorkflow(toStoredWorkflow(r))) };
    });
  }
}

/**
 * Every step must resolve to at least one person who could act.
 *
 * Checked at publish, because publish is the last moment anything can change.
 * A NAMED_USER must hold an active membership in this tenant — a user id from
 * another tenant is a perfectly valid uuid and `approval_steps.approver_user_id`
 * references the global `users` table, so nothing else would notice. A ROLE must
 * exist in this tenant and be held by somebody.
 */
async function assertApproversResolvable(
  client: PoolClient,
  tenantId: string,
  workflow: StoredWorkflow,
): Promise<void> {
  const problems: string[] = [];

  for (const step of workflow.definition.steps) {
    for (const approver of step.approvers as readonly ApproverSpec[]) {
      if (approver.resolvedFrom === 'NAMED_USER') {
        const { rows } = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n
             FROM memberships m
            WHERE m.tenant_id = $1 AND m.user_id = $2
              AND m.status = 'ACTIVE' AND m.suspended_at IS NULL
              AND ($3::uuid IS NULL OR m.legal_entity_id IS NULL OR m.legal_entity_id = $3)`,
          [tenantId, approver.userId, workflow.legalEntityId],
        );
        if (rows[0]?.n === '0') {
          problems.push(
            `step ${step.stepNo} names user ${approver.userId}, who has no active membership in ` +
              `this tenant` +
              (workflow.legalEntityId ? ` covering the workflow's legal entity` : ''),
          );
        }
      } else {
        const { rows } = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n
             FROM memberships m
             JOIN roles r ON r.id = m.role_id AND r.tenant_id = $1
            WHERE m.tenant_id = $1 AND m.role_id = $2
              AND m.status = 'ACTIVE' AND m.suspended_at IS NULL
              AND ($3::uuid IS NULL OR m.legal_entity_id IS NULL OR m.legal_entity_id = $3)`,
          [tenantId, approver.roleId, workflow.legalEntityId],
        );
        if (rows[0]?.n === '0') {
          problems.push(
            `step ${step.stepNo} resolves to role ${approver.roleId}, which nobody holds in this ` +
              `tenant` +
              (workflow.legalEntityId ? ` for the workflow's legal entity` : ''),
          );
        }
      }
    }
  }

  if (problems.length > 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Workflow ${workflow.code} v${workflow.version} cannot be published: ${problems.join('; ')}. ` +
        `A step that resolves to nobody parks every matching document in an approval state ` +
        `nobody can clear, so it is refused now rather than at the moment somebody needs one of ` +
        `those documents posted.`,
      { details: { problems } },
    );
  }
}

/**
 * The published workflow governing a document, or null.
 *
 * Selection is deterministic and stated here so it can be argued with:
 *   1. published, ACTIVE, and effective at `at` (the request instant);
 *   2. scoped to the document's entity, or tenant-wide;
 *   3. conditions satisfied — exact decimal comparison on the amount;
 *   4. of the survivors: an entity-specific workflow beats a tenant-wide one,
 *      then the more specific condition set, then the higher version.
 *
 * The exclusion constraint means (1)+(2) can only produce one row per code, so
 * step 4 only ever ranks DIFFERENT workflow codes against each other.
 */
export async function selectGoverningWorkflow(
  client: PoolClient,
  tenantId: string,
  resourceType: string,
  legalEntityId: string,
  at: Date,
): Promise<readonly StoredWorkflow[]> {
  const { rows } = await client.query<WorkflowRow>(
    `SELECT ${WORKFLOW_COLUMNS}
       FROM approval_workflows w
      WHERE w.tenant_id = $1
        AND w.resource_type = $2
        AND w.status = 'ACTIVE'
        AND w.published_at IS NOT NULL
        AND w.valid_from <= $3::timestamptz
        AND (w.valid_to IS NULL OR w.valid_to > $3::timestamptz)
        AND (w.legal_entity_id IS NULL OR w.legal_entity_id = $4)
      ORDER BY (w.legal_entity_id IS NOT NULL) DESC, w.version DESC`,
    [tenantId, resourceType, at.toISOString(), legalEntityId],
  );
  return rows.map(toStoredWorkflow);
}

export function workflowNotFound(id: string): AppError {
  return notFound('approval_workflow', id);
}
