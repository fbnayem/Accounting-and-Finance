# Phase 2 — Accounting Kernel and General Ledger

**Status:** complete · 2026-08-08
**Defined by:** [21_Phased_Implementation_Plan.md](<../project plan/21_Phased_Implementation_Plan.md>) Phase 2

Builds on [Phase 1](PHASE_1.md). 38 of the contract's 280 operations are Phase 2; all of them are
implemented, and the API refuses to start if any is missing a handler.

This is the phase the rest of the product is built on. doc 21 opens it with a sentence that only
becomes true if something is built to satisfy it — "later modules must call the accounting kernel
through commands/services; they must not create ledger rows directly" — so the kernel is a package,
[`@acct/ledger`](../packages/ledger), and both the API and the worker call it. The worker had two
alternatives: HTTP calls back into its own API, or its own INSERT. The second is how a second
posting path is born, and a second posting path is how a ledger stops balancing.

## Exit criteria — evidence

Doc 21 states six. [`ledger.test.ts`](../apps/api/src/integration/ledger.test.ts) is organised as
six `describe` blocks named after them, so the mapping is in the test output rather than in a
document that has to be kept in step with it.

### 1. Every posted journal balances exactly in book/base currency

| Attempt                                      | Result                                                      |
| -------------------------------------------- | ----------------------------------------------------------- |
| Post a balanced journal                      | 200, gapless number from the entity's sequence              |
| Post an unbalanced journal                   | 422, naming the difference and both totals                  |
| Post a line on a non-posting heading account | 422 `ACCOUNT_NOT_POSTABLE`                                  |
| Post to a control account without the grant  | 403 — `journal.post_control`, recovered by F-601 in Phase 1 |

Three layers assert it, and they are independent: `preparePosting` in
[`@acct/domain`](../packages/domain/src/posting.ts) refuses to produce an unbalanced set at all;
a `CHECK` refuses a line that is neither a debit nor a credit; and a deferred constraint trigger
re-adds every line at COMMIT and refuses the transaction if the totals differ. The third exists
because the first two are code, and code is what gets bypassed by the next module in a hurry.

A 20,000-case property test in [`posting.test.ts`](../packages/domain/src/posting.test.ts) generates
random line sets and asserts the invariant directly, because the interesting failures in rounding
are not the ones anyone thinks to write down.

### 2. No supported application role can edit or delete posted journal lines

| Attempt                                        | Result                            |
| ---------------------------------------------- | --------------------------------- |
| `PATCH /journals/{id}` on a posted entry       | 409 `POSTED_IMMUTABLE`            |
| `DELETE /journals/{id}` on a posted entry      | 409 `POSTED_IMMUTABLE`            |
| `UPDATE journal_lines` as `app_runtime`        | permission denied                 |
| `DELETE journal_entries` as `app_runtime`      | permission denied                 |
| `UPDATE journal_lines` **as the schema owner** | `POSTED_IMMUTABLE` from a trigger |

The last row is the one worth having. The owner holds every privilege, so the privilege layer cannot
protect anything from it; 0006's trigger does. Gate C asks for both because either alone is a single
point of failure, and the database probes run against `runtimePool()` — the connection the
application itself uses, not a role invented to make the assertion pass.

### 3. A duplicate accounting event cannot double-post

Two different duplicates, because they arrive by different routes:

- **The same business event, submitted twice.** `source_event_id` is unique per book; the second
  post returns the first entry rather than creating another.
- **The same HTTP request, retried.** The idempotency interceptor replays the stored response.
  F-044's requirement, tested at the layer that actually sees the retry.

### 4. The ledger read model can be destroyed and rebuilt with identical balances

`POST /ledger/projections/rebuild` (F-614) truncates the projection for a book and recomputes it
from posted lines, returning `rows_before`, `rows_after`, `differences` and `identical` — a
comparison rather than a claim. Three tests:

| Test                                       | What it establishes                                               |
| ------------------------------------------ | ----------------------------------------------------------------- |
| Rebuild with no differences                | The criterion, directly                                           |
| Corrupt one row, then rebuild              | Drift is **reported**, not quietly repaired and reported as clean |
| Trial balance from projection vs raw lines | doc 03's own wording: the cached model equals the recomputed one  |

The middle one is the check on the check. A rebuild that overwrote and returned `identical: true`
would pass criterion 4 forever while proving nothing. Incremental refresh and full rebuild share one
SQL statement in [`projection.service.ts`](../packages/ledger/src/projection.service.ts), so they
cannot disagree about what a balance is.

### 5. The opening trial balance imports and validates Assets = Liabilities + Equity

`POST /opening-balances` (F-613) creates the set and its draft journal together and reports the
equation as data. A balanced set is accepted with the three totals; an unbalanced one is refused.

The equation is checked as `Assets = Liabilities + Equity + (Revenue − Expenses)`, which is the only
form that is true mid-year. Opening balances usually have no P&L side, so the two forms agree at the
moment the criterion is about — but the code that will be reused at every period close needed to be
right the first time rather than corrected once someone posts revenue.

### 6. Journal reversal produces the exact opposite accounting effect and traceability

| Assertion                                | Result                                           |
| ---------------------------------------- | ------------------------------------------------ |
| Reversal lines invert the original       | Debit ↔ credit, same accounts, same dimensions   |
| Original status                          | `REVERSED`                                       |
| Reversal status                          | `POSTED` — it is a real entry, not an annotation |
| Original names its reversal              | `related[].relation = 'REVERSAL'`                |
| Reversal names its original              | `related[].relation = 'REVERSES'`                |
| Net movement per account across the pair | exactly zero                                     |
| Reversing the same entry twice           | 422, "already reversed"                          |

Links in both directions, deliberately: a trace that is reachable only from the reversal is no help
to the person looking at the original and asking why it does not appear in the balance.

## Beyond the six

Doc 21 names five pieces of required engineering work. Three of them are races, so they are tested
by running them concurrently rather than by inspection:

| Requirement                    | Evidence                                                                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Period-lock race protection    | A close and a post fired together. The test asserts the invariant rather than a winner: whichever order the database picks, what must never survive is a posted entry sitting in a period that was hard-closed without it |
| Row locking strategy           | `FOR SHARE` on the posting path, `FOR UPDATE` on close (ADR-0004 §4) — a post cannot slip between the check and the close                                                                                                 |
| Decimal precision and rounding | ADR-0006's boundary chain, `numeric(24,8)` money and `numeric(28,12)` rates, decimal strings on the wire and never JSON numbers                                                                                           |
| Source event idempotency       | Criterion 3 above                                                                                                                                                                                                         |
| Posted-journal DB protection   | Criterion 2 above, both layers                                                                                                                                                                                            |

Period resolution has its own three tests, because doc 03 and F-403 disagree with the obvious
implementation: an adjustment period shares period 12's end date, so resolving a posting date by
range returns whichever the planner reached first. The regular period always wins; the adjustment
period is reachable only by naming it, and only with `journal.post_to_adjustment_period`.

## The gate chain

```
pnpm verify        format · lint · typecheck · 14 contract checks · 8 DoD checks · 353 tests
pnpm db:verify     35 migrations, no drift, privilege layer and RLS on 21 registered tables
pnpm db:guards     24 scenarios, each rejected by the constraint its own label names
pnpm bench         Gate H passed — 8 measured, 6 declared and not yet available
```

353 tests: 139 API (110 of them integration over real HTTP), 102 domain, 45 database, 24 UI, 13
testing, 12 ledger, 10 config, 8 contracts.

Gate H, `profile=small`, against a stored baseline:

| Workload                           |    p95 |   target |
| ---------------------------------- | -----: | -------: |
| `single-journal-post-10-lines`     | 18.5ms |    150ms |
| `ledger-read-model-rebuild-500k`   | 56.5ms | 600000ms |
| `trial-balance-one-period`         |  4.2ms |   1500ms |
| `general-ledger-account-drilldown` |  2.8ms |   1500ms |

An end-to-end proof over HTTP against a stack reset from destroyed volumes runs the whole of doc 03's
posting story in 22 steps — signup, entity, chart, dimension rules, journal definition, activation,
a draft refused for a missing required dimension, MFA enrolment through the real TOTP endpoints, a
post, an edit refused, a reversal, both trial balances agreeing, a rebuild, and a scheduled reversal
— with one correlation id that arrives in the worker's log 68 times.

## What was built

**The posting kernel, as a package.** [`@acct/ledger`](../packages/ledger) holds the posting service,
the projection service, journals, chart, posting rules, reports, numbering and the scheduler, with no
framework in it. The API injects it; the worker imports it. There is one code path that writes a
journal line.

**A posting-rule language** ([`posting-rules.ts`](../packages/domain/src/posting-rules.ts)).
Accounts resolve as `{policy}`, `{event}` or a literal `{code}`; amounts as `{event,factor}`,
`{const}` or `{balancing}`; `forEach` expands a rule over a collection; a negative amount flips the
side rather than posting a negative. Versioned and effective-dated, because doc 01 rule 7 requires a
transaction posted in March to be explainable by March's rule in December.

**Simulation before posting.** `POST /posting-rules/simulate` resolves an event against the rules in
force on a date and returns the lines it would produce, without writing anything.

**Scheduled reversals and recurring journals**, run by the worker. Both claim their work with
`FOR UPDATE SKIP LOCKED` and generate a deterministic occurrence id, so two workers cannot produce
the same journal twice and a restart mid-run cannot either.

**Six screens**: chart of accounts, dimensions, the journal grid, trial balance, general ledger and
posting rules. The [journal grid](../apps/web/components/journal-grid.tsx) closes F-407 — the audit's
open question about accounting grid behaviour — by writing the keyboard model, the running imbalance
and the paste behaviour down in one place rather than leaving them to be discovered per screen.

## Decisions taken during this phase

| Decision                                                   | Why                                                                                                                                                               |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The kernel is a package, not a service inside the API      | doc 21 requires later modules to post through it. The worker is the first such module, and its only alternatives were an HTTP call home or its own INSERT.        |
| The balance assertion is a **deferred** constraint trigger | Lines arrive one at a time; an immediate trigger would refuse the first line of every balanced journal.                                                           |
| Zero-value lines are legal                                 | ADR-0003. A fully-discounted line and a zero-cost inventory issue are both real, and F-002 removed the CHECK that forbade them.                                   |
| Journal lines carry their own scope                        | ADR-0003. Every ledger report otherwise joins `journal_entries` for the entity, book, period and date it filters on.                                              |
| Reversal is a new entry, never an edit                     | doc 01 rule 4. The original keeps its number and its history; the correction has its own.                                                                         |
| A scheduled reversal is a separate aggregate               | F-612. The immutability trigger permits exactly one UPDATE on a posted entry, so a date column on the entry could be set only before posting and never cancelled. |
| The projection is never a source of truth                  | Blueprint note 7. Criterion 4 is the test that keeps it honest, and the rebuild reports differences rather than repairing them.                                   |
| Draft writes go through a `SECURITY DEFINER` function      | F-619. The privileges that protect posted history are not row-aware, so the only way to keep both is a function that checks the row.                              |

## Findings raised while building

Sixteen, recorded in
[contracts/README.md](../contracts/README.md#findings-raised-after-deliverable-2). Eight are contract
gaps (F-607…F-614) — something doc 03 requires with no route to reach it, each found by trying to
drive the posting algorithm end to end and running out of road. Four are schema gaps that only appear
when the kernel runs (F-615…F-618, migration 0029).

The last four are the ones worth reading, because each was a control that existed, was believed, and
did nothing:

| ID    | The control                                 | What it actually did                                                                                                                                       |
| ----- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-619 | 0006's revokes protect posted history       | Also made **drafts** unwritable, so doc 03's "draft can be edited" was impossible. 0006's own comment named the fix; it had never been written             |
| F-620 | RLS protects every ledger table             | Also blinded the scheduler's cross-tenant "what is due today" scan, which returned nothing and did nothing, silently                                       |
| F-621 | 0032's `SECURITY DEFINER` checks the tenant | `app_rls_bypassed()` reads `current_user`, which inside such a function is the **definer** — always true. Any user could discard any tenant's draft by id  |
| F-622 | `GET /health` reports readiness             | Reported `down` on every call since Phase 1, because the probe began with `CREATE TABLE IF NOT EXISTS` and the runtime role has no CREATE on schema public |

F-621 is the one to take a lesson from. Its guard scenario reported a pass twice before it reported
the truth: the first version pointed at an entry whose transaction had rolled back, and the second
ran as the owner, for whom skipping the check is correct behaviour. Both were green. The third
version — create a real draft, call the function under a different tenant, expect a rejection — is
the one that failed, and the exemption came out rather than being repaired.

F-622 is the one to take an uncomfortable lesson from: it had shipped through two completed phases
because the endpoint had no test at all. Its unit tests called the check functions with the owner's
pool, for whom the DDL succeeds. It is now asserted over HTTP against the assembled application, as
the role that serves traffic.

## Defects found and fixed while building

| Found by                          | Defect                                                                                                                                                                                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The first draft write             | Every draft edit failed with `permission denied for table journal_lines`. F-619 — a table privilege cannot distinguish a draft from a posted fact.                                                                                                                     |
| The scheduler, doing nothing      | F-620. Not an error: an empty result set, which is the hardest kind of failure to notice.                                                                                                                                                                              |
| `pnpm db:guards`, third attempt   | F-621, after two versions of the scenario passed without reaching the check they existed to test.                                                                                                                                                                      |
| `curl /health`                    | F-622. Three hours into the phase, on a stack that was working perfectly.                                                                                                                                                                                              |
| Guards T20/T21, immediately after | 0034 reordered the checks, so a scenario with no `app.tenant_id` got NOT_FOUND instead of POSTED_IMMUTABLE. The `via` clause caught it — the scenario declared which constraint must reject it.                                                                        |
| A test regex matching nothing     | `.toThrow(/…/)` never matched because the summary said "1 problem(s)" and the detail lived only in `fieldErrors`. Both error builders now quote up to three problems in the message.                                                                                   |
| Contract check 8                  | Five permissions had grown new routes, so their seeded descriptions no longer matched. Migrations are forward-only, so the generator now emits description UPDATEs rather than only INSERTs.                                                                           |
| Reversing a reversed entry        | "Only a POSTED journal can be reversed" — true, and useless. The already-reversed check now runs first.                                                                                                                                                                |
| `pnpm dod:check`                  | It kept a third copy of the delivered-phase list, so 38 Phase 2 operations failed a check about Phase 1. It now reads the list from `operation.ts`.                                                                                                                    |
| Gate H                            | A 49.7% regression failed the build at 7.4ms against a 1500ms target. A percentage on a single-digit-millisecond workload is noise, and a gate that fails on noise loses its authority on the day it is right. Below 25ms the regression is printed but does not fail. |

## Deferred, deliberately

| Item                                       | Why                                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Multi-book posting and book-specific rules | Phase 10 owns it. The schema is already keyed by book, so nothing needs undoing.                                                                             |
| Consolidation and elimination entries      | Phase 7.                                                                                                                                                     |
| Financial statements (P&L, Balance Sheet)  | Phase 6. Their benchmark workloads are declared and skipped until then, so the gate reports what it is not yet measuring.                                    |
| Automatic period-close P&L transfer        | Phase 6 with the close process. Both retained-earnings methods are already a policy field, per the decision taken before Deliverable 2.                      |
| Currency revaluation                       | Phase 6. Rates and the rate-versioning surface exist; nothing revalues yet.                                                                                  |
| Control-account reconciliation _reports_   | The framework is here — control accounts are flagged, posting to one needs a permission — but the subledgers it reconciles against arrive in Phases 3 and 4. |

## Next

Phase 3 — Customers, Vendors, AR, AP, Tax Foundation and Documents. It is the first phase that posts
through the kernel rather than into it: an invoice does not write journal lines, it raises an
accounting event that a posting rule resolves. `simulatePosting` and the rule language exist for
exactly that, and the two ageing workloads are already declared in the benchmark harness, waiting for
their subject.
