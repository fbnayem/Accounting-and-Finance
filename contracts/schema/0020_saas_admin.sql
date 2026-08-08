-- =============================================================================
-- 0020 — SaaS platform administration, entitlements and support operations
-- =============================================================================
-- Phase 1 (continuous, doc 00 schedules SaaS admin as "0-10"). F-203 found 18 of
-- these 19 objects missing. doc 23's instruction is the design constraint:
-- "Business code checks entitlements through a centralized service; do not
-- scatter hard-coded plan names across modules."
-- =============================================================================

CREATE TABLE plans (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,
  description   text,
  status        record_status NOT NULL DEFAULT 'ACTIVE'
);

CREATE TABLE plan_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id       uuid NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  version       integer NOT NULL,
  effective_from date NOT NULL,
  effective_to  date,
  status        record_status NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (plan_id, version)
);
ALTER TABLE plan_versions ADD CONSTRAINT plan_versions_no_overlap
  EXCLUDE USING gist (plan_id WITH =, daterange(effective_from, effective_to, '[)') WITH &&);

-- doc 23: capabilities and limits, e.g. users, entities, bank connections,
-- storage, API tier, AI usage, multi-entity/consolidation, advanced approvals,
-- country packs, audit retention.
CREATE TABLE entitlements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_version_id  uuid NOT NULL REFERENCES plan_versions(id) ON DELETE CASCADE,
  capability       text NOT NULL,
  enabled          boolean NOT NULL DEFAULT true,
  limit_value      numeric(24,4),
  limit_unit       text,
  UNIQUE (plan_version_id, capability)
);

CREATE TABLE subscriptions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  plan_version_id   uuid NOT NULL REFERENCES plan_versions(id),
  status            subscription_status NOT NULL DEFAULT 'TRIAL',
  trial_ends_at     timestamptz,
  current_period_start date,
  current_period_end   date,
  cancelled_at      timestamptz,
  -- doc 23: "Never destroy accounting records because a SaaS subscription ends."
  -- Restriction policy must state explicitly what remains readable.
  restriction_policy jsonb NOT NULL DEFAULT '{"reads":"allowed","exports":"allowed","mutations":"blocked"}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX subscriptions_active_uq ON subscriptions(tenant_id)
  WHERE status NOT IN ('CANCELLED');

CREATE TABLE subscription_history (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  plan_version_id uuid NOT NULL REFERENCES plan_versions(id),
  status          subscription_status NOT NULL,
  valid_from      timestamptz NOT NULL,
  valid_to        timestamptz,
  changed_by      uuid REFERENCES users(id),
  reason          text
);
COMMENT ON TABLE subscription_history IS
  'doc 23: "Historical subscription changes retain version/effective dates."';

CREATE TABLE tenant_limits (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  capability    text NOT NULL,
  limit_value   numeric(24,4),
  -- doc 23: overrides are audited.
  override_reason text,
  set_by        uuid REFERENCES users(id),
  set_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, capability)
);

CREATE TABLE usage_meters (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,
  unit          text NOT NULL,
  is_billable   boolean NOT NULL DEFAULT false
);

-- doc 23: "Metering must be idempotent, tenant-scoped and independently
-- reconcilable to provider billing."
CREATE TABLE usage_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  usage_meter_id  uuid NOT NULL REFERENCES usage_meters(id),
  period_start    date NOT NULL,
  quantity        numeric(24,4) NOT NULL CHECK (quantity >= 0),
  source_type     text,
  source_id       uuid,
  idempotency_key text NOT NULL,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, usage_meter_id, idempotency_key)
);
CREATE INDEX usage_records_period_idx ON usage_records(tenant_id, usage_meter_id, period_start);

CREATE TABLE billing_customer_references (
  tenant_id           uuid PRIMARY KEY REFERENCES tenants(id),
  provider            text NOT NULL,
  external_customer_id text NOT NULL,
  external_subscription_id text,
  UNIQUE (provider, external_customer_id)
);

-- ----------------------------------------------------------- support access --
-- doc 23: support access requires an explicit role, a time-bound grant, a
-- reason/ticket, least privilege, a visible audit trail, optional customer
-- approval and automatic expiry.
CREATE TABLE support_access_grants (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  support_user_id   uuid NOT NULL REFERENCES users(id),
  reason            text NOT NULL,
  ticket_reference  text,
  granted_permissions text[] NOT NULL,
  requires_customer_approval boolean NOT NULL DEFAULT false,
  customer_approved_by uuid REFERENCES users(id),
  customer_approved_at timestamptz,
  valid_from        timestamptz NOT NULL DEFAULT now(),
  valid_to          timestamptz NOT NULL,
  revoked_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to > valid_from),
  CONSTRAINT sag_approval_present
    CHECK (NOT requires_customer_approval OR customer_approved_at IS NOT NULL OR valid_from > now())
);
CREATE INDEX support_grants_active_idx ON support_access_grants(tenant_id, valid_to)
  WHERE revoked_at IS NULL;

CREATE TABLE impersonation_sessions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  support_access_grant_id uuid NOT NULL REFERENCES support_access_grants(id) ON DELETE RESTRICT,
  support_user_id        uuid NOT NULL REFERENCES users(id),
  impersonated_user_id   uuid NOT NULL REFERENCES users(id),
  session_id             uuid REFERENCES sessions(id),
  started_at             timestamptz NOT NULL DEFAULT now(),
  ended_at               timestamptz,
  -- doc 23: "High-risk actions can be prohibited during impersonation."
  high_risk_blocked      boolean NOT NULL DEFAULT true,
  CHECK (support_user_id <> impersonated_user_id)
);
COMMENT ON TABLE impersonation_sessions IS
  'doc 23: every action during impersonation records BOTH the support actor and the impersonated '
  'user. audit_events.impersonated_by carries the second actor.';

CREATE TABLE maintenance_notices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid REFERENCES tenants(id),        -- null = all tenants
  title         text NOT NULL,
  body          text NOT NULL,
  severity      severity NOT NULL DEFAULT 'INFO',
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz,
  published_at  timestamptz,
  created_by    uuid REFERENCES users(id)
);

-- doc 23: tenant closure and export workflow. Accounting data survives.
CREATE TABLE tenant_closure_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  requested_by      uuid NOT NULL REFERENCES users(id),
  verified_owner    boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN
    ('REQUESTED','EXPORT_PENDING','EXPORT_READY','INTEGRATIONS_REVOKED','SCHEDULED','COMPLETED','CANCELLED')),
  export_file_id    uuid REFERENCES files(id),
  -- F-404 / doc 23: retention and legal hold override deletion.
  legal_hold        boolean NOT NULL DEFAULT false,
  retention_until   date,
  deletion_scheduled_for date,
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tcr_no_delete_under_hold
    CHECK (NOT legal_hold OR deletion_scheduled_for IS NULL)
);

-- F-410: PII inventory. The classification pass runs during this schema design,
-- the one time the whole schema is reviewed anyway.
CREATE TABLE pii_inventory (
  table_name     text NOT NULL,
  column_name    text NOT NULL,
  data_class     text NOT NULL CHECK (data_class IN
    ('IDENTITY','CONTACT','FINANCIAL_ACCOUNT','GOVERNMENT_ID','LOCATION','BEHAVIOURAL','CREDENTIAL')),
  encryption     text NOT NULL DEFAULT 'AT_REST' CHECK (encryption IN ('AT_REST','FIELD_LEVEL','TOKENIZED')),
  subject_request_action text NOT NULL DEFAULT 'EXPORT'
    CHECK (subject_request_action IN ('EXPORT','ANONYMIZE','RETAIN_STATUTORY')),
  PRIMARY KEY (table_name, column_name)
);
INSERT INTO pii_inventory (table_name, column_name, data_class, encryption, subject_request_action) VALUES
  ('users','email','CONTACT','AT_REST','EXPORT'),
  ('users','display_name','IDENTITY','AT_REST','EXPORT'),
  ('users','password_hash','CREDENTIAL','FIELD_LEVEL','RETAIN_STATUTORY'),
  ('sessions','ip_address','BEHAVIOURAL','AT_REST','ANONYMIZE'),
  ('sessions','user_agent','BEHAVIOURAL','AT_REST','ANONYMIZE'),
  ('contacts','email','CONTACT','AT_REST','EXPORT'),
  ('contacts','phone','CONTACT','AT_REST','EXPORT'),
  ('contacts','tax_identifier','GOVERNMENT_ID','FIELD_LEVEL','RETAIN_STATUTORY'),
  ('contacts','billing_address','LOCATION','AT_REST','RETAIN_STATUTORY'),
  ('contact_bank_details','encrypted_ref','FINANCIAL_ACCOUNT','TOKENIZED','RETAIN_STATUTORY'),
  ('contact_bank_details','iban','FINANCIAL_ACCOUNT','FIELD_LEVEL','RETAIN_STATUTORY'),
  ('bank_accounts','masked_account_number','FINANCIAL_ACCOUNT','FIELD_LEVEL','RETAIN_STATUTORY'),
  ('bank_transactions','counterparty_name','IDENTITY','AT_REST','RETAIN_STATUTORY'),
  ('audit_events','ip_address','BEHAVIOURAL','AT_REST','RETAIN_STATUTORY'),
  ('audit_events','user_agent','BEHAVIOURAL','AT_REST','RETAIN_STATUTORY');

-- ADR-0009 §3/§4: recovery tiers and alert thresholds, previously unquantified
-- (F-304, F-305). Stored so Gate L tests against a stated number.
CREATE TABLE recovery_tiers (
  code        text PRIMARY KEY,
  rpo         interval NOT NULL,
  rto         interval NOT NULL,
  description text NOT NULL
);
INSERT INTO recovery_tiers (code, rpo, rto, description) VALUES
  ('standard', interval '15 minutes', interval '4 hours', 'Default for all tenants'),
  ('critical', interval '5 minutes',  interval '1 hour',  'Opt-in, commercial');

ALTER TABLE tenants ADD COLUMN recovery_tier text NOT NULL DEFAULT 'standard'
  REFERENCES recovery_tiers(code);

CREATE TABLE alert_thresholds (
  signal      text PRIMARY KEY,
  threshold   text NOT NULL,
  gate        text,
  rationale   text NOT NULL
);
INSERT INTO alert_thresholds (signal, threshold, gate, rationale) VALUES
  ('outbox_unpublished_age',        'p99 > 60s',            'Gate L', 'doc 16 observability metric'),
  ('posting_failure_rate',          '> 0.1% over 5min',     'Gate L', 'Financial command failures are never routine'),
  ('connector_consecutive_failures','3',                    'Gate L', 'doc 15 integration health'),
  ('reconciliation_job_failure',    'any',                  'Gate L', 'Gate D depends on these jobs running'),
  ('db_connection_saturation',      '> 80% for 5min',       'Gate L', 'doc 16 database health'),
  ('queue_depth',                   '> 10k or oldest > 15min','Gate L','doc 16 queue depth/age'),
  ('webhook_failure_rate',          '> 5% over 15min',      'Gate L', 'doc 15 delivery health'),
  ('api_5xx_rate',                  '> 0.5% over 5min',     'Gate L', 'doc 16 API error metric');

CREATE TRIGGER subscriptions_updated_at BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE entitlements IS
  'doc 23: the centralized capability check. Modules never reference plan names; they ask this '
  'service whether a capability is enabled for the tenant.';
