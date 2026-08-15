/**
 * The auditor workspace — `createAuditRequest` and `listAuditRequests`
 * (contracts/openapi.yaml, phase 6).
 *
 * doc 12's auditor workspace is a request list with evidence attached to each
 * request, and the two routes are its read and its write. `audit.view` and
 * `audit.manage` are separate permissions on purpose: an external auditor reads
 * the workspace and the entity's own staff answer it.
 *
 * The list returns the evidence COUNT and the oldest unanswered age with each
 * request rather than only the request. A workspace that shows twenty OPEN rows
 * and no indication of which have evidence attached is a list somebody has to
 * open twenty times, and the one that has been open for ninety days looks exactly
 * like the one opened this morning.
 */

import type { Pool } from 'pg';
import {
  AppError,
  assertEntityPermission,
  assertPermission,
  buildPage,
  encodeCursor,
  entityScope,
  notFound,
  resolvePage,
  uuidv7,
  type TenantPrincipal,
} from '@acct/domain';
import { readInTenant, recordAudit, writeInTenant } from '@acct/database';

/** `audit_requests.status` — the CHECK in 0016, mirrored exactly. */
export const AUDIT_REQUEST_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'PROVIDED',
  'ACCEPTED',
  'CLOSED',
] as const;
export type AuditRequestStatus = (typeof AUDIT_REQUEST_STATUSES)[number];

export interface CreateAuditRequestInput {
  readonly legalEntityId: string;
  readonly accountingPeriodId?: string | null;
  readonly title: string;
  readonly description?: string | null;
  readonly ownerUserId?: string | null;
  readonly dueAt?: string | null;
}

export class AuditWorkspaceService {
  constructor(private readonly pool: Pool) {}

  async createAuditRequest(principal: TenantPrincipal, input: CreateAuditRequestInput) {
    if (input.title.trim() === '') {
      throw new AppError(
        'VALIDATION_FAILED',
        'An audit request needs a title. "Untitled" in an evidence log is a request nobody can ' +
          'answer and nobody can close.',
      );
    }

    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      assertEntityPermission(principal, 'audit.manage', input.legalEntityId);

      const { rows: entities } = await client.query<{ id: string }>(
        `SELECT id FROM legal_entities WHERE id = $1 AND tenant_id = $2`,
        [input.legalEntityId, principal.tenantId],
      );
      if (!entities[0]) throw notFound('Legal entity', input.legalEntityId);

      if (input.accountingPeriodId) {
        // 0050's aud_period_scope_fk enforces this; asking first turns a
        // foreign-key violation into a sentence that names the mismatch.
        const { rows: periods } = await client.query<{ legal_entity_id: string }>(
          `SELECT legal_entity_id FROM accounting_periods WHERE id = $1 AND tenant_id = $2`,
          [input.accountingPeriodId, principal.tenantId],
        );
        const period = periods[0];
        if (!period) throw notFound('Accounting period', input.accountingPeriodId);
        if (period.legal_entity_id !== input.legalEntityId) {
          throw new AppError(
            'CROSS_ENTITY_REFERENCE',
            `Accounting period ${input.accountingPeriodId} belongs to a different legal entity ` +
              `than this audit request. Evidence gathered against it would be another entity's.`,
          );
        }
      }

      if (input.ownerUserId) {
        const { rows: members } = await client.query<{ id: string }>(
          `SELECT u.id FROM users u
             JOIN memberships m ON m.user_id = u.id
            WHERE u.id = $1 AND m.tenant_id = $2
            LIMIT 1`,
          [input.ownerUserId, principal.tenantId],
        );
        if (!members[0]) {
          throw new AppError(
            'VALIDATION_FAILED',
            `User ${input.ownerUserId} is not a member of this tenant, so an audit request ` +
              `assigned to them would sit in nobody's inbox.`,
            { details: { owner_user_id: input.ownerUserId } },
          );
        }
      }

      const id = uuidv7();
      const { rows } = await client.query(
        `INSERT INTO audit_requests
           (id, tenant_id, legal_entity_id, accounting_period_id, title, description,
            requested_by, owner_user_id, status, due_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'OPEN',$9::timestamptz)
         RETURNING id, legal_entity_id, accounting_period_id, title, description, requested_by,
                   owner_user_id, status, due_at, created_at`,
        [
          id,
          principal.tenantId,
          input.legalEntityId,
          input.accountingPeriodId ?? null,
          input.title.trim(),
          input.description ?? null,
          principal.userId,
          input.ownerUserId ?? null,
          input.dueAt ?? null,
        ],
      );

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        action: 'audit_request.created',
        resourceType: 'audit_request',
        resourceId: id,
        legalEntityId: input.legalEntityId,
        after: rows[0] as Record<string, unknown>,
      });

      return rows[0];
    });
  }

  async listAuditRequests(
    principal: TenantPrincipal,
    query: {
      legalEntityId?: string | undefined;
      accountingPeriodId?: string | undefined;
      status?: string | undefined;
      ownerUserId?: string | undefined;
      openOnly?: boolean | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    },
  ) {
    if (query.status && !(AUDIT_REQUEST_STATUSES as readonly string[]).includes(query.status)) {
      throw new AppError(
        'VALIDATION_FAILED',
        `"${query.status}" is not an audit request status. The workspace uses ` +
          `${AUDIT_REQUEST_STATUSES.join(', ')}.`,
      );
    }
    const page = resolvePage({ cursor: query.cursor, limit: query.limit });

    return readInTenant(this.pool, principal, async ({ client }) => {
      assertPermission(principal, 'audit.view');

      const params: unknown[] = [principal.tenantId];
      const where = ['r.tenant_id = $1'];
      if (query.legalEntityId) {
        assertEntityPermission(principal, 'audit.view', query.legalEntityId);
        params.push(query.legalEntityId);
        where.push(`r.legal_entity_id = $${params.length}`);
      } else {
        const scope = entityScope(principal);
        if (scope.kind === 'ENTITIES') {
          params.push(scope.legalEntityIds);
          where.push(`r.legal_entity_id = ANY($${params.length}::uuid[])`);
        }
      }
      if (query.accountingPeriodId) {
        params.push(query.accountingPeriodId);
        where.push(`r.accounting_period_id = $${params.length}`);
      }
      if (query.status) {
        params.push(query.status);
        where.push(`r.status = $${params.length}`);
      }
      if (query.openOnly) {
        where.push(`r.status NOT IN ('ACCEPTED','CLOSED')`);
      }
      if (query.ownerUserId) {
        params.push(query.ownerUserId);
        where.push(`r.owner_user_id = $${params.length}`);
      }
      if (page.after) {
        params.push(page.after.k, page.after.id);
        where.push(
          `(r.created_at, r.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
        );
      }
      params.push(page.limit + 1);

      const { rows } = await client.query<{ id: string; created_at: string }>(
        `SELECT r.id, r.legal_entity_id, r.accounting_period_id, r.title, r.description,
                r.requested_by, r.owner_user_id, r.status, r.due_at,
                r.created_at::text AS created_at,
                p.name AS period_name,
                requester.display_name AS requested_by_name,
                owner.display_name AS owner_name,
                (SELECT count(*) FROM audit_evidence ev
                  WHERE ev.audit_request_id = r.id)::int AS evidence_count,
                (SELECT max(ev.provided_at) FROM audit_evidence ev
                  WHERE ev.audit_request_id = r.id) AS last_evidence_at,
                (r.due_at IS NOT NULL AND r.due_at < now()
                 AND r.status NOT IN ('ACCEPTED','CLOSED')) AS overdue,
                extract(day FROM now() - r.created_at)::int AS age_days
           FROM audit_requests r
           LEFT JOIN accounting_periods p ON p.id = r.accounting_period_id
           LEFT JOIN users requester ON requester.id = r.requested_by
           LEFT JOIN users owner ON owner.id = r.owner_user_id
          WHERE ${where.join(' AND ')}
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT $${params.length}`,
        params,
      );

      const built = buildPage(rows, page.limit, 'desc', (row) => ({
        k: row.created_at,
        id: row.id,
      }));
      const last = built.data[built.data.length - 1];
      return {
        data: built.data,
        meta: {
          has_more: built.meta.has_more,
          next_cursor:
            built.meta.has_more && last
              ? encodeCursor({ k: last.created_at, id: last.id, d: 'desc' })
              : null,
          limit: page.limit,
          limit_source: query.limit === undefined ? 'DEFAULT' : 'REQUEST',
        },
      };
    });
  }
}
