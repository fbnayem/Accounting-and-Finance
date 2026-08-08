-- =============================================================================
-- 0036 — Subledger runtime: receipts, applications, write-offs, document guards
-- =============================================================================
-- Phase 3. Everything here was found by building AR, AP and tax against
-- 0007–0010 rather than by reading them. Those files are correct about what they
-- cover; these are the things that only appear when a document has to move.
--
--   F-701  `quotes` has totals and no lines. doc 04 gives a quote line items and
--          requires conversion "preserving source link", so a quote was a number
--          with no content and conversion had nothing to copy.
--   F-702  There is no goods receipt. doc 05 and doc 21 both put goods/service
--          receipt in Phase 3, `bill_matches.goods_receipt_line_id` points at
--          `inventory_movements` (Phase 5), and `service_receipts` has no lines.
--          So three-way matching — a Phase 3 exit criterion — had no receipt side.
--   F-703  A write-off cannot reduce an invoice's open balance. The CHECK is
--          `amount_due = total - amount_paid` and `ar_write_offs` reaches neither
--          term, so doc 04's "AR open-item total equals AR GL control account
--          across normal, credit, write-off and FX scenarios" was unreachable.
--   F-704  A credit note cannot be applied to an invoice, nor a vendor credit to
--          a bill. Both tables carry `amount_applied` and nothing could move it.
--   F-705  `files` has no upload state. The row is created by /files/upload-url
--          before any bytes exist, so an abandoned upload is indistinguishable
--          from a real attachment — including to the malware scanner.
--   F-706  Order and quote lines carry `tax_amount` with no `tax_code_id`, so
--          doc 04's tax preview could not record what produced it and conversion
--          to an invoice lost the treatment.
--   F-707  `invoice_lines` has no `sales_order_line_id`, so partial invoicing
--          could not maintain `sales_order_lines.quantity_invoiced`.
--
-- Plus the guard doc 01 rule 4 implies for every subledger document and only the
-- ledger had: a posted invoice's financial values are accounting facts.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. F-701 — quote lines.
--
-- Deliberately shaped like sales_order_lines rather than invoice_lines: a quote
-- is non-posting (doc 04), so it has no revenue account and no calculation
-- snapshot. It has a tax code, because losing the treatment on conversion is
-- exactly F-706.
-- ----------------------------------------------------------------------------
CREATE TABLE quote_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id        uuid NOT NULL REFERENCES quotes(id) ON DELETE RESTRICT,
  legal_entity_id uuid NOT NULL,
  line_no         integer NOT NULL,
  item_id         uuid,
  description     text NOT NULL,
  quantity        numeric(24,8) NOT NULL DEFAULT 1,
  uom             text,
  unit_price      numeric(24,8) NOT NULL DEFAULT 0,
  discount_amount numeric(24,8) NOT NULL DEFAULT 0,
  tax_code_id     uuid,
  net_amount      numeric(24,8) NOT NULL,
  tax_amount      numeric(24,8) NOT NULL DEFAULT 0,
  gross_amount    numeric(24,8) NOT NULL,
  UNIQUE (quote_id, line_no),
  CONSTRAINT quote_lines_quote_scope_fk FOREIGN KEY (quote_id, legal_entity_id) REFERENCES quotes(id, legal_entity_id),
  CONSTRAINT quote_lines_tax_fk FOREIGN KEY (tax_code_id, legal_entity_id) REFERENCES tax_codes(id, legal_entity_id),
  CONSTRAINT quote_lines_scope_uq UNIQUE (id, legal_entity_id)
);

-- F-706 on the order side. The column is nullable because a line may be
-- genuinely out of scope for tax, which is not the same as unspecified.
ALTER TABLE sales_order_lines ADD COLUMN tax_code_id uuid;
ALTER TABLE sales_order_lines ADD COLUMN legal_entity_id uuid;
UPDATE sales_order_lines l SET legal_entity_id = o.legal_entity_id
  FROM sales_orders o WHERE o.id = l.sales_order_id;
ALTER TABLE sales_order_lines ALTER COLUMN legal_entity_id SET NOT NULL;
ALTER TABLE sales_order_lines ADD CONSTRAINT sol_order_scope_fk
  FOREIGN KEY (sales_order_id, legal_entity_id) REFERENCES sales_orders(id, legal_entity_id);
ALTER TABLE sales_order_lines ADD CONSTRAINT sol_tax_fk
  FOREIGN KEY (tax_code_id, legal_entity_id) REFERENCES tax_codes(id, legal_entity_id);
ALTER TABLE sales_order_lines ADD CONSTRAINT sol_scope_uq UNIQUE (id, legal_entity_id);

-- F-707. Partial invoicing has to know which order line it consumed.
ALTER TABLE invoice_lines ADD COLUMN sales_order_line_id uuid;
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_sol_fk
  FOREIGN KEY (sales_order_line_id, legal_entity_id) REFERENCES sales_order_lines(id, legal_entity_id);
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_scope_uq UNIQUE (id, legal_entity_id);

-- ----------------------------------------------------------------------------
-- 2. F-702 — the goods receipt.
--
-- 0010's comment explains the original reasoning: "goods receipts are inventory
-- documents (0012) so physical receipt and vendor invoice timing stay separate."
-- The timing separation is right; the conclusion is not. A receipt is a
-- PROCUREMENT fact — this vendor delivered this quantity on this date, and we
-- accepted this much of it — and an inventory movement is one of its
-- consequences. Services have no movement at all and doc 05 receipts them the
-- same way, which is why doc 05 titles the section "Goods/service receipt".
--
-- So the receipt lives here with a kind, and Phase 5's inventory_movements will
-- reference the receipt line rather than impersonate it. `service_receipts` is
-- dropped rather than left beside it: it is header-only, unreferenced, unwritten,
-- and a second receipt table is a second place for matching to look.
-- ----------------------------------------------------------------------------
DROP TABLE service_receipts;

CREATE TABLE goods_receipts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id   uuid NOT NULL,
  accounting_book_id uuid NOT NULL,
  branch_id         uuid REFERENCES branches(id),
  vendor_id         uuid NOT NULL,
  purchase_order_id uuid REFERENCES purchase_orders(id),
  receipt_number    text,
  receipt_kind      text NOT NULL DEFAULT 'GOODS' CHECK (receipt_kind IN ('GOODS','SERVICE')),
  receipt_date      date NOT NULL,
  posting_date      date NOT NULL,
  location          text,
  received_by       uuid REFERENCES users(id),
  notes             text,
  status            document_status NOT NULL DEFAULT 'DRAFT',
  -- The GRNI accrual, when it is posted. Null until then.
  accounting_entry_id uuid REFERENCES journal_entries(id),
  version           bigint NOT NULL DEFAULT 1,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gr_book_scope_fk FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id),
  CONSTRAINT gr_vendor_fk FOREIGN KEY (vendor_id, tenant_id) REFERENCES contacts(id, tenant_id),
  CONSTRAINT gr_po_scope_fk FOREIGN KEY (purchase_order_id, legal_entity_id) REFERENCES purchase_orders(id, legal_entity_id),
  CONSTRAINT gr_scope_uq UNIQUE (id, legal_entity_id)
);
CREATE UNIQUE INDEX goods_receipts_number_uq ON goods_receipts(legal_entity_id, receipt_number)
  WHERE receipt_number IS NOT NULL;
CREATE INDEX goods_receipts_po_idx ON goods_receipts(purchase_order_id) WHERE purchase_order_id IS NOT NULL;

CREATE TABLE goods_receipt_lines (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goods_receipt_id       uuid NOT NULL REFERENCES goods_receipts(id) ON DELETE RESTRICT,
  legal_entity_id        uuid NOT NULL,
  line_no                integer NOT NULL,
  purchase_order_line_id uuid,
  item_id                uuid,
  description            text NOT NULL,
  uom                    text,
  -- doc 05: "received quantity/date/location, accepted/rejected quantity".
  -- Rejected is not derived from accepted: a delivery may be short AND partly
  -- rejected, and the difference is the vendor's problem versus the carrier's.
  quantity_received      numeric(24,8) NOT NULL CHECK (quantity_received >= 0),
  quantity_accepted      numeric(24,8) NOT NULL DEFAULT 0 CHECK (quantity_accepted >= 0),
  quantity_rejected      numeric(24,8) NOT NULL DEFAULT 0 CHECK (quantity_rejected >= 0),
  quantity_billed        numeric(24,8) NOT NULL DEFAULT 0 CHECK (quantity_billed >= 0),
  unit_price             numeric(24,8) NOT NULL DEFAULT 0,
  destination_account_id uuid,
  rejection_reason       text,
  UNIQUE (goods_receipt_id, line_no),
  CONSTRAINT grl_accepted_bounded CHECK (quantity_accepted + quantity_rejected <= quantity_received),
  -- Only accepted quantity may be billed: rejecting goods and paying for them is
  -- the exact failure three-way matching exists to prevent.
  CONSTRAINT grl_billed_bounded CHECK (quantity_billed <= quantity_accepted),
  CONSTRAINT grl_receipt_scope_fk FOREIGN KEY (goods_receipt_id, legal_entity_id) REFERENCES goods_receipts(id, legal_entity_id),
  CONSTRAINT grl_pol_scope_fk FOREIGN KEY (purchase_order_line_id, legal_entity_id) REFERENCES purchase_order_lines(id, legal_entity_id),
  CONSTRAINT grl_account_fk FOREIGN KEY (destination_account_id, legal_entity_id) REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT grl_scope_uq UNIQUE (id, legal_entity_id)
);
CREATE INDEX goods_receipt_lines_pol_idx ON goods_receipt_lines(purchase_order_line_id)
  WHERE purchase_order_line_id IS NOT NULL;

-- The match's receipt side now points at a receipt. 0012 pointed it at
-- inventory_movements, which arrives two phases after the criterion that needs it.
ALTER TABLE bill_matches DROP CONSTRAINT bill_matches_grn_fk;
ALTER TABLE bill_matches ADD CONSTRAINT bill_matches_grl_fk
  FOREIGN KEY (goods_receipt_line_id) REFERENCES goods_receipt_lines(id);
ALTER TABLE vendor_bill_lines ADD COLUMN goods_receipt_line_id uuid;
ALTER TABLE vendor_bill_lines ADD CONSTRAINT vbl_grl_scope_fk
  FOREIGN KEY (goods_receipt_line_id, legal_entity_id) REFERENCES goods_receipt_lines(id, legal_entity_id);

-- ----------------------------------------------------------------------------
-- 3. F-703 / F-704 — what an open balance actually is.
--
-- An invoice closes four ways, not one: it is paid, it is credited, it is
-- written off, or some combination. The original CHECK admitted only payment, so
-- a credited or written-off invoice stayed open in the subledger while the GL
-- control account had already moved — which is precisely the reconciliation doc
-- 04 makes an acceptance criterion.
--
-- Each term is stored rather than derived from its detail table, for the reason
-- ADR-0004 §2 gives: a persisted balance is what a CHECK constraint can defend,
-- and a SUM() over a detail table is not.
-- ----------------------------------------------------------------------------
ALTER TABLE invoices ADD COLUMN amount_credited    numeric(24,8) NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN amount_written_off numeric(24,8) NOT NULL DEFAULT 0;
ALTER TABLE invoices DROP CONSTRAINT invoices_paid_bounded;
ALTER TABLE invoices DROP CONSTRAINT invoices_due_derived;
ALTER TABLE invoices ADD CONSTRAINT invoices_settlement_nonneg
  CHECK (amount_paid >= 0 AND amount_credited >= 0 AND amount_written_off >= 0);
ALTER TABLE invoices ADD CONSTRAINT invoices_settlement_bounded
  CHECK (amount_paid + amount_credited + amount_written_off <= total);
ALTER TABLE invoices ADD CONSTRAINT invoices_due_derived
  CHECK (amount_due = total - amount_paid - amount_credited - amount_written_off);

ALTER TABLE vendor_bills ADD COLUMN amount_credited numeric(24,8) NOT NULL DEFAULT 0;
ALTER TABLE vendor_bills DROP CONSTRAINT bills_paid_bounded;
ALTER TABLE vendor_bills DROP CONSTRAINT bills_due_derived;
ALTER TABLE vendor_bills ADD CONSTRAINT bills_settlement_nonneg
  CHECK (amount_paid >= 0 AND amount_credited >= 0);
ALTER TABLE vendor_bills ADD CONSTRAINT bills_settlement_bounded
  CHECK (amount_paid + amount_credited <= total);
ALTER TABLE vendor_bills ADD CONSTRAINT bills_due_derived
  CHECK (amount_due = total - amount_paid - amount_credited);

-- F-704. Shaped like receipt_allocations, and for the same reasons: no UNIQUE on
-- (credit, invoice), because two partial applications at different times are
-- legitimate; a deferred trigger, because the per-row check must see the whole
-- set at COMMIT.
CREATE TABLE credit_note_applications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  credit_note_id      uuid NOT NULL REFERENCES credit_notes(id) ON DELETE RESTRICT,
  invoice_id          uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  amount              numeric(24,8) NOT NULL CHECK (amount > 0),
  base_amount         numeric(24,8) NOT NULL,
  applied_at          timestamptz NOT NULL DEFAULT now(),
  applied_by          uuid REFERENCES users(id),
  accounting_entry_id uuid REFERENCES journal_entries(id)
);
CREATE INDEX cna_credit_idx  ON credit_note_applications(credit_note_id);
CREATE INDEX cna_invoice_idx ON credit_note_applications(invoice_id);

CREATE TABLE vendor_credit_applications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  vendor_credit_id    uuid NOT NULL REFERENCES vendor_credits(id) ON DELETE RESTRICT,
  vendor_bill_id      uuid NOT NULL REFERENCES vendor_bills(id) ON DELETE RESTRICT,
  amount              numeric(24,8) NOT NULL CHECK (amount > 0),
  base_amount         numeric(24,8) NOT NULL,
  applied_at          timestamptz NOT NULL DEFAULT now(),
  applied_by          uuid REFERENCES users(id),
  accounting_entry_id uuid REFERENCES journal_entries(id)
);
CREATE INDEX vca_credit_idx ON vendor_credit_applications(vendor_credit_id);
CREATE INDEX vca_bill_idx   ON vendor_credit_applications(vendor_bill_id);

CREATE OR REPLACE FUNCTION assert_credit_not_over_applied()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_total numeric(24,8); v_amount numeric(24,8); v_id uuid;
BEGIN
  v_id := coalesce(NEW.credit_note_id, OLD.credit_note_id);
  SELECT coalesce(sum(amount),0) INTO v_total FROM credit_note_applications WHERE credit_note_id = v_id;
  SELECT total INTO v_amount FROM credit_notes WHERE id = v_id;
  IF v_total > v_amount THEN
    RAISE EXCEPTION
      'OVER_ALLOCATION: credit note % applications total % exceed the note total %.',
      v_id, v_total, v_amount USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER credit_note_applications_bounded
  AFTER INSERT OR UPDATE OR DELETE ON credit_note_applications
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_credit_not_over_applied();

CREATE OR REPLACE FUNCTION assert_vendor_credit_not_over_applied()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_total numeric(24,8); v_amount numeric(24,8); v_id uuid;
BEGIN
  v_id := coalesce(NEW.vendor_credit_id, OLD.vendor_credit_id);
  SELECT coalesce(sum(amount),0) INTO v_total FROM vendor_credit_applications WHERE vendor_credit_id = v_id;
  SELECT total INTO v_amount FROM vendor_credits WHERE id = v_id;
  IF v_total > v_amount THEN
    RAISE EXCEPTION
      'OVER_ALLOCATION: vendor credit % applications total % exceed the credit total %.',
      v_id, v_total, v_amount USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER vendor_credit_applications_bounded
  AFTER INSERT OR UPDATE OR DELETE ON vendor_credit_applications
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_vendor_credit_not_over_applied();

-- ----------------------------------------------------------------------------
-- 4. F-705 — the upload lifecycle.
--
-- /files/upload-url creates the row and hands out a pre-signed URL; the bytes
-- arrive at the object store directly, and /files/{id}/complete is the only
-- evidence they did. Without a state, an abandoned upload is a file record with
-- a storage key pointing at nothing — indistinguishable from an attachment on a
-- posted bill, including to anything that sweeps for unscanned files.
-- ----------------------------------------------------------------------------
CREATE TYPE upload_state AS ENUM ('PENDING','COMPLETED','ABANDONED');
ALTER TABLE files ADD COLUMN upload_state upload_state NOT NULL DEFAULT 'PENDING';
ALTER TABLE files ADD COLUMN completed_at timestamptz;
ALTER TABLE files ADD COLUMN uploaded_size bigint;
UPDATE files SET upload_state = 'COMPLETED', completed_at = created_at;
ALTER TABLE files ADD CONSTRAINT files_completed_has_time
  CHECK ((upload_state = 'COMPLETED') = (completed_at IS NOT NULL));
CREATE INDEX files_pending_idx ON files(tenant_id, created_at) WHERE upload_state = 'PENDING';

-- ----------------------------------------------------------------------------
-- 5. Posted subledger documents are accounting facts too.
--
-- doc 01 rule 4 is not about journals specifically, and until now only journals
-- enforced it. An invoice whose total changes after posting disagrees with its
-- own journal entry for the rest of time, and nothing would notice: the ledger
-- still balances, because the ledger was never told.
--
-- What stays mutable is deliberate. amount_paid, amount_credited,
-- amount_written_off, amount_due, status and sent_at all describe what has
-- happened TO the document since. What freezes is what the journal was built
-- from.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION guard_posted_document_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_frozen_before text;
  v_frozen_after  text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status NOT IN ('DRAFT','PENDING_APPROVAL','APPROVED') THEN
      RAISE EXCEPTION
        'POSTED_IMMUTABLE: % % is % and is never deleted. Correct it by credit note or reversal (doc 01 rule 4).',
        TG_TABLE_NAME, OLD.id, OLD.status USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status IN ('DRAFT','PENDING_APPROVAL','APPROVED') THEN
    RETURN NEW;
  END IF;

  -- TG_ARGV[0] is a comma-separated list of the columns that must not move once
  -- the document is posted. Passed as an argument rather than hardcoded because
  -- three tables share this function and their column sets differ.
  --
  -- Read out of to_jsonb(OLD)/to_jsonb(NEW) rather than by building SQL out of
  -- the argument: a column name that does not exist then yields NULL on both
  -- sides instead of executing, so a typo in a trigger definition cannot turn
  -- into a syntax error at 02:00 on the one UPDATE that mattered.
  v_frozen_before := (SELECT string_agg(coalesce(value, '<null>'), '|' ORDER BY ord)
                        FROM unnest(string_to_array(TG_ARGV[0], ',')) WITH ORDINALITY AS k(col, ord)
                        CROSS JOIN LATERAL (SELECT to_jsonb(OLD) ->> trim(k.col) AS value) v);
  v_frozen_after  := (SELECT string_agg(coalesce(value, '<null>'), '|' ORDER BY ord)
                        FROM unnest(string_to_array(TG_ARGV[0], ',')) WITH ORDINALITY AS k(col, ord)
                        CROSS JOIN LATERAL (SELECT to_jsonb(NEW) ->> trim(k.col) AS value) v);

  IF v_frozen_before IS DISTINCT FROM v_frozen_after THEN
    RAISE EXCEPTION
      'POSTED_IMMUTABLE: % % is %; its accounting values are frozen. Correct it by credit note or reversal (doc 01 rule 4).',
      TG_TABLE_NAME, OLD.id, OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER invoices_posted_immutable
  BEFORE UPDATE OR DELETE ON invoices FOR EACH ROW
  EXECUTE FUNCTION guard_posted_document_immutable(
    'tenant_id,legal_entity_id,accounting_book_id,customer_id,invoice_number,document_date,posting_date,currency,exchange_rate,subtotal,discount_total,tax_total,rounding_adjustment,total,base_total,accounting_entry_id');

CREATE TRIGGER vendor_bills_posted_immutable
  BEFORE UPDATE OR DELETE ON vendor_bills FOR EACH ROW
  EXECUTE FUNCTION guard_posted_document_immutable(
    'tenant_id,legal_entity_id,accounting_book_id,vendor_id,vendor_invoice_number,document_date,posting_date,currency,exchange_rate,subtotal,tax_total,rounding_adjustment,total,base_total,accounting_entry_id');

CREATE TRIGGER credit_notes_posted_immutable
  BEFORE UPDATE OR DELETE ON credit_notes FOR EACH ROW
  EXECUTE FUNCTION guard_posted_document_immutable(
    'tenant_id,legal_entity_id,accounting_book_id,customer_id,invoice_id,credit_note_number,document_date,posting_date,currency,exchange_rate,subtotal,tax_total,total,accounting_entry_id');

-- The lines of a posted document, which is where the amounts actually live.
CREATE OR REPLACE FUNCTION guard_posted_document_lines()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_parent uuid;
BEGIN
  v_parent := coalesce(to_jsonb(NEW) ->> TG_ARGV[0], to_jsonb(OLD) ->> TG_ARGV[0])::uuid;
  EXECUTE format('SELECT status::text FROM %I WHERE id = $1', TG_ARGV[1])
    INTO v_status USING v_parent;

  IF v_status IS NOT NULL AND v_status NOT IN ('DRAFT','PENDING_APPROVAL','APPROVED') THEN
    RAISE EXCEPTION
      'POSTED_IMMUTABLE: % belongs to % % which is %; posted document lines are accounting facts (doc 01 rule 4).',
      TG_TABLE_NAME, TG_ARGV[1], v_parent, v_status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;

-- The guard reads its frozen-column list out of to_jsonb, which means a column
-- name that does not exist compares NULL to NULL and freezes nothing. That is
-- how a control ends up decorative, so the names are checked here against the
-- catalog and a typo fails the migration rather than the audit.
DO $$
DECLARE
  r        record;
  v_column text;
BEGIN
  FOR r IN
    -- tgargs is a null-separated bytea; the definition text is the readable form.
    SELECT c.relname AS table_name, t.tgname,
           substring(pg_get_triggerdef(t.oid) from '''([^'']+)''') AS columns
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
     WHERE t.tgfoid = 'guard_posted_document_immutable'::regproc
  LOOP
    IF r.columns IS NULL THEN
      RAISE EXCEPTION 'trigger % on % passes no frozen-column list', r.tgname, r.table_name;
    END IF;
    FOREACH v_column IN ARRAY string_to_array(r.columns, ',')
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = r.table_name
           AND column_name = trim(v_column))
      THEN
        RAISE EXCEPTION
          'trigger % on % freezes column "%", which does not exist — the guard would silently do nothing',
          r.tgname, r.table_name, trim(v_column);
      END IF;
    END LOOP;
  END LOOP;
END $$;

CREATE TRIGGER invoice_lines_posted_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines FOR EACH ROW
  EXECUTE FUNCTION guard_posted_document_lines('invoice_id', 'invoices');

CREATE TRIGGER vendor_bill_lines_posted_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON vendor_bill_lines FOR EACH ROW
  EXECUTE FUNCTION guard_posted_document_lines('vendor_bill_id', 'vendor_bills');

CREATE TRIGGER credit_note_lines_posted_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON credit_note_lines FOR EACH ROW
  EXECUTE FUNCTION guard_posted_document_lines('credit_note_id', 'credit_notes');

-- ----------------------------------------------------------------------------
-- 6. Tenant scope and row-level security for the Phase 3 tables.
--
-- F-616's pattern: a child table that carries no tenant_id cannot have a policy,
-- so it gets one, backfilled from its parent. F-618's registry is the list
-- `db:verify` joins against in both directions.
-- ----------------------------------------------------------------------------
ALTER TABLE quote_lines            ADD COLUMN tenant_id uuid;
ALTER TABLE sales_order_lines      ADD COLUMN tenant_id uuid;
ALTER TABLE invoice_lines          ADD COLUMN tenant_id uuid;
ALTER TABLE credit_note_lines      ADD COLUMN tenant_id uuid;
ALTER TABLE purchase_order_lines   ADD COLUMN tenant_id uuid;
ALTER TABLE vendor_bill_lines      ADD COLUMN tenant_id uuid;
ALTER TABLE goods_receipt_lines    ADD COLUMN tenant_id uuid;
ALTER TABLE expense_items          ADD COLUMN tenant_id uuid;
ALTER TABLE contact_persons        ADD COLUMN tenant_id uuid;
ALTER TABLE tax_components         ADD COLUMN tenant_id uuid;
ALTER TABLE purchase_requisition_lines ADD COLUMN tenant_id uuid;

UPDATE quote_lines l          SET tenant_id = p.tenant_id FROM quotes p          WHERE p.id = l.quote_id;
UPDATE sales_order_lines l    SET tenant_id = p.tenant_id FROM sales_orders p    WHERE p.id = l.sales_order_id;
UPDATE invoice_lines l        SET tenant_id = p.tenant_id FROM invoices p        WHERE p.id = l.invoice_id;
UPDATE credit_note_lines l    SET tenant_id = p.tenant_id FROM credit_notes p    WHERE p.id = l.credit_note_id;
UPDATE purchase_order_lines l SET tenant_id = p.tenant_id FROM purchase_orders p WHERE p.id = l.purchase_order_id;
UPDATE vendor_bill_lines l    SET tenant_id = p.tenant_id FROM vendor_bills p    WHERE p.id = l.vendor_bill_id;
UPDATE goods_receipt_lines l  SET tenant_id = p.tenant_id FROM goods_receipts p  WHERE p.id = l.goods_receipt_id;
UPDATE expense_items l        SET tenant_id = p.tenant_id FROM expense_claims p  WHERE p.id = l.expense_claim_id;
UPDATE contact_persons l      SET tenant_id = p.tenant_id FROM contacts p        WHERE p.id = l.contact_id;
UPDATE tax_components l       SET tenant_id = p.tenant_id FROM tax_codes p       WHERE p.id = l.tax_code_id;
UPDATE purchase_requisition_lines l SET tenant_id = p.tenant_id FROM purchase_requisitions p
  WHERE p.id = l.requisition_id;

ALTER TABLE quote_lines            ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE sales_order_lines      ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE invoice_lines          ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE credit_note_lines      ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE purchase_order_lines   ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE vendor_bill_lines      ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE goods_receipt_lines    ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE expense_items          ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE contact_persons        ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE tax_components         ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE purchase_requisition_lines ALTER COLUMN tenant_id SET NOT NULL;

DO $$
DECLARE
  v_table text;
  v_tables text[] := ARRAY[
    'quotes','quote_lines','sales_orders','sales_order_lines','invoice_lines',
    'credit_notes','credit_note_lines','credit_note_applications',
    'customer_receipts','receipt_allocations','customer_refunds','ar_write_offs',
    'recurring_invoice_templates','customer_statements','payment_links','dunning_cases',
    'contact_persons','contact_bank_details',
    'purchase_requisitions','purchase_requisition_lines','purchase_orders','purchase_order_lines',
    'goods_receipts','goods_receipt_lines','vendor_bill_lines','bill_matches',
    'vendor_credits','vendor_credit_applications','expense_claims','expense_items',
    'payment_runs','vendor_payments','payment_allocations','payment_holds',
    'tax_codes','tax_components','tax_rates','tax_rules','tax_transactions',
    'tax_periods','tax_returns','tax_registrations','fiscal_positions','tax_overrides',
    'einvoice_submissions'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', v_table);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = app_current_tenant() OR app_rls_bypassed()) '
      'WITH CHECK (tenant_id = app_current_tenant() OR app_rls_bypassed())',
      v_table || '_tenant_isolation', v_table);
    INSERT INTO rls_protected_tables (table_name, phase, rationale)
      VALUES (v_table, 3, 'Phase 3 subledger: a tenant-scoped document or one of its lines (ADR-0002).')
      ON CONFLICT (table_name) DO NOTHING;
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 7. Gate C's privilege layer, extended to the subledger.
--
-- Same reasoning as 0025 on journal_lines: the trigger above is one control, and
-- a privilege the application does not hold is the other. The application never
-- deletes a posted document, so it never needs DELETE on the tables that hold
-- them. It does need UPDATE, because settlement moves.
-- ----------------------------------------------------------------------------
INSERT INTO schema_guard_requirements (id, statement, rationale, gate) VALUES
  ('revoke_document_delete',
   'REVOKE DELETE ON invoices, vendor_bills, credit_notes, vendor_credits, '
   'invoice_lines, vendor_bill_lines, credit_note_lines FROM app_runtime',
   'doc 01 rule 4: a posted document is corrected by credit note or reversal, never deleted. '
   'The lines are where the amounts the journal was built from actually live.',
   'Gate D'),
  ('revoke_tax_subledger_mutation',
   'REVOKE UPDATE, DELETE ON tax_transactions FROM app_runtime',
   'doc 07: the tax subledger is the evidence a filed return was built from. A correction is '
   'another transaction, never an edit.',
   'Gate D'),
  ('revoke_allocation_delete',
   'REVOKE DELETE ON receipt_allocations, payment_allocations, '
   'credit_note_applications, vendor_credit_applications FROM app_runtime',
   'Unallocation is a reversing allocation, so who applied what to which invoice, and when, '
   'survives (doc 04, doc 05).',
   'Gate G')
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id, statement FROM schema_guard_requirements
            WHERE id IN ('revoke_document_delete','revoke_tax_subledger_mutation','revoke_allocation_delete')
  LOOP
    -- Executed from the registry rather than written twice, so the row and the
    -- privilege cannot drift. 0025 learned this the hard way: 0006's revocations
    -- were a table of intentions that had never been run.
    EXECUTE r.statement;
    UPDATE schema_guard_requirements SET applied_at = now() WHERE id = r.id;
  END LOOP;
END $$;

CREATE TRIGGER goods_receipts_updated_at BEFORE UPDATE ON goods_receipts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE goods_receipt_lines IS
  'F-702: the receipt side of doc 05 three-way matching. Phase 5 inventory movements reference '
  'these lines; a receipt is a procurement fact and a movement is one of its consequences.';
COMMENT ON COLUMN invoices.amount_written_off IS
  'F-703: an invoice closes by payment, credit, write-off or a combination. The original CHECK '
  'admitted payment only, so a written-off invoice stayed open in the subledger while the GL had '
  'already moved.';
COMMENT ON COLUMN files.upload_state IS
  'F-705: the row exists from /files/upload-url, before any bytes do. PENDING until the client '
  'confirms; without it an abandoned upload looks exactly like an attachment.';
