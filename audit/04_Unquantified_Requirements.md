# 04 — Unquantified Requirements

Classification of all 260 pass/fail obligations in the package as **objectively testable** or
**unquantified**. An unquantified obligation is one that cannot be failed — and a gate that cannot be
failed is not a gate.

| Source | Count |
|---|---:|
| Acceptance bullets across docs 01–24 | 105 |
| Release gate criteria (Gates A–L) | 81 |
| Phase exit criteria (Phases 0–11) | 56 |
| Definition-of-Done items | 18 |
| **Total** | **260** |

---

## Headline

| Classification | Count | % |
|---|---:|---:|
| **Objectively testable as written** | 191 | 73% |
| **Unquantified** — needs a number, threshold or definition | 42 | 16% |
| **Unimplementable** — depends on something that does not exist | 27 | 10% |

### F-301 — S4 — Seventy-three percent of obligations are directly testable

Recorded as a positive, because it is unusual. The great majority of this specification's acceptance
criteria are written as concrete assertions — "Every generated posted journal balances exactly in
book/base currency", "Duplicate source event returns existing result and creates no duplicate",
"Reimport same statement is idempotent", "AR open-item total equals AR GL control account". These
translate to tests almost mechanically.

That quality is what makes the remaining 27% worth fixing rather than tolerating.

---

## 1. Performance — the largest unquantified block

### F-302 — S2 — Gate H defines no targets, and defers the definition indefinitely

Gate H opens: *"Define environment-specific targets before each release. At minimum test: high-volume
journal posting; Trial Balance and P&L over production-scale journal lines; AR/AP aging; bank matching
queue; inventory valuation; consolidation where enabled; bulk imports; API pagination."*

Eight workloads named. **Zero numbers.** No latency target, no throughput target, no data volume, no
concurrency level. Doc 19 repeats the deferral: *"Before enterprise launch define realistic seeded
volumes: entities, years, journal lines, invoices, bank transactions, concurrent users."*

Gate H is therefore unfailable. Any measurement satisfies "we tested it".

This also propagates: F-002 (denormalising `journal_lines`) is justified partly on Gate H grounds, and
without targets there is no evidence threshold for deciding it. Blueprint note 6 says "do not
prematurely partition… only after measuring workload" — but never says what measurement would trigger
partitioning.

**Resolution.** Ratify concrete Phase-0 baseline targets now, revisable with evidence. Proposed
defaults for a single-tenant reference dataset (1 entity, 3 fiscal years, 500k journal lines, 50k
invoices, 100k bank transactions, 10 concurrent users):

| Workload | Proposed target (p95) |
|---|---|
| Single journal post (10 lines) | < 150 ms |
| Trial Balance, 1 period | < 1.5 s |
| P&L with comparatives, 1 year | < 3 s |
| AR aging, 50k open items | < 2 s |
| Bank match candidate generation, 1 txn | < 500 ms |
| Inventory valuation, 10k items | < 5 s |
| Bulk import, 10k rows | < 5 min |
| API list endpoint, cursor page of 50 | < 300 ms |

These are starting positions to be argued with, not conclusions. The point is that Gate H needs a row
it can fail against. See [D-11](07_Open_Decisions.md).

### F-303 — S3 — No seeded dataset specification exists

Doc 19 requires "representative tenant sizes" and Gate H requires "store performance baselines and
regressions in CI/release evidence" — but the dataset those baselines are measured against is never
specified, so baselines are not comparable between runs.

**Resolution.** Define `packages/testing` seed profiles — `small`, `reference`, `large` — with fixed
row counts and a deterministic seed, in Phase 0. Gate H measures against `reference`; CI regression
checks run against `small`.

---

## 2. Operations and recovery

### F-304 — S2 — RPO and RTO are required per tier, and no tiers exist

Doc 16: *"Document RPO/RTO targets for each deployment tier."* Gate L requires point-in-time recovery
and a tested DR runbook. No tiers are defined anywhere in the package, and no targets are given.

**Resolution.** Two tiers to start — `standard` (RPO 15 min, RTO 4 h) and `critical` (RPO 5 min,
RTO 1 h) — with all tenants on `standard` until a commercial reason exists to offer more. Gate L then
tests a restore against a stated number.

### F-305 — S2 — Alert thresholds are required and unspecified

Gate L: *"Alert thresholds defined for posting failures, outbox backlog, connector failures,
reconciliation failures and database health."* Five alert classes, no thresholds. Doc 16 lists eleven
observability metrics with no thresholds either.

**Resolution.** Set initial thresholds in Phase 0 alongside the metrics, e.g. outbox unpublished age
p99 > 60 s; posting failure rate > 0.1% over 5 min; any connector 3 consecutive failures; any
reconciliation job failure. Tune from production evidence.

### F-306 — S3 — "No unresolved release-blocking findings" has no severity definition

Gate B: *"Security dependency/static scans have no unresolved release-blocking findings."*
"Release-blocking" is never defined. Without a mapping from scanner severity to release policy, the
gate is a judgement call made under release pressure.

**Resolution.** Define: CVSS ≥ 7.0 in a runtime dependency blocks; 4.0–6.9 requires a dated waiver;
< 4.0 is tracked. Any secret detected blocks unconditionally.

---

## 3. AI thresholds

### F-307 — S2 — Every AI automation threshold is deferred to itself

Doc 13: *"Automation threshold is enabled by task only after measured evaluation and live reviewer
acceptance support it."* Gate J: *"Evaluation thresholds are documented per feature."* Phase 8's exit
criterion: *"Evaluation thresholds defined in QA spec pass before enabling automatic actions."*

Three documents each defer the threshold to another document. Doc 19's AI evaluation section names
the metrics (extraction field accuracy, coding top-1/top-3, matching precision/recall, anomaly
precision, Q&A numerical correctness) but gives no values.

**Resolution.** Out of scope for the first release (Phase 8), but the *structure* is not: require that
every AI feature ships with a threshold recorded in `automation_policies` before it can be enabled,
and make "no threshold recorded" a hard block at the policy layer rather than a documentation
convention. That converts an unquantified gate into an enforced one without needing the numbers yet.

### F-308 — S3 — "Confidence" has no defined scale or calibration requirement

`ai_decisions.confidence numeric(8,6)` and `bank_matches.confidence numeric(8,6)` — no statement of
whether these are calibrated probabilities, raw model scores, or heuristic ranks. Doc 13 requires
"Confidence thresholds per action", which is meaningless across uncalibrated scales from different
providers.

**Resolution.** Define confidence as a calibrated probability in [0,1] and require providers to be
calibrated against the doc 19 evaluation sets before their scores gate any automation.

---

## 4. Tolerances and policy values

### F-309 — S2 — Matching and reconciliation tolerances are never quantified

- Doc 05 three-way matching: *"tolerance"* is a compare dimension; no default, no unit
  (absolute? percentage? per line or per document?).
- Doc 06 reconciliation: *"difference is zero/configured tolerance"* — no default.
- Doc 06 matching engine: scoring factors are listed with no weights and no auto-match threshold,
  though "Deterministic exact match can auto-match if policy permits".
- Phase 4 exit criterion: "Matching suggestions never post without configured automation/approval
  policy" — testable; the tolerance itself is not.

**Resolution.** Ship defaults in the accounting policy (F-203): three-way match tolerance 2% or 100
minor units, whichever is lower, per line; reconciliation tolerance 0 with an explicit per-account
override; auto-match only on exact amount + exact reference + same account.

### F-310 — S2 — Approval thresholds, credit limits and capitalization thresholds have no defaults

Doc 02's accounting policy lists "approval thresholds", "bad debt/write-off thresholds",
"capitalization threshold" as policy fields. Doc 14's SoD rules reference "payment over threshold
requires two distinct approvals". Gate F requires "Approval thresholds and conditions pass boundary
tests" — boundary tests need boundaries.

**Resolution.** These are legitimately per-tenant. The gap is that the *shipped default* is
unspecified, so a new tenant has undefined control behaviour. Define a conservative default policy set
seeded at organization creation, and make Gate F's boundary tests run against it.

### F-311 — S3 — AR aging buckets are stated as a default but not as a constraint

Doc 04: *"AR aging buckets configurable, default 0-30, 31-60, 61-90, 91+."* This one **is**
quantified — noted as the counter-example. The gap is only that AP aging has no stated default.

**Resolution.** Mirror the AR defaults for AP.

---

## 5. Obligations that depend on things which do not exist

Twenty-seven criteria are testable as written but currently **unimplementable**, because the artifact
they test is missing. These are not vague — they are blocked. Full detail in the referenced findings.

| Obligation | Source | Blocked by |
|---|---|---|
| "Posted journal application role cannot UPDATE/DELETE protected accounting facts" | Gate C | [F-004](01_Schema_Findings.md) — no immutability mechanism |
| "Property tests cannot create an unbalanced POSTED journal" | Gate C | [F-005](01_Schema_Findings.md) — no DB-level balance assertion |
| "Duplicate source events are idempotent" | Gate C | Satisfied — `journal_entries_source_event_uq` |
| "Ledger projections rebuild exactly from journal facts" | Gate C | [F-002](01_Schema_Findings.md) — no period/book on lines |
| "Authorization tests cover every mutation route" | Gate B | [F-016](01_Schema_Findings.md), [F-108](02_Contract_Drift.md) — no permission registry, no per-route permission |
| "Entity scope is enforced server-side" | Gate B | [F-003](01_Schema_Findings.md) — no structural entity integrity |
| "MFA/session policy is enforced where configured" | Gate B | [F-045](01_Schema_Findings.md) — no sessions table |
| "Audit trail records sensitive setup/permission changes" | Gate B | [F-043](01_Schema_Findings.md) — audit log is mutable |
| "AR/AP/tax/inventory/asset detail = GL control account" (6 criteria) | Gate D | [F-204](03_Coverage_Gaps.md) — no `AccountReconciliation`/`ReconcilingItem` |
| "Every displayed financial amount drills to ledger/source facts" | Gate E | [F-204](03_Coverage_Gaps.md) — no report definition model |
| "P&L closes correctly into equity/retained earnings policy" | Gate E | [F-401](05_Missing_Requirements.md) — the policy is never specified |
| "Statement snapshot is unchanged by future transactions" | doc 12 | `financial_snapshots` exists but cannot reference a report definition version |
| "Hard-closed periods reject all source posting paths" | Gate F | [F-011](01_Schema_Findings.md) — period resolution ambiguous with adjustment periods |
| "Reopen requires explicit privilege/workflow" | Gate F | [F-038](01_Schema_Findings.md) — `close_runs` cannot record a second close |
| "Two receipts allocated to last invoice balance" | Gate G | [F-021](01_Schema_Findings.md) — no over-allocation protection |
| "Duplicate number allocation" | Gate G | [F-012](01_Schema_Findings.md) — no allocation protocol |
| "Two stock issues consume last quantity/cost layer" | Gate G | [F-032](01_Schema_Findings.md) — no layer concurrency protocol |
| "FX/revaluation runs" concurrency | Gate G | [F-037](01_Schema_Findings.md) — only one run per period possible |
| "Webhook retries" concurrency | Gate G | [F-046](01_Schema_Findings.md) — attempt history overwritten |
| "Bank imports" concurrency | Gate G | [F-028](01_Schema_Findings.md) — wrong dedupe key |
| "Every financial report amount can drill to ledger lines" | Phase 6 | as Gate E above |
| "An outbox event cannot be published before the originating DB transaction commits" | doc 01 | Testable; but [F-042](01_Schema_Findings.md) — no consumer checkpoint to verify against |
| "Same idempotency key yields one financial result" | doc 01 | [F-044](01_Schema_Findings.md) — protocol undefined |

**This table is the strongest argument for the audit-first sequencing.** Twenty-seven of the
specification's own gate criteria cannot be satisfied by the specification's own blueprints. Resolving
the S1/S2 schema and contract findings unblocks all of them.

---

## 6. Definition of Done — assessment

Doc 22's 18-item Definition of Done is the strongest artifact in the package. Every item is a concrete
question with a yes/no answer, and together they cover domain rules, permissions, state machines,
idempotency, posting impact, tax/FX/period behaviour, audit, API contract, UI states, events, four
categories of test, reporting impact, migration path, documentation and observability.

### F-312 — S3 — The Definition of Done has no enforcement mechanism

It is a checklist in a markdown file. Nothing in CI checks it; nothing in the schema or contracts
records whether a feature satisfied it.

**Resolution.** Encode it as a PR template with required checkboxes, and make the mechanically
checkable subset actual CI gates: item 5 (posting impact) → every new posting rule has a golden
fixture; item 8 (API contract) → every new route exists in `contracts/openapi.yaml`; item 10 (events)
→ every emitted event exists in `contracts/events.yaml`; item 11/12 (tests) → coverage threshold on
new domain code. Five of eighteen become automatic; the rest stay human.

---

## Summary

| ID | Severity | Title |
|---|---|---|
| F-302 | **S2** | Gate H names 8 workloads and defines zero targets |
| F-304 | **S2** | RPO/RTO required per tier; no tiers, no targets |
| F-305 | **S2** | Five alert classes required; no thresholds |
| F-307 | **S2** | AI automation thresholds deferred circularly across three docs |
| F-309 | **S2** | Matching and reconciliation tolerances never quantified |
| F-310 | **S2** | Approval/write-off/capitalization thresholds have no shipped defaults |
| F-303 | S3 | No seeded dataset spec, so baselines are not comparable |
| F-306 | S3 | "Release-blocking finding" undefined |
| F-308 | S3 | "Confidence" has no defined scale or calibration requirement |
| F-311 | S3 | AP aging buckets have no default (AR does) |
| F-312 | S3 | Definition of Done has no enforcement mechanism |
| F-301 | — | 73% of obligations are objectively testable (positive) |
