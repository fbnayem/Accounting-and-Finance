-- =============================================================================
-- 0021 — Bangladesh localization package
-- =============================================================================
-- Phase 10. NOT in scope for the first release (the generic/global decision),
-- but included so the ~186-table design is complete and, more importantly, so
-- the localization framework in 0008 is proven against a real country pack
-- rather than assumed to be sufficient.
--
-- doc 20's design constraint is the point of this file:
--   "Implement Bangladesh-specific statutory behavior THROUGH the generic
--    localization/tax framework. Do not embed Bangladesh rules inside the global
--    ledger/AR/AP modules."
-- Every table here hangs off localization_versions or tax_transactions. Nothing
-- in 0005 (ledger), 0009 (AR) or 0010 (AP) is modified.
--
-- F-205 recorded zero blueprint coverage for these objects; that was expected,
-- not a defect.
-- =============================================================================

-- doc 20: BIN / registration metadata per entity, versioned by NBR rule version.
CREATE TABLE bd_vat_profiles (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id         uuid NOT NULL REFERENCES legal_entities(id),
  localization_version_id uuid NOT NULL REFERENCES localization_versions(id),
  bin                     text NOT NULL,
  vat_circle              text,
  vat_division            text,
  commissionerate         text,
  business_type           text,
  turnover_threshold_band text,
  is_vds_agent            boolean NOT NULL DEFAULT false,
  valid_from              date NOT NULL,
  valid_to                date,
  UNIQUE (legal_entity_id, bin, valid_from),
  CONSTRAINT bd_vp_entity_scope_fk FOREIGN KEY (legal_entity_id, tenant_id) REFERENCES legal_entities(id, tenant_id)
);
ALTER TABLE bd_vat_profiles ADD CONSTRAINT bd_vat_profiles_no_overlap
  EXCLUDE USING gist (legal_entity_id WITH =, daterange(valid_from, valid_to, '[)') WITH &&);

-- doc 20: NBR act/rule/SRO/form versions, with the source link doc 98's review
-- rule requires ("attach the official source used, publication/effective date,
-- accountant/legal review where required").
CREATE TABLE bd_nbr_rule_versions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  localization_version_id uuid NOT NULL REFERENCES localization_versions(id),
  instrument_type         text NOT NULL CHECK (instrument_type IN ('ACT','RULE','SRO','FORM','CIRCULAR')),
  reference               text NOT NULL,
  title                   text,
  source_url              text NOT NULL,
  published_on            date,
  effective_from          date NOT NULL,
  effective_to            date,
  -- doc 20 acceptance: "Localization test fixtures are reviewed by qualified
  -- Bangladesh accounting/tax professionals before production use."
  reviewed_by             text,
  reviewed_at             date,
  UNIQUE (localization_version_id, instrument_type, reference)
);

-- doc 20: the VAT 2012 forms currently listed by NBR. Registered rather than
-- hardcoded, because doc 20 explicitly says "Do not promise every form in first
-- commercial release; implement and validate required forms by customer scope."
CREATE TABLE bd_mushak_forms (
  code                    text PRIMARY KEY,
  name                    text NOT NULL,
  form_kind               text NOT NULL CHECK (form_kind IN ('INVOICE','REGISTER','RETURN','TRANSFER','SUPPORT','OTHER')),
  is_implemented          boolean NOT NULL DEFAULT false,
  implemented_in_version  uuid REFERENCES localization_versions(id),
  notes                   text
);
INSERT INTO bd_mushak_forms (code, name, form_kind, is_implemented, notes) VALUES
  ('6.1',   'Purchase register',        'REGISTER', false, 'doc 20 priority target'),
  ('6.2',   'Sales register',           'REGISTER', false, 'doc 20 priority target'),
  ('6.2.1', 'Sales register (variant)', 'REGISTER', false, 'doc 20 priority target'),
  ('6.3',   'Tax invoice',              'INVOICE',  false, 'doc 20 priority target'),
  ('6.5',   'Transfer / other document','TRANSFER', false, 'doc 20 priority target'),
  ('6.10',  'Summary / support',        'SUPPORT',  false, 'doc 20 priority target'),
  ('9.1',   'Monthly VAT return',       'RETURN',   false, 'doc 20 priority target'),
  ('9.2',   'Return (variant)',         'RETURN',   false, 'Only after accounting/tax review'),
  ('4.3',   'Form 4.3',                 'OTHER',    false, 'Only after accounting/tax review'),
  ('2.1',   'Form 2.1',                 'OTHER',    false, 'Only after accounting/tax review'),
  ('2.3',   'Form 2.3',                 'OTHER',    false, 'Only after accounting/tax review');

-- doc 20: generated from POSTED source facts; the template version is stored so
-- a reprint reproduces the original document.
CREATE TABLE bd_mushak_documents (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id         uuid NOT NULL REFERENCES legal_entities(id),
  form_code               text NOT NULL REFERENCES bd_mushak_forms(code),
  source_type             text NOT NULL,
  source_id               uuid NOT NULL,
  document_number         text,
  issue_date              date NOT NULL,
  statutory_template_id   uuid REFERENCES statutory_templates(id),
  localization_version_id uuid NOT NULL REFERENCES localization_versions(id),
  payload                 jsonb NOT NULL,
  file_id                 uuid REFERENCES files(id),
  einvoice_submission_id  uuid REFERENCES einvoice_submissions(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, form_code, document_number)
);
CREATE INDEX bd_mushak_source_idx ON bd_mushak_documents(source_type, source_id);

-- doc 20: VAT classification captured from each posted sales/purchase line.
-- Reads from tax_transactions; adds only the BD-specific facets.
CREATE TABLE bd_vat_transaction_details (
  tax_transaction_id  uuid PRIMARY KEY REFERENCES tax_transactions(id) ON DELETE RESTRICT,
  legal_entity_id     uuid NOT NULL,
  bin                 text,
  counterparty_bin    text,
  counterparty_registered boolean,
  product_service_category text,
  treatment           text NOT NULL CHECK (treatment IN
    ('TAXABLE','EXEMPT','ZERO_RATED','SPECIAL','OUTSIDE_SCOPE')),
  sd_amount           numeric(24,8) NOT NULL DEFAULT 0,   -- supplementary duty
  vds_amount          numeric(24,8) NOT NULL DEFAULT 0,   -- VAT deducted at source
  input_recoverable   boolean NOT NULL DEFAULT true,
  branch_id           uuid REFERENCES branches(id),
  sro_reference       text,
  nbr_rule_version_id uuid REFERENCES bd_nbr_rule_versions(id)
);

-- doc 20: VDS / withholding certificates, modelled through effective-dated tax
-- components rather than bespoke rates.
CREATE TABLE bd_vds_certificates (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id      uuid NOT NULL REFERENCES legal_entities(id),
  certificate_number   text NOT NULL,
  counterparty_id      uuid REFERENCES contacts(id),
  source_type          text NOT NULL,
  source_id            uuid NOT NULL,
  deduction_date       date NOT NULL,
  taxable_amount       numeric(24,8) NOT NULL,
  vds_amount           numeric(24,8) NOT NULL,
  tax_transaction_id   uuid REFERENCES tax_transactions(id),
  file_id              uuid REFERENCES files(id),
  issued_at            timestamptz,
  UNIQUE (legal_entity_id, certificate_number)
);

-- doc 20: VAT return workspace. `tax_returns` (0008) carries the generic
-- lifecycle and immutable filed snapshot; this adds BD-specific totals.
CREATE TABLE bd_vat_returns (
  tax_return_id        uuid PRIMARY KEY REFERENCES tax_returns(id) ON DELETE RESTRICT,
  legal_entity_id      uuid NOT NULL,
  bin                  text NOT NULL,
  form_code            text NOT NULL REFERENCES bd_mushak_forms(code),
  output_vat_total     numeric(24,8) NOT NULL DEFAULT 0,
  input_vat_total      numeric(24,8) NOT NULL DEFAULT 0,
  sd_total             numeric(24,8) NOT NULL DEFAULT 0,
  vds_total            numeric(24,8) NOT NULL DEFAULT 0,
  net_payable          numeric(24,8) NOT NULL DEFAULT 0,
  carried_forward      numeric(24,8) NOT NULL DEFAULT 0,
  -- doc 20 acceptance: "Supported VAT forms/registers reconcile to source
  -- transactions and GL tax controls."
  gl_control_balance   numeric(24,8),
  reconciliation_difference numeric(24,8),
  nbr_rule_version_id  uuid REFERENCES bd_nbr_rule_versions(id),
  CONSTRAINT bd_return_reconciles
    CHECK (reconciliation_difference IS NULL OR reconciliation_difference = 0
           OR gl_control_balance IS NOT NULL)
);

-- doc 20: statutory register snapshots, immutable once produced for a filed period.
CREATE TABLE bd_register_snapshots (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id      uuid NOT NULL REFERENCES legal_entities(id),
  form_code            text NOT NULL REFERENCES bd_mushak_forms(code),
  tax_period_id        uuid NOT NULL REFERENCES tax_periods(id),
  localization_version_id uuid NOT NULL REFERENCES localization_versions(id),
  payload              jsonb NOT NULL,
  content_hash         text NOT NULL,
  file_id              uuid REFERENCES files(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, form_code, tax_period_id)
);
CREATE TRIGGER bd_register_snapshots_immutable
  BEFORE UPDATE OR DELETE ON bd_register_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_of_posted();

COMMENT ON TABLE bd_mushak_forms IS
  'doc 20: "Do not promise every form in first commercial release." is_implemented is the honest '
  'record of what a given release actually supports.';
COMMENT ON TABLE bd_vat_transaction_details IS
  'doc 20 design constraint: BD facets attach to tax_transactions; they do not modify the ledger, '
  'AR or AP schemas. This file proves the 0008 localization framework is sufficient for a real '
  'country pack.';
