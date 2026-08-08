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
