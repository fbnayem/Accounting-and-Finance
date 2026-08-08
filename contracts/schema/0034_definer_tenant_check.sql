-- =============================================================================
-- 0034 — The tenant check inside a SECURITY DEFINER function
-- =============================================================================
-- F-621. Migration 0032 wrote this, and was pleased with it:
--
--   IF NOT app_rls_bypassed() AND v_tenant IS DISTINCT FROM app_current_tenant()
--
-- It can never be true. `app_rls_bypassed()` is `pg_has_role(current_user, …)`,
-- and inside a SECURITY DEFINER function `current_user` is the function's OWNER,
-- not the caller. The owner is a member of `app_maintenance` — 0024 grants it so
-- migrations and seeding can work cross-tenant — so the guard short-circuited to
-- true on every call, and the tenant comparison was dead code.
--
-- The consequence: any authenticated user could clear or discard ANY tenant's
-- draft journal by id. Row-level security was no help, because the whole point of
-- the function is that it runs as a role RLS does not apply to.
--
-- Found by the guard suite, and only after the scenario itself was fixed twice:
-- the first version pointed at an entry whose transaction had rolled back, and the
-- second ran as the owner, for whom skipping the check is correct behaviour. Both
-- reported a pass. The scenario that finally failed is the one that creates a real
-- draft, then calls the function under a different tenant and expects a rejection.
--
-- The fix removes the exemption rather than repairing it. `session_user` would be
-- the honest question — "did the role that connected have the bypass" — but the
-- exemption has no purpose here: migration and seeding write to journal_lines
-- directly as the owner and never call these functions. A function whose only
-- caller is the request path should ask the request path's question, and nothing
-- else. A caller with no app.tenant_id now gets NOT_FOUND, which is the same
-- answer FORCE ROW LEVEL SECURITY gives a query that forgot its tenant.
-- =============================================================================

CREATE OR REPLACE FUNCTION ledger_clear_draft_lines(p_entry_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status  journal_status;
  v_tenant  uuid;
  v_deleted integer;
BEGIN
  SELECT status, tenant_id INTO v_status, v_tenant
    FROM journal_entries WHERE id = p_entry_id;

  -- No exemption. Not knowing which tenant you are is not a licence to touch every
  -- tenant; it is a bug in the caller, and NOT_FOUND is what it deserves.
  IF v_status IS NULL OR v_tenant IS DISTINCT FROM app_current_tenant() THEN
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

  IF v_status IS NULL OR v_tenant IS DISTINCT FROM app_current_tenant() THEN
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

COMMENT ON FUNCTION app_rls_bypassed() IS
  'ADR-0002: RLS is defence-in-depth. The exemption is role membership rather than a session '
  'setting, because a setting the application role can write is an exemption the application role '
  'can grant itself. F-621: it reads current_user, so inside a SECURITY DEFINER function it always '
  'returns true — never use it to guard one.';

-- The claim functions in 0033 do not have this problem: they are deliberately
-- cross-tenant, take no caller-chosen filter, and return ids only. Asserted here so
-- the distinction is recorded rather than remembered.
DO $$
DECLARE
  v_definition text;
BEGIN
  FOR v_definition IN
    SELECT pg_get_functiondef(p.oid)
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
     WHERE p.prosecdef
       AND p.proname IN ('ledger_clear_draft_lines', 'ledger_discard_draft')
  LOOP
    IF v_definition LIKE '%app_rls_bypassed%' THEN
      RAISE EXCEPTION
        'a SECURITY DEFINER function still calls app_rls_bypassed(), which is always true inside one (F-621)';
    END IF;
    IF v_definition NOT LIKE '%app_current_tenant%' THEN
      RAISE EXCEPTION 'a SECURITY DEFINER function does not check the tenant at all';
    END IF;
  END LOOP;
END $$;
