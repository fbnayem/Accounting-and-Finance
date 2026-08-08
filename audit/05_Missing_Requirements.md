# 05 — Missing Requirements

Subjects the build will hit that the specification does not address. Distinct from
[03_Coverage_Gaps](03_Coverage_Gaps.md) (specified but unmodelled) and
[04_Unquantified_Requirements](04_Unquantified_Requirements.md) (specified but unmeasurable) —
these are **not specified at all**.

Ordered by when they will block work.

---

## 1. Accounting substance

### F-401 — S1 — The accounting framework is never named

The specification requires a Profit & Loss, Balance Sheet, Cash Flow Statement and Trial Balance
(doc 12), a retained earnings policy (doc 02), revaluation and impairment (doc 09), advanced revenue
recognition (doc 24), and consolidation with CTA (doc 11). It never states **which accounting
framework** these implement — IFRS, US GAAP, or a local GAAP.

This is not academic. The framework decides:

- **Revaluation.** `ASSET_REVALUATION` posts "to Revaluation Surplus or P&L according to book/local
  rule". A revaluation model for PPE exists under IFRS (IAS 16) and does **not** exist under US GAAP.
  The posting rule presumes a model the framework may forbid.
- **Impairment reversal.** IAS 36 permits reversal for non-goodwill assets; US GAAP prohibits it. The
  schema has `asset.impaired` with no reversal event and doc 09 says "never overwrite historical cost"
  — silent on whether reversal is even legal.
- **Inventory.** IFRS prohibits LIFO; doc 08 offers FIFO and weighted average and defers "Standard
  Cost and Specific Identification", which is IFRS-compatible — but the exclusion is by accident, not
  by stated constraint.
- **Development costs, lease accounting, expected credit loss.** Doc 04's "Bad debt/write-off" with an
  allowance account is compatible with both, but IFRS 9's expected-credit-loss model implies a
  forward-looking provision the specification never mentions.
- **Cash flow.** Doc 12 says "Initial method can use configured account/cash-flow classification…
  Later support indirect/direct presentation variants by market need." Both frameworks permit both
  methods, but the indirect method requires a reconciliation from profit that the described
  classification-based approach does not produce.

**Resolution.** Name the framework. Recommendation for a generic/global first release: **IFRS as the
default posting model**, with local GAAP handled as a Phase 10 country-pack concern via the multi-book
mechanism (doc 11) — which is exactly what parallel books exist for. Record it as an ADR and add the
constraint to every posting rule that currently says "according to book/local rule". See
[D-01](07_Open_Decisions.md).

### F-402 — S1 — The retained earnings and year-end rollover policy is undefined

`PERIOD_CLOSE_PNL_TRANSFER` in the posting rule catalog reads, in full:

> Only if book policy requires explicit closing journals. Close income/expense accounts to retained
> earnings/current-year earnings. Must be reversible/reproducible by period-close run.

"Only if book policy requires" implies an alternative — deriving retained earnings at report time
rather than posting a closing journal. **That alternative is never specified.** Yet Gate E requires
"P&L closes correctly into equity/retained earnings policy", and the Balance Sheet cannot balance
without a decision.

The two designs are materially different and not interchangeable:

| | Explicit closing journal | Derived at report time |
|---|---|---|
| Retained earnings balance | A real posted balance | Computed: prior RE + Σ(revenue − expense) to date |
| Trial Balance after year end | P&L accounts zero | P&L accounts retain balances |
| Reopening a prior year | Must reverse and repost the closing entry | Nothing to reverse |
| Multi-book | One closing entry per book | Naturally per-book |
| Gate C "rebuild projections from journal facts" | Closing entry is a journal fact — fine | RE is not a journal fact — the rebuild must know the rule |

**Resolution.** Choose **derived at report time**, with the closing journal as an optional per-book
policy for jurisdictions that require it. Rationale: it keeps prior-period reopening simple (doc 12
requires a reopen workflow), it composes with multi-book, and it avoids a class of bug where the
closing entry and the underlying P&L diverge. Then specify the derivation precisely, because Gate C's
projection-rebuild test must reproduce it. See [D-01](07_Open_Decisions.md).

### F-403 — S2 — Period resolution for ambiguous posting dates is unspecified

Doc 01 states `posting_date` determines the accounting period. Doc 02 permits "optional adjustment
periods". Adjustment periods overlap regular periods by design (they exist to hold post-year-end
adjustments dated within the year). Which period a given `posting_date` resolves to is never stated.

Compounded by [F-011](01_Schema_Findings.md) — no adjustment flag on `accounting_periods`.

**Resolution.** Specify: resolution returns the non-adjustment period containing `posting_date` unless
the caller explicitly names an adjustment period **and** holds the `post_to_adjustment_period`
permission. Add it to the posting service algorithm (doc 03 step 3).

### F-404 — S2 — There is no general archival, retention or deletion policy

The only statement in the package is doc 03's "used account is archived, not deleted". Doc 23 requires
a tenant closure and export workflow, doc 16 requires backups, and doc 24 mentions "Advanced data
retention, legal hold and export controls" as a Phase 10 enterprise extension.

But nothing says how long `audit_events` are kept, whether `bank_transactions.raw_payload` (which can
hold personal data) is ever purged, what happens to `files` when a source document is voided, or what
"deletion" means for a tenant that has posted journals — which doc 23 correctly insists must survive
subscription cancellation.

**Resolution.** Write a retention schedule per table class in Phase 0: posted accounting facts —
indefinite; audit events — 7 years minimum; raw feed payloads — 90 days then purge to normalized form;
files — lifecycle follows the source document; idempotency keys — 30 days; outbox — 30 days post
publish. Legal hold overrides all. This is cheap now and painful once production data exists.

---

## 2. Product surface

### F-405 — S2 — No UI internationalisation architecture

Doc 02 collects "default language/date/number formatting" at onboarding, and doc 20 targets Bangladesh
where Bangla is the official language. Doc 23 has `NotificationTemplate` with a `locale` field. But
there is **no** specification of UI internationalisation: no message catalog format, no
pluralisation strategy, no locale-aware number and date formatting rules, no RTL consideration, no
statement of which locales ship.

Accounting UIs are unusually sensitive here: digit grouping conventions differ (the Indian
subcontinent's lakh/crore grouping is 12,34,567 not 1,234,567), negative number presentation differs
(parentheses vs minus), and currency symbol placement is locale- and currency-dependent.

**Resolution.** Not needed for a generic/global English-first release, but the **money and date
formatting layer must be locale-parameterised from Phase 0** — retrofitting formatting through every
component later is the expensive path. Specify the message catalog format now, ship `en` only.

### F-406 — S2 — No accessibility standard is stated

Absent entirely. Doc 18 specifies the screen map, record page standard, list behaviour and form
behaviour in detail, and mentions "keyboard-friendly accounting grids" — the only accessibility-
adjacent requirement in 3,079 lines.

This matters commercially: public-sector and enterprise procurement in most markets requires a VPAT
or WCAG conformance statement, and doc 24 targets enterprise customers.

**Resolution.** Adopt **WCAG 2.2 Level AA** as the target. Add automated axe checks to the Phase 0 CI
pipeline so violations are caught per-component rather than discovered in an audit. Cheap at Phase 0,
expensive at Phase 6.

### F-407 — S3 — No specification of the accounting grid's behaviour

Doc 18 requires "keyboard-friendly accounting grids" and "server-authoritative totals" and stops
there. The journal entry and invoice line grids are where accountants spend most of their time, and
their behaviour — tab order, copy/paste of a block from Excel, autofill of the balancing line,
inline account search by code or name, running debit/credit totals — is the single largest
determinant of whether the product feels professional.

**Resolution.** Write a grid behaviour specification before Phase 2's manual journal screen. This is
product design work, not a defect, but it is on the critical path for the first screen users will
judge.

---

## 3. Security, privacy and AI governance

### F-408 — S2 — No data residency or cross-border transfer policy

Doc 16 covers encryption, secrets and tenant isolation well. It does not address **where data
physically lives**. Doc 13 sends financial documents to external AI providers; doc 23 permits
"Tenant-level data policy can disable external model processing or require approved provider" — which
implies residency matters, without specifying it.

For a multi-tenant platform with Bangladesh in scope and enterprise ambitions, this will be asked in
the first serious sales conversation.

**Resolution.** Specify at minimum: single-region deployment per tenant with the region recorded on
`tenants`; an explicit list of sub-processors including AI providers; a per-tenant flag disabling
external model processing entirely (doc 13 already implies it — make it structural); and a statement
of which data classes may leave the primary region (backups, telemetry, AI payloads).

### F-409 — S2 — No AI cost control

Doc 23 requires usage metering for "AI document pages, AI actions" as billable dimensions. Doc 13
requires provider abstraction and a "Safe fallback when model/provider unavailable". Neither specifies
**spend limits**.

A tenant uploading 50,000 pages to document extraction, or an automation policy in a retry loop, is an
uncapped cost to the platform operator. `automation_policies` has conditions and actions but no budget.

**Resolution.** Add per-tenant and per-feature budget caps to the entitlement model, enforced before
the provider call, with the doc 13 fallback path used on exhaustion. Specify in Phase 1 with the
entitlement service even though Phase 8 consumes it.

### F-410 — S3 — No PII inventory or data subject request process

The schema holds names, emails, phone numbers, addresses, tax identifiers, bank details, IP addresses
and user agents. Doc 16 requires field-level encryption for "bank credentials, OAuth tokens and other
high-risk secrets" — but there is no PII inventory, no classification, and no process for access or
erasure requests. Doc 23's tenant closure workflow mentions "deletion/anonymization only according to
policy/legal requirements" without defining the policy.

**Resolution.** Classify every column holding personal data during the Deliverable 2 schema pass — the
one time the whole schema is being reviewed anyway. Then define the subject-request process against
that inventory.

### F-411 — S3 — Prompt injection controls are required but not designed

Doc 13 states the principle correctly — *"Treat text inside uploaded documents/emails as untrusted
data, not instructions. Tool-use policy is external to model output."* — and Gate J requires an
adversarial test suite. But no mechanism is specified: no statement of how document text is delimited
from instructions, no tool-call authorization model beyond "allowlisted", no output validation
approach.

**Resolution.** Phase 8 concern, but record now that the *principle* constrains Phase 3's document
service: extracted text must be stored in a form that preserves its untrusted provenance, so Phase 8
does not have to retrofit the distinction.

---

## 4. Commercial and operational

### F-412 — S3 — No pricing, packaging or target segment definition

Doc 23 specifies the mechanism (`Plan`, `PlanVersion`, `Entitlement`, `TenantLimit`) with an example
list of limitable capabilities. It does not name a single plan, price point or target customer
segment.

This is out of scope for a technical specification, but it has technical consequences: which features
are entitlement-gated, and at what granularity, is a schema decision. Doc 23's own instruction —
"Business code checks entitlements through a centralized service; do not scatter hard-coded plan names
across modules" — is exactly right and mitigates most of the risk.

**Resolution.** No action needed for the build. Recorded so it is not mistaken for an oversight.

### F-413 — S3 — No support, SLA or incident communication model

Doc 16 specifies incident response internally (severity, owner, timeline, containment, root cause).
Doc 23 covers support access grants and impersonation. Neither specifies customer-facing SLA,
status page, or incident communication.

**Resolution.** Defer. Note that doc 24's "Enterprise observability/SLA dashboards" presumes an SLA
that does not yet exist.

### F-414 — S3 — No branching, versioning or release cadence model

Doc 16 specifies the CI/CD pipeline shape and doc 15 requires API versioning with deprecation notices.
Neither specifies the repository branching model, semantic versioning policy, release cadence, or how
a deprecation window is measured.

**Resolution.** Trivial to decide, needed at Phase 0: trunk-based with short-lived branches, semver on
the public API only, deprecation window of two minor versions or 90 days.

---

## Summary

| ID | Severity | Title | Blocks |
|---|---|---|---|
| F-401 | **S1** | Accounting framework never named (IFRS vs GAAP) | Phase 2 posting rules, Phase 5 assets |
| F-402 | **S1** | Retained earnings / year-end rollover policy undefined | Gate E, Phase 2 |
| F-403 | **S2** | Ambiguous posting-date period resolution | Phase 2, Gate F |
| F-404 | **S2** | No retention, archival or deletion policy | Phase 0 |
| F-405 | **S2** | No i18n architecture | Phase 0 formatting layer |
| F-406 | **S2** | No accessibility standard | Phase 0 CI |
| F-408 | **S2** | No data residency policy | Phase 1, first enterprise sale |
| F-409 | **S2** | No AI cost control | Phase 1 entitlements |
| F-407 | S3 | Accounting grid behaviour unspecified | Phase 2 UI |
| F-410 | S3 | No PII inventory or subject-request process | Deliverable 2 |
| F-411 | S3 | Prompt injection controls stated as principle only | Phase 3 document service |
| F-412 | S3 | No pricing/packaging/segment definition | — |
| F-413 | S3 | No customer-facing SLA or incident comms | — |
| F-414 | S3 | No branching/versioning/release cadence model | Phase 0 |

**Two S1 findings, both accounting substance, both blocking Phase 2.** F-401 and F-402 must be decided
before the first posting rule is written — they change what the posting rules *are*, not merely how
they are implemented.
