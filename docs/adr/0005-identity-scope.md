# ADR-0005 — Identity scope

**Status:** Accepted · 2026-08-07
**Resolves:** [D-06](../../audit/07_Open_Decisions.md#d-06--user-identity-scope) ·
[F-018](../../audit/01_Schema_Findings.md), [F-045](../../audit/01_Schema_Findings.md),
[F-016](../../audit/01_Schema_Findings.md), [F-207](../../audit/03_Coverage_Gaps.md)

## Context

`users.email` is globally unique across all tenants. `memberships` supports one user holding roles in
many tenants. The intent looks like global identity, but it was never stated — so the first time a
bookkeeper tried to register under a second client it would look like a bug.

Separately, permissions were an untyped `jsonb` array, and there was no `sessions` table despite
doc 02 and doc 16 both requiring session listing and revocation.

## Decision

### 1. Users are global; tenancy comes only from membership

`users` is a platform-level table. One person, one row, one email, regardless of how many tenants
they work in. Authentication is cross-tenant; **authorization is entirely per-tenant** and derives
solely from `memberships`.

This is what Phase 9's multi-client accountant dashboard requires — doc 09 asks for "Permission
switching without cross-client leakage", which presumes one identity spanning tenants. Tenant-scoped
users would force accountants to maintain one login per client, which is the problem the portal
exists to solve.

### 2. Sessions are first-class and revocable

A `sessions` table records user, tenant context, device, issue and expiry times, revocation, IP and
user agent. Stateless JWTs alone cannot satisfy doc 02's "Session list/revocation" or doc 16's
"Session/device management and revocation", and `user.suspended` must terminate live sessions
immediately.

Access tokens are short-lived and carry a session ID; revocation invalidates the session row, which
the refresh path checks.

### 3. Permissions are an enumerable registry

`permissions` is a table, not a JSON array. `role_permissions` is the join.

The registry is **generated from `contracts/openapi.yaml`**, where every route declares its required
permission ([F-108](../../audit/02_Contract_Drift.md)) — so the two cannot drift, and Gate B's
"authorization tests cover every mutation route" becomes mechanically provable rather than
aspirational. A typo'd permission fails at seed time instead of silently granting nothing.

`permissions.is_high_risk` flags the six doc 02 names — change vendor bank details, approve payments,
post manual journals to control accounts, reopen periods, override tax, export all financial data,
manage roles and integrations — which drive reauthentication and segregation-of-duties rules.

## Consequences

- Email change affects every tenant the user belongs to; it needs a verification flow.
- Tenant suspension must not lock a user out of their other tenants. Suspension applies to the
  membership, not the user.
- Gate B gains a specific test: a user with memberships in tenants A and B, acting in A, cannot read
  B's data through any route, including guessed IDs.
- Login is a two-step flow when a user belongs to several tenants: authenticate, then select tenant.
  The selected tenant is bound to the session, not to the credential.
- The permission registry is a build artifact. CI fails if a route exists without a declared
  permission, or if a permission is referenced by a role but absent from the registry.
