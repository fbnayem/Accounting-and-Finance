-- =============================================================================
-- 0032 — The draft-line writer
-- =============================================================================
-- F-619. Gate C's privilege revocation makes a DRAFT journal unwritable.
--
-- 0006 §3 revokes UPDATE and DELETE on journal_lines and journal_line_dimensions,
-- and DELETE on journal_entries, from the application role. That is exactly right
-- for posted history and exactly wrong for a draft: doc 03 says "Draft can be
-- edited", and editing a draft's lines means deleting the old ones. A privilege is
-- not row-aware, so the revocation that protects a POSTED entry also blocks an
-- entry that has never been posted at all.
--
-- 0006 anticipated this and wrote down the answer:
--
--   "The posting path runs as a SECURITY DEFINER function owned by the schema
--    owner, so the runtime role never needs the revoked privileges."
--
-- The function was never written, because until Phase 2 nothing wrote a journal
-- line. This is it, scoped as narrowly as the requirement allows: it deletes lines
-- from an UNPOSTED entry and nothing else. Inserting lines is not here, because
-- INSERT was never revoked and a function that could also insert would be a much
-- larger thing to trust.
--
-- SECURITY DEFINER is an RLS bypass by construction — it runs as the owner, who is
-- a superuser and therefore exempt from every policy in 0024 and 0029. So the tenant
-- check that RLS would have performed is performed here explicitly. Getting that
-- wrong would hand any authenticated user the ability to empty any tenant's draft,
-- which is precisely the hole row-level security exists to close.
-- =============================================================================

CREATE OR REPLACE FUNCTION ledger_clear_draft_lines(p_entry_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
-- Fixed search_path: without it, a caller who can create objects could shadow a
-- table name and have the owner execute their definition.
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status    journal_status;
  v_tenant    uuid;
  v_deleted   integer;
BEGIN
  SELECT status, tenant_id INTO v_status, v_tenant
    FROM journal_entries WHERE id = p_entry_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: journal entry % does not exist', p_entry_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- The check row-level security would have made. app_rls_bypassed() is honoured so
  -- migration, seeding and benchmarking keep working; everyone else must be inside
  -- the tenant they claim.
  IF NOT app_rls_bypassed() AND v_tenant IS DISTINCT FROM app_current_tenant() THEN
    RAISE EXCEPTION 'NOT_FOUND: journal entry % does not exist', p_entry_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_status IN ('POSTED', 'REVERSED') THEN
    RAISE EXCEPTION
      'POSTED_IMMUTABLE: journal entry % is %; its lines are accounting facts (doc 01 rule 4).',
      p_entry_id, v_status USING ERRCODE = 'restrict_violation';
  END IF;

  DELETE FROM journal_line_dimensions
   WHERE journal_line_id IN (SELECT id FROM journal_lines WHERE journal_entry_id = p_entry_id);
  DELETE FROM journal_lines WHERE journal_entry_id = p_entry_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END $$;

/**
 * Discarding an unposted draft entirely (F-611).
 *
 * `REVOKE DELETE ON journal_entries` is what makes posted history permanent, and it
 * blocks removing a draft for the same reason. Same shape of answer, same checks.
 */
CREATE OR REPLACE FUNCTION ledger_discard_draft(p_entry_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status journal_status;
  v_tenant uuid;
BEGIN
  SELECT status, tenant_id INTO v_status, v_tenant
    FROM journal_entries WHERE id = p_entry_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: journal entry % does not exist', p_entry_id
      USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT app_rls_bypassed() AND v_tenant IS DISTINCT FROM app_current_tenant() THEN
    RAISE EXCEPTION 'NOT_FOUND: journal entry % does not exist', p_entry_id
      USING ERRCODE = 'no_data_found';
  END IF;
  IF v_status IN ('POSTED', 'REVERSED') THEN
    RAISE EXCEPTION
      'POSTED_IMMUTABLE: journal entry % is % and is never deleted. Correct it by reversal.',
      p_entry_id, v_status USING ERRCODE = 'restrict_violation';
  END IF;

  PERFORM ledger_clear_draft_lines(p_entry_id);
  DELETE FROM journal_entries WHERE id = p_entry_id;
  RETURN true;
END $$;

-- EXECUTE is granted to app_runtime and revoked from PUBLIC. The default on a new
-- function is EXECUTE to PUBLIC, which on a SECURITY DEFINER function means every
-- role in the cluster.
REVOKE ALL ON FUNCTION ledger_clear_draft_lines(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION ledger_discard_draft(uuid)     FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger_clear_draft_lines(uuid) TO app_runtime;
GRANT EXECUTE ON FUNCTION ledger_discard_draft(uuid)     TO app_runtime;

COMMENT ON FUNCTION ledger_clear_draft_lines(uuid) IS
  'F-619: the SECURITY DEFINER escape 0006 §3 described and did not write. Deletes the lines of an '
  'UNPOSTED entry only, re-checking the tenant because SECURITY DEFINER bypasses row-level security.';

-- The requirement, recorded next to the other privilege guards so `pnpm db:verify`
-- and any future reviewer see it in the same place.
INSERT INTO schema_guard_requirements (id, statement, rationale, gate, applied_at) VALUES
  ('grant_draft_line_writer',
   'GRANT EXECUTE ON FUNCTION ledger_clear_draft_lines(uuid), ledger_discard_draft(uuid) TO app_runtime',
   'F-619: the revocations in 0006 also block editing a DRAFT, which doc 03 requires. These two '
   'SECURITY DEFINER functions are the only sanctioned way past them, and they reach unposted '
   'entries only.',
   'Gate C',
   now());

DO $$
BEGIN
  IF NOT has_function_privilege('app_runtime', 'ledger_clear_draft_lines(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'app_runtime cannot execute ledger_clear_draft_lines; draft editing is broken';
  END IF;
  IF has_function_privilege('public', 'ledger_discard_draft(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ledger_discard_draft is executable by PUBLIC; a SECURITY DEFINER function must not be';
  END IF;
END $$;
