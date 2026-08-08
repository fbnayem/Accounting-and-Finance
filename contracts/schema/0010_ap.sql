-- =============================================================================
-- 0010 — Accounts Payable, procurement and expenses
-- =============================================================================
-- Phase 3. Resolves F-020 (S1: the unique constraint made the spec'd duplicate
-- override workflow impossible), F-019/F-022/F-023/F-027 as for AR, and
-- ADR-0007 (vendor_payments split from the generic payments table).
-- =============================================================================

CREATE TABLE purchase_requisitions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL,
  branch_id       uuid REFERENCES branches(id),
  requisition_number text,
  requester_id    uuid NOT NULL REFERENCES users(id),
  business_reason text,
  suggested_vendor_id uuid,
  required_date   date,
  currency        char(3) NOT NULL REFERENCES currencies(code),
  estimated_total numeric(24,8) NOT NULL DEFAULT 0,
  status          requisition_status NOT NULL DEFAULT 'DRAFT',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, requisition_number),
  CONSTRAINT pr_entity_scope_fk FOREIGN KEY (legal_entity_id, tenant_id) REFERENCES legal_entities(id, tenant_id),
  CONSTRAINT pr_scope_uq UNIQUE (id, legal_entity_id)
);

CREATE TABLE purchase_requisition_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requisition_id    uuid NOT NULL REFERENCES purchase_requisitions(id) ON DELETE RESTRICT,
  line_no           integer NOT NULL,
  item_id           uuid,
  description       text NOT NULL,
  quantity          numeric(24,8) NOT NULL DEFAULT 1,
  estimated_price   numeric(24,8) NOT NULL DEFAULT 0,
  UNIQUE (requisition_id, line_no)
);

CREATE TABLE purchase_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL,
  branch_id       uuid REFERENCES branches(id),
  vendor_id       uuid NOT NULL,
  requisition_id  uuid REFERENCES purchase_requisitions(id),
  po_number       text,
  revision        integer NOT NULL DEFAULT 0,        -- doc 05: change order history
  document_date   date NOT NULL,
  expected_date   date,
  currency        char(3) NOT NULL REFERENCES currencies(code),
  exchange_rate   numeric(28,12),
  status          po_status NOT NULL DEFAULT 'DRAFT',
  subtotal        numeric(24,8) NOT NULL DEFAULT 0,
  tax_total       numeric(24,8) NOT NULL DEFAULT 0,
  total           numeric(24,8) NOT NULL DEFAULT 0,
  issued_at       timestamptz,
  closed_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, po_number, revision),
  CONSTRAINT po_entity_scope_fk FOREIGN KEY (legal_entity_id, tenant_id) REFERENCES legal_entities(id, tenant_id),
  CONSTRAINT po_vendor_fk FOREIGN KEY (vendor_id, tenant_id) REFERENCES contacts(id, tenant_id),
  CONSTRAINT po_scope_uq UNIQUE (id, legal_entity_id)
);

CREATE TABLE purchase_order_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id     uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE RESTRICT,
  legal_entity_id       uuid NOT NULL,
  line_no               integer NOT NULL,
  item_id               uuid,
  description           text NOT NULL,
  quantity_ordered      numeric(24,8) NOT NULL,
  quantity_received     numeric(24,8) NOT NULL DEFAULT 0,
  quantity_billed       numeric(24,8) NOT NULL DEFAULT 0,
  uom                   text,
  unit_price            numeric(24,8) NOT NULL DEFAULT 0,
  destination_account_id uuid,
  tax_code_id           uuid,
  net_amount            numeric(24,8) NOT NULL,
  tax_amount            numeric(24,8) NOT NULL DEFAULT 0,
  gross_amount          numeric(24,8) NOT NULL,
  UNIQUE (purchase_order_id, line_no),
  CHECK (quantity_received >= 0 AND quantity_billed >= 0),
  CONSTRAINT pol_account_fk FOREIGN KEY (destination_account_id, legal_entity_id) REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT pol_scope_uq UNIQUE (id, legal_entity_id)
);

-- doc 05: service receipt for non-stock services; goods receipts are inventory
-- documents (0012) so physical receipt and vendor invoice timing stay separate.
CREATE TABLE service_receipts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id   uuid NOT NULL,
  purchase_order_id uuid REFERENCES purchase_orders(id),
  receipt_number    text,
  receipt_date      date NOT NULL,
  accepted_by       uuid REFERENCES users(id),
  notes             text,
  status            document_status NOT NULL DEFAULT 'DRAFT',
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sr_entity_scope_fk FOREIGN KEY (legal_entity_id, tenant_id) REFERENCES legal_entities(id, tenant_id)
);

-- ----------------------------------------------------------------------------
-- Vendor bills — F-020 (S1).
-- The blueprint had UNIQUE (legal_entity_id, vendor_id, vendor_invoice_number),
-- which made doc 05's "override requires permission and reason" IMPOSSIBLE — the
-- insert failed at the database regardless of permission. Vendors reissue numbers
-- across years, number per branch, and occasionally share a reference between
-- credit and debit documents.
--
-- Detection moves to the service layer (409 DUPLICATE_SUSPECTED with the matching
-- bill IDs, overridable with a reason and an audit event). A PARTIAL unique index
-- still blocks the unambiguous accidental double-entry.
-- ----------------------------------------------------------------------------
CREATE TABLE vendor_bills (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id       uuid NOT NULL,
  accounting_book_id    uuid NOT NULL,                    -- F-019
  branch_id             uuid REFERENCES branches(id),     -- F-019
  vendor_id             uuid NOT NULL,
  purchase_order_id     uuid REFERENCES purchase_orders(id),
  project_id            uuid,
  vendor_invoice_number text NOT NULL,
  internal_number       text,
  document_date         date NOT NULL,                    -- F-019
  posting_date          date NOT NULL,                    -- F-019
  due_date              date,
  currency              char(3) NOT NULL REFERENCES currencies(code),
  exchange_rate         numeric(28,12),
  exchange_rate_date    date,
  exchange_rate_source  text,
  status                document_status NOT NULL DEFAULT 'DRAFT',
  approval_state        approval_status NOT NULL DEFAULT 'NOT_REQUIRED',
  match_state           bill_match_status NOT NULL DEFAULT 'UNMATCHED',
  subtotal              numeric(24,8) NOT NULL DEFAULT 0,
  tax_total             numeric(24,8) NOT NULL DEFAULT 0,
  rounding_adjustment   numeric(24,8) NOT NULL DEFAULT 0,
  total                 numeric(24,8) NOT NULL DEFAULT 0,
  base_total            numeric(24,8) NOT NULL DEFAULT 0,
  amount_paid           numeric(24,8) NOT NULL DEFAULT 0,
  amount_due            numeric(24,8) NOT NULL DEFAULT 0,
  accounting_entry_id   uuid REFERENCES journal_entries(id),
  -- doc 05 duplicate signals: exact number, normalised number, vendor/date/amount,
  -- and file hash. Stored so detection is reproducible and auditable.
  normalized_invoice_number text,
  source_document_hash  text,
  duplicate_override_by uuid REFERENCES users(id),
  duplicate_override_reason text,
  on_hold               boolean NOT NULL DEFAULT false,
  hold_reason           text,
  version               bigint NOT NULL DEFAULT 1,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bills_paid_nonneg  CHECK (amount_paid >= 0),
  CONSTRAINT bills_paid_bounded CHECK (amount_paid <= total),
  CONSTRAINT bills_due_derived  CHECK (amount_due = total - amount_paid),
  -- An override must record who and why (doc 05).
  CONSTRAINT bills_override_has_reason
    CHECK ((duplicate_override_by IS NULL) = (duplicate_override_reason IS NULL)),
  CONSTRAINT bills_book_scope_fk FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id),
  CONSTRAINT bills_vendor_fk FOREIGN KEY (vendor_id, tenant_id) REFERENCES contacts(id, tenant_id),
  CONSTRAINT bills_scope_uq UNIQUE (id, legal_entity_id)
);
-- F-020: blocks the unambiguous accidental double-entry only; an explicit
-- override with a recorded reason is permitted, as doc 05 requires.
CREATE UNIQUE INDEX vendor_bills_exact_duplicate_idx
  ON vendor_bills(legal_entity_id, vendor_id, vendor_invoice_number, document_date, total)
  WHERE duplicate_override_by IS NULL;
CREATE INDEX vendor_bills_dup_signals_idx ON vendor_bills(legal_entity_id, vendor_id, normalized_invoice_number);
CREATE INDEX vendor_bills_hash_idx ON vendor_bills(legal_entity_id, source_document_hash) WHERE source_document_hash IS NOT NULL;
CREATE INDEX vendor_bills_open_idx ON vendor_bills(legal_entity_id, due_date)
  WHERE status IN ('POSTED','PARTIALLY_PAID');

CREATE TABLE vendor_bill_lines (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_bill_id         uuid NOT NULL REFERENCES vendor_bills(id) ON DELETE RESTRICT,   -- F-023
  legal_entity_id        uuid NOT NULL,
  line_no                integer NOT NULL,
  purchase_order_line_id uuid,
  item_id                uuid,
  description            text NOT NULL,
  quantity               numeric(24,8) NOT NULL DEFAULT 1,
  uom                    text,
  unit_price             numeric(24,8) NOT NULL DEFAULT 0,
  destination_account_id uuid NOT NULL,
  tax_code_id            uuid,
  net_amount             numeric(24,8) NOT NULL,
  tax_amount             numeric(24,8) NOT NULL DEFAULT 0,
  recoverable_tax_amount numeric(24,8) NOT NULL DEFAULT 0,
  gross_amount           numeric(24,8) NOT NULL,
  -- doc 09: a bill line may be flagged for capitalization; finance approves.
  capitalize_as_asset    boolean NOT NULL DEFAULT false,
  calculation_snapshot   jsonb,
  UNIQUE (vendor_bill_id, line_no),
  CONSTRAINT vbl_account_fk FOREIGN KEY (destination_account_id, legal_entity_id) REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT vbl_tax_fk     FOREIGN KEY (tax_code_id, legal_entity_id) REFERENCES tax_codes(id, legal_entity_id),
  CONSTRAINT vbl_pol_fk     FOREIGN KEY (purchase_order_line_id, legal_entity_id) REFERENCES purchase_order_lines(id, legal_entity_id),
  CONSTRAINT vbl_scope_uq UNIQUE (id, legal_entity_id)
);

-- doc 05: two-way (PO vs bill) and three-way (PO vs receipt vs bill) matching.
CREATE TABLE bill_matches (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id),
  vendor_bill_id         uuid NOT NULL REFERENCES vendor_bills(id) ON DELETE RESTRICT,
  vendor_bill_line_id    uuid REFERENCES vendor_bill_lines(id),
  purchase_order_line_id uuid REFERENCES purchase_order_lines(id),
  goods_receipt_line_id  uuid,                       -- FK in 0012
  match_kind             text NOT NULL CHECK (match_kind IN ('TWO_WAY','THREE_WAY')),
  result                 bill_match_status NOT NULL,
  quantity_variance      numeric(24,8) NOT NULL DEFAULT 0,
  price_variance         numeric(24,8) NOT NULL DEFAULT 0,
  tax_variance           numeric(24,8) NOT NULL DEFAULT 0,
  tolerance_pct_applied  numeric(9,6),
  tolerance_abs_applied  numeric(24,8),
  matched_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bill_matches_bill_idx ON bill_matches(vendor_bill_id);

CREATE TABLE match_exceptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_match_id  uuid NOT NULL REFERENCES bill_matches(id) ON DELETE RESTRICT,
  exception_type text NOT NULL,
  detail         text,
  owner_user_id  uuid REFERENCES users(id),
  resolved_at    timestamptz,
  resolved_by    uuid REFERENCES users(id),
  resolution     text,
  blocks_posting boolean NOT NULL DEFAULT true,
  blocks_payment boolean NOT NULL DEFAULT true
);

CREATE TABLE vendor_credits (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id     uuid NOT NULL,
  accounting_book_id  uuid NOT NULL,
  vendor_id           uuid NOT NULL,
  vendor_bill_id      uuid REFERENCES vendor_bills(id),
  credit_number       text,
  document_date       date NOT NULL,
  posting_date        date NOT NULL,
  currency            char(3) NOT NULL REFERENCES currencies(code),
  exchange_rate       numeric(28,12),
  status              document_status NOT NULL DEFAULT 'DRAFT',
  subtotal            numeric(24,8) NOT NULL DEFAULT 0,
  tax_total           numeric(24,8) NOT NULL DEFAULT 0,
  total               numeric(24,8) NOT NULL DEFAULT 0,
  amount_applied      numeric(24,8) NOT NULL DEFAULT 0,
  amount_available    numeric(24,8) NOT NULL DEFAULT 0,
  accounting_entry_id uuid REFERENCES journal_entries(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vc_applied_bounded CHECK (amount_applied >= 0 AND amount_applied <= total),
  CONSTRAINT vc_available_derived CHECK (amount_available = total - amount_applied),
  CONSTRAINT vc_book_scope_fk FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id),
  CONSTRAINT vc_vendor_fk FOREIGN KEY (vendor_id, tenant_id) REFERENCES contacts(id, tenant_id)
);

CREATE TABLE expense_claims (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id     uuid NOT NULL,
  accounting_book_id  uuid NOT NULL,
  claimant_user_id    uuid NOT NULL REFERENCES users(id),
  claim_number        text,
  document_date       date NOT NULL,
  posting_date        date,
  currency            char(3) NOT NULL REFERENCES currencies(code),
  total               numeric(24,8) NOT NULL DEFAULT 0,
  status              expense_claim_status NOT NULL DEFAULT 'DRAFT',
  accounting_entry_id uuid REFERENCES journal_entries(id),
  reimbursed_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ec_book_scope_fk FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id),
  CONSTRAINT ec_scope_uq UNIQUE (id, legal_entity_id)
);

CREATE TABLE expense_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_claim_id  uuid NOT NULL REFERENCES expense_claims(id) ON DELETE RESTRICT,
  legal_entity_id   uuid NOT NULL,
  line_no           integer NOT NULL,
  expense_date      date NOT NULL,
  merchant          text,
  category          text,
  business_purpose  text,
  currency          char(3) NOT NULL REFERENCES currencies(code),
  amount            numeric(24,8) NOT NULL CHECK (amount > 0),
  expense_account_id uuid NOT NULL,
  tax_code_id       uuid,
  tax_amount        numeric(24,8) NOT NULL DEFAULT 0,
  receipt_file_id   uuid REFERENCES files(id),
  -- doc 05: policy engine flags limits, missing receipt, weekend/personal risk, duplicates.
  policy_flags      jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_company_card   boolean NOT NULL DEFAULT false,
  UNIQUE (expense_claim_id, line_no),
  CONSTRAINT ei_account_fk FOREIGN KEY (expense_account_id, legal_entity_id) REFERENCES accounts(id, legal_entity_id)
);

CREATE TABLE payment_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id    uuid NOT NULL,
  accounting_book_id uuid NOT NULL,
  run_number         text,
  bank_account_id    uuid,                        -- FK in 0011
  payment_date       date NOT NULL,
  currency           char(3) NOT NULL REFERENCES currencies(code),
  total_amount       numeric(24,8) NOT NULL DEFAULT 0,
  status             payment_run_status NOT NULL DEFAULT 'DRAFT',
  -- doc 14 SoD: payment over threshold requires two distinct approvals.
  approved_by        uuid REFERENCES users(id),
  approved_at        timestamptz,
  second_approved_by uuid REFERENCES users(id),
  second_approved_at timestamptz,
  executed_at        timestamptz,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pr_dual_approvers_differ
    CHECK (second_approved_by IS NULL OR second_approved_by <> approved_by),
  CONSTRAINT pr_maker_checker CHECK (approved_by IS NULL OR approved_by <> created_by),
  CONSTRAINT payment_runs_book_scope_fk FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id),
  CONSTRAINT payment_runs_scope_uq UNIQUE (id, legal_entity_id)
);

-- ADR-0007: split from the blueprint's generic `payments`.
CREATE TABLE vendor_payments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id      uuid NOT NULL,
  accounting_book_id   uuid NOT NULL,
  branch_id            uuid REFERENCES branches(id),
  vendor_id            uuid NOT NULL,
  payment_run_id       uuid REFERENCES payment_runs(id),
  payment_number       text,
  document_date        date NOT NULL,
  posting_date         date NOT NULL,
  currency             char(3) NOT NULL REFERENCES currencies(code),
  amount               numeric(24,8) NOT NULL CHECK (amount > 0),
  exchange_rate        numeric(28,12),
  exchange_rate_date   date,
  exchange_rate_source text,
  base_amount          numeric(24,8) NOT NULL,
  allocated_amount     numeric(24,8) NOT NULL DEFAULT 0,
  unapplied_amount     numeric(24,8) NOT NULL DEFAULT 0,
  -- doc 05: withholding may split the credit between bank and withholding payable.
  withholding_amount   numeric(24,8) NOT NULL DEFAULT 0,
  bank_account_id      uuid,
  contact_bank_detail_id uuid REFERENCES contact_bank_details(id),
  payment_method       text,
  status               payment_status NOT NULL DEFAULT 'DRAFT',
  accounting_entry_id  uuid REFERENCES journal_entries(id),
  external_reference   text,
  failure_reason       text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vp_alloc_bounded CHECK (allocated_amount >= 0 AND allocated_amount <= amount),
  CONSTRAINT vp_unapplied_derived CHECK (unapplied_amount = amount - allocated_amount),
  CONSTRAINT vp_book_scope_fk FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id),
  CONSTRAINT vp_vendor_fk FOREIGN KEY (vendor_id, tenant_id) REFERENCES contacts(id, tenant_id),
  CONSTRAINT vp_scope_uq UNIQUE (id, legal_entity_id)
);
CREATE UNIQUE INDEX vendor_payments_number_uq ON vendor_payments(legal_entity_id, payment_number) WHERE payment_number IS NOT NULL;

-- F-021 / ADR-0004 §2, the AP side.
CREATE TABLE payment_allocations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  vendor_payment_id  uuid NOT NULL REFERENCES vendor_payments(id) ON DELETE RESTRICT,
  target_type        text NOT NULL CHECK (target_type IN ('VENDOR_BILL','VENDOR_CREDIT','ADVANCE')),
  target_id          uuid NOT NULL,
  amount             numeric(24,8) NOT NULL CHECK (amount > 0),
  base_amount        numeric(24,8) NOT NULL,
  realized_fx_amount numeric(24,8) NOT NULL DEFAULT 0,
  allocated_at       timestamptz NOT NULL DEFAULT now(),
  allocated_by       uuid REFERENCES users(id),
  accounting_entry_id uuid REFERENCES journal_entries(id)
);
CREATE INDEX payment_allocations_payment_idx ON payment_allocations(vendor_payment_id);
CREATE INDEX payment_allocations_target_idx  ON payment_allocations(target_type, target_id);

CREATE OR REPLACE FUNCTION assert_payment_not_over_allocated()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_total numeric(24,8); v_amount numeric(24,8); v_id uuid;
BEGIN
  v_id := coalesce(NEW.vendor_payment_id, OLD.vendor_payment_id);
  SELECT coalesce(sum(amount),0) INTO v_total FROM payment_allocations WHERE vendor_payment_id = v_id;
  SELECT amount INTO v_amount FROM vendor_payments WHERE id = v_id;
  IF v_total > v_amount THEN
    RAISE EXCEPTION
      'OVER_ALLOCATION: payment % allocations total % exceed payment amount %.',
      v_id, v_total, v_amount USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER payment_allocations_bounded
  AFTER INSERT OR UPDATE OR DELETE ON payment_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_payment_not_over_allocated();

CREATE TABLE payment_holds (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  scope_type     text NOT NULL CHECK (scope_type IN ('VENDOR','VENDOR_BILL')),
  scope_id       uuid NOT NULL,
  reason         text NOT NULL,
  placed_by      uuid NOT NULL REFERENCES users(id),
  placed_at      timestamptz NOT NULL DEFAULT now(),
  released_by    uuid REFERENCES users(id),
  released_at    timestamptz
);
CREATE INDEX payment_holds_active_idx ON payment_holds(scope_type, scope_id) WHERE released_at IS NULL;

ALTER TABLE purchase_requisitions
  ADD CONSTRAINT pr_suggested_vendor_fk FOREIGN KEY (suggested_vendor_id) REFERENCES contacts(id);
CREATE TRIGGER vendor_bills_updated_at BEFORE UPDATE ON vendor_bills FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON INDEX vendor_bills_exact_duplicate_idx IS
  'F-020 (S1): the blueprint''s hard UNIQUE made doc 05''s permissioned duplicate override '
  'impossible. This partial index blocks only the unambiguous accidental double-entry.';
