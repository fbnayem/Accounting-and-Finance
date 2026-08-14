-- =============================================================================
-- 0039 — Permission registry (GENERATED — pnpm contracts:permissions)
-- =============================================================================
-- ADR-0005 §3 / F-016 / F-207. Rows are derived from x-permission and
-- x-additional-permissions in contracts/openapi.yaml. Do not hand-edit: the
-- contract check compares this seed against the contract and fails on any
-- difference.
--
-- 2 new permission(s), 1 of them high-risk.
-- 2 description(s) restated because a later phase added routes.
-- =============================================================================

INSERT INTO permissions (code, resource, action, description, is_high_risk, requires_reauth, min_phase) VALUES
  ('settlement.manage', 'settlement', 'manage', 'Routes: POST /clearing-items/{id}/chargeback, POST /settlement-batches, POST /settlement-batches/{id}/reconcile', true, true, 4),
  ('settlement.view', 'settlement', 'view', 'Routes: GET /clearing-items, GET /settlement-batches', false, false, 4);

-- Descriptions only. is_high_risk, requires_reauth and min_phase are NOT touched
-- here: those are security-bearing, and a change to one is a new permission
-- decision that should be visible as such rather than folded into a text update.
UPDATE permissions SET description = 'Routes: POST /bank-rules, DELETE /bank-rules/{id}, PATCH /bank-rules/{id}'
 WHERE code = 'bank_rule.manage';
UPDATE permissions SET description = 'Routes: GET /bank-transactions, GET /bank-transactions/{id}/matches, GET /cash-position +1 more'
 WHERE code = 'bank.view';
