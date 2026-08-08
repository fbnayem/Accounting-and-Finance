/**
 * Sessions: minting, resolving, rotating, revoking.
 *
 * ADR-0005 §2 makes sessions first-class and revocable, and doc 02's acceptance
 * criterion is that "a suspended user loses active access". Both are satisfied the
 * same way: the session row is read on every request, so revoking it takes effect
 * on the next one rather than at token expiry.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { AppError } from '@acct/domain';
import { DATABASE_POOL, API_ENV } from '../common/database.module';
import type { loadApiEnv } from '@acct/config';
import type { Grant, Principal } from '../common/principal';
import { issueToken, splitToken, tokenMatches } from './credentials';

interface SessionRow {
  id: string;
  user_id: string;
  tenant_id: string | null;
  access_token_hash: string | null;
  access_expires_at: Date | null;
  refresh_token_hash: string | null;
  refresh_expires_at: Date | null;
  expires_at: Date;
  revoked_at: Date | null;
  mfa_satisfied: boolean;
  mfa_verified_at: Date | null;
  email: string;
  display_name: string;
  user_status: string;
  mfa_required: boolean;
}

interface GrantRow {
  membership_id: string;
  role_id: string;
  role_code: string;
  organization_id: string | null;
  legal_entity_id: string | null;
  branch_id: string | null;
  permissions: string[];
}

export interface IssuedSession {
  readonly sessionId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: Date;
  readonly refreshExpiresAt: Date;
  readonly tenantId: string | null;
  readonly mfaRequired: boolean;
}

@Injectable()
export class SessionService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(API_ENV) private readonly env: ReturnType<typeof loadApiEnv>,
  ) {}

  /**
   * Creates a session and returns both tokens.
   *
   * `tenantId` is null when the user belongs to more than one tenant: ADR-0005
   * makes tenant selection a second step, and the tenant is bound to the session
   * rather than to the credential.
   */
  async create(
    client: PoolClient,
    input: {
      userId: string;
      tenantId: string | null;
      mfaSatisfied: boolean;
      ipAddress?: string | undefined;
      userAgent?: string | undefined;
      deviceLabel?: string | undefined;
    },
  ): Promise<IssuedSession> {
    const now = Date.now();
    const accessExpiresAt = new Date(now + this.env.ACCESS_TOKEN_TTL_SECONDS * 1000);
    const refreshExpiresAt = new Date(now + this.env.REFRESH_TOKEN_TTL_SECONDS * 1000);
    const absoluteExpiresAt = new Date(now + this.env.SESSION_ABSOLUTE_TTL_SECONDS * 1000);

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO sessions (user_id, tenant_id, device_label, ip_address, user_agent,
                             mfa_satisfied, mfa_verified_at, expires_at,
                             access_expires_at, refresh_expires_at)
       VALUES ($1, $2, $3, $4::inet, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        input.userId,
        input.tenantId,
        input.deviceLabel ?? null,
        input.ipAddress ?? null,
        input.userAgent ?? null,
        input.mfaSatisfied,
        input.mfaSatisfied ? new Date() : null,
        absoluteExpiresAt,
        accessExpiresAt,
        refreshExpiresAt,
      ],
    );
    const sessionId = rows[0]!.id;

    const access = issueToken(sessionId);
    const refresh = issueToken(sessionId);
    await client.query(
      `UPDATE sessions SET access_token_hash = $2, refresh_token_hash = $3 WHERE id = $1`,
      [sessionId, access.hash, refresh.hash],
    );

    return {
      sessionId,
      accessToken: access.token,
      refreshToken: refresh.token,
      accessExpiresAt,
      refreshExpiresAt,
      tenantId: input.tenantId,
      mfaRequired: false,
    };
  }

  /**
   * Resolves a bearer token to a principal, or returns null.
   *
   * Null rather than throwing: the guard decides what an anonymous request means
   * for the route it is protecting, and some routes are reachable without one.
   */
  async resolve(bearer: string): Promise<Principal | null> {
    const parts = splitToken(bearer);
    if (!parts) return null;
    // A malformed id would make the query throw rather than return no rows.
    if (!/^[0-9a-f-]{36}$/i.test(parts.sessionId)) return null;

    const { rows } = await this.pool.query<SessionRow>(
      `SELECT s.id, s.user_id, s.tenant_id, s.access_token_hash, s.access_expires_at,
              s.refresh_token_hash, s.refresh_expires_at, s.expires_at, s.revoked_at,
              s.mfa_satisfied, s.mfa_verified_at,
              u.email, u.display_name, u.status AS user_status, u.mfa_required
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = $1`,
      [parts.sessionId],
    );
    const session = rows[0];
    if (!session) return null;
    if (!tokenMatches(parts.secret, session.access_token_hash)) return null;

    const now = new Date();
    if (session.revoked_at) throw new AppError('SESSION_EXPIRED', 'This session was revoked.');
    if (session.expires_at <= now || (session.access_expires_at ?? now) <= now) {
      throw new AppError('SESSION_EXPIRED', 'This session has expired. Refresh or sign in again.');
    }
    // ADR-0005: suspension applies to the membership, but a deactivated *user* is
    // out everywhere, immediately. This is the check that makes doc 02's "suspended
    // user loses active access" true on the next request rather than at expiry.
    if (session.user_status !== 'ACTIVE') {
      throw new AppError('UNAUTHENTICATED', 'This account is not active.');
    }
    if (session.mfa_required && !session.mfa_satisfied) {
      throw new AppError(
        'MFA_REQUIRED',
        'Multi-factor authentication is required for this account.',
      );
    }

    // Best-effort liveness for the session list; never blocks the request.
    void this.pool
      .query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [session.id])
      .catch(() => undefined);

    return {
      userId: session.user_id,
      sessionId: session.id,
      email: session.email,
      displayName: session.display_name,
      tenantId: session.tenant_id,
      grants: session.tenant_id ? await this.grantsFor(session.user_id, session.tenant_id) : [],
      mfaSatisfied: session.mfa_satisfied,
      mfaVerifiedAt: session.mfa_verified_at,
      impersonatedBy: null,
    };
  }

  /**
   * Every (role, scope) pair the user holds in this tenant.
   *
   * Read per request rather than baked into the token, because a permission change
   * has to take effect immediately — Gate B tests exactly that, and a cached grant
   * set means a revoked role keeps working until the token expires.
   */
  async grantsFor(userId: string, tenantId: string): Promise<Grant[]> {
    const { rows } = await this.pool.query<GrantRow>(
      `SELECT m.id AS membership_id, m.role_id, r.code AS role_code,
              m.organization_id, m.legal_entity_id, m.branch_id,
              coalesce(
                array_agg(rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL),
                '{}'
              ) AS permissions
         FROM memberships m
         JOIN roles r ON r.id = m.role_id
         LEFT JOIN role_permissions rp ON rp.role_id = m.role_id
        WHERE m.user_id = $1
          AND m.tenant_id = $2
          AND m.status = 'ACTIVE'
          AND m.suspended_at IS NULL
          AND r.status = 'ACTIVE'
        GROUP BY m.id, r.code`,
      [userId, tenantId],
    );

    return rows.map((row) => ({
      membershipId: row.membership_id,
      roleId: row.role_id,
      roleCode: row.role_code,
      organizationId: row.organization_id,
      legalEntityId: row.legal_entity_id,
      branchId: row.branch_id,
      permissions: new Set(row.permissions),
    }));
  }

  /**
   * Exchanges a refresh token for a new pair.
   *
   * Rotation with reuse detection: presenting a refresh token that is no longer the
   * current one means the old token leaked, so the session is revoked rather than
   * the request merely refused. Refusing alone leaves the attacker's copy working
   * whenever they get there first.
   */
  async refresh(
    client: PoolClient,
    bearer: string,
  ): Promise<{ session: IssuedSession; userId: string }> {
    const parts = splitToken(bearer);
    if (!parts) throw new AppError('UNAUTHENTICATED', 'The refresh token is not valid.');

    const { rows } = await client.query<SessionRow>(
      `SELECT s.*, u.email, u.display_name, u.status AS user_status, u.mfa_required
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 FOR UPDATE OF s`,
      [parts.sessionId],
    );
    const session = rows[0];
    if (!session) throw new AppError('UNAUTHENTICATED', 'The refresh token is not valid.');

    if (!tokenMatches(parts.secret, session.refresh_token_hash)) {
      await client.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL`,
        [session.id, 'refresh token reuse detected'],
      );
      throw new AppError(
        'SESSION_EXPIRED',
        'This refresh token was already used. The session has been revoked; sign in again.',
      );
    }
    if (session.revoked_at) throw new AppError('SESSION_EXPIRED', 'This session was revoked.');

    const now = new Date();
    if (session.expires_at <= now || (session.refresh_expires_at ?? now) <= now) {
      throw new AppError('SESSION_EXPIRED', 'This session has expired. Sign in again.');
    }
    if (session.user_status !== 'ACTIVE') {
      throw new AppError('UNAUTHENTICATED', 'This account is not active.');
    }

    const access = issueToken(session.id);
    const refresh = issueToken(session.id);
    const accessExpiresAt = new Date(Date.now() + this.env.ACCESS_TOKEN_TTL_SECONDS * 1000);
    const refreshExpiresAt = new Date(Date.now() + this.env.REFRESH_TOKEN_TTL_SECONDS * 1000);

    await client.query(
      `UPDATE sessions
          SET access_token_hash = $2, refresh_token_hash = $3,
              access_expires_at = $4, refresh_expires_at = $5,
              rotation_count = rotation_count + 1, last_seen_at = now()
        WHERE id = $1`,
      [session.id, access.hash, refresh.hash, accessExpiresAt, refreshExpiresAt],
    );

    return {
      userId: session.user_id,
      session: {
        sessionId: session.id,
        accessToken: access.token,
        refreshToken: refresh.token,
        accessExpiresAt,
        refreshExpiresAt,
        tenantId: session.tenant_id,
        mfaRequired: false,
      },
    };
  }

  async revoke(client: PoolClient, sessionId: string, reason: string): Promise<boolean> {
    const result = await client.query(
      `UPDATE sessions
          SET revoked_at = now(), revoked_reason = $2,
              access_token_hash = NULL, refresh_token_hash = NULL
        WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId, reason],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** ADR-0005: "user.suspended must terminate live sessions immediately." */
  async revokeAllForUser(client: PoolClient, userId: string, reason: string): Promise<number> {
    const result = await client.query(
      `UPDATE sessions
          SET revoked_at = now(), revoked_reason = $2,
              access_token_hash = NULL, refresh_token_hash = NULL
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId, reason],
    );
    return result.rowCount ?? 0;
  }

  /** Binds a session to one tenant — the second step of ADR-0005's login flow. */
  async bindTenant(client: PoolClient, sessionId: string, tenantId: string): Promise<void> {
    await client.query(`UPDATE sessions SET tenant_id = $2 WHERE id = $1`, [sessionId, tenantId]);
  }
}
