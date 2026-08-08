/**
 * Authentication, tenant selection, invitations and MFA.
 *
 * ADR-0005 shapes all of it: users are platform-level, tenancy comes only from
 * memberships, and login is two steps when a person belongs to more than one
 * tenant. The second step binds the tenant to the *session*, so the same
 * credential can be used in another tenant tomorrow without re-issuing anything.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { AppError, uuidv7, requireContext, type RequestContext } from '@acct/domain';
import { publish, recordAudit, withTransaction } from '@acct/database';
import type { loadApiEnv } from '@acct/config';
import { API_ENV, APP_LOGGER, DATABASE_POOL } from '../common/database.module';
import type { AppLogger } from '../common/logger';
import { withoutTenant } from '../common/db';
import { ROLE_TEMPLATES, permissionsFor } from '../iam/role-templates';
import { SessionService, type IssuedSession } from './session.service';
import {
  burnPasswordTime,
  encryptionKey,
  hashPassword,
  hashToken,
  issueOpaqueSecret,
  newTotpSecret,
  openSecret,
  sealSecret,
  splitToken,
  totpUri,
  verifyPassword,
  verifyTotp,
} from './credentials';

export interface LoginResult {
  readonly mfaRequired: boolean;
  readonly session?: IssuedSession;
  /** Present only while MFA is outstanding: the token to send back to /auth/mfa/verify. */
  readonly mfaToken?: string;
  readonly tenants: readonly { id: string; name: string; slug: string }[];
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  status: string;
  mfa_required: boolean;
  mfa_enrolled: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(API_ENV) private readonly env: ReturnType<typeof loadApiEnv>,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  // -------------------------------------------------------------------------
  // Sign up — F-603
  // -------------------------------------------------------------------------

  /**
   * Creates the first user, their tenant, the eleven system roles and the Owner
   * membership, in one transaction.
   *
   * doc 02's acceptance criterion is that "a new organization reaches posting-ready
   * status without direct DB work". Everything here is the part of that a person
   * with no account can do; the rest is the setup wizard.
   */
  async signUp(input: {
    email: string;
    password: string;
    displayName: string;
    tenantName: string;
    organizationName: string;
  }): Promise<{
    tenantId: string;
    organizationId: string;
    userId: string;
    session: IssuedSession;
  }> {
    const passwordHash = await hashPassword(input.password);
    const ctx = requireContext();

    return withoutTenant(this.pool, async ({ client }) => {
      const existing = await client.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [
        input.email,
      ]);
      if (existing.rows[0]) {
        // ADR-0005: one person, one row, across every tenant. Signing up again is
        // a different action — accept an invitation, or sign in and create a second
        // tenant — and saying so beats a generic conflict.
        throw new AppError(
          'DUPLICATE_SUSPECTED',
          'An account already exists for this email address. Sign in instead; the same identity ' +
            'works across every tenant you belong to.',
        );
      }

      const userId = uuidv7();
      await client.query(
        `INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)`,
        [userId, input.email, input.displayName, passwordHash],
      );

      const tenantId = uuidv7();
      const slug = await this.uniqueSlug(client, input.tenantName);
      await client.query(`INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)`, [
        tenantId,
        input.tenantName,
        slug,
      ]);

      const roleIds = await this.seedRoles(client, tenantId);
      const ownerRoleId = roleIds.get('owner')!;

      const organizationId = uuidv7();
      await client.query(`INSERT INTO organizations (id, tenant_id, name) VALUES ($1, $2, $3)`, [
        organizationId,
        tenantId,
        input.organizationName,
      ]);

      await client.query(
        `INSERT INTO memberships (tenant_id, user_id, role_id, organization_id)
         VALUES ($1, $2, $3, $4)`,
        [tenantId, userId, ownerRoleId, organizationId],
      );

      const scoped: RequestContext = { ...ctx, tenantId, actorId: userId, actorKind: 'USER' };
      await publish(client, scoped, {
        eventType: 'tenant.created',
        aggregateType: 'tenant',
        aggregateId: tenantId,
        tenantId,
        payload: { name: input.tenantName, slug },
      });
      await publish(client, scoped, {
        eventType: 'organization.created',
        aggregateType: 'organization',
        aggregateId: organizationId,
        tenantId,
        organizationId,
        payload: { name: input.organizationName },
      });
      await recordAudit(client, scoped, {
        action: 'tenant.created',
        resourceType: 'tenant',
        resourceId: tenantId,
        tenantId,
        after: { name: input.tenantName, slug, owner: input.email },
      });

      const session = await this.sessions.create(client, {
        userId,
        tenantId,
        mfaSatisfied: false,
      });

      return { tenantId, organizationId, userId, session };
    });
  }

  /** Slugs are citext-unique per tenant table; a collision is a retry, not an error. */
  private async uniqueSlug(client: PoolClient, name: string): Promise<string> {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'tenant';
    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const { rows } = await client.query(`SELECT 1 FROM tenants WHERE slug = $1`, [candidate]);
      if (rows.length === 0) return candidate;
    }
    return `${base}-${uuidv7().slice(0, 8)}`;
  }

  /**
   * Creates the eleven system roles for a new tenant.
   *
   * Materialised per tenant rather than shared, because `roles.tenant_id` is NOT
   * NULL and a tenant must be able to edit its own copy of a template without
   * changing everybody else's. The template is the starting point, not a live link.
   */
  async seedRoles(client: PoolClient, tenantId: string): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    for (const template of ROLE_TEMPLATES) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO roles (tenant_id, code, name, description, is_system)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [tenantId, template.code, template.name, template.description],
      );
      const roleId = rows[0]!.id;
      ids.set(template.code, roleId);

      const permissions = permissionsFor(template);
      if (permissions.length > 0) {
        await client.query(
          `INSERT INTO role_permissions (role_id, permission_code)
           SELECT $1, unnest($2::text[])
           ON CONFLICT DO NOTHING`,
          [roleId, permissions],
        );
      }
    }
    return ids;
  }

  // -------------------------------------------------------------------------
  // Login
  // -------------------------------------------------------------------------

  async login(input: {
    email: string;
    password: string;
    ipAddress?: string | undefined;
    userAgent?: string | undefined;
  }): Promise<LoginResult> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT id, email, display_name, password_hash, status, mfa_required, mfa_enrolled
         FROM users WHERE email = $1`,
      [input.email],
    );
    const user = rows[0];

    // Same work and the same message whether the address is unknown or the
    // password is wrong. Otherwise response time and wording between them turn
    // this route into an account-enumeration oracle.
    if (!user?.password_hash) {
      await burnPasswordTime();
      throw new AppError('UNAUTHENTICATED', 'Email address or password is incorrect.');
    }
    const ok = await verifyPassword(input.password, user.password_hash);
    if (!ok) throw new AppError('UNAUTHENTICATED', 'Email address or password is incorrect.');
    if (user.status !== 'ACTIVE') {
      throw new AppError('UNAUTHENTICATED', 'This account is not active.');
    }

    const tenants = await this.tenantsFor(user.id);
    // ADR-0005: bound automatically when there is only one, because a mandatory
    // selection step with one option is a step nobody understands.
    const tenantId = tenants.length === 1 ? tenants[0]!.id : null;
    const mfaRequired = user.mfa_required || user.mfa_enrolled;

    const session = await withoutTenant(this.pool, async ({ client }) => {
      const issued = await this.sessions.create(client, {
        userId: user.id,
        tenantId,
        mfaSatisfied: !mfaRequired,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });
      await client.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
      return issued;
    });

    this.logger.info(
      { user_id: user.id, tenant_id: tenantId, mfa_required: mfaRequired },
      'login succeeded',
    );

    if (mfaRequired) {
      // Only the access token comes back, and only as `mfa_token`. Handing over a
      // refresh token before the second factor would make the second factor
      // optional for anyone who kept the response.
      return { mfaRequired: true, mfaToken: session.accessToken, tenants };
    }
    return { mfaRequired: false, session, tenants };
  }

  async tenantsFor(userId: string): Promise<{ id: string; name: string; slug: string }[]> {
    const { rows } = await this.pool.query<{ id: string; name: string; slug: string }>(
      `SELECT DISTINCT t.id, t.name, t.slug::text AS slug
         FROM memberships m
         JOIN tenants t ON t.id = m.tenant_id
        WHERE m.user_id = $1 AND m.status = 'ACTIVE' AND m.suspended_at IS NULL
          AND t.status = 'ACTIVE'
        ORDER BY t.name`,
      [userId],
    );
    return rows;
  }

  /** The second step of ADR-0005's login flow. */
  async selectTenant(
    principal: { userId: string; sessionId: string },
    tenantId: string,
  ): Promise<void> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM memberships m JOIN tenants t ON t.id = m.tenant_id
        WHERE m.user_id = $1 AND m.tenant_id = $2
          AND m.status = 'ACTIVE' AND m.suspended_at IS NULL AND t.status = 'ACTIVE'
        LIMIT 1`,
      [principal.userId, tenantId],
    );
    // NOT_FOUND, not FORBIDDEN: a tenant the caller has no membership in must be
    // indistinguishable from one that does not exist (Gate B).
    if (rows.length === 0) throw new AppError('NOT_FOUND', 'No such tenant for this account.');

    await withoutTenant(this.pool, async ({ client }) => {
      await this.sessions.bindTenant(client, principal.sessionId, tenantId);
    });
  }

  // -------------------------------------------------------------------------
  // MFA
  // -------------------------------------------------------------------------

  /**
   * Starts TOTP enrolment and returns the provisioning URI.
   *
   * The factor stays unconfirmed until a code from it verifies, so a half-finished
   * enrolment cannot lock anyone out.
   */
  async beginEnrolment(userId: string, account: string): Promise<{ uri: string; secret: string }> {
    const key = encryptionKey(this.env.MFA_ENCRYPTION_KEY);
    const secret = newTotpSecret();
    const sealed = sealSecret(secret, key);

    await withoutTenant(this.pool, async ({ client }) => {
      // One pending enrolment at a time; restarting replaces it.
      await client.query(`DELETE FROM mfa_factors WHERE user_id = $1 AND confirmed_at IS NULL`, [
        userId,
      ]);
      await client.query(
        `INSERT INTO mfa_factors (user_id, kind, secret_ciphertext, secret_nonce, secret_auth_tag)
         VALUES ($1, 'TOTP', $2, $3, $4)`,
        [userId, sealed.ciphertext, sealed.nonce, sealed.authTag],
      );
    });

    return {
      uri: totpUri(secret, account, 'Accounting Platform'),
      secret: Buffer.from(secret).toString('base64'),
    };
  }

  /**
   * Verifies a TOTP code.
   *
   * Handles both cases with the same code path, because they are the same check:
   * confirming a new factor, and satisfying MFA on a session that has one.
   */
  async verifyMfa(input: {
    mfaToken: string;
    code: string;
    recoveryCode?: string | undefined;
  }): Promise<{ session: IssuedSession; userId: string }> {
    const parts = splitToken(input.mfaToken);
    if (!parts) throw new AppError('UNAUTHENTICATED', 'The MFA token is not valid.');

    return withoutTenant(this.pool, async ({ client }) => {
      const { rows: sessionRows } = await client.query<{
        id: string;
        user_id: string;
        tenant_id: string | null;
        access_token_hash: string | null;
        expires_at: Date;
        revoked_at: Date | null;
      }>(
        `SELECT id, user_id, tenant_id, access_token_hash, expires_at, revoked_at
           FROM sessions WHERE id = $1 FOR UPDATE`,
        [parts.sessionId],
      );
      const session = sessionRows[0];
      if (
        !session ||
        session.revoked_at ||
        session.expires_at <= new Date() ||
        session.access_token_hash !== hashToken(parts.secret)
      ) {
        throw new AppError('UNAUTHENTICATED', 'The MFA token is not valid.');
      }

      const verified = input.recoveryCode
        ? await this.consumeRecoveryCode(client, session.user_id, input.recoveryCode)
        : await this.consumeTotp(client, session.user_id, input.code);
      if (!verified) throw new AppError('UNAUTHENTICATED', 'That code is not valid.');

      await client.query(
        `UPDATE users SET mfa_enrolled = true WHERE id = $1 AND mfa_enrolled = false`,
        [session.user_id],
      );

      // A new pair, so the mfa_token cannot be replayed as a session token.
      const issued = await this.sessions.create(client, {
        userId: session.user_id,
        tenantId: session.tenant_id,
        mfaSatisfied: true,
      });
      await this.sessions.revoke(client, session.id, 'superseded by MFA verification');

      return { session: issued, userId: session.user_id };
    });
  }

  private async consumeTotp(client: PoolClient, userId: string, code: string): Promise<boolean> {
    const key = encryptionKey(this.env.MFA_ENCRYPTION_KEY);
    const { rows } = await client.query<{
      id: string;
      secret_ciphertext: Buffer;
      secret_nonce: Buffer;
      secret_auth_tag: Buffer;
      last_used_step: string | null;
    }>(
      `SELECT id, secret_ciphertext, secret_nonce, secret_auth_tag, last_used_step
         FROM mfa_factors WHERE user_id = $1 AND kind = 'TOTP'
        ORDER BY confirmed_at NULLS LAST, created_at DESC
        FOR UPDATE`,
      [userId],
    );

    for (const factor of rows) {
      const secret = openSecret(
        {
          ciphertext: factor.secret_ciphertext,
          nonce: factor.secret_nonce,
          authTag: factor.secret_auth_tag,
        },
        key,
      );
      const step = verifyTotp(secret, code, {
        lastUsedStep: factor.last_used_step === null ? null : Number(factor.last_used_step),
      });
      if (step === null) continue;

      // The step is recorded, not just the timestamp: a TOTP code is valid for its
      // whole window, so without this a code seen in transit works again until the
      // window closes.
      await client.query(
        `UPDATE mfa_factors
            SET confirmed_at = coalesce(confirmed_at, now()), last_used_at = now(), last_used_step = $2
          WHERE id = $1`,
        [factor.id, step],
      );
      return true;
    }
    return false;
  }

  private async consumeRecoveryCode(
    client: PoolClient,
    userId: string,
    code: string,
  ): Promise<boolean> {
    const { rowCount } = await client.query(
      `UPDATE mfa_recovery_codes SET used_at = now()
        WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
      [userId, hashToken(code.trim())],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Ten single-use codes, shown once. Only their hashes are kept. */
  async issueRecoveryCodes(userId: string): Promise<string[]> {
    const codes = Array.from({ length: 10 }, () => issueOpaqueSecret(10));
    await withoutTenant(this.pool, async ({ client }) => {
      await client.query(`DELETE FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL`, [
        userId,
      ]);
      await client.query(
        `INSERT INTO mfa_recovery_codes (user_id, code_hash)
         SELECT $1, unnest($2::text[])`,
        [userId, codes.map((c) => c.hash)],
      );
    });
    return codes.map((c) => c.secret);
  }

  async availableFactors(mfaToken: string): Promise<{ kinds: string[]; recoveryCodes: number }> {
    const parts = splitToken(mfaToken);
    if (!parts) throw new AppError('UNAUTHENTICATED', 'The MFA token is not valid.');
    const { rows } = await this.pool.query<{ kind: string; recovery: string }>(
      `SELECT f.kind,
              (SELECT count(*) FROM mfa_recovery_codes rc
                WHERE rc.user_id = s.user_id AND rc.used_at IS NULL)::text AS recovery
         FROM sessions s
         LEFT JOIN mfa_factors f ON f.user_id = s.user_id AND f.confirmed_at IS NOT NULL
        WHERE s.id = $1 AND s.access_token_hash = $2 AND s.revoked_at IS NULL`,
      [parts.sessionId, hashToken(parts.secret)],
    );
    if (rows.length === 0) throw new AppError('UNAUTHENTICATED', 'The MFA token is not valid.');
    return {
      kinds: rows.map((r) => r.kind).filter((k): k is string => Boolean(k)),
      recoveryCodes: Number(rows[0]!.recovery),
    };
  }

  // -------------------------------------------------------------------------
  // Invitations — F-604
  // -------------------------------------------------------------------------

  async acceptInvitation(input: {
    token: string;
    displayName?: string | undefined;
    password?: string | undefined;
  }): Promise<{ tenantId: string; userId: string; session: IssuedSession }> {
    const tokenHash = hashToken(input.token.trim());
    const ctx = requireContext();

    return withTransaction(this.pool, async ({ client }) => {
      const { rows } = await client.query<{
        id: string;
        tenant_id: string;
        email: string;
        role_id: string;
        organization_id: string | null;
        legal_entity_id: string | null;
        branch_id: string | null;
        status: string;
        expires_at: Date;
      }>(
        `SELECT id, tenant_id, email::text AS email, role_id, organization_id, legal_entity_id,
                branch_id, status, expires_at
           FROM user_invitations WHERE token_hash = $1 FOR UPDATE`,
        [tokenHash],
      );
      const invitation = rows[0];
      if (!invitation) throw new AppError('NOT_FOUND', 'This invitation is not valid.');
      if (invitation.status !== 'PENDING') {
        throw new AppError(
          'VALIDATION_FAILED',
          `This invitation was already ${invitation.status.toLowerCase()}.`,
        );
      }
      if (invitation.expires_at <= new Date()) {
        await client.query(`UPDATE user_invitations SET status = 'EXPIRED' WHERE id = $1`, [
          invitation.id,
        ]);
        throw new AppError('VALIDATION_FAILED', 'This invitation has expired. Ask for a new one.');
      }

      // ADR-0005: one person, one row. An accountant invited by a second client
      // attaches their existing identity rather than creating a parallel account.
      const existing = await client.query<{ id: string; password_hash: string | null }>(
        `SELECT id, password_hash FROM users WHERE email = $1`,
        [invitation.email],
      );
      let userId = existing.rows[0]?.id;

      if (!userId) {
        if (!input.password || !input.displayName) {
          throw new AppError(
            'VALIDATION_FAILED',
            'This invitation is for a new account; a name and a password are required.',
            {
              fieldErrors: [
                { field: 'password', code: 'REQUIRED', message: 'required for a new account' },
                { field: 'display_name', code: 'REQUIRED', message: 'required for a new account' },
              ],
            },
          );
        }
        userId = uuidv7();
        await client.query(
          `INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)`,
          [userId, invitation.email, input.displayName, await hashPassword(input.password)],
        );
      }

      await client.query(
        `INSERT INTO memberships (tenant_id, user_id, role_id, organization_id, legal_entity_id, branch_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT ON CONSTRAINT memberships_uq DO NOTHING`,
        [
          invitation.tenant_id,
          userId,
          invitation.role_id,
          invitation.organization_id,
          invitation.legal_entity_id,
          invitation.branch_id,
        ],
      );
      await client.query(
        `UPDATE user_invitations SET status = 'ACCEPTED', accepted_at = now(), accepted_user_id = $2
          WHERE id = $1`,
        [invitation.id, userId],
      );

      const scoped: RequestContext = {
        ...ctx,
        tenantId: invitation.tenant_id,
        actorId: userId,
        actorKind: 'USER',
      };
      await publish(client, scoped, {
        eventType: 'membership.created',
        aggregateType: 'membership',
        aggregateId: invitation.id,
        tenantId: invitation.tenant_id,
        ...(invitation.organization_id ? { organizationId: invitation.organization_id } : {}),
        ...(invitation.legal_entity_id ? { legalEntityId: invitation.legal_entity_id } : {}),
        payload: { user_id: userId, role_id: invitation.role_id, via: 'invitation' },
      });
      await recordAudit(client, scoped, {
        action: 'membership.created',
        resourceType: 'membership',
        resourceId: invitation.id,
        tenantId: invitation.tenant_id,
        after: { user_id: userId, role_id: invitation.role_id, invitation_id: invitation.id },
      });

      const session = await this.sessions.create(client, {
        userId,
        tenantId: invitation.tenant_id,
        mfaSatisfied: false,
      });
      return { tenantId: invitation.tenant_id, userId, session };
    });
  }
}
