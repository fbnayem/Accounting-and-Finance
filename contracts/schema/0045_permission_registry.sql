-- =============================================================================
-- 0045 — Permission registry (GENERATED — pnpm contracts:permissions)
-- =============================================================================
-- ADR-0005 §3 / F-016 / F-207. Rows are derived from x-permission and
-- x-additional-permissions in contracts/openapi.yaml. Do not hand-edit: the
-- contract check compares this seed against the contract and fails on any
-- difference.
--
-- 0 new permission(s), 0 of them high-risk.
-- 0 description(s) restated because a later phase added routes.
-- 2 risk reclassification(s).
-- =============================================================================

-- RISK RECLASSIFICATION. Its own section, deliberately: a change of
-- is_high_risk changes who may hold the permission and whether holding it
-- demands re-authentication, so it is a permission decision and reads as one
-- here rather than being folded in beside a text update.
--
-- requires_reauth follows is_high_risk (ADR-0005 §3) and is set with it.
-- inventory.post: high-risk -> ordinary
UPDATE permissions SET is_high_risk = false, requires_reauth = false
 WHERE code = 'inventory.post';
-- inventory.reverse: high-risk -> ordinary
UPDATE permissions SET is_high_risk = false, requires_reauth = false
 WHERE code = 'inventory.reverse';
