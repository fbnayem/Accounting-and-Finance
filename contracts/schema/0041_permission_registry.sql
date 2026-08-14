-- =============================================================================
-- 0041 — Permission registry (GENERATED — pnpm contracts:permissions)
-- =============================================================================
-- ADR-0005 §3 / F-016 / F-207. Rows are derived from x-permission and
-- x-additional-permissions in contracts/openapi.yaml. Do not hand-edit: the
-- contract check compares this seed against the contract and fails on any
-- difference.
--
-- 5 new permission(s), 1 of them high-risk.
-- 8 description(s) restated because a later phase added routes.
-- =============================================================================

INSERT INTO permissions (code, resource, action, description, is_high_risk, requires_reauth, min_phase) VALUES
  ('asset_category.manage', 'asset_category', 'manage', 'Routes: POST /asset-categories', false, false, 5),
  ('asset_category.view', 'asset_category', 'view', 'Routes: GET /asset-categories', false, false, 5),
  ('inventory.count_approve', 'inventory', 'count_approve', 'Routes: POST /inventory/counts/{id}/approve', false, false, 5),
  ('inventory.post', 'inventory', 'post', 'Routes: POST /inventory/documents/{id}/post, POST /inventory/documents/{id}/reverse', true, true, 5),
  ('item.manage', 'item', 'manage', 'Routes: PATCH /items/{id}', false, false, 5);

-- Descriptions only. is_high_risk, requires_reauth and min_phase are NOT touched
-- here: those are security-bearing, and a change to one is a new permission
-- decision that should be visible as such rather than folded into a text update.
UPDATE permissions SET description = 'Routes: POST /assets, POST /assets/{id}/books'
 WHERE code = 'asset.create';
UPDATE permissions SET description = 'Routes: GET /assets, GET /assets/{id}, GET /assets/{id}/schedule'
 WHERE code = 'asset.view';
UPDATE permissions SET description = 'Routes: POST /inventory/counts, PATCH /inventory/counts/{id}'
 WHERE code = 'inventory.count';
UPDATE permissions SET description = 'Routes: POST /inventory/receipts, POST /inventory/returns'
 WHERE code = 'inventory.receive';
UPDATE permissions SET description = 'Routes: GET /inventory/documents, GET /inventory/documents/{id}, GET /inventory/movements/{id}/cost-breakdown +2 more'
 WHERE code = 'inventory.view';
UPDATE permissions SET description = 'Routes: GET /financial-statement-snapshots, GET /report-definitions, GET /report-runs +14 more'
 WHERE code = 'report.view';
UPDATE permissions SET description = 'Routes: POST /warehouses, POST /warehouses/{id}/locations'
 WHERE code = 'warehouse.create';
UPDATE permissions SET description = 'Routes: GET /warehouses, GET /warehouses/{id}/locations'
 WHERE code = 'warehouse.view';
