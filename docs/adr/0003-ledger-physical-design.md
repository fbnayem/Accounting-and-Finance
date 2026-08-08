# ADR-0003 — Ledger physical design

**Status:** Accepted · 2026-08-07
**Resolves:** [D-03](../../audit/07_Open_Decisions.md#d-03--journal-line-denormalisation),
[D-04](../../audit/07_Open_Decisions.md#d-04--chart-of-accounts-grain) ·
[F-002](../../audit/01_Schema_Findings.md), [F-007](../../audit/01_Schema_Findings.md),
[F-019](../../audit/01_Schema_Findings.md), [F-001](../../audit/01_Schema_Findings.md),
[F-004](../../audit/01_Schema_Findings.md), [F-005](../../audit/01_Schema_Findings.md),
[F-006](../../audit/01_Schema_Findings.md), [F-008](../../audit/01_Schema_Findings.md)

## Context

Four structural problems in the ledger core, all cheap now and expensive after migration 0001:
lines carry no scope, the chart is scoped differently from its neighbours, posted rows are mutable,
and the balance invariant is enforced only in application code.

## Decision

### 1. Journal lines carry their own scope

`journal_lines` gains `legal_entity_id`, `accounting_book_id`, `accounting_period_id`,
`posting_date` and `branch_id`, denormalised from `journal_entries`.

Justification: every ledger read (Trial Balance, General Ledger, P&L, Balance Sheet, aging, every
subledger reconciliation) filters on entity + book + period and aggregates over lines. Without these
columns each one joins the parent. It also makes partitioning by `posting_date` possible — blueprint
note 6 contemplates it — and supplies the columns ADR-0002's composite FKs require.

The posting service is the sole writer and populates them inside the transaction that creates the
lines. Immutability (below) prevents subsequent divergence. A deferred constraint trigger asserts
agreement with the parent.

Covering index: `(accounting_book_id, accounting_period_id, account_id)` plus
`(accounting_book_id, posting_date)`.

### 2. Chart of accounts is entity-scoped

`accounts` becomes `UNIQUE (legal_entity_id, code)`, matching `account_groups`, `dimensions` and
`tax_codes`. Book-specific attributes move to a separate `account_book_settings` table.

This removes the wholesale chart duplication that book-scoped accounts would force in Phase 10 —
doc 11 asks for "book-specific journal adjustments" and "chart mapping", not a copy per book — and it
makes an invoice line's `revenue_account_id` resolvable from the invoice's entity.

### 3. Posted rows are immutable, enforced twice

Application code is not a control. Migration 0001 ships both layers:

1. `BEFORE UPDATE OR DELETE` triggers on `journal_entries`, `journal_lines` and
   `journal_line_dimensions` rejecting any change once the entry is `POSTED`. The one permitted
   transition is `POSTED → REVERSED` on `journal_entries`, which may set `status` and nothing else.
2. `REVOKE UPDATE, DELETE ON journal_lines, journal_line_dimensions FROM <app_role>`, with the
   posting path running through a `SECURITY DEFINER` function.

Both, because Gate C tests the role and doc 03 asks for the trigger.

### 4. Balance is asserted by the database

A `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` fires at commit and asserts
`SUM(base_debit) = SUM(base_credit)` for every entry reaching `POSTED`. This sits behind the posting
service, not instead of it.

Blueprint note 5 is right that a `CHECK` cannot express an aggregate over child rows — but a deferred
constraint trigger can, and Gate C's property test is far stronger when the database also refuses.

### 5. Zero-value lines are permitted

The `CHECK (base_debit > 0 OR base_credit > 0)` constraint is **dropped**. It rejected zero-cost
inventory issues, fully-discounted invoice lines, FX lines rounding to zero in base, and memo lines —
all legitimate. The mutual-exclusion and non-negativity checks are retained.

"A journal must have at least one non-zero line" moves to the posting service, where it belongs.

### 6. Header currency is the book's base currency

`journal_entries.currency` is renamed `base_currency` and defined as the book's base currency
snapshotted at posting time. A check asserts every line's `base_currency` matches. Mixed
_transaction_ currencies within one entry remain valid — they must be, for FX remeasurement,
consolidation eliminations and a foreign receipt with a local bank fee.

### 7. Source documents carry posting date, book and branch

`invoices`, `vendor_bills` and every other posting source gain `document_date`, `posting_date`,
`accounting_book_id` and `branch_id`. `posting_date` is the sole input to period resolution across
all modules.

## Consequences

- ~15% more storage on the largest table, and five extra columns on the posting write path.
- Period resolution is specified: the non-adjustment period containing `posting_date`, unless the
  caller names an adjustment period and holds `post_to_adjustment_period`
  ([F-403](../../audit/05_Missing_Requirements.md)).
- Corrections to a posted entry are only possible via reversal. This is the intent, and it makes
  doc 01 rule 4 structural.
- Golden fixtures are required for the zero-cost issue and the 100%-discount invoice, which the old
  constraint would have failed.
- `account_book_settings` is a new table not present in the blueprint.
- The deferred balance trigger's cost is measured under Gate H (ADR-0009). If material at scale, it
  stays enabled in CI and staging and becomes a monitored assertion in production — it is never
  simply removed.
