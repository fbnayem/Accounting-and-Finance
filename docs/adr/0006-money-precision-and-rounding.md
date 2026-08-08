# ADR-0006 — Money precision and rounding

**Status:** Accepted · 2026-08-07
**Resolves:** [D-08](../../audit/07_Open_Decisions.md#d-08--money-precision-and-rounding-boundaries) ·
[F-051](../../audit/01_Schema_Findings.md)

## Context

Doc 01 requires that "rounding occurs at defined calculation boundaries" and never defines them.
No `currencies` table exists, so per-currency minor units and cash-rounding behaviour have nowhere to
live, despite doc 01 requiring "Currency metadata defines precision and cash-rounding behavior".

Every Gate C golden fixture encodes a rounding decision. Left undefined, the fixtures define the
behaviour by accident and each module rediscovers it differently.

## Decision

### 1. Storage precision

| Kind                                | Type             | Rationale                                                                |
| ----------------------------------- | ---------------- | ------------------------------------------------------------------------ |
| Money                               | `numeric(24,8)`  | Full precision retained in storage; rounding applied at boundaries below |
| Exchange rate                       | `numeric(28,12)` | Rate precision exceeds any published source                              |
| Tax rate                            | `numeric(18,10)` | Supports fractional-percent statutory rates                              |
| Percentage (ownership, recoverable) | `numeric(9,6)`   |                                                                          |
| Confidence                          | `numeric(8,6)`   | See ADR-0009 on calibration                                              |

No binary floating point anywhere, for any monetary or rate value.

### 2. The `currencies` table

Reference data, seeded from ISO 4217, per row: `code`, `minor_unit`, `cash_rounding_increment`,
`symbol`, `symbol_position`, `is_active`. `minor_unit` drives every rounding boundary below;
`cash_rounding_increment` handles currencies where physical cash rounds to a coarser increment.

### 3. The rounding boundary chain — normative

Applied in this order. Each step rounds; **no later step re-rounds an already-rounded sum.**

```
1. line net           → round to currency minor_unit
2. line tax           → round per tax component, then sum the rounded components
3. document tax total → sum of rounded component amounts        (never re-round)
4. document total     → sum of rounded line grosses             (never re-round)
5. base conversion    → round after (transaction amount × rate), per line
6. journal line       → already rounded at step 1/2/5; no further rounding
```

Step 3 and step 4 are the ones most often got wrong: re-rounding a sum of rounded parts produces a
total that disagrees with its own lines by a minor unit, which is what customers notice on an invoice.

### 4. Rounding mode

**Half-up** is the default, with a per-tax-component override, because some jurisdictions mandate
half-even or truncation for tax specifically.

### 5. Residual differences

Any residual after the chain posts through `ROUNDING_ADJUSTMENT` to the rounding account configured
in `accounting_policies`. The posting service records the originating calculation and the exact delta,
as the posting rule catalog already requires.

Rounding is **never** used to absorb an unexplained imbalance — an imbalance that is not attributable
to a specific rounding step is a posting failure, not a rounding adjustment.

### 6. Inclusive tax

For tax-inclusive documents, net and tax are derived from gross before step 1, then the chain applies
normally. The derivation is `net = round(gross / (1 + rate))`, `tax = gross − net`, so the components
always re-sum to the stated gross.

## Consequences

- The rounding specification is written **before** the first golden fixture. Every fixture then
  asserts a specified behaviour rather than defining one.
- API contracts carry money as decimal strings, never JSON numbers — already required by
  `api_route_catalog.yaml` conventions and now enforced in `contracts/openapi.yaml`.
- The presentation layer formats using `currencies.minor_unit`; it never rounds a value that the
  server has already rounded.
- Golden fixtures are required for: a three-line invoice where component tax rounding differs from
  document-level rounding; an inclusive-tax invoice; a foreign-currency invoice whose base conversion
  produces a residual; and a cash-rounded currency.
- Changing `minor_unit` for a currency after transactions exist is prohibited — it would invalidate
  every historical rounding decision.
