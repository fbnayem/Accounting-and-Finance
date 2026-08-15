-- =============================================================================
-- 0050 — Phase 6 isolation: tenant scope, entity scope keys, row-level security
-- =============================================================================
-- Phase 6. 0016 and 0017 built reporting, close, reconciliation, the audit
-- workspace and the approval engine correctly as *structures* — F-204's missing
-- objects, F-038's close versioning and F-010/F-017's key defects were all
-- resolved there. What they did not do, because Phase 6 had not arrived, is make
-- the 25 tables safe to serve traffic from. Phase 5 met all three of these in its
-- own tables (0042); they are here unchanged:
--
--   F-912  EIGHT of the 25 tables carry no tenant_id — six of 0016's thirteen
--          (report_rows, report_columns, close_checklist_template_tasks,
--          close_tasks, reconciling_items, audit_evidence) and two of 0017's
--          twelve (approval_steps, notification_delivery_attempts) — so ADR-0002's
--          policy has no column to sit on and none of them could be RLS-protected.
--   F-913  Entity and workflow references are single-column throughout the
--          statement layer, so a report definition can name another organization's
--          entity, a report column another tenant's budget, an approval request
--          another tenant's workflow, and a financial snapshot another entity's
--          book and period. report_definitions.legal_entity_id had no foreign key
--          of any kind, and account_reconciliations.accounting_book_id — the
--          LEADING column of that table's uniqueness — had none either, so the
--          key that decides "one reconciliation per book/period/account" was
--          built on a value nothing checked.
--   F-914  NONE of the 25 tables had row-level security, and none was registered
--          in rls_protected_tables — so F-618's both-directions check was
--          structurally incapable of reporting them: it can only compare a
--          registry to a catalog, and Phase 6 appeared in neither.
--
-- Two further gaps in the same family, closed here:
--   report_runs carried no legal_entity_id at all, so an entity-restricted user
--   could enumerate another entity's exports and open their output files.
--   financial_snapshots had no uniqueness beyond its surrogate key and nothing
--   verified content_hash, so Gate E's "statement snapshot is unchanged by future
--   transactions" rested on a hash no one checked against the payload beside it.
--
-- Forward-only (ADR-0008): 0016 and 0017 are applied, so this adds beside them.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. F-912 (S1) — the eight tables that could not be tenant-scoped.
--
-- Added nullable, backfilled from the parent, then made NOT NULL, so the
-- migration is correct on a populated database as well as an empty one (Gate A:
-- "migrations apply forward on empty and representative populated databases").
-- Every parent link but one is NOT NULL, so the child's tenant is derivable for
-- every row that can exist. audit_evidence is the exception and is handled
-- explicitly below.
-- ----------------------------------------------------------------------------
ALTER TABLE report_rows                     ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE report_columns                  ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE close_checklist_template_tasks  ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE close_tasks                     ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE reconciling_items               ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE audit_evidence                  ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE approval_steps                  ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE notification_delivery_attempts  ADD COLUMN tenant_id uuid REFERENCES tenants(id);

-- report_runs never had an entity at all. Nullable, because a run may legitimately
-- be organization-wide or consolidated (report_definitions.legal_entity_id is
-- nullable for the same reason); what matters is that an entity-scoped run can now
-- SAY which entity it is, which is the column an entity-restricted read filters on.
ALTER TABLE report_runs ADD COLUMN legal_entity_id uuid;

UPDATE report_rows r SET tenant_id = d.tenant_id
  FROM report_definitions d WHERE d.id = r.report_definition_id;
UPDATE report_columns c SET tenant_id = d.tenant_id
  FROM report_definitions d WHERE d.id = c.report_definition_id;
UPDATE close_checklist_template_tasks t SET tenant_id = ct.tenant_id
  FROM close_checklist_templates ct WHERE ct.id = t.template_id;
UPDATE close_tasks t SET tenant_id = r.tenant_id
  FROM close_runs r WHERE r.id = t.close_run_id;
UPDATE reconciling_items i SET tenant_id = a.tenant_id
  FROM account_reconciliations a WHERE a.id = i.account_reconciliation_id;
UPDATE approval_steps s SET tenant_id = q.tenant_id
  FROM approval_requests q WHERE q.id = s.approval_request_id;
UPDATE notification_delivery_attempts a SET tenant_id = m.tenant_id
  FROM notification_messages m WHERE m.id = a.notification_message_id;

-- audit_evidence.audit_request_id is nullable (0016), so the request is not always
-- there to inherit from. The attached file is the second source of truth — files
-- are tenant-scoped and F-048 scopes their storage key — and users are global, so
-- provided_by cannot answer the question. A row with neither parent has no
-- derivable tenant, and inventing one would be worse than failing: it would put a
-- row under a tenant that never created it and then protect it there. So the
-- migration refuses, loudly and specifically, rather than guessing.
UPDATE audit_evidence e SET tenant_id = r.tenant_id
  FROM audit_requests r WHERE r.id = e.audit_request_id;
UPDATE audit_evidence e SET tenant_id = f.tenant_id
  FROM files f WHERE f.id = e.file_id AND e.tenant_id IS NULL;
DO $$
DECLARE orphans bigint;
BEGIN
  SELECT count(*) INTO orphans FROM audit_evidence WHERE tenant_id IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION
      '% audit_evidence row(s) have neither an audit_request_id nor a file_id, so their tenant '
      'cannot be derived. Attach each to its request or its file, then re-run this migration.',
      orphans;
  END IF;
END $$;

ALTER TABLE report_rows                     ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE report_columns                  ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE close_checklist_template_tasks  ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE close_tasks                     ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE reconciling_items               ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE audit_evidence                  ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE approval_steps                  ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE notification_delivery_attempts  ALTER COLUMN tenant_id SET NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. F-913 (S1) — the scope keys nothing referenced.
--
-- ADR-0002: the composite scope foreign key is the PRIMARY isolation mechanism,
-- because it needs no session state at all; RLS is the second layer. Every
-- constraint below ends in _scope_fk so packages/database/src/errors.ts maps a
-- violation to CROSS_ENTITY_REFERENCE rather than a bare conflict.
--
-- First the keys to be referenced BY. Six Phase 6 parents and four older ones
-- (account_groups, budgets, consolidation_groups, accounting_periods) never
-- declared an (id, tenant_id) key, which is why their Phase 6 children could only
-- name them by a bare id.
-- ----------------------------------------------------------------------------
ALTER TABLE report_definitions        ADD CONSTRAINT rd_tenant_uq     UNIQUE (id, tenant_id);
ALTER TABLE close_checklist_templates ADD CONSTRAINT cct_tenant_uq    UNIQUE (id, tenant_id);
ALTER TABLE close_runs                ADD CONSTRAINT cr_tenant_uq     UNIQUE (id, tenant_id);
ALTER TABLE close_tasks               ADD CONSTRAINT ct_run_uq        UNIQUE (id, close_run_id);
ALTER TABLE account_reconciliations   ADD CONSTRAINT recon_tenant_uq  UNIQUE (id, tenant_id);
ALTER TABLE audit_requests            ADD CONSTRAINT aud_tenant_uq    UNIQUE (id, tenant_id);
ALTER TABLE approval_workflows        ADD CONSTRAINT aw_tenant_uq     UNIQUE (id, tenant_id);
ALTER TABLE approval_requests         ADD CONSTRAINT apr_tenant_uq    UNIQUE (id, tenant_id);
ALTER TABLE notification_messages     ADD CONSTRAINT nmsg_tenant_uq   UNIQUE (id, tenant_id);

ALTER TABLE account_groups            ADD CONSTRAINT account_groups_tenant_uq      UNIQUE (id, tenant_id);
ALTER TABLE budgets                   ADD CONSTRAINT budgets_tenant_uq             UNIQUE (id, tenant_id);
ALTER TABLE consolidation_groups      ADD CONSTRAINT consolidation_groups_tenant_uq UNIQUE (id, tenant_id);
ALTER TABLE accounting_periods        ADD CONSTRAINT accounting_periods_tenant_uq  UNIQUE (id, tenant_id);

-- --------------------------------------------------------- report definitions --
-- The exemplar. legal_entity_id had NO foreign key of any kind, so a definition
-- could name an entity that does not exist, or one belonging to another tenant,
-- and every statement rendered from it would look entirely normal. It is bound to
-- the definition's ORGANIZATION rather than only its tenant, because doc 12 scopes
-- a definition to an organization ("null = organization-wide template") and the
-- organization is in turn bound to the tenant below — entity in org, org in
-- tenant, both checked.
ALTER TABLE report_definitions
  ADD CONSTRAINT rd_entity_scope_fk FOREIGN KEY (legal_entity_id, organization_id)
      REFERENCES legal_entities(id, organization_id),
  ADD CONSTRAINT rd_org_scope_fk    FOREIGN KEY (organization_id, tenant_id)
      REFERENCES organizations(id, tenant_id);

ALTER TABLE report_rows
  ADD CONSTRAINT rr_definition_scope_fk    FOREIGN KEY (report_definition_id, tenant_id)
      REFERENCES report_definitions(id, tenant_id),
  ADD CONSTRAINT rr_account_group_scope_fk FOREIGN KEY (account_group_id, tenant_id)
      REFERENCES account_groups(id, tenant_id);

ALTER TABLE report_columns
  ADD CONSTRAINT rc_definition_scope_fk FOREIGN KEY (report_definition_id, tenant_id)
      REFERENCES report_definitions(id, tenant_id),
  ADD CONSTRAINT rc_entity_scope_fk    FOREIGN KEY (legal_entity_id, tenant_id)
      REFERENCES legal_entities(id, tenant_id),
  ADD CONSTRAINT rc_budget_scope_fk    FOREIGN KEY (budget_id, tenant_id)
      REFERENCES budgets(id, tenant_id);

-- The export path. An output file is the statement itself; binding it to the run's
-- tenant is the same reasoning as files_key_is_tenant_scoped (F-048).
ALTER TABLE report_runs
  ADD CONSTRAINT rrun_entity_scope_fk     FOREIGN KEY (legal_entity_id, tenant_id)
      REFERENCES legal_entities(id, tenant_id),
  ADD CONSTRAINT rrun_definition_scope_fk FOREIGN KEY (report_definition_id, tenant_id)
      REFERENCES report_definitions(id, tenant_id),
  ADD CONSTRAINT rrun_file_scope_fk       FOREIGN KEY (output_file_id, tenant_id)
      REFERENCES files(id, tenant_id);
CREATE INDEX report_runs_entity_idx ON report_runs(tenant_id, legal_entity_id, requested_at DESC);

-- ------------------------------------------------------- financial snapshots --
-- Gate E's artifact. Every reference it carries was single-column, so an issued
-- statement could claim another entity's book, another entity's period, another
-- tenant's definition and another tenant's output file.
ALTER TABLE financial_snapshots
  ADD CONSTRAINT fs_entity_scope_fk     FOREIGN KEY (legal_entity_id, tenant_id)
      REFERENCES legal_entities(id, tenant_id),
  ADD CONSTRAINT fs_group_scope_fk      FOREIGN KEY (consolidation_group_id, tenant_id)
      REFERENCES consolidation_groups(id, tenant_id),
  ADD CONSTRAINT fs_book_scope_fk       FOREIGN KEY (accounting_book_id, legal_entity_id)
      REFERENCES accounting_books(id, legal_entity_id),
  ADD CONSTRAINT fs_period_scope_fk     FOREIGN KEY (accounting_period_id, legal_entity_id)
      REFERENCES accounting_periods(id, legal_entity_id),
  -- accounting_period_id is NOT NULL while legal_entity_id is not: a consolidated
  -- snapshot has a group instead of an entity, and MATCH SIMPLE skips the key above
  -- entirely when either column is NULL. Without this second key the consolidated
  -- half of the table — exactly the half that spans entities — would be the
  -- unchecked one. A criterion proved on part of its domain is proved on none of it.
  ADD CONSTRAINT fs_period_tenant_scope_fk FOREIGN KEY (accounting_period_id, tenant_id)
      REFERENCES accounting_periods(id, tenant_id),
  ADD CONSTRAINT fs_definition_scope_fk FOREIGN KEY (report_definition_id, tenant_id)
      REFERENCES report_definitions(id, tenant_id),
  ADD CONSTRAINT fs_file_scope_fk       FOREIGN KEY (output_file_id, tenant_id)
      REFERENCES files(id, tenant_id);

-- doc 12: "Changing report definition creates a new version. Historical approved
-- statement snapshot stores definition version." A snapshot version had nothing
-- making it unique, so the same statement could be issued twice under one version
-- number and the two would disagree while both looked authoritative.
-- NULLS NOT DISTINCT because the entity/group and book columns are legitimately
-- null for consolidated and book-agnostic snapshots, and NULL-distinctness is
-- precisely what defeated the blueprint's keys in F-017.
ALTER TABLE financial_snapshots
  ADD CONSTRAINT fs_identity_uq UNIQUE NULLS NOT DISTINCT
    (tenant_id, legal_entity_id, consolidation_group_id, accounting_book_id,
     accounting_period_id, snapshot_type, version);

-- --------------------------------------------------------------------- close --
ALTER TABLE close_checklist_templates
  ADD CONSTRAINT cct_org_scope_fk FOREIGN KEY (organization_id, tenant_id)
      REFERENCES organizations(id, tenant_id);

ALTER TABLE close_checklist_template_tasks
  ADD CONSTRAINT cctt_template_scope_fk FOREIGN KEY (template_id, tenant_id)
      REFERENCES close_checklist_templates(id, tenant_id);

ALTER TABLE close_runs
  ADD CONSTRAINT cr_entity_scope_fk   FOREIGN KEY (legal_entity_id, tenant_id)
      REFERENCES legal_entities(id, tenant_id),
  ADD CONSTRAINT cr_template_scope_fk FOREIGN KEY (template_id, tenant_id)
      REFERENCES close_checklist_templates(id, tenant_id);

ALTER TABLE close_tasks
  ADD CONSTRAINT ct_run_scope_fk     FOREIGN KEY (close_run_id, tenant_id)
      REFERENCES close_runs(id, tenant_id),
  -- A close task's prerequisite must be a task of the SAME close run. Without this
  -- the dependency graph Gate F walks could cross entities, and a close could be
  -- blocked by, or unblocked by, another entity's work.
  ADD CONSTRAINT ct_depends_scope_fk FOREIGN KEY (depends_on_task_id, close_run_id)
      REFERENCES close_tasks(id, close_run_id);

-- ------------------------------------------------------------ reconciliation --
-- accounting_book_id is the leading column of UNIQUE (accounting_book_id,
-- accounting_period_id, account_id) and had no foreign key at all: the key that
-- makes "one reconciliation per book, period and account" true was resting on a
-- value nothing checked existed, let alone belonged to the same entity as the
-- account and the period beside it.
ALTER TABLE account_reconciliations
  ADD CONSTRAINT recon_book_scope_fk      FOREIGN KEY (accounting_book_id, legal_entity_id)
      REFERENCES accounting_books(id, legal_entity_id),
  ADD CONSTRAINT recon_entity_scope_fk    FOREIGN KEY (legal_entity_id, tenant_id)
      REFERENCES legal_entities(id, tenant_id),
  ADD CONSTRAINT recon_close_run_scope_fk FOREIGN KEY (close_run_id, legal_entity_id)
      REFERENCES close_runs(id, legal_entity_id);

ALTER TABLE reconciling_items
  ADD CONSTRAINT ri_recon_scope_fk FOREIGN KEY (account_reconciliation_id, tenant_id)
      REFERENCES account_reconciliations(id, tenant_id),
  ADD CONSTRAINT ri_file_scope_fk  FOREIGN KEY (evidence_file_id, tenant_id)
      REFERENCES files(id, tenant_id);

-- ---------------------------------------------------------- audit workspace ---
ALTER TABLE audit_requests
  ADD CONSTRAINT aud_entity_scope_fk FOREIGN KEY (legal_entity_id, tenant_id)
      REFERENCES legal_entities(id, tenant_id),
  ADD CONSTRAINT aud_period_scope_fk FOREIGN KEY (accounting_period_id, legal_entity_id)
      REFERENCES accounting_periods(id, legal_entity_id);

ALTER TABLE audit_evidence
  ADD CONSTRAINT aue_request_scope_fk FOREIGN KEY (audit_request_id, tenant_id)
      REFERENCES audit_requests(id, tenant_id),
  ADD CONSTRAINT aue_file_scope_fk    FOREIGN KEY (file_id, tenant_id)
      REFERENCES files(id, tenant_id);

-- ------------------------------------------------------------------ approval --
-- doc 14: "A running instance retains the version it started with." The instance
-- pointed at its workflow by bare id, so a request could be governed by another
-- tenant's approval rules — including one with a lower threshold or no dual
-- approval — and the resulting approval would still be recorded as valid.
ALTER TABLE approval_workflows
  ADD CONSTRAINT aw_entity_scope_fk FOREIGN KEY (legal_entity_id, tenant_id)
      REFERENCES legal_entities(id, tenant_id);

ALTER TABLE approval_requests
  ADD CONSTRAINT apr_workflow_scope_fk FOREIGN KEY (approval_workflow_id, tenant_id)
      REFERENCES approval_workflows(id, tenant_id),
  ADD CONSTRAINT apr_entity_scope_fk   FOREIGN KEY (legal_entity_id, tenant_id)
      REFERENCES legal_entities(id, tenant_id);

ALTER TABLE approval_steps
  ADD CONSTRAINT ast_request_scope_fk FOREIGN KEY (approval_request_id, tenant_id)
      REFERENCES approval_requests(id, tenant_id),
  ADD CONSTRAINT ast_role_scope_fk    FOREIGN KEY (approver_role_id, tenant_id)
      REFERENCES roles(id, tenant_id);

ALTER TABLE delegations
  ADD CONSTRAINT del_entity_scope_fk FOREIGN KEY (legal_entity_id, tenant_id)
      REFERENCES legal_entities(id, tenant_id);

ALTER TABLE escalation_rules
  ADD CONSTRAINT esc_workflow_scope_fk FOREIGN KEY (approval_workflow_id, tenant_id)
      REFERENCES approval_workflows(id, tenant_id),
  ADD CONSTRAINT esc_role_scope_fk     FOREIGN KEY (target_role_id, tenant_id)
      REFERENCES roles(id, tenant_id);

ALTER TABLE automation_actions
  ADD CONSTRAINT aut_workflow_scope_fk FOREIGN KEY (approval_workflow_id, tenant_id)
      REFERENCES approval_workflows(id, tenant_id);

ALTER TABLE segregation_rules
  ADD CONSTRAINT sr_entity_scope_fk FOREIGN KEY (legal_entity_id, tenant_id)
      REFERENCES legal_entities(id, tenant_id);

ALTER TABLE tasks
  ADD CONSTRAINT tsk_entity_scope_fk FOREIGN KEY (legal_entity_id, tenant_id)
      REFERENCES legal_entities(id, tenant_id),
  ADD CONSTRAINT tsk_role_scope_fk   FOREIGN KEY (owner_role_id, tenant_id)
      REFERENCES roles(id, tenant_id);

-- ------------------------------------------------------------- notifications --
-- notification_messages.template_id is deliberately NOT given a composite key:
-- notification_templates.tenant_id is nullable because a platform default belongs
-- to no tenant (0017), so (template_id, tenant_id) would reject every message
-- rendered from a platform template. The RLS policy below is what scopes reads of
-- that table, and it is written to match the same nullability.
ALTER TABLE notification_messages
  ADD CONSTRAINT nmsg_entity_scope_fk  FOREIGN KEY (legal_entity_id, tenant_id)
      REFERENCES legal_entities(id, tenant_id),
  ADD CONSTRAINT nmsg_contact_scope_fk FOREIGN KEY (recipient_contact_id, tenant_id)
      REFERENCES contacts(id, tenant_id);

ALTER TABLE notification_preferences
  ADD CONSTRAINT npref_contact_scope_fk FOREIGN KEY (contact_id, tenant_id)
      REFERENCES contacts(id, tenant_id);

ALTER TABLE notification_delivery_attempts
  ADD CONSTRAINT nda_message_scope_fk FOREIGN KEY (notification_message_id, tenant_id)
      REFERENCES notification_messages(id, tenant_id);

-- ----------------------------------------------------------------------------
-- 3. Gate E — the snapshot hash that nothing verified.
--
-- doc 12: "When statements are approved/period closed, save immutable metadata:
-- report definition version, parameters, ledger cutoff/checkpoint, generated
-- file/hash, actor, approval and date. Future activity must not rewrite old
-- snapshot." 0016 stored content_hash NOT NULL and never compared it to anything,
-- so a snapshot could carry a hash of a payload it does not contain — which is the
-- one thing a content hash exists to make impossible.
--
-- The canonicaliser is a function rather than a rule written down in the API,
-- because a hash the writer computes over ITS canonical form and the database
-- checks against a DIFFERENT canonical form is a control that refuses every
-- legitimate write. PostgreSQL's jsonb text form is the canonical one here (keys
-- sorted, duplicates removed, whitespace normalised); the application calls this
-- function to obtain it rather than reimplementing that ordering in TypeScript.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION financial_snapshot_content_hash(p_payload jsonb)
RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT encode(sha256(convert_to(p_payload::text, 'UTF8')), 'hex')
$$;
REVOKE ALL ON FUNCTION financial_snapshot_content_hash(jsonb) FROM PUBLIC;

COMMENT ON FUNCTION financial_snapshot_content_hash(jsonb) IS
  'Gate E: the canonical content hash of a financial snapshot payload — sha256 over PostgreSQL''s '
  'own jsonb text form, so the writer and the guard cannot disagree about key order. The API MUST '
  'obtain content_hash from this function; financial_snapshots_content_hash rejects any other value.';

CREATE OR REPLACE FUNCTION assert_financial_snapshot_hash()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_expected text;
BEGIN
  v_expected := financial_snapshot_content_hash(NEW.payload);
  IF NEW.content_hash IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION
      'SNAPSHOT_HASH_MISMATCH: content_hash % does not match the payload stored with it (expected '
      '%). Obtain it from financial_snapshot_content_hash(payload); doc 12 requires an issued '
      'statement be reproducible from what is stored.',
      coalesce(NEW.content_hash, '(null)'), v_expected
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER financial_snapshots_content_hash
  BEFORE INSERT ON financial_snapshots
  FOR EACH ROW EXECUTE FUNCTION assert_financial_snapshot_hash();

ALTER TABLE financial_snapshots
  ADD CONSTRAINT fs_content_hash_format CHECK (content_hash ~ '^[0-9a-f]{64}$');

-- ----------------------------------------------------------------------------
-- 4. F-914 (S1) — row-level security, on all 25 Phase 6 tables.
--
-- ADR-0002. Registered in `rls_protected_tables` rather than in a list inside a
-- script, so `pnpm db:verify` joins the catalog against the registry in both
-- directions and a table that is registered but unprotected fails the build just
-- as loudly as one that is protected but unregistered (F-618). Until this
-- migration that check had nothing to say about Phase 6 at all: with no policy and
-- no registration, a table appears in neither side of the join, so "no Phase 6
-- table has RLS" reported exactly as cleanly as full coverage would have.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_table text;
  v_tables text[] := ARRAY[
    -- 0016 — reporting, close, reconciliation, audit workspace
    'report_definitions','report_rows','report_columns','report_runs','financial_snapshots',
    'close_checklist_templates','close_checklist_template_tasks','close_runs','close_tasks',
    'account_reconciliations','reconciling_items','audit_requests','audit_evidence',
    -- 0017 — approvals, delegation, tasks, notifications
    'approval_workflows','segregation_rules','approval_requests','approval_steps','delegations',
    'escalation_rules','tasks','automation_actions','notification_preferences',
    'notification_messages','notification_delivery_attempts'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', v_table);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (app_rls_bypassed() OR tenant_id = app_current_tenant()) '
      'WITH CHECK (app_rls_bypassed() OR tenant_id = app_current_tenant())',
      v_table || '_tenant_isolation', v_table);
    INSERT INTO rls_protected_tables (table_name, phase, rationale)
      VALUES (v_table, 6,
              'Phase 6 statement, close, reconciliation, audit or approval fact: tenant-scoped and '
              'directly readable, so ADR-0002 requires the second layer as well as the scope key.')
      ON CONFLICT (table_name) DO NOTHING;
  END LOOP;
END $$;

-- notification_templates carries the same policy with one deliberate difference:
-- its tenant_id is nullable because a row with no tenant is a PLATFORM default
-- (0017), which every tenant may render from. So USING admits the platform rows
-- and WITH CHECK does not: a tenant reads the defaults and cannot write one, and
-- the exemption is still a role rather than a value the application can supply.
ALTER TABLE notification_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_templates FORCE  ROW LEVEL SECURITY;
CREATE POLICY notification_templates_tenant_isolation ON notification_templates
  USING      (app_rls_bypassed() OR tenant_id = app_current_tenant() OR tenant_id IS NULL)
  WITH CHECK (app_rls_bypassed() OR tenant_id = app_current_tenant());
INSERT INTO rls_protected_tables (table_name, phase, rationale)
  VALUES ('notification_templates', 6,
          'Phase 6: tenant overrides of notification content sit beside platform defaults in one '
          'table. Readable across the NULL-tenant defaults, writable only within the tenant.')
  ON CONFLICT (table_name) DO NOTHING;

-- Both directions, asserted here as well as in db:verify, so this migration cannot
-- install a registry that disagrees with what it just did (0029's habit).
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

-- The registry and the catalog can agree with each other and still both be short
-- of the phase. This asserts the DOMAIN: all 25 tables 0016 and 0017 created carry
-- a tenant column, carry a policy, and are registered. F-912 was found fourteen
-- times in Phase 5 because nothing ever asked the question table by table.
DO $$
DECLARE
  v_table text;
  v_tables text[] := ARRAY[
    'report_definitions','report_rows','report_columns','report_runs','financial_snapshots',
    'close_checklist_templates','close_checklist_template_tasks','close_runs','close_tasks',
    'account_reconciliations','reconciling_items','audit_requests','audit_evidence',
    'approval_workflows','segregation_rules','approval_requests','approval_steps','delegations',
    'escalation_rules','tasks','automation_actions','notification_templates',
    'notification_preferences','notification_messages','notification_delivery_attempts'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = v_table AND column_name = 'tenant_id'
         -- notification_templates is the one table whose tenant_id is legitimately
         -- nullable: a platform default belongs to no tenant.
         AND (is_nullable = 'NO' OR v_table = 'notification_templates'))
    THEN
      RAISE EXCEPTION '% has no NOT NULL tenant_id; ADR-0002''s policy has no column to sit on', v_table;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
       WHERE c.oid = v_table::regclass AND c.relrowsecurity AND c.relforcerowsecurity)
    THEN
      RAISE EXCEPTION '% does not have row-level security enabled AND forced', v_table;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies p
                    WHERE p.schemaname = 'public' AND p.tablename = v_table) THEN
      RAISE EXCEPTION '% has row-level security with no policy on it, which denies everything', v_table;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM rls_protected_tables r WHERE r.table_name = v_table) THEN
      RAISE EXCEPTION '% is protected but unregistered, so db:verify cannot see it', v_table;
    END IF;
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 5. Gate C — the privilege half, for Phase 6's decisions and audit facts.
--
-- Same two-control reasoning as 0025, 0036, 0043 and 0048: a trigger is one
-- control, and a privilege the application does not hold is the other. What the
-- application never does is ERASE a decision or a fact:
--
--   approval_steps / approval_requests — doc 14 records actor, timestamp, comment
--     and session context on every decision, and Gate F is proven by reading them.
--     UPDATE stays, because recording the decision on a PENDING step IS an update;
--     DELETE goes, because there is no correction that requires the decision never
--     to have been made.
--   delegations — doc 14: "Preserve complete assignment history." UPDATE stays:
--     ending a delegation early means shortening valid_to, and delegations_no_overlap
--     makes a superseding row impossible. DELETE would erase who could act for whom.
--   financial_snapshots — Gate E. The 0016 trigger already refuses UPDATE and
--     DELETE; this is the second, independent reason.
--   audit_evidence — what was provided to an auditor, and when. Deleting it
--     rewrites the audit trail rather than correcting it.
--   close_runs — F-038 made a reopen a NEW VERSION rather than an edit, which is
--     only true if the previous version cannot be removed.
--
-- Registered AND executed by the `applied_at IS NULL` sweep 0043 introduced after
-- the audit found 0038 registering two revocations and executing neither: a
-- requirement row is an intention until something runs it.
-- ----------------------------------------------------------------------------
INSERT INTO schema_guard_requirements (id, statement, rationale, gate) VALUES
  ('revoke_approval_decision_delete',
   'REVOKE DELETE ON approval_steps, approval_requests FROM app_runtime',
   'doc 14: an approval decision records actor, timestamp, comment and session context, and the '
   'segregation-of-duties evidence Gate F reads is the history of those rows. A withdrawn request '
   'is CANCELLED, never erased.',
   'Gate C'),
  ('revoke_delegation_delete',
   'REVOKE DELETE ON delegations FROM app_runtime',
   'doc 14: "Preserve complete assignment history." Ending a delegation early shortens valid_to; '
   'deleting the row removes the evidence that someone else could approve in that window.',
   'Gate C'),
  ('revoke_financial_snapshot_mutation',
   'REVOKE UPDATE, DELETE ON financial_snapshots FROM app_runtime',
   'Gate E: "statement snapshot is unchanged by future transactions." The 0016 trigger refuses the '
   'mutation and this refuses the privilege, so restoring one control does not restore both.',
   'Gate C'),
  ('revoke_audit_evidence_delete',
   'REVOKE DELETE ON audit_evidence FROM app_runtime',
   'doc 12 audit workspace: evidence provision is a fact with an actor and a timestamp. Superseded '
   'evidence is answered by providing more, not by removing what was already given.',
   'Gate C'),
  ('revoke_close_run_delete',
   'REVOKE DELETE ON close_runs FROM app_runtime',
   'F-038: a reopen creates a new close version rather than editing the old one, which is only '
   'true while the old one cannot be deleted. close_tasks cascade from it, so the history of what '
   'was completed in the previous close goes with it.',
   'Gate C'),
  ('grant_snapshot_hash_execute',
   'GRANT EXECUTE ON FUNCTION financial_snapshot_content_hash(jsonb) TO app_runtime',
   'Gate E: the canonical hash of a snapshot payload. financial_snapshots_content_hash rejects any '
   'other value, so without EXECUTE the application could not issue a statement at all.',
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

-- Asserted against the catalog, not against the statements above: the registry says
-- applied, so the catalog must agree (0025's habit, 0043's and 0048's repetition).
-- Both halves — a revocation that also took INSERT or UPDATE with it would make an
-- approval undecidable and a close unreopenable, and a control that only refuses is
-- indistinguishable from one that refuses everything.
DO $$
BEGIN
  IF has_table_privilege('app_runtime', 'approval_steps', 'DELETE')
     OR has_table_privilege('app_runtime', 'approval_requests', 'DELETE')
     OR has_table_privilege('app_runtime', 'delegations', 'DELETE')
     OR has_table_privilege('app_runtime', 'financial_snapshots', 'UPDATE')
     OR has_table_privilege('app_runtime', 'financial_snapshots', 'DELETE')
     OR has_table_privilege('app_runtime', 'audit_evidence', 'DELETE')
     OR has_table_privilege('app_runtime', 'close_runs', 'DELETE') THEN
    RAISE EXCEPTION 'app_runtime retains a Phase 6 privilege Gate C requires be revoked (F-914)';
  END IF;

  IF NOT has_table_privilege('app_runtime', 'approval_steps', 'INSERT')
     OR NOT has_table_privilege('app_runtime', 'approval_steps', 'UPDATE')
     OR NOT has_table_privilege('app_runtime', 'delegations', 'UPDATE')
     OR NOT has_table_privilege('app_runtime', 'financial_snapshots', 'INSERT')
     OR NOT has_table_privilege('app_runtime', 'financial_snapshots', 'SELECT')
     OR NOT has_table_privilege('app_runtime', 'audit_evidence', 'INSERT')
     OR NOT has_table_privilege('app_runtime', 'close_runs', 'INSERT')
     OR NOT has_table_privilege('app_runtime', 'close_runs', 'UPDATE') THEN
    RAISE EXCEPTION
      'app_runtime cannot record an approval decision, end a delegation, issue a snapshot or '
      'reopen a close; the revocations above took a working path with them';
  END IF;

  IF NOT has_function_privilege('app_runtime', 'financial_snapshot_content_hash(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'app_runtime cannot compute a snapshot content hash, so no statement can be issued';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 6. What each of these was, in the words of the criterion it broke.
-- ----------------------------------------------------------------------------
COMMENT ON COLUMN approval_steps.tenant_id IS
  'F-912: the row that records WHO approved, WHEN, from which session — the evidence Gate F is '
  'proven by — had no tenant column, so it was the one part of the approval chain RLS could not '
  'reach. Its request had one; the decision did not.';
COMMENT ON CONSTRAINT apr_workflow_scope_fk ON approval_requests IS
  'F-913: a request could be governed by another tenant''s workflow version — including one with a '
  'lower threshold or no dual approval — and the approval it produced would still be recorded as '
  'valid. doc 14: "a running instance retains the version it started with"; this makes it retain a '
  'version of its own tenant''s workflow.';
COMMENT ON CONSTRAINT recon_book_scope_fk ON account_reconciliations IS
  'F-913: accounting_book_id is the LEADING column of this table''s uniqueness and had no foreign '
  'key of any kind, so "one reconciliation per book, period and account" — Gate D''s subject — was '
  'built on a value nothing checked existed or belonged to the same entity.';
COMMENT ON CONSTRAINT rd_entity_scope_fk ON report_definitions IS
  'F-913: legal_entity_id had no foreign key at all. A definition could name an entity of another '
  'organization, and every statement rendered from it would look entirely normal.';
COMMENT ON COLUMN report_runs.legal_entity_id IS
  'An export is a statement in a file. Without this column an entity-restricted user could list '
  'every run in the tenant and open its output_file_id, because there was nothing to filter on.';
COMMENT ON CONSTRAINT fs_identity_uq ON financial_snapshots IS
  'Gate E: the same statement could be issued twice under one version number, and the two would '
  'disagree while both looked authoritative. NULLS NOT DISTINCT because a consolidated snapshot '
  'legitimately has no legal_entity_id, and NULL-distinctness is what defeated the blueprint keys '
  'in F-017.';
