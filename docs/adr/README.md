# Architecture Decision Records

Ratified decisions for the Accounting Platform. Each ADR records a decision that constrains the
schema, the contracts, or the build; the full argument for most of them lives in
[audit/07_Open_Decisions.md](../../audit/07_Open_Decisions.md).

**Status of every ADR here: Accepted, 2026-08-07.**

| ADR                                                        | Decision                                                  | Resolves                               | Constrains                         |
| ---------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------- | ---------------------------------- |
| [0001](0001-accounting-framework-and-retained-earnings.md) | IFRS default; both retained-earnings methods offered      | D-01 · F-401, F-402                    | Every posting rule, Gate E         |
| [0002](0002-tenant-and-entity-isolation.md)                | Composite foreign keys; RLS later as defence-in-depth     | D-02 · F-003, F-040                    | Every table with a scope column    |
| [0003](0003-ledger-physical-design.md)                     | Denormalise scope onto journal lines; entity-scoped chart | D-03, D-04 · F-002, F-007, F-019       | Ledger kernel, all posting sources |
| [0004](0004-concurrency-protocols.md)                      | Pessimistic locks for numbering, allocation, cost layers  | D-05, D-07 · F-012, F-021, F-032       | Phase 2/3/5, Gate G                |
| [0005](0005-identity-scope.md)                             | Global user identity; tenancy via membership only         | D-06 · F-018                           | Phase 1, Phase 9 accountant portal |
| [0006](0006-money-precision-and-rounding.md)               | Explicit rounding boundary chain; `currencies` table      | D-08 · F-051                           | Every golden fixture               |
| [0007](0007-aggregate-table-granularity.md)                | Split `payments`; keep other generic tables               | D-09 · F-206, F-022                    | AR/AP schema                       |
| [0008](0008-platform-baseline.md)                          | PostgreSQL 16; Prisma/raw-SQL boundary; trunk-based       | D-10, D-12, D-14 · F-017, F-036, F-414 | Phase 0                            |
| [0009](0009-performance-baselines.md)                      | Ratified p95 targets and seed profiles                    | D-11 · F-302, F-303                    | Gate H, Phase 0                    |

## Not an ADR

**D-13 (scope and capacity)** is recorded as evidence in
[audit/07_Open_Decisions.md](../../audit/07_Open_Decisions.md#d-13--scope-and-capacity), not as a
decision. The ratified position is solo capacity, Phases 0–11 in strict order, revisited after
Phase 2 exits when there is velocity data rather than estimates.

## Convention

New ADRs are numbered sequentially and never edited after acceptance — a reversal is a new ADR that
supersedes the old one, with both left in place. Migrations and contract files reference the ADR that
justifies a non-obvious choice.
