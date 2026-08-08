import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '@acct/domain';
import { Operation } from '../common/operation';
import { parse, email as emailField, name as nameField, uuid } from '../common/validation';
import type { AuthenticatedRequest } from '../common/auth.guard';
import { AuthService } from './auth.service';
import { SessionService, type IssuedSession } from './session.service';
import { withoutTenant } from '../common/db';
import { Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../common/database.module';

/**
 * The authentication surface: `security: []` on most of it, because you cannot
 * require a session to create one.
 *
 * Passwords have a floor of 12 characters and no composition rules. NIST SP
 * 800-63B withdrew the "one uppercase, one digit, one symbol" advice years ago —
 * it pushes people towards `Password1!` and towards writing it down, and length is
 * what actually costs an attacker anything.
 */
const password = z.string().min(12, 'at least 12 characters').max(256);

const SignUpBody = z.object({
  email: emailField,
  password,
  display_name: nameField,
  tenant_name: nameField,
  organization_name: nameField,
});

const LoginBody = z.object({ email: emailField, password: z.string().min(1).max(256) });
const RefreshBody = z.object({ refresh_token: z.string().min(1) });
const MfaChallengeBody = z.object({ mfa_token: z.string().min(1).optional() });
const MfaVerifyBody = z
  .object({
    mfa_token: z.string().min(1),
    code: z.string().trim().optional(),
    recovery_code: z.string().trim().optional(),
  })
  .refine((b) => Boolean(b.code) !== Boolean(b.recovery_code), {
    message: 'send exactly one of code or recovery_code',
    path: ['code'],
  });
const AcceptInvitationBody = z.object({
  token: z.string().min(1),
  display_name: nameField.optional(),
  password: password.optional(),
});

function sessionResponse(session: IssuedSession): Record<string, unknown> {
  return {
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
    token_type: 'Bearer',
    access_expires_at: session.accessExpiresAt.toISOString(),
    refresh_expires_at: session.refreshExpiresAt.toISOString(),
    session_id: session.sessionId,
    tenant_id: session.tenantId,
  };
}

@Controller()
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
  ) {}

  @Post('auth/signup')
  @Operation('signUp')
  async signUp(@Body() body: unknown): Promise<Record<string, unknown>> {
    const input = parse(SignUpBody, body);
    const result = await this.auth.signUp({
      email: input.email,
      password: input.password,
      displayName: input.display_name,
      tenantName: input.tenant_name,
      organizationName: input.organization_name,
    });
    return {
      id: result.tenantId,
      tenant_id: result.tenantId,
      organization_id: result.organizationId,
      user_id: result.userId,
      ...sessionResponse(result.session),
    };
  }

  @Post('auth/login')
  @Operation('login')
  async login(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    const input = parse(LoginBody, body);
    const result = await this.auth.login({
      email: input.email,
      password: input.password,
      ipAddress: request.ip,
      userAgent: request.header('user-agent'),
    });

    if (result.mfaRequired) {
      return {
        mfa_required: true,
        mfa_token: result.mfaToken,
        tenants: result.tenants,
      };
    }
    return {
      mfa_required: false,
      tenants: result.tenants,
      // Null when the user belongs to more than one tenant: ADR-0005 makes
      // selection the second step, and the client must take it before any
      // permission-bearing route will answer.
      tenant_selection_required: result.session!.tenantId === null,
      ...sessionResponse(result.session!),
    };
  }

  @Post('auth/refresh')
  @Operation('refreshToken')
  async refresh(@Body() body: unknown): Promise<Record<string, unknown>> {
    const input = parse(RefreshBody, body);
    const { session } = await withoutTenant(this.pool, ({ client }) =>
      this.sessions.refresh(client, input.refresh_token),
    );
    return sessionResponse(session);
  }

  @Post('auth/logout')
  @Operation('logout')
  async logout(@Req() request: AuthenticatedRequest): Promise<void> {
    const principal = request.principal;
    if (!principal) return; // Already signed out; saying so twice helps nobody.
    await withoutTenant(this.pool, ({ client }) =>
      this.sessions.revoke(client, principal.sessionId, 'signed out'),
    );
  }

  @Post('auth/mfa/challenge')
  @Operation('mfaChallenge')
  async mfaChallenge(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    const input = parse(MfaChallengeBody, body);

    // Two uses, distinguished by what the caller has. A signed-in user is starting
    // enrolment; a caller holding only an mfa_token is completing a login.
    if (request.principal && !input.mfa_token) {
      const enrolment = await this.auth.beginEnrolment(
        request.principal.userId,
        request.principal.email,
      );
      const recoveryCodes = await this.auth.issueRecoveryCodes(request.principal.userId);
      return {
        mode: 'enrol',
        kind: 'TOTP',
        otpauth_uri: enrolment.uri,
        // Shown exactly once. Only hashes are stored, so there is no second chance
        // to display them and the client must say so.
        recovery_codes: recoveryCodes,
      };
    }

    if (!input.mfa_token) {
      throw new AppError('VALIDATION_FAILED', 'mfa_token is required when not signed in.', {
        fieldErrors: [{ field: 'mfa_token', code: 'REQUIRED', message: 'required' }],
      });
    }
    const factors = await this.auth.availableFactors(input.mfa_token);
    return {
      mode: 'verify',
      kinds: factors.kinds,
      recovery_codes_remaining: factors.recoveryCodes,
    };
  }

  @Post('auth/mfa/verify')
  @Operation('mfaVerify')
  async mfaVerify(@Body() body: unknown): Promise<Record<string, unknown>> {
    const input = parse(MfaVerifyBody, body);
    const { session } = await this.auth.verifyMfa({
      mfaToken: input.mfa_token,
      code: input.code ?? '',
      recoveryCode: input.recovery_code,
    });
    return sessionResponse(session);
  }

  @Get('auth/tenants')
  @Operation('listMyTenants')
  async listMyTenants(@Req() request: AuthenticatedRequest): Promise<Record<string, unknown>> {
    const principal = request.principal;
    if (!principal) throw new AppError('UNAUTHENTICATED', 'This request requires a session.');
    return {
      data: await this.auth.tenantsFor(principal.userId),
      selected_tenant_id: principal.tenantId,
    };
  }

  @Post('auth/tenants/:id/select')
  @Operation('selectTenant')
  async selectTenant(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    const principal = request.principal;
    if (!principal) throw new AppError('UNAUTHENTICATED', 'This request requires a session.');
    const tenantId = parse(uuid, id);
    await this.auth.selectTenant(principal, tenantId);
    return { tenant_id: tenantId, session_id: principal.sessionId };
  }

  @Post('auth/invitations/accept')
  @Operation('acceptInvitation')
  async acceptInvitation(@Body() body: unknown): Promise<Record<string, unknown>> {
    const input = parse(AcceptInvitationBody, body);
    const result = await this.auth.acceptInvitation({
      token: input.token,
      displayName: input.display_name,
      password: input.password,
    });
    return {
      tenant_id: result.tenantId,
      user_id: result.userId,
      ...sessionResponse(result.session),
    };
  }
}
