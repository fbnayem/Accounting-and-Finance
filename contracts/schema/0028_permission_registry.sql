-- =============================================================================
-- 0028 — Permission registry seed (GENERATED — pnpm contracts:permissions)
-- =============================================================================
-- ADR-0005 §3 / F-016 / F-207. Rows are derived from x-permission and
-- x-additional-permissions in contracts/openapi.yaml. Do not hand-edit: contract
-- check 13 compares this seed against the contract and fails on any difference.
--
-- 8 permission(s), 3 of them high-risk.
-- =============================================================================

INSERT INTO permissions (code, resource, action, description, is_high_risk, requires_reauth, min_phase) VALUES
  ('journal_definition.manage', 'journal_definition', 'manage', 'Routes: POST /journal-definitions', false, false, 2),
  ('journal_definition.view', 'journal_definition', 'view', 'Routes: GET /journal-definitions', false, false, 2),
  ('journal.edit', 'journal', 'edit', 'Routes: DELETE /journals/{id}, PATCH /journals/{id}', false, false, 2),
  ('ledger.rebuild', 'ledger', 'rebuild', 'Routes: POST /ledger/projections/rebuild', true, true, 2),
  ('opening_balance.manage', 'opening_balance', 'manage', 'Routes: POST /opening-balances, POST /opening-balances/{id}/post', true, true, 2),
  ('opening_balance.view', 'opening_balance', 'view', 'Routes: GET /opening-balances', false, false, 2),
  ('posting_rule.manage', 'posting_rule', 'manage', 'Routes: POST /posting-rules', true, true, 2),
  ('posting_rule.view', 'posting_rule', 'view', 'Routes: GET /posting-rules', false, false, 2);
