# 07 — Open Decisions

Questions the audit cannot answer alone. Each is an ADR seed: context, options, recommendation,
consequences. Ratified decisions move to `docs/adr/` in Deliverable 2.

**Sequencing.** D-01 through D-08 must be settled before migration 0001. D-09 through D-14 can be
settled during Phase 0.

---

## D-01 — Accounting framework and retained earnings policy

**Blocks:** Phase 2 (posting rules), Phase 5 (assets), Gate E.
**Findings:** [F-401](05_Missing_Requirements.md), [F-402](05_Missing_Requirements.md)

**Context.** The specification requires full financial statements, revaluation, impairment and
consolidation without naming an accounting framework, and offers "explicit closing journal" vs an
unnamed alternative for year-end rollover.

**Options.**
1. **IFRS default, local GAAP via multi-book.** Posting rules implement IFRS; jurisdictional
   divergence handled by Phase 10's parallel books.
2. **Framework-neutral, everything policy-driven.** Every framework-sensitive rule becomes a policy
   switch from day one.
3. **Defer.** Build the rules that both frameworks share; decide when a divergent case is reached.

**Recommendation: Option 1.** IFRS is the broadest single default for a global-generic first release,
it is what doc 11's multi-book mechanism was designed to accommodate divergence from, and doc 09's
revaluation model already presumes it (revaluation of PPE does not exist under US GAAP). Option 2
multiplies Phase 2's complexity for a benefit that arrives in Phase 10. Option 3 guarantees a rewrite,
because the divergent cases are in the asset and revenue rules that Phase 5 and Phase 10 build on.

**Retained earnings: derive at report time**, with an explicit closing journal available as a per-book
policy. Rationale in [F-402](05_Missing_Requirements.md).

**Consequences.** Every posting rule saying "according to book/local rule" gets a concrete IFRS
default. The Gate C projection-rebuild test must reproduce the RE derivation, so the derivation is
specified as part of the ledger read model, not the reporting layer.

---

## D-02 — Tenant and entity isolation mechanism

**Blocks:** migration 0001, Gate B, Gate C.
**Finding:** [F-003](01_Schema_Findings.md)

**Context.** Nothing structurally prevents a journal line referencing another entity's account. Doc 16
says application scoping is required and offers RLS as an optional additional layer.

**Options.**
1. **Composite foreign keys.** Composite unique keys on parents; children reference
   `(id, legal_entity_id, accounting_book_id)`.
2. **PostgreSQL RLS.** Session-variable tenant context, policies on every table.
3. **Domain-layer only.** Repository base class enforces scoping; tests prove it.
4. **Composite FKs + RLS.**

**Recommendation: Option 1 now, Option 4 later.** Composite FKs make cross-entity references
*impossible* rather than *unlikely*, cost nothing at runtime beyond wider indexes, and require no
connection-level session state — which matters because background workers, migrations and the report
engine all connect differently and RLS context is easy to forget in exactly those paths. Add RLS in
Phase 1 as defence-in-depth once the application scoping is proven.

Rejecting Option 3 as primary: it is what the blueprint has today, and it is why this finding exists.

**Consequences.** Every child table needs the parent's scope columns present — which F-002 already
requires for `journal_lines`. Wider FK indexes; measure under Gate H.

---

## D-03 — Journal line denormalisation

**Blocks:** migration 0001.
**Finding:** [F-002](01_Schema_Findings.md)

**Context.** `journal_lines` lacks entity, book, period and posting date. Every ledger read joins;
partitioning is foreclosed; retrofit requires a maintenance window on the largest table.

**Options.**
1. Denormalise all four columns now.
2. Keep normalised; rely on the join and a covering index on `journal_entries`.
3. Denormalise later if Gate H shows a problem.

**Recommendation: Option 1.** The cost is four columns on the write path, populated by the single
writer (the posting service) inside the transaction that creates them, and immutable thereafter
(F-004) so they cannot drift. The benefit is every ledger read, the partitioning option, and the
composite FKs D-02 needs. Option 3 is the trap: Gate H deliberately runs at production scale, which is
precisely when the migration becomes expensive.

**Consequences.** ~15% more storage on the largest table. The posting service must populate them; a
`CHECK` cannot verify agreement with the parent, so a deferred constraint trigger should.

---

## D-04 — Chart of accounts grain

**Blocks:** Phase 2, and every module that references `accounts`.
**Finding:** [F-007](01_Schema_Findings.md)

**Context.** `accounts` is book-scoped; `account_groups`, `dimensions` and `tax_codes` are
entity-scoped. Multi-book (Phase 10) would duplicate the entire chart per book.

**Options.**
1. **Entity-scoped `accounts`** + a separate `account_book_settings` for book-specific attributes.
2. **Keep book-scoped**, accept chart duplication, add mapping tables in Phase 10.
3. Organization-scoped shared chart with per-entity overrides.

**Recommendation: Option 1.** It restores a consistent grain across the setup tables, it means an
invoice line's `revenue_account_id` is resolvable from the invoice's entity (fixing half of F-019),
and it matches how doc 11 describes multi-book — "book-specific journal adjustments" and "chart
mapping", not chart duplication. Option 3 is attractive for the accountant-portal template use case
(doc 09) but conflicts with doc 02's "Each legal entity independently owns… chart".

**Consequences.** Change before Phase 2. Journal lines still record the book (per D-03), so
book-specific reporting is unaffected.

---

## D-05 — Document number allocation protocol

**Blocks:** Phase 2, Gate G.
**Finding:** [F-012](01_Schema_Findings.md)

**Context.** Doc 02 requires concurrency-safe allocation with no reuse of posted or voided numbers.
`number_sequences` has `next_number` and a `version` column but no protocol. PostgreSQL sequences are
gap-tolerant and therefore unsuitable — statutory invoice numbering in most jurisdictions must be
gapless.

**Options.**
1. **Pessimistic row lock.** `SELECT … FOR UPDATE` on the sequence row inside the posting transaction.
2. **Optimistic with retry** using the `version` column.
3. **Advisory lock** keyed on the sequence.
4. Reserve-ahead blocks per worker.

**Recommendation: Option 1.** Gapless numbering fundamentally requires serialisation at the point of
allocation; Option 1 states that honestly. Option 2 degrades badly under the contention it will
actually see (month-end invoice runs). Option 4 reintroduces gaps when a block is partially consumed.

**Consequences.** Concurrent posting serialises per sequence. Mitigate by allocating the number **as
late as possible** in the posting transaction (after all validation), so the lock is held briefly.
Gate H must measure posting throughput per sequence, and Gate G must test the contention case
explicitly.

---

## D-06 — User identity scope

**Blocks:** Phase 1, Phase 9 accountant portal.
**Finding:** [F-018](01_Schema_Findings.md)

**Context.** `users.email` is globally unique. `memberships` supports one user across many tenants.
The intent looks like global identity, but it is never stated, and the consequence — a person cannot
register twice with the same address — will look like a bug the first time it happens.

**Options.**
1. **Global identity, tenant membership only.** Confirm and document current behaviour.
2. **Tenant-scoped users.** `UNIQUE (tenant_id, email)`; separate account per tenant.
3. Global identity with tenant-scoped profiles.

**Recommendation: Option 1.** It is what the schema already implements, and it is what Phase 9's
multi-client accountant dashboard requires. Option 2 would force accountants to maintain one login per
client, which is the problem the portal exists to solve.

**Consequences.** Authentication is cross-tenant; authorization is entirely per-tenant. Gate B needs a
specific test: a user with memberships in tenants A and B, acting in A, cannot read B. Tenant
suspension must not lock the user out of other tenants. Email change affects all tenants — needs a
verification flow.

---

## D-07 — Allocation concurrency protocol

**Blocks:** Phase 3, Gate G.
**Finding:** [F-021](01_Schema_Findings.md)

**Context.** Nothing prevents over-allocating a payment or overpaying an invoice. Gate G tests both.

**Options.**
1. **Pessimistic locks + persisted balances + deferred sum constraint** (all three layers).
2. Optimistic version column on the target document.
3. `SERIALIZABLE` isolation for allocation transactions.

**Recommendation: Option 1.** The three layers fail independently: the lock prevents the race, the
persisted `amount_due` with `CHECK (>= 0)` catches a logic error, and the deferred trigger catches a
path that bypassed the service. Option 3 is correct but pushes retry handling into every caller and
performs poorly under the month-end contention this will see.

**Consequences.** Lock order must be consistent — payment then targets, targets in ID order — or
concurrent multi-invoice allocations deadlock. Document the order; test it in Gate G.

---

## D-08 — Money precision and rounding boundaries

**Blocks:** the first golden fixture, therefore Phase 2.
**Finding:** [F-051](01_Schema_Findings.md)

**Context.** Doc 01 requires rounding at "defined calculation boundaries" and never defines them. No
`currencies` table exists, so per-currency minor units and cash rounding have nowhere to live. Every
Gate C golden fixture silently encodes a rounding decision.

**Options.**
1. **Specify boundaries explicitly** before the first fixture.
2. Round only at presentation; store full precision throughout.
3. Let fixtures define behaviour empirically.

**Recommendation: Option 1.** Proposed boundary chain, applied in order:

```
line net        → round to currency minor unit
line tax        → round per tax component, then sum
document tax    → sum of rounded component amounts (never re-round the sum)
document total  → sum of rounded lines (never re-round)
base conversion → round after multiplying by rate, per line
journal line    → already rounded; no further rounding
```

Default half-up, per-component override, `ROUNDING_ADJUSTMENT` posting to the accounting policy's
rounding account for any residual — with the posting service recording the originating calculation and
exact delta, as the posting rule catalog already requires.

Option 2 fails because tax authorities specify rounding at the invoice line, and a stored value that
disagrees with the printed invoice is a compliance problem.

**Consequences.** Add a `currencies` table (minor unit, cash rounding, symbol, position). Write the
rounding specification as a document before Phase 2. Every fixture then asserts a specified behaviour
rather than defining one.

---

## D-09 — Generic tables vs per-aggregate tables

**Finding:** [F-206](03_Coverage_Gaps.md)

**Context.** `payments`, `inventory_documents`, `ai_decisions` and `approval_workflows` each stand in
for 3–5 specified aggregates via a free-text discriminator.

**Recommendation.** Split **`payments` into `customer_receipts` and `vendor_payments`** — different
lifecycles, different FX treatment (F-022), different approval paths, and doc 05's payment run applies
to only one of them. Keep `inventory_documents` and `ai_decisions` generic; their shapes are genuinely
uniform. Keep `approval_workflows` generic with `version` as a column.

**Consequences.** More tables, but constraints become expressible as NOT NULL rather than as
application invariants Gate C cannot see.

---

## D-10 — Minimum PostgreSQL version

**Findings:** [F-017](01_Schema_Findings.md), [F-036](01_Schema_Findings.md)

**Context.** `UNIQUE NULLS NOT DISTINCT` is the clean fix for four nullable-column unique constraints
and requires PostgreSQL 15+. `EXCLUDE USING gist` for effective-dating (F-010) needs `btree_gist`,
available much earlier.

**Recommendation: PostgreSQL 16 minimum.** 15 is sufficient for the features needed; 16 gives headroom
and better logical replication for the Phase 9 read-replica reporting path. Both are widely available
on managed providers.

**Consequences.** Pin in Docker Compose and CI in Phase 0. Without it, every affected constraint needs
a pair of partial unique indexes instead — workable but noisier.

---

## D-11 — Performance baseline targets

**Finding:** [F-302](04_Unquantified_Requirements.md)

**Context.** Gate H names eight workloads and defines no targets, making it unfailable.

**Recommendation.** Ratify the proposed p95 table in
[04_Unquantified_Requirements](04_Unquantified_Requirements.md) §1 as a Phase 0 baseline against a
defined `reference` seed profile, revisable with evidence. The specific numbers matter less than
having a row Gate H can fail against.

**Consequences.** Phase 0 must ship the seed profiles and a benchmark harness. CI stores baselines;
regressions beyond a threshold fail the build.

---

## D-12 — Prisma and raw SQL boundary

**Context.** Doc 01: *"Prisma for ordinary CRUD; explicit SQL/transaction helpers where ledger
invariants, locking, or high-volume reporting require it."* The principle is right; the boundary is
not drawn, so it will be drawn differently by each module.

**Recommendation.** Draw it explicitly:

| Use raw SQL | Use Prisma |
|---|---|
| Journal posting (insert entry + lines + dimensions) | Setup and master data CRUD |
| Any `SELECT … FOR UPDATE` (sequences, allocations, cost layers) | Draft document CRUD |
| Ledger reads: TB, GL, P&L, BS, CF, aging | Simple filtered lists |
| Read-model rebuild | Admin and config screens |
| Bulk import commit | Single-row lookups |
| Anything inside a deferred-constraint transaction | |

Rule of thumb: **if Gate C, D, E or G tests it, it is raw SQL.** Prisma remains the schema source of
truth for types; raw SQL results are mapped to the same generated types.

**Consequences.** `packages/database` exposes both a Prisma client and a typed query helper. Migration
authoring stays in one place.

---

## D-13 — Scope and capacity

**Finding:** stated concern in the approved plan.

**Context.** The ratified decision is solo capacity, Phases 0–11 in strict order. This audit now
quantifies the scope: ~186 tables at full scope against 74 blueprinted; 260 pass/fail obligations;
27 of them currently unimplementable; 51 schema findings of which 10 are S1.

**This is not a request to re-scope.** It is the evidence base the plan promised, recorded so the
decision can be revisited from data rather than feel.

**Observations for a future review, not recommendations:**
- Phase 2 (kernel) is the best-specified and best-blueprinted phase — 90% schema coverage, and its
  exit criteria are the most concrete in the package. It is the right place to start and the least
  likely to surprise.
- Phase 3 is the largest single gap (29 missing objects) and carries AR, AP, procurement, tax and the
  document service in one phase. It is where a solo schedule will first come under real pressure.
- Phases 8 (AI), 9 (public platform, integrations, migration) and 11 (ERP extensions) are the phases
  whose value depends most on having customers, and least on being built early.

**Consequences.** None yet. Revisit after Phase 2 exits, when there is velocity data instead of
estimates.

---

## D-14 — Repository, branching and release model

**Finding:** [F-414](05_Missing_Requirements.md)

**Recommendation.** Trunk-based development with short-lived branches; semantic versioning applied to
the public API only (doc 15 requires it there and nowhere else); deprecation window of two minor
versions or 90 days, whichever is longer; conventional commits to drive the changelog that doc 15's
developer portal requires.

**Consequences.** Configure in Phase 0. Low cost, and it makes doc 15's changelog and deprecation
obligations automatic rather than manual.

---

## Decision status

| ID | Decision | Blocks | Status |
|---|---|---|---|
| D-01 | Accounting framework + retained earnings | migration 0001, Phase 2 | **Open — S1** |
| D-02 | Tenant/entity isolation mechanism | migration 0001, Gates B/C | **Open — S1** |
| D-03 | Journal line denormalisation | migration 0001 | **Open — S1** |
| D-04 | Chart of accounts grain | Phase 2 | **Open — S3** |
| D-05 | Number allocation protocol | Phase 2, Gate G | **Open — S2** |
| D-06 | User identity scope | Phase 1, Phase 9 | **Open — S2** |
| D-07 | Allocation concurrency protocol | Phase 3, Gate G | **Open — S1** |
| D-08 | Money precision and rounding boundaries | Phase 2 fixtures | **Open — S3** |
| D-09 | Generic vs per-aggregate tables | Phase 3 | Open |
| D-10 | Minimum PostgreSQL version | Phase 0 | Open |
| D-11 | Performance baseline targets | Phase 0, Gate H | Open |
| D-12 | Prisma / raw SQL boundary | Phase 0 | Open |
| D-13 | Scope and capacity | — | Recorded, no action |
| D-14 | Branching and release model | Phase 0 | Open |

**Four decisions (D-01, D-02, D-03, D-07) carry S1 findings and must be settled before any migration
is written.** Each has a recommendation above; none requires research to resolve, only agreement.
