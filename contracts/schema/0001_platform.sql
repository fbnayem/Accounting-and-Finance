-- =============================================================================
-- 0001 — Platform: tenancy, outbox, idempotency, audit, files, feature flags
-- =============================================================================
-- Phase 0/1. Resolves F-041 (outbox envelope), F-042 (consumer checkpoints),
-- F-043 (immutable audit), F-044 (idempotency protocol), F-048 (tenant-scoped
-- object keys), F-050 (polymorphic reference discipline).
-- =============================================================================

CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  slug          citext NOT NULL UNIQUE,
  status        record_status NOT NULL DEFAULT 'ACTIVE',
  -- F-408: data residency must be recorded per tenant, not assumed.
  data_region   text NOT NULL DEFAULT 'default',
  -- F-409: external model processing can be disabled per tenant (doc 23).
  ai_processing_enabled boolean NOT NULL DEFAULT true,
  suspended_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  name          text NOT NULL,
  display_name  text,
  status        record_status NOT NULL DEFAULT 'ACTIVE',
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  version       bigint NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- ADR-0002: composite key so children can enforce same-tenant references.
  CONSTRAINT organizations_scope_uq UNIQUE (id, tenant_id)
);
CREATE INDEX organizations_tenant_idx ON organizations(tenant_id);

-- ----------------------------------------------------------------------------
-- Feature flags — Phase 0 exit dependency (doc 21 Phase 0 Build).
-- F-203 noted these were absent though Phase 0 requires them.
-- ----------------------------------------------------------------------------
CREATE TABLE feature_flags (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,
  description   text NOT NULL,
  default_enabled boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE feature_flag_overrides (
  feature_flag_id uuid NOT NULL REFERENCES feature_flags(id) ON DELETE CASCADE,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  enabled         boolean NOT NULL,
  reason          text,
  set_by          uuid,      -- FK added in 0002 once users exists
  set_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (feature_flag_id, tenant_id)
);

-- ----------------------------------------------------------------------------
-- Transactional outbox
-- F-041 / F-103: the event envelope marks organization_id and legal_entity_id
--        REQUIRED; they are indexed columns, not payload JSON, so entity-scoped
--        webhook subscriptions and per-entity replay can filter on them.
--        (F-041 is the schema view of the defect, F-103 the contract view.)
-- ----------------------------------------------------------------------------
CREATE TABLE outbox_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          uuid NOT NULL UNIQUE,      -- F-041: envelope requires global uniqueness
  event_type        text NOT NULL,             -- validated against contracts/events.yaml
  event_version     integer NOT NULL DEFAULT 1,
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  organization_id   uuid REFERENCES organizations(id),
  legal_entity_id   uuid,                      -- FK added in 0003; null only for platform scope
  accounting_book_id uuid,                     -- FK added in 0004
  branch_id         uuid,                      -- FK added in 0003
  aggregate_type    text NOT NULL,
  aggregate_id      uuid NOT NULL,
  actor_id          uuid,
  actor_kind        actor_type,
  payload           jsonb NOT NULL,
  correlation_id    text,
  causation_id      text,
  idempotency_key   text,
  source_system     text,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  published_at      timestamptz,
  attempts          integer NOT NULL DEFAULT 0,
  last_error        text
);
-- Drain query shape (kept from the blueprint — this was a good index).
CREATE INDEX outbox_unpublished_idx ON outbox_events(occurred_at) WHERE published_at IS NULL;
CREATE INDEX outbox_scope_idx ON outbox_events(tenant_id, legal_entity_id, event_type, occurred_at DESC);

-- F-042: doc 01 requires "consumers are idempotent and record checkpoints/event IDs".
CREATE TABLE outbox_consumer_checkpoints (
  consumer          text PRIMARY KEY,
  last_event_id     uuid,
  last_occurred_at  timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE processed_events (
  consumer          text NOT NULL,
  event_id          uuid NOT NULL,
  processed_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);
-- F-404: retention. Reaped after 30 days; the checkpoint carries longer-term position.
CREATE INDEX processed_events_reap_idx ON processed_events(processed_at);

-- ----------------------------------------------------------------------------
-- Idempotency — F-044. Protocol is normative and stated here so it cannot drift.
--   new key                       -> insert row, execute, store response
--   row exists, locked_until > now-> 409 IN_PROGRESS
--   row exists, response stored   -> replay stored response
--   row exists, request_hash differs -> 422 IDEMPOTENCY_KEY_REUSE
-- ----------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  idempotency_key text NOT NULL,
  operation       text NOT NULL,          -- operationId from contracts/openapi.yaml
  request_hash    text NOT NULL,
  response_code   integer,
  response_body   jsonb,
  resource_type   text,
  resource_id     uuid,
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  UNIQUE (tenant_id, operation, idempotency_key)
);
CREATE INDEX idempotency_keys_reap_idx ON idempotency_keys(expires_at);   -- F-044

-- ----------------------------------------------------------------------------
-- Audit log — F-043: doc 16 says "immutable"; the blueprint had no mechanism.
-- Hash chain supports doc 12's exportable audit trail and the Phase 6 audit
-- workspace. Cheap to add now, impossible to backfill.
-- ----------------------------------------------------------------------------
CREATE TABLE audit_events (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  organization_id uuid REFERENCES organizations(id),
  legal_entity_id uuid,                    -- FK added in 0003
  actor_kind      actor_type NOT NULL,
  actor_id        text,
  impersonated_by uuid,                    -- doc 23: support impersonation records both actors
  action          text NOT NULL,
  resource_type   text NOT NULL,
  resource_id     text,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  correlation_id  text,
  ip_address      inet,
  user_agent      text,
  before_data     jsonb,
  after_data      jsonb,
  reason          text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash       text,
  row_hash        text
);
CREATE INDEX audit_events_resource_idx ON audit_events(tenant_id, resource_type, resource_id, occurred_at DESC);
CREATE INDEX audit_events_actor_idx    ON audit_events(tenant_id, actor_id, occurred_at DESC);

CREATE TRIGGER audit_events_immutable
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_of_posted();

-- ----------------------------------------------------------------------------
-- Files — F-048: doc 16 requires tenant-scoped object keys. Made structural.
-- ----------------------------------------------------------------------------
CREATE TABLE files (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  storage_key       text NOT NULL UNIQUE,
  original_filename text NOT NULL,
  media_type        text,
  byte_size         bigint,
  sha256            text,                       -- doc 13: dedup + evidence integrity
  scan_state        scan_status NOT NULL DEFAULT 'PENDING',
  scanned_at        timestamptz,
  created_by        uuid,                       -- FK added in 0002
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- F-048: a cross-tenant object key is impossible, not merely discouraged.
  CONSTRAINT files_key_is_tenant_scoped CHECK (storage_key LIKE tenant_id::text || '/%'),
  CONSTRAINT files_scope_uq UNIQUE (id, tenant_id)
);
CREATE INDEX files_hash_idx ON files(tenant_id, sha256) WHERE sha256 IS NOT NULL;

-- F-050: polymorphic link. `resource_type` is constrained by the application's
-- enumerated registry and swept nightly for orphans into the Gate D suite.
CREATE TABLE file_links (
  file_id       uuid NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  resource_type text NOT NULL,
  resource_id   uuid NOT NULL,
  link_type     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, resource_type, resource_id)
);
CREATE INDEX file_links_resource_idx ON file_links(resource_type, resource_id);

-- ----------------------------------------------------------------------------
-- Retention schedule — F-404. The specification had no policy at all.
-- ----------------------------------------------------------------------------
CREATE TABLE retention_policies (
  table_name     text PRIMARY KEY,
  retention      interval,          -- NULL = indefinite
  legal_hold_overrides boolean NOT NULL DEFAULT true,
  rationale      text NOT NULL
);
INSERT INTO retention_policies (table_name, retention, rationale) VALUES
  ('journal_entries',    NULL,               'Posted accounting fact; retained indefinitely (doc 01 rule 1)'),
  ('journal_lines',      NULL,               'Posted accounting fact'),
  ('audit_events',       interval '7 years', 'Statutory audit trail minimum'),
  ('outbox_events',      interval '30 days', 'Purged after publication; durable record lives on the aggregate'),
  ('processed_events',   interval '30 days', 'Consumer dedupe window'),
  ('idempotency_keys',   interval '30 days', 'Retry window'),
  ('bank_transactions',  NULL,               'Reconciliation evidence; raw_payload purged separately at 90 days');

CREATE TRIGGER tenants_updated_at       BEFORE UPDATE ON tenants       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER organizations_updated_at BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE outbox_events IS
  'F-041: organization_id/legal_entity_id are indexed columns because the event envelope marks them required.';
COMMENT ON TABLE audit_events IS
  'F-043: immutable by trigger and by revoked privilege (see 0006). Hash chain supports doc 12 audit export.';
