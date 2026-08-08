import { Controller, Get, Inject, Param, Req } from '@nestjs/common';
import { Post } from '@nestjs/common';
import { Pool } from 'pg';
import { AppError } from '@acct/domain';
import { recordAudit } from '@acct/database';
import { DATABASE_POOL } from '../common/database.module';
import { Operation } from '../common/operation';
import { parse, uuid } from '../common/validation';
import type { AuthenticatedRequest } from '../common/auth.guard';
import { hasTenant } from '../common/principal';
import { contextFor, withoutTenant } from '../common/db';
import { SessionService } from './session.service';

/**
 * Session listing and revocation — doc 02 "Session list/revocation", ADR-0005 §2.
 *
 * Scoped to the caller's own sessions plus, for a holder of `session.revoke`, the
 * sessions of other members of the same tenant. Someone administering access needs
 * to be able to end a session on a lost laptop; nobody needs to see sessions in a
 * tenant they do not belong to.
 */
@Controller()
export class SessionsController {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  @Get('sessions')
  @Operation('listSessions')
  async list(@Req() request: AuthenticatedRequest): Promise<Record<string, unknown>> {
    const principal = request.principal!;
    if (!hasTenant(principal)) {
      throw new AppError('TENANT_MISMATCH', 'Select a tenant before listing sessions.');
    }

    const { rows } = await this.pool.query<{
      id: string;
      user_id: string;
      display_name: string;
      email: string;
      device_label: string | null;
      ip_address: string | null;
      user_agent: string | null;
      issued_at: Date;
      last_seen_at: Date;
      expires_at: Date;
      mfa_satisfied: boolean;
    }>(
      `SELECT s.id, s.user_id, u.display_name, u.email::text AS email, s.device_label,
              host(s.ip_address) AS ip_address, s.user_agent, s.issued_at, s.last_seen_at,
              s.expires_at, s.mfa_satisfied
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.revoked_at IS NULL
          AND s.expires_at > now()
          AND s.tenant_id = $1
          -- Everyone sees their own; only session.revoke sees other people's.
          AND (s.user_id = $2 OR $3)
        ORDER BY s.last_seen_at DESC
        LIMIT 200`,
      [
        principal.tenantId,
        principal.userId,
        principal.grants.some((g) => g.permissions.has('session.revoke')),
      ],
    );

    return {
      data: rows.map((row) => ({
        id: row.id,
        user_id: row.user_id,
        user: { display_name: row.display_name, email: row.email },
        device_label: row.device_label,
        ip_address: row.ip_address,
        user_agent: row.user_agent,
        issued_at: row.issued_at.toISOString(),
        last_seen_at: row.last_seen_at.toISOString(),
        expires_at: row.expires_at.toISOString(),
        mfa_satisfied: row.mfa_satisfied,
        is_current: row.id === principal.sessionId,
      })),
    };
  }

  @Post('sessions/:id/revoke')
  @Operation('revokeSession')
  async revoke(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    const principal = request.principal!;
    const sessionId = parse(uuid, id);

    return withoutTenant(this.pool, async ({ client }) => {
      const { rows } = await client.query<{ user_id: string; tenant_id: string | null }>(
        `SELECT user_id, tenant_id FROM sessions WHERE id = $1`,
        [sessionId],
      );
      const target = rows[0];
      // Gate B: a session in another tenant is indistinguishable from one that
      // does not exist. Returning FORBIDDEN here would confirm the id.
      if (!target || (target.tenant_id && target.tenant_id !== principal.tenantId)) {
        throw new AppError('NOT_FOUND', `Session ${sessionId} was not found.`);
      }

      const revoked = await this.sessions.revoke(client, sessionId, 'revoked by an administrator');
      await recordAudit(client, contextFor(principal), {
        action: 'session.revoked',
        resourceType: 'session',
        resourceId: sessionId,
        tenantId: principal.tenantId!,
        after: { revoked, target_user_id: target.user_id },
      });
      return { id: sessionId, revoked };
    });
  }
}
