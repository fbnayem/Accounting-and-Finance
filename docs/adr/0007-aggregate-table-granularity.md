# ADR-0007 — Aggregate table granularity

**Status:** Accepted · 2026-08-07
**Resolves:** [D-09](../../audit/07_Open_Decisions.md#d-09--generic-tables-vs-per-aggregate-tables) ·
[F-206](../../audit/03_Coverage_Gaps.md), [F-022](../../audit/01_Schema_Findings.md),
[F-049](../../audit/01_Schema_Findings.md)

## Context

Four blueprint tables each stand in for three to five specified aggregates via a free-text
discriminator column: `payments`, `inventory_documents`, `ai_decisions`, `approval_workflows`. The
specification never makes this modelling decision — doc 05 and doc 06 describe `VendorPayment` and
`CustomerReceipt` as separate aggregates with different lifecycles.

The cost of a generic table lands on constraints. One table cannot express "a goods receipt must
reference a PO line" and "a stock count must reference a count scope" as `NOT NULL`, so both become
nullable and the invariant moves into application code — where Gates C, D and G cannot see it.

## Decision

Decided per table, not by blanket rule.

### Split: `payments` → `customer_receipts` + `vendor_payments`

They differ in every dimension that matters:

|               | Customer receipt                                | Vendor payment                                   |
| ------------- | ----------------------------------------------- | ------------------------------------------------ |
| Lifecycle     | Received → allocated → (refunded)               | Requested → approved → sent → confirmed → posted |
| Approval      | None, or review over threshold                  | Dual control, payment runs, holds                |
| FX            | Realized FX on settling AR                      | Realized FX on settling AP                       |
| Special cases | Unapplied advances, overpayments, dunning links | Withholding split, payment files, remittance     |
| Batching      | None                                            | `payment_runs` applies only here                 |

Each gains the FX settlement fields the generic table lacked: `exchange_rate`,
`exchange_rate_date`, `exchange_rate_source`, `base_amount`. `realized_fx_amount` and
`allocated_base_amount` live on the **allocation**, not the payment — one receipt may settle invoices
booked at different rates, so FX is realized per allocation.

### Keep generic: `inventory_documents`

Genuinely uniform shape (header + movements + optional accounting entry) across receipt, issue,
transfer, adjustment, count and return. `document_type` becomes an **enum**, and type-specific
required references are enforced by `CHECK` constraints conditioned on the type rather than left
nullable-and-hoped-for.

### Keep generic: `ai_decisions`

Extraction, coding suggestion, match suggestion and agent action share provider/model/version,
input references, output, confidence and review disposition. `decision_type` becomes an enum.
Type-specific payload stays in the `output` JSON, which is appropriate — it is model output, not
relational data.

### Keep generic: `approval_workflows`

Version as a column is correct; a workflow definition is uniform regardless of what it approves.

### Cross-cutting: every status column becomes an enum

Twenty-one tables used `status text`. Free-text status is how state machines rot — a typo creates a
state no code handles, and doc 22's Definition of Done item 3 ("state machine/status transitions")
becomes unverifiable. Every one is enumerated per its documented state machine. Where a set is
genuinely open-ended, a lookup table with an FK, never free text.

## Consequences

- More tables (~4 net), and AR/AP code paths no longer share a payment repository. That separation is
  the point: doc 05's payment run, holds and dual control apply to one side only.
- `payment_allocations` splits correspondingly into `receipt_allocations` and `payment_allocations`,
  each with the ADR-0004 concurrency protocol.
- Bank matching targets both tables; `bank_matches.target_type` enumerates them.
- Enum changes require a migration. This is a feature — a new document status becomes a reviewed
  schema change rather than a string appearing in production.
- Reporting that spans both payment types (cash position, Gate D clearing reconciliation) uses a view
  over the two tables rather than a discriminator filter.
