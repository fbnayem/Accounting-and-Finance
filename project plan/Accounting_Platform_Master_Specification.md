# Accounting Platform Master Specification

Version 1.0 — 2026-08-07

Developer handoff. Requirements are stated as functions, workflows, controls, data behavior and acceptance criteria.
# Accounting Platform - Developer Handoff Package

Version 1.0 — 2026-08-07

## Technology baseline
- Web: Next.js + React + TypeScript.
- API/backend: NestJS + TypeScript.
- Database: PostgreSQL.
- Data access: Prisma for ordinary CRUD; explicit SQL/transaction helpers where ledger invariants, locking, or high-volume reporting require it.
- Cache/locks/jobs: Redis + BullMQ initially.
- Files: S3-compatible object storage.
- AI/data workers: Python only for specialist workloads; financial actions always return through normal domain APIs.
- Deployment: Docker, CI/CD, dev/staging/production isolation.
- Architecture: modular monolith first; transactional outbox; versioned domain events; API-first.

## Non-negotiable platform rules
1. Posted journal lines are the accounting source of truth.
2. Every posted journal balances in book/base currency.
3. Business modules never write directly to posted ledger tables.
4. Posted accounting history is corrected by reversal, credit/debit note, or adjustment; never silent edits.
5. Every financial mutation is tenant-scoped, permission-checked, audited, and idempotent when retriable.
6. AR, AP, inventory, fixed assets, bank clearing, tax and other subledgers must reconcile to GL control accounts.
7. Tax, localization, accounting policies and posting rules are versioned/effective-dated.
8. AI never bypasses deterministic accounting, permissions, approval gates, period locks, or posting validation.
9. Closed periods are enforced by all modules.
10. External systems integrate through canonical commands/events, not direct database writes.

## Documents
- `docs/00_Module_Function_Matrix.md`
- `docs/01_Architecture_Engineering.md`
- `docs/02_Organizations_IAM_Setup.md`
- `docs/03_Accounting_Kernel_GL.md`
- `docs/04_AR_Sales.md`
- `docs/05_AP_Procurement_Expenses.md`
- `docs/06_Banking_Reconciliation.md`
- `docs/07_Tax_Localization.md`
- `docs/08_Inventory_Costing.md`
- `docs/09_Fixed_Assets.md`
- `docs/10_Projects_Budgets.md`
- `docs/11_MultiCurrency_MultiEntity_Consolidation.md`
- `docs/12_Reporting_Close_Audit.md`
- `docs/13_AI_Automation.md`
- `docs/14_Workflows_Approvals.md`
- `docs/15_API_Integrations.md`
- `docs/16_Security_DevOps.md`
- `docs/17_Migration_Data_Quality.md`
- `docs/18_UI_Screen_Map.md`
- `docs/19_QA_Acceptance.md`
- `docs/20_Bangladesh_Localization.md`
- `docs/21_Phased_Implementation_Plan.md`
- `docs/22_Release_Gates.md`
- `docs/23_Platform_Admin_Billing_Notifications.md`
- `docs/24_Optional_Enterprise_Extensions.md`
- `docs/98_Reference_Benchmarks.md`
- `blueprints/schema_blueprint.sql`
- `blueprints/event_catalog.json`
- `blueprints/api_route_catalog.yaml`
- `blueprints/posting_rule_catalog.md`


---

# 00. Module / Function Matrix

| Module | Core functions | Posting owner/effect | Phase |
|---|---|---|---:|
| Platform foundation | config, migrations, jobs, outbox, audit, observability | non-posting infrastructure | 0 |
| Tenant/organization/IAM | tenants, entities, branches, users, roles, permissions | non-posting | 1 |
| Finance setup | periods, books, currencies, policies, sequences | controls posting | 1 |
| Chart of Accounts | account hierarchy, types, control accounts | master data for ledger | 2 |
| Dimensions | department, project, location, cost center, custom | analytical tagging | 2 |
| General Ledger | journals, entries, lines, reversal, recurring/opening | only ledger writer | 2 |
| Customers/AR | customers, quote, order, invoice, receipt, credit, collection | emits AR events | 3 |
| Vendors/AP | vendor, requisition, PO, receipt, bill, credit, payment, expense | emits AP events | 3 |
| Tax | tax determination, tax subledger, returns, withholding | generates tax components | 3 |
| Documents | attachments, evidence, OCR inputs | non-posting | 3 |
| Banking | imports/feeds, rules, matching, reconciliation, transfers, clearing | emits bank/cash events | 4 |
| Inventory | receipt, issue, transfer, costing, counts, landed cost | emits inventory/COGS events | 5 |
| Fixed assets | capitalize, depreciate, transfer, impair, revalue, dispose | emits asset events | 5 |
| Projects | project dimensions, project cost/revenue/billing | tags/source events | 5 |
| Budgets | versions, budget lines, variance, commitments | non-posting unless encumbrance enabled | 5 |
| Reporting | P&L, BS, CF, TB, subledger and analytics | reads posted facts | 6 |
| Approvals | workflow rules, tasks, delegation, SoD | gates financial commands | 6 |
| Close | checklist, reconciliation, locks, snapshots | gates periods | 6 |
| Audit workspace | trace, evidence, exports | reads/audits | 6 |
| Foreign currency | rates, settlement FX, remeasurement | emits FX entries | 7 |
| Multi-entity | entity policies/shared masters | controls scope | 7 |
| Intercompany | paired charges, balances, settlement | emits entity journals | 7 |
| Consolidation | mapping, translation, elimination, group statements | consolidation layer | 7 |
| AI documents | extraction/classification | draft/suggest only | 8 |
| AI accounting | coding/matching/anomaly/Q&A | proposals through domain commands | 8 |
| Automation | rules and allowlisted actions | command orchestration | 8 |
| Public API | OAuth, REST, webhooks, sandbox | canonical domain commands | 9 |
| Integrations | banking/payment/payroll/ecommerce/CRM connectors | canonical imports/events | 9 |
| Migration | source imports, openings, reconciliation | controlled cutover | 9 |
| Accountant portal | multi-client queue and templates | scoped operation | 9 |
| Localization | country taxes/forms/invoicing/e-invoice | versioned tax/statutory rules | 10 |
| Multi-book | parallel accounting books | independent balanced books | 10 |
| Revenue schedules | deferred/recognized revenue | emits schedule entries | 10 |
| SaaS admin/billing | plans, entitlements, usage, tenant admin | platform non-posting | 0-10 |
| Notifications | email/SMS/in-app delivery and preferences | non-posting | 1-10 |
| Payroll extension | payroll calculations/import/posting | emits payroll clearing/expense events | 11 |
| Treasury extension | cash forecast/payment initiation | emits approved cash/payment commands | 11 |
| Manufacturing extension | BOM/WIP/production costing | emits inventory/WIP/variance events | 11 |
| Subscription billing | plans, usage, recurring billing | emits AR/revenue events | 11 |


---

# 01. Architecture and Engineering Standards

## Purpose
Define the shared architecture and engineering rules used by every module and phase.

## Core hierarchy
`Tenant -> Organization -> Legal Entity -> Branch -> Accounting Book -> Ledger`

A tenant is the SaaS isolation boundary. An organization is the customer workspace. A legal entity owns statutory books, base currency, fiscal calendar, tax registrations, bank accounts and ledger. Branches are operational units unless modeled as separate legal entities. Accounting books support primary/statutory and later secondary/tax/management books.

## Required stack
- Next.js/React/TypeScript web application.
- NestJS/TypeScript backend.
- PostgreSQL transactional database.
- Prisma plus explicit SQL for transaction-critical operations.
- Redis for caching, distributed locks and BullMQ jobs.
- S3-compatible object storage for invoices, receipts, statements and exports.
- Python services only where AI/OCR/data processing materially benefits.
- Dockerized services and environment parity.

## Module boundaries
Modules: platform, identity, organization, ledger, tax, AR, AP, procurement, banking, inventory, assets, projects, planning, reporting, close, workflows, integrations, AI, localization and administration.

Only the ledger/posting module may create a POSTED journal. Source modules emit accounting events or call the internal posting service. Cross-module writes are not allowed. Read models may be denormalized but must be rebuildable.

## Money
- PostgreSQL `NUMERIC/DECIMAL`; never binary floating point for financial truth.
- Store transaction amount/currency and base amount/currency.
- Foreign currency records include rate, rate type, source and effective date.
- Currency metadata defines precision and cash-rounding behavior.
- Rounding occurs at defined calculation boundaries.
- Any ledger rounding difference posts to an explicit configured rounding account.

## Dates and periods
- Timestamps stored UTC.
- Legal entity timezone stored separately.
- Financial documents use `document_date`, `posting_date`, `due_date` where relevant.
- `posting_date` determines accounting period.
- OPEN: normal posting.
- SOFT_CLOSED: only privileged/approved posting.
- CLOSED: reject posting unless a controlled reopen/adjustment workflow occurs.

## Database transactions and concurrency
Use a single DB transaction for commands that update source document + allocations + journal + audit + outbox. Use optimistic version columns for editable documents. Use row/advisory locks where concurrency can create duplicate settlement, stock oversell, duplicate numbering or double approval.

Required idempotency for:
- post invoice/bill/journal;
- receive/pay/refund;
- bank matching/reconciliation;
- external API creates;
- provider callbacks;
- migration imports;
- background financial jobs.

## Transactional outbox
Domain events that must follow committed financial data are stored in `outbox_events` in the same DB transaction. Publisher sends them asynchronously. Consumers are idempotent and record checkpoints/event IDs.

## Identifiers and numbering
- Internal IDs: UUID/ULID.
- Human document numbers: separate, configurable sequences.
- Sequence scope options: legal entity, branch, document type, fiscal year.
- Posted numbers are never reused.
- Voided/canceled numbers remain visible in audit sequence.
- Sequence allocation must be concurrency safe.

## Configuration precedence
`Platform default -> Localization default -> Organization -> Legal entity -> Branch -> Transaction override (only where allowed)`.

Accounting-affecting settings are versioned. Historical documents retain the effective version used.

## Source-to-ledger workflow
```text
UI/API command
-> auth + tenant/entity context
-> authorization
-> schema/domain validation
-> idempotency check
-> domain service
-> accounting event
-> posting rule resolution
-> tax/currency/dimension validation
-> build journal
-> debit/credit balance validation
-> approval/period control
-> insert immutable posted journal
-> update source/subledger status
-> audit + outbox
-> commit
-> async notifications/integrations/read models
```

## Mandatory engineering rules
- No destructive cascade may delete posted history.
- No direct ledger SQL from AR/AP/inventory/AI/integrations.
- Service/background jobs always include tenant and entity context.
- All financial changes create audit records.
- API errors use stable error codes plus request ID.
- Use feature flags for unfinished/staged functions.
- Version public APIs and domain event schemas.
- Every financial bug fix includes regression tests.

## Acceptance
- Same idempotency key yields one financial result.
- Cross-tenant object access fails in API and workers.
- Posted rows are immutable under normal application DB credentials.
- Money schema contains no float/double columns.
- An outbox event cannot be published before the originating DB transaction commits.


---

# 02. Organizations, IAM, Company Setup and Master Configuration

## Data objects
Organization, LegalEntity, Branch, User, Membership, Role, Permission, UserRoleScope, FiscalYear, AccountingPeriod, Currency, ExchangeRateProvider, NumberSequence, Contact, AccountingPolicy, LocalizationInstallation.

## Organization onboarding
Wizard must collect:
- legal/display name;
- country and legal address;
- entity type/registration identifiers;
- base currency;
- fiscal year start/end;
- timezone;
- tax registrations;
- industry/business type;
- opening/cutover date;
- localization package;
- default language/date/number formatting.

On completion create:
- primary accounting book;
- periods;
- chart-of-accounts template;
- system/control account mappings;
- tax defaults;
- document number sequences;
- default journals;
- administrator/owner role;
- accounting policy v1.

Posting remains disabled until required setup validation passes.

## Legal entities
Each legal entity independently owns base currency, books, chart, periods, tax registrations, bank accounts, numbering and localization. A user may have different roles per entity. Structural settings that would invalidate history become locked after first posting and require migration/change workflow.

## Branches
Branch fields: code, name, address, entity, manager, active dates, warehouse mappings, optional sequence overrides and user scope. Branch is an analytical/operational dimension unless statutory separation requires another legal entity.

## Authentication and sessions
- Secure login.
- MFA foundation in first production version.
- Session list/revocation.
- Invite/accept flow.
- Suspend/reactivate user.
- Password reset/passkey/SSO roadmap.
- Service principals for integrations.

## Roles and permissions
System roles: Owner, Administrator, Accountant, Finance Manager, AR Clerk, AP Clerk, Procurement, Cashier/Treasury, Inventory Manager, Auditor, Viewer.

Permissions must be atomic: view, create, edit draft, submit, approve, post, reverse, pay, reconcile, export, configure and administer. Role assignment is scoped to organization/entity/branch as needed. Later amount/dimension constraints can extend RBAC toward ABAC.

High-risk permissions:
- change vendor bank details;
- approve payments;
- post manual journals to control accounts;
- reopen periods;
- override tax;
- export all financial data;
- manage roles/integrations.

## Fiscal years and periods
Create monthly standard periods and optional adjustment periods. Validate no overlap. Close/reopen requires permission, reason and audit. Reopen can optionally require approval.

## Currency setup
ISO code, symbol, precision, cash-rounding. Exchange rate providers support transaction, average, closing and historical rate types. Never overwrite historical rates; add effective-dated rows.

## Number sequences
Configurable pattern: prefix, year/month tokens, branch, counter, padding, reset cycle. Allocate final numbers on posting/approval according to document policy. Concurrency-safe. Never reuse posted/voided numbers.

## Contacts foundation
A contact may be customer, vendor or both. Store legal/display name, registration/tax IDs, addresses, contacts, default currency, payment terms, tax profile, bank details where appropriate, external IDs and active status. Duplicate detection uses tax ID, email, bank details and normalized name/address signals.

## Accounting policy
Versioned entity policy fields include:
- default AR/AP accounts;
- default cash/bank clearing;
- retained earnings;
- rounding;
- FX gain/loss;
- bad debt/write-off thresholds;
- capitalization threshold;
- inventory valuation policy;
- revenue/deferred expense defaults;
- approval thresholds;
- AI automation thresholds;
- closed-period behavior.

## APIs
`POST /organizations`, `/legal-entities`, `/branches`, `/users/invitations`, `/roles`, `/fiscal-years`, `/accounting-policies`, `/number-sequences`; `PATCH /periods/{id}/status`; `GET /permissions`, `/settings/effective`.

## Events
organization.created, legal_entity.created/activated, user.invited/suspended, role.updated, accounting_period.closed/reopened, accounting_policy.version_created.

## Acceptance
- New organization reaches posting-ready status without direct DB work.
- Suspended user loses active access.
- Closed period blocks all posting modules consistently.
- User scoped to Entity A cannot view Entity B data.
- Base currency cannot be casually changed after posting exists.


---

# 03. Accounting Kernel, General Ledger, Chart of Accounts and Dimensions

## Data objects
Account, AccountGroup, Dimension, DimensionValue, Journal, JournalEntry, JournalLine, JournalLineDimension, AccountingEvent, PostingRule, PostingRuleVersion, ReversalLink, RecurringJournalTemplate, LedgerBalanceReadModel.

## Chart of accounts
Support Assets, Liabilities, Equity, Revenue and Expense. Support subtypes such as bank, cash, AR, inventory, fixed asset, accumulated depreciation, AP, tax payable/receivable, retained earnings, COGS, operating expense and other income/expense.

Account fields: code, name, type, subtype, normal balance, parent/group, posting/non-posting, control flag, system flag, active dates, default cash-flow classification and optional reporting mappings.

Rules:
- unique code per entity/book;
- used account is archived, not deleted;
- type change after posting requires controlled migration;
- control accounts can reject manual posting except privileged adjustment;
- parent/reporting accounts cannot receive journal lines if non-posting.

## Dimensions
Configurable analytical axes: Department, Cost Center, Location, Branch, Project, Customer, Vendor, Product Line, Channel, Fund, Grant or custom.

For each account/source module configure dimension rule: REQUIRED, OPTIONAL, PROHIBITED, DEFAULTED. Journal lines store dimension values. Dimensions may be hierarchical/effective-dated.

## Journals
Journal types: General, Sales, Purchase, Bank, Cash, Inventory, Asset, Tax, Payroll/External, Consolidation/Elimination. Each source event selects a journal through policy/localization.

## Manual journals
Draft can be edited. Fields: dates, journal, reference, description, lines, dimensions, attachments, reversal date, approval status. Posting performs full validation. Draft may be temporarily unbalanced; POSTED may never be unbalanced.

## Posting service algorithm
1. Receive event/command with unique source event ID.
2. Verify event is not already posted.
3. Resolve tenant, entity, book and posting period.
4. Reject closed period unless controlled permission/workflow.
5. Resolve posting rule version and system account mappings.
6. Build lines from immutable source facts.
7. Resolve tax and FX snapshots.
8. Validate accounts active/postable.
9. Validate dimension rules.
10. Validate each line has debit XOR credit.
11. Validate base debit total equals base credit total.
12. Add permitted explicit rounding line if required.
13. Allocate journal number.
14. Insert journal header/lines atomically.
15. Mark source accounting status POSTED.
16. Create audit and outbox events.
17. Commit.

## Immutability
Posted journal header/lines cannot be edited or deleted. Fields that are presentation-only should also normally remain immutable; correction uses reversal/adjustment. Database privileges and/or triggers must provide a second safety layer beyond application code.

## Reversal
Full reversal copies original lines with debit/credit inverted, references original journal, records reason/date/actor and posts normally. Scheduled reversal queues a future draft/post request and still obeys period status at execution.

## Opening balances
Support:
- opening trial balance;
- opening bank/cash;
- open AR invoices/credits;
- open AP bills/credits;
- inventory quantity/value;
- fixed asset cost/accumulated depreciation;
- tax/control balances.

Detailed subledger opening items must reconcile to GL opening control balances before cutover signoff.

## Recurring journals
Template: lines/formulas, start/end, frequency, dimensions, draft-vs-auto-post, approval, next run. Generated journal references template version and schedule occurrence; occurrence is idempotent.

## Ledger reads
- Trial Balance.
- General Ledger.
- Journal Register.
- Account Activity.
- Period Balance.
- Dimension analysis.
- Control-account reconciliation.

Optimized balance/read tables are caches/projections and must be rebuildable from posted journal lines.

## Core invariants
- `SUM(debit_base) = SUM(credit_base)` for every posted journal.
- One line cannot contain both non-zero debit and credit.
- Source event unique per legal entity/book posting scope.
- Every posted line has entity, book, period, account, posting date and source traceability.
- No supported feature mutates posted lines.

## APIs
`GET/POST /accounts`, `GET/POST /dimensions`, `POST /journals`, `POST /journals/{id}/approve|post|reverse`, `POST /accounting-events/simulate`, `GET /ledger/accounts/{id}/activity`, `GET /reports/trial-balance`.

## Events
journal.draft_created, journal.approved, journal.posted, journal.reversed, posting.failed.

## Acceptance
- Property tests generate thousands of valid postings with zero imbalance.
- Duplicate source event returns existing result and creates no duplicate.
- Journal immutability test fails UPDATE/DELETE through application role.
- Rebuilding trial balance from raw journal lines equals cached balance model.
- Closing a period between request validation and commit cannot allow a race-condition post.


---

# 04. Accounts Receivable, Sales, Invoicing and Collections

## Data objects
Customer, Quote, SalesOrder, Invoice, InvoiceLine, CreditNote, CustomerReceipt, ReceiptAllocation, RecurringInvoiceTemplate, DunningCase, CustomerStatement, PaymentLink.

## Customer configuration
Store tax identity, billing/shipping addresses, contacts, payment terms, default currency, AR account, revenue defaults, tax/fiscal position, price list, credit limit, collection owner, statement delivery preferences and portal access.

## Quote
States: DRAFT -> SENT -> ACCEPTED/REJECTED/EXPIRED -> CONVERTED. Quote is non-posting. Revision creates version history. Convert to sales order or invoice while preserving source link.

## Sales order
States: DRAFT -> APPROVAL_PENDING -> APPROVED -> CONFIRMED -> PARTIALLY_FULFILLED/PARTIALLY_INVOICED -> COMPLETED/CANCELLED. Sales order is non-posting unless a future reservation/encumbrance policy is enabled.

Functions:
- line items/services;
- quantity/UOM;
- pricing/discounts;
- tax preview;
- customer PO/reference;
- dimensions/project;
- deposits;
- partial fulfillment;
- partial invoicing;
- fulfillment/inventory link.

## Invoice
Fields: customer, invoice number, document date, posting date, due date, currency/rate, lines, discount, tax, charges, dimensions, sales order/project source, notes, attachments, terms and payment instructions.

Lifecycle:
`DRAFT -> PENDING_APPROVAL(optional) -> APPROVED -> POSTED/OPEN -> PARTIALLY_PAID -> PAID`
Correction states are handled by credit note/cancel-and-reissue; no editing posted financial values.

On post:
- allocate final invoice number;
- freeze tax/FX/policy snapshots;
- create AR accounting event;
- post AR debit, revenue and output tax credits;
- update customer open-item subledger;
- emit invoice.posted;
- make invoice available to email/portal.

## Invoice calculation
Server calculates subtotal, line discount, document discount where allowed, shipping/fees, taxable base, tax components, rounding and total. UI may preview but server result is authoritative. Store line-level calculation snapshots.

## Recurring invoice
Template contains customer, lines, schedule, start/end, next run, date/due-date rule, tax policy, dimensions, auto-send, draft/auto-post mode and approval behavior. Every generated invoice is a normal standalone invoice linked to template version/occurrence.

## Customer receipt
Sources: manual, bank match, cash, gateway/card settlement, imported legacy transaction.

Receipt can be:
- allocated to one invoice;
- split across invoices;
- partially allocated;
- unapplied/advance;
- overpayment;
- foreign currency.

Posting example:
- Dr Bank/Cash/Payment Clearing;
- Cr AR for allocated amount;
- Cr Customer Advance for intentionally unapplied advance where policy uses separate account;
- add realized FX line if settlement currency/rate requires it.

Allocation is transaction-safe; concurrent allocation cannot overpay an invoice or consume the same available receipt twice.

## Credit note
Create against invoice or customer account. Preserve original invoice/tax references. Can reduce open invoice, remain as customer credit or be refunded. Post revenue/tax reversal and AR reduction according to original/local rules.

## Refund
Requires available customer credit. Creates payment-out and journal from customer credit/AR to bank/cash. Refund status must account for bank/gateway pending/failed/confirmed states.

## Bad debt/write-off
Authorized workflow with reason code, amount threshold and approval. Full or partial write-off. Posts to configured bad-debt/allowance account and reduces AR open item. Later recovery uses dedicated recovery treatment.

## Collections
AR aging buckets configurable, default 0-30, 31-60, 61-90, 91+. Dunning rules can send reminders before/after due date, create tasks, escalate high-value items and pause disputed invoices. Record notes, promise-to-pay date and dispute status.

## Customer portal
Customer can view/download own invoices, credits and statements; make payment through integrated gateway; update allowed contact details; see payment status. Never expose internal notes, margin, ledger accounts or other customers.

## Standard posting rules
| Trigger | Debit | Credit |
|---|---|---|
| Sales invoice | Accounts Receivable | Revenue + Output Tax Payable |
| Customer receipt | Bank/Cash/Clearing | Accounts Receivable/Customer Advance |
| Credit note | Revenue Return/Revenue + tax reduction | Accounts Receivable |
| Customer refund | Customer Credit/AR | Bank/Cash |
| Bad debt | Bad Debt Expense/Allowance | Accounts Receivable |

## Reports
AR Aging, Customer Balances, Customer Statement, Invoice Register, Sales by Customer/Product/Project/Dimension, Revenue Trend, Unapplied Receipts, Credit Balances, Collections Queue, DSO/KPI view.

## APIs
`POST /customers`, `/quotes`, `/sales-orders`, `/invoices`, `/credit-notes`, `/customer-receipts`; commands `/invoices/{id}/approve|post`, `/customer-receipts/{id}/allocate`, `/customers/{id}/statement`, `/ar/aging`.

## Events
customer.created, quote.accepted, sales_order.confirmed, invoice.approved, invoice.posted, invoice.overdue, invoice.partially_paid, invoice.paid, credit_note.posted, customer_receipt.posted, customer_receipt.allocated, dunning.stage_changed.

## Acceptance
- Taxable invoice posting balances and matches invoice total.
- Partial receipt updates open balance and aging without modifying original invoice.
- Overpayment/unapplied funds remain visible and controlled.
- Credit note/refund has complete source audit link.
- AR open-item total equals AR GL control account across normal, credit, write-off and FX scenarios.


---

# 05. Accounts Payable, Procurement and Expenses

## Data objects
Vendor, PurchaseRequisition, PurchaseOrder, PurchaseOrderLine, GoodsReceipt, ServiceReceipt, VendorBill, BillLine, VendorCredit, ExpenseClaim, ExpenseItem, BillMatch, MatchException, PaymentRun, VendorPayment, PaymentHold.

## Vendor
Store legal/tax details, addresses, terms, default currency, AP/expense/tax defaults, payment method, bank details, remittance contacts and external IDs. Bank detail change is high risk: record before/after, actor, reason, verification and optional independent approval.

## Purchase requisition
Internal request containing requester, business reason, item/service, quantity, estimate, vendor suggestion, department/project/cost center, required date and attachments. Approval routing can depend on amount/dimension/category.

States: DRAFT -> SUBMITTED -> APPROVAL_PENDING -> APPROVED/REJECTED -> CONVERTED/CLOSED.

## Purchase order
Create from approved requisition or directly where policy allows. Functions:
- vendor and currency;
- item/service lines;
- terms/tax;
- delivery locations;
- dimensions;
- approval;
- send/print;
- partial receipts;
- partial billing;
- change order/revision history;
- close/cancel remaining quantity.

PO is non-posting initially. Optional commitment/encumbrance is a later accounting policy.

## Goods/service receipt
Record received quantity/date/location, accepted/rejected quantity, lot/serial where inventory applies, receiver, notes and attachments. Service receipt/approval supports non-stock services.

## Vendor bill
Created manually, from PO/receipt, import or document extraction. Fields: vendor, vendor invoice number, invoice date, posting date, due date, currency/rate, lines, tax, dimensions, PO/receipt links and attachments.

Duplicate controls:
- exact vendor + invoice number;
- similar invoice number normalization;
- same vendor/date/amount;
- same file hash/document extraction fingerprint.

Override requires permission and reason.

## Matching
Two-way: PO vs bill. Three-way: PO vs receipt vs bill.

Compare:
- item/service;
- quantity ordered/received/billed;
- unit price;
- line/document total;
- tax;
- currency;
- tolerance.

Match result: MATCHED, WITHIN_TOLERANCE, EXCEPTION, MANUAL_OVERRIDE. Exceptions show exact variance and owner. Posting/payment may be blocked according to policy.

## Bill lifecycle
`DRAFT -> MATCH_REVIEW -> APPROVAL_PENDING -> APPROVED -> POSTED/OPEN -> PARTIALLY_PAID -> PAID`

On post:
- Dr Expense/Asset/Inventory and recoverable tax;
- Cr Accounts Payable;
- freeze tax/FX/accounting snapshots;
- update vendor open-item subledger.

## Vendor credit
Create against original bill or vendor account. Apply to bill/payment run or leave open. Preserve source tax treatment and posting references.

## Expense claims
Employee/contractor submits receipts, merchant/date/amount/currency, category, business purpose, project/cost center and tax. Policy engine flags limits, missing receipt, weekend/personal-risk categories and duplicates. Approval then posts to employee payable/AP or records direct company-card clearing.

## Payment run
Selection filters: entity, bank, payment date, currency, vendor, due date, discount date, priority. System excludes unapproved, held or blocked vendors/bills.

Process:
1. Build candidate run.
2. Apply credits.
3. Validate bank/vendor payment data.
4. Detect duplicate payment.
5. Approvals/dual control.
6. Generate bank/API/export instructions.
7. Track SENT/PENDING/CONFIRMED/FAILED.
8. Post confirmed payment or policy-defined clearing step.
9. Send remittance.
10. Reconcile to bank.

## Standard postings
| Trigger | Debit | Credit |
|---|---|---|
| Vendor bill | Expense/Asset/Inventory + Input Tax | Accounts Payable |
| Vendor payment | Accounts Payable | Bank/Cash/Payment Clearing |
| Vendor credit | Accounts Payable | Expense/Asset/Inventory/Input Tax reversal |
| Employee reimbursable expense | Expense + tax | Employee Payable/AP |

Withholding may split vendor payment credit between Bank and Withholding Tax Payable.

## Reports
AP Aging, Vendor Balances, Bill Register, Unpaid/Overdue Bills, Purchase Analysis, Open POs, PO/Receipt/Bill Variance, Payment Forecast, Payment Run History, Expense Analysis, Vendor Credits, Duplicate Bill Exceptions, Vendor Bank Change Audit.

## APIs
`POST /vendors`, `/purchase-requisitions`, `/purchase-orders`, `/goods-receipts`, `/bills`, `/vendor-credits`, `/expense-claims`, `/payment-runs`, `/vendor-payments`; commands `/bills/{id}/match|approve|post`.

## Events
purchase_requisition.approved, purchase_order.sent, goods_receipt.posted, bill.extracted, bill.match_exception, bill.approved, bill.posted, expense_claim.approved, payment_run.approved, vendor_payment.posted/failed.

## Acceptance
- Three-way matching identifies price and quantity variance correctly.
- Payment run cannot include held/unapproved bill.
- Concurrent payments cannot consume the same bill balance twice.
- AP open items reconcile to AP GL control account.
- Vendor bank changes support dual approval and complete audit history.


---

# 06. Banking, Payments, Cash Management and Reconciliation

## Data objects
BankAccount, BankConnection, BankStatement, BankTransaction, BankRule, MatchCandidate, ReconciliationSession, ReconciliationMatch, Transfer, PaymentClearingItem, SettlementBatch, BankBalanceSnapshot.

## Bank/cash account setup
Types: bank, credit card, cash, wallet, payment processor/clearing. Map each to GL account. Store currency, institution, masked account identifier, branch/IBAN/routing metadata when needed and connection status.

## Feed/import ingestion
Adapter interface must support:
- live bank/aggregator API;
- CSV;
- OFX/QFX/QIF as market need dictates;
- CAMT/MT940 or other statement standards by geography;
- payment processor settlement files/APIs.

Normalize into canonical fields: provider transaction ID, bank account, date/value date, amount/sign, currency, description, reference, counterparty, balance when supplied, category code and raw payload/file hash.

## Deduplication
Primary key: provider transaction ID per connection/account. Fallback fingerprint uses account + date/value date + amount + normalized reference/description + source-file context. Duplicate import must never create duplicate book effects.

## Matching engine
Candidate sources:
- customer receipts/open invoices;
- vendor payments/open bills;
- internal transfers;
- manual journals;
- processor clearing batches;
- payroll/external postings.

Scoring factors: exact/near amount, currency, date proximity, invoice/bill/reference number, counterparty, bank account, historical pattern. Deterministic exact match can auto-match if policy permits. AI ranking is later and does not override accounting validation.

## Categorization
Unmatched bank transaction can create a draft expense/income/owner contribution/loan/fee/interest transaction through a bank rule or user review. User selects account, tax and dimensions. Posting follows normal journal/event path.

## Bank rules
Conditions: text/reference, counterparty, amount range, direction, bank account, recurring date pattern. Actions: suggest or auto-create category/account/tax/dimensions, match transfer, route review. Rules are ordered/versioned and show conflict resolution.

## Reconciliation session
Inputs: account, statement start/end, opening balance, closing balance, statement transactions. Show:
- statement balance;
- book balance;
- matched/cleared items;
- outstanding checks/payments;
- deposits in transit;
- unresolved transactions;
- difference.

Finalization allowed only when difference is zero/configured tolerance. Finalized session is locked; correction uses reopen permission or later-period adjustment depending policy.

## Transfers
Internal transfer creates one business transfer object, paired bank-side references and one journal: Dr destination bank, Cr source bank. Foreign currency transfer includes rates, fees and realized FX where required.

## Payment processor clearing
When customer pays 100 and processor settles 97 with fee 3:
- receipt: Dr Payment Clearing 100 / Cr AR 100;
- settlement: Dr Bank 97 + Dr Processing Fee 3 / Cr Payment Clearing 100.

Support settlement batches and disputes/chargebacks.

## Cash position
Per entity/currency show book balance, latest imported bank balance, unreconciled amount, pending receipts, pending payments, clearing balance and forecasted short-term cash. Values clearly distinguish bank-source vs book-source timestamps.

## Reports
Bank Reconciliation, Unreconciled Transactions, Cash Position, Cash Movement, Bank Fees/Interest, Payment Clearing Aging, Settlement Batches, Feed/Connection Health, Bank Rule Performance.

## APIs
`POST /bank-accounts`, `/bank-connections`, `/bank-imports`, `/bank-transactions/{id}/match|categorize`, `/reconciliations`, `/reconciliations/{id}/finalize`, `/transfers`; `GET /bank-transactions`, `/cash-position`.

## Events
bank_feed.synced, bank_transaction.imported, bank_transaction.matched, bank_transaction.categorized, reconciliation.finalized, transfer.posted, settlement.matched, bank_connection.expiring.

## Acceptance
- Reimport same statement is idempotent.
- Statement reconciliation closes to zero difference.
- Payment processor fixture clears the clearing account exactly.
- Bank match updates subledger and ledger once.
- Foreign-currency transfer creates balanced base-currency journal plus fee/FX where expected.


---

# 07. Tax Engine and Localization Framework

## Data objects
LocalizationPackage, LocalizationVersion, TaxRegistration, TaxCode, TaxRate, TaxComponent, TaxRule, FiscalPosition, TaxTransaction, TaxPeriod, TaxReturn, StatutoryTemplate, EInvoiceSubmission, TaxOverride.

## Localization package
Country/region package can install:
- chart-of-accounts template and account mappings;
- default tax codes/rates/components;
- fiscal positions and tax determination rules;
- statutory invoice/credit-note templates;
- tax reports/returns/registers;
- numbering constraints;
- withholding rules;
- e-invoice adapters;
- country-specific fields/validation.

Installation records exact package version. A multi-entity organization may run different localizations per legal entity.

## Tax determination input
- legal entity and registration;
- source transaction type;
- seller/buyer/vendor/customer jurisdiction;
- supply/delivery location;
- product/service tax category;
- counterparty registration/exemption status;
- transaction/document date;
- tax-inclusive/exclusive mode;
- currency;
- fiscal position;
- exemption/certificate facts.

Output is a deterministic tax calculation snapshot with rule version, taxable base, rate/components, amount, recoverability and posting accounts.

## Tax types/components
Framework must support VAT, GST, sales tax, output/input tax, withholding at source, reverse charge, supplementary/excise-style tax, zero rate, exempt, outside scope, partially recoverable and compound tax. Exact allowed combinations come from localization rules.

## Inclusive/exclusive tax
Server must calculate line-level values consistently and retain rounding. For inclusive tax, derive net base and tax from gross. Document rounding policy must be localization/configuration controlled.

## Input tax recoverability
Tax component can be 0-100% recoverable. Nonrecoverable tax capitalizes into inventory/asset cost or expense based on line destination and localization policy.

## Withholding
Support deduction during invoice, payment or receipt depending jurisdiction. Store certificate/reference and create payable/receivable/control entries. Rule effective dates and counterparty classification are mandatory.

## Tax period/return
Tax period status: OPEN -> PREPARING -> READY -> FILED -> AMENDED. Return pulls only posted tax transactions under exact rule/localization scope. Show exceptions, manual adjustments, reconciliation to GL and source drill-down. Finalized/FILED return becomes immutable snapshot with filing reference/evidence.

## Localization upgrade
New rule/template version never rewrites historical posted tax facts. Upgrade flow:
1. detect package update;
2. show changed rates/rules/forms/mappings;
3. choose effective date if permitted;
4. compatibility checks;
5. approval;
6. install version;
7. apply to new/effective transactions only;
8. keep old engine behavior available for historical credit/amendment logic.

## E-invoicing interface
Provider-neutral contract:
- validate local required fields;
- create payload;
- sign if required;
- submit;
- receive government/provider ID/QR/status;
- retry transient failures;
- handle rejection;
- cancel/credit-note workflow;
- retain full submission/audit metadata.

## Standard posting patterns
- Sale: Dr AR gross; Cr Revenue net; Cr Output Tax.
- Purchase: Dr Expense/Asset/Inventory + Recoverable Input Tax; Cr AP.
- Nonrecoverable tax: included in cost/expense.
- Vendor withholding: Dr AP; Cr Bank + Withholding Payable.
- Reverse charge: generate both applicable input/output/control sides according to localization.

## APIs
`GET /localizations`, `POST /legal-entities/{id}/localization/install`, `POST /tax/calculate`, `GET /tax-codes`, `POST /tax-returns`, `/tax-returns/{id}/finalize`, `/einvoice/{documentId}/submit`.

## Events
localization.installed/upgraded, tax_calculation.completed, tax_rule.version_created, tax_return.ready/filed/amended, einvoice.accepted/rejected.

## Reports
Tax Summary, Tax Detail, Input vs Output, Withholding, Exempt/Zero-rated, Tax Exceptions, Return-to-GL Reconciliation, Tax Rule Usage, Localization Version Audit.

## Acceptance
- Historical posted transaction retains same tax snapshot after rule upgrade.
- Credit note can reference old transaction/rule correctly.
- Return totals reconcile to tax GL controls.
- Mixed taxable/exempt documents calculate correctly.
- Government adapter outage never causes duplicate submission on retry.


---

# 08. Inventory, Warehousing, Costing and COGS

## Data objects
Item, ItemCategory, UnitOfMeasure, Warehouse, Location, StockLot, SerialNumber, InventoryMovement, InventoryReservation, InventoryCostLayer, InventoryValuation, GoodsReceipt, Shipment, StockAdjustment, StockCount, LandedCost.

## Item master
Types: service, non-stock, inventory, asset-purchase item, bundle/composite later. Inventory item fields: SKU, barcode, UOM, sales/purchase descriptions, tax categories, revenue/COGS/inventory accounts, valuation method, tracking method, reorder levels and dimensions/defaults.

## Warehouses and locations
Multiple warehouses; bins/locations; receiving, storage, picking, quarantine, damaged, returns and in-transit locations. Branch association. Inter-warehouse transfer maintains quantity traceability and no revenue/expense unless entities differ.

## Lot/serial tracking
Lot: batch number, manufacture/expiry, supplier, quantity history. Serial: unique unit history. Prevent duplicate active serial ownership. All receipts/issues/transfers preserve chain of custody.

## Stock movements
Movement types: receipt, issue, transfer out/in, customer return, vendor return, adjustment, count variance, production later. Posted movement is immutable; correction creates reverse movement.

## Valuation
Initial advanced support:
- Weighted Average.
- FIFO.
Architecture also allows Standard Cost and Specific Identification later.

Cost engine operates from immutable receipt/cost layers. Every issue has a reproducible valuation breakdown. Backdated transactions require controlled recalculation/settlement strategy and tests.

## Receipt accounting
Policy options:
- receipt posts Dr Inventory / Cr GRNI (goods received not invoiced), bill later clears GRNI to AP;
- simpler bill-driven inventory for early version where receipt has quantity only, if explicitly chosen.

Recommended mature design uses receipt/GRNI because it separates physical receipt from vendor invoice timing.

## Sales fulfillment and COGS
Shipment/issue decrements stock and posts Dr COGS / Cr Inventory using valuation engine. Sales invoice separately posts AR/revenue/tax. This keeps fulfillment timing independent from billing.

## Returns
Customer return restores stock using linked original issue cost where possible; inspection can route to saleable, damaged or scrap. Vendor return reverses receipt/value appropriately and coordinates vendor credit.

## Landed cost
Eligible charges: freight, insurance, customs/duty, handling. Allocation basis: value, quantity, weight, volume or manual. Allocate to receipt/cost layers and post capitalization. Late landed cost must adjust remaining inventory and COGS for already-issued quantity according to chosen policy.

## Stock count
Create scope/snapshot, assign counters, enter counts, recount exceptions, approve variance and post adjustment. Large variances require approval. Keep expected and counted values with evidence.

## Negative stock
Default block. Optional per item/location policy can permit temporarily. If enabled, provisional costing and later cost settlement must be deterministic and visible; enterprise default should remain block.

## Posting patterns
- Receipt: Dr Inventory / Cr GRNI or AP/clearing.
- Vendor invoice when GRNI: Dr GRNI + Input Tax / Cr AP (plus price variance where applicable).
- Issue: Dr COGS / Cr Inventory.
- Write-off: Dr Inventory Loss / Cr Inventory.
- Gain: Dr Inventory / Cr Inventory Gain.
- Landed cost: Dr Inventory / Cr AP or Landed Cost Clearing.

## Reports
Stock On Hand, Inventory Valuation, Stock Movement, Inventory Aging, Lot Expiry, Serial History, Reorder, Stock Count Variance, Landed Cost Detail, COGS Analysis, Inventory-to-GL Reconciliation.

## Acceptance
- Golden FIFO and weighted-average fixtures produce expected COGS/ending inventory.
- Inventory valuation equals GL inventory controls.
- Reverse movement restores quantity/value correctly.
- Serial/lot integrity holds under transfer/return.
- Landed cost allocation totals exactly equal landed-cost document amount.


---

# 09. Fixed Assets and Depreciation

## Data objects
AssetCategory, FixedAsset, AssetBook, DepreciationMethod, DepreciationSchedule, DepreciationRun, AssetTransaction, AssetLocationAssignment, AssetCustodianAssignment, DisposalRecord.

## Asset category
Configure cost account, accumulated depreciation, depreciation expense, gain/loss disposal accounts, default useful life, method, residual-value policy, capitalization threshold and optional book-specific defaults.

## Asset creation
Create manually or from AP purchase line. Required facts: category, description, acquisition source, acquisition date, in-service date, quantity/components when supported, cost, residual value, useful life, method, location, custodian, serial/asset tag, dimensions, attachments and accounting book.

## Capitalization
A bill line can be flagged/suggested as fixed asset. Policy may automatically flag amounts above category threshold but finance approves final capitalization. Posting: Dr Fixed Asset / Cr AP, Bank or clearing as applicable.

## Depreciation methods
Initial:
- straight-line;
- reducing/declining balance where configured.
Design method interface for local/tax variations, units-of-production and custom schedules later.

Proration options: exact days, monthly convention, full month, half-month or localization-specific configuration. Store the actual method/version used by each asset book.

## Depreciation schedule
Generate schedule from in-service date through useful life, respecting residual value. Schedule lines have period, expected amount, posted amount, journal ID, status and revision/version. Changes to estimate apply prospectively unless a specific accounting adjustment workflow is chosen.

## Depreciation run
1. choose entity/book/period;
2. load eligible unposted schedule lines;
3. validate period and asset status;
4. preview total by account/dimension;
5. approve if configured;
6. post Dr Depreciation Expense / Cr Accumulated Depreciation;
7. mark exact schedule lines posted;
8. emit event and update reconciliation.

Run and schedule lines must be idempotent. Same asset/period/book cannot depreciate twice.

## Transfers
Transfer location, branch, department, cost center or custodian with effective date and complete assignment history. Configure whether future depreciation uses new dimensions or original dimensions.

## Revaluation and impairment
Controlled transactions only. Store reason, valuation evidence, date, book and approval. Create explicit journal according to entity accounting policy; never overwrite historical cost/accumulated values.

## Disposal
Types: sale, scrap, loss, write-off, donation. Calculate carrying amount on disposal date, proceeds, cost removal, accumulated depreciation removal and gain/loss. Support partial disposal/component disposal later.

Generic journal:
- Dr Bank/AR for proceeds;
- Dr Accumulated Depreciation;
- Dr Loss if needed;
- Cr Asset Cost;
- Cr Gain if needed.

## Multiple books
Advanced phase supports different depreciation methods/useful life/carrying amount per book while sharing physical asset master. Each book has independent schedule/journals.

## Reports
Asset Register, Asset Additions, Disposals, Depreciation Schedule, Period Depreciation, Asset by Location/Custodian, Fully Depreciated Assets, Revaluation/Impairment History, Asset-to-GL Reconciliation.

## APIs/events
`POST /assets`, `/assets/{id}/capitalize|transfer|revalue|impair|dispose`, `/depreciation-runs`.
Events: asset.created/capitalized/transferred/revalued/impaired/disposed, depreciation.posted.

## Acceptance
- Mid-period depreciation fixture matches configured convention.
- Same schedule line cannot post twice.
- Disposal removes asset cost/accumulated depreciation and calculates gain/loss correctly.
- Asset register equals fixed-asset and accumulated-depreciation GL controls.


---

# 10. Projects, Cost Centers, Budgets and Management Accounting

## Data objects
Project, ProjectPhase, CostCenter, Department, Budget, BudgetVersion, BudgetLine, ForecastVersion, Commitment, TimeEntry, ProjectBillingRule, BillingProposal, AllocationRule.

## Analytical model
Use ledger dimensions for Department, Cost Center, Project, Location, Customer and other management axes. Avoid creating a new GL account for every department/project combination.

## Project
Fields: code, name, customer, manager, status, dates, contract value, currency, billing method, default dimensions, budget and profitability settings.

Statuses: PLANNED -> ACTIVE -> ON_HOLD -> COMPLETED -> CLOSED. Closing blocks new ordinary cost/billing unless reopened or late-cost permission applies.

## Project costs/revenue
AR invoices, AP bills, expenses, inventory issues, manual journals and time/labor allocations can carry project dimension. Project P&L is calculated from ledger lines plus configured management-only metrics.

## Project billing
Methods:
- fixed fee;
- milestone;
- time and materials;
- expense reimbursement;
- retainer/deposit;
- percentage/progress later.

Billing proposal gathers approved billable facts, shows previously billed/unbilled, requires review, then creates normal AR invoice draft. No direct revenue posting from project module.

## Cost centers/departments
Dimension values have code, hierarchy, manager, active dates and optional approval/budget ownership. Configure expense accounts that require cost center.

## Budgets
Budget fields: entity, fiscal year, scenario/type, currency, dimensions, owner, status and version. Lines can target account/account group + period + dimension combination.

Lifecycle: DRAFT -> REVIEW -> APPROVED -> ACTIVE -> SUPERSEDED/CLOSED.

Never overwrite approved budget. Revision creates new version while preserving Original Budget and Current Approved Budget.

## Budget control
Available budget can be:
`Approved Budget - Actual Posted - Open Commitments - Pending Approved Spend`

Policy choices:
- informational only;
- warn above threshold;
- block over budget;
- require override approval.

Commitments may come from approved requisitions and/or purchase orders. Cancel/close releases remaining commitment.

## Forecasts
Separate from statutory ledger. Support rolling monthly forecasts and scenarios Base/Best/Worst. Import/export and copy actual-to-forecast. Forecast data can be used in reports but never changes ledger.

## Allocation rules
Management allocations for shared costs can produce actual journals or reporting-only allocations depending purpose. If actual accounting allocation, use normal journal/posting service with rule/version and reversal support.

## Reports
Budget vs Actual, Available Budget, Department P&L, Cost Center Spend, Project P&L, Project Revenue/Cost/Margin, Billable/Unbilled, Commitment Report, Forecast vs Actual, Scenario Comparison.

## APIs/events
`POST /projects`, `/budgets`, `/budgets/{id}/approve`, `/forecasts`, `/projects/{id}/billing-proposals`, `GET /budget-control/check`.
Events: project.created/closed, budget.approved/superseded, budget.threshold_exceeded, forecast.published, billing_proposal.created.

## Acceptance
- Budget control includes actual + commitment correctly.
- Closing/canceling PO releases unused commitment.
- Project P&L drills to ledger/source documents.
- Budget revision does not overwrite original approved version.


---

# 11. Multi-Currency, Multi-Entity, Intercompany and Consolidation

## Data objects
ExchangeRate, ExchangeRateSet, CurrencyRevaluationRun, Group, GroupMembership, IntercompanyRelationship, IntercompanyTransaction, EliminationRule, ConsolidationRun, TranslationAdjustment, AccountingBook, AccountMapping.

## Foreign currency transaction
Store:
- transaction currency and amount;
- base/book currency and amount;
- exchange rate and rate type;
- source/provider/manual override metadata;
- original rate on open AR/AP item.

Invoice/bill uses rate determined by policy on posting date/document date. Settlement uses settlement-date rate and calculates realized FX difference.

## Exchange rates
Rate types: transaction/spot, average, closing and historical. Never update historical rate row in place. Manual override requires permission and audit reason. Missing rate blocks posting unless authorized manual rate is supplied.

## Realized FX
Example foreign AR:
- invoice creates AR at original base value;
- receipt settles AR at original carrying value;
- bank is posted at current translated value;
- difference posts to realized FX gain/loss.

Support partial settlements, each retaining remaining foreign amount and carrying base amount.

## Period-end revaluation
Revalue open monetary foreign-currency balances at closing rate. Produce preview per account/currency/open item. Post unrealized gain/loss and configurable reversal in next period. Revaluation run is scoped by entity/book/period/rate set and must be idempotent.

## Multi-entity group
Organization can contain multiple legal entities with different currencies, fiscal calendars and localizations. Group configuration includes reporting currency, ownership/effective dates and consolidation hierarchy.

## Intercompany
Configure counterparty relationships and due-to/due-from accounts. Cross-entity business process creates linked source IDs. Example seller invoice in Entity A can create/coordinate buyer bill in Entity B. Each entity posts its own balanced statutory journal.

Intercompany reconciliation compares transaction ID, currency, amount, date and status. Timing differences remain exceptions until matched.

## Consolidation
Consolidation run inputs:
- group;
- period/date range;
- reporting currency;
- accounting book;
- entity source close status;
- exchange-rate set;
- chart/account mappings;
- elimination rule version.

Process:
1. validate entity periods/source completeness;
2. validate rates/mappings;
3. translate entity balances;
4. calculate entity contributions;
5. match intercompany;
6. create elimination entries in consolidation/elimination context;
7. calculate translation adjustment/CTA according to configured accounting policy;
8. create consolidated TB and statements;
9. finance review/approval;
10. lock reproducible consolidation snapshot.

Consolidation never changes source statutory ledgers.

## Account mapping
Entities can use local charts. Map local accounts/groups to group reporting chart. Missing required mapping blocks final consolidation and appears in exception report.

## Multi-book accounting
Advanced scope:
- primary and secondary books;
- book-specific journal adjustments;
- chart mapping;
- book-specific depreciation and revenue schedules;
- book-specific period close;
- book-specific consolidated reporting.

A source transaction may generate parallel book journals through separate posting rules. Book differences are explicit; no hidden overwrites.

## Reports
Foreign Currency Exposure, Realized/Unrealized FX, Intercompany Reconciliation, Entity Contribution, Consolidated TB/P&L/BS/CF, Elimination Detail, CTA Rollforward, Multi-book TB.

## Acceptance
- Foreign invoice with multiple partial settlements produces correct realized FX.
- Revaluation can preview repeatedly but posts once per configured scope/version.
- Intercompany pair reconciles without cross-tenant/entity leakage.
- Consolidated TB is reproducible from source balances + translation + eliminations.
- Source entity journals are unchanged by consolidation.


---

# 12. Reporting, Period Close, Reconciliations and Audit

## Data objects
ReportDefinition, ReportRow, ReportColumn, ReportRun, FinancialStatementSnapshot, CloseChecklistTemplate, CloseChecklist, CloseTask, AccountReconciliation, ReconcilingItem, AuditEvidence, AuditRequest.

## Standard reports
Required:
- Trial Balance;
- General Ledger;
- Journal Register;
- Profit & Loss;
- Balance Sheet;
- Cash Flow;
- AR Aging and customer balances;
- AP Aging and vendor balances;
- Tax summary/detail;
- bank reconciliation/cash;
- inventory valuation/COGS;
- fixed asset register/depreciation;
- budget vs actual;
- project/department/cost-center profitability;
- consolidated statements in later phase.

## Financial statements
Parameters: entity/group, book, period/date range, comparison period, YTD, currency, dimensions, budget/forecast scenario, include/exclude adjustments. Default includes only POSTED journals.

## Drill-down requirement
Every material number must support:
`Statement total -> report row -> account/group -> dimension/entity breakdown -> journal lines -> source document -> attachments + audit history`.

Permission on destination record is rechecked; a user may see an aggregate but not restricted source detail if policy requires.

## Report definitions
Versioned configurable rows/columns:
- account/account group ranges;
- formulas;
- subtotals;
- signs/presentation;
- comparisons;
- dimensions;
- entity/group columns;
- rounding/display units;
- conditional display.

Changing report definition creates new version. Historical approved statement snapshot stores definition version.

## Cash flow
Initial method can use configured account/cash-flow classification plus derived cash movements. Support operating/investing/financing classification and controlled overrides. Later support indirect/direct presentation variants by market need.

## Close checklist
Generate monthly/quarterly/year-end tasks. Typical tasks:
- bank accounts reconciled;
- payment clearing reconciled;
- AR aging reviewed;
- AP aging reviewed;
- inventory count/valuation reconciled;
- fixed asset additions/disposals reviewed;
- depreciation posted;
- accrual/prepayment/deferred revenue entries;
- tax reconciliation;
- FX revaluation;
- intercompany reconciliation;
- unusual/manual journals review;
- balance-sheet reconciliations;
- financial statements reviewed;
- final approval;
- period close.

Tasks have owner, due date, status, dependencies, evidence and approval.

## Account reconciliation
For balance sheet/control account:
- GL ending balance;
- supporting/subledger balance;
- reconciling items;
- difference;
- attachments/evidence;
- preparer certification;
- approver certification;
- status.

Approved reconciliation is immutable unless formally reopened with reason.

## Financial statement snapshot
When statements are approved/period closed, save immutable metadata: report definition version, parameters, ledger cutoff/checkpoint, generated file/hash, actor, approval and date. Future activity must not rewrite old snapshot.

## Auditor workspace
Read-only scoped role can access selected entities/periods, statements, reconciliations, journals, source evidence and audit requests. Auditor cannot edit accounting. Requests have owner/status/evidence and comments.

## Exports
Asynchronous CSV/XLSX/PDF export jobs for large reports. Export is tenant/entity scoped, audit logged and contains metadata (entity, report, period, generated timestamp). Sensitive exports can require additional permission.

## APIs/events
`GET /reports/profit-loss|balance-sheet|cash-flow|trial-balance`, `POST /report-definitions`, `/report-runs`, `/close-checklists/generate`, `/account-reconciliations`, `/financial-statement-snapshots`.
Events: report.generated, close_task.completed, account_reconciliation.certified, financial_statements.approved, accounting_period.closed, audit_request.created.

## Acceptance
- Financial statement amount drills to raw posted journal lines.
- Statement snapshot is unchanged by future transactions.
- Close cannot finalize while required critical tasks are incomplete unless explicit override workflow exists.
- Subledger/control reconciliation exceptions are visible before close.


---

# 13. AI, Document Intelligence and Finance Automation

## Principle
AI is an assistive/orchestration layer. It can extract, suggest, explain, rank, detect and draft. It never writes directly to posted ledger tables and never bypasses domain validation, permissions, period locks, approval or accounting policy.

## Data objects
AIDecision, AIModelConfig, DocumentExtraction, ExtractionField, CodingSuggestion, MatchSuggestion, Anomaly, AIConversation, EvidenceLink, AgentAction, AutomationPolicy, HumanReviewTask, EvaluationCase.

## Document ingestion
Inputs: PDF, image, email attachment and provider file. Pipeline:
1. store original file and cryptographic hash;
2. malware/security scan hook;
3. classify document type;
4. OCR/vision extraction;
5. normalize structured fields;
6. field-level confidence;
7. totals/math validation;
8. duplicate document detection;
9. vendor/customer/PO matching;
10. accounting/tax/dimension suggestions;
11. human review based on confidence/policy;
12. create normal draft bill/invoice/expense/bank statement;
13. continue standard business workflow.

Extract: party, invoice/receipt number, dates, currency, subtotal/tax/total, line items, quantity/UOM, unit price, tax, bank/payment terms, PO/reference. Never discard original evidence.

## Coding assistant
Suggest:
- GL account;
- tax code;
- project/cost center/department;
- vendor/customer;
- fixed-asset capitalization;
- prepayment/deferred treatment;
- bank categorization.

Inputs include accounting policy, approved historical patterns and current source facts. Output includes confidence and evidence/reasons. Do not silently learn a new accounting rule from one reviewer correction.

## Reconciliation assistant
Rank bank-to-book candidates. Deterministic constraints remain authoritative. AI can help understand descriptions/counterparties and historical patterns. A proposed match must still satisfy allocation amount, currency and source-state rules.

## Anomaly engine
Detect:
- duplicate bill/receipt/payment;
- unusual amount/vendor/account;
- new bank detail before large payment;
- manual journal to control account;
- dormant account activity;
- unexpected tax rate;
- missing receipt/attachment;
- out-of-period/backdated activity;
- unreconciled clearing balance;
- unusual gross margin/cost movement;
- repeated reversals;
- invoice/payment patterns suggesting collection risk.

Anomaly stores severity, model/rule, evidence, owner, resolution and false-positive feedback.

## Finance Q&A
Natural language examples: “Why did gross margin fall?”, “Which customers are most overdue?”, “Show cash outflow by department this quarter.”

Q&A must query an authorized finance semantic/report layer, not unrestricted raw SQL. Every material number includes entity, period, currency and evidence links. The assistant states when data is incomplete or unreconciled.

## Close assistant
Summarize outstanding close tasks, unresolved reconciliation items, material variances, missing evidence and abnormal balances. Can draft accrual/reclass journal suggestions. Final journal uses normal draft/approval/post flow.

## Agent action framework
Allowlisted tools only, such as:
- create draft bill;
- create draft journal;
- propose bank match;
- draft customer reminder;
- run report;
- create task;
- place proposed payment/vendor hold under policy.

Each action contains requested tool, structured arguments, actor permission context, policy result, confidence, approval requirement, idempotency key and execution result.

High-risk AI actions always require human approval initially: posting journals, sending payments, changing bank details, filing tax, closing periods, creating users/roles and deleting/exporting sensitive data.

## Prompt injection/data isolation
Treat text inside uploaded documents/emails as untrusted data, not instructions. Tool-use policy is external to model output. Retrieval always scopes tenant/entity/permission. Never allow document text to cause hidden data access or tool calls.

## Model/provider abstraction
Store provider/model/version, prompt/system-policy version and evaluation result. Ability to switch models without rewriting accounting domain. Tenant-level data policy can disable external model processing or require approved provider.

## Evaluation
Maintain labeled sets for:
- invoice/receipt extraction field accuracy;
- accounting coding top-1/top-3 accuracy;
- bank matching precision/recall;
- anomaly precision;
- finance Q&A numerical/evidence correctness.

Automation threshold is enabled by task only after measured evaluation and live reviewer acceptance support it.

## Acceptance
- AI cannot execute unauthorized ledger/payment commands even with malicious document prompt injection.
- Every AI financial action is auditable to model/prompt/tool version and final disposition.
- Q&A material numbers link to evidence.
- Low-confidence extraction routes review instead of fabricating fields.


---

# 14. Workflows, Approvals, Notifications and Tasks

## Data objects
WorkflowDefinition, WorkflowVersion, WorkflowInstance, ApprovalStep, ApprovalDecision, Delegation, EscalationRule, Task, NotificationTemplate, Notification, AutomationAction.

## Workflow definition
A workflow contains:
- trigger event/document action;
- scope by entity/branch/module;
- conditions: amount, currency, vendor/customer, account, category, project, department, risk flag, exception status;
- ordered or parallel steps;
- approver resolution;
- rejection/request-change behavior;
- escalation timers;
- completion actions.

Published workflow versions are immutable. New changes create a new version. A running instance retains the version it started with.

## Approver resolution
Methods:
- named user;
- role in entity/branch;
- manager of requester;
- department/cost-center owner;
- project manager;
- amount-authority table;
- finance controller/CFO role;
- custom deterministic resolver.

Resolved approvers are recorded on the instance. User still needs current permission to act.

## Segregation of duties
Configurable constraints:
- creator cannot final-approve own journal/payment/vendor bank change;
- preparer and approver must be different users;
- payment over threshold requires two distinct approvals;
- vendor bank change and first subsequent payment require independent review;
- period reopen requires controller/admin approval;
- tax filing requires preparer/approver separation.

## Approval actions
APPROVE, REJECT, REQUEST_CHANGES, DELEGATE where permitted. Decision records actor, timestamp, comment, IP/session context and relevant document version. Editing a submitted document can invalidate previous approvals based on configured material-change rules.

## Unified task inbox
Task sources:
- approvals;
- bank reconciliation exceptions;
- bill matching exceptions;
- missing documents;
- overdue collections;
- close tasks;
- tax exceptions;
- AI review;
- integration failures;
- migration errors.

Task fields: title, source link, entity, owner, priority, due date, status, tags, escalation and completion evidence.

## Notifications
Channels: in-app mandatory, email, later SMS/push. Template variables are allowlisted. Do not put sensitive bank/account information into notification content by default. Notification delivery failures enter operations view.

## Delegation/escalation
Temporary delegation with start/end and scope. Delegation cannot violate segregation-of-duties. Escalation can remind, add watcher, reassign or add higher approver. Preserve complete assignment history.

## Automation actions
Workflow can create task, send notification, tag/hold document, call webhook, request AI suggestion, generate draft document or trigger safe non-posting action. Any financial posting/payment remains a normal domain command with its own permission/approval rules.

## APIs/events
`POST /workflows`, `/workflows/{id}/publish`, `GET /tasks`, `POST /approvals/{id}/approve|reject|request-changes|delegate`.
Events: workflow.started/completed, approval.requested/approved/rejected/escalated, task.created/completed, notification.sent/failed.

## Acceptance
- Calling a post/pay endpoint directly cannot bypass active approval workflow.
- Workflow instance remains attached to its original version.
- Creator cannot self-approve where SoD rule forbids it.
- Parallel approval and rejection behavior is deterministic.


---

# 15. API, Integrations and Developer Platform

## API conventions
Base `/v1`. JSON. Stable resource IDs. Cursor pagination for large lists. Filtering/sorting documented. All responses/errors include request/correlation ID. Financial create/action endpoints accept `Idempotency-Key` where retries are possible.

Error envelope includes stable code, human message, field/details and request ID. Avoid leaking stack traces or internal SQL.

## Authentication
- First-party user session/JWT strategy as platform decides.
- OAuth 2.x style authorization for third-party apps.
- Scoped service credentials for tenant-owned machine integrations.
- Credential rotation/revocation.
- Tenant/entity scopes in token authorization.

## Public resource groups
Organizations/Entities, Customers, Vendors, Accounts, Dimensions, Invoices/Credits/Receipts, Bills/Vendor Credits/Payments, Bank Transactions/Reconciliation, Items/Inventory, Assets, Projects, Journals, Reports, Tasks/Approvals, Tax where safe, Imports/Exports.

Public API never offers “insert journal line directly into posted ledger.” Manual journal API creates draft then uses normal approve/post command.

## Webhooks
Endpoint configuration: URL, subscribed event types, signing secret, status and retry policy. Payload includes unique event ID, type/version, occurred time, tenant/resource IDs and minimal necessary data.

Delivery:
1. event committed via outbox;
2. create delivery;
3. sign timestamp + payload;
4. POST;
5. 2xx success;
6. retry transient failure with backoff;
7. dead-letter after limit;
8. manual replay supported.

Same event ID is retained on retries. Consumer is expected to be idempotent.

## Integration adapters
Standard interfaces:
- bank feed;
- payment gateway/processor;
- e-commerce/POS;
- payroll;
- CRM;
- document/email intake;
- government/e-invoicing;
- competitor migration.

Adapter converts provider data into canonical domain commands/import staging records. Store provider connection, external IDs, sync cursor, mapping tables and last successful sync.

## Integration mappings
Map external customer/vendor/item/account/tax/location IDs to internal IDs. Conflicts/unmapped values enter integration exception queue, not silent defaults.

## Bulk imports/exports
Asynchronous jobs. Flow: upload -> parse -> validate -> mapping -> preview -> commit -> result. Row-level errors and resumable/retry behavior. Import uses external IDs and project/batch idempotency.

## Rate limiting
By app/tenant/IP and endpoint class. Sensitive/high-cost endpoints stricter. Return retry metadata. Prevent one tenant/integration from exhausting shared workers.

## Developer portal
Provide:
- OpenAPI document;
- auth guide;
- scopes;
- idempotency guide;
- pagination/errors;
- webhook signing examples;
- event catalog;
- sandbox/demo environment;
- changelog/deprecation notices;
- SDK examples.

## Integration health
Show connection status, token/consent expiry, last sync, next sync, failed jobs, webhook failures, unmapped records and backlog. Alert before credentials expire.

## Acceptance
- External timeout + retry cannot duplicate invoice/payment.
- Revoked token stops access.
- Webhook signature/replay tests pass.
- Provider schema error is isolated to integration exception and does not corrupt financial data.


---

# 16. Security, DevOps, Backups, Availability and Observability

## Identity security
- MFA.
- Session/device management and revocation.
- Secure password reset; passkey/SSO roadmap.
- Login throttling/brute-force controls.
- Reauthentication for selected high-risk actions.
- Security events for login failures, MFA changes, role/permission changes and unusual access.

## Authorization and tenant isolation
Central server-side guards enforce tenant, organization, legal entity, branch and permission scope. Object IDs alone never grant access. Workers/report exports/integrations receive explicit tenant context. Add automated cross-tenant tests for every major resource.

PostgreSQL RLS may be used as a defense layer if engineering team can operate it reliably; application scoping remains required.

## Data protection
- TLS in transit.
- Managed encryption at rest.
- Field-level encryption/tokenization for bank credentials, OAuth tokens and other high-risk secrets.
- S3 signed URLs/tenant-scoped object keys.
- Antivirus/malware scan hook for uploads.
- Data minimization for AI/providers.

## Secrets
Use cloud secret manager/Vault-type system. No production secrets in repository, image, client bundle or committed `.env`. Rotate integration signing keys and provider credentials. Separate dev/staging/prod secrets.

## Audit vs operational logs
Audit log: immutable business/security history, actor/resource/before-after/reason/request ID. Operational log: structured technical diagnostics. Never log passwords, access tokens, full secrets or sensitive bank details. Use correlation IDs across API, queues and webhooks.

## CI/CD
CI gates:
- lint/format;
- TypeScript typecheck;
- unit tests;
- PostgreSQL integration tests;
- accounting golden fixtures;
- tenant/authorization tests;
- migration tests;
- dependency/secret/container scans;
- application build.

CD: immutable image -> staging -> smoke/regression -> approval -> production. Use feature flags for staged rollout. Prefer roll-forward compatible migrations; document rollback when possible.

## Database migrations
- Versioned migrations in repo.
- Never make destructive production migration without staged/backfill plan.
- Add nullable/new structures before switching code; backfill; enforce constraint later.
- Test on realistic volume.
- Financial data conversions require before/after reconciliation.

## Backups
PostgreSQL automated backups + point-in-time recovery. Object storage versioning/retention. Monitor backup jobs. Regular restore drills into isolated environment. Restore verification includes tenant samples, attachment existence and ledger/reconciliation checks.

## Recovery
Document RPO/RTO targets for each deployment tier. Runbooks for DB failure, Redis/queue outage, object-store issue, provider outage and compromised credential. Financial command must fail safely if required consistency service unavailable.

## Observability
Metrics/traces/logs:
- API p50/p95/p99 and errors;
- DB connections/locks/slow queries;
- queue depth/age;
- outbox unpublished age;
- posting failures;
- reconciliation job failures;
- bank feed latency/errors;
- webhook delivery failures;
- report/export job duration;
- AI provider/model errors/cost/latency;
- login/permission-denied anomalies.

## Incident response
Severity, owner, timeline, containment, customer impact, financial reconciliation, root cause and corrective actions. P0/P1 financial incidents require post-incident ledger/subledger integrity checks.

## Acceptance
- Tenant isolation security suite passes.
- Restore drill recovers selected point and validates ledger totals.
- Sampled logs contain no secrets/tokens.
- Application role cannot mutate posted journal lines directly.
- CI blocks untested migration/financial regression.


---

# 17. Migration, Imports, Opening Balances and Data Quality

## Data objects
MigrationProject, SourceSystem, ImportTemplate, ImportBatch, ImportRow, MappingSet, MigrationExternalID, OpeningBalanceSet, ReconciliationResult, CutoverChecklist.

## Supported migration modes
1. Opening balances only.
2. Opening balances + open AR/AP + master data + comparative monthly balances.
3. Full historical transaction migration where commercially necessary.

Store chosen mode so users know which historical drill-down is detailed versus summarized.

## Generic import framework
Templates for:
- chart of accounts;
- customers/vendors;
- items;
- opening TB;
- open invoices/credits/receipts;
- open bills/credits/payments;
- bank balances/transactions;
- inventory quantity/value;
- fixed assets;
- historical journals/balances.

Process:
1. upload file/API source;
2. parse into staging;
3. map columns and source IDs;
4. validate types/required fields;
5. validate references/accounts/tax/dimensions;
6. show row errors/warnings;
7. preview totals;
8. commit through migration/domain services;
9. produce reconciliation and result report.

## Competitor adapters
Prioritize based on customers: QuickBooks, Xero, Zoho Books, Odoo and later Sage/NetSuite. Adapter transforms source export/API to canonical staging models. Never direct-write posted ledger tables.

## Mapping
Account mapping validates compatible account types/control behavior. Tax mapping includes effective historical logic where detail is imported. External IDs are namespaced by migration project/source system.

## Opening trial balance
Require debit=credit. Separate current-year P&L/retained earnings treatment according to cutover date. Opening journal is special source type and fully auditable.

## Open AR/AP
Import individual open items so aging/statements/payment allocation work. Import customer/vendor credits and unapplied receipts where needed. Subledger total must reconcile to opening AR/AP control accounts before activation.

## Inventory opening
Import quantity and value by item/warehouse/lot/serial as required. Create opening inventory movement/cost layers that reconcile to GL inventory opening value.

## Fixed assets opening
Import original cost, acquisition date, in-service date, accumulated depreciation, remaining life/method and current book value. Reconcile cost/accumulated GL balances.

## Data quality
Checks:
- duplicate customer/vendor;
- duplicate document numbers;
- invalid account types;
- unbalanced journal;
- invalid date/period;
- unsupported currency;
- missing rate;
- negative/open amount inconsistencies;
- tax total mismatch;
- orphan references;
- inventory negative/serial duplicate.

## Dry run and cutover
Run at least one representative dry migration in sandbox/staging. Record source extraction steps, mapping decisions and timings. At cutover: source freeze, final delta, target reconcile, business signoff, enable posting, preserve source exports/checksums.

## Reconciliation pack
Source vs target:
- Trial Balance;
- AR aging/control;
- AP aging/control;
- bank balances;
- inventory value;
- fixed asset cost/accumulated depreciation;
- tax controls;
- key document counts.

Every difference needs documented explanation and approval.

## Acceptance
- Rerun is idempotent by project/external ID.
- Target trial balance equals signed source balance.
- Open AR/AP agree at detail and GL level.
- Original source files/checksums remain retained through agreed audit period.


---

# 18. UI Screen Map and User Workspaces

## Global shell
- Organization/entity selector.
- Accounting book selector where enabled.
- Global period/date context.
- Left navigation.
- Search/command palette.
- Global Create menu.
- Notifications.
- Unified Tasks.
- Help/support.
- User/security menu.
- Visible environment indicator in non-production.

Entity/book switching must discard/reconfirm unsaved cross-scope draft and reload all scoped queries. Never keep stale Entity A data visible after switching to Entity B.

## Owner workspace
Widgets: cash, revenue, expenses, profit, AR due/overdue, AP due, bank status, tax/close alerts, cash forecast, top customers/vendors and finance-health exceptions. Keep accounting jargon minimal; drill down remains available.

## Accountant workspace
- Trial Balance.
- General Ledger.
- Journals.
- Bank reconciliation.
- AR/AP aging and exceptions.
- Tax workspace.
- Fixed assets.
- Inventory reconciliation.
- Account reconciliations.
- Period close.
- AI/document review queue.

## CFO/Controller workspace
- consolidated/entity KPIs;
- P&L/BS/CF;
- budget vs actual;
- cash/forecast;
- approvals;
- close status;
- entity contribution;
- intercompany exceptions;
- anomalies/risks;
- management report packs.

## Main navigation
Dashboard
Sales: Customers, Quotes, Sales Orders, Invoices, Credit Notes, Receipts, Statements, Collections
Purchases: Vendors, Requisitions, Purchase Orders, Receipts, Bills, Vendor Credits, Expenses, Payment Runs
Banking: Accounts, Transactions, Rules, Reconciliation, Transfers, Settlements
Inventory: Items, Warehouses, Movements, Counts, Adjustments, Landed Costs
Assets
Projects
Budgets & Forecasts
Accounting: COA, Journals, Dimensions, Periods, Recurring Journals
Tax
Reports
Close & Reconciliations
Tasks & Approvals
AI Review/Assistant
Integrations
Settings/Admin

## Record page standard
Header: document number/name, status, key amount/currency, counterparty, date, primary actions.
Tabs:
- Details;
- Lines;
- Accounting (journal link/posting preview);
- Payments/Allocations;
- Match/Fulfillment where applicable;
- Attachments;
- Activity/Audit.

Posted documents visibly show locked state. Correction action is Credit/Reverse/Adjust rather than Edit.

## Lists
Server-side pagination/filtering. Saved views. Columns configurable by user/role. Export permission separate. Bulk actions only when domain-safe. Status and exception badges standardized.

## Create/edit forms
- server-authoritative totals;
- keyboard-friendly accounting grids;
- tax/account/dimension search;
- inline validation;
- autosave draft where safe;
- posting preview for accountants;
- attachment drag/drop;
- approval status.

## Reports
Filter drawer for entity/book/date/currency/dimensions/comparison. Drill-down on values. Save report view. Export. Approved snapshot indicator when viewing closed report pack.

## Unified search
Search authorized customers/vendors, document numbers, journal references, item/SKU, amounts where enabled and attachment metadata. Search index/read model is tenant/entity scoped.

## Acceptance
- Every module has consistent list/detail/action/audit behavior.
- User can navigate P&L number to source attachment.
- UI never uses hidden button as authorization control.
- Posted document cannot be altered by form manipulation/API request.


---

# 19. QA, Financial Test Strategy and Acceptance

## Required test layers

### Unit tests
Money/rounding, due dates, tax, FX, depreciation, FIFO/average cost, allocation math, matching scores, report formulas, posting-rule builders.

### PostgreSQL integration tests
Posting transactions, locks, period status, idempotency, concurrent allocation/payment, sequence numbering, outbox, migrations, read-model rebuilds.

### Golden accounting fixtures
Maintain exact inputs and expected journals/report balances for:
- invoice + tax;
- customer receipt/partial/overpayment;
- credit/refund/write-off;
- vendor bill/payment/credit/withholding;
- bank fee/transfer/processor settlement;
- inventory receipt/issue/return/write-off/landed cost;
- asset capitalization/depreciation/disposal;
- accrual/reversal/prepayment;
- foreign invoice/partial settlement/revaluation;
- intercompany + elimination;
- opening balances;
- tax return reconciliation.

### Property/invariant tests
Generate many random valid transactions and assert:
- posted debit=credit;
- no line has debit and credit simultaneously;
- no receipt/payment over-allocation;
- no duplicate posting from retries;
- posted history immutable;
- stock/serial invariants;
- subledger/control reconciliation;
- tenant isolation.

### End-to-end
Critical browser/API flows must reach actual posted journal and report. Include create -> approve -> post -> pay -> reconcile -> close.

### Security
- cross-tenant IDOR attempts;
- entity scope;
- privilege escalation;
- role changes/session revocation;
- signed webhook;
- upload access;
- integration scope;
- rate limit;
- AI prompt injection/tool abuse.

### Concurrency
- two users post same invoice;
- two receipts allocated to last invoice balance;
- two vendor payments on same bill;
- duplicate number allocation;
- two stock issues consume last quantity/cost layer;
- period closes during posting;
- approval race.

### Performance
Before enterprise launch define realistic seeded volumes: entities, years, journal lines, invoices, bank transactions, concurrent users. Measure report p95, list p95, posting latency, batch close/revaluation and import throughput. Use query plans/index tuning from evidence.

### AI evaluation
Labeled extraction fields, coding accuracy, matching precision/recall, anomaly precision, Q&A numerical correctness/evidence. Evaluate per model/prompt version before rollout.

## Reconciliation suite
Automated seeded dataset must prove:
- AR detail = AR control GL;
- AP detail = AP control GL;
- inventory valuation = inventory GL;
- fixed asset cost/accumulated = GL;
- payment clearing = unsettled processor items;
- tax support = tax controls;
- trial balance debits = credits.

## Release rule
A financial defect fix must add a regression test or golden fixture. No release may skip invariant/reconciliation tests to get green CI.

## Acceptance
- CI fails on any changed expected journal unless fixture change is explicitly reviewed.
- Cross-tenant suite covers all core resources.
- Reversal/correction paths are tested, not only creation.
- Staging reconciliation suite must be green before production.


---

# 20. Bangladesh Localization Package

## Scope
Implement Bangladesh-specific statutory behavior through the generic localization/tax framework. Do not embed Bangladesh rules inside the global ledger/AR/AP modules. Every local rule/template is versioned/effective-dated and validated against current NBR requirements before release.

## Data objects
BangladeshVATProfile, BangladeshTaxCode/Rule mappings, BIN/registration metadata, MushakDocument, VATReturnBD, VDS/withholding certificate records, NBRRuleVersion, statutory register snapshots.

## Installation
Bangladesh package installs/configures:
- Bangladesh chart template/mappings;
- VAT/input/output/withholding/other tax control accounts;
- fiscal positions and product/service tax categories;
- local invoice fields/templates;
- statutory registers/forms supported by release;
- VAT period defaults and return workspace;
- local numbering/printing rules where required;
- source references for rule/version.

## VAT 2012 forms/registers
Initial compliance development should map posted source data to the VAT/Mushak forms currently listed by NBR that are relevant to supported customer types. The official VAT 2012 forms page currently lists 9.1, 6.3, 6.5, 6.2, 6.2.1, 6.1, 4.3, 2.1, 9.2, 6.10 and 2.3. Do not promise every form in first commercial release; implement and validate required forms by customer/industry scope.

Priority design targets:
- purchase register/output for Mushak/VAT 6.1 where applicable;
- sales register/output for 6.2/6.2.1 where applicable;
- tax invoice support for 6.3 where applicable;
- transfer/other document 6.5 where applicable;
- summary/support 6.10 where applicable;
- monthly return support 9.1;
- additional forms only after accounting/tax review.

## VAT transaction classification
Store from each posted sales/purchase line:
- entity/BIN;
- counterparty and registration facts;
- product/service category;
- taxable/exempt/zero/special treatment;
- taxable base;
- VAT/SD/withholding components;
- source document and date;
- rule/SRO/localization version;
- input recoverability;
- branch/location as required.

## VAT invoice generation
Generate local invoice from posted source facts. Template version is stored. If government/NBR electronic integration becomes available/required for target case, implement through e-invoice adapter rather than changing invoice accounting logic.

## Return workflow
`Posted transactions -> tax exception queue -> registers/forms -> VAT control reconciliation -> preparer review -> approver -> export/submission process -> mark filed with reference/evidence -> immutable snapshot`.

Late document after filing is flagged to amended/next-period treatment according to current validated rules; never silently rewrite filed snapshot.

## Withholding/VDS
Model through effective-dated tax components. Vendor/customer/payment classification determines deduction rule. Store certificate/reference and reconcile withholding payable/receivable accounts. Exact rates/timing/forms must be maintained by localization rule version.

## Regulatory update process
1. monitor official NBR act/rule/SRO/form changes;
2. accounting/tax analysis;
3. create new rule/template version;
4. effective date/source link;
5. regression fixtures for old and new rules;
6. impact report for active Bangladesh entities;
7. finance/compliance approval;
8. release localization version;
9. historical transactions remain on old rule snapshot.

## NBR software enlistment readiness
NBR maintains an enlisted software-firm list. Keep statutory output samples, data dictionaries, audit/security documentation, test evidence and implementation documents organized so the company can pursue any applicable NBR enlistment/approval path. Exact current application requirements must be verified with NBR before submission.

## Acceptance
- Supported VAT forms/registers reconcile to source transactions and GL tax controls.
- New SRO/rate version does not alter historical posted tax facts.
- Bangladesh package can coexist with other-country entities in same organization.
- Localization test fixtures are reviewed by qualified Bangladesh accounting/tax professionals before production use.


---

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


---

# 22. Release Gates and Definition of Done

## Gate A — Engineering foundation
Release allowed when:
- CI is green from clean checkout.
- Database migrations apply forward on empty and representative populated databases.
- Secrets are externalized.
- Dev/staging/prod use separate credentials/data stores.
- Central error/log/health telemetry is active.
- Backup job and restore test have succeeded.

## Gate B — Tenant and security isolation
- Authorization tests cover every mutation route.
- Cross-tenant object ID probes return no data.
- Entity scope is enforced server-side.
- MFA/session policy is enforced where configured.
- Audit trail records sensitive setup/permission changes.
- Security dependency/static scans have no unresolved release-blocking findings.

## Gate C — Ledger integrity
- 100% of posting golden tests balance.
- Property tests cannot create an unbalanced POSTED journal.
- Posted journal application role cannot UPDATE/DELETE protected accounting facts.
- Duplicate source events are idempotent.
- Period close race tests pass.
- Reversal and correction tests preserve source/reversal links.
- Ledger projections rebuild exactly from journal facts.

## Gate D — Subledger reconciliation
For every enabled module:
- AR detail = AR GL control account.
- AP detail = AP GL control account.
- Bank/clearing detail = related GL control accounts.
- Tax detail = tax control accounts.
- Inventory valuation = inventory control accounts.
- Fixed asset/depreciation schedules = asset GL accounts.
Any difference is either zero or represented by an explicit, explainable reconciliation item.

## Gate E — Financial statements
- Trial Balance balances.
- Balance Sheet balances.
- P&L closes correctly into equity/retained earnings policy.
- Cash Flow reconciles beginning cash + movement = ending cash.
- Comparative/YTD calculations pass reference data sets.
- Every displayed financial amount drills to ledger/source facts.

## Gate F — Workflow and controls
- Approval thresholds and conditions pass boundary tests.
- Maker/checker/segregation rules cannot be bypassed by API.
- Delegation and escalation are audited.
- Hard-closed periods reject all source posting paths.
- Reopen requires explicit privilege/workflow.
- Payment/vendor-bank-detail high-risk flows enforce configured approval controls.

## Gate G — Concurrency and idempotency
Test concurrent:
- invoice posting;
- number allocation;
- duplicate payment callbacks;
- bank imports;
- stock issues;
- depreciation jobs;
- FX/revaluation runs;
- webhook retries.
Expected result: no duplicate posting, broken sequence ownership, negative stock outside policy, or inconsistent subledger state.

## Gate H — Performance
Define environment-specific targets before each release. At minimum test:
- high-volume journal posting;
- Trial Balance and P&L over production-scale journal lines;
- AR/AP aging;
- bank matching queue;
- inventory valuation;
- consolidation where enabled;
- bulk imports;
- API pagination.
Use representative tenant sizes; store performance baselines and regressions in CI/release evidence.

## Gate I — Migration
- Imported source control totals captured before cutover.
- Opening Trial Balance matches source totals.
- Open AR/AP reconcile.
- Bank opening balances reconcile.
- Inventory and fixed assets reconcile if enabled.
- Tax/control accounts reconcile.
- Migration exceptions are resolved or explicitly signed off.
- Cutover report is immutable/archived.

## Gate J — AI safety and quality
Before enabling an AI feature:
- Financial-effect tools are allowlisted.
- Permission and approval tests pass.
- Prompt/model/schema versions are recorded.
- Evidence/citations to system records are returned for financial Q&A.
- Adversarial document/prompt-injection test suite passes.
- Model failure has deterministic fallback.
- Evaluation thresholds are documented per feature.
- Automatic actions can be disabled globally and by tenant.

## Gate K — Localization
For each country package:
- Tax examples pass official/accountant-reviewed test cases.
- Invoice/statutory output fields match current requirements.
- Effective dates are tested across regulatory change boundaries.
- Historical transactions retain original applied tax/rule version.
- Package upgrade dry-run reports config/data impact.
- Country-specific reports reconcile to the ledger/tax subledger.

## Gate L — Production operations
- Point-in-time recovery tested.
- Disaster recovery runbook tested.
- Incident ownership/on-call defined.
- Alert thresholds defined for posting failures, outbox backlog, connector failures, reconciliation failures and database health.
- Feature rollback/disable path exists.
- Data export and tenant closure procedures exist.

# Definition of Done for Any Financial Feature
A feature is not done until it has:
1. Domain rules and validation.
2. Permission model.
3. State machine/status transitions where applicable.
4. Idempotency behavior.
5. Accounting event/posting impact or explicit statement that it is non-posting.
6. Tax/FX/period behavior where relevant.
7. Audit events.
8. API contract.
9. UI states including empty/error/loading/permission denied.
10. Events/webhooks where relevant.
11. Unit and integration tests.
12. Golden accounting tests for financial effects.
13. Concurrency tests for shared balances/sequences.
14. Reporting/reconciliation impact.
15. Migration/backfill path if schema or rules changed.
16. Documentation/changelog.
17. Observability metrics/logging.
18. Release gate evidence.


---

# 23. SaaS Platform Administration, Entitlements, Notifications and Support Operations

## Data objects
Plan, PlanVersion, Subscription, Entitlement, UsageMeter, UsageRecord, BillingCustomerReference, FeatureFlag, TenantLimit, NotificationTemplate, NotificationPreference, NotificationMessage, DeliveryAttempt, SupportAccessGrant, ImpersonationSession, MaintenanceNotice.

## Platform admin
Separate platform-superadmin capabilities from tenant accounting roles. Platform admins may manage tenancy, plan state, feature flags, technical health, support grants and account lifecycle. They do not automatically receive permission to inspect customer financial records.

Required functions:
- tenant search/status;
- suspend/reactivate tenant without deleting data;
- plan/subscription assignment;
- feature/entitlement override with audit;
- usage monitoring;
- connector/provider health;
- background job health/replay controls;
- migration/localization version visibility;
- maintenance notices;
- tenant export/closure workflow;
- security/audit search restricted by role.

## Plans and entitlements
Plan version defines enabled capabilities and limits, for example:
- number of users/entities;
- bank connections;
- storage;
- API rate/usage tier;
- AI usage;
- multi-entity/consolidation;
- advanced approvals;
- country packs;
- audit retention.

Business code checks entitlements through a centralized service; do not scatter hard-coded plan names across modules. Historical subscription changes retain version/effective dates.

## Subscription lifecycle
`TRIAL -> ACTIVE -> PAST_DUE -> RESTRICTED/SUSPENDED -> CANCELLED` according to commercial policy.

Accounting data remains intact during billing state changes. Restriction policy must explicitly define which reads/exports remain available and which new mutations are disabled. Never destroy accounting records because a SaaS subscription ends.

## Usage metering
Record immutable usage facts for billable dimensions such as AI document pages, AI actions, storage, premium connectors or API volume if monetized. Metering must be idempotent, tenant-scoped and independently reconcilable to provider billing if external billing platform is used.

## Notifications service
Channels: in-app, email, SMS/push/provider adapters as enabled.

Use cases:
- approval task;
- invoice/statement/reminder;
- payment/bank integration failure;
- close task/period deadline;
- tax workflow status;
- security login/MFA/admin changes;
- connector outage;
- migration completion;
- AI review required.

Template contains code, locale, channel, version, variables, sender policy and effective date. Delivery stores provider message ID, attempts, state and error. Financial documents sent externally must use immutable rendered version/reference where required.

## Preferences
Tenant defaults plus user/customer/vendor preferences. Transactional/security notices may be mandatory where allowed/required. Marketing preferences must remain separate from operational finance notifications.

## Support access
Support staff access to customer tenant requires:
- explicit support role;
- time-bound support grant or approved emergency process;
- reason/ticket reference;
- least privilege;
- visible audit trail;
- optional customer approval depending policy;
- automatic expiry.

If impersonation is provided, UI must visibly show impersonation state and every action records both support actor and impersonated user context. High-risk actions can be prohibited during impersonation.

## Tenant closure/export
Workflow:
1. verify authorized owner;
2. stop new billing/renewal according to commercial policy;
3. generate export request;
4. preserve required retention/legal-hold data;
5. revoke integrations/tokens;
6. schedule deletion/anonymization only according to policy/legal requirements;
7. audit completion.

## Acceptance
- Plan downgrade cannot cause silent deletion or corruption of financial records.
- Entitlement checks are enforced server-side.
- Notification retries do not send uncontrolled duplicates where provider supports idempotency.
- Support impersonation is time-bound and fully audited.
- Tenant suspension does not break backups, legal retention or authorized exports.


---

# 24. Optional Enterprise / ERP Extensions

These extensions use the existing accounting kernel, tax engine, approvals, dimensions, documents, audit, APIs and events. None writes posted journals directly.

## Payroll
Data: employee/payee reference, pay group, payroll period, earning/deduction/tax components, employer cost, net pay, payroll run, payment file, clearing/reconciliation.

Flow:
`approved payroll inputs -> payroll calculation/provider import -> validation -> payroll register -> approval -> accounting event -> GL -> payment/clearing -> reconciliation`.

Posting template:
- Dr Salary/Wage Expense and employer cost accounts;
- Cr tax/deduction/payroll liabilities;
- Cr payroll clearing/net payable;
- payment clears payroll liability/clearing to bank.

Keep country payroll calculation in payroll/localization adapters; global GL receives normalized accounting events.

## Subscription and usage billing
- product plans/price books;
- customer subscriptions;
- fixed/usage/tiered billing;
- usage ingestion and dedup;
- proration;
- recurring invoice generation;
- credits/refunds;
- contract dates;
- deferred revenue schedule integration.

## Advanced revenue recognition
Data: performance obligation, contract line, recognition method, schedule, modification, catch-up adjustment.

Methods supported by policy: point-in-time, straight-line/time-based, milestone, usage/output based, custom approved schedule. Billing and revenue recognition remain separate. Schedule posts Dr Deferred Revenue / Cr Revenue or other configured treatment.

## Treasury and payment initiation
- cash position by entity/currency/bank;
- short-term cash forecast;
- payment proposal;
- bank account/beneficiary validation;
- dual approval;
- payment file/API submission;
- provider status;
- bank reconciliation;
- liquidity concentration/sweep suggestions.

Bank-detail changes and payment execution are high-risk actions with strong approval/MFA/SoD controls.

## Corporate spend / cards
- cardholder/card/token references;
- spend limits/policies;
- merchant/category controls where provider supports;
- authorization/feed ingestion;
- receipt collection;
- expense coding/approval;
- card statement reconciliation;
- reimbursement vs company-card distinction.

## Manufacturing / MRP accounting
- BOM and routing references;
- production order;
- raw-material issue;
- WIP;
- labor/overhead absorption;
- finished-goods receipt;
- scrap;
- standard/actual cost variances;
- inventory and WIP reconciliation.

Posting effects derive from valuation/cost policy and remain traceable to production order.

## POS
- store/register/session;
- item/tax/discount;
- tender types;
- cash drawer;
- card/payment clearing;
- returns;
- end-of-day close;
- summarized or detailed accounting event configuration;
- inventory integration.

## FP&A
- driver-based planning;
- versions/scenarios;
- workforce/revenue/expense/capex assumptions;
- rolling forecast;
- cash forecast;
- entity/dimension planning;
- actual-vs-budget/forecast;
- approvals;
- scenario snapshots.
Actuals always come from posted finance facts.

## Tax filing connectors
Adapter receives finalized tax-return snapshot, validates required filing schema, submits through approved authority/provider interface, records receipt/reference/status and retains payload/response evidence. Filing cannot mutate the underlying posted tax transactions.

## Acceptance
Each extension must define:
- source lifecycle/state machine;
- permissions/approval;
- accounting events/posting rules;
- tax/FX behavior;
- reconciliation to GL/control accounts;
- API/events/webhooks;
- audit/evidence;
- migration/import;
- performance and concurrency tests;
- release gate suite.


---

# 98. Reference Benchmarks and Regulatory Sources

Use these only as benchmark/reference inputs. Implement against the platform specifications and validate current statutory requirements before production country releases.

## Product capability references
- Xero accounting features: https://www.xero.com/us/accounting-software/all-features/
- Sage Intacct dimensional accounting/reporting: https://www.sage.com/en-us/sage-business-cloud/intacct/product-capabilities/extended-capabilities/financial-reporting/multi-dimensional-system/
- NetSuite Multi-Book Accounting: https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_3831567542.html
- Odoo accounting/localization: https://www.odoo.com/documentation/18.0/applications/finance/fiscal_localizations.html
- Zoho Books features: https://www.zoho.com/in/books/accounting-software-features/

## Bangladesh VAT/NBR references
- NBR VAT forms listing: https://nbr.gov.bd/form/vat/vat-2012/
- NBR VAT compliance guides: https://nbr.gov.bd/taxtypes/vat-compliance-guides/
- NBR VAT SRO page: https://nbr.gov.bd/regulations/sros/vat-sros/
- NBR enlisted software firms page/listing: https://nbr.gov.bd/uploads/public-notice/Enlisted_Software_Firms.pdf

## Review rule
- Regulatory/localization tickets must attach the official source used, publication/effective date, accountant/legal review where required, affected rule version and test cases.
- Never overwrite a historical tax calculation because a current rate/rule changed.


---

# Blueprint: Posting Rule Catalog

# Posting Rule Catalog

All rules are templates. Concrete account IDs come from the entity/book accounting policy and installed localization. Rules are versioned and effective-dated. Every posting is generated by the posting service and validated before commit.

## Sales / AR

### SALES_INVOICE_POSTED
- Dr Accounts Receivable — gross invoice amount.
- Cr Revenue — net taxable/exempt revenue by configured revenue account/dimensions.
- Cr Output Tax Payable — output tax by tax component.
- If inventory item is fulfilled and perpetual inventory is enabled, emit a separate inventory cost event.

### SALES_INVOICE_INVENTORY_COST
- Dr Cost of Goods Sold.
- Cr Inventory.
- Amount comes from inventory valuation engine, not invoice selling price.

### CUSTOMER_RECEIPT
- Dr Bank/Cash/Payment Clearing.
- Cr Accounts Receivable for allocated amount.
- Cr Customer Advances/Unapplied Receipts for unapplied amount where policy requires.

### CUSTOMER_ADVANCE_APPLIED
- Dr Customer Advances/Unapplied Receipts.
- Cr Accounts Receivable.

### SALES_CREDIT_NOTE
- Dr Sales Returns/Revenue Reversal.
- Dr Output Tax Payable for tax reversal where applicable.
- Cr Accounts Receivable / Customer Credit.
- Inventory return, if any, posts through inventory valuation event.

### CUSTOMER_REFUND
- Dr Customer Credit/Accounts Receivable/Advance liability according to source balance.
- Cr Bank/Cash.

### AR_BAD_DEBT_WRITE_OFF
- Dr Bad Debt Expense or Allowance.
- Cr Accounts Receivable.
- Tax adjustment, if permitted/required, is a separate tax component under localization rules.

## Procurement / AP

### VENDOR_BILL_POSTED
- Dr Expense, Inventory, Asset, Prepaid or other destination account by line.
- Dr Recoverable Input Tax for recoverable tax.
- Dr Non-Recoverable Tax destination when policy capitalizes/expenses it.
- Cr Accounts Payable — gross payable.

### VENDOR_PAYMENT
- Dr Accounts Payable for allocated amount.
- Cr Bank/Cash/Payment Clearing.
- Vendor advance behavior uses configured advance account.

### VENDOR_ADVANCE
- Dr Vendor Advances/Prepayments.
- Cr Bank/Cash/Payment Clearing.

### VENDOR_ADVANCE_APPLIED
- Dr Accounts Payable.
- Cr Vendor Advances/Prepayments.

### VENDOR_CREDIT
- Dr Accounts Payable / Vendor Credit.
- Cr Expense/Inventory/Asset reversal.
- Cr Recoverable Input Tax reversal where applicable.

### EXPENSE_CLAIM_POSTED
- Dr Expense/Asset/Tax accounts from approved lines.
- Cr Employee Reimbursement Payable or clearing account.

### EXPENSE_REIMBURSED
- Dr Employee Reimbursement Payable.
- Cr Bank/Cash.

## Banking / Cash

### BANK_FEE
- Dr Bank Fee Expense.
- Cr Bank.

### BANK_INTEREST_INCOME
- Dr Bank.
- Cr Interest Income.

### BANK_INTEREST_EXPENSE
- Dr Interest Expense.
- Cr Bank.

### INTERNAL_BANK_TRANSFER
Source side:
- Dr Transfer Clearing.
- Cr Source Bank.
Destination side:
- Dr Destination Bank.
- Cr Transfer Clearing.
Use linked paired events; clearing must reconcile to zero after both sides post.

### PAYMENT_PROCESSOR_SALE
- Dr Processor Clearing — gross receivable from processor.
- Cr Revenue/AR settlement account as defined by source integration.

### PAYMENT_PROCESSOR_SETTLEMENT
- Dr Bank — net settlement.
- Dr Processing Fee Expense — fees/charges.
- Dr/Cr explicit adjustments where supported.
- Cr Processor Clearing — gross settlement cleared.

## Inventory

### INVENTORY_RECEIPT_AGAINST_PO
- Dr Inventory.
- Cr GRNI / Received-Not-Invoiced.

### INVENTORY_BILL_MATCHED_TO_RECEIPT
- Dr GRNI.
- Dr/Cr Purchase Price Variance where policy requires.
- Dr Recoverable Input Tax.
- Cr Accounts Payable.

### INVENTORY_ISSUE_FOR_SALE
- Dr Cost of Goods Sold.
- Cr Inventory.

### INVENTORY_CUSTOMER_RETURN
- Dr Inventory at supported return cost.
- Cr Cost of Goods Sold / Return Cost account.

### INVENTORY_VENDOR_RETURN
- Dr GRNI/AP/vendor-credit clearing according to document state.
- Cr Inventory.

### INVENTORY_WRITE_OFF
- Dr Inventory Loss/Shrinkage Expense.
- Cr Inventory.

### INVENTORY_GAIN
- Dr Inventory.
- Cr Inventory Gain/Adjustment Income.

### LANDED_COST_CAPITALIZED
- Dr Inventory cost layers/items receiving allocation.
- Cr Landed Cost Clearing / AP according to source.

## Fixed Assets

### ASSET_ACQUIRED
- Dr Fixed Asset Cost.
- Dr Recoverable Input Tax where applicable.
- Cr AP/Bank/Asset Clearing.

### ASSET_CAPITALIZED_FROM_CIP
- Dr Fixed Asset Cost.
- Cr Construction/Capital Work in Progress.

### ASSET_DEPRECIATION
- Dr Depreciation Expense.
- Cr Accumulated Depreciation.

### ASSET_IMPAIRMENT
- Dr Impairment Loss.
- Cr Accumulated Impairment or Asset Cost per book policy.

### ASSET_REVALUATION
- Dr/Cr Asset Cost or Revaluation account.
- Counter-entry to Revaluation Surplus or P&L according to book/local rule.

### ASSET_DISPOSAL
- Dr Cash/AR for proceeds.
- Dr Accumulated Depreciation.
- Dr/Cr Gain or Loss on Disposal for balancing result.
- Cr Fixed Asset Cost.
- Tax components added by tax engine if applicable.

## Accruals, Prepaids and Revenue Schedules

### EXPENSE_ACCRUAL
- Dr Expense.
- Cr Accrued Liability.

### EXPENSE_ACCRUAL_REVERSAL
- Dr Accrued Liability.
- Cr Expense.

### PREPAID_PURCHASE
- Dr Prepaid Asset.
- Cr AP/Bank.

### PREPAID_AMORTIZATION
- Dr Expense.
- Cr Prepaid Asset.

### DEFERRED_REVENUE_BILLING
- Dr AR/Bank.
- Cr Deferred Revenue.

### REVENUE_RECOGNIZED
- Dr Deferred Revenue.
- Cr Revenue.

## Foreign Currency

### REALIZED_FX_ON_SETTLEMENT
- Settlement clears original receivable/payable using historical carrying amount.
- Bank/clearing uses settlement-date amount/rate.
- Difference posts Dr/Cr Realized FX Gain/Loss.

### UNREALIZED_FX_REMEASUREMENT
- Dr/Cr monetary asset/liability adjustment.
- Counter-entry Dr/Cr Unrealized FX Gain/Loss.
- Run stores original carrying amount, closing rate and delta.
- Reversal policy is controlled by accounting book settings.

## Intercompany / Consolidation

### INTERCOMPANY_CHARGE_SELLER
- Dr Intercompany Receivable.
- Cr Revenue/Cost Recovery.
- Tax if applicable by local entity rules.

### INTERCOMPANY_CHARGE_BUYER
- Dr Expense/Asset.
- Cr Intercompany Payable.
- Tax if applicable by local entity rules.

### INTERCOMPANY_SETTLEMENT
- Dr Intercompany Payable / Cr Bank on payer.
- Dr Bank / Cr Intercompany Receivable on receiver.

### CONSOLIDATION_ELIMINATION
- Debit/credit mapped group accounts according to elimination definition.
- Must exist only in consolidation book/layer unless explicitly configured otherwise.
- Always references source entity balances/transactions used for elimination.

## Equity / Opening / Close

### OPENING_BALANCE
- Posts validated opening account balances against opening equity/retained earnings/suspense according to cutover policy.
- Detailed AR/AP/inventory/assets are loaded to subledgers and must reconcile to control accounts.

### PERIOD_CLOSE_PNL_TRANSFER
- Only if book policy requires explicit closing journals.
- Close income/expense accounts to retained earnings/current-year earnings.
- Must be reversible/reproducible by period-close run.

## Rounding

### ROUNDING_ADJUSTMENT
- Only generated when policy permits a defined currency/tax/FX rounding tolerance.
- Posts to configured Rounding Gain/Loss account.
- Posting service records the originating calculation and exact delta.
- Never use rounding to hide an unexplained imbalance.
