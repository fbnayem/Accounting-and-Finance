/**
 * Authorization vocabulary, re-exported.
 *
 * The definitions moved to @acct/domain in Phase 2: the ledger kernel became a
 * package (`@acct/ledger`) so the worker could post scheduled reversals through the
 * same service the API uses, and a kernel that imports from `apps/api` is not a
 * package. Nothing about the rules changed. This file stays so the Phase 1 modules
 * that import from it keep working, and because `../common/principal` is where a
 * reader looks first.
 */
export {
  can,
  canInEntity,
  canInOrganization,
  entityScope,
  entityScopeFilter,
  hasTenant,
  assertEntityPermission,
  assertPermission,
  assertTenantScope,
  type Grant,
  type Principal,
  type TenantPrincipal,
  type EntityScope,
  type ScopeFilter,
} from '@acct/domain';
