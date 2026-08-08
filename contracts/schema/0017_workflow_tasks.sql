-- =============================================================================
-- 0017 — Workflows, approvals, tasks and notifications
-- =============================================================================
-- Phase 6 (notifications from Phase 1). F-204: Task, Notification, Delegation,
-- EscalationRule and AutomationAction were all missing, in the phase where
-- Gate F is proven. F-010: approval_workflows had version columns with no
-- overlap constraint.
-- =============================================================================

CREATE TABLE approval_workflows (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid REFERENCES legal_entities(id),
  resource_type   text NOT NULL,
  code            text NOT NULL,
  name            text NOT NULL,
  version         integer NOT NULL,
  valid_from      timestamptz NOT NULL,
  valid_to        timestamptz,
  -- doc 14: conditions on amount, currency, vendor/customer, account, category,
  -- project, department, risk flag, exception status.
  conditions      jsonb NOT NULL DEFAULT '{}'::jsonb,
  definition      jsonb NOT NULL,
  -- doc 14: "Published workflow versions are immutable."
  published_at    timestamptz,
  status          record_status NOT NULL DEFAULT 'ACTIVE',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, resource_type, code, version),
  CONSTRAINT aw_dates CHECK (valid_to IS NULL OR valid_to > valid_from)
);
-- F-010 pattern: two versions of the same workflow cannot be simultaneously
-- effective for the same resource type and scope.
ALTER TABLE approval_workflows ADD CONSTRAINT approval_workflows_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =, resource_type WITH =, code WITH =,
    coalesce(legal_entity_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    tstzrange(valid_from, valid_to, '[)') WITH &&
  ) WHERE (published_at IS NOT NULL);

-- doc 14: "Published workflow versions are immutable. A running instance retains
-- the version it started with."
CREATE OR REPLACE FUNCTION guard_published_workflow()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published_at IS NOT NULL
     AND ROW(NEW.definition, NEW.conditions, NEW.version, NEW.resource_type)
         IS DISTINCT FROM ROW(OLD.definition, OLD.conditions, OLD.version, OLD.resource_type) THEN
    RAISE EXCEPTION
      'WORKFLOW_PUBLISHED: workflow % version % is published; create a new version (doc 14).',
      OLD.code, OLD.version USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_workflows_immutable BEFORE UPDATE ON approval_workflows
  FOR EACH ROW EXECUTE FUNCTION guard_published_workflow();

-- doc 14: configurable segregation-of-duties constraints. F-204: absent.
CREATE TABLE segregation_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid REFERENCES legal_entities(id),
  code            text NOT NULL,
  description     text NOT NULL,
  rule_type       text NOT NULL CHECK (rule_type IN
    ('NO_SELF_APPROVE','PREPARER_NE_APPROVER','DUAL_APPROVAL_OVER_THRESHOLD',
     'BANK_CHANGE_INDEPENDENT_REVIEW','PERIOD_REOPEN_PRIVILEGED','TAX_FILING_SEPARATION')),
  resource_type   text,
  threshold_amount numeric(24,8),
  status          record_status NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (tenant_id, code)
);

CREATE TABLE approval_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id     uuid REFERENCES legal_entities(id),
  approval_workflow_id uuid NOT NULL REFERENCES approval_workflows(id),
  -- doc 14: the instance retains the version it started with. Recorded, not
  -- inferred, so a later workflow edit cannot change a running instance.
  workflow_version    integer NOT NULL,
  resource_type       text NOT NULL,
  resource_id         uuid NOT NULL,
  status              approval_status NOT NULL DEFAULT 'PENDING',
  requested_by        uuid REFERENCES users(id),
  requested_at        timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  -- doc 14: "Editing a submitted document can invalidate previous approvals."
  document_version    bigint,
  snapshot            jsonb NOT NULL,
  UNIQUE (resource_type, resource_id, requested_at)
);
CREATE INDEX approval_requests_resource_idx ON approval_requests(resource_type, resource_id);
CREATE INDEX approval_requests_pending_idx  ON approval_requests(tenant_id) WHERE status = 'PENDING';

CREATE TABLE approval_steps (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_request_id uuid NOT NULL REFERENCES approval_requests(id) ON DELETE RESTRICT,
  step_no             integer NOT NULL,
  is_parallel         boolean NOT NULL DEFAULT false,
  approver_user_id    uuid REFERENCES users(id),
  approver_role_id    uuid REFERENCES roles(id),
  resolved_from       text CHECK (resolved_from IN
    ('NAMED_USER','ROLE','MANAGER','DEPARTMENT_OWNER','PROJECT_MANAGER','AMOUNT_AUTHORITY','CUSTOM')),
  status              approval_status NOT NULL DEFAULT 'PENDING',
  decision            approval_decision,
  decision_reason     text,
  decided_by          uuid REFERENCES users(id),
  decided_at          timestamptz,
  -- doc 14: decision records actor, timestamp, comment and session context.
  ip_address          inet,
  session_id          uuid REFERENCES sessions(id),
  escalated_at        timestamptz,
  expires_at          timestamptz,
  -- F-017: both approver columns are nullable, so the blueprint's UNIQUE was
  -- defeated by NULL-distinctness.
  CONSTRAINT approval_steps_uq
    UNIQUE NULLS NOT DISTINCT (approval_request_id, step_no, approver_user_id, approver_role_id),
  CONSTRAINT approval_steps_has_approver
    CHECK (approver_user_id IS NOT NULL OR approver_role_id IS NOT NULL)
);
CREATE INDEX approval_steps_inbox_idx ON approval_steps(approver_user_id, status) WHERE status = 'PENDING';

CREATE TABLE delegations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  delegator_user_id uuid NOT NULL REFERENCES users(id),
  delegate_user_id  uuid NOT NULL REFERENCES users(id),
  scope_resource_type text,
  legal_entity_id   uuid REFERENCES legal_entities(id),
  max_amount        numeric(24,8),
  valid_from        timestamptz NOT NULL,
  valid_to          timestamptz NOT NULL,
  reason            text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (delegator_user_id <> delegate_user_id),
  CHECK (valid_to > valid_from)
);
-- doc 14: "Delegation cannot violate segregation-of-duties." Overlapping
-- delegations for the same delegator and scope are rejected.
ALTER TABLE delegations ADD CONSTRAINT delegations_no_overlap
  EXCLUDE USING gist (
    delegator_user_id WITH =,
    coalesce(scope_resource_type, '*') WITH =,
    tstzrange(valid_from, valid_to, '[)') WITH &&
  );

CREATE TABLE escalation_rules (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  approval_workflow_id uuid REFERENCES approval_workflows(id),
  after_interval       interval NOT NULL,
  action               text NOT NULL CHECK (action IN ('REMIND','ADD_WATCHER','REASSIGN','ADD_APPROVER','CANCEL')),
  target_role_id       uuid REFERENCES roles(id),
  target_user_id       uuid REFERENCES users(id),
  status               record_status NOT NULL DEFAULT 'ACTIVE'
);

-- ----------------------------------------------------------------------------
-- Unified task inbox — doc 14 lists 10 source types. F-204: absent entirely.
-- ----------------------------------------------------------------------------
CREATE TABLE tasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id   uuid REFERENCES legal_entities(id),
  source_type       text NOT NULL CHECK (source_type IN
    ('APPROVAL','BANK_RECONCILIATION','BILL_MATCH','MISSING_DOCUMENT','COLLECTIONS',
     'CLOSE','TAX_EXCEPTION','AI_REVIEW','INTEGRATION_FAILURE','MIGRATION_ERROR')),
  source_id         uuid,
  title             text NOT NULL,
  description       text,
  owner_user_id     uuid REFERENCES users(id),
  owner_role_id     uuid REFERENCES roles(id),
  priority          task_priority NOT NULL DEFAULT 'NORMAL',
  status            task_status NOT NULL DEFAULT 'OPEN',
  due_at            timestamptz,
  tags              text[] NOT NULL DEFAULT '{}',
  completion_evidence jsonb,
  completed_by      uuid REFERENCES users(id),
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_inbox_idx  ON tasks(owner_user_id, status, due_at) WHERE status IN ('OPEN','IN_PROGRESS');
CREATE INDEX tasks_source_idx ON tasks(source_type, source_id);

CREATE TABLE automation_actions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  approval_workflow_id uuid REFERENCES approval_workflows(id),
  trigger_event        text NOT NULL,
  action_type          text NOT NULL CHECK (action_type IN
    ('CREATE_TASK','SEND_NOTIFICATION','TAG_DOCUMENT','HOLD_DOCUMENT','CALL_WEBHOOK',
     'REQUEST_AI_SUGGESTION','GENERATE_DRAFT')),
  action_config        jsonb NOT NULL,
  status               record_status NOT NULL DEFAULT 'ACTIVE'
);
COMMENT ON TABLE automation_actions IS
  'doc 14: "Any financial posting/payment remains a normal domain command with its own permission '
  'and approval rules." The action_type CHECK deliberately excludes POST and PAY.';

-- --------------------------------------------------------- notifications -----
CREATE TABLE notification_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid REFERENCES tenants(id),      -- null = platform default
  code          text NOT NULL,
  locale        text NOT NULL DEFAULT 'en',       -- F-405: locale from day one
  channel       text NOT NULL CHECK (channel IN ('IN_APP','EMAIL','SMS','PUSH')),
  version       integer NOT NULL DEFAULT 1,
  subject       text,
  body          text NOT NULL,
  -- doc 14: "Template variables are allowlisted."
  allowed_variables text[] NOT NULL DEFAULT '{}',
  effective_from timestamptz NOT NULL DEFAULT now(),
  status        record_status NOT NULL DEFAULT 'ACTIVE',
  CONSTRAINT nt_uq UNIQUE NULLS NOT DISTINCT (tenant_id, code, locale, channel, version)
);

CREATE TABLE notification_preferences (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  user_id       uuid REFERENCES users(id),
  contact_id    uuid REFERENCES contacts(id),
  category      text NOT NULL,
  channel       text NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  -- doc 23: transactional/security notices may be mandatory; marketing
  -- preferences stay separate from operational finance notifications.
  is_mandatory  boolean NOT NULL DEFAULT false,
  CONSTRAINT np_uq UNIQUE NULLS NOT DISTINCT (tenant_id, user_id, contact_id, category, channel),
  CONSTRAINT np_has_subject CHECK (user_id IS NOT NULL OR contact_id IS NOT NULL)
);

CREATE TABLE notification_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid REFERENCES legal_entities(id),
  template_id     uuid REFERENCES notification_templates(id),
  channel         text NOT NULL,
  category        text NOT NULL,
  recipient_user_id uuid REFERENCES users(id),
  recipient_contact_id uuid REFERENCES contacts(id),
  recipient_address text,
  subject         text,
  body            text,
  -- doc 14: "Do not put sensitive bank/account information into notification
  -- content by default."
  contains_sensitive boolean NOT NULL DEFAULT false,
  status          delivery_status NOT NULL DEFAULT 'QUEUED',
  source_type     text,
  source_id       uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_messages_pending_idx ON notification_messages(status, created_at)
  WHERE status IN ('QUEUED','DELIVERING');

CREATE TABLE notification_delivery_attempts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_message_id uuid NOT NULL REFERENCES notification_messages(id) ON DELETE CASCADE,
  attempt                 integer NOT NULL,
  provider                text,
  provider_message_id     text,
  status                  delivery_status NOT NULL,
  error                   text,
  attempted_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (notification_message_id, attempt)
);

COMMENT ON TABLE tasks IS
  'F-204: doc 14 specifies a unified inbox across 10 source types; no table existed. '
  'Gate F depends on approval tasks being enumerable and auditable.';
