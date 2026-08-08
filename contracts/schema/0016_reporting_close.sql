-- =============================================================================
-- 0016 — Reporting, period close, reconciliations and audit workspace
-- =============================================================================
-- Phase 6. F-204 found this the second-largest coverage gap: 14 missing objects
-- in the phase where Gates D, E and F are all proven. AccountReconciliation and
-- ReconcilingItem are literally what Gate D tests; report definition versioning
-- is what makes a financial snapshot reproducible (Gate E).
-- Also resolves F-038 (only one close run per period was ever possible).
-- =============================================================================

CREATE TABLE report_definitions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id    uuid,                       -- null = organization-wide template
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  code               text NOT NULL,
  name               text NOT NULL,
  report_type        text NOT NULL CHECK (report_type IN
    ('PROFIT_LOSS','BALANCE_SHEET','CASH_FLOW','TRIAL_BALANCE','CUSTOM')),
  version            integer NOT NULL DEFAULT 1,
  -- ADR-0001: the P&L definition must know which retained-earnings method the
  -- book uses, because DERIVED books carry P&L balances across the year boundary.
  retained_earnings_method retained_earnings_method,
  rounding_display_unit text CHECK (rounding_display_unit IN ('UNIT','THOUSAND','MILLION')),
  status             record_status NOT NULL DEFAULT 'ACTIVE',
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code, version),
  CONSTRAINT rd_scope_uq UNIQUE (id, organization_id)
);
COMMENT ON TABLE report_definitions IS
  'doc 12: "Changing report definition creates a new version. Historical approved statement '
  'snapshot stores definition version." F-204: neither table existed.';

CREATE TABLE report_rows (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_definition_id uuid NOT NULL REFERENCES report_definitions(id) ON DELETE CASCADE,
  row_no               integer NOT NULL,
  label                text NOT NULL,
  row_type             text NOT NULL CHECK (row_type IN
    ('ACCOUNT_RANGE','ACCOUNT_GROUP','FORMULA','SUBTOTAL','HEADER','SPACER')),
  account_from         text,
  account_to           text,
  account_group_id     uuid REFERENCES account_groups(id),
  formula              text,
  sign_reversal        boolean NOT NULL DEFAULT false,
  indent_level         integer NOT NULL DEFAULT 0,
  is_bold              boolean NOT NULL DEFAULT false,
  hide_if_zero         boolean NOT NULL DEFAULT false,
  UNIQUE (report_definition_id, row_no)
);

CREATE TABLE report_columns (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_definition_id uuid NOT NULL REFERENCES report_definitions(id) ON DELETE CASCADE,
  column_no            integer NOT NULL,
  label                text NOT NULL,
  column_type          text NOT NULL CHECK (column_type IN
    ('PERIOD','YTD','COMPARATIVE','VARIANCE','BUDGET','FORECAST','PERCENT','ENTITY','FORMULA')),
  period_offset        integer NOT NULL DEFAULT 0,
  budget_id            uuid REFERENCES budgets(id),
  legal_entity_id      uuid REFERENCES legal_entities(id),
  formula              text,
  UNIQUE (report_definition_id, column_no)
);

CREATE TABLE report_runs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  report_definition_id uuid REFERENCES report_definitions(id),
  report_type          text NOT NULL,
  parameters           jsonb NOT NULL,
  requested_by         uuid REFERENCES users(id),
  status               job_status NOT NULL DEFAULT 'QUEUED',
  output_file_id       uuid REFERENCES files(id),
  output_format        text CHECK (output_format IN ('CSV','XLSX','PDF','JSON')),
  row_count            integer,
  duration_ms          integer,
  error                text,
  requested_at         timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz
);
CREATE INDEX report_runs_status_idx ON report_runs(tenant_id, status, requested_at DESC);

-- doc 12: immutable metadata for issued statements. Gate E: "Statement snapshot
-- is unchanged by future transactions."
CREATE TABLE financial_snapshots (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id        uuid REFERENCES legal_entities(id),
  consolidation_group_id uuid REFERENCES consolidation_groups(id),
  accounting_book_id     uuid REFERENCES accounting_books(id),
  accounting_period_id   uuid NOT NULL REFERENCES accounting_periods(id),
  -- F-204: the snapshot could not record "the definition version used" because
  -- report_definitions did not exist.
  report_definition_id   uuid REFERENCES report_definitions(id),
  snapshot_type          text NOT NULL,
  version                integer NOT NULL DEFAULT 1,
  parameters             jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The ledger cutoff this snapshot was taken at, so it is reproducible.
  ledger_cutoff_at       timestamptz NOT NULL,
  payload                jsonb NOT NULL,
  output_file_id         uuid REFERENCES files(id),
  content_hash           text NOT NULL,
  approved_by            uuid REFERENCES users(id),
  approved_at            timestamptz,
  created_by             uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (legal_entity_id IS NOT NULL OR consolidation_group_id IS NOT NULL)
);
-- Immutable once created (Gate E).
CREATE TRIGGER financial_snapshots_immutable
  BEFORE UPDATE OR DELETE ON financial_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_of_posted();

-- --------------------------------------------------------------- close --------
CREATE TABLE close_checklist_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  code            text NOT NULL,
  name            text NOT NULL,
  cadence         text NOT NULL CHECK (cadence IN ('MONTHLY','QUARTERLY','YEAR_END')),
  version         integer NOT NULL DEFAULT 1,
  status          record_status NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (organization_id, code, version)
);

CREATE TABLE close_checklist_template_tasks (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id          uuid NOT NULL REFERENCES close_checklist_templates(id) ON DELETE CASCADE,
  sequence             integer NOT NULL,
  code                 text NOT NULL,
  name                 text NOT NULL,
  task_type            text NOT NULL,
  required             boolean NOT NULL DEFAULT true,
  depends_on_task_code text,
  UNIQUE (template_id, code)
);

-- F-038: the blueprint had UNIQUE (entity, book, period), so after a reopen a
-- second close could not be recorded — yet doc 12 requires a reopen workflow and
-- Gate F tests it.
CREATE TABLE close_runs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id      uuid NOT NULL,
  accounting_book_id   uuid NOT NULL,
  accounting_period_id uuid NOT NULL,
  template_id          uuid REFERENCES close_checklist_templates(id),
  version              integer NOT NULL DEFAULT 1,
  status               close_run_status NOT NULL DEFAULT 'OPEN',
  readiness_percent    numeric(7,4) NOT NULL DEFAULT 0 CHECK (readiness_percent BETWEEN 0 AND 100),
  started_by           uuid REFERENCES users(id),
  started_at           timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz,
  reopened_at          timestamptz,
  reopened_by          uuid REFERENCES users(id),
  reopen_reason        text,
  UNIQUE (legal_entity_id, accounting_book_id, accounting_period_id, version),
  CONSTRAINT close_runs_book_scope_fk FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id),
  CONSTRAINT close_runs_period_scope_fk FOREIGN KEY (accounting_period_id, legal_entity_id) REFERENCES accounting_periods(id, legal_entity_id),
  CONSTRAINT close_runs_reopen_has_reason CHECK (reopened_at IS NULL OR reopen_reason IS NOT NULL),
  CONSTRAINT close_runs_scope_uq UNIQUE (id, legal_entity_id)
);
-- Exactly one COMPLETED close per period; reopen creates a new version.
CREATE UNIQUE INDEX close_runs_completed_uq
  ON close_runs(legal_entity_id, accounting_book_id, accounting_period_id)
  WHERE status = 'COMPLETED';

CREATE TABLE close_tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  close_run_id    uuid NOT NULL REFERENCES close_runs(id) ON DELETE CASCADE,
  sequence        integer NOT NULL DEFAULT 0,
  code            text NOT NULL,
  name            text NOT NULL,
  task_type       text NOT NULL,
  owner_user_id   uuid REFERENCES users(id),
  required        boolean NOT NULL DEFAULT true,
  status          close_task_status NOT NULL DEFAULT 'OPEN',
  depends_on_task_id uuid REFERENCES close_tasks(id),
  due_at          timestamptz,
  evidence        jsonb NOT NULL DEFAULT '[]'::jsonb,
  waived_by       uuid REFERENCES users(id),
  waived_reason   text,
  completed_by    uuid REFERENCES users(id),
  completed_at    timestamptz,
  UNIQUE (close_run_id, code),
  CONSTRAINT close_tasks_waived_has_reason CHECK (status <> 'WAIVED' OR waived_reason IS NOT NULL)
);

-- ----------------------------------------------------------------------------
-- Account reconciliation — F-204. This is literally what Gate D tests:
-- "Any difference is either zero or represented by an explicit, explainable
-- reconciliation item." Neither table existed.
-- ----------------------------------------------------------------------------
CREATE TABLE account_reconciliations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id        uuid NOT NULL,
  accounting_book_id     uuid NOT NULL,
  accounting_period_id   uuid NOT NULL,
  account_id             uuid NOT NULL,
  close_run_id           uuid REFERENCES close_runs(id),
  gl_balance             numeric(24,8) NOT NULL,
  supporting_balance     numeric(24,8) NOT NULL,
  difference             numeric(24,8) NOT NULL,
  currency               char(3) NOT NULL REFERENCES currencies(code),
  status                 recon_cert_status NOT NULL DEFAULT 'DRAFT',
  prepared_by            uuid REFERENCES users(id),
  prepared_at            timestamptz,
  -- doc 12: preparer and approver certification; approved reconciliation is
  -- immutable unless formally reopened.
  approved_by            uuid REFERENCES users(id),
  approved_at            timestamptz,
  reopened_reason        text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (accounting_book_id, accounting_period_id, account_id),
  CONSTRAINT recon_difference_derived CHECK (difference = gl_balance - supporting_balance),
  CONSTRAINT recon_sod CHECK (approved_by IS NULL OR approved_by <> prepared_by),
  CONSTRAINT recon_account_scope_fk FOREIGN KEY (account_id, legal_entity_id) REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT recon_period_scope_fk  FOREIGN KEY (accounting_period_id, legal_entity_id) REFERENCES accounting_periods(id, legal_entity_id)
);

CREATE TABLE reconciling_items (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_reconciliation_id uuid NOT NULL REFERENCES account_reconciliations(id) ON DELETE RESTRICT,
  item_type                 text NOT NULL CHECK (item_type IN
    ('TIMING','ERROR','UNRECORDED','IN_TRANSIT','DISPUTED','OTHER')),
  description               text NOT NULL,
  amount                    numeric(24,8) NOT NULL,
  expected_clear_date       date,
  source_type               text,
  source_id                 uuid,
  evidence_file_id          uuid REFERENCES files(id),
  resolved_at               timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now()
);

-- Gate D: the difference must be fully explained by reconciling items.
CREATE OR REPLACE FUNCTION assert_reconciliation_explained()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_items numeric(24,8);
BEGIN
  IF NEW.status NOT IN ('CERTIFIED','APPROVED') THEN RETURN NULL; END IF;
  SELECT coalesce(sum(amount),0) INTO v_items
    FROM reconciling_items WHERE account_reconciliation_id = NEW.id;
  IF NEW.difference <> v_items THEN
    RAISE EXCEPTION
      'RECONCILIATION_UNEXPLAINED: difference % is not fully explained by reconciling items % on %.',
      NEW.difference, v_items, NEW.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER account_reconciliations_explained
  AFTER INSERT OR UPDATE ON account_reconciliations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_reconciliation_explained();

-- --------------------------------------------------------- audit workspace ---
CREATE TABLE audit_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid REFERENCES legal_entities(id),
  accounting_period_id uuid REFERENCES accounting_periods(id),
  title           text NOT NULL,
  description     text,
  requested_by    uuid REFERENCES users(id),
  owner_user_id   uuid REFERENCES users(id),
  status          text NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','IN_PROGRESS','PROVIDED','ACCEPTED','CLOSED')),
  due_at          timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_evidence (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_request_id  uuid REFERENCES audit_requests(id) ON DELETE RESTRICT,
  resource_type     text NOT NULL,
  resource_id       uuid NOT NULL,
  file_id           uuid REFERENCES files(id),
  note              text,
  provided_by       uuid REFERENCES users(id),
  provided_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_evidence_resource_idx ON audit_evidence(resource_type, resource_id);

COMMENT ON TABLE account_reconciliations IS
  'F-204: Gate D''s six subledger-to-control criteria had no table to record their result. This is '
  'the artifact those criteria assert against.';
COMMENT ON INDEX close_runs_completed_uq IS
  'F-038: exactly one COMPLETED close per period, but reopen creates a new version - the blueprint''s '
  'flat UNIQUE made the doc 12 reopen workflow unrecordable.';
