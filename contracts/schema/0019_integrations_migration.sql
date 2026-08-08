-- =============================================================================
-- 0019 — Integrations, webhooks and migration toolkit
-- =============================================================================
-- Phase 9. Resolves F-046 (webhook delivery history overwritten by each retry),
-- F-047 (subscribed_events unvalidated), F-017 (nullable columns in the
-- integrations unique key).
-- =============================================================================

CREATE TABLE integrations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id       uuid REFERENCES legal_entities(id),
  provider              text NOT NULL,
  integration_type      text NOT NULL CHECK (integration_type IN
    ('BANK_FEED','PAYMENT_GATEWAY','ECOMMERCE','POS','PAYROLL','CRM','DOCUMENT_INTAKE',
     'EINVOICING','MIGRATION','STORAGE','ESIGNATURE')),
  external_account_id   text,
  status                text NOT NULL DEFAULT 'DISCONNECTED'
    CHECK (status IN ('DISCONNECTED','CONNECTED','EXPIRING','EXPIRED','ERROR','REVOKED')),
  -- doc 15/16: connectors never receive database credentials; only a
  -- secret-manager reference is stored.
  encrypted_config_ref  text,
  scopes                text[] NOT NULL DEFAULT '{}',
  consent_expires_at    timestamptz,
  connected_at          timestamptz,
  last_sync_at          timestamptz,
  next_sync_at          timestamptz,
  settings              jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- F-017: three of these five columns are nullable, so the blueprint's plain
  -- UNIQUE was defeated by NULL-distinctness.
  CONSTRAINT integrations_uq
    UNIQUE NULLS NOT DISTINCT (tenant_id, legal_entity_id, provider, integration_type, external_account_id)
);
CREATE INDEX integrations_expiry_idx ON integrations(consent_expires_at) WHERE status = 'CONNECTED';

CREATE TABLE integration_mappings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id  uuid NOT NULL REFERENCES integrations(id) ON DELETE RESTRICT,
  entity_kind     text NOT NULL CHECK (entity_kind IN
    ('CUSTOMER','VENDOR','ITEM','ACCOUNT','TAX_CODE','LOCATION','PAYMENT_METHOD','CURRENCY')),
  external_id     text NOT NULL,
  internal_id     uuid,
  -- doc 15: "Conflicts/unmapped values enter the integration exception queue,
  -- not silent defaults."
  status          text NOT NULL DEFAULT 'MAPPED' CHECK (status IN ('MAPPED','UNMAPPED','CONFLICT')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (integration_id, entity_kind, external_id)
);
CREATE INDEX integration_mappings_unmapped_idx
  ON integration_mappings(integration_id) WHERE status <> 'MAPPED';

CREATE TABLE sync_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  integration_id  uuid NOT NULL REFERENCES integrations(id),
  sync_type       text NOT NULL,
  cursor_state    jsonb,
  status          job_status NOT NULL DEFAULT 'QUEUED',
  records_read    integer NOT NULL DEFAULT 0,
  records_written integer NOT NULL DEFAULT 0,
  records_failed  integer NOT NULL DEFAULT 0,
  started_at      timestamptz,
  completed_at    timestamptz,
  error           text,
  metrics         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sync_jobs_integration_idx ON sync_jobs(integration_id, created_at DESC);

CREATE TABLE integration_exceptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id  uuid NOT NULL REFERENCES integrations(id) ON DELETE RESTRICT,
  sync_job_id     uuid REFERENCES sync_jobs(id),
  exception_type  text NOT NULL,
  external_ref    text,
  payload         jsonb,
  message         text NOT NULL,
  task_id         uuid REFERENCES tasks(id),
  resolved_at     timestamptz,
  resolved_by     uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE integration_exceptions IS
  'doc 15 acceptance: "Provider schema error is isolated to integration exception and does not '
  'corrupt financial data."';

CREATE TABLE webhook_endpoints (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id   uuid REFERENCES legal_entities(id),
  url               text NOT NULL,
  secret_ref        text NOT NULL,
  -- F-047: validated against contracts/events.yaml at write time; the
  -- event_types reference table below is seeded from the same source, so a typo
  -- fails at insert instead of silently subscribing to nothing.
  subscribed_events text[] NOT NULL,
  max_attempts      integer NOT NULL DEFAULT 8,
  status            record_status NOT NULL DEFAULT 'ACTIVE',
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Seeded from contracts/events.yaml by the build. F-047.
CREATE TABLE event_types (
  event_type    text PRIMARY KEY,
  context       text NOT NULL,
  event_version integer NOT NULL DEFAULT 1,
  scope         text NOT NULL CHECK (scope IN ('platform','entity','book')),
  min_phase     integer NOT NULL DEFAULT 1
);

CREATE OR REPLACE FUNCTION assert_subscribed_events_known()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_unknown text[];
BEGIN
  SELECT array_agg(e) INTO v_unknown
    FROM unnest(NEW.subscribed_events) AS e
   WHERE NOT EXISTS (SELECT 1 FROM event_types WHERE event_type = e);
  IF v_unknown IS NOT NULL AND cardinality(v_unknown) > 0 THEN
    RAISE EXCEPTION
      'UNKNOWN_EVENT_TYPE: % is not in contracts/events.yaml.', v_unknown
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER webhook_endpoints_events_known
  BEFORE INSERT OR UPDATE ON webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION assert_subscribed_events_known();

-- F-046: the blueprint had UNIQUE (endpoint, outbox_event) with a scalar
-- `attempt integer`, so every retry overwrote the previous response — yet doc 15
-- requires retry with backoff, dead-lettering and manual replay, all of which
-- need per-attempt history. The delivery row is now the aggregate; attempts are
-- separate rows.
CREATE TABLE webhook_deliveries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE RESTRICT,
  outbox_event_id     uuid NOT NULL REFERENCES outbox_events(id) ON DELETE RESTRICT,
  event_id            uuid NOT NULL,       -- retained across retries (doc 15)
  status              delivery_status NOT NULL DEFAULT 'QUEUED',
  attempt_count       integer NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz,
  delivered_at        timestamptz,
  dead_lettered_at    timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (webhook_endpoint_id, outbox_event_id)
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries(next_attempt_at)
  WHERE status IN ('QUEUED','FAILED');

CREATE TABLE webhook_delivery_attempts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_delivery_id  uuid NOT NULL REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
  attempt              integer NOT NULL,
  request_signature    text,
  response_code        integer,
  response_body        text,
  duration_ms          integer,
  error                text,
  attempted_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (webhook_delivery_id, attempt)
);

-- ------------------------------------------------------------- migration -----
CREATE TABLE source_systems (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,
  -- doc 17: prioritise by customer need.
  adapter_kind  text NOT NULL CHECK (adapter_kind IN ('QUICKBOOKS','XERO','ZOHO','ODOO','SAGE','NETSUITE','CSV','CUSTOM')),
  status        record_status NOT NULL DEFAULT 'ACTIVE'
);

CREATE TABLE import_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL,
  name            text NOT NULL,
  target_entity   text NOT NULL CHECK (target_entity IN
    ('CHART_OF_ACCOUNTS','CUSTOMERS','VENDORS','ITEMS','OPENING_TRIAL_BALANCE',
     'OPEN_INVOICES','OPEN_BILLS','BANK_BALANCES','BANK_TRANSACTIONS',
     'INVENTORY_OPENING','FIXED_ASSETS','HISTORICAL_JOURNALS')),
  version         integer NOT NULL DEFAULT 1,
  column_spec     jsonb NOT NULL,
  UNIQUE (code, version)
);

CREATE TABLE migration_jobs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id        uuid NOT NULL REFERENCES legal_entities(id),
  source_system_id       uuid REFERENCES source_systems(id),
  mode                   migration_mode NOT NULL,
  cutover_date           date,
  status                 migration_status NOT NULL DEFAULT 'DRAFT',
  mapping_config         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Gate I: "Imported source control totals captured before cutover" and
  -- "Cutover report is immutable/archived."
  source_control_totals  jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_control_totals  jsonb NOT NULL DEFAULT '{}'::jsonb,
  cutover_report_file_id uuid REFERENCES files(id),
  signed_off_by          uuid REFERENCES users(id),
  signed_off_at          timestamptz,
  created_by             uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  completed_at           timestamptz,
  CONSTRAINT mj_cutover_needs_signoff
    CHECK (status <> 'CUTOVER' OR (signed_off_by IS NOT NULL AND cutover_report_file_id IS NOT NULL))
);

CREATE TABLE mapping_sets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_job_id uuid NOT NULL REFERENCES migration_jobs(id) ON DELETE RESTRICT,
  entity_kind      text NOT NULL,
  mappings         jsonb NOT NULL,
  UNIQUE (migration_job_id, entity_kind)
);

CREATE TABLE import_batches (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  migration_job_id   uuid REFERENCES migration_jobs(id),
  import_template_id uuid REFERENCES import_templates(id),
  source_file_id     uuid REFERENCES files(id),
  file_hash          text,
  status             job_status NOT NULL DEFAULT 'QUEUED',
  rows_total         integer NOT NULL DEFAULT 0,
  rows_valid         integer NOT NULL DEFAULT 0,
  rows_failed        integer NOT NULL DEFAULT 0,
  preview_totals     jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- doc 17 acceptance: "Rerun is idempotent by project/external ID."
  UNIQUE (migration_job_id, file_hash)
);

CREATE TABLE import_rows (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_id  uuid NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_no           integer NOT NULL,
  raw_data         jsonb NOT NULL,
  normalized_data  jsonb,
  status           text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','VALID','WARNING','ERROR','COMMITTED','SKIPPED')),
  errors           jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_resource_type text,
  created_resource_id   uuid,
  UNIQUE (import_batch_id, row_no)
);
CREATE INDEX import_rows_errors_idx ON import_rows(import_batch_id) WHERE status IN ('ERROR','WARNING');

-- doc 17: external IDs are namespaced by migration project / source system, so a
-- rerun is idempotent and the source lineage survives.
CREATE TABLE migration_external_ids (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_job_id uuid NOT NULL REFERENCES migration_jobs(id) ON DELETE RESTRICT,
  entity_kind      text NOT NULL,
  external_id      text NOT NULL,
  internal_id      uuid NOT NULL,
  UNIQUE (migration_job_id, entity_kind, external_id)
);

CREATE TABLE opening_balance_sets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id  uuid NOT NULL,
  accounting_book_id uuid NOT NULL,
  migration_job_id uuid REFERENCES migration_jobs(id),
  as_of_date       date NOT NULL,
  -- doc 17 / Gate I: "Opening Trial Balance matches source totals" and
  -- "Require debit=credit."
  total_debit      numeric(24,8) NOT NULL,
  total_credit     numeric(24,8) NOT NULL,
  journal_entry_id uuid REFERENCES journal_entries(id),
  status           text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','VALIDATED','POSTED','REVERSED')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT obs_balanced CHECK (status = 'DRAFT' OR total_debit = total_credit),
  CONSTRAINT obs_book_scope_fk FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id)
);
COMMENT ON CONSTRAINT obs_balanced ON opening_balance_sets IS
  'Phase 2 exit criterion: "Opening Trial Balance imports and validates Assets = Liabilities + Equity."';

-- Gate I: the reconciliation pack. Every difference needs a documented
-- explanation and approval.
CREATE TABLE migration_reconciliation_results (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_job_id uuid NOT NULL REFERENCES migration_jobs(id) ON DELETE RESTRICT,
  check_code       text NOT NULL CHECK (check_code IN
    ('TRIAL_BALANCE','AR_AGING','AP_AGING','BANK_BALANCES','INVENTORY_VALUE',
     'FIXED_ASSET_COST','FIXED_ASSET_ACCUM_DEP','TAX_CONTROL','DOCUMENT_COUNTS')),
  source_value     numeric(24,8),
  target_value     numeric(24,8),
  difference       numeric(24,8),
  explanation      text,
  approved_by      uuid REFERENCES users(id),
  approved_at      timestamptz,
  UNIQUE (migration_job_id, check_code),
  CONSTRAINT mrr_difference_explained
    CHECK (difference IS NULL OR difference = 0 OR explanation IS NOT NULL)
);

CREATE TABLE cutover_checklists (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_job_id uuid NOT NULL REFERENCES migration_jobs(id) ON DELETE RESTRICT,
  step_code        text NOT NULL,
  step_name        text NOT NULL,
  required         boolean NOT NULL DEFAULT true,
  status           close_task_status NOT NULL DEFAULT 'OPEN',
  completed_by     uuid REFERENCES users(id),
  completed_at     timestamptz,
  UNIQUE (migration_job_id, step_code)
);

COMMENT ON TABLE webhook_delivery_attempts IS
  'F-046: the blueprint stored a scalar attempt counter, so each retry overwrote the previous '
  'response and doc 15''s dead-letter and replay requirements were unimplementable.';
