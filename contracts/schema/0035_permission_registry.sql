-- =============================================================================
-- 0035 — Permission registry (GENERATED — pnpm contracts:permissions)
-- =============================================================================
-- ADR-0005 §3 / F-016 / F-207. Rows are derived from x-permission and
-- x-additional-permissions in contracts/openapi.yaml. Do not hand-edit: the
-- contract check compares this seed against the contract and fails on any
-- difference.
--
-- 17 new permission(s), 0 of them high-risk.
-- 4 description(s) restated because a later phase added routes.
-- =============================================================================

INSERT INTO permissions (code, resource, action, description, is_high_risk, requires_reauth, min_phase) VALUES
  ('credit_note.apply', 'credit_note', 'apply', 'Routes: POST /credit-notes/{id}/apply', false, false, 3),
  ('credit_note.post', 'credit_note', 'post', 'Routes: POST /credit-notes/{id}/post', false, false, 3),
  ('customer.edit', 'customer', 'edit', 'Routes: PATCH /customers/{id}', false, false, 3),
  ('expense_claim.approve', 'expense_claim', 'approve', 'Routes: POST /expense-claims/{id}/approve', false, false, 3),
  ('expense_claim.post', 'expense_claim', 'post', 'Routes: POST /expense-claims/{id}/post', false, false, 3),
  ('expense_claim.submit', 'expense_claim', 'submit', 'Routes: POST /expense-claims/{id}/submit', false, false, 3),
  ('goods_receipt.post', 'goods_receipt', 'post', 'Routes: POST /goods-receipts/{id}/post', false, false, 3),
  ('payment_hold.manage', 'payment_hold', 'manage', 'Routes: POST /payment-holds, POST /payment-holds/{id}/release', false, false, 3),
  ('payment_hold.view', 'payment_hold', 'view', 'Routes: GET /payment-holds', false, false, 3),
  ('purchase_requisition.approve', 'purchase_requisition', 'approve', 'Routes: POST /purchase-requisitions/{id}/approve', false, false, 3),
  ('sales_order.confirm', 'sales_order', 'confirm', 'Routes: POST /sales-orders/{id}/confirm', false, false, 3),
  ('tax_period.manage', 'tax_period', 'manage', 'Routes: POST /tax-periods, POST /tax-periods/{id}/close', false, false, 3),
  ('tax_period.view', 'tax_period', 'view', 'Routes: GET /tax-periods', false, false, 3),
  ('vendor_credit.apply', 'vendor_credit', 'apply', 'Routes: POST /vendor-credits/{id}/apply', false, false, 3),
  ('vendor_credit.post', 'vendor_credit', 'post', 'Routes: POST /vendor-credits/{id}/post', false, false, 3),
  ('vendor_payment.confirm', 'vendor_payment', 'confirm', 'Routes: POST /vendor-payments/{id}/confirm', false, false, 3),
  ('vendor.edit', 'vendor', 'edit', 'Routes: PATCH /vendors/{id}', false, false, 3);

-- Descriptions only. is_high_risk, requires_reauth and min_phase are NOT touched
-- here: those are security-bearing, and a change to one is a new permission
-- decision that should be visible as such rather than folded into a text update.
UPDATE permissions SET description = 'Routes: GET /customers, GET /customers/{id}, GET /customers/{id}/statement'
 WHERE code = 'customer.view';
UPDATE permissions SET description = 'Routes: GET /files/{id}, GET /files/{id}/download-url'
 WHERE code = 'file.view';
UPDATE permissions SET description = 'Routes: POST /quotes/{id}/accept, POST /quotes/{id}/convert'
 WHERE code = 'quote.edit';
UPDATE permissions SET description = 'Routes: GET /vendors, GET /vendors/{id}'
 WHERE code = 'vendor.view';
