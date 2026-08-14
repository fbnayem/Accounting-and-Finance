-- =============================================================================
-- 0043 — Phase 5 guards: movement immutability, depreciation lock, budget
--        lines, transfer balance, negative-stock policy, Gate C privileges
-- =============================================================================
-- Phase 5, beside 0042's isolation work. Each of these is a rule the project
-- plan states in prose and 0012/0013/0014 left to whoever wrote the UPDATE:
--
--   F-915  doc 08: "Posted movement is immutable; correction creates reverse
--          movement." Nothing enforced it — a posted inventory document, its
--          movements, its cost layers and its consumptions were all freely
--          editable, and the journal they produced would never hear about it.
--   F-916  0013's comment claims UNIQUE (asset_book_id, accounting_period_id)
--          makes depreciation idempotency "structural". A unique index
--          constrains INSERT; a rerun that finds the existing SCHEDULED line
--          and UPDATEs posted_amount/journal_entry_id never touches the index
--          and posts twice. Exit criterion 5 was not enforced.
--   F-917  doc 10: "Never overwrite approved budget." guard_budget_versioning
--          (0014) protects four HEADER columns and none of the amounts: the
--          lines of an APPROVED budget were freely UPDATE-able and DELETE-able.
--   F-918  An inter-warehouse TRANSFER was not required to net to zero, so it
--          could create or destroy stock and value on its way between bins.
--   F-919  doc 08's negative-stock policy is "per item/location"; it existed
--          only as accounting_policies.allow_negative_stock, one entity-wide
--          boolean (0003).
--   F-920  Gate C privileges for the Phase 5 accounting facts — and the audit
--          found 0038 registered its two revocations in
--          schema_guard_requirements and never executed them: 0006's original
--          defect ("a table of intentions"), recurring.
--
-- Every guard here raises with a prefix packages/database/src/errors.ts can
-- map; a guard that fires as a 500 is indistinguishable from a bug (F-809).
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. F-915 — a posted inventory document is an accounting fact.
--
-- The header reuses guard_posted_document_immutable (0036): inventory_documents
-- shares document_status with the subledger documents, and its frozen list is
-- what the movement journal was built from. status stays mutable — that is how
-- the document's later life is recorded — and so does metadata.
-- ----------------------------------------------------------------------------
CREATE TRIGGER inventory_documents_posted_immutable
  BEFORE UPDATE OR DELETE ON inventory_documents FOR EACH ROW
  EXECUTE FUNCTION guard_posted_document_immutable(
    'tenant_id,legal_entity_id,accounting_book_id,document_type,document_number,document_date,posting_date,warehouse_id,purchase_order_id,sales_order_id,vendor_bill_id,invoice_id,source_type,source_id,accounting_entry_id');

-- The movements are the document's lines, which is where the quantities and
-- costs actually live. guard_posted_document_lines (0036) blocks INSERT as well:
-- a document whose journal is already written must not acquire a movement
-- afterwards. The posting service therefore writes movement costs BEFORE it
-- flips the document to POSTED, exactly as invoice posting has since 0036.
CREATE TRIGGER inventory_movements_posted_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON inventory_movements FOR EACH ROW
  EXECUTE FUNCTION guard_posted_document_lines('inventory_document_id', 'inventory_documents');

-- Cost layers cannot reuse the shared guard: a layer has no posted/draft life —
-- it exists because a posted movement created it — and parts of it are SUPPOSED
-- to move. remaining_quantity falls as issues consume it, status and settled_at
-- record that consumption, and a provisional layer (doc 08 negative stock) is
-- re-costed once at settlement. What freezes is what was received, from which
-- movement, and — once the cost is real — at what cost.
CREATE OR REPLACE FUNCTION guard_cost_layer_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'POSTED_IMMUTABLE: cost layer % is the stored evidence COGS is reproduced from and is never deleted. Correct it by reverse movement (doc 08).',
      OLD.id USING ERRCODE = 'restrict_violation';
  END IF;

  IF ROW(NEW.tenant_id, NEW.legal_entity_id, NEW.accounting_book_id, NEW.item_id,
         NEW.warehouse_id, NEW.source_movement_id, NEW.received_date,
         NEW.original_quantity, NEW.currency)
     IS DISTINCT FROM
     ROW(OLD.tenant_id, OLD.legal_entity_id, OLD.accounting_book_id, OLD.item_id,
         OLD.warehouse_id, OLD.source_movement_id, OLD.received_date,
         OLD.original_quantity, OLD.currency) THEN
    RAISE EXCEPTION
      'POSTED_IMMUTABLE: cost layer % records what was received and from where; those are accounting facts. Correct them by reverse movement (doc 08).',
      OLD.id USING ERRCODE = 'restrict_violation';
  END IF;

  -- Settlement is the one path that may re-cost a layer, and only a layer that
  -- was provisional to begin with (doc 08: "provisional costing and later cost
  -- settlement must be deterministic and visible").
  IF NEW.unit_cost IS DISTINCT FROM OLD.unit_cost AND NOT OLD.is_provisional THEN
    RAISE EXCEPTION
      'POSTED_IMMUTABLE: cost layer % is not provisional; consumed quantity was costed at its unit cost, and re-costing it would orphan that COGS (doc 08).',
      OLD.id USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER inventory_cost_layers_immutable
  BEFORE UPDATE OR DELETE ON inventory_cost_layers FOR EACH ROW
  EXECUTE FUNCTION guard_cost_layer_immutable();

-- A consumption row is the calculation itself — layer, quantity, cost — and the
-- Phase 5 exit criterion is that COGS is REPRODUCIBLE from it. There is no
-- legitimate second version of a calculation that already happened: a
-- correction is a reverse movement with consumptions of its own. So the whole
-- row freezes, with the shared guard from 0000.
CREATE TRIGGER inventory_cost_consumptions_immutable
  BEFORE UPDATE OR DELETE ON inventory_cost_consumptions FOR EACH ROW
  EXECUTE FUNCTION reject_mutation_of_posted();

-- ----------------------------------------------------------------------------
-- 2. F-916 — exit criterion 5, actually enforced.
--
-- The rerun 0013's UNIQUE cannot see: run one posts the line; run two finds it,
-- UPDATEs posted_amount and journal_entry_id to its own journal, and the index
-- never fires because nothing was inserted. Two journals, one line, and the
-- second quietly overwrote the evidence of the first. A POSTED line therefore
-- accepts no change at all — a rerun must find nothing to do, and a correction
-- is a reversing journal against the run, not an edit of the schedule.
-- SCHEDULED, SKIPPED and REVISED lines stay freely mutable; prospective
-- re-estimation (doc 09) lives there.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION guard_depreciation_line_posted()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'POSTED' THEN
    RAISE EXCEPTION
      'POSTED_IMMUTABLE: schedule line % for asset book % in period % is POSTED; the same asset/book/period cannot depreciate twice (doc 09). Correct it by reversing the run.',
      OLD.id, OLD.asset_book_id, OLD.accounting_period_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;

CREATE TRIGGER depreciation_schedule_lines_posted_locked
  BEFORE UPDATE OR DELETE ON depreciation_schedule_lines FOR EACH ROW
  EXECUTE FUNCTION guard_depreciation_line_posted();

-- 0013's table comment claimed the UNIQUE alone made idempotency structural.
-- That file is applied and checksummed, so the claim is corrected here, where
-- the guard that makes it true lives. The 0013 source text still overstates.
COMMENT ON TABLE depreciation_schedule_lines IS
  'The UNIQUE (asset_book_id, accounting_period_id) blocks a second line per asset book and period; '
  'guard_depreciation_line_posted (0043) blocks the rerun that UPDATEs the existing POSTED line. '
  'Depreciation idempotency (Phase 5 exit criterion, Gate G) is structural only with both.';

-- ----------------------------------------------------------------------------
-- 3. F-917 — the amounts of an approved budget.
--
-- guard_budget_versioning (0014) freezes version, fiscal year, currency and
-- scenario on the header. The amounts live in budget_lines, and doc 10's rule
-- is about the amounts: "Never overwrite approved budget. Revision creates a
-- new version while preserving Original Budget and Current Approved Budget."
-- INSERT is refused too — a line added to an approved budget changes the
-- approved total as surely as an edit does. Both sides of an UPDATE are
-- checked, so a line cannot be walked out of an approved budget into a draft
-- one and edited there.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION guard_budget_lines_versioned()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_budget uuid;
  v_status budget_status;
BEGIN
  SELECT b.id, b.status INTO v_budget, v_status
    FROM budgets b
   WHERE b.id IN (coalesce(NEW.budget_id, OLD.budget_id), coalesce(OLD.budget_id, NEW.budget_id))
     AND b.status IN ('APPROVED','ACTIVE','SUPERSEDED','CLOSED')
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      'BUDGET_IMMUTABLE: budget % is %; its lines are the approved amounts. Revise to create a new version (doc 10).',
      v_budget, v_status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;

CREATE TRIGGER budget_lines_versioned
  BEFORE INSERT OR UPDATE OR DELETE ON budget_lines FOR EACH ROW
  EXECUTE FUNCTION guard_budget_lines_versioned();

-- ----------------------------------------------------------------------------
-- 4. F-918 — a transfer relocates stock; it does not create or destroy it.
--
-- doc 08: "Inter-warehouse transfer maintains quantity traceability and no
-- revenue/expense unless entities differ." A TRANSFER document whose movements
-- do not net to zero per item is a receipt or an issue wearing a transfer's
-- accounting — no COGS, no gain — which is exactly how stock and value leak.
--
-- Deferred, like assert_split_children_sum (0038) and for the same reason: the
-- out and in movements arrive one INSERT at a time, and an immediate trigger
-- would reject the first half of every legal transfer. Checked only once the
-- document is posted: a DRAFT entered across several requests is legitimately
-- half-built between them, and the movements of a posted document are already
-- frozen above, so balance-at-posting is balance forever.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_transfer_balanced(p_document uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_doc record;
  v_bad record;
BEGIN
  SELECT document_type, status INTO v_doc
    FROM inventory_documents WHERE id = p_document;
  IF NOT FOUND THEN
    RETURN;                          -- document deleted; the FK governs that case
  END IF;
  IF v_doc.document_type <> 'TRANSFER' OR v_doc.status NOT IN ('POSTED','CLOSED') THEN
    RETURN;
  END IF;

  SELECT m.item_id, sum(m.quantity) AS net INTO v_bad
    FROM inventory_movements m
   WHERE m.inventory_document_id = p_document
   GROUP BY m.item_id
  HAVING sum(m.quantity) <> 0
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'TRANSFER_UNBALANCED: transfer document % moves a net quantity of % of item %; a transfer must net to zero per item (doc 08).',
      p_document, v_bad.net, v_bad.item_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION assert_transfer_movements_balanced()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_transfer_balanced(coalesce(NEW.inventory_document_id, OLD.inventory_document_id));
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION assert_transfer_document_balanced()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_transfer_balanced(NEW.id);
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER inventory_movements_transfer_balanced
  AFTER INSERT OR UPDATE OR DELETE ON inventory_movements
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_transfer_movements_balanced();

-- Both tables, deliberately: a document built DRAFT across earlier transactions
-- and posted later never touches its movements in the posting transaction, so a
-- movement-side trigger alone would let the unbalanced case straight through.
CREATE CONSTRAINT TRIGGER inventory_documents_transfer_balanced
  AFTER INSERT OR UPDATE ON inventory_documents
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_transfer_document_balanced();

-- ----------------------------------------------------------------------------
-- 5. F-919 — negative-stock policy, at the grain doc 08 requires.
--
-- "Default block. Optional per item/location policy can permit temporarily ...
-- enterprise default should remain block." accounting_policies.
-- allow_negative_stock (0003) stays as the entity-wide switch; the item now
-- carries its own policy, and item_accounting_settings carries a per-entity
-- override, nullable because unset means "inherit the item's". The consumption
-- service resolves override -> item -> entity, most specific wins; these
-- columns are the data that resolution reads, not the enforcement itself —
-- enforcement is layer_remaining_bounded (0012) plus the provisional-layer
-- path, which only a permitting policy may take.
-- ----------------------------------------------------------------------------
ALTER TABLE items ADD COLUMN negative_stock_policy text NOT NULL DEFAULT 'BLOCK'
  CONSTRAINT items_negative_stock_policy_chk
  CHECK (negative_stock_policy IN ('BLOCK','ALLOW_PROVISIONAL'));

ALTER TABLE item_accounting_settings ADD COLUMN negative_stock_policy text
  CONSTRAINT ias_negative_stock_policy_chk
  CHECK (negative_stock_policy IN ('BLOCK','ALLOW_PROVISIONAL'));

-- ----------------------------------------------------------------------------
-- 6. F-920 — Gate C's privilege layer, extended to the Phase 5 facts.
--
-- Same two-control reasoning as 0025 and 0036: the triggers above are one
-- control, and a privilege the application does not hold is the other. The
-- application never deletes a movement, a layer, a consumption or a posted
-- schedule line — correction is a reverse movement or a reversing run — so it
-- never needs DELETE on the tables that hold them. UPDATE stays: consumption
-- draws layers down, and settlement moves.
-- ----------------------------------------------------------------------------
INSERT INTO schema_guard_requirements (id, statement, rationale, gate) VALUES
  ('revoke_inventory_fact_delete',
   'REVOKE DELETE ON inventory_movements, inventory_cost_layers, inventory_cost_consumptions FROM app_runtime',
   'doc 08: posted movement is immutable and COGS must be reproducible from stored layers and '
   'consumptions. A correction is a reverse movement, never an erasure of what moved.',
   'Gate C'),
  ('revoke_depreciation_line_delete',
   'REVOKE DELETE ON depreciation_schedule_lines FROM app_runtime',
   'doc 09: the same asset/book/period cannot depreciate twice. Deleting the POSTED line and '
   'recreating it is the way around the UNIQUE that makes that structural.',
   'Gate C')
ON CONFLICT (id) DO NOTHING;

-- Executed by applied_at IS NULL rather than by naming this migration's ids:
-- 0038 inserted revoke_bank_transaction_delete and revoke_reconciliation_delete
-- and executed neither — 0006's "table of intentions", third occurrence — so
-- this sweep applies whatever any predecessor registered and left inert, then
-- records that it did.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id, statement FROM schema_guard_requirements
            WHERE applied_at IS NULL ORDER BY id
  LOOP
    EXECUTE r.statement;
    UPDATE schema_guard_requirements SET applied_at = now() WHERE id = r.id;
    RAISE NOTICE 'applied schema guard %', r.id;
  END LOOP;
END $$;

-- Stated as an assertion, not a comment (0025's habit): the registry says
-- applied, so the catalog must agree — including for 0038's two, which this
-- migration just caught up.
DO $$
BEGIN
  IF has_table_privilege('app_runtime', 'inventory_movements', 'DELETE')
     OR has_table_privilege('app_runtime', 'inventory_cost_layers', 'DELETE')
     OR has_table_privilege('app_runtime', 'inventory_cost_consumptions', 'DELETE')
     OR has_table_privilege('app_runtime', 'depreciation_schedule_lines', 'DELETE')
     OR has_table_privilege('app_runtime', 'bank_transactions', 'DELETE')
     OR has_table_privilege('app_runtime', 'bank_statements', 'DELETE')
     OR has_table_privilege('app_runtime', 'bank_reconciliations', 'DELETE')
     OR has_table_privilege('app_runtime', 'bank_matches', 'DELETE') THEN
    RAISE EXCEPTION 'app_runtime retains a DELETE privilege Gate C requires be revoked (F-920)';
  END IF;
  IF NOT has_table_privilege('app_runtime', 'inventory_cost_layers', 'UPDATE')
     OR NOT has_table_privilege('app_runtime', 'inventory_movements', 'INSERT') THEN
    RAISE EXCEPTION 'app_runtime cannot write inventory; posting a stock movement would be impossible';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 7. Prove the columns and frozen lists this migration names actually exist.
--
-- 0036's habit, kept twice over. First: every trigger on
-- guard_posted_document_immutable reads its frozen columns out of to_jsonb,
-- where a misspelled name compares NULL to NULL and freezes nothing, so the
-- lists — including the new inventory_documents one — are checked against the
-- catalog and a typo fails the migration rather than the audit.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  r        record;
  v_column text;
BEGIN
  FOR r IN
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

-- Second: the plpgsql above references columns by name, where a typo is not a
-- syntax error but a runtime failure on the one UPDATE that mattered (0038 §6).
DO $$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_pair text;
  v_pairs text[] := ARRAY[
    'inventory_documents.document_type',
    'inventory_documents.status',
    'inventory_movements.inventory_document_id',
    'inventory_movements.item_id',
    'inventory_movements.quantity',
    'inventory_cost_layers.source_movement_id',
    'inventory_cost_layers.original_quantity',
    'inventory_cost_layers.remaining_quantity',
    'inventory_cost_layers.unit_cost',
    'inventory_cost_layers.is_provisional',
    'inventory_cost_layers.received_date',
    'depreciation_schedule_lines.status',
    'depreciation_schedule_lines.asset_book_id',
    'depreciation_schedule_lines.accounting_period_id',
    'budget_lines.budget_id',
    'budgets.status',
    'items.negative_stock_policy',
    'item_accounting_settings.negative_stock_policy'
  ];
BEGIN
  FOREACH v_pair IN ARRAY v_pairs LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name  = split_part(v_pair, '.', 1)
         AND column_name = split_part(v_pair, '.', 2)
    ) THEN
      v_missing := v_missing || v_pair;
    END IF;
  END LOOP;
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '0043 references columns that do not exist: %', array_to_string(v_missing, ', ');
  END IF;
END $$;

COMMENT ON FUNCTION guard_depreciation_line_posted() IS
  'F-916: 0013''s UNIQUE constrains INSERT only. The rerun it cannot see finds the existing line '
  'and UPDATEs posted_amount/journal_entry_id — two journals, one line, the second overwriting the '
  'evidence of the first.';
COMMENT ON FUNCTION guard_budget_lines_versioned() IS
  'F-917: guard_budget_versioning (0014) protects four header columns and none of the amounts. '
  'doc 10''s "never overwrite approved budget" is about the amounts.';
COMMENT ON FUNCTION assert_transfer_balanced(uuid) IS
  'F-918: a TRANSFER whose movements do not net to zero per item is a receipt or an issue wearing '
  'a transfer''s accounting — no COGS, no gain — which is how stock and value leak between bins.';
COMMENT ON COLUMN items.negative_stock_policy IS
  'F-919: doc 08 requires the negative-stock policy per item/location with an enterprise default of '
  'BLOCK. accounting_policies.allow_negative_stock remains the entity switch; resolution is '
  'item_accounting_settings override, then this, then the entity.';
