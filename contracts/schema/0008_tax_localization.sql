-- =============================================================================
-- 0008 — Tax engine and localization framework
-- =============================================================================
-- Phase 3. This is the largest coverage gap the audit found: F-202 noted the
-- blueprint had tax_codes / tax_rates / tax_transactions — enough to STORE a rate
-- and RECORD a calculation, but nothing to DETERMINE one (TaxRule, FiscalPosition)
-- and nothing to VERSION a package (LocalizationPackage, LocalizationVersion).
-- doc 07's non-negotiable "historical posted transaction retains the same tax
-- snapshot after rule upgrade" depended entirely on tables that did not exist.
--
-- Also resolves F-024 (tax_transactions not book-aware), F-025 (no overlap
-- constraint on rates), F-107 (tax returns had no entry point).
-- =============================================================================

-- --------------------------------------------------------- localization ------
CREATE TABLE localization_packages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,          -- e.g. 'BD', 'GB', 'US-CA'
  country_code  char(2) NOT NULL,
  name          text NOT NULL,
  status        record_status NOT NULL DEFAULT 'ACTIVE'
);

CREATE TABLE localization_versions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  localization_package_id uuid NOT NULL REFERENCES localization_packages(id),
  version                 text NOT NULL,
  effective_from          date NOT NULL,
  effective_to            date,
  -- doc 98 review rule: regulatory tickets must attach the official source used,
  -- publication/effective date and reviewer.
  source_reference        text,
  published_at            date,
  reviewed_by             text,
  release_notes           text,
  status                  record_status NOT NULL DEFAULT 'ACTIVE',
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (localization_package_id, version)
);
ALTER TABLE localization_installations
  ADD CONSTRAINT loc_install_version_fk FOREIGN KEY (localization_version_id) REFERENCES localization_versions(id);

CREATE TABLE tax_registrations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id  uuid NOT NULL REFERENCES legal_entities(id),
  jurisdiction     text NOT NULL,
  registration_no  text NOT NULL,
  registration_type text,
  valid_from       date NOT NULL,
  valid_to         date,
  status           record_status NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (legal_entity_id, jurisdiction, registration_no),
  CONSTRAINT tax_reg_entity_scope_fk FOREIGN KEY (legal_entity_id, tenant_id) REFERENCES legal_entities(id, tenant_id)
);

-- doc 07: fiscal position selects the tax treatment for a counterparty/context.
CREATE TABLE fiscal_positions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id  uuid NOT NULL,
  localization_version_id uuid REFERENCES localization_versions(id),
  code             text NOT NULL,
  name             text NOT NULL,
  auto_apply_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  status           record_status NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (legal_entity_id, code),
  CONSTRAINT fp_entity_scope_fk FOREIGN KEY (legal_entity_id, tenant_id) REFERENCES legal_entities(id, tenant_id),
  CONSTRAINT fp_scope_uq UNIQUE (id, legal_entity_id)
);

-- ------------------------------------------------------------------ codes -----
CREATE TABLE tax_codes (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id        uuid NOT NULL,
  localization_version_id uuid REFERENCES localization_versions(id),
  code                   text NOT NULL,
  name                   text NOT NULL,
  kind                   tax_type NOT NULL,
  treatment              tax_treatment NOT NULL DEFAULT 'STANDARD',
  is_inclusive_default   boolean NOT NULL DEFAULT false,
  payable_account_id     uuid,
  receivable_account_id  uuid,
  nonrecoverable_account_id uuid,
  valid_from             date,
  valid_to               date,
  status                 record_status NOT NULL DEFAULT 'ACTIVE',
  settings               jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (legal_entity_id, code),
  CONSTRAINT tax_codes_entity_scope_fk FOREIGN KEY (legal_entity_id, tenant_id) REFERENCES legal_entities(id, tenant_id),
  -- F-033 pattern: the account must belong to the same entity as the tax code.
  CONSTRAINT tax_codes_payable_fk     FOREIGN KEY (payable_account_id, legal_entity_id)        REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT tax_codes_receivable_fk  FOREIGN KEY (receivable_account_id, legal_entity_id)     REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT tax_codes_nonrec_fk      FOREIGN KEY (nonrecoverable_account_id, legal_entity_id) REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT tax_codes_scope_uq UNIQUE (id, legal_entity_id)
);

CREATE TABLE tax_components (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_code_id   uuid NOT NULL REFERENCES tax_codes(id) ON DELETE RESTRICT,
  legal_entity_id uuid NOT NULL,
  code          text NOT NULL,
  name          text NOT NULL,
  sequence      integer NOT NULL DEFAULT 1,
  compound_on_previous boolean NOT NULL DEFAULT false,
  -- ADR-0006 §4: rounding mode may be overridden per component because some
  -- jurisdictions mandate half-even or truncation for tax specifically.
  rounding_mode rounding_mode,
  UNIQUE (tax_code_id, code),
  CONSTRAINT tax_components_code_scope_fk FOREIGN KEY (tax_code_id, legal_entity_id) REFERENCES tax_codes(id, legal_entity_id),
  CONSTRAINT tax_components_scope_uq UNIQUE (id, legal_entity_id)
);

-- F-025: the blueprint's tax_rates had NO constraint at all, so duplicate or
-- overlapping (code, component, period) rows were insertable and rate resolution
-- was non-deterministic — on the table that produces tax on customer invoices.
CREATE TABLE tax_rates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  tax_component_id    uuid NOT NULL REFERENCES tax_components(id) ON DELETE RESTRICT,
  rate                numeric(18,10) NOT NULL,
  recoverable_percent numeric(9,6) NOT NULL DEFAULT 1 CHECK (recoverable_percent BETWEEN 0 AND 1),
  valid_from          date NOT NULL,
  valid_to            date,
  localization_version_id uuid REFERENCES localization_versions(id),
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT tax_rates_dates CHECK (valid_to IS NULL OR valid_to > valid_from)
);
ALTER TABLE tax_rates ADD CONSTRAINT tax_rates_no_overlap
  EXCLUDE USING gist (
    tax_component_id WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  );

-- doc 07: determination rules. Absent from the blueprint entirely (F-202).
CREATE TABLE tax_rules (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id         uuid NOT NULL,
  localization_version_id uuid REFERENCES localization_versions(id),
  code                    text NOT NULL,
  version                 integer NOT NULL,
  priority                integer NOT NULL DEFAULT 100,
  -- Determination inputs from doc 07: transaction type, jurisdictions, supply
  -- location, product/service category, counterparty registration, dates,
  -- inclusive/exclusive, currency, fiscal position, exemption facts.
  conditions              jsonb NOT NULL,
  resulting_tax_code_id   uuid,
  valid_from              date NOT NULL,
  valid_to                date,
  status                  record_status NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (legal_entity_id, code, version),
  CONSTRAINT tax_rules_entity_scope_fk FOREIGN KEY (legal_entity_id, tenant_id) REFERENCES legal_entities(id, tenant_id),
  CONSTRAINT tax_rules_result_fk FOREIGN KEY (resulting_tax_code_id, legal_entity_id) REFERENCES tax_codes(id, legal_entity_id)
);
ALTER TABLE tax_rules ADD CONSTRAINT tax_rules_no_overlap
  EXCLUDE USING gist (
    legal_entity_id WITH =, code WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  );

-- ---------------------------------------------------------- tax subledger -----
-- F-024: the blueprint had no accounting_book_id and no forward link to the
-- journal, yet Gate D requires "tax detail = tax control accounts" per book and
-- doc 07 requires return-to-GL reconciliation.
CREATE TABLE tax_transactions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id      uuid NOT NULL,
  accounting_book_id   uuid NOT NULL,                       -- F-024
  journal_entry_id     uuid REFERENCES journal_entries(id),  -- F-024
  tax_code_id          uuid NOT NULL,
  tax_component_id     uuid REFERENCES tax_components(id),
  source_type          text NOT NULL,
  source_id            uuid NOT NULL,
  source_line_id       uuid,
  transaction_date     date NOT NULL,
  posting_date         date NOT NULL,
  direction            text NOT NULL CHECK (direction IN ('OUTPUT','INPUT','WITHHOLDING')),
  currency             char(3) NOT NULL REFERENCES currencies(code),
  taxable_amount       numeric(24,8) NOT NULL,
  tax_amount           numeric(24,8) NOT NULL,
  base_taxable_amount  numeric(24,8) NOT NULL,
  base_tax_amount      numeric(24,8) NOT NULL,
  recoverable_amount   numeric(24,8) NOT NULL DEFAULT 0,
  nonrecoverable_amount numeric(24,8) NOT NULL DEFAULT 0,
  -- Kept from the blueprint and made NOT NULL: this snapshot is what makes
  -- "historical posted transaction retains the same tax snapshot after rule
  -- upgrade" (doc 07 acceptance) achievable.
  rule_snapshot        jsonb NOT NULL,
  localization_version_id uuid REFERENCES localization_versions(id),
  tax_period_id        uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tax_txn_book_scope_fk FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id),
  CONSTRAINT tax_txn_code_scope_fk FOREIGN KEY (tax_code_id, legal_entity_id) REFERENCES tax_codes(id, legal_entity_id)
);
CREATE INDEX tax_transactions_period_idx ON tax_transactions(legal_entity_id, posting_date, direction);
CREATE INDEX tax_transactions_source_idx ON tax_transactions(source_type, source_id);
CREATE INDEX tax_transactions_journal_idx ON tax_transactions(journal_entry_id);

ALTER TABLE journal_lines ADD CONSTRAINT jl_tax_transaction_fk
  FOREIGN KEY (tax_transaction_id) REFERENCES tax_transactions(id);

-- --------------------------------------------------- tax periods / returns ----
CREATE TABLE tax_periods (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL,
  jurisdiction    text NOT NULL,
  name            text NOT NULL,
  start_date      date NOT NULL,
  end_date        date NOT NULL,
  status          tax_period_status NOT NULL DEFAULT 'OPEN',
  CHECK (end_date >= start_date),
  UNIQUE (legal_entity_id, jurisdiction, start_date, end_date),
  CONSTRAINT tax_periods_entity_scope_fk FOREIGN KEY (legal_entity_id, tenant_id) REFERENCES legal_entities(id, tenant_id),
  CONSTRAINT tax_periods_scope_uq UNIQUE (id, legal_entity_id)
);
ALTER TABLE tax_periods ADD CONSTRAINT tax_periods_no_overlap
  EXCLUDE USING gist (
    legal_entity_id WITH =, jurisdiction WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  );
ALTER TABLE tax_transactions
  ADD CONSTRAINT tax_txn_period_fk FOREIGN KEY (tax_period_id, legal_entity_id) REFERENCES tax_periods(id, legal_entity_id);

-- F-107 (S1): the blueprint exposed only GET /tax-returns plus three sub-commands,
-- so the lifecycle had no entry point. The table and the POST route now exist.
CREATE TABLE tax_returns (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id     uuid NOT NULL,
  tax_period_id       uuid NOT NULL,
  form_code           text NOT NULL,
  version             integer NOT NULL DEFAULT 1,
  -- doc 07 machine: OPEN -> PREPARING -> READY -> FILED -> AMENDED
  status              tax_period_status NOT NULL DEFAULT 'OPEN',
  prepared_by         uuid REFERENCES users(id),
  prepared_at         timestamptz,
  -- doc 14 SoD: preparer and approver must differ. Enforced in the workflow
  -- engine; the columns make the check possible and auditable.
  approved_by         uuid REFERENCES users(id),
  approved_at         timestamptz,
  filed_at            timestamptz,
  filing_reference    text,
  filing_evidence_file_id uuid REFERENCES files(id),
  -- doc 07: "Finalized/FILED return becomes an immutable snapshot".
  snapshot            jsonb,
  localization_version_id uuid REFERENCES localization_versions(id),
  amends_return_id    uuid REFERENCES tax_returns(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tax_period_id, form_code, version),
  CONSTRAINT tax_returns_period_scope_fk FOREIGN KEY (tax_period_id, legal_entity_id) REFERENCES tax_periods(id, legal_entity_id),
  CONSTRAINT tax_returns_filed_has_evidence
    CHECK (status <> 'FILED' OR (filing_reference IS NOT NULL AND snapshot IS NOT NULL)),
  CONSTRAINT tax_returns_sod CHECK (approved_by IS NULL OR approved_by <> prepared_by)
);
-- A FILED return is an immutable snapshot; doc 07 forbids silently rewriting it.
CREATE TRIGGER tax_returns_filed_immutable
  BEFORE DELETE ON tax_returns
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_of_posted();

CREATE TABLE tax_overrides (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id  uuid NOT NULL,
  source_type      text NOT NULL,
  source_id        uuid NOT NULL,
  source_line_id   uuid,
  original_tax_code_id uuid REFERENCES tax_codes(id),
  override_tax_code_id uuid REFERENCES tax_codes(id),
  reason           text NOT NULL,                 -- doc 02: override tax is high-risk
  overridden_by    uuid NOT NULL REFERENCES users(id),
  overridden_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE statutory_templates (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  localization_version_id uuid NOT NULL REFERENCES localization_versions(id),
  code                    text NOT NULL,
  name                    text NOT NULL,
  template_kind           text NOT NULL CHECK (template_kind IN ('INVOICE','CREDIT_NOTE','RETURN','REGISTER','REPORT')),
  definition              jsonb NOT NULL,
  UNIQUE (localization_version_id, code)
);

-- doc 07: provider-neutral e-invoice contract. Retry must never duplicate a
-- government submission (doc 07 acceptance), hence the unique idempotency key.
CREATE TABLE einvoice_submissions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id    uuid NOT NULL REFERENCES legal_entities(id),
  source_type        text NOT NULL,
  source_id          uuid NOT NULL,
  provider           text NOT NULL,
  idempotency_key    text NOT NULL,
  status             einvoice_status NOT NULL DEFAULT 'PENDING',
  request_payload    jsonb,
  response_payload   jsonb,
  government_id      text,
  qr_payload         text,
  rejection_reason   text,
  attempts           integer NOT NULL DEFAULT 0,
  submitted_at       timestamptz,
  responded_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, idempotency_key)
);
CREATE INDEX einvoice_source_idx ON einvoice_submissions(source_type, source_id);

ALTER TABLE contacts
  ADD CONSTRAINT contacts_sales_tax_fk    FOREIGN KEY (sales_tax_code_id)    REFERENCES tax_codes(id),
  ADD CONSTRAINT contacts_purchase_tax_fk FOREIGN KEY (purchase_tax_code_id) REFERENCES tax_codes(id);

COMMENT ON TABLE tax_rules IS
  'F-202: the determination substrate. The blueprint could store a rate and record a calculation '
  'but had no way to determine one.';
COMMENT ON TABLE localization_versions IS
  'F-202: without package versioning, doc 07''s "historical transactions retain their original rule '
  'version" was unachievable. Retrofitting this is not possible once tax history exists.';
