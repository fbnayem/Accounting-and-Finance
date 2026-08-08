# 03 — Coverage Gaps

Every data object named in a module doc's `## Data objects` section, matched against
[schema_blueprint.sql](../project%20plan/schema_blueprint.sql).

The blueprint's own note 1 concedes it is partial: *"Add full inventory, purchase order, asset,
project, budget, consolidation, localization, integration, migration, close-management and AI tables
as their modules are implemented."* This document quantifies **how** partial, because that number
drives every phase estimate.

Method: `## Data objects` blocks parsed from all 25 spec sections → 199 objects. Each matched against
the 74 blueprint tables by direct name, then by a hand-verified alias map (each alias confirmed by
reading the DDL), then classified as deliberately non-persistent. Script: `scratchpad/extract2.py`.

---

## Headline

| Classification | Count | % |
|---|---:|---:|
| Direct table match | 46 | 23% |
| Covered by a differently-named table (verified alias) | 34 | 17% |
| Deliberately derived / non-persistent | 7 | 4% |
| **No table exists** | **112** | **56%** |
| **Total spec'd objects** | **199** | |

### F-201 — S2 — The schema blueprint covers 44% of the specified domain model

**Finding.** 112 of 199 specified data objects have no table. Projected final schema:

```
  74  tables in the blueprint today
+112  tables for uncovered objects (≈1:1; some collapse, some split)
────
~186  tables at full Phase 0–11 scope
```

**Why this matters.** The blueprint reads like a near-complete schema — it has 74 tables, foreign
keys, indexes and enums. It is in fact a **skeleton spanning all phases at uneven depth**: the ledger
core is production-grade, while AR/AP is roughly one third modelled and tax, workflow, reporting and
close are barely started. Anyone sizing the work from the blueprint's apparent completeness will
underestimate by more than half.

**Resolution.** Use the per-phase table counts below for estimating. Do not treat
`schema_blueprint.sql` as a starting migration set to be lightly extended.

---

## Per-phase distribution of missing tables

| Phase | Module area | Missing objects | Blueprint tables present | Coverage |
|---:|---|---:|---:|---|
| 1 | Setup, IAM, SaaS admin (doc 02, 23) | **19** | 11 | 37% |
| 2 | Accounting kernel (doc 03) | **1** | 9 | 90% |
| 3 | AR / AP / tax / localization (doc 04, 05, 07) | **29** | 10 | 26% |
| 4 | Banking (doc 06) | **7** | 4 | 36% |
| 5 | Inventory / assets / projects / budgets (doc 08–10) | **19** | 13 | 41% |
| 6 | Reporting / close / workflow (doc 12, 14) | **14** | 6 | 30% |
| 7 | FX / multi-entity / consolidation (doc 11) | **4** | 8 | 67% |
| 8 | AI (doc 13) | **6** | 3 | 33% |
| 9 | Migration / integrations (doc 15, 17) | **9** | 5 | 36% |
| 10 | Bangladesh localization (doc 20) | **4** | 0 | 0% |

**The shape of this table is the finding.** Phase 2 — the accounting kernel — is 90% modelled. Every
other phase sits between 0% and 41%. The blueprint's author modelled the ledger properly and sketched
the rest. That is a reasonable thing to have done, and it means **Phase 2 can start from the
blueprint, while Phases 3–10 need genuine schema design work that has not happened yet.**

### F-202 — S2 — Phase 3 is the largest single gap and it is on the critical path

29 missing objects, and Phase 3 already carries the heaviest Build list in doc 21 (AR, AP,
procurement, tax foundation and the document service, in one phase). Missing:

**AR (doc 04):** `Quote`, `SalesOrder`, `CreditNote`, `RecurringInvoiceTemplate`, `DunningCase`,
`CustomerStatement`, `PaymentLink`
**AP (doc 05):** `PurchaseRequisition`, `PurchaseOrder`, `PurchaseOrderLine`, `ServiceReceipt`,
`VendorCredit`, `ExpenseClaim`, `ExpenseItem`, `BillMatch`, `MatchException`, `PaymentRun`,
`PaymentHold`
**Tax (doc 07):** `TaxRegistration`, `TaxComponent`, `TaxRule`, `FiscalPosition`, `TaxPeriod`,
`TaxReturn`, `TaxOverride`, `StatutoryTemplate`, `EInvoiceSubmission`, `LocalizationPackage`,
`LocalizationVersion`

Note what is absent on the tax side: **the entire versioning and determination substrate.** The
blueprint has `tax_codes`, `tax_rates` and `tax_transactions` — enough to store a rate and record a
calculation, but nothing to *determine* one (`TaxRule`, `FiscalPosition`) and nothing to version a
package (`LocalizationPackage`, `LocalizationVersion`). Doc 07's non-negotiable requirement —
"Historical posted transaction retains same tax snapshot after rule upgrade" — depends entirely on
tables that do not exist.

**Resolution.** Split Phase 3 into 3a (AR + document service), 3b (AP + procurement) and 3c (tax
foundation + localization framework) for scheduling purposes, while keeping doc 21's single exit-
criteria gate. This is a work-breakdown refinement, not a re-scope: all Phase 3 exit criteria still
apply, and nothing moves out of the phase.

### F-203 — S1 — Phase 1 is 37% covered, and the gap includes the accounting policy container

19 missing objects, of which one is structural rather than incremental: **`AccountingPolicy`**.

Doc 02 specifies a versioned per-entity policy holding default AR/AP accounts, cash/bank clearing,
retained earnings, rounding, FX gain/loss, write-off thresholds, capitalization threshold, inventory
valuation policy, revenue/deferred defaults, approval thresholds, AI automation thresholds and
closed-period behaviour. The posting rule catalog opens with: *"Concrete account IDs come from the
entity/book accounting policy"*.

**Every posting rule resolves its accounts through a table that does not exist.** The blueprint's
nearest equivalent is `legal_entities.settings jsonb` — untyped, unversioned, and unable to satisfy
doc 01's rule 7 ("accounting policies and posting rules are versioned/effective-dated") or doc 02's
"Historical documents retain the effective version used".

The other 18 are the SaaS administration layer from doc 23 (`Plan`, `PlanVersion`, `Subscription`,
`Entitlement`, `UsageMeter`, `UsageRecord`, `FeatureFlag`, `TenantLimit`, `NotificationTemplate`,
`NotificationPreference`, `NotificationMessage`, `DeliveryAttempt`, `SupportAccessGrant`,
`ImpersonationSession`, `MaintenanceNotice`, `BillingCustomerReference`) plus
`ExchangeRateProvider` and `LocalizationInstallation`. Doc 00 schedules SaaS admin as "0-10"
(continuous), so these can land incrementally — but `FeatureFlag` is a **Phase 0 exit dependency**
(doc 21 Phase 0 Build: "Feature flags/configuration framework").

**Resolution.** `accounting_policies` (versioned, effective-dated, typed) is a **Phase 1 blocker** and
must be designed before Phase 2 posting rules can resolve accounts. Promote it to the front of Phase 1.
`feature_flags` moves to Phase 0. The remaining doc 23 tables can follow their "0-10" schedule.

### F-204 — S2 — Phase 6 is 30% covered and it is where four gates are proven

14 missing objects: `ReportDefinition`, `ReportRow`, `ReportColumn`, `ReportRun`,
`AccountReconciliation`, `ReconcilingItem`, `CloseChecklistTemplate`, `AuditEvidence`, `AuditRequest`,
`Task`, `Notification`, `Delegation`, `EscalationRule`, `AutomationAction`.

Gates D (subledger reconciliation), E (financial statements), F (workflow and controls) and much of
L are all proven in Phase 6. `AccountReconciliation` + `ReconcilingItem` are literally what Gate D
tests ("Any difference is either zero or represented by an explicit, explainable reconciliation
item"). `FinancialStatementSnapshot` is aliased to `financial_snapshots` and does exist — but the
report-definition versioning it must reference does not, so a snapshot cannot record "the definition
version used" as doc 12 requires.

**Resolution.** Phase 6 needs a full schema design pass, not an extension pass. Budget it accordingly.

### F-205 — S3 — Phase 10 (Bangladesh) has zero schema coverage

`BangladeshVATProfile`, `MushakDocument`, `VATReturnBD`, `NBRRuleVersion` — none present. Expected:
doc 20 explicitly instructs that BD behaviour be implemented *through* the generic localization
framework rather than embedded in core modules, so these tables should be defined by the country-pack
mechanism, not the core blueprint.

**Not a defect.** Recorded so the coverage table is complete. Out of scope for the first release per
the generic/global decision — but note that the framework it depends on
(`LocalizationPackage`/`LocalizationVersion`) is itself missing, per F-202.

---

## The 112 absent objects, in full

Enumerated so the matrix is complete and each can be ticked off as it is designed.

**Phase 1 — 19** · `AccountingPolicy`, `ExchangeRateProvider`, `LocalizationInstallation`,
`FeatureFlag`, `Plan`, `PlanVersion`, `Subscription`, `Entitlement`, `TenantLimit`, `UsageMeter`,
`UsageRecord`, `BillingCustomerReference`, `NotificationTemplate`, `NotificationPreference`,
`NotificationMessage`, `DeliveryAttempt`, `SupportAccessGrant`, `ImpersonationSession`,
`MaintenanceNotice`

**Phase 2 — 1** · `RecurringJournalTemplate`

**Phase 3 — 29** · `Quote`, `SalesOrder`, `CreditNote`, `RecurringInvoiceTemplate`, `DunningCase`,
`CustomerStatement`, `PaymentLink`, `PurchaseRequisition`, `PurchaseOrder`, `PurchaseOrderLine`,
`ServiceReceipt`, `VendorCredit`, `ExpenseClaim`, `ExpenseItem`, `BillMatch`, `MatchException`,
`PaymentRun`, `PaymentHold`, `TaxRegistration`, `TaxComponent`, `TaxRule`, `FiscalPosition`,
`TaxPeriod`, `TaxReturn`, `TaxOverride`, `StatutoryTemplate`, `EInvoiceSubmission`,
`LocalizationPackage`, `LocalizationVersion`

**Phase 4 — 7** · `BankConnection`, `BankStatement`, `BankRule`, `Transfer`, `PaymentClearingItem`,
`SettlementBatch`, `BankBalanceSnapshot`

**Phase 5 — 19** · `ItemCategory`, `UnitOfMeasure`, `StockLot`, `SerialNumber`,
`InventoryReservation`, `LandedCost`, `DepreciationMethod`, `DepreciationRun`, `DisposalRecord`,
`AssetTransaction`, `AssetLocationAssignment`, `AssetCustodianAssignment`, `ProjectPhase`,
`TimeEntry`, `ProjectBillingRule`, `BillingProposal`, `Commitment`, `ForecastVersion`,
`AllocationRule`

**Phase 6 — 14** · `ReportDefinition`, `ReportRow`, `ReportColumn`, `ReportRun`,
`AccountReconciliation`, `ReconcilingItem`, `CloseChecklistTemplate`, `AuditEvidence`,
`AuditRequest`, `Task`, `Notification`, `Delegation`, `EscalationRule`, `AutomationAction`

**Phase 7 — 4** · `ExchangeRateSet`, `IntercompanyRelationship`, `EliminationRule`,
`TranslationAdjustment`

**Phase 8 — 6** · `AIConversation`, `AIModelConfig`, `ExtractionField`, `EvidenceLink`,
`HumanReviewTask`, `EvaluationCase`

**Phase 9 — 9** · `SourceSystem`, `ImportTemplate`, `ImportBatch`, `ImportRow`, `MappingSet`,
`MigrationExternalID`, `OpeningBalanceSet`, `ReconciliationResult`, `CutoverChecklist`

**Phase 10 — 4** · `BangladeshVATProfile`, `MushakDocument`, `VATReturnBD`, `NBRRuleVersion`

> `AIDecision` is **not** in this list — it is covered by `ai_decisions`, and appears in the alias
> table below.

---

## Objects covered under a different name (verified aliases)

Confirmed by reading the DDL, not inferred. These are **not** gaps:

| Spec object(s) | Covering table | Note |
|---|---|---|
| `Customer`, `Vendor` | `contacts` | Doc 02 explicitly models one contact as customer/vendor/both |
| `CustomerReceipt`, `VendorPayment` | `payments` | Generic table with `payment_type text` — see [F-022](01_Schema_Findings.md) for why this is thin |
| `ReceiptAllocation` | `payment_allocations` | |
| `MatchCandidate`, `ReconciliationMatch` | `bank_matches` | |
| `ReconciliationSession` | `bank_reconciliations` | |
| `GoodsReceipt`, `Shipment`, `StockAdjustment`, `StockCount` | `inventory_documents` | Generic `document_type text` |
| `Location` | `warehouse_locations` | |
| `Group`, `GroupMembership` | `consolidation_groups`, `consolidation_group_entities` | |
| `AccountMapping` | `consolidation_account_mappings` | |
| `CurrencyRevaluationRun` | `fx_remeasurement_runs` | |
| `Department`, `CostCenter` | `dimension_values` | Doc 10 mandates dimensions over dedicated tables |
| `WorkflowDefinition`, `WorkflowVersion` | `approval_workflows` | Version is a column |
| `WorkflowInstance`, `ApprovalDecision` | `approval_requests`, `approval_steps` | |
| `DepreciationSchedule` | `depreciation_schedule_lines` | |
| `BudgetVersion` | `budgets` | Version is a column |
| `PostingRule` | `posting_rule_versions` | |
| `CloseChecklist` | `close_runs` | |
| `MigrationProject` | `migration_jobs` | |
| `BillLine` | `vendor_bill_lines` | |
| `AIDecision`, `DocumentExtraction`, `CodingSuggestion`, `MatchSuggestion`, `AgentAction` | `ai_decisions` | Generic `decision_type text` |

### F-206 — S3 — Four generic tables absorb 14 distinct specified objects

`payments`, `inventory_documents`, `ai_decisions` and `approval_workflows` each stand in for
3–5 spec'd objects via a free-text discriminator column. That is a legitimate pattern, but it is an
**undocumented modelling decision** that the specification never makes — doc 05 and doc 06 describe
`VendorPayment` and `CustomerReceipt` as separate aggregates with different lifecycles, and doc 08
describes goods receipts, shipments, adjustments and counts as four documents with different
approval rules and different posting rules.

The cost lands on constraints: a single table cannot express "a goods receipt must reference a PO
line" and "a stock count must reference a count scope" as NOT NULL, so both become nullable and the
invariant moves to application code — where Gate C and Gate G cannot see it.

**Resolution.** Decide per table, explicitly, and record it — see
[07_Open_Decisions.md](07_Open_Decisions.md) D-09. Recommendation: **split `payments` into
`customer_receipts` and `vendor_payments`** (different lifecycles, different FX treatment, different
approval paths, and doc 05's payment run applies to only one of them); **keep `inventory_documents`
and `ai_decisions` generic** (genuinely uniform shapes with a type discriminator).

---

## Deliberately non-persistent

Confirmed as intentional, no table expected:

| Object | Doc | Why |
|---|---|---|
| `LedgerBalanceReadModel` | 03 | Blueprint note 7: projections, never source of truth. Must be rebuildable (Phase 2 exit criterion) |
| `InventoryValuation` | 08 | Derived from `inventory_cost_layers` |
| `AccountingEvent` | 03 | The in-process command envelope; its durable trace is `journal_entries.source_event_id` |
| `ReversalLink` | 03 | Realised as `journal_entries.reversal_of_id` |
| `Currency` | 02 | Reference data; ISO 4217 |
| `Permission` | 02 | **Should not be on this list** — see below |
| `UserRoleScope` | 02 | Realised as `memberships` columns |

### F-207 — S2 — `Permission` has no table, but doc 02 requires it to be enumerable

`roles.permissions` is a `jsonb` array of strings. Doc 02 requires atomic permissions
(view/create/edit-draft/submit/approve/post/reverse/pay/reconcile/export/configure/administer),
names high-risk permissions that need distinct handling, and specifies `GET /permissions`.
Gate B requires "authorization tests cover every mutation route" — which needs an enumerable
permission set to test *against*.

A `jsonb` array gives no referential integrity (a typo'd permission silently grants nothing), no way
to answer "which roles hold this permission", and no way to mark one high-risk.

**Resolution.** Add a `permissions` table as the registry, keep `role_permissions` as the join.
Generate the registry from `contracts/openapi.yaml` (per F-108, each route declares its required
permission) so the two cannot drift. This makes Gate B mechanically provable.

---

## Summary

| ID | Severity | Title |
|---|---|---|
| F-203 | **S1** | `AccountingPolicy` missing — every posting rule resolves accounts through it |
| F-201 | **S2** | Blueprint covers 44% of the domain model; ~186 tables at full scope |
| F-202 | **S2** | Phase 3 gap is 29 objects incl. the entire tax determination/versioning substrate |
| F-204 | **S2** | Phase 6 is 30% covered and is where Gates D, E, F are proven |
| F-207 | **S2** | `Permission` is untyped JSON; Gate B needs an enumerable set |
| F-205 | S3 | Phase 10 BD localization has zero coverage (expected — framework-delivered) |
| F-206 | S3 | Four generic tables silently absorb 14 spec'd objects |
