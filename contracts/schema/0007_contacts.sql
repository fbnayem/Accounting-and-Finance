-- =============================================================================
-- 0007 — Contacts (customers and vendors)
-- =============================================================================
-- Phase 3. Resolves F-026 (org-scoped contacts with no sharing policy).
-- doc 02: one contact may be customer, vendor or both.
-- =============================================================================

CREATE TABLE contacts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  organization_id     uuid NOT NULL REFERENCES organizations(id),
  -- F-026: doc 11 specifies "shared master-data policy options"; the blueprint
  -- hardcoded org-wide sharing. NULL = shared across the organization,
  -- populated = restricted to one entity. Expressible without a later migration.
  legal_entity_id     uuid,
  kind                contact_type NOT NULL,
  code                text,
  legal_name          text NOT NULL,
  display_name        text,
  email               citext,
  phone               text,
  tax_identifier      text,
  registration_number text,
  default_currency    char(3) REFERENCES currencies(code),
  payment_terms_days  integer CHECK (payment_terms_days IS NULL OR payment_terms_days >= 0),
  credit_limit        numeric(24,8) CHECK (credit_limit IS NULL OR credit_limit >= 0),
  -- doc 04: per-customer AR/revenue defaults; doc 05: per-vendor AP/expense defaults
  ar_account_id       uuid,
  ap_account_id       uuid,
  revenue_account_id  uuid,
  expense_account_id  uuid,
  sales_tax_code_id   uuid,                    -- FK in 0008
  purchase_tax_code_id uuid,                   -- FK in 0008
  collection_owner_id uuid REFERENCES users(id),
  billing_address     jsonb,
  shipping_address    jsonb,
  portal_enabled      boolean NOT NULL DEFAULT false,
  status              record_status NOT NULL DEFAULT 'ACTIVE',
  settings            jsonb NOT NULL DEFAULT '{}'::jsonb,
  version             bigint NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code),
  CONSTRAINT contacts_org_scope_fk FOREIGN KEY (organization_id, tenant_id) REFERENCES organizations(id, tenant_id),
  CONSTRAINT contacts_entity_scope_fk FOREIGN KEY (legal_entity_id, organization_id) REFERENCES legal_entities(id, organization_id),
  CONSTRAINT contacts_ar_fk FOREIGN KEY (ar_account_id) REFERENCES accounts(id),
  CONSTRAINT contacts_ap_fk FOREIGN KEY (ap_account_id) REFERENCES accounts(id),
  CONSTRAINT contacts_rev_fk FOREIGN KEY (revenue_account_id) REFERENCES accounts(id),
  CONSTRAINT contacts_exp_fk FOREIGN KEY (expense_account_id) REFERENCES accounts(id),
  CONSTRAINT contacts_scope_uq UNIQUE (id, organization_id),
  CONSTRAINT contacts_tenant_uq UNIQUE (id, tenant_id)
);
CREATE INDEX contacts_org_kind_idx ON contacts(organization_id, kind, status);
-- doc 02: duplicate detection uses tax ID, email, bank details and normalised name.
CREATE INDEX contacts_tax_id_idx ON contacts(organization_id, tax_identifier) WHERE tax_identifier IS NOT NULL;
CREATE INDEX contacts_email_idx  ON contacts(organization_id, email) WHERE email IS NOT NULL;

CREATE TABLE contact_persons (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id  uuid NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  name        text NOT NULL,
  email       citext,
  phone       text,
  role        text,
  is_primary  boolean NOT NULL DEFAULT false,
  status      record_status NOT NULL DEFAULT 'ACTIVE'
);
CREATE INDEX contact_persons_contact_idx ON contact_persons(contact_id);

-- doc 05: "Bank detail change is high risk: record before/after, actor, reason,
-- verification and optional independent approval." Versioned, never overwritten,
-- so the Vendor Bank Change Audit report (doc 05) is possible.
CREATE TABLE contact_bank_details (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  contact_id          uuid NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  version             integer NOT NULL,
  account_holder_name text,
  masked_account_no   text,
  -- doc 16: field-level encryption for high-risk secrets; only a reference is stored.
  encrypted_ref       text,
  bank_name           text,
  branch_code         text,
  iban                text,
  swift_bic           text,
  currency            char(3) REFERENCES currencies(code),
  country_code        char(2),
  valid_from          timestamptz NOT NULL DEFAULT now(),
  valid_to            timestamptz,
  verified_at         timestamptz,
  verified_by         uuid REFERENCES users(id),
  changed_by          uuid REFERENCES users(id),
  change_reason       text,
  approved_by         uuid REFERENCES users(id),
  approved_at         timestamptz,
  UNIQUE (contact_id, version)
);
CREATE UNIQUE INDEX contact_bank_details_current_idx
  ON contact_bank_details(contact_id) WHERE valid_to IS NULL;

-- doc 04: dunning / collections state per customer.
CREATE TABLE dunning_cases (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id   uuid NOT NULL REFERENCES legal_entities(id),
  contact_id        uuid NOT NULL REFERENCES contacts(id),
  stage             integer NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PAUSED','PROMISED','DISPUTED','ESCALATED','CLOSED')),
  promise_to_pay_at date,
  dispute_reason    text,
  owner_user_id     uuid REFERENCES users(id),
  last_action_at    timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dunning_cases_contact_idx ON dunning_cases(contact_id, status);

ALTER TABLE journal_lines ADD CONSTRAINT jl_contact_fk FOREIGN KEY (contact_id) REFERENCES contacts(id);
CREATE TRIGGER contacts_updated_at BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN contacts.legal_entity_id IS
  'F-026: NULL = shared across the organization (the blueprint''s only behaviour); populated = '
  'restricted to one entity. Makes doc 11''s shared master-data policy expressible.';
COMMENT ON TABLE contact_bank_details IS
  'doc 05 high-risk change. Versioned rows, never updated in place, so before/after is always '
  'recoverable for the Vendor Bank Change Audit report and doc 13 anomaly detection.';
