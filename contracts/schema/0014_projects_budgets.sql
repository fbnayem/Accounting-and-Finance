-- =============================================================================
-- 0014 — Projects, cost centers, budgets and management accounting
-- =============================================================================
-- Phase 5. Resolves F-009 (budget_lines.dimensions jsonb), F-049 (free-text
-- status), and adds the budget-control substrate F-106 found missing
-- (/budget-control/check had no table behind it, so control was advisory only).
--
-- doc 10: Department and CostCenter are dimension values, not dedicated tables.
-- "Avoid creating a new GL account for every department/project combination."
-- =============================================================================

CREATE TABLE projects (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  organization_id   uuid NOT NULL REFERENCES organizations(id),
  legal_entity_id   uuid,
  customer_id       uuid,
  manager_user_id   uuid REFERENCES users(id),
  code              text NOT NULL,
  name              text NOT NULL,
  start_date        date,
  end_date          date,
  contract_value    numeric(24,8),
  currency          char(3) REFERENCES currencies(code),
  billing_method    text CHECK (billing_method IN
    ('FIXED_FEE','MILESTONE','TIME_AND_MATERIALS','EXPENSE_REIMBURSEMENT','RETAINER','PROGRESS')),
  status            project_status NOT NULL DEFAULT 'PLANNED',
  -- doc 10: closing blocks new ordinary cost/billing unless reopened.
  closed_at         timestamptz,
  settings          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code),
  CONSTRAINT projects_org_scope_fk FOREIGN KEY (organization_id, tenant_id) REFERENCES organizations(id, tenant_id),
  CONSTRAINT projects_customer_fk FOREIGN KEY (customer_id, tenant_id) REFERENCES contacts(id, tenant_id),
  CONSTRAINT projects_scope_uq UNIQUE (id, organization_id)
);
ALTER TABLE invoices     ADD CONSTRAINT invoices_project_fk FOREIGN KEY (project_id) REFERENCES projects(id);
ALTER TABLE vendor_bills ADD CONSTRAINT bills_project_fk    FOREIGN KEY (project_id) REFERENCES projects(id);

CREATE TABLE project_phases (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  code         text NOT NULL,
  name         text NOT NULL,
  start_date   date,
  end_date     date,
  budget_amount numeric(24,8),
  status       project_status NOT NULL DEFAULT 'PLANNED',
  UNIQUE (project_id, code)
);

CREATE TABLE time_entries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  project_id     uuid NOT NULL REFERENCES projects(id),
  project_phase_id uuid REFERENCES project_phases(id),
  user_id        uuid NOT NULL REFERENCES users(id),
  entry_date     date NOT NULL,
  hours          numeric(12,4) NOT NULL CHECK (hours > 0),
  billable       boolean NOT NULL DEFAULT true,
  billed         boolean NOT NULL DEFAULT false,
  cost_rate      numeric(24,8),
  billing_rate   numeric(24,8),
  currency       char(3) REFERENCES currencies(code),
  description    text,
  approved_by    uuid REFERENCES users(id),
  approved_at    timestamptz,
  invoice_line_id uuid REFERENCES invoice_lines(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX time_entries_project_idx ON time_entries(project_id, entry_date);
CREATE INDEX time_entries_unbilled_idx ON time_entries(project_id) WHERE billable AND NOT billed;

CREATE TABLE project_billing_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  rule_type    text NOT NULL,
  definition   jsonb NOT NULL,
  valid_from   date NOT NULL,
  valid_to     date,
  status       record_status NOT NULL DEFAULT 'ACTIVE'
);

-- doc 10: "Billing proposal gathers approved billable facts ... then creates a
-- normal AR invoice draft. No direct revenue posting from the project module."
CREATE TABLE billing_proposals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  project_id        uuid NOT NULL REFERENCES projects(id),
  legal_entity_id   uuid NOT NULL,
  period_start      date,
  period_end        date,
  currency          char(3) NOT NULL REFERENCES currencies(code),
  proposed_amount   numeric(24,8) NOT NULL DEFAULT 0,
  previously_billed numeric(24,8) NOT NULL DEFAULT 0,
  unbilled_amount   numeric(24,8) NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','REVIEW','APPROVED','INVOICED','CANCELLED')),
  invoice_id        uuid REFERENCES invoices(id),
  reviewed_by       uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- Budgets. doc 10: "Never overwrite approved budget. Revision creates a new
-- version while preserving Original Budget and Current Approved Budget."
-- ----------------------------------------------------------------------------
CREATE TABLE budgets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id    uuid NOT NULL,
  accounting_book_id uuid NOT NULL,
  fiscal_year_id     uuid NOT NULL,
  name               text NOT NULL,
  version            integer NOT NULL DEFAULT 1,
  scenario           text NOT NULL DEFAULT 'BASE' CHECK (scenario IN ('BASE','BEST','WORST','CUSTOM')),
  currency           char(3) NOT NULL REFERENCES currencies(code),
  status             budget_status NOT NULL DEFAULT 'DRAFT',
  -- doc 10 budget control policy. F-310: the blueprint shipped no default.
  control_policy     budget_control_policy NOT NULL DEFAULT 'INFORMATIONAL',
  control_threshold_pct numeric(9,6),
  owner_user_id      uuid REFERENCES users(id),
  supersedes_budget_id uuid REFERENCES budgets(id),
  approved_by        uuid REFERENCES users(id),
  approved_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, accounting_book_id, name, version),
  CONSTRAINT budgets_book_scope_fk FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id),
  CONSTRAINT budgets_fy_scope_fk   FOREIGN KEY (fiscal_year_id, legal_entity_id) REFERENCES fiscal_years(id, legal_entity_id),
  CONSTRAINT budgets_scope_uq UNIQUE (id, legal_entity_id)
);
-- One ACTIVE budget per name per book; earlier versions become SUPERSEDED.
CREATE UNIQUE INDEX budgets_one_active_idx
  ON budgets(legal_entity_id, accounting_book_id, name) WHERE status = 'ACTIVE';

-- An APPROVED or later budget is immutable; a change is a new version (doc 10).
CREATE OR REPLACE FUNCTION guard_budget_versioning()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('APPROVED','ACTIVE','SUPERSEDED','CLOSED')
     AND NEW.status = OLD.status
     AND ROW(NEW.version, NEW.fiscal_year_id, NEW.currency, NEW.scenario)
         IS DISTINCT FROM ROW(OLD.version, OLD.fiscal_year_id, OLD.currency, OLD.scenario) THEN
    RAISE EXCEPTION
      'BUDGET_IMMUTABLE: budget % is %; revise to create a new version (doc 10).', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER budgets_versioning BEFORE UPDATE ON budgets
  FOR EACH ROW EXECUTE FUNCTION guard_budget_versioning();

CREATE TABLE budget_lines (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id            uuid NOT NULL REFERENCES budgets(id) ON DELETE RESTRICT,   -- F-023 pattern
  legal_entity_id      uuid NOT NULL,
  accounting_period_id uuid NOT NULL,
  account_id           uuid NOT NULL,
  amount               numeric(24,8) NOT NULL,
  currency             char(3) NOT NULL REFERENCES currencies(code),
  CONSTRAINT bl_account_scope_fk FOREIGN KEY (account_id, legal_entity_id) REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT bl_period_scope_fk  FOREIGN KEY (accounting_period_id, legal_entity_id) REFERENCES accounting_periods(id, legal_entity_id)
  -- F-009: dimensions live in document_line_dimensions, not a jsonb column.
);
CREATE INDEX budget_lines_lookup_idx ON budget_lines(budget_id, accounting_period_id, account_id);

-- doc 10: Available = Approved - Actual Posted - Open Commitments - Pending Spend.
-- F-106 noted /budget-control/check had no substrate; commitments are it.
CREATE TABLE commitments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id      uuid NOT NULL,
  accounting_book_id   uuid NOT NULL,
  accounting_period_id uuid NOT NULL,
  account_id           uuid NOT NULL,
  source_type          text NOT NULL CHECK (source_type IN ('PURCHASE_REQUISITION','PURCHASE_ORDER')),
  source_id            uuid NOT NULL,
  source_line_id       uuid,
  currency             char(3) NOT NULL REFERENCES currencies(code),
  committed_amount     numeric(24,8) NOT NULL CHECK (committed_amount >= 0),
  relieved_amount      numeric(24,8) NOT NULL DEFAULT 0 CHECK (relieved_amount >= 0),
  open_amount          numeric(24,8) NOT NULL,
  status               commitment_status NOT NULL DEFAULT 'OPEN',
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- doc 10 acceptance: "Closing/canceling PO releases unused commitment."
  CONSTRAINT commitments_open_derived CHECK (open_amount = committed_amount - relieved_amount),
  CONSTRAINT commitments_relieved_bounded CHECK (relieved_amount <= committed_amount),
  CONSTRAINT commitments_account_scope_fk FOREIGN KEY (account_id, legal_entity_id) REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT commitments_period_scope_fk FOREIGN KEY (accounting_period_id, legal_entity_id) REFERENCES accounting_periods(id, legal_entity_id)
);
CREATE INDEX commitments_open_idx
  ON commitments(accounting_book_id, accounting_period_id, account_id) WHERE status <> 'RELIEVED';

CREATE TABLE forecast_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id    uuid NOT NULL,
  accounting_book_id uuid NOT NULL,
  fiscal_year_id     uuid NOT NULL,
  name               text NOT NULL,
  version            integer NOT NULL DEFAULT 1,
  scenario           text NOT NULL DEFAULT 'BASE',
  as_of_date         date NOT NULL,
  status             text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','SUPERSEDED')),
  published_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, accounting_book_id, name, version)
);
COMMENT ON TABLE forecast_versions IS
  'doc 10: "Forecast data can be used in reports but never changes ledger." No accounting_entry_id '
  'column exists here by design.';

CREATE TABLE forecast_lines (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  forecast_version_id  uuid NOT NULL REFERENCES forecast_versions(id) ON DELETE CASCADE,
  legal_entity_id      uuid NOT NULL,
  accounting_period_id uuid NOT NULL,
  account_id           uuid NOT NULL,
  amount               numeric(24,8) NOT NULL,
  currency             char(3) NOT NULL REFERENCES currencies(code),
  CONSTRAINT fl_account_scope_fk FOREIGN KEY (account_id, legal_entity_id) REFERENCES accounts(id, legal_entity_id)
);

-- doc 10: management allocations may produce actual journals or be
-- reporting-only. If actual, they use the normal posting service.
CREATE TABLE allocation_rules (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id    uuid NOT NULL,
  accounting_book_id uuid NOT NULL,
  code               text NOT NULL,
  name               text NOT NULL,
  version            integer NOT NULL DEFAULT 1,
  posts_actual_journal boolean NOT NULL DEFAULT false,
  source_definition  jsonb NOT NULL,
  target_definition  jsonb NOT NULL,
  basis              text NOT NULL,
  valid_from         date NOT NULL,
  valid_to           date,
  status             record_status NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (legal_entity_id, code, version),
  CONSTRAINT ar_book_scope_fk FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id)
);
ALTER TABLE allocation_rules ADD CONSTRAINT allocation_rules_no_overlap
  EXCLUDE USING gist (legal_entity_id WITH =, code WITH =, daterange(valid_from, valid_to, '[)') WITH &&);

COMMENT ON TABLE commitments IS
  'F-106: /budget-control/check had no substrate, so doc 10''s block/warn/override policy could '
  'only ever have been advisory. Gate: "budget control includes actual + commitment correctly."';
