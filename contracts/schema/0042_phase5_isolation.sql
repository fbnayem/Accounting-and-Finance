-- =============================================================================
-- 0042 — Phase 5 isolation: tenant scope, entity scope keys, row-level security
-- =============================================================================
-- Phase 5. 0012/0013/0014 built inventory, assets and projects correctly as
-- *structures* — F-031's serial ownership, F-032's negative cost layers and
-- F-033's grain split were all resolved there. What they did not do, because
-- Phase 5 had not arrived, is make the 38 tables safe to serve traffic from:
--
--   F-912  FOURTEEN of the 38 tables carry no tenant_id, so ADR-0002's policy
--          has no column to sit on and none of them could be RLS-protected.
--          F-802 was this defect once; this is the same defect fourteen times.
--   F-913  0012/0013/0014 declare scope keys that nothing references — six
--          UNIQUE scope keys with no referencing composite FK — so a cost
--          consumption can join entity A's layer to entity B's issue, and a
--          budget line can claim a different entity than its budget.
--   F-914  None of the 38 tables had row-level security.
--
-- Forward-only (ADR-0008): 0012–0014 are applied, so this adds beside them.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. F-912 (S1) — fourteen tables could not be tenant-scoped.
--
-- Added nullable, backfilled from the parent, then made NOT NULL, so the
-- migration is correct on a populated database as well as an empty one (Gate A:
-- "migrations apply forward on empty and representative populated databases").
-- Where the parent is itself one of the fourteen (depreciation_schedule_lines
-- under asset_books), the parent is filled first and the child inherits through
-- it, so the two cannot end up disagreeing about whose tenant they are.
--
-- project_phases and project_billing_rules gain tenant_id only:
-- projects.legal_entity_id is nullable by design (0014 — a project may span an
-- organization), so the children cannot honestly promise an entity. The
-- ADR-0002 policy needs only tenant_id.
-- ----------------------------------------------------------------------------
ALTER TABLE warehouse_locations         ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE item_accounting_settings    ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE inventory_cost_consumptions ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE inventory_cost_consumptions ADD COLUMN legal_entity_id uuid;
ALTER TABLE inventory_on_hand           ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE landed_cost_allocations     ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE landed_cost_allocations     ADD COLUMN legal_entity_id uuid;
ALTER TABLE stock_count_lines           ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE stock_count_lines           ADD COLUMN legal_entity_id uuid;
ALTER TABLE asset_books                 ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE depreciation_schedule_lines ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE asset_location_assignments  ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE asset_location_assignments  ADD COLUMN legal_entity_id uuid;
ALTER TABLE asset_custodian_assignments ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE asset_custodian_assignments ADD COLUMN legal_entity_id uuid;
ALTER TABLE budget_lines                ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE forecast_lines              ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE project_phases              ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE project_billing_rules       ADD COLUMN tenant_id uuid REFERENCES tenants(id);

UPDATE warehouse_locations l SET tenant_id = w.tenant_id
  FROM warehouses w WHERE w.id = l.warehouse_id;
UPDATE item_accounting_settings s SET tenant_id = i.tenant_id
  FROM items i WHERE i.id = s.item_id;
UPDATE inventory_cost_consumptions c SET tenant_id = y.tenant_id, legal_entity_id = y.legal_entity_id
  FROM inventory_cost_layers y WHERE y.id = c.cost_layer_id;
-- The projection has no single parent row; the entity it already carries in its
-- primary key knows its tenant.
UPDATE inventory_on_hand h SET tenant_id = e.tenant_id
  FROM legal_entities e WHERE e.id = h.legal_entity_id;
UPDATE landed_cost_allocations a SET tenant_id = lc.tenant_id, legal_entity_id = lc.legal_entity_id
  FROM landed_costs lc WHERE lc.id = a.landed_cost_id;
UPDATE stock_count_lines l SET tenant_id = sc.tenant_id, legal_entity_id = sc.legal_entity_id
  FROM stock_counts sc WHERE sc.id = l.stock_count_id;
UPDATE asset_books b SET tenant_id = a.tenant_id
  FROM fixed_assets a WHERE a.id = b.fixed_asset_id;
UPDATE depreciation_schedule_lines l SET tenant_id = b.tenant_id
  FROM asset_books b WHERE b.id = l.asset_book_id;
UPDATE asset_location_assignments x SET tenant_id = a.tenant_id, legal_entity_id = a.legal_entity_id
  FROM fixed_assets a WHERE a.id = x.fixed_asset_id;
UPDATE asset_custodian_assignments x SET tenant_id = a.tenant_id, legal_entity_id = a.legal_entity_id
  FROM fixed_assets a WHERE a.id = x.fixed_asset_id;
UPDATE budget_lines l SET tenant_id = b.tenant_id
  FROM budgets b WHERE b.id = l.budget_id;
UPDATE forecast_lines l SET tenant_id = v.tenant_id
  FROM forecast_versions v WHERE v.id = l.forecast_version_id;
UPDATE project_phases p SET tenant_id = j.tenant_id
  FROM projects j WHERE j.id = p.project_id;
UPDATE project_billing_rules r SET tenant_id = j.tenant_id
  FROM projects j WHERE j.id = r.project_id;

ALTER TABLE warehouse_locations         ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE item_accounting_settings    ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE inventory_cost_consumptions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE inventory_cost_consumptions ALTER COLUMN legal_entity_id SET NOT NULL;
ALTER TABLE inventory_on_hand           ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE landed_cost_allocations     ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE landed_cost_allocations     ALTER COLUMN legal_entity_id SET NOT NULL;
ALTER TABLE stock_count_lines           ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE stock_count_lines           ALTER COLUMN legal_entity_id SET NOT NULL;
ALTER TABLE asset_books                 ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE depreciation_schedule_lines ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE asset_location_assignments  ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE asset_location_assignments  ALTER COLUMN legal_entity_id SET NOT NULL;
ALTER TABLE asset_custodian_assignments ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE asset_custodian_assignments ALTER COLUMN legal_entity_id SET NOT NULL;
ALTER TABLE budget_lines                ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE forecast_lines              ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE project_phases              ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE project_billing_rules       ALTER COLUMN tenant_id SET NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. F-913 (S1) — the scope keys nothing referenced.
--
-- ADR-0002: the composite scope foreign key is the PRIMARY isolation mechanism,
-- because it needs no session state at all; RLS is the second layer. 0012–0014
-- declared the keys and no table referenced one, so every child below could
-- disagree with its parent about which entity it belongs to — cross-entity,
-- balanced, and undetectable until a control account failed to reconcile.
-- jl_account_scope_fk (0005) and bank_txn_account_scope_fk (0011) are the
-- pattern. Every constraint ends in _scope_fk so packages/database/src/errors.ts
-- maps a violation to CROSS_ENTITY_REFERENCE rather than a bare conflict.
-- ----------------------------------------------------------------------------
-- Parents that never declared a key to be referenced by.
ALTER TABLE inventory_cost_layers ADD CONSTRAINT icl_scope_uq UNIQUE (id, legal_entity_id);
ALTER TABLE landed_costs          ADD CONSTRAINT lc_scope_uq  UNIQUE (id, legal_entity_id);
ALTER TABLE stock_counts          ADD CONSTRAINT sc_scope_uq  UNIQUE (id, legal_entity_id);
ALTER TABLE stock_lots            ADD CONSTRAINT sl_scope_uq  UNIQUE (id, legal_entity_id);
ALTER TABLE forecast_versions     ADD CONSTRAINT fv_scope_uq  UNIQUE (id, legal_entity_id);
-- Projects are organization-scoped with an OPTIONAL entity, so their children
-- pin the tenant instead — the same reason items has items_tenant_uq.
ALTER TABLE projects              ADD CONSTRAINT projects_tenant_uq UNIQUE (id, tenant_id);

-- A document's source documents, warehouse and movements all belong to the
-- document's own entity.
ALTER TABLE inventory_documents
  ADD CONSTRAINT invdoc_warehouse_scope_fk FOREIGN KEY (warehouse_id, legal_entity_id)      REFERENCES warehouses(id, legal_entity_id),
  ADD CONSTRAINT invdoc_po_scope_fk        FOREIGN KEY (purchase_order_id, legal_entity_id) REFERENCES purchase_orders(id, legal_entity_id),
  ADD CONSTRAINT invdoc_so_scope_fk        FOREIGN KEY (sales_order_id, legal_entity_id)    REFERENCES sales_orders(id, legal_entity_id),
  ADD CONSTRAINT invdoc_bill_scope_fk      FOREIGN KEY (vendor_bill_id, legal_entity_id)    REFERENCES vendor_bills(id, legal_entity_id),
  ADD CONSTRAINT invdoc_invoice_scope_fk   FOREIGN KEY (invoice_id, legal_entity_id)        REFERENCES invoices(id, legal_entity_id);

ALTER TABLE inventory_movements
  ADD CONSTRAINT im_document_scope_fk      FOREIGN KEY (inventory_document_id, legal_entity_id)  REFERENCES inventory_documents(id, legal_entity_id),
  ADD CONSTRAINT im_from_location_scope_fk FOREIGN KEY (from_location_id, legal_entity_id)       REFERENCES warehouse_locations(id, legal_entity_id),
  ADD CONSTRAINT im_to_location_scope_fk   FOREIGN KEY (to_location_id, legal_entity_id)         REFERENCES warehouse_locations(id, legal_entity_id),
  ADD CONSTRAINT im_lot_scope_fk           FOREIGN KEY (stock_lot_id, legal_entity_id)           REFERENCES stock_lots(id, legal_entity_id),
  ADD CONSTRAINT im_pol_scope_fk           FOREIGN KEY (purchase_order_line_id, legal_entity_id) REFERENCES purchase_order_lines(id, legal_entity_id);

-- A location tree that crossed entities would let one entity's bin sit inside
-- another entity's warehouse.
ALTER TABLE warehouse_locations
  ADD CONSTRAINT wl_parent_scope_fk FOREIGN KEY (parent_id, legal_entity_id) REFERENCES warehouse_locations(id, legal_entity_id);

ALTER TABLE serial_units
  ADD CONSTRAINT su_location_scope_fk FOREIGN KEY (current_location_id, legal_entity_id) REFERENCES warehouse_locations(id, legal_entity_id),
  ADD CONSTRAINT su_lot_scope_fk      FOREIGN KEY (stock_lot_id, legal_entity_id)        REFERENCES stock_lots(id, legal_entity_id);

ALTER TABLE inventory_cost_layers
  ADD CONSTRAINT icl_movement_scope_fk  FOREIGN KEY (source_movement_id, legal_entity_id) REFERENCES inventory_movements(id, legal_entity_id),
  ADD CONSTRAINT icl_warehouse_scope_fk FOREIGN KEY (warehouse_id, legal_entity_id)       REFERENCES warehouses(id, legal_entity_id);

-- The F-913 exemplar: the consumption row is the join between a layer and the
-- issue that consumed it, and nothing required the two to share an entity.
ALTER TABLE inventory_cost_consumptions
  ADD CONSTRAINT icc_layer_scope_fk    FOREIGN KEY (cost_layer_id, legal_entity_id)         REFERENCES inventory_cost_layers(id, legal_entity_id),
  ADD CONSTRAINT icc_movement_scope_fk FOREIGN KEY (inventory_movement_id, legal_entity_id) REFERENCES inventory_movements(id, legal_entity_id);

ALTER TABLE inventory_reservations
  ADD CONSTRAINT ir_warehouse_scope_fk FOREIGN KEY (warehouse_id, legal_entity_id) REFERENCES warehouses(id, legal_entity_id);

ALTER TABLE inventory_on_hand
  ADD CONSTRAINT ioh_warehouse_scope_fk FOREIGN KEY (warehouse_id, legal_entity_id) REFERENCES warehouses(id, legal_entity_id);

ALTER TABLE landed_cost_allocations
  ADD CONSTRAINT lca_landed_cost_scope_fk FOREIGN KEY (landed_cost_id, legal_entity_id)        REFERENCES landed_costs(id, legal_entity_id),
  ADD CONSTRAINT lca_layer_scope_fk       FOREIGN KEY (cost_layer_id, legal_entity_id)         REFERENCES inventory_cost_layers(id, legal_entity_id),
  ADD CONSTRAINT lca_movement_scope_fk    FOREIGN KEY (inventory_movement_id, legal_entity_id) REFERENCES inventory_movements(id, legal_entity_id);

ALTER TABLE stock_counts
  ADD CONSTRAINT sc_warehouse_scope_fk FOREIGN KEY (warehouse_id, legal_entity_id)          REFERENCES warehouses(id, legal_entity_id),
  ADD CONSTRAINT sc_document_scope_fk  FOREIGN KEY (inventory_document_id, legal_entity_id) REFERENCES inventory_documents(id, legal_entity_id);

ALTER TABLE stock_count_lines
  ADD CONSTRAINT scl_count_scope_fk    FOREIGN KEY (stock_count_id, legal_entity_id) REFERENCES stock_counts(id, legal_entity_id),
  ADD CONSTRAINT scl_location_scope_fk FOREIGN KEY (location_id, legal_entity_id)    REFERENCES warehouse_locations(id, legal_entity_id),
  ADD CONSTRAINT scl_lot_scope_fk      FOREIGN KEY (stock_lot_id, legal_entity_id)   REFERENCES stock_lots(id, legal_entity_id);

-- item_accounting_settings' own parent: pins the tenant just backfilled from it,
-- and references items_tenant_uq — declared in 0012, referenced by nothing.
ALTER TABLE item_accounting_settings
  ADD CONSTRAINT ias_item_scope_fk FOREIGN KEY (item_id, tenant_id) REFERENCES items(id, tenant_id);

ALTER TABLE depreciation_schedule_lines
  ADD CONSTRAINT dsl_book_scope_fk FOREIGN KEY (asset_book_id, legal_entity_id) REFERENCES asset_books(id, legal_entity_id);

ALTER TABLE asset_transactions
  ADD CONSTRAINT at_asset_scope_fk FOREIGN KEY (fixed_asset_id, legal_entity_id) REFERENCES fixed_assets(id, legal_entity_id),
  ADD CONSTRAINT at_book_scope_fk  FOREIGN KEY (asset_book_id, legal_entity_id)  REFERENCES asset_books(id, legal_entity_id);

ALTER TABLE disposal_records
  ADD CONSTRAINT disp_asset_scope_fk FOREIGN KEY (fixed_asset_id, legal_entity_id) REFERENCES fixed_assets(id, legal_entity_id),
  ADD CONSTRAINT disp_book_scope_fk  FOREIGN KEY (asset_book_id, legal_entity_id)  REFERENCES asset_books(id, legal_entity_id);

ALTER TABLE asset_location_assignments
  ADD CONSTRAINT ala_asset_scope_fk    FOREIGN KEY (fixed_asset_id, legal_entity_id)        REFERENCES fixed_assets(id, legal_entity_id),
  ADD CONSTRAINT ala_location_scope_fk FOREIGN KEY (warehouse_location_id, legal_entity_id) REFERENCES warehouse_locations(id, legal_entity_id);

ALTER TABLE asset_custodian_assignments
  ADD CONSTRAINT aca_asset_scope_fk FOREIGN KEY (fixed_asset_id, legal_entity_id) REFERENCES fixed_assets(id, legal_entity_id);

-- The other F-913 exemplar: a budget line free to claim a different entity than
-- its budget, while every variance report groups by the line's own columns.
ALTER TABLE budget_lines
  ADD CONSTRAINT bl_budget_scope_fk FOREIGN KEY (budget_id, legal_entity_id) REFERENCES budgets(id, legal_entity_id);

ALTER TABLE forecast_versions
  ADD CONSTRAINT fv_book_scope_fk FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id),
  ADD CONSTRAINT fv_fy_scope_fk   FOREIGN KEY (fiscal_year_id, legal_entity_id)     REFERENCES fiscal_years(id, legal_entity_id);

ALTER TABLE forecast_lines
  ADD CONSTRAINT fl_version_scope_fk FOREIGN KEY (forecast_version_id, legal_entity_id) REFERENCES forecast_versions(id, legal_entity_id);

ALTER TABLE commitments
  ADD CONSTRAINT commitments_book_scope_fk FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id);

ALTER TABLE project_phases
  ADD CONSTRAINT pp_project_scope_fk FOREIGN KEY (project_id, tenant_id) REFERENCES projects(id, tenant_id);
ALTER TABLE project_billing_rules
  ADD CONSTRAINT pbr_project_scope_fk FOREIGN KEY (project_id, tenant_id) REFERENCES projects(id, tenant_id);
ALTER TABLE time_entries
  ADD CONSTRAINT te_project_scope_fk FOREIGN KEY (project_id, tenant_id) REFERENCES projects(id, tenant_id);
ALTER TABLE billing_proposals
  ADD CONSTRAINT bp_project_scope_fk FOREIGN KEY (project_id, tenant_id) REFERENCES projects(id, tenant_id),
  ADD CONSTRAINT bp_invoice_scope_fk FOREIGN KEY (invoice_id, legal_entity_id) REFERENCES invoices(id, legal_entity_id);

-- ----------------------------------------------------------------------------
-- 3. F-914 (S1) — row-level security, on all 38 Phase 5 tables.
--
-- ADR-0002. Registered in `rls_protected_tables` rather than in a list inside a
-- script, so `pnpm db:verify` joins the catalog against the registry in both
-- directions and a table that is registered but unprotected fails the build just
-- as loudly as one that is protected but unregistered (F-618).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_table text;
  v_tables text[] := ARRAY[
    'item_categories','units_of_measure','items','item_accounting_settings',
    'warehouses','warehouse_locations','stock_lots','serial_units',
    'inventory_documents','inventory_movements','inventory_cost_layers',
    'inventory_cost_consumptions','inventory_reservations','landed_costs',
    'landed_cost_allocations','stock_counts','stock_count_lines','inventory_on_hand',
    'asset_categories','fixed_assets','asset_books','depreciation_runs',
    'depreciation_schedule_lines','asset_transactions','asset_location_assignments',
    'asset_custodian_assignments','disposal_records',
    'projects','project_phases','time_entries','project_billing_rules',
    'billing_proposals','budgets','budget_lines','commitments',
    'forecast_versions','forecast_lines','allocation_rules'
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
      VALUES (v_table, 5, 'Phase 5 inventory/assets/projects: a tenant-scoped operational or costing fact (ADR-0002).')
      ON CONFLICT (table_name) DO NOTHING;
  END LOOP;
END $$;

-- Both directions, asserted here as well as in db:verify, so this migration
-- cannot install a registry that disagrees with what it just did (0029's habit).
DO $$
DECLARE
  problem text;
BEGIN
  SELECT string_agg(t.table_name, ', ') INTO problem
    FROM rls_protected_tables t
    LEFT JOIN pg_class c ON c.relname = t.table_name AND c.relkind = 'r'
   WHERE c.oid IS NULL OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'registered for RLS but not enabled and forced: %', problem;
  END IF;

  SELECT string_agg(c.relname, ', ') INTO problem
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    LEFT JOIN rls_protected_tables t ON t.table_name = c.relname
   WHERE c.relkind = 'r' AND c.relrowsecurity AND t.table_name IS NULL;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'row-level security is enabled but the table is not registered: %', problem;
  END IF;
END $$;

COMMENT ON COLUMN inventory_cost_consumptions.tenant_id IS
  'F-912: the table doc 08''s "COGS is reproducible from stored cost layers/calculations" criterion '
  'rests on had no tenant column, so the reproduction path was the one place RLS could not reach.';
COMMENT ON CONSTRAINT icc_layer_scope_fk ON inventory_cost_consumptions IS
  'F-913: the consumption row joins a layer to the issue that consumed it, and nothing required the '
  'two to share a legal entity. Cross-entity COGS moves no money out of balance, so only a '
  'composite key notices.';
COMMENT ON CONSTRAINT bl_budget_scope_fk ON budget_lines IS
  'F-913: a budget line could claim a different entity than its budget, and every variance and '
  'budget-control read groups by the line''s own columns.';
