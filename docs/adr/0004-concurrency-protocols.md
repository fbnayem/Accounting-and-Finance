# ADR-0004 — Concurrency protocols

**Status:** Accepted · 2026-08-07
**Resolves:** [D-05](../../audit/07_Open_Decisions.md#d-05--document-number-allocation-protocol),
[D-07](../../audit/07_Open_Decisions.md#d-07--allocation-concurrency-protocol) ·
[F-012](../../audit/01_Schema_Findings.md), [F-021](../../audit/01_Schema_Findings.md),
[F-032](../../audit/01_Schema_Findings.md)

## Context

Gate G names eight concurrency scenarios and expects "no duplicate posting, broken sequence
ownership, negative stock outside policy, or inconsistent subledger state". Three of them have no
mechanism in the blueprint: number allocation, payment allocation, and inventory cost-layer
consumption. All three are read-modify-write races on contended rows.

## Decision

**Pessimistic row locking, consistently, with defence in depth.** Each protocol below is normative.

### 1. Document number allocation

```
BEGIN
  … all validation …
  SELECT next_number FROM number_sequences
    WHERE id = :sequence_id FOR UPDATE;        -- serialisation point, held briefly
  UPDATE number_sequences SET next_number = next_number + 1 WHERE id = :sequence_id;
  INSERT … entry_number = formatted(next_number) …
COMMIT
```

Allocation happens **as late as possible** in the posting transaction, after all validation, so the
lock is held for the minimum time.

PostgreSQL sequences are explicitly rejected: they are gap-tolerant by design, and statutory invoice
numbering in most jurisdictions must be gapless. Optimistic retry on the `version` column is rejected
because it degrades exactly under the contention it will meet — month-end invoice runs.

`number_sequences` gains real scope columns (`branch_id`, `document_type`, `fiscal_year_id`) rather
than string-encoding them into `scope`.

Voided numbers are never reused: the number stays on the voided document and remains visible in the
audit sequence, as doc 02 requires.

### 2. Payment allocation — three layers

1. **Locks.** `SELECT … FOR UPDATE` on the payment row, then on each target document row.
   **Lock order is payment first, then targets in ascending `id` order** — without a fixed order,
   concurrent multi-invoice allocations deadlock.
2. **Persisted balances.** `amount_paid` and `amount_due` are maintained on the target in the same
   transaction, with `CHECK (amount_paid >= 0)`, `CHECK (amount_paid <= total)` and
   `CHECK (amount_due = total - amount_paid)`.
3. **Deferred assertion.** A constraint trigger asserts
   `SUM(allocations.amount) <= payments.amount` per payment at commit.

The three fail independently: the lock prevents the race, the checks catch a logic error, the trigger
catches a path that bypassed the service.

The blueprint's `UNIQUE (payment_id, target_type, target_id)` is **dropped** — it forbade two partial
allocations from one payment to one invoice at different times, which doc 04's partial-allocation
flow legitimately needs. The sum constraint replaces it.

### 3. Inventory cost layer consumption

```
SELECT * FROM inventory_cost_layers
  WHERE item_id = :item AND warehouse_id = :wh AND remaining_quantity > 0
  ORDER BY received_date, id
  FOR UPDATE;                                   -- locks all candidate layers
```

`CHECK (remaining_quantity >= 0)` is added — on its own this converts a silent corruption into a loud
failure.

Where policy permits negative stock, an explicit provisional layer is created with a settlement flag,
so the exception is visible in the valuation report rather than implicit in a negative number.

### 4. Period-lock races

Period status is re-checked **inside** the posting transaction with
`SELECT status FROM accounting_periods WHERE id = :period FOR SHARE`, after validation and before
insert. Closing a period takes `FOR UPDATE` on the same row, so a close cannot interleave with an
in-flight post. This is doc 03's acceptance criterion: "Closing a period between request validation
and commit cannot allow a race-condition post."

### 5. Depreciation, FX and close runs

Idempotency is structural rather than lock-based:
`depreciation_schedule_lines UNIQUE (asset_book_id, accounting_period_id)` already does this
correctly. `fx_remeasurement_runs` and `close_runs` gain `version` + `status` with uniqueness moved
to a **partial index over the posted/completed state only**, so preview, rerun and reopen all work
while exactly one run posts ([F-037](../../audit/01_Schema_Findings.md),
[F-038](../../audit/01_Schema_Findings.md)).

## Consequences

- Concurrent posting serialises per number sequence. This is inherent to gapless numbering, not a
  flaw in the design. Gate H (ADR-0009) must measure posting throughput per sequence; if a tenant
  needs more, the answer is more sequences (per branch, per document type), not a weaker protocol.
- The documented lock order is load-bearing. Gate G must include a deliberate deadlock test:
  two concurrent receipts allocating to the same two invoices in opposite input order.
- `SERIALIZABLE` isolation was considered and rejected: correct, but it pushes retry handling into
  every caller and performs poorly under month-end contention.
- Every protocol here is a Gate G test case. They are written as tests first, in Phase 2 and Phase 3.
