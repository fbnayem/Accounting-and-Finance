# ADR-0001 — Accounting framework and retained earnings policy

**Status:** Accepted · 2026-08-07
**Resolves:** [D-01](../../audit/07_Open_Decisions.md#d-01--accounting-framework-and-retained-earnings) ·
[F-401](../../audit/05_Missing_Requirements.md), [F-402](../../audit/05_Missing_Requirements.md)

## Context

The specification requires full financial statements, asset revaluation, impairment, consolidation
with CTA and advanced revenue recognition, but never names an accounting framework. It also offers
"explicit closing journals" for year-end rollover conditional on an unnamed alternative. Gate E
requires "P&L closes correctly into equity/retained earnings policy" — a policy that did not exist.

Both gaps change what the posting rules _are_, not merely how they are implemented.

## Decision

### 1. IFRS is the default posting model

Every posting rule that the catalog qualifies as "according to book/local rule" resolves to its IFRS
treatment by default. Jurisdictional divergence is handled by Phase 10 parallel books
(doc 11), which is what parallel books exist for — not by branching the core rules.

Concrete consequences for the rules that differ:

| Rule                | IFRS treatment adopted                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ASSET_REVALUATION` | Revaluation model permitted (IAS 16). Increase → Revaluation Surplus in OCI; reversal of a prior decrease → P&L to the extent of that decrease                                                                           |
| `ASSET_IMPAIRMENT`  | IAS 36. **Reversal is permitted** for non-goodwill assets, capped at the carrying amount that would have applied without impairment. A `asset.impairment_reversed` event and posting rule are required — neither existed |
| Inventory valuation | FIFO and weighted average only. **LIFO is prohibited** and must not be added as a valuation policy                                                                                                                       |
| Bad debt            | Allowance model. IFRS 9 expected credit loss is deferred; the allowance account structure supports it without schema change                                                                                              |
| Cash flow           | Both direct and indirect permitted. Indirect requires a reconciliation from profit that account classification alone cannot produce — see consequences                                                                   |

### 2. Both retained-earnings methods are supported; the tenant chooses at setup

`accounting_policies.retained_earnings_method` is an enum:

- **`DERIVED`** — retained earnings computed at report time as
  `prior RE + Σ(revenue − expense) for the current year to date`. No closing journal is posted; P&L
  accounts retain their balances on the Trial Balance across the year boundary.
- **`CLOSING_JOURNAL`** — `PERIOD_CLOSE_PNL_TRANSFER` fires at year end, closing income and expense
  accounts to retained earnings. P&L accounts zero on the Trial Balance after close.

The method is set at organization creation, is per accounting book, and **cannot be changed once the
book has a closed fiscal year** — changing it retrospectively would invalidate every prior Balance
Sheet.

`DERIVED` is the shipped default. It keeps prior-period reopening simple (doc 12 requires a reopen
workflow), and it composes naturally with multi-book.

## Consequences

- Every posting rule in `posting_rule_catalog.md` that says "according to book/local rule" gets a
  concrete IFRS default written into `contracts/schema/` and the rule definitions.
- **A new posting rule and event are required:** `ASSET_IMPAIRMENT_REVERSAL` /
  `asset.impairment_reversed`. Neither the catalog nor the event catalog had them, because US GAAP
  forbids the transaction. Added to `contracts/events.yaml`.
- **Gate C needs two sets of golden fixtures** for year-end — one per retained-earnings method. The
  fixture matrix grows; this is the cost of the tenant-choice decision and was accepted knowingly.
- **The ledger read model implements both derivations.** Gate C's "projections rebuild exactly from
  journal facts" must reproduce the `DERIVED` computation, which means the derivation is part of the
  ledger read model specification, not the reporting layer.
- `accounting_policies` must exist before Phase 2 can resolve posting accounts — it is the table
  [F-203](../../audit/03_Coverage_Gaps.md) identified as missing and blocking.
- Cash flow: ship the classification-based direct method first (as doc 12 proposes). The indirect
  method needs a profit reconciliation and is deferred to Phase 6 with its own design note.
- Adding a US GAAP book later is a country-pack and multi-book exercise, not a core change. That is
  the property this decision buys.
