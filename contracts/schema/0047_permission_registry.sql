-- =============================================================================
-- 0047 — Permission registry (GENERATED — pnpm contracts:permissions)
-- =============================================================================
-- ADR-0005 §3 / F-016 / F-207. Rows are derived from x-permission and
-- x-additional-permissions in contracts/openapi.yaml. Do not hand-edit: the
-- contract check compares this seed against the contract and fails on any
-- difference.
--
-- 1 new permission(s), 0 of them high-risk.
-- 0 description(s) restated because a later phase added routes.
-- 0 risk reclassification(s).
-- =============================================================================

INSERT INTO permissions (code, resource, action, description, is_high_risk, requires_reauth, min_phase) VALUES
  ('purchase_order.close', 'purchase_order', 'close', 'Routes: POST /purchase-orders/{id}/close', false, false, 3);

