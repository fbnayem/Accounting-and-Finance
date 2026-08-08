-- =============================================================================
-- 0018 — AI, document intelligence and controlled automation
-- =============================================================================
-- Phase 8. F-307/F-308: automation thresholds were deferred circularly across
-- three documents, and "confidence" had no defined scale. ADR-0009 §6 makes both
-- structural: confidence is a calibrated probability in [0,1], and a feature
-- with no recorded threshold CANNOT be enabled — enforced at the policy layer.
-- F-409: per-tenant AI spend was uncapped.
-- =============================================================================

CREATE TABLE ai_model_configs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid REFERENCES tenants(id),      -- null = platform default
  feature               text NOT NULL,
  provider              text NOT NULL,
  model                 text NOT NULL,
  model_version         text,
  prompt_policy_version text NOT NULL,
  -- ADR-0009 §6: a raw provider score may not gate automation until calibrated
  -- against the doc 19 evaluation sets.
  is_calibrated         boolean NOT NULL DEFAULT false,
  calibrated_at         timestamptz,
  -- F-307: a feature with no recorded threshold cannot be enabled. The CHECK
  -- makes that a database rule rather than a documentation convention.
  automation_threshold  numeric(8,6) CHECK (automation_threshold IS NULL OR automation_threshold BETWEEN 0 AND 1),
  automation_enabled    boolean NOT NULL DEFAULT false,
  status                record_status NOT NULL DEFAULT 'ACTIVE',
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_automation_requires_threshold
    CHECK (NOT automation_enabled OR (automation_threshold IS NOT NULL AND is_calibrated)),
  CONSTRAINT ai_model_configs_uq UNIQUE NULLS NOT DISTINCT (tenant_id, feature, provider, model, model_version)
);
COMMENT ON CONSTRAINT ai_automation_requires_threshold ON ai_model_configs IS
  'F-307: Gate J requires "evaluation thresholds documented per feature", which doc 13, doc 19 and '
  'Gate J each deferred to one another. Enabling automation without a calibrated threshold now fails.';

-- F-409: doc 23 meters AI usage as billable but specified no spend limit. A
-- tenant uploading 50k pages, or an automation policy in a retry loop, was an
-- uncapped cost to the operator.
CREATE TABLE ai_budgets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  feature           text,                          -- null = tenant-wide cap
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  max_units         numeric(24,4) NOT NULL CHECK (max_units >= 0),
  consumed_units    numeric(24,4) NOT NULL DEFAULT 0 CHECK (consumed_units >= 0),
  unit              text NOT NULL CHECK (unit IN ('PAGES','TOKENS','ACTIONS','REQUESTS')),
  on_exhaustion     text NOT NULL DEFAULT 'FALLBACK'
    CHECK (on_exhaustion IN ('FALLBACK','BLOCK','NOTIFY_ONLY')),
  CONSTRAINT ai_budgets_uq UNIQUE NULLS NOT DISTINCT (tenant_id, feature, period_start)
);

-- ADR-0007: kept generic. decision_type is an enum-by-CHECK; the model output
-- stays in JSON because it is model output, not relational data.
CREATE TABLE ai_decisions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id       uuid REFERENCES legal_entities(id),
  decision_type         text NOT NULL CHECK (decision_type IN
    ('DOCUMENT_EXTRACTION','CODING_SUGGESTION','MATCH_SUGGESTION','ANOMALY',
     'QA_ANSWER','CLOSE_SUMMARY','AGENT_ACTION')),
  resource_type         text,
  resource_id           uuid,
  ai_model_config_id    uuid REFERENCES ai_model_configs(id),
  provider              text NOT NULL,
  model                 text NOT NULL,
  model_version         text,
  prompt_policy_version text,
  -- doc 13: "Every AI suggestion records model/version/input references/
  -- confidence/output/actor decision."
  input_references      jsonb NOT NULL DEFAULT '[]'::jsonb,
  output                jsonb NOT NULL,
  confidence            numeric(8,6) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  status                ai_decision_status NOT NULL DEFAULT 'PROPOSED',
  reviewed_by           uuid REFERENCES users(id),
  reviewed_at           timestamptz,
  review_note           text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_decisions_review_idx ON ai_decisions(tenant_id, status) WHERE status = 'PROPOSED';
CREATE INDEX ai_decisions_resource_idx ON ai_decisions(resource_type, resource_id);

CREATE TABLE ai_extraction_fields (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_decision_id  uuid NOT NULL REFERENCES ai_decisions(id) ON DELETE CASCADE,
  field_name      text NOT NULL,
  extracted_value text,
  normalized_value text,
  confidence      numeric(8,6) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  -- doc 13: "Never discard original evidence." Bounding box / page reference.
  evidence_locator jsonb,
  accepted_value  text,
  accepted_by     uuid REFERENCES users(id),
  UNIQUE (ai_decision_id, field_name)
);

CREATE TABLE ai_evidence_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_decision_id  uuid NOT NULL REFERENCES ai_decisions(id) ON DELETE CASCADE,
  resource_type   text NOT NULL,
  resource_id     uuid NOT NULL,
  relation        text NOT NULL CHECK (relation IN ('SOURCE','SUPPORTING','CITED','MATCHED'))
);
COMMENT ON TABLE ai_evidence_links IS
  'doc 13: "Every material number includes evidence links." Gate J: financial Q&A results must '
  'reconcile to authoritative report APIs, which requires the citation to be a real record.';

-- doc 13: allowlisted tools only. The CHECK is the allowlist — a tool absent
-- from it cannot be recorded, let alone executed.
CREATE TABLE ai_agent_actions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id    uuid REFERENCES legal_entities(id),
  ai_decision_id     uuid REFERENCES ai_decisions(id),
  tool               text NOT NULL CHECK (tool IN
    ('CREATE_DRAFT_BILL','CREATE_DRAFT_JOURNAL','PROPOSE_BANK_MATCH','DRAFT_CUSTOMER_REMINDER',
     'RUN_REPORT','CREATE_TASK','PROPOSE_PAYMENT_HOLD','PROPOSE_VENDOR_HOLD')),
  arguments          jsonb NOT NULL,
  -- doc 13: permission context is evaluated OUTSIDE the model output.
  actor_permission_context jsonb NOT NULL,
  policy_result      text NOT NULL CHECK (policy_result IN ('ALLOWED','REQUIRES_APPROVAL','DENIED')),
  confidence         numeric(8,6) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  requires_approval  boolean NOT NULL DEFAULT true,
  idempotency_key    text NOT NULL,
  approved_by        uuid REFERENCES users(id),
  approved_at        timestamptz,
  executed_at        timestamptz,
  execution_result   jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  -- doc 13: high-risk actions ALWAYS require human approval initially.
  CONSTRAINT ai_action_not_executed_without_approval
    CHECK (executed_at IS NULL OR NOT requires_approval OR approved_by IS NOT NULL)
);
COMMENT ON CONSTRAINT ai_action_not_executed_without_approval ON ai_agent_actions IS
  'Gate J: "AI cannot post, pay, close periods or alter configuration outside explicit allowed '
  'policy." The tool allowlist deliberately contains no POST, PAY, CLOSE or FILE verb.';

CREATE TABLE anomalies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid REFERENCES legal_entities(id),
  anomaly_type    text NOT NULL,
  severity        severity NOT NULL DEFAULT 'MEDIUM',
  resource_type   text,
  resource_id     uuid,
  evidence        jsonb NOT NULL,
  detector        text NOT NULL,
  detector_version text,
  status          anomaly_status NOT NULL DEFAULT 'OPEN',
  owner_user_id   uuid REFERENCES users(id),
  resolution      text,
  -- doc 13: false-positive feedback drives the doc 19 evaluation sets.
  false_positive_reason text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);
CREATE INDEX anomalies_open_idx ON anomalies(tenant_id, severity, created_at DESC) WHERE status = 'OPEN';

CREATE TABLE human_review_tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  ai_decision_id  uuid REFERENCES ai_decisions(id),
  task_id         uuid REFERENCES tasks(id),
  reason          text NOT NULL CHECK (reason IN
    ('LOW_CONFIDENCE','POLICY_REQUIRED','THRESHOLD_NOT_MET','VALIDATION_FAILED','SAMPLED')),
  status          task_status NOT NULL DEFAULT 'OPEN',
  reviewed_by     uuid REFERENCES users(id),
  reviewed_at     timestamptz,
  outcome         text CHECK (outcome IN ('ACCEPTED','CORRECTED','REJECTED')),
  corrections     jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- doc 19: labelled sets for extraction accuracy, coding top-1/top-3, matching
-- precision/recall, anomaly precision and Q&A correctness.
CREATE TABLE ai_evaluation_cases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature         text NOT NULL,
  case_ref        text NOT NULL,
  input_payload   jsonb NOT NULL,
  expected_output jsonb NOT NULL,
  labelled_by     text,
  labelled_at     date,
  status          record_status NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (feature, case_ref)
);

CREATE TABLE ai_evaluation_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature            text NOT NULL,
  ai_model_config_id uuid REFERENCES ai_model_configs(id),
  run_at             timestamptz NOT NULL DEFAULT now(),
  cases_total        integer NOT NULL,
  cases_passed       integer NOT NULL,
  precision_score    numeric(8,6),
  recall_score       numeric(8,6),
  metrics            jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- ADR-0009 §6: a config may only be marked calibrated by a passing run.
  meets_threshold    boolean NOT NULL DEFAULT false
);

CREATE TABLE automation_policies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid REFERENCES legal_entities(id),
  code            text NOT NULL,
  name            text NOT NULL,
  version         integer NOT NULL,
  trigger_type    text NOT NULL,
  conditions      jsonb NOT NULL,
  actions         jsonb NOT NULL,
  confidence_threshold numeric(8,6) CHECK (confidence_threshold IS NULL OR confidence_threshold BETWEEN 0 AND 1),
  requires_approval boolean NOT NULL DEFAULT true,
  valid_from      timestamptz NOT NULL DEFAULT now(),
  valid_to        timestamptz,
  status          record_status NOT NULL DEFAULT 'ACTIVE',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code, version)
);
ALTER TABLE automation_policies ADD CONSTRAINT automation_policies_no_overlap
  EXCLUDE USING gist (tenant_id WITH =, code WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&);

-- doc 13: "Treat text inside uploaded documents/emails as untrusted data, not
-- instructions." F-411 noted the principle had no mechanism. Provenance is
-- recorded at ingestion so Phase 8 does not have to retrofit the distinction.
CREATE TABLE document_extractions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  file_id         uuid NOT NULL REFERENCES files(id),
  ai_decision_id  uuid REFERENCES ai_decisions(id),
  document_class  text,
  extracted_text  text,
  -- F-411: everything from an uploaded document is untrusted by construction.
  trust_level     text NOT NULL DEFAULT 'UNTRUSTED'
    CHECK (trust_level IN ('UNTRUSTED','OPERATOR_REVIEWED')),
  totals_validated boolean NOT NULL DEFAULT false,
  duplicate_of_file_id uuid REFERENCES files(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN document_extractions.trust_level IS
  'F-411: doc 13 states the principle; this column makes provenance structural so a Phase 8 tool '
  'layer cannot accidentally treat document text as instruction.';
