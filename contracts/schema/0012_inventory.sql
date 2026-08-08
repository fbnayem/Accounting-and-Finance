-- =============================================================================
-- 0012 — Inventory, warehousing, costing and COGS
-- =============================================================================
-- Phase 5. Resolves F-031 (serial numbers not unique, movement direction
-- implicit), F-032 (cost layers could go negative, no concurrency protocol),
-- F-033 (item accounting mappings crossed a grain boundary).
-- ADR-0001: LIFO is prohibited under IFRS and absent from valuation_method.
-- =============================================================================

CREATE TABLE item_categories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  parent_id       uuid REFERENCES item_categories(id),
  code            text NOT NULL,
  name            text NOT NULL,
  status          record_status NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (organization_id, code)
);

CREATE TABLE units_of_measure (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  code            text NOT NULL,
  name            text NOT NULL,
  base_uom_code   text,
  conversion_factor numeric(24,8) NOT NULL DEFAULT 1 CHECK (conversion_factor > 0),
  UNIQUE (organization_id, code)
);

CREATE TABLE items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  item_category_id  uuid REFERENCES item_categories(id),
  sku               text NOT NULL,
  barcode           text,
  name              text NOT NULL,
  sales_description text,
  purchase_description text,
  kind              item_type NOT NULL,
  base_uom          text NOT NULL,
  valuation         valuation_method NOT NULL DEFAULT 'WEIGHTED_AVERAGE',
  lot_tracking      boolean NOT NULL DEFAULT false,
  serial_tracking   boolean NOT NULL DEFAULT false,
  expiry_tracking   boolean NOT NULL DEFAULT false,
  reorder_level     numeric(24,8),
  status            record_status NOT NULL DEFAULT 'ACTIVE',
  settings          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, sku),
  CONSTRAINT items_org_scope_fk FOREIGN KEY (organization_id, tenant_id) REFERENCES organizations(id, tenant_id),
  CONSTRAINT items_scope_uq UNIQUE (id, organization_id),
  CONSTRAINT items_tenant_uq UNIQUE (id, tenant_id)
);

-- F-033: the blueprint put inventory/COGS/revenue/purchase account columns on
-- the ORGANIZATION-scoped items table, pointing at accounts. An item shared
-- across two entities could not have correct per-entity mappings. Split out.
CREATE TABLE item_accounting_settings (
  item_id              uuid NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  legal_entity_id      uuid NOT NULL,
  inventory_account_id uuid,
  cogs_account_id      uuid,
  revenue_account_id   uuid,
  purchase_account_id  uuid,
  variance_account_id  uuid,
  sales_tax_code_id    uuid,
  purchase_tax_code_id uuid,
  valuation_override   valuation_method,
  PRIMARY KEY (item_id, legal_entity_id),
  CONSTRAINT ias_inventory_fk FOREIGN KEY (inventory_account_id, legal_entity_id) REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT ias_cogs_fk      FOREIGN KEY (cogs_account_id, legal_entity_id)      REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT ias_revenue_fk   FOREIGN KEY (revenue_account_id, legal_entity_id)   REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT ias_purchase_fk  FOREIGN KEY (purchase_account_id, legal_entity_id)  REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT ias_variance_fk  FOREIGN KEY (variance_account_id, legal_entity_id)  REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT ias_sales_tax_fk    FOREIGN KEY (sales_tax_code_id, legal_entity_id)    REFERENCES tax_codes(id, legal_entity_id),
  CONSTRAINT ias_purchase_tax_fk FOREIGN KEY (purchase_tax_code_id, legal_entity_id) REFERENCES tax_codes(id, legal_entity_id)
);

CREATE TABLE warehouses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL,
  branch_id       uuid REFERENCES branches(id),
  code            text NOT NULL,
  name            text NOT NULL,
  status          record_status NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (legal_entity_id, code),
  CONSTRAINT warehouses_entity_scope_fk FOREIGN KEY (legal_entity_id, tenant_id) REFERENCES legal_entities(id, tenant_id),
  CONSTRAINT warehouses_scope_uq UNIQUE (id, legal_entity_id)
);

CREATE TABLE warehouse_locations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id  uuid NOT NULL REFERENCES warehouses(id) ON DELETE RESTRICT,
  legal_entity_id uuid NOT NULL,
  parent_id     uuid REFERENCES warehouse_locations(id),
  code          text NOT NULL,
  name          text NOT NULL,
  kind          location_type NOT NULL DEFAULT 'STORAGE',
  status        record_status NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (warehouse_id, code),
  CONSTRAINT wl_warehouse_scope_fk FOREIGN KEY (warehouse_id, legal_entity_id) REFERENCES warehouses(id, legal_entity_id),
  CONSTRAINT wl_scope_uq UNIQUE (id, legal_entity_id)
);

CREATE TABLE stock_lots (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL,
  item_id        uuid NOT NULL REFERENCES items(id),
  lot_number     text NOT NULL,
  manufactured_on date,
  expires_on     date,
  supplier_id    uuid REFERENCES contacts(id),
  status         record_status NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (legal_entity_id, item_id, lot_number)
);
CREATE INDEX stock_lots_expiry_idx ON stock_lots(legal_entity_id, expires_on) WHERE expires_on IS NOT NULL;

-- F-031: doc 08 requires "prevent duplicate active serial ownership". The
-- blueprint had a bare `serial_number text` on movements with no constraint.
CREATE TABLE serial_units (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id       uuid NOT NULL,
  item_id               uuid NOT NULL REFERENCES items(id),
  serial_number         text NOT NULL,
  stock_lot_id          uuid REFERENCES stock_lots(id),
  current_location_id   uuid REFERENCES warehouse_locations(id),
  state                 text NOT NULL DEFAULT 'IN_STOCK'
    CHECK (state IN ('IN_STOCK','ISSUED','RETURNED','SCRAPPED','IN_TRANSIT')),
  received_at           timestamptz,
  issued_at             timestamptz,
  UNIQUE (legal_entity_id, item_id, serial_number)
);
-- One active owner per serial, enforced by the database.
CREATE UNIQUE INDEX serial_units_active_uq
  ON serial_units(legal_entity_id, item_id, serial_number) WHERE state = 'IN_STOCK';

-- ADR-0007: kept generic (uniform header + movements + optional accounting
-- entry), but document_type is now an ENUM and type-specific references are
-- enforced by CHECK rather than left nullable-and-hoped-for.
CREATE TABLE inventory_documents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id     uuid NOT NULL,
  accounting_book_id  uuid NOT NULL,
  branch_id           uuid REFERENCES branches(id),
  document_type       inventory_doc_type NOT NULL,
  document_number     text,
  document_date       date NOT NULL,
  posting_date        date NOT NULL,
  status              document_status NOT NULL DEFAULT 'DRAFT',
  warehouse_id        uuid REFERENCES warehouses(id),
  purchase_order_id   uuid REFERENCES purchase_orders(id),
  sales_order_id      uuid REFERENCES sales_orders(id),
  vendor_bill_id      uuid REFERENCES vendor_bills(id),
  invoice_id          uuid REFERENCES invoices(id),
  source_type         text,
  source_id           uuid,
  accounting_entry_id uuid REFERENCES journal_entries(id),
  approved_by         uuid REFERENCES users(id),
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- ADR-0007: type-specific invariants a generic table can still express.
  CONSTRAINT invdoc_receipt_needs_source
    CHECK (document_type <> 'RECEIPT' OR purchase_order_id IS NOT NULL OR source_type IS NOT NULL),
  CONSTRAINT invdoc_count_needs_warehouse
    CHECK (document_type <> 'COUNT' OR warehouse_id IS NOT NULL),
  CONSTRAINT invdoc_book_scope_fk FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id),
  CONSTRAINT invdoc_scope_uq UNIQUE (id, legal_entity_id)
);
CREATE UNIQUE INDEX inventory_documents_number_uq
  ON inventory_documents(legal_entity_id, document_number) WHERE document_number IS NOT NULL;

CREATE TABLE inventory_movements (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id        uuid NOT NULL,
  inventory_document_id  uuid NOT NULL REFERENCES inventory_documents(id) ON DELETE RESTRICT,
  line_no                integer NOT NULL,
  item_id                uuid NOT NULL REFERENCES items(id),
  from_location_id       uuid REFERENCES warehouse_locations(id),
  to_location_id         uuid REFERENCES warehouse_locations(id),
  movement_date          date NOT NULL,
  -- F-031: sign convention documented, and direction is no longer implicit.
  -- Positive = into the location; negative = out of it.
  quantity               numeric(24,8) NOT NULL CHECK (quantity <> 0),
  uom                    text NOT NULL,
  stock_lot_id           uuid REFERENCES stock_lots(id),
  serial_unit_id         uuid REFERENCES serial_units(id),
  unit_cost              numeric(24,8),
  total_cost             numeric(24,8),
  currency               char(3) REFERENCES currencies(code),
  cost_method            valuation_method,
  purchase_order_line_id uuid REFERENCES purchase_order_lines(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inventory_document_id, line_no),
  -- F-031: an inbound movement needs a destination, an outbound needs a source.
  CONSTRAINT movement_direction_has_location
    CHECK ((quantity > 0 AND to_location_id IS NOT NULL)
        OR (quantity < 0 AND from_location_id IS NOT NULL)),
  CONSTRAINT im_scope_uq UNIQUE (id, legal_entity_id)
);
CREATE INDEX inventory_movements_item_date_idx ON inventory_movements(item_id, movement_date);
CREATE INDEX inventory_movements_doc_idx ON inventory_movements(inventory_document_id);

ALTER TABLE bill_matches ADD CONSTRAINT bill_matches_grn_fk
  FOREIGN KEY (goods_receipt_line_id) REFERENCES inventory_movements(id);

-- ----------------------------------------------------------------------------
-- Cost layers — F-032.
-- The blueprint had no CHECK on remaining_quantity, so FIFO consumption could
-- silently drive it negative. Phase 5's exit criterion requires negative-stock
-- behaviour to follow policy UNDER CONCURRENCY, and Gate G tests "two stock
-- issues consume last quantity/cost layer".
--
-- ADR-0004 §3: consumption takes SELECT ... FOR UPDATE over the item's open
-- layers ordered by received_date, id. The CHECK below converts a silent
-- corruption into a loud failure if that protocol is ever bypassed.
-- ----------------------------------------------------------------------------
CREATE TABLE inventory_cost_layers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id     uuid NOT NULL,
  accounting_book_id  uuid NOT NULL,
  item_id             uuid NOT NULL REFERENCES items(id),
  warehouse_id        uuid REFERENCES warehouses(id),
  source_movement_id  uuid NOT NULL REFERENCES inventory_movements(id),
  received_date       date NOT NULL,
  original_quantity   numeric(24,8) NOT NULL CHECK (original_quantity > 0),
  remaining_quantity  numeric(24,8) NOT NULL CHECK (remaining_quantity >= 0),   -- F-032
  unit_cost           numeric(24,8) NOT NULL,
  currency            char(3) NOT NULL REFERENCES currencies(code),
  status              cost_layer_status NOT NULL DEFAULT 'OPEN',
  -- doc 08: where policy permits negative stock, an explicit provisional layer
  -- makes the exception visible in the valuation report instead of implicit.
  is_provisional      boolean NOT NULL DEFAULT false,
  settled_at          timestamptz,
  CONSTRAINT layer_remaining_bounded CHECK (remaining_quantity <= original_quantity),
  CONSTRAINT icl_book_scope_fk FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id)
);
-- The FIFO consumption order (ADR-0004 §3).
CREATE INDEX inventory_cost_layers_fifo_idx
  ON inventory_cost_layers(item_id, warehouse_id, received_date, id)
  WHERE remaining_quantity > 0;

CREATE TABLE inventory_cost_consumptions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cost_layer_id         uuid NOT NULL REFERENCES inventory_cost_layers(id) ON DELETE RESTRICT,
  inventory_movement_id uuid NOT NULL REFERENCES inventory_movements(id) ON DELETE RESTRICT,
  quantity              numeric(24,8) NOT NULL CHECK (quantity > 0),
  unit_cost             numeric(24,8) NOT NULL,
  total_cost            numeric(24,8) NOT NULL,
  UNIQUE (cost_layer_id, inventory_movement_id)
);
COMMENT ON TABLE inventory_cost_consumptions IS
  'Phase 5 exit criterion: "COGS is reproducible from stored cost layers/calculations." This table '
  'is that reproduction path.';

CREATE TABLE inventory_reservations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL,
  item_id         uuid NOT NULL REFERENCES items(id),
  warehouse_id    uuid REFERENCES warehouses(id),
  source_type     text NOT NULL,
  source_id       uuid NOT NULL,
  quantity        numeric(24,8) NOT NULL CHECK (quantity > 0),
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RELEASED','CONSUMED')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE landed_costs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id     uuid NOT NULL,
  accounting_book_id  uuid NOT NULL,
  document_number     text,
  posting_date        date NOT NULL,
  charge_type         text NOT NULL CHECK (charge_type IN ('FREIGHT','INSURANCE','DUTY','HANDLING','OTHER')),
  allocation_basis    text NOT NULL CHECK (allocation_basis IN ('VALUE','QUANTITY','WEIGHT','VOLUME','MANUAL')),
  currency            char(3) NOT NULL REFERENCES currencies(code),
  amount              numeric(24,8) NOT NULL CHECK (amount > 0),
  vendor_bill_id      uuid REFERENCES vendor_bills(id),
  status              document_status NOT NULL DEFAULT 'DRAFT',
  accounting_entry_id uuid REFERENCES journal_entries(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lc_book_scope_fk FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id)
);

CREATE TABLE landed_cost_allocations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landed_cost_id        uuid NOT NULL REFERENCES landed_costs(id) ON DELETE RESTRICT,
  cost_layer_id         uuid REFERENCES inventory_cost_layers(id),
  inventory_movement_id uuid REFERENCES inventory_movements(id),
  allocated_amount      numeric(24,8) NOT NULL,
  -- doc 08 acceptance: "landed cost allocation totals exactly equal the landed
  -- cost document amount". Asserted below.
  cogs_adjustment       numeric(24,8) NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION assert_landed_cost_fully_allocated()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_sum numeric(24,8); v_amount numeric(24,8); v_id uuid;
BEGIN
  v_id := coalesce(NEW.landed_cost_id, OLD.landed_cost_id);
  SELECT coalesce(sum(allocated_amount),0) INTO v_sum FROM landed_cost_allocations WHERE landed_cost_id = v_id;
  SELECT amount INTO v_amount FROM landed_costs WHERE id = v_id AND status = 'POSTED';
  IF v_amount IS NOT NULL AND v_sum <> v_amount THEN
    RAISE EXCEPTION
      'LANDED_COST_UNALLOCATED: allocations % <> landed cost amount % for %.',
      v_sum, v_amount, v_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER landed_cost_allocations_complete
  AFTER INSERT OR UPDATE OR DELETE ON landed_cost_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_landed_cost_fully_allocated();

CREATE TABLE stock_counts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id       uuid NOT NULL,
  inventory_document_id uuid REFERENCES inventory_documents(id),
  warehouse_id          uuid NOT NULL REFERENCES warehouses(id),
  count_date            date NOT NULL,
  scope                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                text NOT NULL DEFAULT 'PLANNED'
    CHECK (status IN ('PLANNED','COUNTING','RECOUNT','REVIEW','APPROVED','POSTED','CANCELLED')),
  approved_by           uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stock_count_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_count_id    uuid NOT NULL REFERENCES stock_counts(id) ON DELETE RESTRICT,
  item_id           uuid NOT NULL REFERENCES items(id),
  location_id       uuid REFERENCES warehouse_locations(id),
  stock_lot_id      uuid REFERENCES stock_lots(id),
  expected_quantity numeric(24,8) NOT NULL,
  counted_quantity  numeric(24,8),
  variance_quantity numeric(24,8),
  recount_required  boolean NOT NULL DEFAULT false,
  counted_by        uuid REFERENCES users(id),
  UNIQUE (stock_count_id, item_id, location_id, stock_lot_id)
);

-- Rebuildable projection, never a source of truth.
CREATE TABLE inventory_on_hand (
  legal_entity_id uuid NOT NULL,
  item_id         uuid NOT NULL,
  warehouse_id    uuid NOT NULL,
  quantity        numeric(24,8) NOT NULL DEFAULT 0,
  value           numeric(24,8) NOT NULL DEFAULT 0,
  currency        char(3) NOT NULL REFERENCES currencies(code),
  rebuilt_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (legal_entity_id, item_id, warehouse_id)
);

ALTER TABLE invoice_lines     ADD CONSTRAINT invoice_lines_item_fk FOREIGN KEY (item_id) REFERENCES items(id);
ALTER TABLE vendor_bill_lines ADD CONSTRAINT vbl_item_fk           FOREIGN KEY (item_id) REFERENCES items(id);
ALTER TABLE sales_order_lines ADD CONSTRAINT sol_item_fk           FOREIGN KEY (item_id) REFERENCES items(id);
ALTER TABLE purchase_order_lines ADD CONSTRAINT pol_item_fk        FOREIGN KEY (item_id) REFERENCES items(id);
ALTER TABLE purchase_requisition_lines ADD CONSTRAINT prl_item_fk  FOREIGN KEY (item_id) REFERENCES items(id);

COMMENT ON CONSTRAINT layer_remaining_bounded ON inventory_cost_layers IS
  'F-032: the blueprint had no bound at all, so FIFO consumption could drive remaining_quantity '
  'negative under the concurrency Gate G explicitly tests.';
