/**
 * Narrowing a request's principal to one that has a tenant.
 *
 * Phase 1 grew four identical copies of this, one per controller, which is three
 * more chances to write `request.principal!` instead. Every business route needs
 * it, so it lives with the guards that produce the principal in the first place.
 *
 * TENANT_MISMATCH rather than UNAUTHENTICATED: the caller is authenticated, they
 * simply have not completed ADR-0005's second login step. A 401 would send a client
 * back to the password form it has already passed.
 */
import { AppError } from '@acct/domain';
import type { AuthenticatedRequest } from './auth.guard';
import { hasTenant, type TenantPrincipal } from './principal';

export function tenantPrincipal(request: AuthenticatedRequest): TenantPrincipal {
  const principal = request.principal;
  if (!principal || !hasTenant(principal)) {
    throw new AppError(
      'TENANT_MISMATCH',
      'No tenant is selected for this session. Call POST /auth/tenants/{id}/select first.',
    );
  }
  return principal;
}
