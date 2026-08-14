-- =============================================================================
-- 0044 — Permission registry (GENERATED — pnpm contracts:permissions)
-- =============================================================================
-- ADR-0005 §3 / F-016 / F-207. Rows are derived from x-permission and
-- x-additional-permissions in contracts/openapi.yaml. Do not hand-edit: the
-- contract check compares this seed against the contract and fails on any
-- difference.
--
-- 1 new permission(s), 1 of them high-risk.
-- 1 description(s) restated because a later phase added routes.
-- =============================================================================

INSERT INTO permissions (code, resource, action, description, is_high_risk, requires_reauth, min_phase) VALUES
  ('inventory.reverse', 'inventory', 'reverse', 'Routes: POST /inventory/documents/{id}/reverse', true, true, 5);

-- Descriptions only. is_high_risk, requires_reauth and min_phase are NOT touched
-- here: those are security-bearing, and a change to one is a new permission
-- decision that should be visible as such rather than folded into a text update.
UPDATE permissions SET description = 'Routes: POST /inventory/documents/{id}/post'
 WHERE code = 'inventory.post';
