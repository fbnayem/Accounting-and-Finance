import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { Pool } from 'pg';
import { z } from 'zod';
import { AppError, notFound, uuidv7 } from '@acct/domain';
import { publish, recordAudit, withTransaction } from '@acct/database';
import { DATABASE_POOL } from '../common/database.module';
import { Operation } from '../common/operation';
import { parse, reason as reasonField, uuid } from '../common/validation';
import type { AuthenticatedRequest } from '../common/auth.guard';
import { contextFor } from '../common/db';
import type { Principal } from '../common/principal';

/**
 * doc 23's SaaS administration surface. The operator's, never the customer's.
 *
 * These are the only routes in the system that are deliberately cross-tenant, and
 * the permissions that reach them (`platform.*`) are excluded from all eleven role
 * templates by a test. There is no API path that grants them: `assertNoEscalation`
 * refuses to grant a permission the granter does not hold, and nobody holds these
 * to begin with. The first platform operator is created by an operations runbook
 * against the database, which is the correct amount of friction for an account that
 * can suspend a customer.
 */
const SuspendTenantBody = z.object({ reason: reasonField });
const SupportGrantBody = z.object({
  tenant_id: uuid,
  reason: reasonField,
  permissions: z.array(z.string().min(1)).min(1).max(50),
  expires_in_hours: z.number().int().min(1).max(72).default(8),
});

@Controller()
export class PlatformController {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  @Get('admin/tenants')
  @Operation('adminListTenants')
  async listTenants(@Query() query: unknown) {
    const parsed = parse(
      z.object({
        status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      query,
    );
    const { rows } = await this.pool.query(
      `SELECT t.id, t.name, t.slug::text AS slug, t.status, t.data_region,
              t.ai_processing_enabled, t.suspended_at, t.created_at,
              (SELECT count(*) FROM memberships m WHERE m.tenant_id = t.id)::int AS member_count,
              (SELECT count(*) FROM legal_entities le WHERE le.tenant_id = t.id)::int AS entity_count
         FROM tenants t
        WHERE ($1::record_status IS NULL OR t.status = $1::record_status)
        ORDER BY t.created_at DESC
        LIMIT $2`,
      [parsed.status ?? null, parsed.limit],
    );
    return { data: rows };
  }

  @Post('admin/tenants/:id/suspend')
  @Operation('adminSuspendTenant')
  async suspendTenant(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(SuspendTenantBody, body);
    return this.setTenantStatus(request.principal!, parse(uuid, id), true, input.reason);
  }

  @Post('admin/tenants/:id/reactivate')
  @Operation('adminReactivateTenant')
  async reactivateTenant(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(SuspendTenantBody.partial({ reason: true }), body ?? {});
    return this.setTenantStatus(
      request.principal!,
      parse(uuid, id),
      false,
      input.reason ?? 'reactivated',
    );
  }

  private async setTenantStatus(
    principal: Principal,
    tenantId: string,
    suspended: boolean,
    reason: string,
  ) {
    return withTransaction(
      this.pool,
      async ({ client, context }) => {
        const { rows } = await client.query<{ id: string; name: string; status: string }>(
          `SELECT id, name, status FROM tenants WHERE id = $1 FOR UPDATE`,
          [tenantId],
        );
        const tenant = rows[0];
        if (!tenant) throw notFound('Tenant', tenantId);

        await client.query(
          `UPDATE tenants
              SET status = $2::record_status,
                  suspended_at = CASE WHEN $3::boolean THEN now() ELSE NULL END
            WHERE id = $1`,
          [tenantId, suspended ? 'INACTIVE' : 'ACTIVE', suspended],
        );

        let revoked = 0;
        if (suspended) {
          // doc 23 is explicit that a subscription ending must never destroy
          // accounting records. Suspension therefore ends sessions and nothing
          // else — the data stays, and reactivation restores access rather than
          // recovering anything.
          const result = await client.query(
            `UPDATE sessions
                SET revoked_at = now(), revoked_reason = 'tenant suspended',
                    access_token_hash = NULL, refresh_token_hash = NULL
              WHERE tenant_id = $1 AND revoked_at IS NULL`,
            [tenantId],
          );
          revoked = result.rowCount ?? 0;
        }

        await publish(
          client,
          { ...context, tenantId },
          {
            eventType: suspended ? 'tenant.suspended' : 'tenant.reactivated',
            aggregateType: 'tenant',
            aggregateId: tenantId,
            tenantId,
            payload: { reason, sessions_revoked: revoked },
          },
        );
        await recordAudit(
          client,
          { ...context, tenantId },
          {
            action: suspended ? 'tenant.suspended' : 'tenant.reactivated',
            resourceType: 'tenant',
            resourceId: tenantId,
            tenantId,
            reason,
            before: { status: tenant.status },
            after: { status: suspended ? 'INACTIVE' : 'ACTIVE', sessions_revoked: revoked },
          },
        );

        return {
          id: tenantId,
          status: suspended ? 'INACTIVE' : 'ACTIVE',
          sessions_revoked: revoked,
        };
      },
      { context: { ...contextFor(principal), tenantId } },
    );
  }

  @Get('admin/feature-flags')
  @Operation('listFeatureFlags')
  async listFeatureFlags(@Query() query: unknown) {
    // doc 21 Phase 0 build list: "Feature flags/configuration framework". Phase 0
    // created the tables and the route was never mounted, which the boot-time
    // contract reconciliation found the first time it ran.
    const parsed = parse(z.object({ tenant_id: uuid.optional() }), query);
    const { rows } = await this.pool.query(
      `SELECT f.code, f.description, f.default_enabled,
              coalesce(json_agg(json_build_object(
                'tenant_id', o.tenant_id,
                'enabled', o.enabled,
                'reason', o.reason,
                'set_at', o.set_at
              ) ORDER BY o.set_at DESC) FILTER (WHERE o.tenant_id IS NOT NULL), '[]') AS overrides
         FROM feature_flags f
         LEFT JOIN feature_flag_overrides o
                ON o.feature_flag_id = f.id
               AND ($1::uuid IS NULL OR o.tenant_id = $1)
        GROUP BY f.id
        ORDER BY f.code`,
      [parsed.tenant_id ?? null],
    );
    return { data: rows };
  }

  @Get('admin/entitlements')
  @Operation('listEntitlements')
  async listEntitlements(@Query() query: unknown) {
    const parsed = parse(z.object({ tenant_id: uuid.optional() }), query);
    const { rows } = await this.pool.query(
      `SELECT s.tenant_id, t.name AS tenant_name, p.code AS plan_code, pv.version AS plan_version,
              s.status, s.trial_ends_at, s.restriction_policy,
              coalesce(json_agg(json_build_object(
                'capability', e.capability,
                'enabled', e.enabled,
                'limit_value', e.limit_value::text,
                'limit_unit', e.limit_unit
              ) ORDER BY e.capability) FILTER (WHERE e.id IS NOT NULL), '[]') AS entitlements
         FROM subscriptions s
         JOIN tenants t ON t.id = s.tenant_id
         JOIN plan_versions pv ON pv.id = s.plan_version_id
         JOIN plans p ON p.id = pv.plan_id
         LEFT JOIN entitlements e ON e.plan_version_id = pv.id
        WHERE ($1::uuid IS NULL OR s.tenant_id = $1)
        GROUP BY s.tenant_id, t.name, p.code, pv.version, s.status, s.trial_ends_at, s.restriction_policy
        ORDER BY t.name
        LIMIT 200`,
      [parsed.tenant_id ?? null],
    );
    return { data: rows };
  }

  @Post('admin/support-grants')
  @Operation('createSupportGrant')
  async createSupportGrant(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(SupportGrantBody, body);
    const principal = request.principal!;

    return withTransaction(
      this.pool,
      async ({ client, context }) => {
        const tenant = await client.query<{ id: string }>(`SELECT id FROM tenants WHERE id = $1`, [
          input.tenant_id,
        ]);
        if (!tenant.rows[0]) throw notFound('Tenant', input.tenant_id);

        const id = uuidv7();
        const { rows } = await client.query(
          `INSERT INTO support_access_grants (id, tenant_id, support_user_id, reason,
                                              granted_permissions, valid_to)
           VALUES ($1,$2,$3,$4,$5, now() + make_interval(hours => $6))
           RETURNING id, tenant_id, support_user_id, reason, granted_permissions,
                     valid_from, valid_to`,
          [
            id,
            input.tenant_id,
            principal.userId,
            input.reason,
            input.permissions,
            input.expires_in_hours,
          ],
        );

        // doc 23: support access is time-boxed and audited on both sides. The
        // audit row is written into the *customer's* trail, not only the
        // operator's, because it is their data that was reachable.
        await recordAudit(
          client,
          { ...context, tenantId: input.tenant_id },
          {
            action: 'support_grant.created',
            resourceType: 'support_access_grant',
            resourceId: id,
            tenantId: input.tenant_id,
            reason: input.reason,
            after: {
              granted_to: principal.userId,
              permissions: input.permissions,
              expires_in_hours: input.expires_in_hours,
            },
          },
        );
        return rows[0]!;
      },
      { context: { ...contextFor(principal), tenantId: input.tenant_id } },
    );
  }
}

/**
 * The audit trail, read back.
 *
 * Tenant-scoped and permission-gated, unlike everything else in this file. It lives
 * here because `GET /audit-events` is the only phase-1 route on the Audit tag, and
 * a module of one controller for it would be filing rather than structure.
 */
@Controller()
export class AuditController {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  @Get('audit-events')
  @Operation('listAuditEvents')
  async list(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const principal = request.principal!;
    if (!principal.tenantId) {
      throw new AppError('TENANT_MISMATCH', 'No tenant is selected for this session.');
    }
    const parsed = parse(
      z.object({
        resource_type: z.string().trim().max(60).optional(),
        resource_id: z.string().trim().max(64).optional(),
        actor_id: z.string().trim().max(64).optional(),
        action: z.string().trim().max(60).optional(),
        since: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before_id: z.coerce.number().int().positive().optional(),
      }),
      query,
    );

    const where = ['a.tenant_id = $1'];
    const params: unknown[] = [principal.tenantId];
    const add = (sql: string, value: unknown): void => {
      params.push(value);
      where.push(sql.replace('$n', `$${params.length}`));
    };
    if (parsed.resource_type) add('a.resource_type = $n', parsed.resource_type);
    if (parsed.resource_id) add('a.resource_id = $n', parsed.resource_id);
    if (parsed.actor_id) add('a.actor_id = $n', parsed.actor_id);
    if (parsed.action) add('a.action = $n', parsed.action);
    if (parsed.since) add('a.occurred_at >= $n::timestamptz', parsed.since);
    // The audit log is append-only with a monotonic bigserial id, so paging on the
    // id is exact and needs no cursor encoding: nothing is ever inserted behind you.
    if (parsed.before_id) add('a.id < $n', parsed.before_id);
    params.push(parsed.limit);

    const { rows } = await this.pool.query(
      `SELECT a.id::text AS id, a.action, a.resource_type, a.resource_id, a.actor_kind, a.actor_id,
              a.impersonated_by, a.occurred_at, a.correlation_id, host(a.ip_address) AS ip_address,
              a.reason, a.before_data, a.after_data, a.legal_entity_id, a.row_hash
         FROM audit_events a
        WHERE ${where.join(' AND ')}
        ORDER BY a.id DESC
        LIMIT $${params.length}`,
      params,
    );

    return {
      data: rows,
      meta: {
        next_before_id: rows.length === parsed.limit ? rows[rows.length - 1]!.id : null,
        // F-043: the chain is what makes "immutable" checkable rather than claimed.
        hash_chained: true,
      },
    };
  }
}
