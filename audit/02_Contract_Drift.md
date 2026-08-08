# 02 — Contract Drift

Three-way diff: module-doc prose vs [event_catalog.json](../project%20plan/event_catalog.json) vs
[api_route_catalog.yaml](../project%20plan/api_route_catalog.yaml).

**Why this matters most.** Doc 15 commits to a versioned public API with a backward-compatibility
policy, and Gate 9 requires "API/webhook contract tests and backward compatibility policy pass". Event
types are declared **immutable once published** (`event_catalog.json`, rules[1]). Every name chosen
here is chosen once. A name fixed after Phase 9 costs a version bump and a deprecation window;
a name fixed now costs nothing.

Method: sections parsed from the master specification, event tokens extracted from each doc's
`## Events` block, route paths from each `## APIs` block (with `|` alternation and `GET/POST` prefix
forms expanded), then set-differenced against the two catalogs. Script:
`scratchpad/extract2.py`. Counts below are machine-produced, not estimated.

---

## Part A — Events

| Measure | Count |
|---|---:|
| Events in `event_catalog.json` | 136 |
| Distinct events named in doc `## Events` sections | 83 |
| Agree (identical name in both) | 36 |
| **Named in a doc but absent from the catalog** | **47** |
| In the catalog, never named in a doc | 100 |

The 100 catalog-only events are mostly benign — doc Events sections list a representative subset, not
an exhaustive one. **The 47 doc-named-but-absent events are the finding.** Each is either a rename
collision (same event, two names — a trap, because both look valid) or a genuinely missing event.

### F-101 — S3 — Twenty-two events exist under two different names

Same domain event, two spellings. Whichever a developer reads first becomes what they emit; the other
consumer never fires. These are the dangerous ones — nothing errors, the event simply never arrives.

| Doc name | Catalog name | Doc | Canonical (recommended) |
|---|---|---|---|
| `customer_receipt.posted` | `customer_receipt.received` | 04 | **`customer_receipt.received`** — receipt of funds and posting are distinct moments; keep both, add `customer_receipt.posted` (see F-102) |
| `bill.posted` | `vendor_bill.posted` | 05 | **`vendor_bill.posted`** — `bill.` prefix is ambiguous with billing/subscriptions (doc 24) |
| `bill.approved` | `vendor_bill.approved` | 05 | **`vendor_bill.approved`** |
| `bill.extracted` | *(none — closest `ai.document_extracted`)* | 05 | **`ai.document_extracted`** with `aggregate_type=vendor_bill` |
| `bill.match_exception` | `vendor_bill.matched` (inverse) | 05 | **`vendor_bill.match_failed`** — add; `matched` cannot represent the exception path |
| `purchase_requisition.approved` | `purchase_requisition.submitted` | 05 | keep both — different lifecycle points; **add `.approved`** |
| `purchase_order.sent` | `purchase_order.issued` | 05 | **`purchase_order.issued`** |
| `payment_run.approved` | `vendor_payment.approved` | 05 | keep both — a run is not a payment; **add `payment_run.approved`** |
| `vendor_payment.posted` | `vendor_payment.completed` | 05 | **`vendor_payment.completed`** for provider confirmation; **add `.posted`** for the accounting event |
| `vendor_payment.failed` | *(none)* | 05 | **add `vendor_payment.failed`** — doc 05 requires FAILED status tracking |
| `bank_feed.synced` | `bank_feed.sync_completed` | 06 | **`bank_feed.sync_completed`** |
| `reconciliation.finalized` | `bank_reconciliation.completed` | 06 | **`bank_reconciliation.completed`** — `reconciliation.completed` also exists under `close_reporting`, so the unprefixed form is genuinely ambiguous |
| `transfer.posted` | `bank_transfer.completed` | 06 | **`bank_transfer.completed`** |
| `settlement.matched` | `processor_settlement.reconciled` | 06 | **`processor_settlement.reconciled`** |
| `bank_transaction.categorized` | *(none)* | 06 | **add** — doc 06 specifies a categorize action with its own route |
| `tax_return.ready` | `tax_return.reviewed` | 07 | keep both — doc 07's status machine is `OPEN→PREPARING→READY→FILED→AMENDED`; **add `.ready`** |
| `tax_return.amended` | *(none)* | 07 | **add** — terminal state in doc 07's machine |
| `depreciation.posted` | `asset.depreciation_posted` | 09 | **`asset.depreciation_posted`** |
| `budget.superseded` | `budget.revised` | 10 | **`budget.revised`** for the action; **add `budget.superseded`** for the old version's transition |
| `close_task.completed` | `close.task_completed` | 12 | **`close.task_completed`** |
| `accounting_period.closed` | `accounting_period.soft_closed` / `.hard_closed` | 02, 12 | **use the explicit pair** — a single `.closed` cannot distinguish the two states the whole platform gates on |
| `role.updated` | `role.changed` | 02 | **`role.changed`** |

**Resolution.** Adopt the recommended column into `contracts/events.yaml`. Rule to apply
consistently: **`<aggregate>.<past_tense_verb>`, aggregate names matching the schema table's singular
form.** That rule mechanically resolves `bill.` → `vendor_bill.`, `transfer.` → `bank_transfer.`,
`depreciation.` → `asset.depreciation_`, and `reconciliation.` → `bank_reconciliation.`.

### F-102 — S2 — Twenty-five events are specified in prose but exist in no catalog

These are not naming disputes. The doc requires the behaviour; the catalog has no event for it, so
nothing downstream can subscribe.

| Event | Doc | Why it is required |
|---|---|---|
| `invoice.partially_paid` | 04 | Doc 04 lifecycle has an explicit `PARTIALLY_PAID` state; catalog jumps `invoice.posted` → `invoice.paid` |
| `dunning.stage_changed` | 04 | Doc 04 dunning escalation is event-driven |
| `user.suspended` | 02 | Doc 02 acceptance: "Suspended user loses active access" — needs session-revocation fan-out |
| `legal_entity.activated` | 02 | Distinct from `.created`; posting is disabled until activation (doc 02) |
| `accounting_policy.version_created` | 02 | Versioned policy is a non-negotiable rule (doc 01 §7) |
| `localization.installed` | 07 | Doc 07 upgrade flow is an 8-step audited process |
| `localization.upgraded` | 07 | Distinct from install; carries the version delta |
| `tax_calculation.completed` | 07 | Needed for the tax subledger write path |
| `tax_rule.version_created` | 07 | Same versioning obligation |
| `einvoice.accepted` | 07 | Doc 07 e-invoice adapter has explicit accept handling |
| `einvoice.rejected` | 07 | …and an explicit rejection path with retry semantics |
| `report.generated` | 12 | Doc 12 requires export/report audit logging |
| `account_reconciliation.certified` | 12 | Preparer/approver certification is a Gate D artifact |
| `financial_statements.approved` | 12 | Gates the immutable snapshot |
| `audit_request.created` | 12 | Auditor workspace workflow |
| `workflow.started` | 14 | Instance lifecycle, distinct from step-level `approval.*` |
| `workflow.completed` | 14 | Instance terminal state |
| `task.created` | 14 | The unified task inbox has 10 source types (doc 14) |
| `task.completed` | 14 | Closes the inbox item and its escalation timers |
| `notification.sent` | 14, 23 | Delivery confirmation with provider message ID |
| `notification.failed` | 14, 23 | Doc 23: "Notification delivery failures enter operations view" |
| `budget.threshold_exceeded` | 10 | Doc 10 budget control policy: warn/block/override |
| `forecast.published` | 10 | Doc 10 forecast lifecycle |
| `billing_proposal.created` | 10 | Project billing hand-off to AR |
| `bank_connection.expiring` | 06 | Doc 15: "Alert before credentials expire" — this is the alert's trigger |

**Resolution.** Add all 25 to `contracts/events.yaml`, applying the F-101 naming rule
(`accounting_period.closed` resolves to the soft/hard pair; `close_task.completed` to
`close.task_completed`). Twenty-five additions against a 136-event catalog is an **18% expansion** —
the catalog is not near-complete, and treating it as such would leave a fifth of the domain's
integration surface undeliverable.

### F-103 — S3 — The event envelope requires fields the outbox table cannot store

`event_catalog.json` marks `organization_id` and `legal_entity_id` as **required** envelope fields.
`outbox_events` (schema line 664) has `tenant_id` only. Cross-referenced as
[F-040](01_Schema_Findings.md) in the schema audit.

**Resolution.** Add both columns to `outbox_events` as first-class indexed fields, not payload JSON —
entity-scoped webhook subscriptions and per-entity replay both need to filter on them.

### F-104 — S4 — Catalog groups do not map cleanly to phases or modules

`event_catalog.json` groups events into 14 buckets (`platform`, `ledger`, `sales_ar`,
`purchasing_ap`, …) that match neither doc 00's 40-module matrix nor the 12 phases. `close_reporting`
merges two modules; `platform` holds both tenancy and period events.

**Resolution.** Low priority. Keep the groups as documentation aids; do not use them as a routing or
authorization key.

---

## Part B — API Routes

| Measure | Count |
|---|---:|
| Route entries in `api_route_catalog.yaml` | 192 |
| Distinct paths in catalog | 150 |
| (verb, path) pairs named in doc `## APIs` sections | 90 |
| **Doc paths absent from the catalog** | **38** |
| Verb mismatches on an otherwise-matching path | 1 |

### F-105 — S3 — Nine routes exist under two different paths

| Doc path | Catalog path | Doc | Canonical (recommended) |
|---|---|---|---|
| `/bills`, `/bills/{id}/match\|approve\|post` | `/vendor-bills`, `/vendor-bills/{id}/…` | 05 | **`/vendor-bills`** — matches the table and disambiguates from subscription billing |
| `/reconciliations`, `/reconciliations/{id}/finalize` | `/bank-reconciliations`, `/bank-reconciliations/{id}/complete` | 06 | **`/bank-reconciliations`**; verb **`/complete`** (doc 12 uses `finalize` for close runs — keep the words distinct) |
| `/transfers` | `/bank-transfers` | 06 | **`/bank-transfers`** |
| `/bank-imports` | `/bank-accounts/{id}/imports` | 06 | **`/bank-accounts/{id}/imports`** — imports are always account-scoped |
| `PATCH /periods/{id}/status` | `POST /accounting-periods/{id}/soft-close\|hard-close\|reopen` | 02 | **the three explicit commands** — a generic status PATCH cannot carry per-transition permissions, and doc 02 requires reopen to demand reason + audit + optional approval |
| `/tax-returns/{id}/finalize` | `/tax-returns/{id}/mark-filed` | 07 | **`/mark-filed`** — doc 07's terminal transition is "filed with reference/evidence" |
| `/depreciation-runs` | `/assets/depreciation-runs` | 09 | **`/assets/depreciation-runs`** |
| `/approvals/{id}/…` | `/approval-tasks/{id}/…` | 14 | **`/approval-tasks/{id}/…`** |
| `/users/invitations` | `/users/invite` | 02 | **`POST /users/invite`** |

### F-106 — S2 — Twenty-nine routes are specified in prose but absent from the catalog

Grouped by the phase that needs them:

**Phase 1 (setup):** `/accounting-policies`, `/number-sequences`, `/settings/effective`
— doc 02 requires all three; `/settings/effective` is how the six-level configuration precedence
chain (doc 01) becomes inspectable, and without it the precedence rules are untestable.

**Phase 3 (AR/AP/tax):** `/ar/aging`, `/customers/{id}/statement`, `/vendor-payments`,
`/localizations`, `/legal-entities/{id}/localization/install`, `/einvoice/{documentId}/submit`
— note the catalog has `GET /reports/ar-aging` but doc 04 also specifies `/ar/aging` as a
subledger endpoint; these are arguably the same and should collapse to the report route.

**Phase 5 (projects/budgets):** `/forecasts`, `/budget-control/check`,
`/projects/{id}/billing-proposals` — `/budget-control/check` is the enforcement point for doc 10's
block/warn/override policy. Without it, budget control is advisory only.

**Phase 6 (reporting/close/workflow):** `/report-definitions`, `/report-runs`,
`/financial-statement-snapshots`, `/account-reconciliations`, `/close-checklists/generate`,
`/tasks`, `/workflows`, `/workflows/{id}/publish` — this is the largest cluster.
`/report-definitions` and `/report-runs` underpin doc 12's versioned custom reports;
`/financial-statement-snapshots` is what Gate E's immutability criterion tests;
`/account-reconciliations` is what Gate D's certification tests.

**Phase 4 (banking):** `/bank-connections`, `/cash-position` — doc 06 specifies a cash position
dashboard as a deliverable and Phase 4's Build list names it explicitly.

**Resolution.** Add all to `contracts/openapi.yaml`. **The catalog is ~20% incomplete against the
prose**, and the gaps cluster in Phase 6 — which is exactly where Gates D, E and F are proven.

### F-107 — S1 — `POST /tax-returns` is specified but the catalog exposes only `GET`

Doc 07 specifies `POST /tax-returns`; the catalog has `GET /tax-returns` plus three sub-commands
(`prepare`, `approve`, `mark-filed`) but **no way to create a return**. The tax return lifecycle has
no entry point.

**Resolution.** Add `POST /tax-returns`. Severity is S1 rather than S3 because this is not a naming
disagreement — a required workflow is unreachable as catalogued.

### F-108 — S3 — The catalog omits the API conventions the docs mandate

`api_route_catalog.yaml` has a good `conventions` block (auth, tenant scope, idempotency, pagination,
errors, money-as-decimal-strings). But per-route it records **only method and path** — no request or
response schema, no per-route permission, no statement of which routes require `Idempotency-Key`.

Doc 15 requires an OpenAPI document, stable error codes, and documented scopes. Doc 01 requires
idempotency on a specific list of operations (post invoice/bill/journal, receive/pay/refund, bank
matching, external creates, provider callbacks, migration imports, background jobs) — none of which
is marked in the catalog.

**Resolution.** `contracts/openapi.yaml` must carry, per route: request/response schema, required
permission, `Idempotency-Key` requirement (required / optional / n-a), and idempotency scope key.
Deriving the permission matrix from this file is what makes Gate B's "authorization tests cover every
mutation route" mechanically checkable rather than aspirational.

### F-109 — S4 — Route naming is inconsistent within the catalog itself

`POST /integrations/{provider}/connect` uses a slug where every other path uses `{id}`;
`/inventory/receipts` nests under a module prefix while `/goods-receipts` sits at root for the same
physical event; `/customer-receipts` vs `/customer-refunds` vs `/payment-runs` mix aggregate
granularity.

**Resolution.** Adopt one rule — plural kebab-case aggregate at root, sub-resources nested,
commands as `POST /{aggregate}/{id}/{verb}` — and apply during `contracts/openapi.yaml` authoring.

---

## Summary

| ID | Severity | Title |
|---|---|---|
| F-107 | **S1** | `POST /tax-returns` missing — tax return lifecycle has no entry point |
| F-102 | **S2** | 25 events specified in prose exist in no catalog (18% expansion needed) |
| F-106 | **S2** | 29 routes specified in prose absent from catalog (~20% incomplete) |
| F-101 | S3 | 22 events exist under two different names |
| F-103 | S3 | Envelope requires `organization_id`/`legal_entity_id`; outbox cannot store them |
| F-105 | S3 | 9 routes exist under two different paths |
| F-108 | S3 | Catalog omits schemas, permissions and idempotency markers |
| F-104 | S4 | Catalog event groups map to neither modules nor phases |
| F-109 | S4 | Internal naming inconsistency in the route catalog |

**Bottom line.** Neither catalog is authoritative today, and neither is close to complete against the
prose. Deliverable 2 must produce `contracts/events.yaml` and `contracts/openapi.yaml` as the single
source of truth, generated once and then treated as the contract — with the module-doc prose demoted
to rationale.
