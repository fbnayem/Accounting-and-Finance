# 00 — Findings Register

Deep audit of the Accounting Platform specification package (v1.0, 2026-08-07).
Audited 2026-08-07. **97 findings.**

| Detail file | Scope | Findings |
|---|---|---:|
| [01_Schema_Findings](01_Schema_Findings.md) | All 74 tables vs owning module spec | 51 |
| [02_Contract_Drift](02_Contract_Drift.md) | Module prose vs event catalog vs route catalog | 9 |
| [03_Coverage_Gaps](03_Coverage_Gaps.md) | 199 spec'd data objects vs schema | 7 |
| [04_Unquantified_Requirements](04_Unquantified_Requirements.md) | 260 pass/fail obligations | 12 |
| [05_Missing_Requirements](05_Missing_Requirements.md) | Subjects not addressed at all | 14 |
| [06_Package_Integrity](06_Package_Integrity.md) | Authenticity and completeness | 4 |
| [07_Open_Decisions](07_Open_Decisions.md) | 14 ADR seeds | — |

---

## Verdict

**This is a good specification with a schema that is not yet a migration set.**

The prose is genuinely strong. Doc 01's ten non-negotiable platform rules are the right ten rules.
Doc 03's posting service algorithm is a correct 17-step description of how a ledger should work.
Doc 22's Definition of Done is better than most production teams operate with. **73% of the
specification's 260 pass/fail obligations are objectively testable exactly as written** — unusual, and
the reason the remaining 27% is worth fixing rather than tolerating.

The gap is between that prose and the four blueprints meant to implement it.

- The **schema blueprint** models the ledger core to production standard and sketches everything else.
  It covers **44% of the specified domain model** (~186 tables at full scope, against 74 blueprinted),
  and it omits the two mechanisms its own gates test hardest: posted-journal immutability and
  tenant/entity referential integrity.
- The **event catalog** disagrees with the module prose on 22 event names and is missing 25 events the
  prose requires — an 18% expansion — while declaring event types immutable once published.
- The **route catalog** disagrees on 9 paths, omits 29 routes the prose specifies, and has one
  workflow (`POST /tax-returns`) with no entry point at all.
- **Twenty-seven of the specification's own gate criteria are currently unimplementable**, because
  they test artifacts the blueprints do not provide.

None of this is unusual for a v1.0 handoff, and none of it is expensive to fix now. All of it is
expensive to fix after migration 0001, after the first golden fixture, or after the public API ships
under a backward-compatibility policy.

**Two findings are not schema issues and are the most important in the audit:** the accounting
framework is never named ([F-401](05_Missing_Requirements.md)) and the retained-earnings policy is
never specified ([F-402](05_Missing_Requirements.md)). Both change what the posting rules *are*. Both
must be decided before Phase 2 writes one.

---

## Severity distribution

| Severity | Definition | Count |
|---|---|---:|
| **S1** | Blocks correctness — wrong accounting, data corruption, or cross-tenant leak if built as written | **14** |
| **S2** | Blocks a gate — prevents a phase exit criterion or release gate being objectively passable | **36** |
| **S3** | Contract debt — ambiguity or drift that becomes a breaking change once public | **40** |
| **S4** | Noted — incomplete but explicitly acknowledged by the spec as deferred | **7** |

---

## S1 — Must be resolved before migration 0001

Fourteen findings. Every one is either impossible to retrofit or produces silently wrong accounting.

| ID | Title | Area | Decision |
|---|---|---|---|
| [F-001](01_Schema_Findings.md) | `journal_lines` CHECK forbids zero-value lines — blocks zero-cost issues, 100% discounts, FX lines rounding to zero | Ledger | — |
| [F-002](01_Schema_Findings.md) | `journal_lines` lacks entity, book, period, posting date — every ledger read joins; partitioning foreclosed; retrofit needs a maintenance window | Ledger | [D-03](07_Open_Decisions.md) |
| [F-003](01_Schema_Findings.md) | Nothing prevents a journal line referencing another entity's account | Ledger | [D-02](07_Open_Decisions.md) |
| [F-004](01_Schema_Findings.md) | No posted-journal immutability mechanism — the single most-tested property in the spec | Ledger | — |
| [F-019](01_Schema_Findings.md) | `invoices` has no posting date or book — cannot determine its own accounting period | AR/AP | [D-04](07_Open_Decisions.md) |
| [F-020](01_Schema_Findings.md) | `vendor_bills` unique constraint makes the spec'd duplicate-override workflow impossible | AP | — |
| [F-021](01_Schema_Findings.md) | Nothing prevents over-allocating a payment or overpaying an invoice | AR/AP | [D-07](07_Open_Decisions.md) |
| [F-028](01_Schema_Findings.md) | Bank dedupe enforces the fallback fingerprint, not the primary provider ID — loses real transactions and accepts real duplicates | Banking | — |
| [F-036](01_Schema_Findings.md) | Nullable `tenant_id` in the `exchange_rates` unique key leaves global rates unconstrained | FX | [D-10](07_Open_Decisions.md) |
| [F-041](01_Schema_Findings.md) | `outbox_events` cannot carry the envelope fields the event catalog marks required | Platform | — |
| [F-107](02_Contract_Drift.md) | `POST /tax-returns` missing — the tax return lifecycle has no entry point | Contracts | — |
| [F-203](03_Coverage_Gaps.md) | `AccountingPolicy` has no table — every posting rule resolves its accounts through it | Setup | — |
| [F-401](05_Missing_Requirements.md) | Accounting framework never named (IFRS vs GAAP) — decides revaluation, impairment reversal, cash flow method | Accounting | [D-01](07_Open_Decisions.md) |
| [F-402](05_Missing_Requirements.md) | Retained earnings / year-end rollover policy undefined — Gate E cannot pass | Accounting | [D-01](07_Open_Decisions.md) |

---

## S2 — Must be resolved before the gate they block

Thirty-six findings, grouped by the phase that first hits them.

### Phase 0
| ID | Title |
|---|---|
| [F-042](01_Schema_Findings.md) | No outbox consumer checkpoint mechanism |
| [F-043](01_Schema_Findings.md) | Audit log is mutable, though doc 16 requires immutability |
| [F-302](04_Unquantified_Requirements.md) | Gate H names 8 workloads and defines zero targets — unfailable |
| [F-304](04_Unquantified_Requirements.md) | RPO/RTO required per tier; no tiers, no targets |
| [F-305](04_Unquantified_Requirements.md) | Five alert classes required; no thresholds |
| [F-404](05_Missing_Requirements.md) | No retention, archival or deletion policy |
| [F-405](05_Missing_Requirements.md) | No i18n architecture — money/date formatting must be locale-parameterised from the start |
| [F-406](05_Missing_Requirements.md) | No accessibility standard stated |

### Phase 1
| ID | Title |
|---|---|
| [F-011](01_Schema_Findings.md) | Periods can overlap; adjustment periods unmodelled |
| [F-012](01_Schema_Findings.md) | Number sequences cannot express their spec'd scope options; no allocation protocol |
| [F-016](01_Schema_Findings.md) | Permissions are an untyped JSON array |
| [F-018](01_Schema_Findings.md) | `users.email` globally unique — conflicts with the accountant portal |
| [F-207](03_Coverage_Gaps.md) | No `Permission` table; Gate B needs an enumerable set |
| [F-408](05_Missing_Requirements.md) | No data residency or cross-border transfer policy |
| [F-409](05_Missing_Requirements.md) | No AI cost control — uncapped provider spend |

### Phase 2
| ID | Title |
|---|---|
| [F-005](01_Schema_Findings.md) | Journal balance enforced nowhere in the schema |
| [F-006](01_Schema_Findings.md) | `journal_entries.currency` has undefined semantics |
| [F-008](01_Schema_Findings.md) | `journal_entries` has no `branch_id` — branch scoping has no server-side filter |
| [F-010](01_Schema_Findings.md) | Overlapping posting rule versions can both be effective |
| [F-403](05_Missing_Requirements.md) | Ambiguous posting-date period resolution |

### Phase 3
| ID | Title |
|---|---|
| [F-022](01_Schema_Findings.md) | `payments` cannot store FX settlement data — realized FX uncomputable |
| [F-023](01_Schema_Findings.md) | `ON DELETE CASCADE` on invoice and bill lines |
| [F-202](03_Coverage_Gaps.md) | 29 objects missing incl. the entire tax determination and versioning substrate |
| [F-309](04_Unquantified_Requirements.md) | Matching and reconciliation tolerances never quantified |
| [F-310](04_Unquantified_Requirements.md) | Approval, write-off and capitalization thresholds have no shipped defaults |

### Phase 4
| ID | Title |
|---|---|
| [F-029](01_Schema_Findings.md) | `bank_matches` has no integrity constraints |
| [F-030](01_Schema_Findings.md) | Completed reconciliations are not locked |

### Phase 5
| ID | Title |
|---|---|
| [F-031](01_Schema_Findings.md) | Serial numbers not unique; movement direction implicit |
| [F-032](01_Schema_Findings.md) | Cost layers can go negative; no concurrency protocol |

### Phase 6
| ID | Title |
|---|---|
| [F-038](01_Schema_Findings.md) | Only one close run per period possible — reopen cannot be recorded |
| [F-204](03_Coverage_Gaps.md) | Phase 6 is 30% covered and is where Gates D, E and F are proven |

### Phase 7
| ID | Title |
|---|---|
| [F-037](01_Schema_Findings.md) | Only one FX remeasurement run per period possible — blocks preview and rerun |

### Phase 8+
| ID | Title |
|---|---|
| [F-307](04_Unquantified_Requirements.md) | AI automation thresholds deferred circularly across three documents |

### Cross-cutting
| ID | Title |
|---|---|
| [F-102](02_Contract_Drift.md) | 25 events specified in prose exist in no catalog (18% expansion) |
| [F-106](02_Contract_Drift.md) | 29 routes specified in prose absent from catalog (~20% incomplete) |
| [F-201](03_Coverage_Gaps.md) | Blueprint covers 44% of the domain model; ~186 tables at full scope |

---

## S3 — Contract debt

Forty findings. Resolve during the phase that owns the affected area; none blocks a gate, all become
breaking changes once public.

| ID | Title | File |
|---|---|---|
| F-007 | Chart of accounts book-scoped while neighbours are entity-scoped | [01](01_Schema_Findings.md) |
| F-009 | Three incompatible representations of dimensions coexist | [01](01_Schema_Findings.md) |
| F-013 | Nothing enforces one primary accounting book per entity | [01](01_Schema_Findings.md) |
| F-014 | Two currency fields with an undefined relationship | [01](01_Schema_Findings.md) |
| F-015 | `fiscal_years` permits overlapping years | [01](01_Schema_Findings.md) |
| F-017 | Nullable columns in UNIQUE keys defeat four constraints | [01](01_Schema_Findings.md) |
| F-024 | `tax_transactions` not book-aware; links backwards from the ledger | [01](01_Schema_Findings.md) |
| F-025 | `tax_rates` has no unique or overlap constraint | [01](01_Schema_Findings.md) |
| F-026 | Contacts org-scoped with no sharing policy | [01](01_Schema_Findings.md) |
| F-027 | Denormalised balances have no supporting constraints | [01](01_Schema_Findings.md) |
| F-033 | Item accounting mappings cross a grain boundary | [01](01_Schema_Findings.md) |
| F-035 | `fixed_assets.dimensions jsonb` — fourth instance of F-009 | [01](01_Schema_Findings.md) |
| F-039 | Consolidation maps to a group chart that does not exist | [01](01_Schema_Findings.md) |
| F-040 | Intercompany pairs not tenant-checked | [01](01_Schema_Findings.md) |
| F-044 | Idempotency protocol unspecified | [01](01_Schema_Findings.md) |
| F-045 | No `sessions` table, though revocation is required | [01](01_Schema_Findings.md) |
| F-046 | Webhook delivery history overwritten by each retry | [01](01_Schema_Findings.md) |
| F-047 | `webhook_endpoints.subscribed_events` unvalidated | [01](01_Schema_Findings.md) |
| F-048 | Tenant-scoped object keys not enforced | [01](01_Schema_Findings.md) |
| F-049 | Status is an enum on 12 tables and free text on 21 | [01](01_Schema_Findings.md) |
| F-050 | Polymorphic references have no integrity strategy | [01](01_Schema_Findings.md) |
| F-051 | Numeric precision varies; rounding boundaries undefined | [01](01_Schema_Findings.md) |
| F-101 | 22 events exist under two different names | [02](02_Contract_Drift.md) |
| F-103 | Envelope requires IDs the outbox cannot store | [02](02_Contract_Drift.md) |
| F-105 | 9 routes exist under two different paths | [02](02_Contract_Drift.md) |
| F-108 | Route catalog omits schemas, permissions, idempotency markers | [02](02_Contract_Drift.md) |
| F-205 | Phase 10 BD localization has zero schema coverage | [03](03_Coverage_Gaps.md) |
| F-206 | Four generic tables silently absorb 14 spec'd objects | [03](03_Coverage_Gaps.md) |
| F-303 | No seeded dataset spec, so baselines are not comparable | [04](04_Unquantified_Requirements.md) |
| F-306 | "Release-blocking finding" undefined | [04](04_Unquantified_Requirements.md) |
| F-308 | "Confidence" has no defined scale or calibration requirement | [04](04_Unquantified_Requirements.md) |
| F-311 | AP aging buckets have no default (AR does) | [04](04_Unquantified_Requirements.md) |
| F-312 | Definition of Done has no enforcement mechanism | [04](04_Unquantified_Requirements.md) |
| F-407 | Accounting grid behaviour unspecified | [05](05_Missing_Requirements.md) |
| F-410 | No PII inventory or data subject request process | [05](05_Missing_Requirements.md) |
| F-411 | Prompt injection controls stated as principle only | [05](05_Missing_Requirements.md) |
| F-412 | No pricing, packaging or segment definition | [05](05_Missing_Requirements.md) |
| F-413 | No customer-facing SLA or incident communication model | [05](05_Missing_Requirements.md) |
| F-414 | No branching, versioning or release cadence model | [05](05_Missing_Requirements.md) |
| F-502 | 12 `phases/*.md` files absent, content unverified | [06](06_Package_Integrity.md) |

---

## S4 — Noted, no action

| ID | Title | File |
|---|---|---|
| F-034 | Partial and component asset disposal unmodelled — explicitly deferred by doc 09 | [01](01_Schema_Findings.md) |
| F-104 | Catalog event groups map to neither modules nor phases | [02](02_Contract_Drift.md) |
| F-109 | Internal naming inconsistency in the route catalog | [02](02_Contract_Drift.md) |
| F-301 | 73% of obligations are objectively testable — recorded as a positive | [04](04_Unquantified_Requirements.md) |
| F-501 | 22 `docs/*.md` absent but fully inlined in the master spec | [06](06_Package_Integrity.md) |
| F-503 | `README.md` absent — orientation material only | [06](06_Package_Integrity.md) |
| F-504 | Manifest paths do not match the delivered flat layout | [06](06_Package_Integrity.md) |

---

## What the specification gets right

Recorded so the audit is not mistaken for a rejection. Preserve these:

- **All 8 files match their published SHA-256 hashes.** The package is authentic and unmodified.
- **Doc 01's ten non-negotiable rules** are the correct ten. Rule 3 (business modules never write
  posted ledger tables) and rule 4 (correction by reversal, never silent edit) are the two that most
  accounting systems get wrong, and both are stated first and enforced throughout.
- **`journal_entries_source_event_uq`** — a partial unique index that makes "duplicate accounting event
  cannot double-post" structural rather than procedural.
- **Dual amount storage** on every journal line, with rate, rate date and rate source. Multi-currency
  designed in, not retrofitted.
- **`rule_snapshot jsonb NOT NULL` on `tax_transactions`** — freezing the tax calculation at
  transaction time is what makes "historical transactions retain their original rule version"
  achievable rather than aspirational.
- **`depreciation_schedule_lines UNIQUE (asset_book_id, accounting_period_id)`** — depreciation
  idempotency enforced by the database.
- **`numeric` throughout, no float anywhere.**
- **Doc 22's 18-item Definition of Done** — the strongest artifact in the package.
- **Blueprint notes 1–7** — the author documented what was deferred and why, including the honest
  admission that a `CHECK` cannot express the balance invariant and a refusal to partition
  prematurely.

---

## Recommended next step

Fourteen S1 findings, of which four require a decision rather than an edit:
**[D-01](07_Open_Decisions.md)** (accounting framework + retained earnings),
**[D-02](07_Open_Decisions.md)** (isolation mechanism),
**[D-03](07_Open_Decisions.md)** (journal line denormalisation),
**[D-07](07_Open_Decisions.md)** (allocation concurrency).

Each carries a recommendation in [07_Open_Decisions.md](07_Open_Decisions.md). None needs research —
only agreement. Ratifying those four unblocks Deliverable 2 (canonical contracts and a corrected
migration set), which in turn unblocks all 27 of the currently-unimplementable gate criteria.
