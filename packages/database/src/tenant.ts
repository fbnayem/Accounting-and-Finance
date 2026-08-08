/**
 * Tenant-scoped database access.
 *
 * Every read and write on a request path goes through one of these, and they all
 * open a transaction even when a bare `pool.query` would do. Two reasons, both
 * structural:
 *
 *   - `withTransaction` sets `app.tenant_id`, which is what the migration 0024 and
 *     0029 row-level security policies read. Outside a transaction the setting would
 *     have to be session-level, and a session-level setting survives the connection
 *     going back to the pool — the next request would inherit somebody else's
 *     tenant. That is a worse bug than the one RLS was added to prevent.
 *   - Having one entry point means the habit is set once. Phase 1 touched tables RLS
 *     did not yet cover; Phase 2's ledger tables are all covered, and nothing had to
 *     be revisited for that to be true.
 */
import { Pool } from 'pg';
import type { Principal, RequestContext, TenantPrincipal } from '@acct/domain';
import { requireContext } from '@acct/domain';
import { withTransaction, type TransactionScope } from './transaction';

export function contextFor(
  principal: Principal,
  extra: Partial<RequestContext> = {},
): RequestContext {
  return {
    ...requireContext(),
    ...(principal.tenantId ? { tenantId: principal.tenantId } : {}),
    actorId: principal.userId,
    actorKind: 'USER',
    ...(principal.impersonatedBy ? { impersonatedBy: principal.impersonatedBy } : {}),
    ...extra,
  };
}

/** A read. READ COMMITTED and READ ONLY — a list does not need a snapshot of the world. */
export function readInTenant<T>(
  pool: Pool,
  principal: TenantPrincipal,
  fn: (scope: TransactionScope) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, fn, {
    context: contextFor(principal),
    readOnly: true,
    isolation: 'READ COMMITTED',
    maxRetries: 0,
  });
}

/** A write. Aggregate row, outbox event and audit entry commit together or not at all. */
export function writeInTenant<T>(
  pool: Pool,
  principal: TenantPrincipal,
  fn: (scope: TransactionScope) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, fn, { context: contextFor(principal) });
}

/**
 * For the two paths that legitimately have no tenant yet: authentication, and
 * signup before the tenant row exists. Named so that a grep for it returns a list
 * short enough to read.
 */
export function withoutTenant<T>(
  pool: Pool,
  fn: (scope: TransactionScope) => Promise<T>,
  context?: RequestContext,
): Promise<T> {
  return withTransaction(pool, fn, { context: context ?? requireContext() });
}
