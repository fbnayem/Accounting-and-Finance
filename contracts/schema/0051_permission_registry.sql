-- =============================================================================
-- 0051 — Permission registry (GENERATED — pnpm contracts:permissions)
-- =============================================================================
-- ADR-0005 §3 / F-016 / F-207. Rows are derived from x-permission and
-- x-additional-permissions in contracts/openapi.yaml. Do not hand-edit: the
-- contract check compares this seed against the contract and fails on any
-- difference.
--
-- 6 new permission(s), 1 of them high-risk.
-- 2 description(s) restated because a later phase added routes.
-- 0 risk reclassification(s).
-- =============================================================================

INSERT INTO permissions (code, resource, action, description, is_high_risk, requires_reauth, min_phase) VALUES
  ('close.reopen', 'close', 'reopen', 'Routes: POST /close-runs/{id}/reopen', true, true, 6),
  ('financial_statement.approve', 'financial_statement', 'approve', 'Routes: POST /financial-statement-snapshots/{id}/approve', false, false, 6),
  ('period_end_entry.create', 'period_end_entry', 'create', 'Routes: POST /period-end-entries', false, false, 6),
  ('period_end_entry.recognize', 'period_end_entry', 'recognize', 'Routes: POST /period-end-entries/{id}/recognize', false, false, 6),
  ('period_end_entry.view', 'period_end_entry', 'view', 'Routes: GET /period-end-entries, GET /period-end-entries/{id}', false, false, 6),
  ('report.drill_down', 'report', 'drill_down', 'Routes: GET /reports/drill-down', false, false, 6);

-- Descriptions only. is_high_risk, requires_reauth and min_phase are NOT touched
-- here: those are security-bearing, and a change to one is a new permission
-- decision that should be visible as such rather than folded into a text update.
UPDATE permissions SET description = 'Routes: POST /account-reconciliations, POST /account-reconciliations/{id}/reconciling-items, POST /reconciling-items/{id}/resolve'
 WHERE code = 'reconciliation.manage';
UPDATE permissions SET description = 'Routes: GET /account-reconciliations, GET /account-reconciliations/{id}/reconciling-items'
 WHERE code = 'reconciliation.view';
