/**
 * Who is calling, and what they may touch.
 *
 * ADR-0005: users are platform-level and "authorization is entirely per-tenant and
 * derives solely from memberships". This module is that sentence in code — nothing
 * else in the API is allowed to decide access, and nothing reads a tenant or an
 * entity id out of a request body to decide scope.
 *
 * The shape that matters is `grants`. doc 02: "A user may have different roles per
 * entity", so a principal is not one role with one permission set; it is a list of
 * (role, scope) pairs, and a permission question is only meaningful once you say
 * *where*. Phase 1 exit criterion 2 — "an entity-restricted user cannot query or
 * mutate another entity" — is a property of this file.
 */
import { AppError } from './errors';

export interface Grant {
  readonly membershipId: string;
  readonly roleId: string;
  readonly roleCode: string;
  /** null = every organization in the tenant. */
  readonly organizationId: string | null;
  /** null = every legal entity within the granted organization scope. */
  readonly legalEntityId: string | null;
  /** null = every branch within the granted entity scope. */
  readonly branchId: string | null;
  readonly permissions: ReadonlySet<string>;
}

export interface Principal {
  readonly userId: string;
  readonly sessionId: string;
  readonly email: string;
  readonly displayName: string;
  /** Absent between authentication and tenant selection (ADR-0005 two-step login). */
  readonly tenantId: string | null;
  readonly grants: readonly Grant[];
  readonly mfaSatisfied: boolean;
  readonly mfaVerifiedAt: Date | null;
  /** doc 23: support impersonation records both actors, never only the operator. */
  readonly impersonatedBy: string | null;
}

/** A principal with a tenant bound — most routes require this and say so in their types. */
export interface TenantPrincipal extends Principal {
  readonly tenantId: string;
}

export function hasTenant(principal: Principal): principal is TenantPrincipal {
  return principal.tenantId !== null;
}

// ---------------------------------------------------------------------------
// Permission questions
// ---------------------------------------------------------------------------

/**
 * Does this principal hold the permission *anywhere* in the current tenant?
 *
 * This is the coarse question, and the only one a route guard can answer, because
 * at guard time the target entity is usually still inside an unparsed request body.
 * It is necessary but never sufficient: every entity-scoped service call must then
 * ask `assertEntityPermission`. Guard-only checking is exactly how an AR clerk for
 * entity A ends up able to post in entity B.
 */
export function can(principal: Principal, permission: string): boolean {
  return principal.grants.some((g) => g.permissions.has(permission));
}

/** The same question, asked about one legal entity. */
export function canInEntity(
  principal: Principal,
  permission: string,
  legalEntityId: string,
): boolean {
  return principal.grants.some(
    (g) =>
      g.permissions.has(permission) &&
      (g.legalEntityId === null || g.legalEntityId === legalEntityId),
  );
}

export function canInOrganization(
  principal: Principal,
  permission: string,
  organizationId: string,
): boolean {
  return principal.grants.some(
    (g) =>
      g.permissions.has(permission) &&
      (g.organizationId === null || g.organizationId === organizationId),
  );
}

/**
 * The entities this principal can see at all.
 *
 * `{ kind: 'ALL' }` means at least one membership is tenant-wide, so the answer is
 * "every entity in the tenant" and a list query needs no entity filter beyond the
 * tenant. Returning the resolved id list instead would mean a query per request and
 * a race with entity creation.
 */
export type EntityScope =
  | { readonly kind: 'ALL' }
  | { readonly kind: 'ORGANIZATIONS'; readonly organizationIds: readonly string[] }
  | { readonly kind: 'ENTITIES'; readonly legalEntityIds: readonly string[] };

export function entityScope(principal: Principal): EntityScope {
  const active = principal.grants;
  if (active.some((g) => g.legalEntityId === null && g.organizationId === null)) {
    return { kind: 'ALL' };
  }
  const entities = active.map((g) => g.legalEntityId).filter((id): id is string => id !== null);
  const organizations = active
    .filter((g) => g.legalEntityId === null)
    .map((g) => g.organizationId)
    .filter((id): id is string => id !== null);

  // An organization-wide membership grants every entity under it, including ones
  // created after the membership. Expressed as the organization, not as the entity
  // list it happens to resolve to today.
  if (organizations.length > 0 && entities.length === 0) {
    return { kind: 'ORGANIZATIONS', organizationIds: [...new Set(organizations)] };
  }
  if (organizations.length > 0) {
    // Mixed scopes. Widening to the organizations and letting the entity list ride
    // along inside them would be wrong only if an entity grant pointed outside the
    // granted organizations, which the membership FKs prevent.
    return { kind: 'ORGANIZATIONS', organizationIds: [...new Set(organizations)] };
  }
  return { kind: 'ENTITIES', legalEntityIds: [...new Set(entities)] };
}

/**
 * A SQL fragment restricting a query to the entities this principal may see.
 *
 * Returned as a fragment plus parameters rather than as an id list so the filter
 * happens in the database. A list route that fetches and then filters in
 * JavaScript still leaks through `has_more`, through counts, and through cursor
 * positions — the row was read, so its existence is observable.
 */
export interface ScopeFilter {
  readonly sql: string;
  readonly params: readonly unknown[];
}

export function entityScopeFilter(
  principal: Principal,
  columns: { legalEntityId: string; organizationId?: string },
  nextParamIndex: number,
): ScopeFilter {
  const scope = entityScope(principal);
  if (scope.kind === 'ALL') return { sql: 'TRUE', params: [] };
  if (scope.kind === 'ORGANIZATIONS') {
    const column =
      columns.organizationId ??
      `(SELECT le.organization_id FROM legal_entities le WHERE le.id = ${columns.legalEntityId})`;
    return { sql: `${column} = ANY($${nextParamIndex}::uuid[])`, params: [scope.organizationIds] };
  }
  if (scope.legalEntityIds.length === 0) return { sql: 'FALSE', params: [] };
  return {
    sql: `${columns.legalEntityId} = ANY($${nextParamIndex}::uuid[])`,
    params: [scope.legalEntityIds],
  };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/**
 * ENTITY_ACCESS_DENIED, not NOT_FOUND.
 *
 * There is a school of thought that says an authorization failure should be
 * indistinguishable from a missing record so that ids cannot be probed. It does not
 * apply here: entity ids are visible to every member of the tenant on the entity
 * list, so hiding the difference costs a support call for every genuine permission
 * gap and buys nothing. Cross-*tenant* probes are different, and those do return
 * NOT_FOUND — see `assertTenantScope`.
 */
export function assertEntityPermission(
  principal: Principal,
  permission: string,
  legalEntityId: string,
): void {
  if (canInEntity(principal, permission, legalEntityId)) return;
  if (can(principal, permission)) {
    throw new AppError(
      'ENTITY_ACCESS_DENIED',
      `Your access to ${permission} does not include this legal entity.`,
      { details: { permission, legalEntityId } },
    );
  }
  throw new AppError('FORBIDDEN', `This action requires the ${permission} permission.`, {
    details: { permission },
  });
}

export function assertPermission(principal: Principal, permission: string): void {
  if (can(principal, permission)) return;
  throw new AppError('FORBIDDEN', `This action requires the ${permission} permission.`, {
    details: { permission },
  });
}

/**
 * Gate B: "cross-tenant object ID probes return no data."
 *
 * NOT_FOUND rather than FORBIDDEN, and deliberately so: a distinct response would
 * confirm that the id exists somewhere, which is precisely what the probe is
 * looking for. Every service that loads a row by id calls this before returning it.
 */
export function assertTenantScope(
  principal: Principal,
  row: { tenant_id: string } | null | undefined,
  resource: string,
  id: string,
): void {
  if (row && hasTenant(principal) && row.tenant_id === principal.tenantId) return;
  throw new AppError('NOT_FOUND', `${resource} ${id} was not found.`, {
    details: { resource, id },
  });
}
