# Phase 5 — Inventory, Fixed Assets, Projects and Budgets

**Status:** complete, with three items red at hand-over — named in [At hand-over](#at-hand-over) · 2026-08-15
**Defined by:** [21_Phased_Implementation_Plan.md](<../project plan/21_Phased_Implementation_Plan.md>) Phase 5

Builds on [Phase 4](PHASE_4.md). 53 of the contract's 331 operations are Phase 5 — 25 inventory, 16
assets, 12 projects and budgets — and all of them are implemented; the API refuses to start if any is
missing a handler.

The phase's governing constraint comes from doc 21's own dependency rules: _"Phase 5 inventory and
asset accounting use accounting events/posting rules."_ So neither [`@acct/inventory`](../packages/inventory)
nor [`@acct/assets`](../packages/assets) writes a journal line. Every posting in this phase goes
through `DocumentPostingService` under a named rule — `INVENTORY_ISSUE_FOR_SALE`, `ASSET_ACQUIRED`,
`ASSET_DEPRECIATION`, `ASSET_DISPOSAL` and the rest — for the same reason Phase 4 refused to settle
documents from a bank match: a module that composes its own debits and credits is a second accounting
engine, and `@acct/ledger` exists so there is only one.

Phase 5 differs from every phase before it in one way worth stating up front. **Its findings were
raised by an audit run before the build, not during it.** Migrations 0012, 0013 and 0014 delivered 38
tables in Deliverable 2 and Phase 5 added none — what those files could not do, because Phase 5 had
not arrived, is make the tables safe to serve traffic from. Six lenses read doc 08, doc 09, doc 10 and
doc 21 against the schema and the contract; a second pass verified every claim against the files.
**82 verdicts, 4 refuted, 78 survived.** They are the register in
[contracts/README.md](../contracts/README.md), and they are why this phase opens with two migrations
and a contract change rather than with code.

## Exit criteria — evidence

Doc 21 states six. [`phase5.test.ts`](../apps/api/src/integration/phase5.test.ts) is organised as
`describe` blocks named after them, over real HTTP against the assembled application.

### 1. The inventory valuation report reconciles to the inventory GL control account

| Attempt                                              | Result                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| Two receipts, a FIFO issue, then a **transfer**      | valuation 286.00; control account 286.00                   |
| Read the difference through the reconciliation route | `difference` 0.00, `unexplained` 0.00, GL equals valuation |
| The same shape on a **weighted-average** item        | `difference` 0.00, `unexplained` 0.00 — after F-922        |

The weighted-average row is the one that earned its place. The first version of this proof used a FIFO
item only, and the criterion says "inventory valuation", not "FIFO valuation" — two of the four
valuation methods are implemented, and a criterion proved on half of them is proved on none, because
the half left out is where the harder arithmetic lives. Run against weighted average, the criterion
failed by **−10.40** on a scenario with no rounding anywhere in it, so that difference was pure
accounting error rather than a cent of arithmetic. That is F-922, and it is fixed.

The transfer is in the scenario deliberately. A transfer posted as an issue plus a receipt leaves both
figures self-consistent and both wrong, and only a criterion that spans one notices — which is also
why F-918 makes a TRANSFER whose movements do not net to zero per item a database-level refusal
rather than a service convention.

The reconciliation route is asserted field by field. `body.difference ?? 0` would read `undefined` on
a renamed field, default to zero and pass while measuring nothing, which is the exact failure this
suite exists to prevent.

### 2. Negative stock behaviour follows the configured policy under concurrent issues

| Attempt                                          | Result                                           |
| ------------------------------------------------ | ------------------------------------------------ |
| 40 on hand, two issues of 30 posted **together** | exactly one 200; the other refused, naming stock |
| On-hand after the race                           | 10, and never negative                           |

Both drafts exist before either posts, so the contention lands on the posting path where the cost
layers are locked — which is where ADR-0004 §3 says it must be resolved. The decisive assertion is the
last one: a refusal is worth nothing if the stock went negative anyway, and an implementation that
returned 409 and committed would pass every check above that line.

The on-hand **report** is read, not the `inventory_on_hand` table. 0012 marks that table a rebuildable
projection and the posting path deliberately does not maintain it, so reading it would have measured a
table nobody writes and called the zero a pass.

F-919 is what makes "configured policy" mean anything here. doc 08 states the policy per item and
location; it existed only as `accounting_policies.allow_negative_stock`, one entity-wide boolean, so
the criterion had exactly one thing to configure. Resolution order is now the item's per-entity
override, then the item, then the entity.

### 3. COGS is reproducible from the stored cost layers

| Attempt                                                | Result                                                    |
| ------------------------------------------------------ | --------------------------------------------------------- |
| Read the issue document, then its movement's breakdown | two consumption rows summing to 244.00                    |
| Compare that sum with the movement's own total         | equal — and equal to the 244.00 the journal actually used |

Read through the API, deliberately. A direct pool query returns **nothing** here: `runtimePool()` sets
no tenant GUC, so `app_current_tenant()` is null and 0042's row-level security correctly hides every
row. Reaching around the application to check the application's work would have meant either disabling
that isolation for the test or misreading its silence as an empty table.

The service reports its own `reproduces_movement_total` verdict, and that is checked **after** the
independent sum and never instead of it — a service that computes the flag from the same expression it
used to write the rows answers `true` no matter what the ledger says.

F-903 is why the criterion has a subject at all: 0012 comments `inventory_cost_consumptions` as "this
table is that reproduction path" and no route returned it.

### 4. Fixed asset cost and accumulated depreciation reconcile to GL

| Attempt                                                | Result                                            |
| ------------------------------------------------------ | ------------------------------------------------- |
| Capitalize a 12,000 asset                              | asset cost account 12,000.00                      |
| Run one period of depreciation (10 months, full month) | expense 1,200.00, accumulated −1,200.00           |
| Read `/reports/asset-reconciliation` per category      | cost difference 0.00, accumulated difference 0.00 |

Both sides of the reconciliation are asserted as real figures, not two zeroes agreeing: the subledger
column reads 12,000.00 and 1,200.00. The category row is asserted to exist first, because a lookup
that found nothing would leave every difference check with no subject and the criterion would pass by
measuring an empty list.

### 5. A depreciation rerun is idempotent for the same asset, book and period

| Attempt                                            | Result                                                                  |
| -------------------------------------------------- | ----------------------------------------------------------------------- |
| Rerun March with a **different** idempotency key   | expense unchanged; exactly one POSTED line, against exactly one journal |
| Capitalize a second asset into March and run again | its own POSTED run, in the same period, `lines_posted: 1`               |

The rerun uses a different `Idempotency-Key` on purpose. An idempotent HTTP replay would prove only
that the interceptor works; the criterion is about the **domain** refusing to depreciate the same asset
and period twice, which is a different claim and the one that protects the ledger.

The second row is the half a naive fix breaks, and it is the reason
[0046](../contracts/schema/0046_depreciation_run_key.sql) exists — see
[Decisions](#decisions-taken-during-this-phase). The journal count is asserted as well as the line
count, because the rerun hole F-916 closes is an **UPDATE** of the existing line: that leaves the count
at one while silently repointing it at a second journal.

### 6. Budget actuals derive from the posted ledger

| Attempt                                              | Result                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| Budget an account, approve it, read budget-vs-actual | `source: "journal_lines"`, actual 1,560.00, budget 2,000.00 |
| Compare the actual with the trial balance            | equal to the penny                                          |

The declared provenance is asserted — a later change that started summing documents would have to lie
there to pass — but the penny-level comparison is what proves it. A report that summed source documents
would agree only by coincidence, and would drift the moment a document posted differently from its own
totals, which is exactly what doc 10 forbids. `budget_lines` holds no actuals column and nothing writes
one.

## Beyond the six

| Requirement                         | Evidence                                                                                                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GRNI / accrual handling             | A goods receipt debits the destination and credits GRNI; the bill now debits **GRNI**, not the destination again. Proved by a receipt-to-bill run asserting the destination carries 100 once and GRNI nets to zero |
| Receipt accrual posted once         | `postDocument` branches on `source_type = 'goods_receipt'`: a GR-backed inventory receipt writes movements and layers and posts **no second accrual**, linking to the journal Phase 3 already posted               |
| Landed-cost allocation              | VALUE / QUANTITY / WEIGHT / VOLUME through the largest-remainder helper, so parts sum exactly to the document amount; MANUAL refuses a split that does not sum                                                     |
| Commitment / encumbrance            | One commitment per PO line, written **inside** the approval transaction and checked per line interleaved with the INSERT — line 2 must see line 1's encumbrance                                                    |
| Budget control that actually blocks | `assertSpendAllowed` runs inside `approvePurchaseOrder`'s transaction under `SELECT … FOR UPDATE` on the budget. Falsified by disabling the lock: two concurrent approvals then both committed 1,200 against 1,000 |
| Closing a PO releases commitment    | F-106's `POST /purchase-orders/{id}/close` — releases the **unused** part only; 300 committed with 100 billed leaves `actual_posted 100`, `available 900`                                                          |
| Impairment and revaluation          | IAS 36 reversal cap enforced with all four numbers named in the refusal; IAS 16 surplus/P&L split. Neither touches `acquisition_cost` or `cost_basis`                                                              |
| Disposal                            | `disposalResult`'s gain/loss is verbatim the `dr_gain_loss_derived` CHECK expression, so the engine and the database cannot disagree                                                                               |
| Forecast snapshots                  | Versioned, superseding the prior PUBLISHED version, never touching the ledger                                                                                                                                      |

## The gate chain

```
pnpm dod:check        all 271 phase 0/1/2/3/4/5 operations have a handler, none orphaned
pnpm contracts:check  14 checks ok — 331 operations, 177 events, 227 permissions, 23 high-risk
pnpm db:guards        123 scenarios, each rejected by the constraint its own label names
pnpm bench            Gate H passed — 13 measured, 2 declared and not yet available
pnpm db:verify        FAILS on one index — schema.lock.json not re-snapshotted after 0046
pnpm test             854 of 856 pass — two failures, both named below
```

856 tests: 302 API, 251 domain, 121 subledger, 45 database, 24 UI, 23 assets, 23 banking, 17 testing,
12 ledger, 12 projects, 10 config, 8 contracts, 8 inventory.

The schema, from `schema.lock.json`: **246 tables** (Phase 5 added none — 0012–0014 already held all
38), 1,643 constraints, 583 indexes, 51 triggers, 311 functions, and row-level security on **115**
tables, up from Phase 4's 77 by exactly the 38 that 0042 protects.

Gate H, `profile=small`, against a baseline re-recorded for this phase:

| Workload                           |   p95 | target |
| ---------------------------------- | ----: | -----: |
| `inventory-valuation-10k-items`    | 3.2ms | 5000ms |
| `inventory-fifo-cogs-reproduction` | 1.6ms | 2000ms |

Both were declared and skipped since Phase 0. Each now declares the population it needs (F-811): a
stocked on-hand position with open layers behind it, and a FIFO issue movement that has stored
consumption rows to reproduce its COGS from. An empty one reports `no-subject` and fails the gate
rather than reporting a very fast query over nothing.

The seeded dataset obeys the real engine — every FIFO issue's consumption rows come out of
`consumeFifo`, every weighted-average running value out of `weightedAverageCost` — because the whole
point of those two tables is that COGS is reproducible from them, and seeded rows produced by ad-hoc
arithmetic would make every reconciliation benchmark meaningless.

## What was built

**Two migrations, before any code.** [0042](../contracts/schema/0042_phase5_isolation.sql) is
isolation: `tenant_id` on the fourteen tables that had none, the composite scope-FK lattice that ADR-0002
calls the primary isolation mechanism, and row-level security on all 38 tables.
[0043](../contracts/schema/0043_phase5_guards.sql) is the controls doc 08, doc 09 and doc 10 state in
prose and nothing enforced. 73 new guard scenarios came with them.

**An inventory package.** [`@acct/inventory`](../packages/inventory) — items, warehouses and locations,
the five stock documents plus returns, posting and reversal, stock counts, landed cost, on-hand,
valuation and the inventory-to-GL reconciliation. Framework-free, the same shape as `@acct/banking`.

**An assets package.** [`@acct/assets`](../packages/assets) — categories, register, capitalization,
depreciation runs, impairment and revaluation, disposal, and the asset-to-GL reconciliation.

**A projects and budgets package.** [`@acct/projects`](../packages/projects) — projects, billing
proposals that raise an AR **draft** and never post revenue, budget versions, budget control, PO
commitments, and forecasts.

**Three pure engines in `@acct/domain`**, with no database and no clock: `costing.ts` (FIFO,
weighted average, landed-cost allocation), `depreciation.ts` (straight line and declining balance
across all five proration conventions, plus disposal arithmetic), and `budgeting.ts` (doc 10's
available-budget formula and commitment relief). doc 08's and doc 10's rules are stated as rules, and a
rule that can only be exercised through a database is a rule nobody tests at its edges.

**Five inventory screens**: items, warehouses, stock documents, stock counts, inventory valuation.

**Two benchmark workloads and the inventory seed stage** that turns them from declared into measured.

## Decisions taken during this phase

| Decision                                                                                    | Why                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A weighted-average issue's stored rows carry a **derived** unit cost, not the pool average  | doc 08 makes `inventory_cost_consumptions` the reproduction path. The rows already summed to COGS, but each row stored the pool average, so `unit_cost × quantity` did not equal the row's own `total_cost`. The COGS is still rounded once; that single figure is then split across the drawn-down layers by largest remainder and each row's unit cost derived from its own allocated cost |
| The weighted-average draw-down uses the FIFO walk itself                                    | Remaining quantities have to live on some layer, and `(received_date, id)` is the one order every reader agrees on. Sharing the walk rather than copying it means the two cannot drift                                                                                                                                                                                                       |
| `depreciation_runs_posted_uq` is **dropped** (0046)                                         | The run was never the invariant. See below                                                                                                                                                                                                                                                                                                                                                   |
| Posting is a separate act from creating a stock document                                    | F-902. A receipt is a physical fact recorded when it happens; its accounting date is a policy decision                                                                                                                                                                                                                                                                                       |
| `inventory.reverse` is its own permission, and neither it nor `inventory.post` is high-risk | F-921. A permission's high-risk flag is inherited by every operation sharing its code                                                                                                                                                                                                                                                                                                        |
| Budget control is enforced inside the approval transaction, per line                        | F-106. A check outside the transaction that performs the write is a race, not a guard — and line 2 must see line 1's encumbrance                                                                                                                                                                                                                                                             |
| A billing proposal produces an AR **draft** and never posts                                 | doc 10. The project module is not a second revenue-recognition path                                                                                                                                                                                                                                                                                                                          |
| MT940-style honesty on unimplemented methods                                                | STANDARD and SPECIFIC valuation, `UNITS_OF_PRODUCTION` and `CUSTOM` depreciation, and DECLINING_BALANCE at `createAssetBook` all refuse with `NOT_IMPLEMENTED` and the reason, rather than falling back to a method the caller did not choose                                                                                                                                                |

### The dropped depreciation run key

This is the decision most likely to surprise someone reading the migrations, because **the audit
refuted it**. One lens proposed dropping `depreciation_runs_posted_uq`; the verifier refuted the
finding, correctly, on two grounds: a REVERSED run falls outside the index predicate, so the period is
not closed forever — reverse and repost — and the index is the audit's own F-037 prescription,
implemented column for column, whose whole purpose is that exactly one run may reach POSTED.

Building against it changed the picture. Exit criterion 5 has two halves, and the second — an asset
capitalized into a period that has **already** been run must still reach a POSTED run of its own —
was unreachable, not merely awkward. Month end is not an instant: a late vendor bill arrives on the
3rd, the asset is capitalized into the month just run, and that month's depreciation has to include it.
`@acct/assets` had to refuse the incremental run in so many words rather than let a unique violation
surface as a 500 at COMMIT (the F-809 lesson), which made the refusal honest and left the capability
missing.

Nothing in doc 09 says a period depreciates once. It says an **asset** depreciates once per period, and
that invariant is already structural in two places without the run key: `depreciation_schedule_lines`
UNIQUE `(asset_book_id, accounting_period_id)`, and `guard_depreciation_line_posted` from 0043, which
refuses any update or delete of a POSTED line and so closes the hole the UNIQUE cannot see. Together
they hold the criterion at the grain the criterion is stated at, and they hold it against the service
being bypassed entirely. The run-level key forbids nothing those two permit and additionally forbids a
legitimate second run.

0046 therefore proves both replacements against the live catalog before it drops anything — the UNIQUE
located **by its columns, not its name**, and the guard by function existence, trigger wiring, and
`tgenabled <> 'D'`, because a trigger that exists but is disabled enforces nothing. If either premise
is missing the DROP does not run. The behaviour is proved by T118–T123 and by two service-level tests
against real PostgreSQL, one of which drops the schedule-line UNIQUE, injects the duplicate it was
protecting against, asserts the service's own tripwire refuses with `POSTED_IMMUTABLE`, and restores the
constraint in `finally`.

The refutation was not wrong about the facts. It was reasoning about the schema; the criterion is about
what an accountant can do on the 3rd of the month.

## Findings

Twenty-one, F-901…F-921, recorded in [contracts/README.md](../contracts/README.md).

Eleven are contract gaps (F-901…F-911), found the way F-707…F-718 and F-805…F-808 were: by trying to
drive doc 08, doc 09 and doc 10 end to end and running out of road. Three of them are the same
sentence three times — **the criterion's own subject had no door.** No route created a warehouse
location, and `movement_direction_has_location` requires one on every movement, so no stock movement
could be created at all and three of the six criteria had no subject (F-901). No route posted an
inventory document, so nothing ever reached the ledger (F-902). No route returned a cost breakdown,
and criterion 3 is about exactly that table (F-903).

Three are isolation gaps (F-912…F-914) and they are Phase 4's F-802 and F-804 at a larger scale:
fourteen tables with no column for the ADR-0002 policy to sit on, six declared scope keys that nothing
referenced, and no row-level security anywhere in the 38.

Six are controls stated in prose and enforced by nothing (F-915…F-920): posted movement immutability,
depreciation idempotency against the UPDATE path, the amounts of an approved budget, a transfer that
nets to zero, the negative-stock policy at doc 08's grain, and Gate C's privilege layer.

F-920 carries a detail worth reading. Phase 4's 0038 **registered** two DELETE revocations in
`schema_guard_requirements` and never executed them, and `db:verify`'s privilege check was hardcoded to
three requirement ids, so it reported them in force. 0006's original defect — "a table of intentions" —
recurring two deliverables later. 0043's sweep executes anything registered with `applied_at IS NULL`,
which caught Phase 4's pair as well as its own: **the effective date of `revoke_bank_transaction_delete`
and `revoke_reconciliation_delete` is 0043's application, not 0038's.**

### What the audit refuted

Four of the 82 verdicts. Recording them because a refutation is evidence too:

- The depreciation run key, above — refuted, then overturned by execution.
- "Asset categories and asset books have no route" — true when the lens read the file and false by the
  time the verifier did, because a parallel lens had added F-904 mid-session. One fragment survives and
  is carried forward: there is still no PATCH on a category or an asset book, so an account mapping or
  a life estimate can be set once and never revised.
- "There is no asset-to-GL reconciliation route" — same cause; F-911 had landed. One fragment survives:
  `asset_transactions` is keyed by `posting_date` with no `accounting_period_id`, while
  `depreciation_schedule_lines` is keyed by period, so accumulated impairment and accumulated
  depreciation as-at a period are computed on two different axes. That is F-720's shape.
- "Partial and component disposal remain unmodelled" — already F-034, S4, closed as no-action by doc 09's
  own deferral and already stated in 0013's header.

### What integration found after the audit

Three, and two of them are instruments that reported success about something they were not measuring —
the shape this codebase keeps meeting (F-620, F-622, F-729, F-811).

**F-921.** `inventory.post` guarded both posting and reversing a document. Marking reversal high-risk
made routine posting high-risk too, and put it out of reach of the Inventory Manager whose daily work it
is. Two corrections: the codes were split so a tenant can grant posting without granting correction, and
the flag was removed — high-risk means doc 02's seven named categories, and `journal.reverse`, a strictly
more powerful act on the ledger itself, has never carried it. Found by the role-template test.

**The permission-registry generator reported "registry is complete" while the registry and the contract
disagreed about a risk classification.** It compared descriptions and never compared `is_high_risk` — the
one field that decides who may hold a permission and whether holding it demands re-authentication.
`contracts:check` caught the drift, which is the right outcome, but a generator that reports completeness
about a field it never reads is the failure above. It now compares the field and emits reclassifications
in their own section of the generated migration, and the static reader that reconstructs the accumulated
seed understands them — without that, a reclassification applied by migration is invisible to every check
that reads those files, and the contract check reports drift that has in fact already been corrected,
which trains people to ignore it.

**T15 had been inert since Phase 2.** A bare SELECT in the guard suite that printed a row and asserted
nothing, so period resolution with an adjustment period present — F-403 — could have regressed silently
for three phases. It was visible only as the difference between 117 labelled scenarios in the file and
116 the runner counted as asserted. The runner now fails outright on any labelled scenario that declares
no expectation: the point of putting the expectation in the label is that the suite and its pass criteria
cannot drift apart, and a label that declares nothing is a hole in that rather than an exemption from it.

## At hand-over

Three things are red, all outside this record's ownership, all one-line or one-command fixes:

| What                                                                                                               | Fix                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm db:verify` — one index of drift, `depreciation_runs_period_idx` added and `depreciation_runs_posted_uq` gone | `pnpm --filter @acct/database migrate:snapshot`, once. All 48 migrations are applied and no other check fails                                   |
| `role-templates.test.ts` — `unclassifiedActions()` returns `['close']`                                             | `ACTION_TIER` needs `close: 'OPERATE'`. Until then only Owner holds `purchase_order.close`, because Owner bypasses the tier                     |
| `subledger.test.ts:609` — creates account code `1400`, 422                                                         | The shared harness CHART now seeds `1400` as Inventory. The test must use a code of its own; this is test collision, not a defect in the system |

## What is NOT done

The audit's surviving verdicts were deduplicated into F-901…F-920 where Phase 5 resolved them. The rest
were confirmed and **carried forward**, and they are listed here rather than left to be rediscovered.

### The one that cost money — F-922, now fixed

This section described an open defect when it was written. It was closed before hand-over, and the
account of it is kept because how it was found matters more than that it is gone.

**A weighted-average issue permanently unbalanced inventory against its GL control.** `consumeStock`
derived the pool value as the sum of remaining quantity times each layer's **receipt** cost, while
doc 08's weighted average carries value as the source of truth. The two stopped agreeing at the first
WA issue: the journal credited Inventory at the average-based COGS while the layers lost value at
receipt cost. `reports.service.ts` valued inventory from the layers, so the gap landed in `unexplained`
and none of the four reconciling items covered it.

On doc 08's own worked run — 655.00 received, issues of 120, 160 and 20 — the service charged
254.40 + 365.33 + 50.00 = **669.73 against 655.00 received**, leaving the control account at −14.73 with
zero stock on hand. The correct run is 254.40 + 356.09 + 44.51 = 655.00.

**How it was found is the point.** Exit criterion 1 was green, and green because its scenario was FIFO.
Nothing in the suite was wrong; the suite simply never asked the question on the other implemented
valuation method. It surfaced twice independently — once by an agent reading the costing path, once by
extending the criterion to a weighted-average item, where it failed by exactly −10.40 on a scenario
containing no rounding at all.

**The resolution takes no new state and re-prices nothing.** Pool value is received value minus issued
value — `Σ(original_quantity × unit_cost)` over the item's layers less `Σ(total_cost)` over its
consumption rows — both already stored, both already immutable, and both already the reproduction path
doc 08 designates for criterion 3. Deriving from them means the valuation cannot drift from the rows
COGS is reproduced from. The two alternatives were rejected deliberately: carrying a new value column
adds state that can itself go stale, and re-pricing the remaining layers to the new average after each
issue is refused outright by 0043's `guard_cost_layer_immutable`, which is right to refuse it — a layer
records what was received.

The valuation report branches on the effective method for the same reason: a FIFO layer's unit cost
**is** what was paid for the units still in it, so `Σ(remaining × unit_cost)` is correct there and only
there. `ROUNDING_RESIDUE_CONSUMED_LAYERS` is now scoped to non-WA layers, because a WA layer's
received-minus-consumed difference is already inside the valuation and counting it twice would push
exactly that amount back into `unexplained`.

Proved by `apps/api/src/integration/phase5.test.ts` over HTTP, and by a unit suite that runs doc 08's
golden numbers through the real production functions and asserts `received − Σ COGS === pool value`
after **every** movement — not only at the end, because a defect that cancels out by the final issue is
still wrong at every intermediate balance sheet.

### The one still open — reversal of a weighted-average issue

Found while fixing F-922 and **not** fixed, because it needs a schema change rather than a service one.

`restoreConsumedLayers` restores layer quantities but records no offsetting consumption fact, and
`inventory_cost_consumptions` carries `CHECK (quantity > 0)`, so a negative restoration row cannot be
written at all. After reversing a WA issue the reversal journal restores the GL by the reversed COGS,
but received-minus-issued stays short by it — a valuation-versus-GL gap no reconciling item names.

It is not a regression: under the old expression the two happened to re-agree after a _full_ reversal
while disagreeing between the issue and the reversal, so neither shape handled both. **No test exercises
weighted-average issue reversal**, which is why it survived this long, and writing one is the first task
for whoever takes it — a stored restoration fact means a migration and a decision about whether a
consumption row may be negative or whether restoration belongs in a table of its own.

### Confirmed by the audit, unresolved

Twenty-one of the 78 surviving verdicts. The rest were resolved as F-901…F-920.

| Finding                                                                                                                                                                               | Where it stands                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Quantity has no unit binding.** `units_of_measure.conversion_factor` is referenced by nothing; a receipt in one UOM and an issue in another are added and consumed as the same unit | Movements store whatever `uom` string is given and convert nothing                        |
| **Lot, serial and expiry tracking are booleans no constraint reads**, and a movement carries at most one serial regardless of its quantity                                            | Chain of custody is optional in the schema; no route creates a serial unit                |
| **`items` has no weight or volume**, so two of the five landed-cost allocation bases the CHECK permits have no data                                                                   | WEIGHT and VOLUME are implemented in the engine and unusable in practice                  |
| **A project is a table, not a dimension value**, and `journal_lines` carries no project                                                                                               | doc 10's "Project P&L drills to ledger/source documents" has no join                      |
| **Nothing creates a time entry**, so a billing proposal's billable facts can only arrive out of band                                                                                  | `createBillingProposal` works; there is no route to give it anything to price             |
| **The project lifecycle is unreachable**: no route moves `projects.status`, no guard implements "closing blocks new cost", `project.closed` has no producer                           | Projects are created and listed and never close                                           |
| **`budget_lines.currency` is unconstrained against `budgets.currency`** and against the book's base currency                                                                          | Budget-versus-actual names both currencies so a mismatch is visible, and converts nothing |
| **A budget line cannot target an account group**, though doc 10 says it can and `account_groups` exists                                                                               | `budget_lines.account_id` is NOT NULL and there is no group column                        |
| **`budgets` uniqueness omits `fiscal_year_id` and `scenario`**, so next year's budget of the same name collides with this year's and Base/Best/Worst cannot be ACTIVE together        | The Scenario Comparison report is unreachable                                             |
| **Two ACTIVE budgets can cover the same account and period** with conflicting `control_policy` and nothing resolves which governs                                                     | The answer budget control gives depends on which row it reads                             |
| **`forecast_lines.accounting_period_id` has no foreign key**, and `report_columns` cannot name a forecast version for a FORECAST column                                               | Forecasts are created and listed; nothing consumes them                                   |
| **`inventory_cost_layers.warehouse_id` is nullable** — the exact key ADR-0004 §3's locking query and the FIFO index filter on                                                         | And `inventory_on_hand`'s primary key requires it NOT NULL                                |
| **`inventory_on_hand` carries no `accounting_book_id`**                                                                                                                               | A per-book valuation figure cannot be produced from it                                    |
| **`stock_count_lines.variance_quantity` is stored and never derived**                                                                                                                 | A posted count adjustment can move stock by an amount unrelated to what was counted       |
| **The landed-cost completeness trigger fires only on the allocations table**, so posting a landed cost with no allocations at all is accepted                                         | The engine's parts always sum; nothing stops a caller bypassing it                        |
| **`inventory_movements` has no `goods_receipt_line_id`**, though 0036 states Phase 5's movements will reference it                                                                    | The GRNI accrual and the stock movement it accrues have no key between them               |
| **Asset carrying amounts are free-floating numerics** with no guard and no derivation, and `disposal_records.carrying_amount` is never checked against the book it disposes           | The services derive them correctly; the database does not require it                      |
| **Nothing prevents depreciation being posted for a period after the asset book was disposed**, and a disposal need not change the asset's status                                      | Disposal flips remaining SCHEDULED lines to SKIPPED, by convention                        |
| **`at_controlled_needs_approval` promises approval and checks only that a reason string is non-null**                                                                                 | doc 02's "reason on every override" is met; the approval is not                           |
| **Asset transfers of department or cost centre have no from/to record and no history**                                                                                                |                                                                                           |
| **No arithmetic floor on an asset book** — accumulated depreciation may exceed the depreciable base                                                                                   |                                                                                           |

Two further items come from the fragments that survived the refutations above and are equally open: no
PATCH on an asset category or an asset book, and `asset_transactions` keyed by `posting_date` with no
`accounting_period_id`.

### Known gaps in what was built

- **No assets or projects screens.** The five screens this phase delivered are all inventory. The asset
  register, the depreciation schedule, budgets and budget-versus-actual are reachable over HTTP and have
  no interface.
- **Bills posted before the GRNI fix left GRNI credits standing and destinations double-debited.** The
  fix is prospective only; posted facts are immutable, so historical correction is a compensating entry.
- **Vendor credits derived from a receipt-matched bill still credit the destination, not GRNI** — the
  same defect on the credit side, not fixed.
- **Budget control double-counts between bill APPROVED and POSTED**, and between a posted goods receipt
  and the bill: the PO commitment stays open while the same money is already in `pending_approved_spend`
  or `actual_posted`. Conservative in direction, wrong in fact.
- **No outbox events for assets**, and `closePurchaseOrder` publishes nothing because
  `purchase_order.closed` / `.cancelled` are not in `events.yaml` — a budget release is invisible to
  downstream consumers. `reverseInventoryDocument` publishes `inventory.adjusted` for want of a
  dedicated event.
- **`relieveForPurchaseOrderLineInTransaction` uses `LIMIT 1`.** Nothing creates a PO line with two open
  commitments today; a UNIQUE would make that unrepresentable.
- **`depreciation_line_status = 'REVISED'` has no producer**, and could not work if it did: the
  per-period UNIQUE means a REVISED row cannot be superseded by a replacement for the same period.
  doc 09's "changes to estimate apply prospectively" is an in-place UPDATE of a SCHEDULED row (T106).
- **`depreciation_runs.version` can now collide.** It is `count(*) + 1` computed inside the INSERT, so
  two concurrent runs in READ COMMITTED both write the same version — made reachable by 0046, and
  previously masked because the second run failed anyway. Cosmetic rather than a correctness break: the
  runs still claim disjoint lines under `FOR UPDATE SKIP LOCKED`, no asset is charged twice, and the
  replay lookup breaks the tie deterministically. A unique index would turn a legitimate concurrent run
  into a 500, which is F-809's shape; the right fix is allocating the version under the period lock.
- **Provisional cost layers are created, consumed, transferred and reported, and nothing settles them.**
  No route re-costs a provisional layer at the true receipt cost.
- **Landed cost is not re-driven into COGS for layers already consumed** — it is surfaced as a named
  reconciliation item instead.
- **A duplicated stock receipt against the same goods-receipt line is not blocked at creation.** Each
  receipt is bounded by that line's accepted quantity; earlier receipts against it are not summed. It
  surfaces on the reconciliation.
- **`0013_assets.sql`'s own source text still overstates its guarantee.** It says the UNIQUE is "what
  makes Phase 5's depreciation rerun is idempotent for same asset/book/period structural rather than
  procedural". That is false twice over now: the run-level key is gone (0046), and the per-line UNIQUE
  alone cannot see the rerun that UPDATEs an existing POSTED line (F-916). 0043 corrected the **live
  catalog** with `COMMENT ON TABLE`, and 0046 does the same for `depreciation_runs`. The file text was
  not corrected because applied migrations are checksummed and forward-only (ADR-0008) — editing it
  would fail `db:verify` on the next run. **Anyone reading 0013 in the source tree is reading a claim
  the database no longer makes.**

## Deferred, deliberately

| Item                                                     | Why                                                                                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| STANDARD and SPECIFIC valuation methods                  | doc 08 names four; FIFO and weighted average are the two the criteria are stated against. Both others refuse with `NOT_IMPLEMENTED`         |
| DECLINING_BALANCE depreciation                           | The engine implements it; `asset_books` has no column for the annual rate, so `createAssetBook` refuses it. A schema gap, not a service gap |
| `UNITS_OF_PRODUCTION` and `CUSTOM` depreciation          | Deferred by doc 09 itself                                                                                                                   |
| Declining-balance to straight-line crossover             | A method variation doc 09 defers. The final period absorbs the geometric tail so the schedule still sums exactly to cost less residual      |
| Cost settlement and backdated recalculation              | doc 08's "late landed cost … according to chosen policy". The reconciliation names what is affected; nothing recomputes it                  |
| IAS 16 surplus transfer to retained earnings on disposal | Close-process territory, Phase 6. The surplus balance stays on the book row                                                                 |
| Automatic `FULLY_DEPRECIATED` status                     | Transitions implemented are DRAFT→ACTIVE, ACTIVE↔IMPAIRED, →DISPOSED/WRITTEN_OFF                                                            |
| Historical as-of inventory valuation                     | The report states current position. As-of would need movement-based reconstruction                                                          |

## Next

Phase 6 — Reporting, Approvals, Period Close and Audit Workspace. Its exit criteria will read the
subledgers this phase produced, and doc 21's dependency rule for it is the one Phase 5 has already been
living under: reporting code does not become a second accounting engine.

The weighted-average divergence should be settled first. It is the only item in this record that makes a
posted number wrong rather than a capability missing, and Phase 6's reports will read straight through
it.
