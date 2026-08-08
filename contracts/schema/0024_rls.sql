-- =============================================================================
-- 0024 — Row-level security, as the second layer
-- =============================================================================
-- Phase 1. ADR-0002: "RLS is still added in Phase 1 on the highest-value tables
-- (journal_entries, journal_lines, invoices, vendor_bills, contacts, files) as a
-- second layer, consistent with doc 16 positioning it as defence-in-depth."
--
-- Read the ADR before extending this. RLS is deliberately NOT the primary control:
-- it depends on connection-level session state, and migrations, background workers,
-- the report engine and bulk importers all connect differently — which is exactly
-- where setting the context is easiest to forget. Composite foreign keys are the
-- primary mechanism because they need no session state at all. What RLS adds is a
-- second, independent reason a cross-tenant read returns nothing, so a single
-- application mistake is not sufficient to leak.
--
-- Gate B: "cross-tenant object ID probes return no data."
-- =============================================================================

-- ----------------------------------------------------------------------------
-- What the policies read.
--
-- `app.tenant_id` is set by withTransaction() for every request-scoped
-- transaction, from the authenticated session. A connection can only ever narrow
-- itself to one tenant with it, which is the point.
--
-- The exemption is a ROLE, not a setting. The first draft of this migration used
-- `current_setting('app.rls_bypass')`, which the application role could set for
-- itself — one stray line, or one SQL injection, and the layer is gone. Migration,
-- seeding and benchmarking are legitimately cross-tenant, but they are cross-tenant
-- because of *who they are*, not because of what they ask for, so membership of
-- `app_maintenance` is what grants it. `app_runtime` is never a member, and cannot
-- make itself one.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_maintenance') THEN
    CREATE ROLE app_maintenance NOLOGIN;
  END IF;
END $$;

-- Whoever applies migrations owns the schema and does the seeding and the
-- benchmarking. Granted here so those paths keep working without a flag.
DO $$
BEGIN
  EXECUTE format('GRANT app_maintenance TO %I', current_user);
END $$;

CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_rls_bypassed() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT pg_has_role(current_user, 'app_maintenance', 'USAGE')
$$;

COMMENT ON FUNCTION app_rls_bypassed() IS
  'ADR-0002: RLS is defence-in-depth. The exemption is role membership rather than a session '
  'setting, because a setting the application role can write is an exemption the application role '
  'can grant itself.';

-- ----------------------------------------------------------------------------
-- Policies.
--
-- FORCE is required: the application connects as the table owner, and without it
-- the owner silently bypasses every policy, which would make this migration
-- decorative. A NULL app.tenant_id therefore denies rather than permits — a query
-- that forgot its context reads nothing instead of reading everything.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'journal_entries', 'journal_lines', 'invoices', 'vendor_bills', 'contacts', 'files'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (app_rls_bypassed() OR tenant_id = app_current_tenant()) '
      'WITH CHECK (app_rls_bypassed() OR tenant_id = app_current_tenant())',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;

COMMENT ON FUNCTION app_current_tenant() IS
  'Gate B: with FORCE ROW LEVEL SECURITY a missing app.tenant_id denies. A query that forgot its '
  'tenant context reads nothing, which fails loudly, rather than reading everything, which does not.';
