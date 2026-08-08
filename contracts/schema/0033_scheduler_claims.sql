-- =============================================================================
-- 0033 — Claiming due work across tenants
-- =============================================================================
-- F-620. Row-level security makes a background scanner blind.
--
-- Every policy in 0024 and 0029 is `tenant_id = app_current_tenant()`, and FORCE is
-- on, so a query with no tenant context reads nothing. That is exactly the intent
-- for a request — a query that forgot its tenant should fail loudly rather than
-- read everything. But Phase 2 introduces the first background job that must look
-- ACROSS tenants before it knows which one it is working in: the scheduler asks
-- "which reversals are due today", and the answer spans every tenant on the
-- instance.
--
-- Phase 1 never met this. The outbox drainer scans `outbox_events`, which has no
-- policy, so nothing pushed back.
--
-- The wrong fixes, and why:
--
--   Give the worker app_maintenance.   It would bypass RLS for the postings too,
--                                      not only for the scan. The worker posts.
--   Drop the policy on the two tables. Trades a real control for a convenience.
--   Loop over tenants in the worker.   Requires reading `tenants`, which is the
--                                      same problem one table further out.
--
-- What is here instead: two SECURITY DEFINER functions that answer exactly the
-- question "what is due", return the ids and nothing else, and take no caller input
-- beyond a date and a limit. Everything the scheduler then DOES with those ids runs
-- inside a normal tenant-scoped transaction, with every policy applying. The
-- cross-tenant surface is two read-only queries with no filter a caller can choose.
-- =============================================================================

CREATE OR REPLACE FUNCTION ledger_claim_due_reversals(p_today date, p_limit integer)
RETURNS TABLE (
  id               uuid,
  tenant_id        uuid,
  legal_entity_id  uuid,
  journal_entry_id uuid,
  scheduled_date   date,
  reason           text,
  attempts         integer
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.id, s.tenant_id, s.legal_entity_id, s.journal_entry_id, s.scheduled_date,
         s.reason, s.attempts
    FROM scheduled_reversals s
   WHERE s.status = 'PENDING'
     AND s.scheduled_date <= p_today
   ORDER BY s.scheduled_date, s.id
   LIMIT least(greatest(p_limit, 1), 1000)
   -- SKIP LOCKED so two worker replicas never take the same row. The lock is held
   -- for the caller's transaction, which ends when the claim returns — the work
   -- itself is done row by row afterwards, in its own transaction, so one slow
   -- posting cannot block the row behind it.
   FOR UPDATE SKIP LOCKED
$$;

CREATE OR REPLACE FUNCTION ledger_claim_due_recurring(p_today date, p_limit integer)
RETURNS TABLE (
  id                 uuid,
  tenant_id          uuid,
  legal_entity_id    uuid,
  accounting_book_id uuid,
  journal_id         uuid,
  name               text,
  version            integer,
  frequency          text,
  next_run_date      date,
  end_date           date,
  auto_post          boolean,
  requires_approval  boolean,
  line_template      jsonb
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT t.id, t.tenant_id, t.legal_entity_id, t.accounting_book_id, t.journal_id, t.name,
         t.version, t.frequency, t.next_run_date, t.end_date, t.auto_post, t.requires_approval,
         t.line_template
    FROM recurring_journal_templates t
   WHERE t.status = 'ACTIVE'
     AND t.next_run_date IS NOT NULL
     AND t.next_run_date <= p_today
     AND (t.end_date IS NULL OR t.next_run_date <= t.end_date)
   ORDER BY t.next_run_date, t.id
   LIMIT least(greatest(p_limit, 1), 1000)
   FOR UPDATE SKIP LOCKED
$$;

REVOKE ALL ON FUNCTION ledger_claim_due_reversals(date, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION ledger_claim_due_recurring(date, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledger_claim_due_reversals(date, integer) TO app_runtime;
GRANT EXECUTE ON FUNCTION ledger_claim_due_recurring(date, integer) TO app_runtime;

COMMENT ON FUNCTION ledger_claim_due_reversals(date, integer) IS
  'F-620: the cross-tenant read a scheduler needs before it knows which tenant it is in. Returns '
  'ids only; every action taken on them runs inside a tenant-scoped transaction with RLS applying.';

INSERT INTO schema_guard_requirements (id, statement, rationale, gate, applied_at) VALUES
  ('grant_scheduler_claims',
   'GRANT EXECUTE ON FUNCTION ledger_claim_due_reversals(date, integer), ledger_claim_due_recurring(date, integer) TO app_runtime',
   'F-620: row-level security denies a query with no tenant context, which is correct for a '
   'request and impossible for a background scan. These two read-only functions are the whole of '
   'the cross-tenant surface; the worker is not a member of app_maintenance and cannot become one.',
   'Gate B',
   now());

DO $$
BEGIN
  IF pg_has_role('app_runtime', 'app_maintenance', 'USAGE') THEN
    RAISE EXCEPTION 'app_runtime is a member of app_maintenance; the claim functions would be pointless';
  END IF;
  IF has_function_privilege('public', 'ledger_claim_due_reversals(date, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ledger_claim_due_reversals is executable by PUBLIC';
  END IF;
END $$;
