# ADR-0009 — Performance baselines and seed profiles

**Status:** Accepted · 2026-08-07
**Resolves:** [D-11](../../audit/07_Open_Decisions.md#d-11--performance-baseline-targets) ·
[F-302](../../audit/04_Unquantified_Requirements.md), [F-303](../../audit/04_Unquantified_Requirements.md),
[F-304](../../audit/04_Unquantified_Requirements.md), [F-305](../../audit/04_Unquantified_Requirements.md),
[F-308](../../audit/04_Unquantified_Requirements.md)

## Context

Gate H names eight workloads and defines zero targets, deferring them to "before each release".
Doc 19 defers the seeded volumes the same way. **A gate with no number cannot be failed** — any
measurement satisfies "we tested it".

The same pattern affects RPO/RTO (required per tier, no tiers defined) and alert thresholds
(five classes named, none quantified).

## Decision

These are starting positions to be argued with from evidence, not conclusions. The point is that
each gate now has a row it can fail against.

### 1. Seed profiles

`packages/testing` ships three deterministic profiles. Gate H measures against `reference`;
CI regression checks run against `small`.

| Profile     | Entities | Fiscal years | Journal lines | Invoices | Bank txns | Items | Concurrent users |
| ----------- | -------: | -----------: | ------------: | -------: | --------: | ----: | ---------------: |
| `small`     |        1 |            1 |          20 k |      2 k |       5 k |   200 |                2 |
| `reference` |        1 |            3 |         500 k |     50 k |     100 k |   5 k |               10 |
| `large`     |        5 |            5 |           5 M |    500 k |       1 M |  50 k |               50 |

Fixed random seed, so a baseline from one run is comparable with the next — which
[F-303](../../audit/04_Unquantified_Requirements.md) noted was impossible without a defined dataset.

### 2. Gate H targets — p95 against `reference`

| Workload                                         | Target   |
| ------------------------------------------------ | -------- |
| Single journal post, 10 lines                    | < 150 ms |
| Trial Balance, one period                        | < 1.5 s  |
| P&L with comparatives, one year                  | < 3 s    |
| Balance Sheet, one period                        | < 1.5 s  |
| AR aging, 50 k open items                        | < 2 s    |
| AP aging, 50 k open items                        | < 2 s    |
| Bank match candidate generation, one transaction | < 500 ms |
| Inventory valuation, 10 k items                  | < 5 s    |
| Consolidation run, 5 entities                    | < 60 s   |
| Bulk import, 10 k rows                           | < 5 min  |
| API list endpoint, cursor page of 50             | < 300 ms |
| Ledger read-model full rebuild, 500 k lines      | < 10 min |

Baselines are stored in CI. A regression beyond **20%** fails the build; a regression beyond the
absolute target blocks release.

### 3. Recovery tiers

| Tier       | RPO    | RTO | Applies to             |
| ---------- | ------ | --- | ---------------------- |
| `standard` | 15 min | 4 h | All tenants by default |
| `critical` | 5 min  | 1 h | Opt-in, commercial     |

Gate L's restore drill tests against the tier's stated numbers.

### 4. Alert thresholds

| Signal                         | Threshold                     |
| ------------------------------ | ----------------------------- |
| Outbox unpublished age         | p99 > 60 s                    |
| Posting failure rate           | > 0.1% over 5 min             |
| Connector sync                 | 3 consecutive failures        |
| Reconciliation job             | any failure                   |
| Database connection saturation | > 80% for 5 min               |
| Queue depth                    | > 10 k or oldest job > 15 min |
| Webhook delivery failure rate  | > 5% over 15 min              |
| API 5xx rate                   | > 0.5% over 5 min             |

### 5. Security finding severity

[F-306](../../audit/04_Unquantified_Requirements.md) — "release-blocking" was undefined:

- CVSS ≥ 7.0 in a runtime dependency: **blocks release**
- CVSS 4.0–6.9: requires a dated waiver with an owner
- CVSS < 4.0: tracked
- Any detected secret: **blocks unconditionally**, no waiver

### 6. AI confidence

[F-308](../../audit/04_Unquantified_Requirements.md) — confidence is defined as a **calibrated
probability in [0,1]**. A provider's raw score may not gate automation until it has been calibrated
against the doc 19 evaluation sets. Thresholds per feature are recorded in `automation_policies`, and
**a feature with no recorded threshold cannot be enabled** — enforced at the policy layer, not by
documentation convention ([F-307](../../audit/04_Unquantified_Requirements.md)).

## Consequences

- Phase 0 must ship the three seed profiles and a benchmark harness before Gate H can be assessed at
  any phase.
- These numbers are for a single-node development-grade database. Production targets will differ and
  should be re-ratified from production evidence — but the _mechanism_ (a stated number, a stored
  baseline, a regression threshold) is what makes Gate H real, and that does not change.
- The ledger read-model rebuild target is a Gate C dependency as well as Gate H: Phase 2's exit
  criterion requires the rebuild to be possible, and a rebuild that takes hours is not operationally
  possible.
