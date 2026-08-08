# ADR-0008 — Platform baseline

**Status:** Accepted · 2026-08-07
**Resolves:** [D-10](../../audit/07_Open_Decisions.md#d-10--minimum-postgresql-version),
[D-12](../../audit/07_Open_Decisions.md#d-12--prisma-and-raw-sql-boundary),
[D-14](../../audit/07_Open_Decisions.md#d-14--repository-branching-and-release-model) ·
[F-017](../../audit/01_Schema_Findings.md), [F-036](../../audit/01_Schema_Findings.md),
[F-414](../../audit/05_Missing_Requirements.md)

## Decision

### 1. PostgreSQL 16 minimum

Required features:

| Feature                             | Needed for                                                                                      | Since |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- | ----- |
| `UNIQUE NULLS NOT DISTINCT`         | F-017, F-036 — four unique constraints containing nullable columns, incl. global exchange rates | 15    |
| `EXCLUDE USING gist` + `btree_gist` | F-010, F-015, F-025 — effective-dated overlap prevention on rules, rates, periods, mappings     | 9.x   |
| `CONSTRAINT TRIGGER … DEFERRABLE`   | ADR-0003 — commit-time journal balance assertion                                                | 9.x   |
| Composite foreign keys              | ADR-0002                                                                                        | —     |

15 would suffice; **16** is chosen for headroom and better logical replication, which the Phase 9
read-replica reporting path will want. Both are standard on managed providers.

Pinned in `docker-compose.yml` and CI in Phase 0. Without `NULLS NOT DISTINCT`, every affected
constraint needs a pair of partial unique indexes — workable, but noisier and easy to get wrong.

### 2. Prisma / raw SQL boundary

Doc 01's principle — "Prisma for ordinary CRUD; explicit SQL where ledger invariants, locking, or
high-volume reporting require it" — is right but undrawn, so each module would draw it differently.

| Raw SQL                                                                       | Prisma                          |
| ----------------------------------------------------------------------------- | ------------------------------- |
| Journal posting (entry + lines + dimensions in one transaction)               | Setup and master data CRUD      |
| Any `SELECT … FOR UPDATE` — sequences, allocations, cost layers, period locks | Draft document CRUD             |
| Ledger reads: TB, GL, P&L, BS, CF, aging                                      | Simple filtered lists           |
| Read-model rebuild                                                            | Admin and configuration screens |
| Bulk import commit                                                            | Single-row lookups              |
| Anything inside a deferred-constraint transaction                             |                                 |

**Rule of thumb: if Gate C, D, E or G tests it, it is raw SQL.**

Prisma remains the schema source of truth for generated types; raw SQL results map to those same
types, so there is one type definition per table regardless of access path. `packages/database`
exposes both clients behind one module.

### 3. Repository, branching and release

- **Trunk-based** development, short-lived branches, no long-running release branches.
- **Semantic versioning on the public API only** — doc 15 requires versioning there and nowhere else.
  Internal packages are versioned by commit.
- **Deprecation window: two minor versions or 90 days**, whichever is longer. Measured from the
  deprecation notice appearing in the developer portal changelog.
- **Conventional commits**, which generate the changelog doc 15's developer portal requires.
- Migrations are forward-only in production. Rollback is a new forward migration, per doc 16's
  "Prefer roll-forward compatible migrations".

### 4. Migration conventions

- One migration per bounded context per change; never a single monolithic file.
- Additive first: add nullable → backfill → enforce constraint, in separate migrations, per doc 16.
- Every migration that changes financial data carries a before/after reconciliation query in its
  description.
- Migrations are tested against both an empty database and the `reference` seed profile (ADR-0009).

## Consequences

- Managed PostgreSQL 16 is a deployment prerequisite; noted in the Phase 0 infrastructure setup.
- Two data access paths mean two testing approaches: Prisma paths are unit-testable with a mock,
  raw SQL paths require a real PostgreSQL integration test. Doc 19 already mandates the latter.
- The `NULLS NOT DISTINCT` dependency should be revisited if a target deployment cannot offer 16 —
  the fallback is documented above and costs only verbosity.
