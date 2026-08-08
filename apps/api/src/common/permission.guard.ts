import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '@acct/domain';
import { PERMISSION_DEFINITIONS, isKnownPermission } from '@acct/contracts';
import type { loadApiEnv } from '@acct/config';
import { API_ENV } from './database.module';
import { ANONYMOUS_METADATA, OPERATION_METADATA, operationOrThrow } from './operation';
import type { AuthenticatedRequest } from './auth.guard';
import { can } from './principal';

/**
 * Enforces the permission the contract declares for the route.
 *
 * This is the coarse half of authorization: does the caller hold this permission
 * anywhere in the tenant. The fine half — does it extend to *this* legal entity —
 * lives in the services, because at guard time the target entity is usually still
 * an unparsed request body. Both halves are needed; either alone is a hole, and it
 * is the second one that Phase 1 exit criterion 2 tests.
 *
 * Nothing here reads a decorator argument. The permission comes from
 * contracts/openapi.yaml via the generated `OPERATIONS`, so a route physically
 * cannot require a permission the contract does not record, and the CI check that
 * every mutation declares one is therefore a check on this code as well.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(API_ENV) private readonly env: ReturnType<typeof loadApiEnv>,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const handler = context.getHandler();
    if (this.reflector.get<boolean>(ANONYMOUS_METADATA, handler)) return true;

    const operationId = this.reflector.get<string>(OPERATION_METADATA, handler);
    if (!operationId) return true; // AuthGuard has already rejected this.
    const definition = operationOrThrow(operationId);

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request.principal;

    if (definition.unauthenticated && !definition.permission) return true;

    if (!principal) {
      throw new AppError('UNAUTHENTICATED', 'This request requires a signed-in session.');
    }

    // Self-service operations act only on the caller's own session or profile, so
    // they need a session and no permission. The contract check restricts this
    // exemption to the /auth and /webhooks surfaces, which is what stops it becoming
    // a general-purpose way to skip authorization.
    if (definition.selfService) return true;

    if (!definition.permission) return true;

    // Every permission-bearing route is tenant-scoped. Reaching one before choosing
    // a tenant is a client-flow error, and saying so plainly beats an empty list.
    if (!principal.tenantId) {
      throw new AppError(
        'TENANT_MISMATCH',
        'No tenant is selected for this session. Call POST /auth/tenants/{id}/select first.',
      );
    }

    if (!can(principal, definition.permission)) {
      throw new AppError(
        'FORBIDDEN',
        `This action requires the ${definition.permission} permission.`,
        { details: { permission: definition.permission, operation: operationId } },
      );
    }

    // ADR-0005 §3: the high-risk permissions "drive reauthentication and
    // segregation-of-duties rules". Reauthentication is enforced here rather than
    // at each call site, because the set of high-risk permissions is data — the
    // registry flags 19 of them — and a rule applied by hand at 19 call sites is a
    // rule applied at 18.
    // `permission` is a plain string on OperationDefinition while the registry is
    // keyed by the Permission union; the narrowing is the type-level version of
    // "this permission is one the contract knows about".
    if (
      isKnownPermission(definition.permission) &&
      PERMISSION_DEFINITIONS[definition.permission].isHighRisk
    ) {
      this.assertRecentlyAuthenticated(principal, definition.permission);
    }

    return true;
  }

  private assertRecentlyAuthenticated(
    principal: NonNullable<AuthenticatedRequest['principal']>,
    permission: string,
  ): void {
    // Two different situations that both end in MFA_REQUIRED and need different
    // things from the person reading the message: enrol a factor, or verify again.
    if (!principal.mfaSatisfied || !principal.mfaVerifiedAt) {
      throw new AppError(
        'MFA_REQUIRED',
        `${permission} is one of the high-risk permissions doc 02 names, and requires ` +
          'multi-factor authentication. Enrol a factor at POST /auth/mfa/challenge, then sign ' +
          'in again.',
        { details: { permission, remedy: 'enrol' } },
      );
    }
    const ageSeconds = (Date.now() - principal.mfaVerifiedAt.getTime()) / 1000;
    if (ageSeconds > this.env.REAUTH_WINDOW_SECONDS) {
      throw new AppError(
        'MFA_REQUIRED',
        `${permission} is a high-risk permission and your last verification was ` +
          `${Math.round(ageSeconds / 60)} minutes ago, beyond the ` +
          `${Math.round(this.env.REAUTH_WINDOW_SECONDS / 60)}-minute re-authentication window. ` +
          'Verify again and retry.',
        {
          details: {
            permission,
            remedy: 'reauthenticate',
            reauth_window_seconds: this.env.REAUTH_WINDOW_SECONDS,
          },
        },
      );
    }
  }
}
