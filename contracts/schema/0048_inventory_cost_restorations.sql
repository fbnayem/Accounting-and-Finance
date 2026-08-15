-- =============================================================================
-- 0048 — F-923: a reversed issue gives its value back, as a stored fact
-- =============================================================================
-- Phase 5's one knowingly shipped defect, and the other half of F-922.
--
-- F-922 made the weighted-average valuation received-minus-issued over stored,
-- immutable facts: Σ round(original_quantity × unit_cost) over the layers, less
-- Σ total_cost over `inventory_cost_consumptions`. That is the GL control
-- balance by construction — each receipt debits Inventory by the layer's
-- once-rounded value, each issue credits it by exactly the consumption rows it
-- wrote.
--
-- Reversal broke the identity in the other direction. `restoreConsumedLayers`
-- gives back the layer QUANTITIES an issue drew down and writes no offsetting
-- cost fact, while the reversal journal debits Inventory by the reversed COGS.
-- The GL goes back up; received-minus-issued does not, because the consumption
-- rows are still standing and nothing says they were undone. Measured over
-- HTTP on the doc 08 worked example — 100 @ 2.00 + 150 @ 2.20, issue 120 at an
-- average of exactly 2.12 — the reconciliation reported a `difference` and an
-- `unexplained` of 254.40 with no reconciling item able to name either, and the
-- next issue of that item priced off the stale 275.60 pool and cost 132.29
-- where 254.40 was correct. No rounding is involved in any of those figures.
--
-- It was not a regression. Before F-922 the valuation was Σ(remaining ×
-- unit_cost), which re-agreed after a FULL reversal and disagreed between the
-- issue and its reversal; after F-922 it agrees between them and disagrees
-- afterwards. Neither expression handled both, because the fact that a
-- consumption had been undone was never stored anywhere. This migration stores
-- it.
--
-- -----------------------------------------------------------------------------
-- The shape, and the one rejected
-- -----------------------------------------------------------------------------
-- REJECTED: drop `inventory_cost_consumptions.CHECK (quantity > 0)` and let a
-- restoration be a NEGATIVE consumption, keeping one table as the reproduction
-- path. Three reasons, in order of weight:
--
--   1. It cannot express the invariant that matters. A restoration must give
--      back AT MOST what was consumed and AT MOST ONCE — otherwise the pool
--      exceeds what was ever received and the books balance to an invented
--      number. With signed rows nothing bounds the negative side: a second
--      restoration, or one larger than the consumption it reverses, is a
--      perfectly legal row, and `layer_remaining_bounded` (0012) would only
--      ever notice the QUANTITY half of it, never the value. In the shape
--      below, over-restoration is not checked, it is unrepresentable — the
--      restoration carries no amount of its own and is UNIQUE on the
--      consumption it reverses.
--   2. It weakens a live control on the common path to serve the rare one.
--      `quantity > 0` guards every row `consumeStock` writes; relaxing it to
--      `<> 0` admits a whole sign space in which a costing bug that passed a
--      movement's own (negative) quantity would write a valid row that RAISES
--      the pool instead of lowering it. That is this codebase's recurring
--      failure — a check that no longer has a subject — installed deliberately.
--   3. It would put two conventions in one column. The reversal of a RECEIPT
--      already writes POSITIVE consumption rows against its mirrored outbound
--      movement (`unwindCreatedLayers`), so a negative row on the mirrored
--      INBOUND movement of a reversed issue means the sign of `total_cost` is
--      readable only against the direction of the movement it hangs from.
--      Exit criterion 3 sums those rows.
--
-- CHOSEN: a separate fact, `inventory_cost_restorations`, carrying NO money.
-- One row says "this consumption was given back by that movement". Therefore:
--
--   * Exit criterion 3 is untouched. Σ total_cost over an issue movement's
--     consumption rows still reproduces the COGS that issue posted, because the
--     issue DID post it; the reversal is a separate event with its own journal,
--     and a correction that rewrote the original calculation would erase the
--     evidence rather than reverse it.
--   * There is one number, not two that can disagree. The restored value IS the
--     consumption's `total_cost`, read by join. Nothing is re-derived, so
--     nothing can be re-derived differently (ADR-0006).
--   * The valuation reads received − issued + restored, line for line the same
--     three postings the control account holds.
--
-- And it does not become a way around 0043's freeze of consumption rows. A
-- restoration is immutable itself, DELETE and UPDATE are revoked from
-- app_runtime, it can only ever cancel ONE consumption ONCE, and — the load
-- bearing part — `guard_cost_restoration_provenance` refuses any restoration
-- whose movement is not an inbound line of a document that is the declared
-- reversal of the very document the consumption's issue belongs to, with
-- `assert_restoration_document_posted` refusing at COMMIT one whose document
-- never reached POSTED. A row here cannot be conjured to make a consumption
-- disappear; it can only record the reversal that doc 08 already requires.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. The key F-913 needs the new child to reference.
--
-- 0042 gave every Phase 5 parent an (id, legal_entity_id) key so its children
-- could not disagree with it about the entity. `inventory_cost_consumptions`
-- was a leaf then and got none; it has a child now, and a restoration that
-- claimed a different entity than the consumption it cancels would move no
-- money out of balance — which is precisely why only a composite key notices.
-- ----------------------------------------------------------------------------
ALTER TABLE inventory_cost_consumptions
  ADD CONSTRAINT icc_scope_uq UNIQUE (id, legal_entity_id);

-- ----------------------------------------------------------------------------
-- 2. The fact itself.
--
-- No quantity, no unit cost, no total: the restored amounts are the
-- consumption's own, and duplicating them here would create two numbers that
-- can drift. `inventory_cost_consumption_id` is UNIQUE, so a consumption is
-- given back at most once, whatever writes the row.
-- ----------------------------------------------------------------------------
CREATE TABLE inventory_cost_restorations (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                     uuid NOT NULL REFERENCES tenants(id),
  -- No direct FK, like every other Phase 5 fact: the entity is pinned by the
  -- composite scope keys below, which say something stronger than "this entity
  -- exists" — that it is the SAME entity as the consumption and the movement.
  legal_entity_id               uuid NOT NULL,
  inventory_cost_consumption_id uuid NOT NULL UNIQUE
                                  REFERENCES inventory_cost_consumptions(id) ON DELETE RESTRICT,
  inventory_movement_id         uuid NOT NULL
                                  REFERENCES inventory_movements(id) ON DELETE RESTRICT,
  restored_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT icr_consumption_scope_fk
    FOREIGN KEY (inventory_cost_consumption_id, legal_entity_id)
    REFERENCES inventory_cost_consumptions(id, legal_entity_id),
  CONSTRAINT icr_movement_scope_fk
    FOREIGN KEY (inventory_movement_id, legal_entity_id)
    REFERENCES inventory_movements(id, legal_entity_id)
);

-- The two reads this table exists for: "has this consumption been given back?"
-- (covered by the UNIQUE) and "what did this reversal movement give back?".
CREATE INDEX inventory_cost_restorations_movement_idx
  ON inventory_cost_restorations(inventory_movement_id);

-- ----------------------------------------------------------------------------
-- 3. Provenance — the reason this is not a hole in F-915's freeze.
--
-- A restoration removes value from the issued side of the valuation, so being
-- able to write one at will would be exactly the "correct a posted calculation
-- by writing another row" that 0043 refuses on `inventory_cost_consumptions`.
-- The row is therefore only legal as part of the correction doc 08 names:
--
--   * the consumption's movement took stock OUT (an issue drew the layer down);
--   * the restoring movement puts the SAME ITEM back in; and
--   * the restoring movement's document declares itself the reversal of the
--     very document that issue belongs to.
--
-- Those last two columns are frozen by guard_posted_document_immutable (0043)
-- once the reversal posts, so the link cannot be re-pointed afterwards.
-- POSTED_IMMUTABLE is the prefix because the remedy is doc 01 rule 4's: correct
-- posted history by reversal, not by inventing a fact about it.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION guard_cost_restoration_provenance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_issue   record;
  v_restore record;
BEGIN
  SELECT m.id                     AS movement_id,
         m.item_id                AS item_id,
         m.quantity               AS quantity,
         m.inventory_document_id  AS document_id
    INTO v_issue
    FROM inventory_cost_consumptions c
    JOIN inventory_movements m ON m.id = c.inventory_movement_id
   WHERE c.id = NEW.inventory_cost_consumption_id;
  -- Raised rather than assumed. The foreign keys make this unreachable today,
  -- and a guard that passes silently when its subject is absent is the exact
  -- failure this codebase keeps meeting.
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'POSTED_IMMUTABLE: restoration names consumption %, which does not exist; there is nothing for it to give back.',
      NEW.inventory_cost_consumption_id USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT m.item_id        AS item_id,
         m.quantity       AS quantity,
         d.id             AS document_id,
         d.source_type    AS source_type,
         d.source_id      AS source_id
    INTO v_restore
    FROM inventory_movements m
    JOIN inventory_documents d ON d.id = m.inventory_document_id
   WHERE m.id = NEW.inventory_movement_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'POSTED_IMMUTABLE: restoration names movement %, which does not exist or has no document; nothing can have given anything back.',
      NEW.inventory_movement_id USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_issue.quantity >= 0 THEN
    RAISE EXCEPTION
      'POSTED_IMMUTABLE: consumption % hangs from movement %, which did not take stock out; only an issue can be given back.',
      NEW.inventory_cost_consumption_id, v_issue.movement_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_restore.quantity <= 0 OR v_restore.item_id <> v_issue.item_id THEN
    RAISE EXCEPTION
      'POSTED_IMMUTABLE: movement % must bring the same item back in to restore consumption %; a restoration is the mirror of the issue, not a note about it.',
      NEW.inventory_movement_id, NEW.inventory_cost_consumption_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_restore.source_type IS DISTINCT FROM 'reversal'
     OR v_restore.source_id IS DISTINCT FROM v_issue.document_id THEN
    RAISE EXCEPTION
      'POSTED_IMMUTABLE: document % is not the declared reversal of document %, so it cannot give back what that document issued (doc 08: correction creates reverse movement).',
      v_restore.document_id, v_issue.document_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER inventory_cost_restorations_provenance
  BEFORE INSERT ON inventory_cost_restorations FOR EACH ROW
  EXECUTE FUNCTION guard_cost_restoration_provenance();

-- A restoration is a posted accounting fact like the consumption it cancels:
-- there is no legitimate second version, and deleting one would take the value
-- back out of the valuation with no journal saying so. Same shared guard 0043
-- put on the consumptions themselves.
CREATE TRIGGER inventory_cost_restorations_immutable
  BEFORE UPDATE OR DELETE ON inventory_cost_restorations FOR EACH ROW
  EXECUTE FUNCTION reject_mutation_of_posted();

-- Deferred, like assert_transfer_balanced (0043) and for the same reason: the
-- reversal document is necessarily still DRAFT while its movements and
-- restorations are written — guard_posted_document_lines (0036) refuses to add
-- a movement to a POSTED document, so the status flip comes last — and an
-- immediate check would reject every legal reversal. At COMMIT the document
-- must have posted. A restoration standing against a draft that was never
-- posted would remove value from the valuation with no journal behind it.
CREATE OR REPLACE FUNCTION assert_restoration_document_posted()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_document uuid;
  v_status   document_status;
BEGIN
  SELECT d.id, d.status INTO v_document, v_status
    FROM inventory_movements m
    JOIN inventory_documents d ON d.id = m.inventory_document_id
   WHERE m.id = NEW.inventory_movement_id;
  IF NOT FOUND THEN
    RETURN NULL;                       -- the movement went away; the FK governs
  END IF;
  IF v_status NOT IN ('POSTED','CLOSED') THEN
    RAISE EXCEPTION
      'POSTED_IMMUTABLE: reversal document % is %; a consumption is only given back by a reversal that actually posted (doc 08).',
      v_document, v_status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER inventory_cost_restorations_document_posted
  AFTER INSERT ON inventory_cost_restorations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_restoration_document_posted();

-- ----------------------------------------------------------------------------
-- 4. F-914 — row-level security, on the new fact too.
--
-- ADR-0002, and 0042's exact pattern. A costing fact that RLS cannot reach is
-- the F-912 shape; the reproduction path acquiring an unprotected child would
-- reopen it one table along. Registered as well as enabled, so `db:verify`'s
-- both-directions check has a subject.
-- ----------------------------------------------------------------------------
ALTER TABLE inventory_cost_restorations ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_cost_restorations FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_cost_restorations_tenant_isolation ON inventory_cost_restorations
  USING (tenant_id = app_current_tenant() OR app_rls_bypassed())
  WITH CHECK (tenant_id = app_current_tenant() OR app_rls_bypassed());
INSERT INTO rls_protected_tables (table_name, phase, rationale)
  VALUES ('inventory_cost_restorations', 5,
          'F-923: the fact that a stored COGS consumption was given back by a reversal. It is '
          'read by every weighted-average valuation, so a tenant able to see or write another '
          'tenant''s rows could move that tenant''s inventory value (ADR-0002).')
  ON CONFLICT (table_name) DO NOTHING;

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

-- ----------------------------------------------------------------------------
-- 5. Gate C — the privilege half.
--
-- 0043 §6's reasoning, applied to a table whose whole content is set at INSERT:
-- the application reads restorations and writes them, and has no path that
-- edits or removes one, so it holds neither privilege. Registered AND executed
-- by the same `applied_at IS NULL` sweep 0043 introduced after the audit found
-- 0038 registering two revocations and executing neither — a requirement row is
-- an intention until something runs it.
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT ON inventory_cost_restorations TO app_runtime;

INSERT INTO schema_guard_requirements (id, statement, rationale, gate) VALUES
  ('revoke_cost_restoration_mutation',
   'REVOKE UPDATE, DELETE ON inventory_cost_restorations FROM app_runtime',
   'F-923: a restoration records that a posted COGS consumption was given back by a posted '
   'reversal. Every column is set once at INSERT; editing or deleting one would move inventory '
   'value with no journal behind it, which is what doc 08''s reverse-movement rule forbids.',
   'Gate C')
ON CONFLICT (id) DO NOTHING;

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

-- Asserted against the catalog, not against the statement above: the registry
-- says applied, so the catalog must agree (0025's habit, 0043's repetition).
-- Both directions — a revoke that took INSERT with it would make every reversal
-- of an issue fail, and that is the fault this migration exists to fix.
DO $$
BEGIN
  IF has_table_privilege('app_runtime', 'inventory_cost_restorations', 'UPDATE')
     OR has_table_privilege('app_runtime', 'inventory_cost_restorations', 'DELETE') THEN
    RAISE EXCEPTION
      'app_runtime retains UPDATE or DELETE on inventory_cost_restorations, which Gate C requires be revoked (F-923)';
  END IF;
  IF NOT has_table_privilege('app_runtime', 'inventory_cost_restorations', 'INSERT')
     OR NOT has_table_privilege('app_runtime', 'inventory_cost_restorations', 'SELECT') THEN
    RAISE EXCEPTION
      'app_runtime cannot record or read a cost restoration; reversing a stock issue would be impossible';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 6. Prove the columns the plpgsql above names actually exist.
--
-- 0038 §6 and 0043 §7: a column referenced by name inside plpgsql is not a
-- syntax error when it is misspelled — it is a runtime failure on the one
-- INSERT that mattered, long after the migration reported success.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_pair    text;
  v_pairs   text[] := ARRAY[
    'inventory_cost_restorations.inventory_cost_consumption_id',
    'inventory_cost_restorations.inventory_movement_id',
    'inventory_cost_restorations.legal_entity_id',
    'inventory_cost_restorations.tenant_id',
    'inventory_cost_consumptions.inventory_movement_id',
    'inventory_cost_consumptions.cost_layer_id',
    'inventory_cost_consumptions.total_cost',
    'inventory_movements.inventory_document_id',
    'inventory_movements.item_id',
    'inventory_movements.quantity',
    'inventory_documents.source_type',
    'inventory_documents.source_id',
    'inventory_documents.status'
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
    RAISE EXCEPTION '0048 references columns that do not exist: %', array_to_string(v_missing, ', ');
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 7. What the tables now say about themselves.
-- ----------------------------------------------------------------------------
COMMENT ON TABLE inventory_cost_restorations IS
  'F-923: the stored fact that a reversal gave back a consumption. It carries no amount — the '
  'restored value IS the consumption''s total_cost, read by join — so the weighted-average '
  'valuation is received - issued + restored over one set of numbers rather than two that can '
  'drift. UNIQUE on the consumption: a given consumption is given back at most once, which is '
  'what keeps a reversal from returning more value than the issue ever took.';
COMMENT ON COLUMN inventory_cost_restorations.inventory_movement_id IS
  'The inbound mirror movement of the reversal document, not the original issue. '
  'guard_cost_restoration_provenance requires its document to declare itself the reversal of the '
  'document the consumed issue belongs to.';
COMMENT ON FUNCTION guard_cost_restoration_provenance() IS
  'F-923: 0043 freezes consumption rows because a posted calculation has no second version. A '
  'restoration cancels one, so it must not be writable at will — it is legal only as the mirror '
  'line of the reversal doc 08 already requires, of the very document that issued.';
COMMENT ON FUNCTION assert_restoration_document_posted() IS
  'F-923: the reversal document is DRAFT while its restorations are written (0036 refuses to add '
  'a movement to a POSTED document), so the check is deferred to COMMIT, where a reversal that '
  'never posted cannot leave value removed from the issued side with no journal behind it.';
COMMENT ON CONSTRAINT icc_scope_uq ON inventory_cost_consumptions IS
  'F-913, one table later: the key a restoration references, so it cannot claim a different legal '
  'entity than the consumption it gives back.';
