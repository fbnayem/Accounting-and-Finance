-- =============================================================================
-- 0025 — The application database role
-- =============================================================================
-- Phase 1. Turns two layers that were previously written down but not in force
-- into layers that actually hold.
--
-- 0006_ledger_guards.sql §3 recorded the privilege revocations Gate C requires
-- ("Posted journal application role cannot UPDATE/DELETE protected accounting
-- facts") as a runbook comment plus a `schema_guard_requirements` table, to be
-- "run once per environment after creating the runtime role". The role was never
-- created, so nothing ran anywhere — including in development, which is where the
-- tests that are supposed to prove it run.
--
-- 0024_rls.sql then added row-level security. A superuser bypasses RLS outright,
-- and the application was connecting as the database owner, who is a superuser in
-- every standard PostgreSQL image. The policies were therefore decorative: a
-- cross-tenant SELECT with the wrong app.tenant_id still returned every row.
--
-- Both problems have the same cause and the same fix: the application must not
-- connect as the owner.
--
--   owner       (acct)      migrations, seeding, benchmarks. Cross-tenant by design.
--   app_runtime (group)     what a request runs as. No superuser, RLS applies,
--                           cannot UPDATE or DELETE posted accounting facts.
--
-- The login role that carries a password is created per environment by
-- `pnpm db:runtime-role`, not here — a migration is version-controlled and a
-- credential must not be.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    -- NOLOGIN: this is the privilege set, not an account. Environment-specific
    -- login roles are granted membership in it.
    CREATE ROLE app_runtime NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO app_runtime;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO app_runtime;

-- Phase 2 onwards adds tables in later migrations, which run as the owner. Without
-- this the runtime role would silently lose access to each new table until someone
-- remembered to grant it — and "someone remembered" is what this whole migration
-- exists to stop relying on.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;

-- ----------------------------------------------------------------------------
-- The revocations. Executed from `schema_guard_requirements` rather than written
-- out again, so the table stops being a list of intentions and becomes the thing
-- that was actually run. `pnpm db:verify` re-checks each one against the catalog.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  requirement record;
BEGIN
  FOR requirement IN SELECT id, statement FROM schema_guard_requirements ORDER BY id LOOP
    EXECUTE requirement.statement;
    RAISE NOTICE 'applied schema guard %', requirement.id;
  END LOOP;
END $$;

ALTER TABLE schema_guard_requirements
  ADD COLUMN applied_at timestamptz;
UPDATE schema_guard_requirements SET applied_at = now();

COMMENT ON TABLE schema_guard_requirements IS
  'Privilege statements applied to app_runtime by migration 0025. `pnpm db:verify` asserts each is '
  'still in force by reading the catalog, so a later GRANT that undoes one fails the drift gate.';

-- ----------------------------------------------------------------------------
-- Posted history stays readable but unwritable. Stated as an assertion rather
-- than a comment: if a future migration hands the privilege back, this fails at
-- the point of the mistake instead of at the next Gate C run.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  -- app_maintenance is the row-level-security exemption (0024). If app_runtime
  -- ever holds it, every policy in 0024 stops applying to every request, and
  -- nothing else in the schema would show it.
  IF pg_has_role('app_runtime', 'app_maintenance', 'USAGE') THEN
    RAISE EXCEPTION 'app_runtime is a member of app_maintenance; RLS would not apply to requests';
  END IF;
  IF has_table_privilege('app_runtime', 'journal_lines', 'UPDATE')
     OR has_table_privilege('app_runtime', 'journal_lines', 'DELETE')
     OR has_table_privilege('app_runtime', 'journal_entries', 'DELETE')
     OR has_table_privilege('app_runtime', 'audit_events', 'UPDATE')
     OR has_table_privilege('app_runtime', 'audit_events', 'DELETE') THEN
    RAISE EXCEPTION 'app_runtime retains a privilege Gate C requires be revoked';
  END IF;
  IF NOT has_table_privilege('app_runtime', 'journal_lines', 'SELECT')
     OR NOT has_table_privilege('app_runtime', 'journal_lines', 'INSERT') THEN
    RAISE EXCEPTION 'app_runtime cannot read or write journal_lines; posting would be impossible';
  END IF;
END $$;
