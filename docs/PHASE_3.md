# Phase 3 — Customers, Vendors, AR, AP, Tax Foundation and Documents

**Status:** complete · 2026-08-08
**Defined by:** [21_Phased_Implementation_Plan.md](<../project plan/21_Phased_Implementation_Plan.md>) Phase 3

Builds on [Phase 2](PHASE_2.md). 96 of the contract's 303 operations are Phase 3 — the largest phase
in the plan — and all of them are implemented. The API refuses to start if any is missing a handler.

This is the first phase that posts **through** the kernel rather than into it. An invoice does not
write journal lines; it raises an accounting event that a posting rule resolves. That constraint is
structural rather than advisory: [`@acct/subledger`](../packages/subledger) has no INSERT into
`journal_lines` anywhere in it, and every document reaches the ledger through `PostingService`.

## Exit criteria — evidence

Doc 21 states six. [`subledger.test.ts`](../apps/api/src/integration/subledger.test.ts) is organised
as six `describe` blocks named after them, over real HTTP against the assembled application, so the
mapping is in the test output rather than in a document that has to be kept in step with it.

### 1. AR and AP aging totals reconcile to their GL control accounts

| Assertion                                               | Result                                |
| ------------------------------------------------------- | ------------------------------------- |
| AR aging total after invoice, credit note and write-off | equals the AR control account balance |
| AP aging total after a bill is paid                     | equals the AP control account balance |

Both sides are exercised through their whole settlement vocabulary rather than through a single
posting, because the interesting failure is not "an invoice does not reconcile" — it is that a credit
note, a write-off or a payment moves one side and not the other. F-703 had made the AR half literally
unreachable: the CHECK read `amount_due = total - amount_paid`, and a write-off touched neither term.

The balance side reads `GET /reports/trial-balance` with `source: 'journal_lines'`, not the
projection — a reconciliation that trusts a read model to prove the read model is worth nothing.

### 2. The tax subledger reconciles to the tax control accounts

Reported output tax equals the output tax account balance. `tax_transactions` is written on the same
transaction as the posting, and F-720 made its `tax_period_id` a real column rather than a date-range
guess, so "what did we report" and "what did we post" are the same question asked twice.

### 3. Invoice post and reversal pass golden accounting tests

| Attempt                  | Result                                      |
| ------------------------ | ------------------------------------------- |
| Post an invoice          | Dr AR gross, Cr revenue net, Cr output tax  |
| Correct a posted invoice | Credit note — a new document, never an edit |
| `PATCH` a posted invoice | 409 `POSTED_IMMUTABLE`                      |

The third row is the one that matters. Doc 01 rule 4 is not a convention the services agree to
follow: `guard_posted_document_immutable` (migration 0036) freezes the financial columns of every
posted subledger document, and reads its frozen-column list against `information_schema.columns` so a
typo refuses to apply rather than silently freezing nothing.

### 4. Partial allocation and overpayment do not corrupt balances

| Attempt                                        | Result                                                    |
| ---------------------------------------------- | --------------------------------------------------------- |
| Two allocations that each fit, together do not | 422 `OVER_ALLOCATION` — the second is refused             |
| Overpay an invoice                             | The excess stays visible as unapplied, not absorbed by AR |

Over-allocation is a race, so it is tested by racing it, per ADR-0004. The second assertion is the
one people forget: money received and not yet applied is a liability, and hiding it in AR makes the
customer look settled while the entity still owes them the balance.

### 5. Three-way match flags quantity, price and tolerance violations

| Attempt                                                       | Result                                   |
| ------------------------------------------------------------- | ---------------------------------------- |
| Bill agreeing with its order and receipt                      | `MATCHED`                                |
| Bill a **linked** receipt line for more than it accepted      | refused outright by `grl_billed_bounded` |
| Bill more than was received, **not** tied to the receipt line | `EXCEPTION`, naming quantity             |
| Price above tolerance                                         | `EXCEPTION`, naming price                |
| Price within tolerance                                        | `WITHIN_TOLERANCE`                       |

Rows two and three were originally one test, and splitting them is the finding. Over-billing a linked
receipt line is not something matching detects — the database refuses the write, because
`quantity_billed <= quantity_accepted` is a CHECK. Matching exists for the case the CHECK cannot see:
a bill that never referenced the receipt at all. Asserting the exception names _quantity_ rather than
merely that an exception exists matters for the same reason: a match that flags the right bill for
the wrong reason sends somebody to check a price that was never wrong.

None of this was reachable before F-702 — `bill_matches.goods_receipt_line_id` pointed at
`inventory_movements`, which arrives in Phase 5, so a Phase 3 exit criterion had no receipt side.

### 6. The drill chain is complete

One test walks source document → accounting event → journal entry → general ledger report row, and
asserts each hop by following the identifier the previous hop returned rather than by re-deriving it.
It found two broken links (F-727, F-728) that every unit test had passed straight over.

## Beyond the six

| Requirement                             | Evidence                                                                                                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tax determination and rule versioning   | doc 07 and doc 20 both require a transaction to retain its original rule version; `tax_rule_versions` is effective-dated and the transaction records which version decided it |
| Tax period lifecycle                    | OPEN → PREPARING → READY → FILED → AMENDED, separate from the accounting period because jurisdictions file on their own cadence (F-717)                                       |
| A filed return is an immutable snapshot | Migration 0037, with guard scenarios T42–T44                                                                                                                                  |
| Realized FX on settlement               | ADR-0007: recognised **per allocation**, on the same journal as the allocation that caused it                                                                                 |
| Document numbering                      | Delegated to `@acct/ledger`'s `allocateNumber` — one sequence allocator, one audit trail (F-726)                                                                              |
| Attachments                             | Upload state machine (F-705) and a download that refuses a file whose scan has not returned CLEAN (F-718)                                                                     |

## The gate chain

```
pnpm test          580 tests
pnpm lint          clean
pnpm dod:check     8 mechanical checks, including all 189 phase 0-3 operations handled
pnpm contracts:check  14 checks — 303 operations, 177 events, 218 permissions, 22 high-risk
pnpm db:verify     38 migrations, 246 tables, 1,569 constraints, 40 triggers, 302 functions, RLS on 66
pnpm db:guards     43 scenarios, each rejected by the constraint its own label names
pnpm bench         Gate H passed — 10 measured, 4 declared and not yet available
```

580 tests: 215 API, 132 domain, 121 subledger, 45 database, 24 UI, 13 testing, 12 ledger, 10 config,
8 contracts.

Gate H, `profile=small`, against a baseline re-recorded for this phase:

| Workload                  |   p95 | target |
| ------------------------- | ----: | -----: |
| `ar-aging-50k-open-items` | 2.3ms | 2000ms |
| `ap-aging-50k-open-items` | 2.7ms | 2000ms |

Measured over 2,400 open items across 160 contacts, with the status mix and all five aging buckets
populated. That sentence is the whole of F-730: the same workloads reported _pass at 1.2ms_ for the
entire phase before the seeder produced anything for them to read.

## What was built

**A subledger package.** [`@acct/subledger`](../packages/subledger) holds tax determination, AR, AP,
sales, procurement, tax returns, localization, files and the aging reports, with no framework in it.
Built as a package for the same reason `@acct/ledger` was: the worker generates recurring invoices
and advances dunning stages, and its alternatives were an HTTP call back into its own API or its own
INSERT.

**One posting choke point.** Every document posts through `DocumentPostingService`, which is where
the accounting event is hashed, the idempotency check runs and the journal is resolved. That it is a
single function is what made F-725 a one-line fix instead of a nine-service one.

**Deterministic accounting event ids.** `accountingEventId()` hashes a readable event name
(`invoice.posted:<id>`) to an RFC 9562 v5 UUID under a fixed namespace, so call sites keep the name a
human can read and the column keeps the type its unique index needs.

**Seven screens**: customers, vendors, invoices, vendor bills, AR aging, AP aging and tax codes.

**A benchmark dataset for the subledger**, which turned two declared workloads into measured ones.

## Decisions taken during this phase

| Decision                                                        | Why                                                                                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounting event names are hashed, not renamed                  | The column is a `uuid`; the alternative was `invoice.posted:<id>` disappearing from every log and stack trace to satisfy a storage type                 |
| A goods receipt is a procurement fact, not a stock move         | F-702. The inventory movement is one of its consequences and arrives in Phase 5; three-way matching needs the receipt now                               |
| Over-billing a linked receipt line is a CHECK, not an exception | Structural refusal beats detection where the data model can express the constraint. Matching still covers the unlinked case, which no CHECK can see     |
| A failed payment is reversed, never unwound                     | F-724. The AP control account was already debited; a rejection that only reset the allocations left the entity reporting money it still held as spent   |
| The tax period is stamped when the transaction is written       | F-720. A date-range fallback cannot distinguish a late posting into a filed period from an on-time one, so a return could silently re-report or drop it |
| Seed data is written to tables, not through the services        | 50,000 posted invoices would seed 50,000 journals the profile does not budget for. Stated in the file rather than discovered later                      |

## Findings raised while building

Thirty-one, recorded in [contracts/README.md](../contracts/README.md). F-701…F-707 are schema gaps
that make a stated requirement unreachable; F-708…F-718 are contract gaps — something a module doc
requires with no route to reach it, each found by trying to drive a document lifecycle end to end and
running out of road.

F-719…F-723 are the familiar shape: a control that exists, is believed, and does nothing. F-719's
filed-return guard was attached to DELETE only, and nobody deletes a tax return. F-721's `useResource`
hook — behind every screen in the application — declared `useEffect(…, [deps, nonce])` with an array
literal at every call site, so it refetched continuously on every Phase 1 and Phase 2 screen, and its
only symptom was traffic. F-723 is the largest: **settlement never reached the general ledger at
all**, so exit criterion 1 failed by construction the first time anything was paid.

## What the exit-criteria proofs found

Five more (F-724…F-728), in code that had 121 passing subledger unit tests and 202 passing API tests.
The unit tests exercise pure line builders; the authorization tests receive their 403 before the
service is ever reached. Neither shape can observe a database.

F-725 is the one to sit with. `journal_entries.source_event_id` is a `uuid`, every subledger posting
passed a readable name, and so **no subledger document could post at all** — every invoice, credit
note, receipt, bill, goods receipt, vendor credit, expense claim and settlement failed on
`invalid input syntax for type uuid`. 562 tests were green throughout.

Three of the failures were mine, not the system's, and each is worth recording because in every case
the system was right: `POSTED_IMMUTABLE` maps to 409 and I asserted 422; three bills to one vendor on
one day for similar amounts is exactly what doc 05's duplicate detector exists to flag; and uuidv7
encodes a millisecond timestamp, so ids minted seconds apart share their first eight hex characters
and my "unique" invoice numbers built from `id.slice(0, 8)` were not unique.

## What Gate H's own output found

Three more (F-729…F-731), while re-running the benchmark to write this page. The benchmark defaulted
to `--phase 2`, so it reported "subject arrives in phase 3" about workloads Phase 3 had delivered —
the same hardcoded-copy defect Phase 2 fixed in `dod:check`, in a second place. With that opened, both
aging workloads passed at 1.2ms over empty tables. And once seeded, the identical dataset measured
22.4ms or 3.8ms depending on nothing but whether `ANALYZE` had run, which is precisely the variability
ADR-0009 §1's fixed seed exists to eliminate.

## Deferred, deliberately

| Item                                    | Why                                                                                                      |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Bank feeds, matching, reconciliation    | Phase 4. Settlement posts to the bank/cash account; nothing imports a statement yet                      |
| Inventory movements from goods receipts | Phase 5. The receipt is a procurement fact now; the stock consequence follows                            |
| Dunning execution and customer portal   | Phase 8. The stage model exists; the worker advances it, and nothing emails yet                          |
| Country tax packs                       | Out of scope for the first release, per the generic/global decision. The versioning abstraction is built |
| Partial vendor credits                  | `vendor_credits` has no line table, so a credit applies whole. Raised, not yet resolved                  |
| Payment run cancellation                | No cancel route; a run can be created and executed but not called off                                    |

## Next

Phase 4 — Banking, cash management and reconciliation. Its benchmark workload
(`bank-match-candidates-one-txn`) is already declared and skipped, and `profiles.ts` declares 5,000
bank transactions for `small` — with the seeder now resumable per stage, that dataset is a
`pnpm db:seed -- --only banking` away rather than a volume destroy.
