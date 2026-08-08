/**
 * Users, invitations, roles and memberships.
 *
 * ADR-0005 draws the line this module lives on: `users` is platform-level and
 * `memberships` is the sole source of authorization scope. So "suspend a user" is
 * two different actions depending on who is asking — a tenant administrator
 * suspends the *membership*, and only a platform operator deactivates the person.
 * Conflating them would let one client lock a bookkeeper out of every other client.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { AppError, notFound, uuidv7 } from '@acct/domain';
import { PERMISSIONS, PERMISSION_DEFINITIONS } from '@acct/contracts';
import { publish, recordAudit } from '@acct/database';
import { DATABASE_POOL, API_ENV } from '../common/database.module';
import type { loadApiEnv } from '@acct/config';
import { readInTenant, writeInTenant } from '../common/db';
import { assertEntityPermission, entityScope, type TenantPrincipal } from '../common/principal';
import { issueOpaqueSecret } from '../auth/credentials';
import { SessionService } from '../auth/session.service';
import { assertVersion } from '../organization/organization.service';

@Injectable()
export class IamService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(API_ENV) private readonly env: ReturnType<typeof loadApiEnv>,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  /**
   * The people with a membership in this tenant.
   *
   * Scoped through `memberships`, never through `users`. A query over `users`
   * would list every person on the platform, which is the single most obvious way
   * a multi-tenant system leaks — and the leak is a customer list.
   */
  async listUsers(principal: TenantPrincipal) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT u.id, u.email::text AS email, u.display_name, u.status, u.mfa_enrolled,
                u.mfa_required, u.last_login_at, u.locale,
                json_agg(json_build_object(
                  'membership_id', m.id,
                  'role_id', m.role_id,
                  'role_code', r.code,
                  'organization_id', m.organization_id,
                  'legal_entity_id', m.legal_entity_id,
                  'branch_id', m.branch_id,
                  'status', m.status,
                  'suspended_at', m.suspended_at
                ) ORDER BY r.code) AS memberships
           FROM memberships m
           JOIN users u ON u.id = m.user_id
           JOIN roles r ON r.id = m.role_id
          WHERE m.tenant_id = $1
          GROUP BY u.id
          ORDER BY u.display_name
          LIMIT 500`,
        [principal.tenantId],
      );
      return { data: rows };
    });
  }

  /**
   * doc 02: "Invite/accept flow." This is the invite half; `acceptInvitation`
   * (F-604) is the other.
   *
   * The token is returned once, in the response, and only its SHA-256 is stored.
   * Phase 9 delivers the notification channel that mails it; until then returning
   * it is the difference between an invite flow that works and one that is
   * described in a document.
   */
  async inviteUser(
    principal: TenantPrincipal,
    input: {
      email: string;
      roleId: string;
      organizationId?: string | undefined;
      legalEntityId?: string | undefined;
      branchId?: string | undefined;
      expiresInDays?: number | undefined;
    },
  ) {
    if (input.legalEntityId) {
      // You cannot grant access to an entity you do not have access to. Without
      // this, entity-restricted administration is escalation by invitation.
      assertEntityPermission(principal, 'user.invite', input.legalEntityId);
    }

    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const role = await client.query<{ id: string; code: string; is_system: boolean }>(
        `SELECT id, code, is_system FROM roles WHERE id = $1 AND tenant_id = $2`,
        [input.roleId, principal.tenantId],
      );
      if (!role.rows[0]) throw notFound('Role', input.roleId);

      // Granting a role that holds permissions the inviter does not hold is
      // privilege escalation with extra steps. Checked here rather than trusted to
      // the UI, because the UI is not what an attacker uses.
      await this.assertCanGrantRole(principal, input.roleId);

      const token = issueOpaqueSecret(32);
      const expiresInDays = input.expiresInDays ?? 14;

      // One live invitation per address per tenant; re-inviting replaces rather
      // than accumulating, so two valid tokens for the same person never coexist.
      await client.query(
        `UPDATE user_invitations SET status = 'REVOKED', revoked_at = now()
          WHERE tenant_id = $1 AND email = $2 AND status = 'PENDING'`,
        [principal.tenantId, input.email],
      );

      const id = uuidv7();
      const { rows } = await client.query(
        `INSERT INTO user_invitations (id, tenant_id, email, role_id, organization_id,
                                       legal_entity_id, branch_id, token_hash, expires_at, invited_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(days => $9), $10)
         RETURNING id, email::text AS email, role_id, organization_id, legal_entity_id, branch_id,
                   status, expires_at`,
        [
          id,
          principal.tenantId,
          input.email,
          input.roleId,
          input.organizationId ?? null,
          input.legalEntityId ?? null,
          input.branchId ?? null,
          token.hash,
          expiresInDays,
          principal.userId,
        ],
      );

      await publish(client, context, {
        eventType: 'user.invited',
        aggregateType: 'user_invitation',
        aggregateId: id,
        tenantId: principal.tenantId,
        ...(input.organizationId ? { organizationId: input.organizationId } : {}),
        ...(input.legalEntityId ? { legalEntityId: input.legalEntityId } : {}),
        payload: { email: input.email, role_code: role.rows[0].code },
      });
      await recordAudit(client, context, {
        action: 'user.invited',
        resourceType: 'user_invitation',
        resourceId: id,
        tenantId: principal.tenantId,
        // The token is deliberately absent from the audit record. An audit trail is
        // read by more people than the invitation was ever meant for.
        after: { email: input.email, role_id: input.roleId, expires_in_days: expiresInDays },
      });

      return {
        ...rows[0]!,
        invitation_token: token.secret,
        accept_url: `${this.env.WEB_BASE_URL}/accept-invitation?token=${encodeURIComponent(token.secret)}`,
      };
    });
  }

  /**
   * Suspends the membership, not the person (ADR-0005).
   *
   * "Tenant suspension must not lock a user out of their other tenants." The
   * sessions bound to *this* tenant are revoked; sessions in other tenants are
   * untouched, which is what makes the accountant portal usable.
   */
  async setUserSuspension(principal: TenantPrincipal, userId: string, suspended: boolean) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows: memberships } = await client.query<{
        id: string;
        legal_entity_id: string | null;
      }>(
        `SELECT id, legal_entity_id FROM memberships
          WHERE user_id = $1 AND tenant_id = $2 FOR UPDATE`,
        [userId, principal.tenantId],
      );
      // Gate B: a user with no membership here is indistinguishable from one who
      // does not exist. Anything else is a directory of every account on the
      // platform, queryable one id at a time.
      if (memberships.length === 0) throw notFound('User', userId);

      for (const membership of memberships) {
        if (membership.legal_entity_id) {
          assertEntityPermission(principal, 'user.suspend', membership.legal_entity_id);
        }
      }
      if (userId === principal.userId && suspended) {
        throw new AppError(
          'VALIDATION_FAILED',
          'You cannot suspend your own access. Ask another administrator.',
        );
      }

      await client.query(
        `UPDATE memberships
            SET suspended_at = CASE WHEN $3::boolean THEN now() ELSE NULL END,
                status = CASE WHEN $3::boolean THEN 'INACTIVE'::record_status ELSE 'ACTIVE'::record_status END
          WHERE user_id = $1 AND tenant_id = $2`,
        [userId, principal.tenantId, suspended],
      );

      let revoked = 0;
      if (suspended) {
        // ADR-0005: "user.suspended must revoke live sessions". Scoped to this
        // tenant's sessions for the same reason the membership is.
        const result = await client.query(
          `UPDATE sessions
              SET revoked_at = now(), revoked_reason = 'membership suspended',
                  access_token_hash = NULL, refresh_token_hash = NULL
            WHERE user_id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
          [userId, principal.tenantId],
        );
        revoked = result.rowCount ?? 0;
      }

      await publish(client, context, {
        eventType: suspended ? 'user.suspended' : 'user.reactivated',
        aggregateType: 'user',
        aggregateId: userId,
        tenantId: principal.tenantId,
        payload: { sessions_revoked: revoked },
      });
      await recordAudit(client, context, {
        action: suspended ? 'user.suspended' : 'user.reactivated',
        resourceType: 'user',
        resourceId: userId,
        tenantId: principal.tenantId,
        after: { suspended, memberships: memberships.length, sessions_revoked: revoked },
      });

      return {
        id: userId,
        suspended,
        memberships_affected: memberships.length,
        sessions_revoked: revoked,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Roles and permissions
  // -------------------------------------------------------------------------

  /** The generated registry, served as ADR-0005 §3 describes. */
  listPermissions() {
    return {
      data: PERMISSIONS.map((code) => PERMISSION_DEFINITIONS[code]).map((p) => ({
        code: p.code,
        resource: p.resource,
        action: p.action,
        description: p.description,
        is_high_risk: p.isHighRisk,
        min_phase: p.minPhase,
      })),
      meta: {
        total: PERMISSIONS.length,
        high_risk: PERMISSIONS.filter((c) => PERMISSION_DEFINITIONS[c].isHighRisk).length,
        source: 'contracts/openapi.yaml (generated — ADR-0005 §3)',
      },
    };
  }

  async listRoles(principal: TenantPrincipal) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT r.id, r.code, r.name, r.description, r.is_system, r.status, r.created_at,
                coalesce(array_agg(rp.permission_code ORDER BY rp.permission_code)
                         FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions,
                (SELECT count(*) FROM memberships m WHERE m.role_id = r.id)::int AS member_count
           FROM roles r
           LEFT JOIN role_permissions rp ON rp.role_id = r.id
          WHERE r.tenant_id = $1
          GROUP BY r.id
          ORDER BY r.is_system DESC, r.code`,
        [principal.tenantId],
      );
      return { data: rows };
    });
  }

  async createRole(
    principal: TenantPrincipal,
    input: { code: string; name: string; description?: string | undefined; permissions: string[] },
  ) {
    this.assertPermissionsExist(input.permissions);
    this.assertNoEscalation(principal, input.permissions);

    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const id = uuidv7();
      const { rows } = await client.query(
        `INSERT INTO roles (id, tenant_id, code, name, description, is_system)
         VALUES ($1, $2, $3, $4, $5, false)
         RETURNING id, code, name, description, is_system, status`,
        [id, principal.tenantId, input.code, input.name, input.description ?? null],
      );
      if (input.permissions.length > 0) {
        await client.query(
          `INSERT INTO role_permissions (role_id, permission_code) SELECT $1, unnest($2::text[])`,
          [id, input.permissions],
        );
      }

      await publish(client, context, {
        eventType: 'role.changed',
        aggregateType: 'role',
        aggregateId: id,
        tenantId: principal.tenantId,
        payload: { code: input.code, change: 'created', permissions: input.permissions.length },
      });
      await recordAudit(client, context, {
        action: 'role.created',
        resourceType: 'role',
        resourceId: id,
        tenantId: principal.tenantId,
        after: { ...rows[0]!, permissions: input.permissions },
      });
      return { ...rows[0]!, permissions: input.permissions };
    });
  }

  async updateRole(
    principal: TenantPrincipal,
    roleId: string,
    ifMatch: string,
    input: { name?: string; description?: string | null; permissions?: string[] },
  ) {
    if (input.permissions) {
      this.assertPermissionsExist(input.permissions);
      this.assertNoEscalation(principal, input.permissions);
    }

    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows: locked } = await client.query<{
        id: string;
        code: string;
        name: string;
        description: string | null;
        is_system: boolean;
        permissions: string[];
        created_at: Date;
      }>(
        `SELECT r.id, r.code, r.name, r.description, r.is_system, r.created_at,
                coalesce(array_agg(rp.permission_code ORDER BY rp.permission_code)
                         FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions
           FROM roles r
           LEFT JOIN role_permissions rp ON rp.role_id = r.id
          WHERE r.id = $1 AND r.tenant_id = $2
          GROUP BY r.id
          FOR UPDATE OF r`,
        [roleId, principal.tenantId],
      );
      const before = locked[0];
      if (!before) throw notFound('Role', roleId);

      // `roles` has no version column, so the ETag is the row's content hash rather
      // than a counter. Same guarantee, and it does not need a migration to a table
      // whose shape the schema already fixed.
      assertVersion(roleEtag(before), ifMatch, 'Role', roleId);

      if (before.is_system && input.permissions) {
        // A system role is the tenant's copy of a template. Editing its permissions
        // is allowed — it is their tenant — but the role stops being a template, so
        // it is marked as such rather than silently diverging from the name.
        await client.query(`UPDATE roles SET is_system = false WHERE id = $1`, [roleId]);
      }

      await client.query(
        `UPDATE roles
            SET name = coalesce($2, name),
                description = CASE WHEN $3::boolean THEN $4 ELSE description END
          WHERE id = $1`,
        [roleId, input.name ?? null, input.description !== undefined, input.description ?? null],
      );

      if (input.permissions) {
        await client.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
        if (input.permissions.length > 0) {
          await client.query(
            `INSERT INTO role_permissions (role_id, permission_code) SELECT $1, unnest($2::text[])`,
            [roleId, input.permissions],
          );
        }
      }

      const { rows: afterRows } = await client.query(
        `SELECT r.id, r.code, r.name, r.description, r.is_system, r.status, r.created_at,
                coalesce(array_agg(rp.permission_code ORDER BY rp.permission_code)
                         FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions
           FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
          WHERE r.id = $1 GROUP BY r.id`,
        [roleId],
      );

      await publish(client, context, {
        eventType: 'permission.changed',
        aggregateType: 'role',
        aggregateId: roleId,
        tenantId: principal.tenantId,
        payload: { code: before.code, change: 'updated' },
      });
      await recordAudit(client, context, {
        action: 'role.changed',
        resourceType: 'role',
        resourceId: roleId,
        tenantId: principal.tenantId,
        before,
        after: afterRows[0]!,
      });
      return afterRows[0]!;
    });
  }

  // -------------------------------------------------------------------------
  // Memberships
  // -------------------------------------------------------------------------

  async listMemberships(principal: TenantPrincipal) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const scope = entityScope(principal);
      const where = ['m.tenant_id = $1'];
      const params: unknown[] = [principal.tenantId];
      if (scope.kind === 'ENTITIES') {
        // An entity-restricted administrator sees the memberships that touch their
        // entities plus the tenant-wide ones, and nothing about other entities.
        params.push(scope.legalEntityIds);
        where.push(
          `(m.legal_entity_id IS NULL OR m.legal_entity_id = ANY($${params.length}::uuid[]))`,
        );
      }
      const { rows } = await client.query(
        `SELECT m.id, m.user_id, u.display_name, u.email::text AS email, m.role_id, r.code AS role_code,
                m.organization_id, m.legal_entity_id, m.branch_id, m.status, m.suspended_at, m.created_at
           FROM memberships m
           JOIN users u ON u.id = m.user_id
           JOIN roles r ON r.id = m.role_id
          WHERE ${where.join(' AND ')}
          ORDER BY u.display_name, r.code
          LIMIT 500`,
        params,
      );
      return { data: rows };
    });
  }

  async createMembership(
    principal: TenantPrincipal,
    input: {
      userId: string;
      roleId: string;
      organizationId?: string | undefined;
      legalEntityId?: string | undefined;
      branchId?: string | undefined;
    },
  ) {
    if (input.legalEntityId) {
      assertEntityPermission(principal, 'role.manage', input.legalEntityId);
    }
    await this.assertCanGrantRole(principal, input.roleId);

    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const role = await client.query<{ code: string }>(
        `SELECT code FROM roles WHERE id = $1 AND tenant_id = $2`,
        [input.roleId, principal.tenantId],
      );
      if (!role.rows[0]) throw notFound('Role', input.roleId);

      // The user must already belong to this tenant. Adding a second membership is
      // ordinary; conjuring a first one from a user id would let anyone with
      // role.manage attach any account on the platform to their tenant.
      const member = await client.query(
        `SELECT 1 FROM memberships WHERE user_id = $1 AND tenant_id = $2 LIMIT 1`,
        [input.userId, principal.tenantId],
      );
      if (member.rows.length === 0) {
        throw new AppError(
          'NOT_FOUND',
          'That user is not a member of this tenant. Invite them instead — POST /users/invite.',
        );
      }

      const id = uuidv7();
      const { rows } = await client.query(
        `INSERT INTO memberships (id, tenant_id, user_id, role_id, organization_id,
                                  legal_entity_id, branch_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT ON CONSTRAINT memberships_uq DO NOTHING
         RETURNING id, user_id, role_id, organization_id, legal_entity_id, branch_id, status`,
        [
          id,
          principal.tenantId,
          input.userId,
          input.roleId,
          input.organizationId ?? null,
          input.legalEntityId ?? null,
          input.branchId ?? null,
        ],
      );
      if (!rows[0]) {
        throw new AppError(
          'DUPLICATE_SUSPECTED',
          'That user already holds this role at this scope.',
        );
      }

      await publish(client, context, {
        eventType: 'membership.created',
        aggregateType: 'membership',
        aggregateId: id,
        tenantId: principal.tenantId,
        ...(input.organizationId ? { organizationId: input.organizationId } : {}),
        ...(input.legalEntityId ? { legalEntityId: input.legalEntityId } : {}),
        payload: { user_id: input.userId, role_code: role.rows[0].code },
      });
      await recordAudit(client, context, {
        action: 'membership.created',
        resourceType: 'membership',
        resourceId: id,
        tenantId: principal.tenantId,
        ...(input.legalEntityId ? { legalEntityId: input.legalEntityId } : {}),
        after: rows[0]!,
      });
      return rows[0]!;
    });
  }

  // -------------------------------------------------------------------------
  // Escalation checks
  // -------------------------------------------------------------------------

  private assertPermissionsExist(permissions: readonly string[]): void {
    // ADR-0005: "A typo'd permission fails at seed time instead of silently
    // granting nothing." The same applies at role-edit time, and the failure mode
    // is worse here — the administrator believes they granted something.
    const known = new Set<string>(PERMISSIONS);
    const unknown = permissions.filter((p) => !known.has(p));
    if (unknown.length > 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Not permissions in this system: ${unknown.join(', ')}.`,
        {
          fieldErrors: unknown.map((p) => ({
            field: 'permissions',
            code: 'UNKNOWN_PERMISSION',
            message: p,
          })),
        },
      );
    }
  }

  /**
   * You cannot grant what you do not hold.
   *
   * Without this, `role.manage` is equivalent to every permission in the system:
   * create a role holding them all, assign it to yourself, done. doc 02 lists
   * "manage roles" among the high-risk permissions for exactly this reason, and
   * Gate F requires that segregation rules "cannot be bypassed by API".
   */
  private assertNoEscalation(principal: TenantPrincipal, permissions: readonly string[]): void {
    const held = new Set(principal.grants.flatMap((g) => [...g.permissions]));
    const escalating = permissions.filter((p) => !held.has(p));
    if (escalating.length > 0) {
      throw new AppError(
        'FORBIDDEN',
        `You cannot grant permissions you do not hold: ${escalating.slice(0, 5).join(', ')}` +
          `${escalating.length > 5 ? ` and ${escalating.length - 5} more` : ''}.`,
        { details: { escalating } },
      );
    }
  }

  private async assertCanGrantRole(principal: TenantPrincipal, roleId: string): Promise<void> {
    const { rows } = await this.pool.query<{ permission_code: string }>(
      `SELECT rp.permission_code
         FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
        WHERE rp.role_id = $1 AND r.tenant_id = $2`,
      [roleId, principal.tenantId],
    );
    this.assertNoEscalation(
      principal,
      rows.map((r) => r.permission_code),
    );
  }
}

/**
 * An ETag for a table with no version column.
 *
 * `roles` was specified without one, and adding a counter would be a schema change
 * to satisfy a header. The content hash gives the same guarantee — a concurrent
 * edit changes the content, so the precondition fails — without pretending the row
 * has a history it does not keep.
 */
export function roleEtag(role: {
  name: string;
  description: string | null;
  permissions: readonly string[];
}): string {
  const canonical = JSON.stringify([role.name, role.description, [...role.permissions].sort()]);
  let hash = 5381;
  for (let i = 0; i < canonical.length; i++) hash = ((hash * 33) ^ canonical.charCodeAt(i)) >>> 0;
  return `r${hash.toString(36)}`;
}
