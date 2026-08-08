-- =============================================================================
-- 0006 — Ledger guards: posted immutability and the balance assertion
-- =============================================================================
-- ADR-0003 §3 and §4. Resolves F-004 (S1) and F-005 (S2).
--
-- The blueprint deferred both to application code (notes 4 and 5). Gate C tests
-- them as binary pass/fail:
--   "Posted journal application role cannot UPDATE/DELETE protected accounting facts"
--   "Property tests cannot create an unbalanced POSTED journal"
-- Application code is not a control. Both are enforced here as well.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. Posted journal immutability — F-004
--
-- journal_entries permits exactly one transition after POSTED: to REVERSED, and
-- only the status/reversal columns may change. Everything else is frozen.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION guard_journal_entry_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('POSTED','REVERSED') THEN
      RAISE EXCEPTION
        'POSTED_IMMUTABLE: journal_entries % is % and cannot be deleted. Use reversal (doc 01 rule 4).',
        OLD.id, OLD.status USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status IN ('POSTED','REVERSED') THEN
    -- The single permitted transition: POSTED -> REVERSED, status and reversal
    -- bookkeeping only.
    IF NOT (OLD.status = 'POSTED' AND NEW.status = 'REVERSED') THEN
      RAISE EXCEPTION
        'POSTED_IMMUTABLE: journal_entries % is %; the only permitted change is POSTED -> REVERSED.',
        OLD.id, OLD.status USING ERRCODE = 'restrict_violation';
    END IF;
    IF ROW(NEW.tenant_id, NEW.legal_entity_id, NEW.accounting_book_id, NEW.journal_id,
           NEW.accounting_period_id, NEW.branch_id, NEW.entry_number, NEW.posting_date,
           NEW.document_date, NEW.source_type, NEW.source_id, NEW.source_event_id,
           NEW.posting_rule_version_id, NEW.base_currency, NEW.posted_at, NEW.posted_by)
       IS DISTINCT FROM
       ROW(OLD.tenant_id, OLD.legal_entity_id, OLD.accounting_book_id, OLD.journal_id,
           OLD.accounting_period_id, OLD.branch_id, OLD.entry_number, OLD.posting_date,
           OLD.document_date, OLD.source_type, OLD.source_id, OLD.source_event_id,
           OLD.posting_rule_version_id, OLD.base_currency, OLD.posted_at, OLD.posted_by)
    THEN
      RAISE EXCEPTION
        'POSTED_IMMUTABLE: journal_entries % - accounting facts cannot change when marking REVERSED.',
        OLD.id USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER journal_entries_immutable
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION guard_journal_entry_immutable();

-- Lines and their dimensions are frozen the moment the parent is posted; there
-- is no permitted transition at all.
CREATE OR REPLACE FUNCTION guard_journal_line_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_status journal_status;
  v_entry  uuid;
BEGIN
  v_entry := CASE TG_OP WHEN 'DELETE' THEN OLD.journal_entry_id ELSE NEW.journal_entry_id END;
  SELECT status INTO v_status FROM journal_entries WHERE id = v_entry;
  IF v_status IN ('POSTED','REVERSED') THEN
    RAISE EXCEPTION
      'POSTED_IMMUTABLE: % on journal_lines is not permitted; entry % is %.',
      TG_OP, v_entry, v_status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE TRIGGER journal_lines_immutable
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION guard_journal_line_immutable();

CREATE OR REPLACE FUNCTION guard_journal_line_dimension_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_status journal_status;
  v_line   uuid;
BEGIN
  v_line := CASE TG_OP WHEN 'DELETE' THEN OLD.journal_line_id ELSE NEW.journal_line_id END;
  SELECT je.status INTO v_status
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id
   WHERE jl.id = v_line;
  IF v_status IN ('POSTED','REVERSED') THEN
    RAISE EXCEPTION
      'POSTED_IMMUTABLE: % on journal_line_dimensions is not permitted; the parent entry is %.',
      TG_OP, v_status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE TRIGGER journal_line_dimensions_immutable
  BEFORE UPDATE OR DELETE ON journal_line_dimensions
  FOR EACH ROW EXECUTE FUNCTION guard_journal_line_dimension_immutable();

-- ----------------------------------------------------------------------------
-- 2. Balance assertion — F-005
--
-- Blueprint note 5 was right that a CHECK cannot express an aggregate over child
-- rows, and delegated to "a controlled posting function/service plus tests".
-- A DEFERRABLE INITIALLY DEFERRED constraint trigger CAN express it: it fires at
-- COMMIT, after every line is inserted.
--
-- doc 01 rule 2 / Gate C criterion 1: every posted journal balances in base.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_journal_balanced()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_debit  numeric(24,8);
  v_credit numeric(24,8);
  v_lines  integer;
BEGIN
  IF NEW.status <> 'POSTED' THEN
    RETURN NULL;                      -- drafts may be unbalanced (doc 03)
  END IF;

  SELECT coalesce(sum(base_debit),0), coalesce(sum(base_credit),0), count(*)
    INTO v_debit, v_credit, v_lines
    FROM journal_lines WHERE journal_entry_id = NEW.id;

  IF v_lines = 0 THEN
    RAISE EXCEPTION 'UNBALANCED_JOURNAL: entry % is POSTED with no lines.', NEW.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- F-001: zero-value lines are legal, but a journal of only zero lines is not.
  IF v_debit = 0 AND v_credit = 0 THEN
    RAISE EXCEPTION 'UNBALANCED_JOURNAL: entry % is POSTED with no non-zero line.', NEW.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF v_debit <> v_credit THEN
    RAISE EXCEPTION
      'UNBALANCED_JOURNAL: entry % debits % <> credits % in base currency %.',
      NEW.id, v_debit, v_credit, NEW.base_currency
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER journal_entries_balanced
  AFTER INSERT OR UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();

-- Every line's base currency must equal the entry's (ADR-0003 §6). Mixed
-- TRANSACTION currencies within one entry remain valid and are expected for FX
-- remeasurement, consolidation eliminations and foreign receipts with local fees.
CREATE OR REPLACE FUNCTION assert_line_base_currency()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_base char(3);
BEGIN
  SELECT base_currency INTO v_base FROM journal_entries WHERE id = NEW.journal_entry_id;
  IF NEW.base_currency <> v_base THEN
    RAISE EXCEPTION
      'BASE_CURRENCY_MISMATCH: line base currency % does not match entry base currency %.',
      NEW.base_currency, v_base USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER journal_lines_base_currency
  BEFORE INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION assert_line_base_currency();

-- ----------------------------------------------------------------------------
-- 3. Application role privileges — the second layer Gate C tests directly.
--
-- Run once per environment after creating the runtime role. Kept here so the
-- requirement is versioned with the schema rather than living in a runbook.
--
--   CREATE ROLE app_runtime LOGIN PASSWORD '...';
--   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
--   REVOKE UPDATE, DELETE ON journal_lines, journal_line_dimensions, audit_events
--     FROM app_runtime;
--   REVOKE DELETE ON journal_entries FROM app_runtime;
--
-- The posting path runs as a SECURITY DEFINER function owned by the schema
-- owner, so the runtime role never needs the revoked privileges.
-- ----------------------------------------------------------------------------
CREATE TABLE schema_guard_requirements (
  id          text PRIMARY KEY,
  statement   text NOT NULL,
  rationale   text NOT NULL,
  gate        text NOT NULL
);
INSERT INTO schema_guard_requirements (id, statement, rationale, gate) VALUES
  ('revoke_line_mutation',
   'REVOKE UPDATE, DELETE ON journal_lines, journal_line_dimensions FROM app_runtime',
   'F-004 / ADR-0003: posted lines must be immutable under the normal application DB credentials.',
   'Gate C'),
  ('revoke_entry_delete',
   'REVOKE DELETE ON journal_entries FROM app_runtime',
   'F-004: posted history is corrected by reversal, never deleted (doc 01 rule 4).',
   'Gate C'),
  ('revoke_audit_mutation',
   'REVOKE UPDATE, DELETE ON audit_events FROM app_runtime',
   'F-043: doc 16 requires the audit log to be immutable.',
   'Gate B');

COMMENT ON TABLE schema_guard_requirements IS
  'Privilege statements that must be applied per environment. CI asserts each has been executed '
  'against staging and production before a release passes Gate C.';

COMMENT ON FUNCTION assert_journal_balanced() IS
  'F-005: blueprint note 5 correctly observed a CHECK cannot express this, then deferred it to '
  'application code. A deferred constraint trigger can, and Gate C is far stronger when the '
  'database also refuses.';
