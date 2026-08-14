-- =============================================================================
-- 0038 — Banking runtime: tenant scope, the finalization rule, split integrity
-- =============================================================================
-- Phase 4. 0011 built the banking tables correctly as *structures* — F-028's
-- dedupe inversion, F-029's unbounded matches and F-030's unlocked sessions were
-- all resolved there. What it did not do, because Phase 4 had not arrived, is
-- make them safe to serve traffic from:
--
--   F-801  A reconciliation could be COMPLETED with any difference at all.
--   F-802  `bank_balance_snapshots` had no tenant column, so it could not be
--          row-level-security protected and cash position read every tenant.
--   F-803  A split transaction's children were not constrained against their
--          parent, and the parent stayed matchable beside them.
--   F-804  None of the eleven banking tables had RLS.
--
-- Forward-only (ADR-0008): 0011 is applied, so this adds beside it.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. F-802 (S1) — bank_balance_snapshots could not be tenant-scoped.
--
-- The table carried `bank_account_id` and nothing else identifying. Every other
-- banking table has `tenant_id`; this one was reachable only by joining out to
-- `bank_accounts`, which means the ADR-0002 policy — `tenant_id =
-- app_current_tenant()` — had no column to sit on. doc 06 makes this table the
-- source of the *bank-side* half of cash position, so the leak would have been
-- every tenant's actual bank balances.
--
-- Backfilled from the owning account rather than defaulted: a snapshot belongs to
-- exactly one bank account, and that account already knows its tenant.
-- ----------------------------------------------------------------------------
ALTER TABLE bank_balance_snapshots ADD COLUMN IF NOT EXISTS tenant_id       uuid;
ALTER TABLE bank_balance_snapshots ADD COLUMN IF NOT EXISTS legal_entity_id uuid;

UPDATE bank_balance_snapshots s
   SET tenant_id       = a.tenant_id,
       legal_entity_id = a.legal_entity_id
  FROM bank_accounts a
 WHERE a.id = s.bank_account_id
   AND (s.tenant_id IS NULL OR s.legal_entity_id IS NULL);

ALTER TABLE bank_balance_snapshots ALTER COLUMN tenant_id       SET NOT NULL;
ALTER TABLE bank_balance_snapshots ALTER COLUMN legal_entity_id SET NOT NULL;
ALTER TABLE bank_balance_snapshots
  ADD CONSTRAINT bbs_tenant_fk  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  ADD CONSTRAINT bbs_account_scope_fk
    FOREIGN KEY (bank_account_id, legal_entity_id) REFERENCES bank_accounts(id, legal_entity_id);

-- Same for bank_statements and bank_matches, which had tenant_id but no entity:
-- every read in this phase filters by entity, and without the column each one
-- joins out to prove something the row could have carried.
ALTER TABLE bank_statements ADD COLUMN IF NOT EXISTS legal_entity_id uuid;
UPDATE bank_statements s SET legal_entity_id = a.legal_entity_id
  FROM bank_accounts a WHERE a.id = s.bank_account_id AND s.legal_entity_id IS NULL;
ALTER TABLE bank_statements ALTER COLUMN legal_entity_id SET NOT NULL;
ALTER TABLE bank_statements
  ADD CONSTRAINT bank_statements_account_scope_fk
    FOREIGN KEY (bank_account_id, legal_entity_id) REFERENCES bank_accounts(id, legal_entity_id);

ALTER TABLE bank_matches ADD COLUMN IF NOT EXISTS legal_entity_id uuid;
UPDATE bank_matches m SET legal_entity_id = t.legal_entity_id
  FROM bank_transactions t WHERE t.id = m.bank_transaction_id AND m.legal_entity_id IS NULL;
ALTER TABLE bank_matches ALTER COLUMN legal_entity_id SET NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. F-801 (S2) — "finalization allowed only when difference is zero or within
--    the configured tolerance" (doc 06) was enforced by nothing.
--
-- 0011's CHECK reads `status <> 'COMPLETED' OR (difference IS NOT NULL AND
-- book_closing_balance IS NOT NULL)` — it asserts the columns were *populated*,
-- not that they *reconcile*. A session could be completed showing a difference of
-- 500 and the row was accepted; proved by execution before this was written.
--
-- `accounting_policies.bank_reconciliation_tolerance` has existed since 0003 and
-- nothing had ever read it. Phase 4's second exit criterion — "statement ending
-- balance equals reconciled book balance after adjustments" — was therefore not
-- expressible as a pass or a fail.
--
-- A CHECK cannot do this: the tolerance lives in another table, and which policy
-- row applies depends on the entity and the date. So it is a trigger, and it also
-- re-derives `difference` rather than trusting the caller's arithmetic — a client
-- that computes its own difference of zero is exactly the client this guards
-- against.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION guard_reconciliation_balanced()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_tolerance numeric(24,8);
  v_expected  numeric(24,8);
BEGIN
  IF NEW.status <> 'COMPLETED' THEN
    RETURN NEW;
  END IF;
  -- Re-entering COMPLETED from COMPLETED is handled by guard_reconciliation_locked;
  -- this fires on the transition that matters.
  IF TG_OP = 'UPDATE' AND OLD.status = 'COMPLETED' THEN
    RETURN NEW;
  END IF;

  IF NEW.book_closing_balance IS NULL THEN
    RAISE EXCEPTION
      'RECONCILIATION_UNBALANCED: session % cannot complete without a book closing balance.',
      NEW.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  v_expected := NEW.statement_closing_balance - NEW.book_closing_balance;

  IF NEW.difference IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION
      'RECONCILIATION_UNBALANCED: session % reports a difference of % but statement % minus book % is %.',
      NEW.id, NEW.difference, NEW.statement_closing_balance, NEW.book_closing_balance, v_expected
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT p.bank_reconciliation_tolerance INTO v_tolerance
    FROM accounting_policies p
   WHERE p.legal_entity_id = NEW.legal_entity_id
     AND p.valid_from <= NEW.statement_end_date
     AND (p.valid_to IS NULL OR p.valid_to > NEW.statement_end_date)
   ORDER BY p.valid_from DESC
   LIMIT 1;

  -- No policy row is not permission to skip the rule. doc 06's default is zero.
  v_tolerance := coalesce(v_tolerance, 0);

  IF abs(v_expected) > v_tolerance THEN
    RAISE EXCEPTION
      'RECONCILIATION_UNBALANCED: session % has a difference of % against a tolerance of % (doc 06).',
      NEW.id, v_expected, v_tolerance
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER bank_reconciliations_balanced
  BEFORE INSERT OR UPDATE ON bank_reconciliations
  FOR EACH ROW EXECUTE FUNCTION guard_reconciliation_balanced();

-- ----------------------------------------------------------------------------
-- 3. F-803 — split transactions could double-count cash.
--
-- doc 06 requires split handling and 0011 provides `parent_transaction_id` and a
-- SPLIT reconciliation state. Nothing connected the two: children could sum to
-- any amount, and the parent stayed matchable beside its own children. Matching
-- the parent for 100 and its two children for 60 and 40 books 200 of cash from
-- one bank line, and `bank_matches_bounded` does not see it because it bounds
-- each transaction against its own amount.
--
-- Deferred, like the journal balance assertion in 0006 and for the same reason:
-- children arrive one INSERT at a time, and an immediate trigger would reject the
-- first child of every legal split.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_split_children_sum()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_parent uuid;
  v_parent_amount numeric(24,8);
  v_children numeric(24,8);
  v_count integer;
BEGIN
  v_parent := coalesce(NEW.parent_transaction_id, OLD.parent_transaction_id);
  IF v_parent IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT amount INTO v_parent_amount FROM bank_transactions WHERE id = v_parent;
  IF NOT FOUND THEN
    RETURN NULL;                     -- parent deleted; the FK governs that case
  END IF;

  SELECT coalesce(sum(amount), 0), count(*) INTO v_children, v_count
    FROM bank_transactions WHERE parent_transaction_id = v_parent;

  IF v_count > 0 AND v_children <> v_parent_amount THEN
    RAISE EXCEPTION
      'SPLIT_UNBALANCED: children of bank transaction % sum to % but the parent is %.',
      v_parent, v_children, v_parent_amount
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER bank_transactions_split_sums
  AFTER INSERT OR UPDATE OR DELETE ON bank_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_split_children_sum();

-- The other half: a parent that has been split is not itself a cash movement any
-- more, it is a container for the ones below it. Matching it double-counts.
CREATE OR REPLACE FUNCTION assert_split_parent_unmatched()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'CONFIRMED' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM bank_transactions
              WHERE parent_transaction_id = NEW.bank_transaction_id) THEN
    RAISE EXCEPTION
      'SPLIT_PARENT_NOT_MATCHABLE: bank transaction % is split; match its parts, not the whole.',
      NEW.bank_transaction_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER bank_matches_not_split_parent
  BEFORE INSERT OR UPDATE ON bank_matches
  FOR EACH ROW EXECUTE FUNCTION assert_split_parent_unmatched();

-- ----------------------------------------------------------------------------
-- 4. F-804 — row-level security, on all eleven banking tables.
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
    'bank_connections','bank_accounts','bank_statements','bank_transactions',
    'bank_rules','bank_reconciliations','bank_matches','bank_transfers',
    'settlement_batches','payment_clearing_items','bank_balance_snapshots'
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
      VALUES (v_table, 4, 'Phase 4 banking: a tenant-scoped bank fact (ADR-0002).')
      ON CONFLICT (table_name) DO NOTHING;
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 5. Gate C's privilege layer, extended to banking.
--
-- An imported bank transaction is evidence of what the bank said. The application
-- corrects it by splitting, ignoring or re-importing — never by deleting the
-- record of what arrived, because a reconciliation that balanced yesterday must
-- still be explainable tomorrow.
-- ----------------------------------------------------------------------------
INSERT INTO schema_guard_requirements (id, statement, rationale, gate) VALUES
  ('revoke_bank_transaction_delete',
   'REVOKE DELETE ON bank_transactions, bank_statements FROM app_runtime',
   'doc 06: an imported transaction is the evidence a reconciliation was built from. '
   'Deleting one silently invalidates every completed session that cleared it.',
   'Gate D'),
  ('revoke_reconciliation_delete',
   'REVOKE DELETE ON bank_reconciliations, bank_matches FROM app_runtime',
   'F-030: a completed session is locked and corrected by the permissioned reopen workflow. '
   'DELETE would be the way around the lock.',
   'Gate D')
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 6. Prove the columns this migration names actually exist.
--
-- 0036's habit, kept: the guards above reference columns by name from inside
-- plpgsql, where a typo is not a syntax error — it is a runtime failure on a code
-- path nobody exercises until it matters. This refuses to apply instead.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_pair text;
  v_pairs text[] := ARRAY[
    'bank_reconciliations.statement_closing_balance',
    'bank_reconciliations.book_closing_balance',
    'bank_reconciliations.statement_end_date',
    'bank_reconciliations.difference',
    'bank_reconciliations.legal_entity_id',
    'accounting_policies.bank_reconciliation_tolerance',
    'accounting_policies.valid_from',
    'accounting_policies.valid_to',
    'bank_transactions.parent_transaction_id',
    'bank_transactions.amount',
    'bank_matches.bank_transaction_id',
    'bank_matches.status',
    'bank_balance_snapshots.tenant_id',
    'bank_balance_snapshots.legal_entity_id'
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
    RAISE EXCEPTION '0038 references columns that do not exist: %', array_to_string(v_missing, ', ');
  END IF;
END $$;

COMMENT ON FUNCTION guard_reconciliation_balanced() IS
  'F-801: doc 06''s "finalization allowed only when difference is zero or within the configured '
  'tolerance". 0011''s CHECK asserted the balance columns were populated, not that they reconciled, '
  'so a session could be completed showing a difference of 500.';
