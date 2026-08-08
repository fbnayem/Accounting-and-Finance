-- Accounting Platform — PostgreSQL Schema Blueprint
-- This is an implementation starting blueprint, not the final migration set.
-- Split into bounded-context migrations in production and add tenant/entity consistency constraints per aggregate.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE record_status AS ENUM ('ACTIVE','INACTIVE','ARCHIVED');
CREATE TYPE period_status AS ENUM ('OPEN','SOFT_CLOSED','HARD_CLOSED');
CREATE TYPE journal_status AS ENUM ('DRAFT','SUBMITTED','APPROVED','POSTED','REVERSED');
CREATE TYPE document_status AS ENUM ('DRAFT','SUBMITTED','APPROVED','POSTED','PARTIALLY_PAID','PAID','VOID','CANCELLED','CLOSED');
CREATE TYPE contact_type AS ENUM ('CUSTOMER','VENDOR','BOTH');
CREATE TYPE account_type AS ENUM ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE');
CREATE TYPE normal_balance AS ENUM ('DEBIT','CREDIT');
CREATE TYPE approval_status AS ENUM ('NOT_REQUIRED','PENDING','APPROVED','REJECTED','CANCELLED');

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  status record_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  display_name text,
  status record_status NOT NULL DEFAULT 'ACTIVE',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX organizations_tenant_idx ON organizations(tenant_id);

CREATE TABLE legal_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  code text NOT NULL,
  legal_name text NOT NULL,
  registration_number text,
  tax_identifier text,
  country_code char(2) NOT NULL,
  functional_currency char(3) NOT NULL,
  timezone text NOT NULL,
  status record_status NOT NULL DEFAULT 'ACTIVE',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
CREATE INDEX legal_entities_org_idx ON legal_entities(organization_id);

CREATE TABLE branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  code text NOT NULL,
  name text NOT NULL,
  country_code char(2),
  address jsonb,
  status record_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, code)
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text,
  mfa_required boolean NOT NULL DEFAULT false,
  status record_status NOT NULL DEFAULT 'ACTIVE',
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role_id uuid NOT NULL REFERENCES roles(id),
  organization_id uuid REFERENCES organizations(id),
  legal_entity_id uuid REFERENCES legal_entities(id),
  branch_id uuid REFERENCES branches(id),
  status record_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, role_id, organization_id, legal_entity_id, branch_id)
);
CREATE INDEX memberships_user_idx ON memberships(user_id);

CREATE TABLE fiscal_years (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  name text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  CHECK (end_date >= start_date),
  UNIQUE (legal_entity_id, start_date, end_date)
);

CREATE TABLE accounting_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  fiscal_year_id uuid NOT NULL REFERENCES fiscal_years(id),
  period_no integer NOT NULL,
  name text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  status period_status NOT NULL DEFAULT 'OPEN',
  closed_at timestamptz,
  closed_by uuid REFERENCES users(id),
  version bigint NOT NULL DEFAULT 1,
  CHECK (end_date >= start_date),
  UNIQUE (legal_entity_id, fiscal_year_id, period_no)
);
CREATE INDEX accounting_periods_lookup_idx ON accounting_periods(legal_entity_id, start_date, end_date);

CREATE TABLE accounting_books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  code text NOT NULL,
  name text NOT NULL,
  base_currency char(3) NOT NULL,
  book_type text NOT NULL DEFAULT 'PRIMARY',
  is_primary boolean NOT NULL DEFAULT false,
  status record_status NOT NULL DEFAULT 'ACTIVE',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, code)
);

CREATE TABLE number_sequences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  scope text NOT NULL,
  prefix text,
  suffix text,
  next_number bigint NOT NULL DEFAULT 1,
  padding integer NOT NULL DEFAULT 0,
  reset_rule text,
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (legal_entity_id, scope)
);

CREATE TABLE account_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  parent_id uuid REFERENCES account_groups(id),
  code text,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0
);

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  accounting_book_id uuid NOT NULL REFERENCES accounting_books(id),
  group_id uuid REFERENCES account_groups(id),
  parent_id uuid REFERENCES accounts(id),
  code text NOT NULL,
  name text NOT NULL,
  account_type account_type NOT NULL,
  subtype text,
  normal_balance normal_balance NOT NULL,
  is_posting boolean NOT NULL DEFAULT true,
  is_control boolean NOT NULL DEFAULT false,
  is_system boolean NOT NULL DEFAULT false,
  cash_flow_classification text,
  valid_from date,
  valid_to date,
  status record_status NOT NULL DEFAULT 'ACTIVE',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (accounting_book_id, code)
);
CREATE INDEX accounts_entity_type_idx ON accounts(legal_entity_id, account_type);

CREATE TABLE dimensions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  code text NOT NULL,
  name text NOT NULL,
  hierarchy_enabled boolean NOT NULL DEFAULT false,
  status record_status NOT NULL DEFAULT 'ACTIVE',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (legal_entity_id, code)
);

CREATE TABLE dimension_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  dimension_id uuid NOT NULL REFERENCES dimensions(id),
  parent_id uuid REFERENCES dimension_values(id),
  code text NOT NULL,
  name text NOT NULL,
  valid_from date,
  valid_to date,
  status record_status NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (dimension_id, code)
);

CREATE TABLE journals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  accounting_book_id uuid NOT NULL REFERENCES accounting_books(id),
  code text NOT NULL,
  name text NOT NULL,
  journal_type text NOT NULL,
  status record_status NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (accounting_book_id, code)
);

CREATE TABLE posting_rule_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  accounting_book_id uuid NOT NULL REFERENCES accounting_books(id),
  event_type text NOT NULL,
  version integer NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  rule_definition jsonb NOT NULL,
  status record_status NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (accounting_book_id, event_type, version)
);

CREATE TABLE journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  accounting_book_id uuid NOT NULL REFERENCES accounting_books(id),
  journal_id uuid NOT NULL REFERENCES journals(id),
  accounting_period_id uuid NOT NULL REFERENCES accounting_periods(id),
  entry_number text,
  posting_date date NOT NULL,
  document_date date,
  description text,
  source_type text NOT NULL,
  source_id uuid,
  source_event_id uuid,
  posting_rule_version_id uuid REFERENCES posting_rule_versions(id),
  reversal_of_id uuid REFERENCES journal_entries(id),
  currency char(3) NOT NULL,
  status journal_status NOT NULL DEFAULT 'DRAFT',
  approval_status approval_status NOT NULL DEFAULT 'NOT_REQUIRED',
  submitted_at timestamptz,
  approved_at timestamptz,
  approved_by uuid REFERENCES users(id),
  posted_at timestamptz,
  posted_by uuid REFERENCES users(id),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX journal_entries_source_event_uq
  ON journal_entries(legal_entity_id, accounting_book_id, source_event_id)
  WHERE source_event_id IS NOT NULL;
CREATE UNIQUE INDEX journal_entries_number_uq
  ON journal_entries(accounting_book_id, entry_number)
  WHERE entry_number IS NOT NULL;
CREATE INDEX journal_entries_period_idx ON journal_entries(accounting_book_id, accounting_period_id, status);
CREATE INDEX journal_entries_source_idx ON journal_entries(source_type, source_id);

CREATE TABLE journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  journal_entry_id uuid NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  line_no integer NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id),
  description text,
  transaction_currency char(3) NOT NULL,
  transaction_debit numeric(24,8) NOT NULL DEFAULT 0,
  transaction_credit numeric(24,8) NOT NULL DEFAULT 0,
  base_currency char(3) NOT NULL,
  base_debit numeric(24,8) NOT NULL DEFAULT 0,
  base_credit numeric(24,8) NOT NULL DEFAULT 0,
  exchange_rate numeric(28,12),
  exchange_rate_date date,
  exchange_rate_source text,
  contact_id uuid,
  tax_transaction_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (transaction_debit >= 0 AND transaction_credit >= 0),
  CHECK (base_debit >= 0 AND base_credit >= 0),
  CHECK (NOT (transaction_debit > 0 AND transaction_credit > 0)),
  CHECK (NOT (base_debit > 0 AND base_credit > 0)),
  CHECK (base_debit > 0 OR base_credit > 0),
  UNIQUE (journal_entry_id, line_no)
);
CREATE INDEX journal_lines_account_idx ON journal_lines(account_id, journal_entry_id);

CREATE TABLE journal_line_dimensions (
  journal_line_id uuid NOT NULL REFERENCES journal_lines(id) ON DELETE RESTRICT,
  dimension_id uuid NOT NULL REFERENCES dimensions(id),
  dimension_value_id uuid NOT NULL REFERENCES dimension_values(id),
  PRIMARY KEY (journal_line_id, dimension_id)
);

CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  contact_type contact_type NOT NULL,
  code text,
  legal_name text NOT NULL,
  display_name text,
  email citext,
  phone text,
  tax_identifier text,
  default_currency char(3),
  payment_terms_days integer,
  credit_limit numeric(24,8),
  status record_status NOT NULL DEFAULT 'ACTIVE',
  billing_address jsonb,
  shipping_address jsonb,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contacts_org_type_idx ON contacts(organization_id, contact_type, status);

CREATE TABLE tax_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  code text NOT NULL,
  name text NOT NULL,
  tax_type text NOT NULL,
  tax_treatment text,
  payable_account_id uuid REFERENCES accounts(id),
  receivable_account_id uuid REFERENCES accounts(id),
  valid_from date,
  valid_to date,
  status record_status NOT NULL DEFAULT 'ACTIVE',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (legal_entity_id, code)
);

CREATE TABLE tax_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  tax_code_id uuid NOT NULL REFERENCES tax_codes(id),
  component_name text NOT NULL,
  rate numeric(18,10) NOT NULL,
  sequence integer NOT NULL DEFAULT 1,
  compound_on_previous boolean NOT NULL DEFAULT false,
  recoverable_percent numeric(9,6) NOT NULL DEFAULT 1,
  valid_from date NOT NULL,
  valid_to date,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE tax_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  tax_code_id uuid NOT NULL REFERENCES tax_codes(id),
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  source_line_id uuid,
  transaction_date date NOT NULL,
  currency char(3) NOT NULL,
  taxable_amount numeric(24,8) NOT NULL,
  tax_amount numeric(24,8) NOT NULL,
  recoverable_amount numeric(24,8) NOT NULL DEFAULT 0,
  nonrecoverable_amount numeric(24,8) NOT NULL DEFAULT 0,
  rule_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tax_transactions_period_idx ON tax_transactions(legal_entity_id, transaction_date);

CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  customer_id uuid NOT NULL REFERENCES contacts(id),
  invoice_number text,
  issue_date date NOT NULL,
  due_date date,
  currency char(3) NOT NULL,
  exchange_rate numeric(28,12),
  status document_status NOT NULL DEFAULT 'DRAFT',
  approval_status approval_status NOT NULL DEFAULT 'NOT_REQUIRED',
  subtotal numeric(24,8) NOT NULL DEFAULT 0,
  tax_total numeric(24,8) NOT NULL DEFAULT 0,
  total numeric(24,8) NOT NULL DEFAULT 0,
  amount_paid numeric(24,8) NOT NULL DEFAULT 0,
  amount_due numeric(24,8) NOT NULL DEFAULT 0,
  accounting_entry_id uuid REFERENCES journal_entries(id),
  terms text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX invoices_number_uq ON invoices(legal_entity_id, invoice_number) WHERE invoice_number IS NOT NULL;
CREATE INDEX invoices_customer_status_idx ON invoices(customer_id, status, due_date);

CREATE TABLE invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  line_no integer NOT NULL,
  item_id uuid,
  description text NOT NULL,
  quantity numeric(24,8) NOT NULL DEFAULT 1,
  unit_price numeric(24,8) NOT NULL DEFAULT 0,
  discount_amount numeric(24,8) NOT NULL DEFAULT 0,
  revenue_account_id uuid NOT NULL REFERENCES accounts(id),
  tax_code_id uuid REFERENCES tax_codes(id),
  net_amount numeric(24,8) NOT NULL,
  tax_amount numeric(24,8) NOT NULL DEFAULT 0,
  gross_amount numeric(24,8) NOT NULL,
  dimensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (invoice_id, line_no)
);

CREATE TABLE vendor_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  vendor_id uuid NOT NULL REFERENCES contacts(id),
  vendor_invoice_number text NOT NULL,
  internal_number text,
  bill_date date NOT NULL,
  due_date date,
  currency char(3) NOT NULL,
  exchange_rate numeric(28,12),
  status document_status NOT NULL DEFAULT 'DRAFT',
  approval_status approval_status NOT NULL DEFAULT 'NOT_REQUIRED',
  subtotal numeric(24,8) NOT NULL DEFAULT 0,
  tax_total numeric(24,8) NOT NULL DEFAULT 0,
  total numeric(24,8) NOT NULL DEFAULT 0,
  amount_paid numeric(24,8) NOT NULL DEFAULT 0,
  amount_due numeric(24,8) NOT NULL DEFAULT 0,
  accounting_entry_id uuid REFERENCES journal_entries(id),
  source_document_hash text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, vendor_id, vendor_invoice_number)
);

CREATE TABLE vendor_bill_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_bill_id uuid NOT NULL REFERENCES vendor_bills(id) ON DELETE CASCADE,
  line_no integer NOT NULL,
  description text NOT NULL,
  quantity numeric(24,8) NOT NULL DEFAULT 1,
  unit_price numeric(24,8) NOT NULL DEFAULT 0,
  destination_account_id uuid NOT NULL REFERENCES accounts(id),
  tax_code_id uuid REFERENCES tax_codes(id),
  net_amount numeric(24,8) NOT NULL,
  tax_amount numeric(24,8) NOT NULL DEFAULT 0,
  gross_amount numeric(24,8) NOT NULL,
  dimensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (vendor_bill_id, line_no)
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  payment_type text NOT NULL,
  contact_id uuid REFERENCES contacts(id),
  payment_number text,
  payment_date date NOT NULL,
  currency char(3) NOT NULL,
  amount numeric(24,8) NOT NULL CHECK (amount > 0),
  bank_account_id uuid,
  status document_status NOT NULL DEFAULT 'DRAFT',
  accounting_entry_id uuid REFERENCES journal_entries(id),
  external_reference text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  amount numeric(24,8) NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, target_type, target_id)
);

CREATE TABLE bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  name text NOT NULL,
  bank_name text,
  masked_account_identifier text,
  currency char(3) NOT NULL,
  connector_type text,
  connector_account_id text,
  status record_status NOT NULL DEFAULT 'ACTIVE',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE payments ADD CONSTRAINT payments_bank_account_fk FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id);

CREATE TABLE bank_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  bank_account_id uuid NOT NULL REFERENCES bank_accounts(id),
  provider_transaction_id text,
  import_batch_id uuid,
  transaction_date date NOT NULL,
  value_date date,
  currency char(3) NOT NULL,
  amount numeric(24,8) NOT NULL,
  description text,
  counterparty_name text,
  reference text,
  raw_payload jsonb,
  fingerprint text NOT NULL,
  reconciliation_status text NOT NULL DEFAULT 'UNMATCHED',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bank_account_id, fingerprint)
);
CREATE INDEX bank_transactions_match_idx ON bank_transactions(bank_account_id, reconciliation_status, transaction_date, amount);

CREATE TABLE bank_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_transaction_id uuid NOT NULL REFERENCES bank_transactions(id) ON DELETE RESTRICT,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  matched_amount numeric(24,8) NOT NULL,
  confidence numeric(8,6),
  match_method text NOT NULL,
  status text NOT NULL DEFAULT 'SUGGESTED',
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE bank_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  bank_account_id uuid NOT NULL REFERENCES bank_accounts(id),
  statement_start_date date NOT NULL,
  statement_end_date date NOT NULL,
  statement_opening_balance numeric(24,8) NOT NULL,
  statement_closing_balance numeric(24,8) NOT NULL,
  book_closing_balance numeric(24,8),
  difference numeric(24,8),
  status text NOT NULL DEFAULT 'IN_PROGRESS',
  completed_at timestamptz,
  completed_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE approval_workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid REFERENCES legal_entities(id),
  resource_type text NOT NULL,
  name text NOT NULL,
  version integer NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  definition jsonb NOT NULL,
  status record_status NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (tenant_id, resource_type, name, version)
);

CREATE TABLE approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid REFERENCES legal_entities(id),
  workflow_id uuid NOT NULL REFERENCES approval_workflows(id),
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  status approval_status NOT NULL DEFAULT 'PENDING',
  requested_by uuid REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  snapshot jsonb NOT NULL
);

CREATE TABLE approval_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_request_id uuid NOT NULL REFERENCES approval_requests(id) ON DELETE RESTRICT,
  step_no integer NOT NULL,
  approver_user_id uuid REFERENCES users(id),
  approver_role_id uuid REFERENCES roles(id),
  status approval_status NOT NULL DEFAULT 'PENDING',
  decision_reason text,
  decided_at timestamptz,
  UNIQUE (approval_request_id, step_no, approver_user_id, approver_role_id)
);

CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  storage_key text NOT NULL UNIQUE,
  original_filename text NOT NULL,
  media_type text,
  byte_size bigint,
  sha256 text,
  scan_status text NOT NULL DEFAULT 'PENDING',
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE file_links (
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  link_type text,
  PRIMARY KEY (file_id, resource_type, resource_id)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  organization_id uuid REFERENCES organizations(id),
  legal_entity_id uuid REFERENCES legal_entities(id),
  actor_type text NOT NULL,
  actor_id text,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  correlation_id text,
  ip_address inet,
  user_agent text,
  before_data jsonb,
  after_data jsonb,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_events_resource_idx ON audit_events(tenant_id, resource_type, resource_id, occurred_at DESC);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  event_type text NOT NULL,
  event_version integer NOT NULL DEFAULT 1,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  correlation_id text,
  causation_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);
CREATE INDEX outbox_unpublished_idx ON outbox_events(occurred_at) WHERE published_at IS NULL;

CREATE TABLE idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  idempotency_key text NOT NULL,
  operation text NOT NULL,
  request_hash text NOT NULL,
  response_code integer,
  response_body jsonb,
  resource_type text,
  resource_id uuid,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  UNIQUE (tenant_id, operation, idempotency_key)
);

-- Recommended production additions:
-- 1. Add full inventory, purchase order, asset, project, budget, consolidation, localization,
--    integration, migration, close-management and AI tables as their modules are implemented.
-- 2. Add tenant/legal-entity consistency checks using composite FKs or trusted domain constraints.
-- 3. Add RLS as defense-in-depth if selected by architecture/security review.
-- 4. Revoke UPDATE/DELETE on posted journal facts from application runtime roles and/or add
--    immutable triggers that reject changes once journal_entries.status = 'POSTED'.
-- 5. Enforce journal balance in the posting transaction/service. PostgreSQL CHECK cannot safely
--    express an aggregate across child rows; use a controlled posting function/service plus tests.
-- 6. Partition very large journal_lines/audit_events/bank_transactions by tenant/date only after
--    measuring workload; do not prematurely partition.
-- 7. Treat all *_balance read models/materialized views as rebuildable projections, never source of truth.

-- ===== Inventory =====
CREATE TABLE items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  sku text NOT NULL,
  name text NOT NULL,
  item_type text NOT NULL,
  base_uom text NOT NULL,
  inventory_account_id uuid REFERENCES accounts(id),
  cogs_account_id uuid REFERENCES accounts(id),
  revenue_account_id uuid REFERENCES accounts(id),
  purchase_account_id uuid REFERENCES accounts(id),
  default_sales_tax_code_id uuid REFERENCES tax_codes(id),
  default_purchase_tax_code_id uuid REFERENCES tax_codes(id),
  lot_tracking boolean NOT NULL DEFAULT false,
  serial_tracking boolean NOT NULL DEFAULT false,
  expiry_tracking boolean NOT NULL DEFAULT false,
  status record_status NOT NULL DEFAULT 'ACTIVE',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (organization_id, sku)
);

CREATE TABLE warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  code text NOT NULL,
  name text NOT NULL,
  branch_id uuid REFERENCES branches(id),
  status record_status NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (legal_entity_id, code)
);

CREATE TABLE warehouse_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id uuid NOT NULL REFERENCES warehouses(id),
  parent_id uuid REFERENCES warehouse_locations(id),
  code text NOT NULL,
  name text NOT NULL,
  location_type text NOT NULL DEFAULT 'STORAGE',
  status record_status NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (warehouse_id, code)
);

CREATE TABLE inventory_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  document_type text NOT NULL,
  document_number text,
  document_date date NOT NULL,
  status document_status NOT NULL DEFAULT 'DRAFT',
  source_type text,
  source_id uuid,
  accounting_entry_id uuid REFERENCES journal_entries(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  inventory_document_id uuid NOT NULL REFERENCES inventory_documents(id) ON DELETE RESTRICT,
  item_id uuid NOT NULL REFERENCES items(id),
  from_location_id uuid REFERENCES warehouse_locations(id),
  to_location_id uuid REFERENCES warehouse_locations(id),
  movement_date date NOT NULL,
  quantity numeric(24,8) NOT NULL,
  uom text NOT NULL,
  lot_number text,
  serial_number text,
  expiry_date date,
  unit_cost numeric(24,8),
  total_cost numeric(24,8),
  currency char(3),
  cost_method text,
  source_type text,
  source_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_movements_item_date_idx ON inventory_movements(item_id, movement_date);

CREATE TABLE inventory_cost_layers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  item_id uuid NOT NULL REFERENCES items(id),
  warehouse_id uuid REFERENCES warehouses(id),
  source_movement_id uuid NOT NULL REFERENCES inventory_movements(id),
  received_date date NOT NULL,
  original_quantity numeric(24,8) NOT NULL,
  remaining_quantity numeric(24,8) NOT NULL,
  unit_cost numeric(24,8) NOT NULL,
  currency char(3) NOT NULL,
  status text NOT NULL DEFAULT 'OPEN'
);

-- ===== Fixed Assets =====
CREATE TABLE asset_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  code text NOT NULL,
  name text NOT NULL,
  asset_account_id uuid NOT NULL REFERENCES accounts(id),
  accumulated_depreciation_account_id uuid NOT NULL REFERENCES accounts(id),
  depreciation_expense_account_id uuid NOT NULL REFERENCES accounts(id),
  gain_account_id uuid REFERENCES accounts(id),
  loss_account_id uuid REFERENCES accounts(id),
  default_method text,
  default_useful_life_months integer,
  status record_status NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (legal_entity_id, code)
);

CREATE TABLE fixed_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  asset_category_id uuid NOT NULL REFERENCES asset_categories(id),
  asset_number text NOT NULL,
  name text NOT NULL,
  acquisition_date date,
  in_service_date date,
  currency char(3) NOT NULL,
  acquisition_cost numeric(24,8) NOT NULL DEFAULT 0,
  residual_value numeric(24,8) NOT NULL DEFAULT 0,
  useful_life_months integer,
  status text NOT NULL DEFAULT 'DRAFT',
  source_type text,
  source_id uuid,
  branch_id uuid REFERENCES branches(id),
  dimensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (legal_entity_id, asset_number)
);

CREATE TABLE asset_books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixed_asset_id uuid NOT NULL REFERENCES fixed_assets(id),
  accounting_book_id uuid NOT NULL REFERENCES accounting_books(id),
  depreciation_method text NOT NULL,
  useful_life_months integer NOT NULL,
  residual_value numeric(24,8) NOT NULL DEFAULT 0,
  depreciation_start_date date NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (fixed_asset_id, accounting_book_id)
);

CREATE TABLE depreciation_schedule_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_book_id uuid NOT NULL REFERENCES asset_books(id),
  accounting_period_id uuid NOT NULL REFERENCES accounting_periods(id),
  scheduled_amount numeric(24,8) NOT NULL,
  posted_amount numeric(24,8) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'SCHEDULED',
  journal_entry_id uuid REFERENCES journal_entries(id),
  UNIQUE (asset_book_id, accounting_period_id)
);

-- ===== Projects and Budgets =====
CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  legal_entity_id uuid REFERENCES legal_entities(id),
  code text NOT NULL,
  name text NOT NULL,
  customer_id uuid REFERENCES contacts(id),
  start_date date,
  end_date date,
  billing_method text,
  status text NOT NULL DEFAULT 'ACTIVE',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (organization_id, code)
);

CREATE TABLE budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  accounting_book_id uuid NOT NULL REFERENCES accounting_books(id),
  name text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  fiscal_year_id uuid NOT NULL REFERENCES fiscal_years(id),
  status text NOT NULL DEFAULT 'DRAFT',
  approved_at timestamptz,
  approved_by uuid REFERENCES users(id),
  UNIQUE (legal_entity_id, accounting_book_id, name, version)
);

CREATE TABLE budget_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id uuid NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  accounting_period_id uuid NOT NULL REFERENCES accounting_periods(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  amount numeric(24,8) NOT NULL,
  currency char(3) NOT NULL,
  dimensions jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX budget_lines_lookup_idx ON budget_lines(budget_id, accounting_period_id, account_id);

-- ===== Foreign Exchange =====
CREATE TABLE exchange_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id),
  rate_date date NOT NULL,
  from_currency char(3) NOT NULL,
  to_currency char(3) NOT NULL,
  rate_type text NOT NULL DEFAULT 'SPOT',
  rate numeric(28,12) NOT NULL CHECK (rate > 0),
  source text NOT NULL,
  provider_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, rate_date, from_currency, to_currency, rate_type, source)
);

CREATE TABLE fx_remeasurement_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  accounting_book_id uuid NOT NULL REFERENCES accounting_books(id),
  accounting_period_id uuid NOT NULL REFERENCES accounting_periods(id),
  rate_date date NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT',
  journal_entry_id uuid REFERENCES journal_entries(id),
  reversal_journal_entry_id uuid REFERENCES journal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, accounting_book_id, accounting_period_id)
);

-- ===== Intercompany and Consolidation =====
CREATE TABLE consolidation_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  code text NOT NULL,
  name text NOT NULL,
  reporting_currency char(3) NOT NULL,
  status record_status NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (organization_id, code)
);

CREATE TABLE consolidation_group_entities (
  consolidation_group_id uuid NOT NULL REFERENCES consolidation_groups(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  ownership_percent numeric(9,6) NOT NULL DEFAULT 1,
  consolidation_method text NOT NULL DEFAULT 'FULL',
  valid_from date NOT NULL,
  valid_to date,
  PRIMARY KEY (consolidation_group_id, legal_entity_id, valid_from)
);

CREATE TABLE consolidation_account_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consolidation_group_id uuid NOT NULL REFERENCES consolidation_groups(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  source_account_id uuid NOT NULL REFERENCES accounts(id),
  group_account_code text NOT NULL,
  valid_from date NOT NULL,
  valid_to date
);

CREATE TABLE intercompany_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  counterparty_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  transaction_type text NOT NULL,
  source_document_type text,
  source_document_id uuid,
  currency char(3) NOT NULL,
  amount numeric(24,8) NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  paired_transaction_id uuid REFERENCES intercompany_transactions(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consolidation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  consolidation_group_id uuid NOT NULL REFERENCES consolidation_groups(id),
  accounting_period_id uuid NOT NULL REFERENCES accounting_periods(id),
  reporting_currency char(3) NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT',
  version integer NOT NULL DEFAULT 1,
  input_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (consolidation_group_id, accounting_period_id, version)
);

CREATE TABLE consolidation_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consolidation_run_id uuid NOT NULL REFERENCES consolidation_runs(id) ON DELETE RESTRICT,
  adjustment_type text NOT NULL,
  reference text,
  description text,
  lines jsonb NOT NULL,
  source_links jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===== Close Management =====
CREATE TABLE close_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  accounting_book_id uuid NOT NULL REFERENCES accounting_books(id),
  accounting_period_id uuid NOT NULL REFERENCES accounting_periods(id),
  status text NOT NULL DEFAULT 'OPEN',
  readiness_percent numeric(7,4) NOT NULL DEFAULT 0,
  started_by uuid REFERENCES users(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (legal_entity_id, accounting_book_id, accounting_period_id)
);

CREATE TABLE close_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  close_run_id uuid NOT NULL REFERENCES close_runs(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  task_type text NOT NULL,
  owner_user_id uuid REFERENCES users(id),
  required boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'OPEN',
  due_at timestamptz,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  completed_at timestamptz,
  UNIQUE (close_run_id, code)
);

CREATE TABLE financial_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid REFERENCES legal_entities(id),
  consolidation_group_id uuid REFERENCES consolidation_groups(id),
  accounting_book_id uuid REFERENCES accounting_books(id),
  accounting_period_id uuid NOT NULL REFERENCES accounting_periods(id),
  snapshot_type text NOT NULL,
  version integer NOT NULL,
  payload jsonb NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ===== Integration / Webhooks =====
CREATE TABLE integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid REFERENCES legal_entities(id),
  provider text NOT NULL,
  integration_type text NOT NULL,
  status text NOT NULL DEFAULT 'DISCONNECTED',
  external_account_id text,
  encrypted_config_reference text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  connected_at timestamptz,
  last_sync_at timestamptz,
  UNIQUE (tenant_id, legal_entity_id, provider, integration_type, external_account_id)
);

CREATE TABLE sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  integration_id uuid NOT NULL REFERENCES integrations(id),
  sync_type text NOT NULL,
  cursor_state jsonb,
  status text NOT NULL DEFAULT 'QUEUED',
  started_at timestamptz,
  completed_at timestamptz,
  error text,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  url text NOT NULL,
  secret_reference text NOT NULL,
  subscribed_events text[] NOT NULL,
  status record_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id),
  outbox_event_id uuid NOT NULL REFERENCES outbox_events(id),
  attempt integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'QUEUED',
  response_code integer,
  response_body text,
  next_attempt_at timestamptz,
  delivered_at timestamptz,
  UNIQUE (webhook_endpoint_id, outbox_event_id)
);

-- ===== Migration =====
CREATE TABLE migration_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  source_system text NOT NULL,
  mode text NOT NULL,
  cutover_date date,
  status text NOT NULL DEFAULT 'DRAFT',
  mapping_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_control_totals jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_control_totals jsonb NOT NULL DEFAULT '{}'::jsonb,
  exceptions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- ===== AI / Automation =====
CREATE TABLE ai_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid REFERENCES legal_entities(id),
  decision_type text NOT NULL,
  resource_type text,
  resource_id uuid,
  provider text NOT NULL,
  model text NOT NULL,
  model_version text,
  prompt_policy_version text,
  input_references jsonb NOT NULL DEFAULT '[]'::jsonb,
  output jsonb NOT NULL,
  confidence numeric(8,6),
  status text NOT NULL DEFAULT 'PROPOSED',
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE anomalies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid REFERENCES legal_entities(id),
  anomaly_type text NOT NULL,
  severity text NOT NULL,
  resource_type text,
  resource_id uuid,
  evidence jsonb NOT NULL,
  detector text NOT NULL,
  detector_version text,
  status text NOT NULL DEFAULT 'OPEN',
  owner_user_id uuid REFERENCES users(id),
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE automation_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid REFERENCES legal_entities(id),
  code text NOT NULL,
  name text NOT NULL,
  trigger_type text NOT NULL,
  conditions jsonb NOT NULL,
  actions jsonb NOT NULL,
  version integer NOT NULL,
  status record_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code, version)
);

-- Deferred foreign keys defined after referenced tables.
ALTER TABLE journal_lines
  ADD CONSTRAINT journal_lines_contact_fk FOREIGN KEY (contact_id) REFERENCES contacts(id);
ALTER TABLE journal_lines
  ADD CONSTRAINT journal_lines_tax_transaction_fk FOREIGN KEY (tax_transaction_id) REFERENCES tax_transactions(id);

-- Critical implementation note:
-- Do not expose tables above as an anemic CRUD surface. Aggregate/domain services own state transitions.
-- Posted journal immutability and balanced posting are implemented as defense-in-depth through
-- service transactions plus database permissions/triggers/functions tested by the release gates.
