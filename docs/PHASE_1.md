# Phase 1 — Tenant, Organization, Legal Entity, IAM and Finance Setup

**Status:** complete · 2026-08-07
**Defined by:** [21_Phased_Implementation_Plan.md](<../project plan/21_Phased_Implementation_Plan.md>) Phase 1

Builds on [Phase 0](PHASE_0.md). 53 of the contract's 263 operations are Phase 1; all of them are
implemented, and the API refuses to start if any is missing a handler.

## Exit criteria — evidence

Doc 21 states four. Three of them are statements about what _cannot_ happen, so each is tested by
attempting it — a suite of successful requests would show that the happy path works and nothing
about isolation.

### 1. Two tenants cannot access each other's records through UI, API or guessed IDs

[`isolation.test.ts`](../apps/api/src/integration/isolation.test.ts) — 14 assertions over real HTTP
against a real PostgreSQL, using ids that are _known_ rather than guessed, which is strictly harder
than the criterion asks.

| Attempt                                                     | Result              |
| ----------------------------------------------------------- | ------------------- |
| Read another tenant's legal entity by id                    | 404 `NOT_FOUND`     |
| Read another tenant's organization by id                    | 404 `NOT_FOUND`     |
| List entities, organizations, users, sessions, audit events | other tenant absent |
| Create a legal entity under another tenant's organization   | 404 `NOT_FOUND`     |
| Bind a session to a tenant with no membership               | 404 `NOT_FOUND`     |

404 rather than 403 throughout, deliberately: Gate B requires that "cross-tenant object ID probes
return no data", and a 403 confirms the id exists somewhere, which is exactly what the probe is
looking for.

**The second layer, proven separately.** ADR-0002 makes composite foreign keys the primary control
and row-level security defence-in-depth. Probed directly against the database as `app_runtime`,
bypassing the application entirely:

```
no context            -> 0 rows
correct tenant        -> 20,000 rows
wrong tenant          -> 0 rows
self-granted bypass   -> 0 rows
```

The last line is the one that matters. The first draft of migration 0024 keyed the exemption off
`current_setting('app.rls_bypass')`, which the application role could set for itself — one stray
line, or one SQL injection, and the layer is gone. It is now membership of an `app_maintenance`
role, which `app_runtime` is not in and cannot join.

### 2. An entity-restricted user cannot query or mutate another entity

The restricted user is built through the real invite/accept flow and holds `finance_manager` —
the same permission as the person they are being compared against, so a refusal is attributable to
scope and to nothing else.

| Attempt                                      | Result                     |
| -------------------------------------------- | -------------------------- |
| List legal entities                          | exactly one — their own    |
| Read the other entity                        | 403 `ENTITY_ACCESS_DENIED` |
| Create a fiscal year in the other entity     | 403                        |
| Create a fiscal year in their own entity     | 201                        |
| Invite a user into the other entity as Owner | refused                    |
| Create a role holding permissions they lack  | refused                    |

403, not 404, within a tenant: the entity id is on the entity list every colleague can see, so
hiding the difference would cost a support call for every genuine permission gap and conceal nothing.

### 3. Fiscal periods are generated and can be opened, soft-closed and hard-closed by permission

[`period-lifecycle.test.ts`](../apps/api/src/integration/period-lifecycle.test.ts) — 14 assertions.

```
12 monthly periods + 1 adjustment period generated from one call
2028-01-01 … 2028-12-31, consecutive, February ends 2028-02-29 (leap year)
adjustment period overlaps period 12 by design (F-011)
overlapping fiscal year                 -> 422, names the year it collided with
soft close                              -> 200
hard close out of order                 -> 422 PERIOD_NOT_OPEN
hard close with no reason               -> 422, field_errors[0].field = "reason"
hard close in order                     -> 200, reason in the audit trail
reopen without recent MFA               -> 401 MFA_REQUIRED
reopen with MFA + reason                -> 200, reopened_by and reason persisted
soft close as an AR clerk               -> 403 FORBIDDEN
```

Two of those deserve a note.

**Out-of-order close.** The first version of the rule blocked only when an earlier period was
`OPEN`, while its own error message said the reason was that an earlier posting would move the
closing balances. `SOFT_CLOSED` still admits privileged posting, so the rule did not achieve what it
claimed. It now requires earlier regular periods to be `HARD_CLOSED`.

**Reopen and MFA.** `accounting_period.reopen` is one of doc 02's seven high-risk permissions, and
ADR-0005 §3 ties those to re-authentication. The tenant Owner holds the permission and is still
refused until MFA is satisfied, which is the point.

### 4. Role and permission tests cover every finance mutation route created in this phase

[`authorization.test.ts`](../apps/api/src/integration/authorization.test.ts) generates its cases
from the contract rather than listing them:

```
✓ 20 Phase 1 mutations, each refused to a caller holding every permission except its own
✓ every Phase 1 high-risk permission demands recent MFA
✓ every permission-bearing Phase 1 route answers 401 unauthenticated
```

The caller in each case holds _every_ permission except the one under test. A caller with no
permissions would be refused by any bug at all; this one distinguishes "the guard works" from "the
request happened to fail".

Coverage does not depend on anyone remembering to add a test. Handlers declare only which contract
operation they are — the permission, the authentication requirement and the idempotency rule are all
read from the generated contract at request time. Adding a Phase 1 mutation to
`contracts/openapi.yaml` therefore adds a case to this test automatically, and three further gates
close the loop:

| Gate                      | What it catches                                                       |
| ------------------------- | --------------------------------------------------------------------- |
| `reconcileRoutes` at boot | a route with no `@Operation`, or a contract operation with no handler |
| `pnpm dod:check` check 6  | the same, statically, in CI                                           |
| `pnpm dod:check` check 7  | the guards or the idempotency interceptor being unregistered          |

## The gate chain

```
pnpm verify        format · lint · typecheck · 14 contract checks · 8 DoD checks · 240 tests
pnpm db:verify     28 migrations, no drift, privilege layer and RLS in force
pnpm db:guards     14 scenarios, each rejected by the constraint its label names
pnpm bench         Gate H passed — 6 measured, 8 declared and not yet available
```

240 tests: 80 API (37 of them integration over real HTTP), 62 domain, 43 database, 24 UI, 13
testing, 10 config, 8 contracts.

## What was built

**Authorization, driven by the contract.** `@Operation('createOrganization')` is all a handler
declares. `AuthGuard`, `PermissionGuard` and `IdempotencyInterceptor` are registered globally and
read `security`, `x-permission` and `x-idempotency` from the generated contract, so a route cannot
declare the wrong permission because it does not declare one. Unmarked routes are denied.

**The permission registry, made real.** 193 permissions generated from the contract and seeded by
[migration 0022](../contracts/schema/0022_permission_registry.sql); 19 flagged high-risk; all seven
of doc 02's high-risk categories mapped and checked. Contract check 8 compares the seeded rows
against the contract field by field, so a permission seeded as ordinary when the contract calls it
high-risk fails the build.

**Eleven system roles**, expressed as rules over the registry rather than as eleven hand-written
lists — because the registry grows every phase and eleven lists are eleven things to forget.
A test asserts that every action and every resource in the registry is classified, so a Phase 5
permission cannot silently belong to nobody.

**Identity.** scrypt passwords at OWASP's 2024 parameters, opaque revocable session tokens, refresh
rotation with reuse detection, TOTP against the RFC 6238 vectors with step-level replay defence, and
AES-256-GCM at rest for the one credential that cannot be hashed.

**The domain surface.** Organizations, legal entities (each created with its primary accounting
book), branches, versioned accounting policies, number sequences with concurrency-safe allocation,
fiscal years and period generation, the period lifecycle, currencies, exchange rates, users,
invitations, roles, memberships, sessions, platform administration and the audit trail.

**Seventeen screens**, including the eleven doc 02 names. Every input labelled and tied to its error
message; status shown as a word rather than a colour; focus visible; targets at least 24 CSS pixels;
reduced motion honoured (ADR-0010).

## Decisions taken during this phase

| Decision                                                    | Why                                                                                                                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The application connects as `app_runtime`, not as the owner | The owner is a superuser in every standard PostgreSQL image, and a superuser bypasses RLS outright. Checked at boot and in `db:verify`.                            |
| The RLS exemption is a role, not a session setting          | A setting the application role can write is an exemption it can grant itself.                                                                                      |
| Opaque session tokens rather than self-contained JWTs       | ADR-0005 requires revocation to be immediate. That means reading the session row per request, which leaves nothing for a JWT to save.                              |
| A legal entity is created with its primary book             | Nothing else could create one, and activation requires it. doc 02's onboarding list says the same.                                                                 |
| High-risk permissions require MFA within 15 minutes         | ADR-0005 §3 ties the seven doc 02 categories to re-authentication. Enforced from the registry, so it applies to all 19 rather than to the ones someone remembered. |
| You cannot grant a permission you do not hold               | Otherwise `role.manage` is equivalent to every permission in the system: create a role holding them all, assign it to yourself.                                    |
| An administrator cannot approve or execute payments         | doc 02 marks both high-risk. One compromised account should not be able to add a vendor and pay it.                                                                |

## Findings raised while building

Six, recorded in [contracts/README.md](../contracts/README.md#findings-raised-after-deliverable-2).
Each was a gap between two documents that only became visible when something had to actually work.

| ID    | Finding                                                                           | Resolution                                           |
| ----- | --------------------------------------------------------------------------------- | ---------------------------------------------------- |
| F-601 | Permissions gating a condition _inside_ a route had nowhere in the registry       | `x-additional-permissions`; 5 codes recovered        |
| F-602 | No route bound a session to a tenant, though ADR-0005 requires two-step login     | `POST /auth/tenants/{id}/select`                     |
| F-603 | No route created a tenant, though Phase 1 must deliver "tenant/account creation"  | `POST /auth/signup`                                  |
| F-604 | Invite had no accept, so an invited user could never join                         | `POST /auth/invitations/accept` + `user_invitations` |
| F-605 | `branches` had no `settings`, so level 5 of a six-level chain had nowhere to live | migration 0026                                       |
| F-606 | Nothing could create a primary book, which activation requires                    | Created with the legal entity                        |

## Defects found and fixed while building

| Found by                    | Defect                                                                                                                                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A direct database probe     | **RLS was completely inert.** The application connected as a superuser, so the 0024 policies had no effect at all. The tables, the policies and the requirement rows all existed and looked correct.                                     |
| Reading 0006 §3             | **The Gate C privilege revocations had never been run anywhere.** They were a runbook comment plus a table of intentions. Migration 0025 executes them and `db:verify` re-checks the catalog.                                            |
| Reviewing my own migration  | The RLS bypass was a session setting the application role could set for itself.                                                                                                                                                          |
| `pnpm db:guards`            | **The guard suite passed while T14 was rejected by a fixture collision**, never reaching the constraint it exists to test. Scenarios now declare what must reject them.                                                                  |
| The same check, immediately | T7 expected `journal_lines_account_scope_fk`; the real constraint is `jl_account_scope_fk`.                                                                                                                                              |
| Running the suite twice     | **Four database tests were not repeatable.** They built names from the first 8 characters of a uuidv7 — a millisecond timestamp that repeats every ~65 seconds, not entropy. The same defect as Phase 0's slug collision, one file over. |
| Boot-time reconciliation    | `GET /admin/feature-flags` (Phase 0) had tables and no route. Found the first time the check ran.                                                                                                                                        |
| `pnpm dod:check` check 6    | Its own false positive: `operation.ts` quotes `@Operation('…')` in the message it prints when a route names an operation the contract lacks.                                                                                             |
| Writing the close rule      | The out-of-order guard blocked only `OPEN` periods while claiming to prevent postings that `SOFT_CLOSED` still allows.                                                                                                                   |
| First API request           | Every route 500'd. The dev runner is esbuild-based and does not implement `emitDecoratorMetadata`, so Nest could not infer any constructor parameter. Every injection is now explicit.                                                   |

## Deferred, deliberately

| Item                                | Why                                                                                                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Service principals for integrations | doc 02 lists them under authentication; no Phase 1 route uses one and `integration.manage` (Phase 9) owns that surface.                         |
| Password reset, passkeys, SSO       | doc 02 calls them roadmap explicitly.                                                                                                           |
| Sending the invitation email        | Phase 9 owns notification channels. The token is returned in the response meanwhile, which is what makes the flow usable rather than described. |
| Localization settings level         | Level 2 of the precedence chain resolves and contributes nothing until Phase 3 installs a package. The level exists; it is empty.               |
| Rate limiting and lockout           | Platform concerns, and the error taxonomy already reserves `RATE_LIMITED`.                                                                      |

## Next

Phase 2 — Accounting Kernel and General Ledger. The chart of accounts, dimensions, the posting
service and immutable posted journals. Two things Phase 1 leaves ready for it: the entity readiness
list is data, so Phase 2 adds "a chart of accounts exists" as a row rather than as an edit to a
chain of conditionals; and `journal.post_control` and `journal.post_to_adjustment_period` are
already in the registry, so the posting path has permissions to check rather than permissions to
invent.
