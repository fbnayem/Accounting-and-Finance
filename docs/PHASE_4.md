# Phase 4 — Banking, Cash, Clearing and Reconciliation

**Status:** complete · 2026-08-14
**Defined by:** [21_Phased_Implementation_Plan.md](<../project plan/21_Phased_Implementation_Plan.md>) Phase 4

Builds on [Phase 3](PHASE_3.md). 28 of the contract's 312 operations are Phase 4, and all of them are
implemented; the API refuses to start if any is missing a handler.

The phase's governing constraint comes from doc 21's own dependency rules: _"Phase 4 banking consumes
AR/AP payment allocation services instead of editing customer/vendor balances."_ So nothing in
[`@acct/banking`](../packages/banking) writes `amount_due`, and nothing in it inserts a journal line.
Confirming a match records that a bank line explains a document; settling the document is an AR/AP
action with its own posting. Two places deciding what "settled" means is exactly the second
accounting engine `@acct/ledger` exists to prevent.

## Exit criteria — evidence

Doc 21 states five. [`banking.test.ts`](../apps/api/src/integration/banking.test.ts) is organised as
five `describe` blocks named after them, over real HTTP against the assembled application.

### 1. The same imported transaction cannot create a duplicate

| Attempt                                            | Result                                                |
| -------------------------------------------------- | ----------------------------------------------------- |
| Re-import a byte-identical statement file          | 0 imported, `replayed: true`, same statement id       |
| A row whose `provider_transaction_id` is on record | refused — 1 duplicate, the genuinely new row imported |
| Two identical same-day lines with no provider id   | **both imported**, the second flagged for review      |

The third row is F-028 and it runs the other way from the first two. doc 06 makes
`provider_transaction_id` the primary key and the fingerprint a _fallback_; the blueprint enforced
UNIQUE on the fingerprint only, so two genuine £4.20 coffees on one day collided and one was silently
dropped — which is how a reconciliation stops balancing for a reason nobody can find. A collision on
the fallback raises a review item. Only the bank telling us it is the same transaction refuses.

### 2. The statement closing balance equals the reconciled book balance

| Attempt                                            | Result                                                      |
| -------------------------------------------------- | ----------------------------------------------------------- |
| Complete a session with a difference of 900        | 422, naming the difference **and** the tolerance it missed  |
| Complete a session whose statement equals the book | completed, locked, and everything it cleared now RECONCILED |
| Complete it a second time                          | 409 `POSTED_IMMUTABLE`                                      |
| Reopen without a reason                            | refused; with a reason, reopened and the reason stored      |

doc 06 permits finalization "only when difference is zero/configured tolerance" and **nothing
enforced it** (F-801). It is enforced twice now: by the service, with the numbers named, and by
`guard_reconciliation_balanced` in migration 0038 against whatever reaches the table. The guard also
recomputes the difference rather than trusting the column, because a stored difference that disagrees
with its own operands is the failure mode a tolerance check cannot see.

### 3. Processor gross, fees and net settlement reconcile through clearing

Doc 06's own example — gross 100, fee 3, net 97:

| Account          | Movement |
| ---------------- | -------: |
| Payment clearing |     −100 |
| Bank             |      +97 |
| Processing fees  |       +3 |

The clearing account clears to exactly −100 against the receipts it held, the fee is an expense and
not a discount on revenue, and a batch whose gross does not decompose into fee and net is refused
(422) rather than posted and reconciled later. A chargeback reverses cash already recognised, on a
new journal — posted history is never edited.

### 4. An internal transfer does not double-count cash

| Attempt                                               | Result                                              |
| ----------------------------------------------------- | --------------------------------------------------- |
| Move 250 between two accounts                         | one journal, two legs, total cash unchanged         |
| Transfer to the same account                          | refused                                             |
| Same-currency transfer arriving as a different amount | refused — that is a fee or an error, not a transfer |

### 5. Matching suggestions never post without policy

| Attempt                                             | Result                                                       |
| --------------------------------------------------- | ------------------------------------------------------------ |
| Ask for candidates                                  | scored and ranked; the line stays `UNMATCHED`, nothing posts |
| Match more than the bank line is worth              | 422 `OVER_ALLOCATION`                                        |
| Split a line into parts that sum to it              | accepted; parts that do not, refused                         |
| Match the **parent** of a split beside its children | refused — `SPLIT_PARENT_NOT_MATCHABLE`                       |

`scoreCandidate` reports `exact` separately from `score`, and auto-confirmation requires both an
exact match and a policy that permits it. A 0.96 built from a near amount and a strong name
similarity is not a deterministic match, and doc 06 permits auto-matching only for one of those.

## Beyond the five

| Requirement                    | Evidence                                                                                                                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bank connector abstraction     | `bank_connections` stores a **secret-manager reference**, never a credential; the create endpoint has no field one could arrive in, and the list endpoint never returns the reference it holds |
| Import adapters                | CSV (header-driven), OFX (FITID as the provider id), QIF (no provider id, so the fallback applies). MT940 and CAMT053 refuse **with the reason** rather than pretending                        |
| Bank rule engine               | Ordered, versioned, and editable — F-806 added the lifecycle. Editing supersedes a rule with a new version rather than rewriting the one that classified history                               |
| Cash position                  | Every figure carries its source and its as-of date. A bank balance that has never been fed says "not fed" instead of borrowing the book's number                                               |
| Unreconciled/uncleared reports | F-807. The three populations a difference decomposes into — outstanding payments, deposits in transit, unmatched lines                                                                         |
| Split handling                 | The children sum to the parent (deferred constraint trigger), and the parent becomes unmatchable. Both halves of not double-counting cash                                                      |

## The gate chain

```
pnpm verify        exit 0 — format, lint, typecheck, contracts, DoD, 681 tests
pnpm dod:check     all 217 phase 0/1/2/3/4 operations have a handler, none orphaned
pnpm contracts:check  312 operations, 177 events, 220 permissions, 23 high-risk
pnpm db:verify     41 migrations, 246 tables, 1,573 constraints, 43 triggers, 305 functions, RLS on 77
pnpm db:guards     50 scenarios, each rejected by the constraint its own label names
pnpm bench         Gate H passed — 11 measured, 3 declared and not yet available
```

681 tests: 253 API, 168 domain, 121 subledger, 45 database, 24 UI, 23 banking, 17 testing, 12 ledger,
10 config, 8 contracts.

Gate H, `profile=small`, against a baseline re-recorded for this phase:

| Workload                        |   p95 | target |
| ------------------------------- | ----: | -----: |
| `bank-match-candidates-one-txn` | 3.9ms |  500ms |

Measured over 5,000 bank transactions, of which 1,891 are unmatched incoming lines and 489 mirror an
open document exactly. The measurement includes the scoring, not only the SQL: fifty candidates
through `scoreCandidate` is real work on the request path, and a benchmark that timed only the query
would report a number no caller experiences.

## What was built

**A banking package.** [`@acct/banking`](../packages/banking) holds import adapters, the matching
engine, reconciliation, treasury and account masters, with no framework in it — the same shape as
`@acct/ledger` and `@acct/subledger`, and for the same reason: the worker will sync feeds.

**A pure banking domain.** `normalizeText`, `fingerprintTransaction`, `scoreCandidate`, `reconcile`
and `decomposeSettlement` live in `@acct/domain` with no database and no clock. doc 06 specifies
dedupe and matching as _rules_, and a rule that can only be exercised through a database is a rule
nobody tests at its edges — 36 unit tests do.

**RLS on eleven banking tables**, registered in `rls_protected_tables`, plus tenant and entity
columns on the three that could not previously be scoped at all (F-802).

**Four screens**: bank accounts and connections, transactions and matching, reconciliation, cash
position.

**A banking benchmark dataset**, which turned the last declared-and-skipped Phase 4 workload into a
measured one.

## Decisions taken during this phase

| Decision                                                    | Why                                                                                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| A confirmed match does not settle the document              | doc 21's dependency rule. Two places deciding what settlement means is a second posting path                                               |
| `exact` is reported separately from `score`                 | doc 06 permits auto-matching only for a deterministic exact match; a high score built from a near amount is not one                        |
| MT940 and CAMT053 refuse rather than half-parse             | Both are region-specific and the first release is generic. A refusal with the reason is honest; a partial parse of a bank statement is not |
| The parent of a split is unmatchable                        | The children carry the cash. Enforced by a guard rather than by convention, because the convention is what fails at 4pm on a close day     |
| A benchmark declares the subject it needs                   | F-811. The seeder's check cannot see a database seeded by someone else, partially, or a stage ago                                          |
| The resumable seed picks the tenant with the largest ledger | F-812. Recency was the old rule; when it disagrees with the benchmark's own choice, a stage lands on an entity nothing measures            |
| Every list returns `{ data }`                               | F-814. The contract declares every 200 body an object, and a bare array has nowhere to put the `next_cursor` the contract already defines  |

## Findings raised while building

Eight (F-801…F-808), recorded in [contracts/README.md](../contracts/README.md). Three are schema gaps
that make a stated requirement unreachable — the tolerance rule nothing enforced, snapshots that
could not be tenant-scoped, splits with no integrity — and five are contract gaps found by trying to
drive doc 06's workflows end to end and running out of road: no way to create a settlement batch, no
way to reconcile one, no way to see unreconciled transactions, no way to charge back a cleared item
whose status the schema already modelled, no way to edit a bank rule.

## What the exit-criteria proofs found

Two more (F-809, F-810), in code with 656 passing tests.

F-809 is the one to sit with. `mapDatabaseError` turns a guard's message prefix into the error
taxonomy, and none of the banking prefixes were in the list — so `SPLIT_PARENT_NOT_MATCHABLE`, the
guard written that morning to stop split cash being double-counted, fired correctly and told the
caller "an unexpected error occurred". `OVER_MATCH` and `RECONCILIATION_LOCKED` had been raising
correctly since Deliverable 2's migration 0011 and were never mapped either: two working controls
whose refusals had been unactionable for two phases. doc 15 requires the API never leak internals, and
a control that surfaces as a 500 is indistinguishable from a bug.

Three of the failures were mine rather than the system's: the fixture book is **GBP**, so USD literals
produced "a USD line in a GBP book needs an exchange rate" from three tests at once; the error
envelope is top-level, not nested under `error`; and a supertest chain wrapped in an `async` helper is
a Promise, which has no `.expect`. The harness also had `payment_clearing_account_id` pointing at the
bank account, which would have made "the clearing account clears exactly" true of nothing.

## What Gate H's own output found

Two more (F-811, F-812). F-730 was fixed in Phase 3 by making the _seeder_ fail when it produces no
open items; seeding the banking dataset showed that to be one route out of several. A workload now
declares the population it needs and an empty one fails the gate instead of reporting a very fast
query over nothing.

F-812 is the same family. `loadFoundation` chose the most recently created seeded tenant and the
benchmark chooses the one with the most journal lines — and this database had two, because a full
seed had once failed after its first commit and left a complete chart of accounts with no ledger
behind it. 5,000 bank transactions went to the husk. Every number both sides printed was true and
none of them was about the same rows.

## What building the screens found

Two more (F-813, F-814). `BankReconciliationService.get` computes the working view — matched and
unmatched lines, the derived book balance, the difference and what explains it — and no route reached
it, so the difference was visible only in the error body of a refused completion. A reconciliation
screen has to show the difference _while_ you work it down.

F-814 is contract debt caught before it became public: all seven Phase 4 list endpoints returned a
bare JSON array, while the contract declares every 200 body as `{type: object}` and every other
collection in the system is enveloped. An array also has nowhere to put the `next_cursor` the contract
defines for "all large collections", which would have made pagination a breaking change.

## Deferred, deliberately

| Item                                   | Why                                                                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Live connector sync                    | Phase 9. `POST /bank-accounts/{id}/sync` takes the rows a provider would supply; what Phase 4 owns is what happens to them once they land |
| MT940 and CAMT053                      | Region-specific, and the first release is generic. Both refuse with that reason rather than half-parsing                                  |
| Bank charges and interest as workflows | The lines import and categorise; there is no scheduled accrual. doc 06 lists both, and neither is a Phase 4 exit criterion                |
| Automatic rule application on import   | Rules are created, ordered, versioned and evaluated; nothing applies them unattended. Exit criterion 5 is the reason to be slow here      |
| `bank_balance_snapshots` from a feed   | The table is tenant-scoped and read by cash position; only a live connector can write a real one                                          |

## Next

Phase 5 — Inventory, Fixed Assets, Projects and Budgets. Its benchmark workload
(`inventory-valuation-10k-items`) is declared and skipped, and `profiles.ts` declares 200 items for
`small` and 5,000 for `reference` — a `pnpm db:seed -- --only inventory` away once the tables exist,
with the subject check now failing the gate if that stage is forgotten.
