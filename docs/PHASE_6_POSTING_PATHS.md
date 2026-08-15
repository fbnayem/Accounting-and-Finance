# Phase 6 — every path by which a journal line reaches the ledger

**Status:** enumeration complete, read-only · 2026-08-15
**For:** Phase 6 exit criterion _"Hard-closed periods reject posting from every source module"_
**Method:** static enumeration of every writer of `journal_entries` / `journal_lines`, plus a
read-only probe of the live database for a period-status control at the storage layer.

This is not a description of Phase 6 close management. It is the work list close management has to
satisfy, because the criterion is a claim about Phases 2, 3, 4 and 5 simultaneously: each of them
added ways to write to the ledger, and one path that does not check the period lock is a hole that
only an enumeration finds. A per-module spot check is exactly how such a hole survives — and the
evidence below is that the project currently has less than a spot check: **three of the sixty-four
paths enumerated here have a closed-period test, nine of them have no period check at all, and no
module outside `@acct/ledger` has ever been tested against a closed period.**

---

## 1. The control, in one sentence

There is exactly one enforcement of period status in the entire system:
`PostingService.lockPeriod` ([`packages/ledger/src/posting.service.ts:264`](../packages/ledger/src/posting.service.ts)),
which takes `FOR SHARE` on the period row through `lockPeriodForPosting`
([`packages/database/src/transaction.ts:166`](../packages/database/src/transaction.ts)) and then
refuses `HARD_CLOSED` outright and `SOFT_CLOSED` unless the book's `closed_period_behaviour` is
`ALLOW_PRIVILEGED` **and** the principal holds `accounting_period.soft_close`.

It has **three call sites in the whole repository**:

```
$ grep -rn "\.lockPeriod(" packages/*/src apps/*/src --include=*.ts
packages/ledger/src/journal.service.ts:660:      await this.posting.lockPeriod(client, principal, period.id, book.closedPeriodBehaviour);
packages/ledger/src/journal.service.ts:761:      await this.posting.lockPeriod(client, principal, period.id, book.closedPeriodBehaviour);
packages/subledger/src/document-posting.service.ts:197:    await this.posting.lockPeriod(client, principal, period.id, book.closedPeriodBehaviour);
```

`journal.service.ts:660` is `JournalService.post`, `:761` is `JournalService.reverse`, and
`document-posting.service.ts:197` is `DocumentPostingService.post` — the funnel through which all 23
module posting call sites pass. That concentration is the system's strength: any path that reaches
one of those three is covered by construction, and the audit reduces to _"which writes do not reach
one of the three?"_

### There is no database backstop

Read-only probe against the live development database (51 migrations applied, `pnpm db:status`):

```
--- triggers on journal tables ---
journal_entries :: journal_entries_approval_threshold -> assert_journal_approval()
journal_entries :: journal_entries_balanced -> assert_journal_balanced()
journal_entries :: journal_entries_immutable -> guard_journal_entry_immutable()
journal_line_dimensions :: journal_line_dimensions_immutable -> guard_journal_line_dimension_immutable()
journal_lines :: journal_lines_account_postable -> assert_line_account_postable()
journal_lines :: journal_lines_base_currency -> assert_line_base_currency()
journal_lines :: journal_lines_immutable -> guard_journal_line_immutable()
--- functions mentioning a closed period status ---
(none)
--- CHECK constraints on journal_entries / journal_lines ---
journal_entries :: je_maker_checker
journal_entries :: je_posted_has_number
journal_lines :: jl_base_xor
journal_lines :: jl_nonneg
journal_lines :: jl_txn_xor
--- FKs from journal tables to accounting_periods ---
je_period_scope_fk: FOREIGN KEY (accounting_period_id, legal_entity_id) REFERENCES accounting_periods(id, legal_entity_id)
```

No trigger, no CHECK, no function anywhere in the schema mentions `HARD_CLOSED`, `SOFT_CLOSED` or
`period_status`. The only link from a journal row to its period is a scope foreign key, which pins
the entity and says nothing about status. `resolve_accounting_period`
([`contracts/schema/0004_periods_books.sql:124`](../contracts/schema/0004_periods_books.sql)) filters
on dates and `is_adjustment` only.

**Consequence for Phase 6:** the criterion cannot be met by testing the API alone, because nothing
below the API can catch a module that forgets. It is met by proving that every writer reaches
`lockPeriod`, or by adding the storage-layer control that would make forgetting impossible.

---

## 2. The enumeration

Legend

| Cell                   | Meaning                                                                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **resolves**           | `F-403` = `PostingService.resolvePeriod` (the normative resolver) · `named` = caller supplies a period id · `own SQL` = a private re-implementation · `—` = no period is resolved |
| **lock**               | `lockPeriod` = FOR SHARE + status enforced · `status read` = status read with no lock, advisory only · `—` = nothing                                                              |
| **same tx**            | is the check in the same transaction as the write it guards                                                                                                                       |
| **closed-period test** | a REJECT test that proves the refusal, named                                                                                                                                      |

The SQL guard suite (`pnpm db:guards`,
[`contracts/schema/tests/0006_guards_test.sql`](../contracts/schema/tests/0006_guards_test.sql)) has
**160 scenarios and not one of them is about period status** — necessarily, since the database holds
no such rule. So the last column names integration tests, and "none" means the path has no automated
closed-period proof of any kind.

### 2.1 `packages/ledger` — the kernel

| #   | path                                                                         | entry point                                                           | resolves                     | lock                                   | same tx                                 | closed-period test                              |
| --- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------- | -------------------------------------- | --------------------------------------- | ----------------------------------------------- |
| 1   | `loadBookContext` — book, base currency, policy, **`closedPeriodBehaviour`** | `posting.service.ts:103`                                              | —                            | —                                      | yes (caller's tx)                       | n/a — resolves no period                        |
| 2   | `resolvePeriod` — F-403 resolution                                           | `posting.service.ts:183`                                              | F-403 / `named`              | — (returns `status`, enforces nothing) | yes                                     | n/a                                             |
| 3   | `lockPeriod` — **the only enforcement**                                      | `posting.service.ts:264`                                              | —                            | `lockPeriod`                           | yes                                     | `ledger.test.ts:507`                            |
| 4   | `writeLines` — inserts `journal_lines`                                       | `posting.service.ts:447`                                              | — (takes `scope.periodId`)   | —                                      | yes                                     | none                                            |
| 5   | `commitPosting` — DRAFT → POSTED, projection, outbox, audit                  | `posting.service.ts:579`                                              | — (takes `options.periodId`) | — (trusts the caller)                  | yes                                     | none                                            |
| 6   | `JournalService.createDraft` — draft header + lines                          | `journal.service.ts:264` (resolve `:302`, write `:342`)               | F-403                        | **—**                                  | yes                                     | **none**                                        |
| 7   | `JournalService.updateDraft` — re-dates and rewrites lines                   | `journal.service.ts:390` (resolve `:415`, write `:452`)               | F-403                        | **—**                                  | yes                                     | **none**                                        |
| 8   | `JournalService.post` — manual journal                                       | `journal.service.ts:631` (resolve `:655`, lock `:660`, commit `:697`) | F-403 / `named`              | `lockPeriod`                           | yes                                     | `ledger.test.ts:507` REJECT · `:541` close-race |
| 9   | `JournalService.reverse` — manual + scheduled reversal                       | `journal.service.ts:714` (resolve `:757`, lock `:761`, commit `:838`) | F-403                        | `lockPeriod`                           | yes                                     | `scheduler.test.ts:117` REJECT · `:78` ACCEPT   |
| 10  | `RulesService.postOpeningBalanceSet`                                         | `rules.service.ts:515` → `journals.post` at `:544`                    | via #8                       | via #8                                 | **no — three transactions** (see F-6.6) | none                                            |
| 11  | `RulesService.createOpeningBalanceSet` — draft                               | `rules.service.ts:427` → `createDraft` `:472`                         | via #6                       | **—**                                  | yes                                     | none                                            |
| 12  | `RulesService.simulate` — preview                                            | `rules.service.ts:207` (resolve `:245`)                               | F-403                        | —                                      | read-only tx                            | n/a — writes nothing                            |

Row 5 is worth stating plainly: `commitPosting` is the single function that makes a journal POSTED,
and it does **not** check the period. It takes `options.periodId` from whoever called it. The
approval threshold and the control-account permission are checked there (`:597`, `:601`) precisely
because "a rule stated in four places is a rule three of them will eventually differ about" — the
period rule is the one rule that was left with the callers.

### 2.2 `packages/subledger` — AR, AP, procurement, sales, tax, documents

Every row below reaches `DocumentPostingService.post`, which resolves at `:193` and locks at `:197`
before inserting its header at `:200`. The `client` is always the caller's `writeInTenant`
transaction, so the lock and the write are atomic.

| #   | path                                                                                         | entry point                                                                                                       | resolves                   | lock                                                   | same tx | closed-period test                                  |
| --- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------ | ------- | --------------------------------------------------- |
| 13  | **`DocumentPostingService.post`** — the funnel                                               | `document-posting.service.ts:153`                                                                                 | F-403 `:193`               | `lockPeriod` `:197`                                    | yes     | **none** (only reached indirectly by #8/#9's tests) |
| 14  | Replay short-circuit — existing `source_event_id` returns the first entry                    | `document-posting.service.ts:168`                                                                                 | —                          | —                                                      | yes     | none                                                |
| 15  | AR — post invoice                                                                            | `ar.service.ts:653` → post `:707`                                                                                 | via #13                    | via #13                                                | yes     | none                                                |
| 16  | AR — void/credit a posted invoice                                                            | `ar.service.ts:1429` → `postCreditNoteFromCalculated:1627` → post `:1665`                                         | via #13                    | via #13                                                | yes     | none                                                |
| 17  | AR — post credit note (also `sales.postCreditNote:1038`)                                     | `ar.service.ts:1627` → post `:1665`                                                                               | via #13                    | via #13                                                | yes     | none                                                |
| 18  | AR — create + post customer receipt                                                          | `ar.service.ts:1861` → post `:2032`                                                                               | via #13                    | via #13                                                | yes     | none                                                |
| 19  | AR — allocate receipt (advance→AR reclass + realized FX)                                     | `ar.service.ts:2122` → post `:2204`, **guarded by `if (lines.length > 0)` `:2198`**                               | via #13                    | via #13                                                | yes     | none                                                |
| 20  | AR — apply credit note to invoice                                                            | `ar.service.ts:1740`                                                                                              | **—**                      | **—**                                                  | yes     | **none — writes no journal at all**                 |
| 21  | AP — post vendor bill                                                                        | `ap.service.ts:1010` → post `:1112`                                                                               | via #13                    | via #13                                                | yes     | none                                                |
| 22  | AP — post goods receipt (GRNI accrual)                                                       | `ap.service.ts:1373` → post `:1459`                                                                               | via #13                    | via #13                                                | yes     | none                                                |
| 23  | AP — create + post payment                                                                   | `ap.service.ts:1510` → `postPaymentJournal:1662` → post `:1740`                                                   | via #13                    | via #13                                                | yes     | none                                                |
| 24  | AP — allocate payment                                                                        | `ap.service.ts:1848` → post `:1923`, **guarded by `if (lines.length > 0)` `:1917`**                               | via #13                    | via #13                                                | yes     | none                                                |
| 25  | AP — confirm payment FAILED → compensating entries                                           | `ap.service.ts:1984`, **status read `:2088`**, post `:2111`                                                       | F-403 `:2088` **then** #13 | `status read` for the date, `lockPeriod` for the write | yes     | none                                                |
| 26  | Procurement — post vendor credit                                                             | `procurement.service.ts:881` → post `:960`                                                                        | via #13                    | via #13                                                | yes     | none                                                |
| 27  | Procurement — post expense claim                                                             | `procurement.service.ts:1428` → post `:1527`                                                                      | via #13                    | via #13                                                | yes     | none                                                |
| 28  | Procurement — execute payment run (N payments, one tx)                                       | `procurement.service.ts:1905` → `ap.postPaymentJournal` `:2055`                                                   | via #13 per payment        | via #13 per payment                                    | yes     | none                                                |
| 29  | Sales — AR write-off                                                                         | `sales.service.ts:1182` → post `:1240`                                                                            | via #13                    | via #13                                                | yes     | none                                                |
| 30  | Sales — customer refund                                                                      | `sales.service.ts:1336` → post `:1520`                                                                            | via #13                    | via #13                                                | yes     | none                                                |
| 31  | Sales — **recurring invoice generation**                                                     | `sales.service.ts:1737` / `:1763`                                                                                 | — (drafts only)            | **—**                                                  | yes     | **none — and nothing calls it** (F-6.7)             |
| 32  | Tax — `recordTransactions` writes the tax subledger                                          | `tax.service.ts:362`, called from `document-posting.service.ts:287`                                               | via #13                    | via #13                                                | yes     | none                                                |
| 33  | Tax returns — prepare / file / amend                                                         | `tax-return.service.ts`                                                                                           | tax periods only           | n/a                                                    | yes     | n/a — posts no journal                              |
| 34  | AR/AP draft creation (invoice, bill, goods receipt, credit note, expense claim, payment run) | `ar.service.ts:389`, `ap.service.ts:398`, `:1233`, `sales.service.ts:856`, `procurement.service.ts:1142`, `:1598` | —                          | **—**                                                  | yes     | n/a — no journal until posted                       |

### 2.3 `packages/banking`

| #   | path                                                    | entry point                                                             | resolves | lock    | same tx | closed-period test                    |
| --- | ------------------------------------------------------- | ----------------------------------------------------------------------- | -------- | ------- | ------- | ------------------------------------- |
| 35  | Bank transfer                                           | `treasury.service.ts:48` → post `:183`                                  | via #13  | via #13 | yes     | none                                  |
| 36  | Settlement batch reconciliation (clearing → bank, fees) | `treasury.service.ts:331` → post `:412`                                 | via #13  | via #13 | yes     | none                                  |
| 37  | Chargeback                                              | `treasury.service.ts:500` → post `:539`                                 | via #13  | via #13 | yes     | none                                  |
| 38  | Settlement batch creation (clearing items only)         | `treasury.service.ts:230`                                               | —        | —       | yes     | n/a — no journal                      |
| 39  | Statement import, matching, reconciliation              | `import.service.ts`, `matching.service.ts`, `reconciliation.service.ts` | —        | —       | yes     | n/a — read the ledger, never write it |

### 2.4 `packages/inventory`

| #   | path                                                                                                                                                                                 | entry point                                                                             | resolves                                                  | lock                                                 | same tx | closed-period test                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------- | ------- | -------------------------------------- |
| 40  | Post document — **journal branch** (ISSUE, ADJUSTMENT, COUNT, WRITE_OFF, CUSTOMER_RETURN, manual RECEIPT)                                                                            | `posting.service.ts:125` → post `:209` under `if (outcome.lines.length > 0)` `:208`     | via #13                                                   | via #13                                              | yes     | none                                   |
| 41  | Post document — **goods-receipt-backed RECEIPT**: stock + layers written, journal deliberately skipped                                                                               | `posting.service.ts:196-207`                                                            | **—**                                                     | **—**                                                | yes     | **none — no period check on any path** |
| 42  | Post document — **TRANSFER**: `applyTransfer` returns `lines: []` (`:871`), so no journal is posted                                                                                  | `posting.service.ts:125`, `:630`, `:806`                                                | **—**                                                     | **—**                                                | yes     | **none — no period check on any path** |
| 43  | Post document — **zero-cost movements**: `if (value.isZero()) continue` `:689`, `if (totalCost.isZero()) continue` `:776`; a document whose every line is zero-cost posts no journal | `posting.service.ts:645`, `:734`                                                        | **—**                                                     | **—**                                                | yes     | **none**                               |
| 44  | Reverse document — journal branch                                                                                                                                                    | `posting.service.ts:271` → post `:439` under `if (original.accounting_entry_id)` `:425` | via #13, plus **status read `:324-329`** to pick the date | `status read` (advisory), `lockPeriod` for the write | yes     | none                                   |
| 45  | Reverse document — original had no journal: mirrored movements and restored layers only                                                                                              | `posting.service.ts:271`, `:425`                                                        | **—**                                                     | **—**                                                | yes     | **none**                               |
| 46  | Landed cost capitalisation (unconditional post)                                                                                                                                      | `landed-cost.service.ts:48` → post `:233`                                               | via #13                                                   | via #13                                              | yes     | none                                   |
| 47  | Count approval → creates an inventory document                                                                                                                                       | `counts.service.ts:219` (insert `:280`)                                                 | —                                                         | **—**                                                | yes     | n/a — draft document                   |
| 48  | Document creation (receipt/issue/transfer/adjustment/return)                                                                                                                         | `documents.service.ts:69`, `:189`, `:268`, `:353`, `:429`                               | —                                                         | **—**                                                | yes     | n/a — drafts                           |

### 2.5 `packages/assets`

| #   | path                                           | entry point                                                                                                                                                           | resolves                                                         | lock                                                                | same tx | closed-period test |
| --- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------- | ------- | ------------------ |
| 49  | Capitalization (one journal per asset book)    | `capitalization.service.ts:41` → post `:129`                                                                                                                          | via #13                                                          | via #13                                                             | yes     | none               |
| 50  | **Depreciation run**                           | `depreciation.service.ts:134`; period **named** by the caller and loaded at `:139-150` with **no status check**; posts at `:324` with `postingDate = period.end_date` | `named` for the run row, **F-403 by date** for the journal (#13) | via #13 — on the period the **date** resolves to, not the one named | yes     | none               |
| 51  | Disposal                                       | `disposal.service.ts:164` → post `:243`                                                                                                                               | via #13                                                          | via #13                                                             | yes     | none               |
| 52  | Impairment / impairment reversal / revaluation | `valuation.service.ts:199`, `:265`, `:351` → `postValuationTransaction:492` → post `:518`                                                                             | via #13                                                          | via #13                                                             | yes     | none               |
| 53  | Asset transfer (location/custodian)            | `register.service.ts:556`                                                                                                                                             | —                                                                | —                                                                   | yes     | n/a — no journal   |

### 2.6 `packages/projects`

Nothing in this package posts. It reaches the ledger only through AR, and it reads posted lines for
budget actuals. Two writes are nonetheless period-scoped and unguarded.

| #   | path                                                                        | entry point                                                                                       | resolves                                       | lock  | same tx | closed-period test                        |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----- | ------- | ----------------------------------------- |
| 54  | Billing proposal → AR invoice **draft**                                     | `projects.service.ts:189` → `ar.createInvoiceInTransaction` `:275`                                | —                                              | **—** | yes     | n/a — journal only at `postInvoice` (#15) |
| 55  | **PO commitment (encumbrance)** — writes `commitments.accounting_period_id` | `commitments.service.ts:72` / `:96`, period resolved by **its own SQL** `:161-174`, insert `:202` | **own SQL** — a second implementation of F-403 | **—** | yes     | **none**                                  |
| 56  | Budget lines / forecast lines carry `accounting_period_id`                  | `budgets.service.ts:663-676`, `forecasts.service.ts:62-73`                                        | membership in the fiscal year only             | **—** | yes     | **none**                                  |

### 2.7 `apps/worker` — postings with no user request at all

The worker is `LedgerScheduler.tick` ([`apps/worker/src/ledger-scheduler.ts:68`](../apps/worker/src/ledger-scheduler.ts))
on an interval, constructed in `main.ts:158` and started at `:165` behind `LEDGER_SCHEDULER_ENABLED`.
`today` is the UTC process clock (`ledger-scheduler.ts:71`). The outbox drainer and the domain-event
worker (`main.ts:91-141`) write no ledger rows — the consumer logs and records
`processed_event_ids`, nothing else.

| #   | path                                                                                                   | entry point                                        | resolves                                    | lock                | same tx                                                               | closed-period test                                    |
| --- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------- | ------------------- | --------------------------------------------------------------------- | ----------------------------------------------------- |
| 57  | **Scheduled reversal** — claims PENDING rows cross-tenant, then `JournalService.reverse`               | `scheduler.ts:119`, reverse at `:153-158`          | F-403 on **`scheduled_date`**, not on today | `lockPeriod` via #9 | yes, inside `reverse`                                                 | `scheduler.test.ts:117` REJECT · `:78` ACCEPT         |
| 58  | Scheduled-reversal failure handling — `attempts+1`, `status = CASE WHEN attempts+1 >= 5 THEN 'FAILED'` | `scheduler.ts:173-195`                             | —                                           | —                   | own tx                                                                | asserts `attempts = 1` only (`scheduler.test.ts:150`) |
| 59  | **Recurring journal — occurrence reservation**                                                         | `scheduler.ts:260-264` via `reserveOccurrence:376` | —                                           | **—**               | **no — its own `withTransaction`, committed before the draft exists** | **none**                                              |
| 60  | **Recurring journal — draft generation**                                                               | `scheduler.ts:282` → `createDraft` (#6)            | F-403 on `next_run_date`                    | **—**               | yes (inside `createDraft`)                                            | **none**                                              |
| 61  | **Recurring journal — auto-post** (`auto_post && !requires_approval`)                                  | `scheduler.ts:308-309` → `journals.post` (#8)      | via #8                                      | `lockPeriod` via #8 | yes                                                                   | **none**                                              |
| 62  | Recurring journal — cursor advance                                                                     | `scheduler.ts:322-329`                             | —                                           | —                   | own tx                                                                | none                                                  |

**What period does worker output land in?** Not "today". A scheduled reversal posts on
`schedule.scheduled_date` (`scheduler.ts:156`) and a recurring journal on the template's
`next_run_date` (`scheduler.ts:244`, `:285`). Both are dates in the past whenever the worker was down,
the schedule was made long ago, or the month has turned — which is exactly when the target period is
likely to be closed. The refusal is correct in both cases; what happens **after** the refusal is where
the defects are (F-6.1, F-6.2).

The worker's authority is not the issue: `servicePrincipal` (`scheduler.ts:57`) is granted
`journal.view, journal.reverse, journal.post_control` for reversals and
`journal.view, journal.create, journal.submit, journal.post` for recurring journals (`:92-93`). It
holds **no** `accounting_period.soft_close`, so `lockPeriod:302` refuses it a SOFT_CLOSED period even
under `ALLOW_PRIVILEGED`. That is right, and it should stay that way.

### 2.8 Writers that bypass the kernel entirely (test and bench only)

| #   | path                                                 | entry point                                           | resolves | lock  | same tx | closed-period test |
| --- | ---------------------------------------------------- | ----------------------------------------------------- | -------- | ----- | ------- | ------------------ |
| 63  | Test seed writes POSTED entries and lines directly   | `packages/testing/src/seed/ledger.ts:151`, `:165`     | —        | **—** | n/a     | n/a                |
| 64  | Benchmark workload writes entries and lines directly | `packages/testing/src/bench/workloads.ts:213`, `:235` | —        | **—** | n/a     | n/a                |

Both run as the migration owner, so RLS and grants do not stop them. They are not production paths,
but they are the reason a Phase 6 storage-layer guard must be written as a trigger rather than a
privilege: a `REVOKE` would not have stopped either of these.

---

## 3. Findings

### 3.1 Paths with NO period check at all

Each of these writes state that a closed period is supposed to freeze, and reaches no `lockPeriod`.

| Id        | Path                                                                                                                 | Evidence                                                                                                                                                                                                                                  | What lands in a hard-closed period today                                                                                                                                                                                                                                                                                                                                                                                        |
| --------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F-6.1** | Inventory **TRANSFER** document posting                                                                              | `packages/inventory/src/posting.service.ts:125` → `:630` → `applyTransfer:806`, which returns `{ lines: [] }` at `:871`; `postDocument` posts only `if (outcome.lines.length > 0)` (`:208`)                                               | Cost layers consumed at the source warehouse and recreated at the destination, `inventory_movements` costed, document flipped to POSTED. The stock valuation report for a signed-off period changes after sign-off.                                                                                                                                                                                                             |
| **F-6.2** | Inventory **goods-receipt-backed RECEIPT** posting                                                                   | `posting.service.ts:196-207` — the branch deliberately posts no journal and links to the accrual Phase 3 already posted                                                                                                                   | New cost layers dated inside the closed period; inventory valuation moves with no journal and no check.                                                                                                                                                                                                                                                                                                                         |
| **F-6.3** | Inventory **zero-cost** movements                                                                                    | `posting.service.ts:689` (`if (value.isZero()) continue`), `:776` (`if (totalCost.isZero()) continue`)                                                                                                                                    | A document whose lines are all zero-cost produces `lines.length === 0` and takes the same no-check branch as F-6.1: quantities move, layers are created or consumed.                                                                                                                                                                                                                                                            |
| **F-6.4** | Inventory **reversal of a document that never posted a journal**                                                     | `posting.service.ts:271`, guard at `:425` (`if (original.accounting_entry_id)`)                                                                                                                                                           | Mirrored movements and restored layers, no journal, no period check — the reversal of an F-6.1 transfer is itself F-6.1.                                                                                                                                                                                                                                                                                                        |
| **F-6.5** | **Draft journals** (manual, opening balance, recurring) into a closed period                                         | `journal.service.ts:264` resolve `:302` → `writeLines:342`; `updateDraft:390` resolve `:415` → `writeLines:452`; `rules.service.ts:472`; `scheduler.ts:282`                                                                               | Real `journal_lines` rows carrying `accounting_period_id` of a HARD_CLOSED period. They do not reach the trial balance (`reports.service.ts:151`, `:209`, `:327` and `projection.service.ts:47` all filter `status IN ('POSTED','REVERSED')`), so this is not a balance defect — it is a close-integrity decision Phase 6 has to take explicitly, because `updateDraft` also lets a draft be **re-dated into** a closed period. |
| **F-6.6** | **Subledger-only state changes** — credit-note application, allocation batches whose settlement lines net to nothing | `ar.service.ts:1740` (no journal at all); `ar.service.ts:2198` and `ap.service.ts:1917` (`if (lines.length > 0)` skips the post while the `UPDATE customer_receipts` / `vendor_payments` and the target-document `amount_paid` still run) | AR/AP aging for a closed period moves with no journal and no period check, which is the control-vs-aging divergence Phase 3's first exit criterion exists to prevent.                                                                                                                                                                                                                                                           |
| **F-6.7** | **Project commitments** into a closed period, resolved by a private period resolver                                  | `packages/projects/src/commitments.service.ts:161-174` — inline `SELECT id FROM accounting_periods WHERE … BETWEEN start_date AND end_date AND NOT is_adjustment`, no `status`, not `resolve_accounting_period`                           | An encumbrance dated into a hard-closed period, changing that period's budget-control arithmetic (`budget-control.service.ts:157`). Also a second implementation of F-403's "single normative resolution".                                                                                                                                                                                                                      |
| **F-6.8** | **Budget and forecast lines** into a closed period                                                                   | `budgets.service.ts:663-676`, `forecasts.service.ts:62-73` — periods are validated for fiscal-year membership only                                                                                                                        | Budget cells for a signed-off period can be created or revised after close.                                                                                                                                                                                                                                                                                                                                                     |
| **F-6.9** | **Depreciation run named-period mismatch**                                                                           | `assets/depreciation.service.ts:139-150` loads the caller's `accountingPeriodId` and never reads its `status`; the journal locks the period that `period.end_date` resolves to (`document-posting.service.ts:193`)                        | For a regular period the two coincide and the run is safe. For an **adjustment** period they do not: `resolve_accounting_period` never returns an adjustment period (`0004_periods_books.sql:130`), so a run named against a hard-closed adjustment period posts into the regular period that contains its end date, and `depreciation_runs.accounting_period_id` then disagrees with `journal_entries.accounting_period_id`.   |

### 3.2 Paths that check outside the write transaction — F-106's shape

No path checks the period in a **different** transaction from the write it guards. The three
`lockPeriod` call sites all run on the caller's `writeInTenant` client, and every `documents.post`
call site passes the enclosing transaction's client. That is the good news and it should be recorded
as such.

Three things in this family still need Phase 6's attention:

| Id         | Path                                                                          | Evidence                                                                                                                                                                                                                            | Why it matters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F-6.10** | **Recurring-journal occurrence reserved in a separate committed transaction** | `packages/ledger/src/scheduler.ts:260-264` — `withTransaction(pool, … reserveOccurrence …)` commits **before** `createDraft` (`:282`) and `post` (`:309`), which run in their own transactions                                      | This is the genuine cross-transaction defect. When the draft or the post throws — a hard-closed period being the likeliest cause — the catch at `:331` leaves `next_run_date` in place, but the occurrence row is already committed. On the next tick the template is re-claimed, `reserveOccurrence` returns `false`, the run logs _"recurring occurrence already generated; skipping"_ (`:268-271`), returns **normally**, and the code then advances `next_run_date` (`:322-329`) and counts `succeeded++`. **The occurrence is consumed and never generated.** If only the post failed, the DRAFT survives and is never posted or retried. Either way an accrual silently disappears from a period nobody re-examines — the exact failure mode the comment at `:333-335` says it is avoiding. |
| **F-6.11** | **Advisory period-status reads with no lock**, used to choose a posting date  | `ap.service.ts:2088-2093` (failed-payment compensation: `originalPeriod.status === 'OPEN' ? payment.posting_date : todayIso()`); `inventory/posting.service.ts:324-329` (`if (period.status !== 'OPEN') reversalDate = todayIso()`) | `resolvePeriod` reads status without `FOR SHARE`, so a close committing between the read and the write flips the decision. The **write** is still locked, so the outcome is a correct refusal rather than a bad posting — but the caller gets `PERIOD_CLOSED` for a period it thought was open instead of the today-fallback it was designed to take. A `FOR SHARE` read here would make the fallback deterministic.                                                                                                                                                                                                                                                                                                                                                                              |
| **F-6.12** | **`postOpeningBalanceSet` spans three transactions**                          | `rules.service.ts:515` (read), `:544` (`journals.post` — its own transaction), `:546` (status flip in a third)                                                                                                                      | Not a period hole: the post is locked. But a crash between `:544` and `:546` leaves a POSTED opening journal with the set still `VALIDATED`, and the retry path (`:532`) will report POSTED only after the flip succeeded. Worth folding into Phase 6's close-run atomicity work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### 3.3 Paths with no guard-suite scenario

The SQL guard suite has 160 scenarios (`grep -c "### T" contracts/schema/tests/0006_guards_test.sql`)
and **zero** about period status, because the database has no such rule to test. The whole coverage
of the exit criterion today is:

| Test                                                | Half   | What it proves                                                                               |
| --------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------- |
| `apps/api/src/integration/ledger.test.ts:507`       | REJECT | A manual journal post into a hard-closed period returns 422 `PERIOD_CLOSED`                  |
| `apps/api/src/integration/ledger.test.ts:541`       | race   | A concurrent post and hard-close never leave a POSTED entry in a period closed without it    |
| `apps/api/src/integration/scheduler.test.ts:117`    | REJECT | A due scheduled reversal into a hard-closed period stays PENDING with `last_error` naming it |
| `apps/api/src/integration/scheduler.test.ts:78`     | ACCEPT | The same schedule posts and reaches EXECUTED when the period is open                         |
| `apps/api/src/integration/period-lifecycle.test.ts` | —      | Close ordering, permission and reason — the lifecycle, not the refusal                       |

So of the 64 rows above, **rows 8, 9 and 57 are proved and nothing else is** — the manual post, the
manual reversal (proved through the scheduled one), and the scheduler that calls it. In particular
there is no closed-period test for:

- `DocumentPostingService.post` itself (row 13) — the funnel every subledger, banking, inventory and
  asset posting passes through, 23 call sites (`grep -rn "documents\.post(" packages/*/src` = 23);
- **any** subledger document: invoice, credit note, receipt, allocation, bill, goods receipt,
  payment, payment run, vendor credit, expense claim, write-off, refund (rows 15-31);
- **any** banking posting: transfer, settlement reconciliation, chargeback (rows 35-37);
- **any** inventory posting or reversal (rows 40-46) — and three of those paths have no check to
  test (F-6.1 to F-6.4);
- **any** asset posting: capitalization, depreciation run, disposal, impairment, revaluation
  (rows 49-52);
- the recurring-journal worker in any form (rows 59-62) — neither the auto-post refusal nor the
  occurrence-loss defect;
- soft-close in any module: no test anywhere exercises `closed_period_behaviour`,
  `ALLOW_PRIVILEGED`, or the `accounting_period.soft_close` branch of `lockPeriod:294-309`.

Two coverage notes that matter more than the count:

1. **Both halves.** `scheduler.test.ts` is the only place in the repository that has an ACCEPT beside
   its REJECT for a period rule. `ledger.test.ts:507` proves the refusal; the corresponding "and the
   same journal posts when the period is open" is implicit in other tests rather than asserted beside
   it. Every scenario Phase 6 adds needs its pair, or a control that refuses everything looks
   identical to a correct one.
2. **A criterion proved on part of its domain is proved on none of it.** The criterion says _every
   source module_. One module is tested. The enumeration above is the domain it has to be proved on.

### 3.4 Defects found that are not period checks

| Id         | Defect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Evidence |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **F-6.13** | **A scheduled reversal blocked by a closed period dies permanently in ~5 ticks.** `runDueReversals` retries every tick, `attempts` increments each time, and at `attempts + 1 >= 5` the row becomes `FAILED` (`scheduler.ts:184-186`). `ledger_claim_due_reversals` only returns `status = 'PENDING'` (`contracts/schema/0033_scheduler_claims.sql:49`), so a FAILED schedule is never picked up again — and `cancelScheduledReversal` refuses anything that is not PENDING (`journal.service.ts:1001`), so it cannot even be cancelled. With the default interval that is under half an hour between "the period is closed" and "this accrual will never reverse, and the only route left is a manual journal". The comment at `scheduler.ts:175-179` describes the intended behaviour ("not something to retry into oblivion at five-minute intervals") — the code does retry at exactly that interval and burns the budget doing it. The API offers only `listScheduledReversals` and `cancelScheduledReversal` (`contracts/openapi.yaml:174-175`); there is no reset. |
| **F-6.14** | **Recurring invoices never generate.** `SalesService.generateDueOccurrences` (`sales.service.ts:1737`) has no route, no worker call and no test — `grep -rn "generateDueOccurrences"` matches its own definition and its own private callee only. `recurring_invoice_templates.auto_post` is read at `:1831` and returned in the result, and nothing acts on it. A registered intention is not an executed one; if Phase 6 wires this into the worker it inherits every question in §2.7.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **F-6.15** | **The dunning worker described at `sales.service.ts:1852-1855` ("stage advancement is the worker's job") does not exist.** Same class as F-6.14; noted here so the Phase 6 worker inventory is complete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

---

## 4. What this means for Phase 6's close management

Stated as the work list, in the order the evidence suggests:

1. **Give the criterion a storage-layer answer.** The probe in §1 is the finding: nothing below the
   application can refuse a journal in a closed period. A deferred constraint trigger on
   `journal_entries` — POSTED requires its `accounting_period_id` to be OPEN, or SOFT_CLOSED with the
   policy and permission recorded — would make every one of the 64 paths safe by construction,
   including the three that have no check today and any path Phase 7 adds. It would also give the
   guard suite its first period scenario, with both halves.
2. **Close the three no-check inventory branches** (F-6.1 to F-6.4). These are the holes a per-module
   spot check misses, because the module _does_ check the period — on its other branch.
3. **Decide what a hard close means for non-journal period-scoped writes** (F-6.5 to F-6.8): draft
   journals, subledger aging, commitments, budgets and forecasts. Each is defensible either way; none
   is defensible undecided.
4. **Fix the recurring-journal occurrence reservation** (F-6.10) before close management makes closed
   periods more common, and give the scheduled reversal a route back from FAILED (F-6.13). Closing a
   period is about to become a routine operation, and both defects are triggered by exactly that.
5. **Fold the depreciation-run adjustment-period mismatch into close** (F-6.9): a close run that
   depreciates into period 13 needs the run row and the journal to name the same period.
6. **Test both halves of every row in §2.** The table is the domain. The two rows that are proved
   today are the shape the other sixty-two need.
