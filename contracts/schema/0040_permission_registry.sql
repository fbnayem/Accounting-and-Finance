-- =============================================================================
-- 0040 — Permission registry (GENERATED — pnpm contracts:permissions)
-- =============================================================================
-- ADR-0005 §3 / F-016 / F-207. Rows are derived from x-permission and
-- x-additional-permissions in contracts/openapi.yaml. Do not hand-edit: the
-- contract check compares this seed against the contract and fails on any
-- difference.
--
-- 0 new permission(s), 0 of them high-risk.
-- 1 description(s) restated because a later phase added routes.
-- =============================================================================

-- Descriptions only. is_high_risk, requires_reauth and min_phase are NOT touched
-- here: those are security-bearing, and a change to one is a new permission
-- decision that should be visible as such rather than folded into a text update.
UPDATE permissions SET description = 'Routes: POST /bank-reconciliations, GET /bank-reconciliations, GET /bank-reconciliations/{id} +2 more'
 WHERE code = 'bank.reconcile';
