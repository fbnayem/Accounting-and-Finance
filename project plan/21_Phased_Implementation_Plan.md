# 21. Phased Implementation Plan

Each phase is deliverable only after its exit criteria pass. Later modules must call the accounting kernel through commands/services; they must not create ledger rows directly.

## Phase 0 — Repository, Platform Foundation and Engineering Standards

### Build
- Monorepo/workspace for `web`, `api`, `workers`, shared packages and infrastructure.
- Next.js web shell and NestJS API shell.
- PostgreSQL, Redis, S3-compatible local/dev storage and Docker Compose.
- Environment configuration with typed validation.
- Database migration framework and seed framework.
- Structured logging, correlation/request IDs, error taxonomy and health endpoints.
- CI pipeline: lint, format, typecheck, unit tests, integration tests, migration validation, build and dependency/security scan.
- Staging and production deployment pipelines with environment separation.
- Transaction helper, idempotency middleware, audit helper and transactional outbox base implementation.
- Shared money, date, currency, pagination, API error and identifier libraries.
- Feature flags/configuration framework.

### Required repository modules
`apps/web`, `apps/api`, `apps/worker`, `packages/domain`, `packages/database`, `packages/contracts`, `packages/ui`, `packages/config`, `packages/testing`, `infra`.

### Exit criteria
- Clean checkout starts full local stack with one documented command.
- CI rejects schema drift, failed tests and type errors.
- API can write a sample transaction and outbox event atomically.
- Retry of idempotent sample command does not duplicate data.
- Logs trace a request across API and worker by correlation ID.

---

## Phase 1 — Tenant, Organization, Legal Entity, IAM and Finance Setup

### Build
- Tenant/account creation.
- Organization and legal entity management.
- Branch/location master data.
- User invitations and memberships.
- RBAC permissions and role templates.
- MFA enforcement hooks and session management.
- Entity-scoped access rules.
- Fiscal year and accounting period setup.
- Base/functional/reporting currencies.
- Accounting book record and default primary book.
- Number sequences.
- Organization settings and accounting policy container.
- Setup wizard.
- Audit events for all administrative changes.

### Core screens
Tenant setup, company setup, entity list, branch list, users, roles, permissions, fiscal calendar, currencies, number sequences, accounting settings.

### Exit criteria
- Two tenants cannot access each other's records through UI, API or guessed IDs.
- An entity-restricted user cannot query or mutate another entity.
- Fiscal periods are generated and can be opened/soft-closed/hard-closed according to permission.
- Role/permission tests cover every finance mutation route created in this phase.

---

## Phase 2 — Accounting Kernel and General Ledger

### Build
- Chart of Accounts and account groups.
- Account subtypes/control/system account flags.
- Dimension definitions and dimension values.
- Journal definitions.
- Draft/manual journals.
- Deterministic accounting event and posting-rule infrastructure.
- Posting rule versions/effective dates.
- Posting simulation endpoint.
- Atomic journal posting.
- Immutable posted journals.
- Reversals and scheduled reversals.
- Recurring journals.
- Opening balances.
- Trial Balance, General Ledger, Journal Register and account activity.
- Ledger balance projections/read models.
- Control-account reconciliation framework.

### Required engineering work
- Database constraint/trigger/privilege protection for posted journals.
- Row locking/serializable strategy where sequence or period state requires it.
- Decimal precision/rounding policies.
- Source event idempotency.
- Period-lock race-condition protection.

### Exit criteria
- Every generated posted journal balances exactly in book/base currency.
- No supported application role can edit/delete posted journal lines.
- Duplicate accounting event cannot double-post.
- Full ledger read model can be destroyed and rebuilt from posted journal lines with identical balances.
- Opening Trial Balance imports and validates Assets = Liabilities + Equity.
- Journal reversal produces exact opposite accounting effect and traceability.

---

## Phase 3 — Customers, Vendors, AR, AP, Tax Foundation and Documents

### Build — AR
- Customer master and contacts.
- Quotes/estimates.
- Sales orders with status lifecycle.
- Invoices and invoice lines.
- Recurring invoices.
- Credit notes and refunds.
- Receipts, allocations, partial payments, overpayments and customer advances.
- Customer statements and AR aging.
- Write-offs and bad-debt workflow.
- Payment terms, credit limits and dunning/reminders.

### Build — AP/procurement
- Vendor master.
- Purchase requisitions.
- Purchase orders.
- Goods/service receipt.
- Vendor bills.
- Duplicate-bill detection.
- Two-way and three-way matching.
- Vendor credits.
- Expense claims.
- Payment requests/payment runs and payment status.
- Vendor statement/reconciliation support.

### Build — tax foundation
- Tax codes, components, rates and effective dates.
- Inclusive/exclusive tax.
- Recoverable/non-recoverable tax.
- Withholding foundation.
- Tax transaction/subledger.
- Tax account mappings.

### Build — document service
- S3 attachment upload/download.
- Hashing/dedup support.
- File metadata and source links.
- Malware scanning integration point.
- PDF/image previews where supported.

### Accounting integration
All invoice, credit, receipt, bill, payment, tax and write-off events invoke Phase 2 posting service using the posting-rule catalog.

### Exit criteria
- AR and AP aging totals reconcile to their GL control accounts.
- Tax subledger reconciles to tax control accounts.
- Invoice/bill post and reversal scenarios pass golden accounting tests.
- Partial allocation and overpayment scenarios do not corrupt customer/vendor balances.
- Three-way match flags quantity/price/tolerance violations correctly.
- Source document -> accounting event -> journal -> report drill chain is complete.

---

## Phase 4 — Banking, Cash, Clearing and Reconciliation

### Build
- Bank/cash/credit-card account masters.
- Bank connector abstraction.
- CSV/OFX/QIF/MT940/CAMT-style import adapters as required by target customers.
- Raw feed transaction retention and canonical transaction normalization.
- Import/feed duplicate prevention.
- Bank rule engine.
- Candidate matching engine for invoices, bills, payments, transfers and ledger transactions.
- Split transaction handling.
- Bank charges and interest workflows.
- Internal transfers.
- Payment processor clearing/settlement workflow.
- Reconciliation session and statement balance workflow.
- Cash position dashboard.
- Unreconciled/uncleared reports.

### Matching score inputs
Amount, currency, date distance, counterparty, reference, memo/token similarity, open-document amount, historical mapping and explicit rules.

### Exit criteria
- Same imported/feed transaction cannot create a duplicate canonical transaction.
- Bank reconciliation statement ending balance equals reconciled book balance after adjustments.
- Processor gross receipts, fees and net settlement reconcile through clearing accounts.
- Internal transfer creates one coherent paired transaction without double-counting cash.
- Matching suggestions never post without configured automation/approval policy.

---

## Phase 5 — Inventory, Fixed Assets, Projects and Budgets

### Build — inventory
- Products/items and accounting mappings.
- Warehouse/location/bin structure.
- Units of measure.
- Lot/batch/serial/expiry metadata.
- Receipt, issue, transfer, adjustment, count, return and write-off documents.
- FIFO and weighted-average cost engines; support adding other valuation policies later.
- COGS posting.
- GRNI/accrual handling.
- Landed-cost allocation.
- Inventory valuation and movement reports.

### Build — fixed assets
- Asset categories and account mappings.
- Capitalization from bills or manual acquisition.
- Asset register.
- Depreciation methods/schedules/runs.
- Transfers.
- Impairment/revaluation foundations.
- Disposal/sale/write-off.
- Asset reconciliation report.

### Build — projects and budgets
- Project master, project dimensions and status.
- Project time/cost/revenue associations.
- Project billing foundations.
- Budget models and versions.
- Budget by account, period and dimensions.
- Budget vs actual.
- Commitment/encumbrance option.
- Forecast snapshots.

### Exit criteria
- Inventory valuation report reconciles to inventory GL control account.
- Negative stock behavior follows configured policy under concurrent sales/issues.
- COGS is reproducible from stored cost layers/calculations.
- Fixed asset cost and accumulated depreciation reconcile to GL.
- Depreciation rerun is idempotent for same asset/book/period.
- Budget actuals derive from posted ledger, not duplicated transaction totals.

---

## Phase 6 — Reporting, Approvals, Period Close and Audit Workspace

### Build — financial/reporting engine
- P&L, Balance Sheet, Cash Flow, Trial Balance and GL.
- Comparative periods and year-to-date.
- Reporting by dimensions.
- AR/AP aging.
- Sales/purchases/customer/vendor/product analysis.
- Inventory/asset/tax reports.
- Custom report definitions with safe financial semantic model.
- Saved views, filters and scheduled exports.
- Drill-down to source evidence.

### Build — approval engine
- Versioned workflow definitions.
- Conditions based on amount, entity, account, vendor/customer, department, risk and source type.
- Serial/parallel approvals.
- Delegation, escalation and expiry.
- Maker/checker and segregation-of-duties rules.
- Approval task inbox and audit history.

### Build — close management
- Period close checklist.
- Subledger reconciliation status.
- Bank reconciliation readiness.
- Accrual/prepaid/deferred entries.
- Recurring journals and depreciation readiness.
- Review/approval tasks.
- Soft close and hard close.
- Reopen workflow with privileged approval/audit.
- Financial snapshot/versioning for issued statements.

### Build — auditor workspace
- Read-only auditor role.
- Evidence/document links.
- Journal/source tracing.
- Exportable audit trail.
- Controlled audit data room exports.

### Exit criteria
- Core statements tie exactly to Trial Balance.
- Every financial report amount can drill to ledger lines.
- Approval bypass attempts fail at API/domain layer.
- Hard-closed periods reject posting from every source module.
- Reopening a period is privileged, approved and audited.
- Close dashboard proves all configured reconciliations/checklists complete before hard close.

---

## Phase 7 — Multi-Currency, Multi-Entity, Intercompany and Consolidation

### Build — currency
- Transaction, functional/base and reporting currency values.
- Versioned exchange-rate tables and rate sources.
- Rate types.
- Foreign-currency invoices/payments.
- Realized FX gain/loss.
- Period-end monetary remeasurement and unrealized FX.
- Reversal/revaluation lifecycle.

### Build — multi-entity
- Group hierarchy.
- Entity-specific books, COA mappings, tax/localization and fiscal calendars where supported.
- Entity-scoped bank, customer/vendor and document behavior.
- Shared master-data policy options.

### Build — intercompany
- Intercompany counterparties and accounts.
- Due-to/due-from balancing.
- Mirrored intercompany transactions.
- Matching/reconciliation.
- Intercompany settlement.

### Build — consolidation
- Consolidation groups and ownership/effective dates.
- Mapping local accounts to group accounts.
- Currency translation.
- Intercompany eliminations.
- Consolidation adjustments.
- Consolidated Trial Balance and financial statements.
- Consolidation run/version/snapshot and drill-through.

### Advanced foundation
- Accounting-book abstraction ready for later parallel/multi-book accounting.

### Exit criteria
- Foreign-currency settlement generates correct realized FX.
- Period-end remeasurement is reversible/repeatable without duplication.
- Consolidated Trial Balance equals mapped translated entities plus adjustments/eliminations.
- Intercompany balances match or are surfaced as exceptions.
- Consolidated reports drill from group amount to entity journals.

---

## Phase 8 — AI Finance, Document Intelligence and Controlled Automation

### Build — document intelligence
- Invoice/receipt extraction pipeline.
- Structured extraction schema and validation.
- Duplicate document detection.
- Vendor/customer matching.
- PO/receipt/bill matching suggestions.
- Confidence and evidence display.

### Build — accounting assistance
- Account/dimension/tax coding suggestions.
- Bank reconciliation suggestions.
- Duplicate/anomaly detection.
- Missing-document detection.
- Collection risk/late-payment signals.
- Close exception summaries.

### Build — Finance Q&A
- Financial semantic layer.
- Allowlisted query functions instead of unrestricted database SQL.
- Questions over statements, transactions, customers, vendors, cash, budgets and dimensions.
- Every numerical answer returns supporting records/report links.
- No model-generated number is treated as system of record.

### Build — agent actions
- Allowlisted tools such as prepare draft journal, prepare bill, propose reconciliation, prepare reminder and create approval task.
- Permission checks before tool execution.
- Approval policy for financial effects.
- Full model/tool/action audit.
- Prompt-injection and hostile-document controls.

### AI quality controls
- Version models/prompts/schemas.
- Offline evaluation data sets.
- Confidence thresholds per action.
- Human-review queues.
- False-post/false-match rate dashboards.
- Safe fallback when model/provider unavailable.

### Exit criteria
- AI cannot post, pay, close periods or alter configuration outside explicit allowed policy.
- Every AI suggestion records model/version/input references/confidence/output/actor decision.
- Financial Q&A numerical results reconcile to authoritative report APIs.
- Adversarial document tests cannot cause unauthorized tool execution.
- Evaluation thresholds defined in QA spec pass before enabling automatic actions.

---

## Phase 9 — Public Platform, Integrations, Migration and Accountant Operations

### Build — public platform
- Versioned public REST API.
- OAuth/API client credentials.
- Scoped API permissions.
- Webhooks with signing, retries, replay and dead-letter handling.
- Developer documentation and sandbox company.
- API usage/rate dashboards.

### Build — connectors
- Payment gateways/processors.
- Banking aggregators/direct bank adapters.
- Payroll connectors.
- Ecommerce/POS connectors.
- CRM connectors.
- Storage/document/e-signature connectors as required.
- Generic import/export and SFTP/batch adapter if needed by enterprise customers.

### Build — migration toolkit
- Guided import jobs.
- QuickBooks/Xero/Zoho/Odoo/Sage adapter framework based on accessible export/API formats.
- CSV/Excel mappings.
- Opening balances and open subledgers.
- Inventory and fixed asset openings.
- Reconciliation/cutover report.
- Re-runnable validation before final cutover.

### Build — accountant operations
- Multi-client accountant dashboard.
- Client status/close readiness.
- Central review queues.
- Permission switching without cross-client leakage.
- Accountant templates for COA, policies, workflows and reports.

### Exit criteria
- API/webhook contract tests and backward compatibility policy pass.
- Connector retries cannot duplicate financial records.
- Migration reconciliation reports prove imported balances and subledgers match source/cutover targets.
- Accountant can service multiple tenants without data crossing tenant boundaries.

---

## Phase 10 — Global Localization and Enterprise Financial Management

### Build — localization platform
- Installable/versioned country packs.
- Country-specific COA templates, taxes, statutory reports, invoice fields/numbering, withholding and e-invoice connectors.
- Effective-dated regulatory updates.
- Upgrade simulator and migration notes.
- Country pack certification/QA suite.

### Build — enterprise accounting
- Parallel/multi-book accounting.
- Book-specific adjustments and mappings.
- Advanced revenue recognition schedules.
- Prepaid/accrual schedule engine.
- Advanced consolidation and ownership scenarios.
- Advanced allocation engine.
- Treasury/cash forecasting expansion.
- Financial planning/forecast scenarios.
- Enterprise SSO/SAML/SCIM as required.
- Advanced data retention, legal hold and export controls.

### Build — platform operations
- Localization marketplace/repository model.
- Integration marketplace governance.
- Extension permissions/sandboxing.
- Enterprise observability/SLA dashboards.

### Exit criteria
- Country pack upgrade does not rewrite historical tax results.
- Multiple accounting books independently balance and reconcile according to configured rules.
- Revenue schedules reconcile recognized/deferred balances to GL.
- Enterprise access/SSO and audit requirements pass security acceptance.

---

## Phase 11 — Optional ERP Extensions

These modules begin only after the financial platform is stable. They must consume the same accounting APIs/events.

### Optional modules
- Payroll engine.
- Full procurement/supplier portal.
- Manufacturing/MRP and standard costing.
- POS.
- Subscription billing and usage billing.
- CRM/order management expansion.
- Expense corporate cards/spend controls.
- Treasury/payment initiation.
- FP&A planning workspace.
- Tax filing connectors.
- Ecommerce storefront connectors.

### Exit criteria
Each extension has its own subledger/reconciliation specification and cannot directly mutate posted journals.

---

# Parallel Workstream Map

| Workstream | Primary phases |
|---|---|
| Platform/DevOps | 0-11 continuous |
| IAM/Tenancy | 1 then continuous |
| Accounting Kernel | 2 then controlled enhancements |
| AR/AP/Tax | 3 onward |
| Banking | 4 onward |
| Inventory/Assets/Projects | 5 onward |
| Reporting/Close | 2 foundation, 6 full |
| Multi-entity/FX | 7 onward |
| AI | prepare data contracts earlier; production in 8 |
| APIs/Integrations | internal contracts from 0; public platform in 9 |
| Localization | architecture in 3/7; country packs in 10 |
| QA/Automation | every phase |
| Security | every phase |

# Dependency Rules
- Phase 2 posting service must exist before any source module is allowed to post accounting.
- Phase 3 tax API is used by AR/AP and later inventory/assets; source modules do not calculate tax independently.
- Phase 4 banking consumes AR/AP payment allocation services instead of editing customer/vendor balances.
- Phase 5 inventory and asset accounting use accounting events/posting rules.
- Phase 6 reports consume ledger/subledger read APIs; reporting code does not become a second accounting engine.
- Phase 7 currency/consolidation extends book/entity abstractions without breaking prior journal immutability.
- Phase 8 AI consumes controlled domain/report APIs and produces proposals/commands only.
- Phase 9 external integrations use public/canonical APIs; no connector receives database credentials.
- Phase 10 country packs and multi-book extend versioned policy abstractions instead of forks.
