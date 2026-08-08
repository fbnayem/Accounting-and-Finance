/**
 * Tenant-scoped database access, re-exported.
 *
 * Moved to @acct/database in Phase 2 alongside `principal.ts`, so the ledger kernel
 * package can open a tenant-scoped transaction without importing from apps/api.
 * Kept here because every Phase 1 service imports `../common/db` and the move is an
 * implementation detail of where the kernel lives, not a change to what these do.
 */
export { contextFor, readInTenant, writeInTenant, withoutTenant } from '@acct/database';
