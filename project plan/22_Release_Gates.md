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
