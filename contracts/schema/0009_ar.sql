-- =============================================================================
-- 0009 — Accounts Receivable and sales
-- =============================================================================
-- Phase 3. Resolves F-019 (invoices could not determine their own period or
-- book), F-021 (over-allocation), F-022 (no FX settlement data), F-023
-- (ON DELETE CASCADE on posted document lines), F-027 (unconstrained balances),
-- F-009 (dimensions jsonb), and ADR-0007 (payments split into two tables).
-- =============================================================================

CREATE TABLE quotes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id  uuid NOT NULL,
  branch_id        uuid REFERENCES branches(id),
  customer_id      uuid NOT NULL,
  quote_number     text,
  version          integer NOT NULL DEFAULT 1,
  document_date    date NOT NULL,
  valid_until      date,
  currency         char(3) NOT NULL REFERENCES currencies(code),
  status           quote_status NOT NULL DEFAULT 'DRAFT',
  subtotal         numeric(24,8) NOT NULL DEFAULT 0,
  tax_total        numeric(24,8) NOT NULL DEFAULT 0,
  total            numeric(24,8) NOT NULL DEFAULT 0,
  converted_to_type text,
  converted_to_id  uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, quote_number, version),
  CONSTRAINT quotes_entity_scope_fk FOREIGN KEY (legal_entity_id, tenant_id) REFERENCES legal_entities(id, tenant_id),
  CONSTRAINT quotes_customer_fk FOREIGN KEY (customer_id, tenant_id) REFERENCES contacts(id, tenant_id),
  CONSTRAINT quotes_scope_uq UNIQUE (id, legal_entity_id)
);

CREATE TABLE sales_orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id  uuid NOT NULL,
  branch_id        uuid REFERENCES branches(id),
  customer_id      uuid NOT NULL,
  order_number     text,
  quote_id         uuid REFERENCES quotes(id),
  document_date    date NOT NULL,
  requested_date   date,
  customer_po_ref  text,
  currency         char(3) NOT NULL REFERENCES currencies(code),
  status           sales_order_status NOT NULL DEFAULT 'DRAFT',
  subtotal         numeric(24,8) NOT NULL DEFAULT 0,
  tax_total        numeric(24,8) NOT NULL DEFAULT 0,
  total            numeric(24,8) NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, order_number),
  CONSTRAINT so_entity_scope_fk FOREIGN KEY (legal_entity_id, tenant_id) REFERENCES legal_entities(id, tenant_id),
  CONSTRAINT so_customer_fk FOREIGN KEY (customer_id, tenant_id) REFERENCES contacts(id, tenant_id),
  CONSTRAINT so_scope_uq UNIQUE (id, legal_entity_id)
);

CREATE TABLE sales_order_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES sales_orders(id) ON DELETE RESTRICT,   -- F-023
  line_no        integer NOT NULL,
  item_id        uuid,
  description    text NOT NULL,
  quantity       numeric(24,8) NOT NULL DEFAULT 1,
  quantity_fulfilled numeric(24,8) NOT NULL DEFAULT 0,
  quantity_invoiced  numeric(24,8) NOT NULL DEFAULT 0,
  unit_price     numeric(24,8) NOT NULL DEFAULT 0,
  net_amount     numeric(24,8) NOT NULL,
  tax_amount     numeric(24,8) NOT NULL DEFAULT 0,
  gross_amount   numeric(24,8) NOT NULL,
  UNIQUE (sales_order_id, line_no),
  CHECK (quantity_fulfilled <= quantity AND quantity_invoiced <= quantity)
);

-- ----------------------------------------------------------------------------
-- Invoices — F-019 (S1).
-- The blueprint had issue_date and due_date only: no posting_date, no
-- document_date, no accounting_book_id, no branch_id. So the period an invoice
-- posts to could not be derived from the invoice, and invoice_lines.
-- revenue_account_id pointed at a book-scoped account while the invoice did not
-- know its book. ADR-0003 §7.
-- ----------------------------------------------------------------------------
CREATE TABLE invoices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id     uuid NOT NULL,
  accounting_book_id  uuid NOT NULL,                       -- F-019
  branch_id           uuid REFERENCES branches(id),        -- F-019
  customer_id         uuid NOT NULL,
  sales_order_id      uuid REFERENCES sales_orders(id),
  project_id          uuid,                                -- FK in 0014
  invoice_number      text,
  document_date       date NOT NULL,                       -- F-019
  posting_date        date NOT NULL,                       -- F-019: determines the period
  due_date            date,
  currency            char(3) NOT NULL REFERENCES currencies(code),
  exchange_rate       numeric(28,12),
  exchange_rate_date  date,
  exchange_rate_source text,
  status              document_status NOT NULL DEFAULT 'DRAFT',
  approval_state      approval_status NOT NULL DEFAULT 'NOT_REQUIRED',
  subtotal            numeric(24,8) NOT NULL DEFAULT 0,
  discount_total      numeric(24,8) NOT NULL DEFAULT 0,
  tax_total           numeric(24,8) NOT NULL DEFAULT 0,
  rounding_adjustment numeric(24,8) NOT NULL DEFAULT 0,     -- ADR-0006 §5
  total               numeric(24,8) NOT NULL DEFAULT 0,
  base_total          numeric(24,8) NOT NULL DEFAULT 0,
  amount_paid         numeric(24,8) NOT NULL DEFAULT 0,
  amount_due          numeric(24,8) NOT NULL DEFAULT 0,
  accounting_entry_id uuid REFERENCES journal_entries(id),
  recurring_template_id uuid,
  terms               text,
  notes               text,
  sent_at             timestamptz,
  version             bigint NOT NULL DEFAULT 1,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- F-027: the blueprint stored amount_paid/amount_due with no relationship to
  -- total. ADR-0004 §2 layer 2.
  CONSTRAINT invoices_paid_nonneg  CHECK (amount_paid >= 0),
  CONSTRAINT invoices_paid_bounded CHECK (amount_paid <= total),
  CONSTRAINT invoices_due_derived  CHECK (amount_due = total - amount_paid),
  CONSTRAINT invoices_posted_has_number CHECK (status = 'DRAFT' OR invoice_number IS NOT NULL),
  CONSTRAINT invoices_book_scope_fk FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id),
  CONSTRAINT invoices_customer_fk   FOREIGN KEY (customer_id, tenant_id) REFERENCES contacts(id, tenant_id),
  CONSTRAINT invoices_scope_uq UNIQUE (id, legal_entity_id)
);
CREATE UNIQUE INDEX invoices_number_uq ON invoices(legal_entity_id, invoice_number) WHERE invoice_number IS NOT NULL;
CREATE INDEX invoices_customer_status_idx ON invoices(customer_id, status, due_date);
-- Gate D: AR detail = AR GL control account. This is the aging query's index.
CREATE INDEX invoices_open_idx ON invoices(legal_entity_id, due_date)
  WHERE status IN ('POSTED','PARTIALLY_PAID');

CREATE TABLE invoice_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- F-023: the blueprint used ON DELETE CASCADE, so a posted invoice's lines
  -- could be cascade-deleted. doc 01: "no destructive cascade may delete posted
  -- history."
  invoice_id         uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  legal_entity_id    uuid NOT NULL,
  line_no            integer NOT NULL,
  item_id            uuid,
  description        text NOT NULL,
  quantity           numeric(24,8) NOT NULL DEFAULT 1,
  uom                text,
  unit_price         numeric(24,8) NOT NULL DEFAULT 0,
  discount_amount    numeric(24,8) NOT NULL DEFAULT 0,
  revenue_account_id uuid NOT NULL,
  tax_code_id        uuid,
  net_amount         numeric(24,8) NOT NULL,
  tax_amount         numeric(24,8) NOT NULL DEFAULT 0,
  gross_amount       numeric(24,8) NOT NULL,
  -- ADR-0006: the per-line calculation snapshot doc 04 requires.
  calculation_snapshot jsonb,
  UNIQUE (invoice_id, line_no),
  -- F-003 pattern: revenue account must belong to the invoice's entity.
  CONSTRAINT invoice_lines_revenue_fk FOREIGN KEY (revenue_account_id, legal_entity_id) REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT invoice_lines_tax_fk     FOREIGN KEY (tax_code_id, legal_entity_id) REFERENCES tax_codes(id, legal_entity_id)
  -- F-009: dimensions live in document_line_dimensions, not a jsonb column.
);

CREATE TABLE credit_notes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id     uuid NOT NULL,
  accounting_book_id  uuid NOT NULL,
  branch_id           uuid REFERENCES branches(id),
  customer_id         uuid NOT NULL,
  invoice_id          uuid REFERENCES invoices(id),   -- null = against the account
  credit_note_number  text,
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
  reason              text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_notes_applied_bounded CHECK (amount_applied >= 0 AND amount_applied <= total),
  CONSTRAINT credit_notes_available_derived CHECK (amount_available = total - amount_applied),
  CONSTRAINT credit_notes_book_scope_fk FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id),
  CONSTRAINT credit_notes_customer_fk FOREIGN KEY (customer_id, tenant_id) REFERENCES contacts(id, tenant_id),
  CONSTRAINT credit_notes_scope_uq UNIQUE (id, legal_entity_id)
);
CREATE UNIQUE INDEX credit_notes_number_uq ON credit_notes(legal_entity_id, credit_note_number) WHERE credit_note_number IS NOT NULL;

CREATE TABLE credit_note_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_note_id     uuid NOT NULL REFERENCES credit_notes(id) ON DELETE RESTRICT,
  legal_entity_id    uuid NOT NULL,
  line_no            integer NOT NULL,
  invoice_line_id    uuid REFERENCES invoice_lines(id),   -- preserves original tax reference
  description        text NOT NULL,
  quantity           numeric(24,8) NOT NULL DEFAULT 1,
  unit_price         numeric(24,8) NOT NULL DEFAULT 0,
  revenue_account_id uuid NOT NULL,
  tax_code_id        uuid,
  net_amount         numeric(24,8) NOT NULL,
  tax_amount         numeric(24,8) NOT NULL DEFAULT 0,
  gross_amount       numeric(24,8) NOT NULL,
  UNIQUE (credit_note_id, line_no),
  CONSTRAINT cn_lines_revenue_fk FOREIGN KEY (revenue_account_id, legal_entity_id) REFERENCES accounts(id, legal_entity_id)
);

-- ----------------------------------------------------------------------------
-- Customer receipts — ADR-0007 split from the blueprint's generic `payments`.
-- F-022: the generic table had no exchange_rate, no base amount and no realized
-- FX fields, so doc 11's realized FX on settlement was uncomputable.
-- ----------------------------------------------------------------------------
CREATE TABLE customer_receipts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id      uuid NOT NULL,
  accounting_book_id   uuid NOT NULL,
  branch_id            uuid REFERENCES branches(id),
  customer_id          uuid NOT NULL,
  receipt_number       text,
  document_date        date NOT NULL,
  posting_date         date NOT NULL,
  currency             char(3) NOT NULL REFERENCES currencies(code),
  amount               numeric(24,8) NOT NULL CHECK (amount > 0),
  -- F-022 / ADR-0007: FX settlement inputs.
  exchange_rate        numeric(28,12),
  exchange_rate_date   date,
  exchange_rate_source text,
  base_amount          numeric(24,8) NOT NULL,
  allocated_amount     numeric(24,8) NOT NULL DEFAULT 0,
  unapplied_amount     numeric(24,8) NOT NULL DEFAULT 0,
  bank_account_id      uuid,                                -- FK in 0011
  payment_method       text,
  source               text NOT NULL DEFAULT 'MANUAL'
    CHECK (source IN ('MANUAL','BANK_MATCH','CASH','GATEWAY','IMPORT','MIGRATION')),
  status               payment_status NOT NULL DEFAULT 'DRAFT',
  accounting_entry_id  uuid REFERENCES journal_entries(id),
  external_reference   text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT receipts_alloc_bounded CHECK (allocated_amount >= 0 AND allocated_amount <= amount),
  CONSTRAINT receipts_unapplied_derived CHECK (unapplied_amount = amount - allocated_amount),
  CONSTRAINT receipts_book_scope_fk FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id),
  CONSTRAINT receipts_customer_fk FOREIGN KEY (customer_id, tenant_id) REFERENCES contacts(id, tenant_id),
  CONSTRAINT receipts_scope_uq UNIQUE (id, legal_entity_id)
);
CREATE UNIQUE INDEX customer_receipts_number_uq ON customer_receipts(legal_entity_id, receipt_number) WHERE receipt_number IS NOT NULL;
CREATE INDEX customer_receipts_unapplied_idx ON customer_receipts(customer_id) WHERE unapplied_amount > 0;

-- ----------------------------------------------------------------------------
-- Receipt allocations — F-021 (S1) / ADR-0004 §2.
-- The blueprint had UNIQUE (payment_id, target_type, target_id) and CHECK
-- (amount > 0) and nothing else. Two concurrent transactions could each read
-- amount_due = 100, each allocate 100, and both commit.
--
-- Layer 1 (locks) is in the service. Layer 2 (persisted balances) is the CHECK
-- constraints on invoices/credit_notes above. Layer 3 is the deferred trigger.
--
-- The blueprint's UNIQUE is deliberately NOT reproduced: it forbade two partial
-- allocations from one receipt to one invoice at different times, which doc 04's
-- partial-allocation flow legitimately needs.
-- ----------------------------------------------------------------------------
CREATE TABLE receipt_allocations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  customer_receipt_id  uuid NOT NULL REFERENCES customer_receipts(id) ON DELETE RESTRICT,
  target_type          text NOT NULL CHECK (target_type IN ('INVOICE','CREDIT_NOTE','ADVANCE')),
  target_id            uuid NOT NULL,
  amount               numeric(24,8) NOT NULL CHECK (amount > 0),
  base_amount          numeric(24,8) NOT NULL,
  -- ADR-0007: FX is realized PER ALLOCATION, not per receipt, because one
  -- receipt may settle invoices booked at different rates.
  realized_fx_amount   numeric(24,8) NOT NULL DEFAULT 0,
  allocated_at         timestamptz NOT NULL DEFAULT now(),
  allocated_by         uuid REFERENCES users(id),
  accounting_entry_id  uuid REFERENCES journal_entries(id)
);
CREATE INDEX receipt_allocations_receipt_idx ON receipt_allocations(customer_receipt_id);
CREATE INDEX receipt_allocations_target_idx  ON receipt_allocations(target_type, target_id);

CREATE OR REPLACE FUNCTION assert_receipt_not_over_allocated()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_total numeric(24,8); v_amount numeric(24,8); v_id uuid;
BEGIN
  v_id := coalesce(NEW.customer_receipt_id, OLD.customer_receipt_id);
  SELECT coalesce(sum(amount),0) INTO v_total FROM receipt_allocations WHERE customer_receipt_id = v_id;
  SELECT amount INTO v_amount FROM customer_receipts WHERE id = v_id;
  IF v_total > v_amount THEN
    RAISE EXCEPTION
      'OVER_ALLOCATION: receipt % allocations total % exceed receipt amount %.',
      v_id, v_total, v_amount USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER receipt_allocations_bounded
  AFTER INSERT OR UPDATE OR DELETE ON receipt_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_receipt_not_over_allocated();

CREATE TABLE customer_refunds (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id     uuid NOT NULL,
  accounting_book_id  uuid NOT NULL,
  customer_id         uuid NOT NULL,
  credit_note_id      uuid REFERENCES credit_notes(id),
  customer_receipt_id uuid REFERENCES customer_receipts(id),
  refund_number       text,
  posting_date        date NOT NULL,
  currency            char(3) NOT NULL REFERENCES currencies(code),
  amount              numeric(24,8) NOT NULL CHECK (amount > 0),
  bank_account_id     uuid,
  status              payment_status NOT NULL DEFAULT 'DRAFT',
  accounting_entry_id uuid REFERENCES journal_entries(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refunds_book_scope_fk FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id)
);

-- doc 04: authorized workflow with reason code, threshold and approval.
CREATE TABLE ar_write_offs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id     uuid NOT NULL,
  accounting_book_id  uuid NOT NULL,
  invoice_id          uuid NOT NULL REFERENCES invoices(id),
  posting_date        date NOT NULL,
  amount              numeric(24,8) NOT NULL CHECK (amount > 0),
  reason_code         text NOT NULL,
  approved_by         uuid REFERENCES users(id),
  approved_at         timestamptz,
  accounting_entry_id uuid REFERENCES journal_entries(id),
  recovered_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ar_wo_book_scope_fk FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id)
);

CREATE TABLE recurring_invoice_templates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id    uuid NOT NULL,
  accounting_book_id uuid NOT NULL,
  customer_id        uuid NOT NULL,
  name               text NOT NULL,
  version            integer NOT NULL DEFAULT 1,
  frequency          text NOT NULL CHECK (frequency IN ('WEEKLY','MONTHLY','QUARTERLY','ANNUAL')),
  start_date         date NOT NULL,
  end_date           date,
  next_run_date      date,
  due_date_rule      text,
  auto_send          boolean NOT NULL DEFAULT false,
  auto_post          boolean NOT NULL DEFAULT false,
  line_template      jsonb NOT NULL,
  status             record_status NOT NULL DEFAULT 'ACTIVE',
  CONSTRAINT rit_book_scope_fk FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id),
  CONSTRAINT rit_customer_fk FOREIGN KEY (customer_id, tenant_id) REFERENCES contacts(id, tenant_id)
);

CREATE TABLE recurring_invoice_occurrences (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id     uuid NOT NULL REFERENCES recurring_invoice_templates(id) ON DELETE RESTRICT,
  occurrence_date date NOT NULL,
  template_version integer NOT NULL,
  invoice_id      uuid REFERENCES invoices(id),
  generated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, occurrence_date)     -- doc 04: occurrence is idempotent
);
ALTER TABLE invoices ADD CONSTRAINT invoices_recurring_fk
  FOREIGN KEY (recurring_template_id) REFERENCES recurring_invoice_templates(id);

CREATE TABLE customer_statements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL,
  customer_id     uuid NOT NULL,
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  opening_balance numeric(24,8) NOT NULL,
  closing_balance numeric(24,8) NOT NULL,
  currency        char(3) NOT NULL REFERENCES currencies(code),
  file_id         uuid REFERENCES files(id),
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  invoice_id      uuid NOT NULL REFERENCES invoices(id),
  provider        text NOT NULL,
  external_id     text,
  url             text NOT NULL,
  expires_at      timestamptz,
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','USED','EXPIRED','CANCELLED')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER invoices_updated_at BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE receipt_allocations IS
  'F-021 (S1) / ADR-0004: three-layer over-allocation guard. Gate G tests "two receipts allocated '
  'to last invoice balance". Lock order is receipt, then targets by ascending id.';
COMMENT ON COLUMN invoices.posting_date IS
  'F-019: determines the accounting period (doc 01). The blueprint had no such column.';
