-- =============================================================================
-- 0013 — Fixed assets and depreciation
-- =============================================================================
-- Phase 5. Resolves F-035 (dimensions jsonb), F-049 (free-text status).
-- ADR-0001: IFRS/IAS 36 permits impairment REVERSAL for non-goodwill assets;
-- neither the posting rule catalog nor the event catalog had it, because US GAAP
-- forbids the transaction. Added here and in contracts/events.yaml.
-- F-034 (partial/component disposal) remains deferred by doc 09 — S4, no action.
-- =============================================================================

CREATE TABLE asset_categories (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id        uuid NOT NULL,
  code                   text NOT NULL,
  name                   text NOT NULL,
  asset_account_id                    uuid NOT NULL,
  accumulated_depreciation_account_id uuid NOT NULL,
  depreciation_expense_account_id     uuid NOT NULL,
  impairment_loss_account_id          uuid,
  accumulated_impairment_account_id   uuid,
  revaluation_surplus_account_id      uuid,   -- ADR-0001: IAS 16 revaluation model
  gain_account_id                     uuid,
  loss_account_id                     uuid,
  cip_account_id                      uuid,   -- capital work in progress
  default_method         depreciation_method NOT NULL DEFAULT 'STRAIGHT_LINE',
  default_useful_life_months integer CHECK (default_useful_life_months IS NULL OR default_useful_life_months > 0),
  default_proration      proration_convention NOT NULL DEFAULT 'MONTHLY',
  residual_value_policy  text,
  capitalization_threshold numeric(24,8),
  status                 record_status NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (legal_entity_id, code),
  CONSTRAINT ac_entity_scope_fk FOREIGN KEY (legal_entity_id, tenant_id) REFERENCES legal_entities(id, tenant_id),
  -- F-033 pattern: every account must belong to this category's entity.
  CONSTRAINT ac_asset_fk    FOREIGN KEY (asset_account_id, legal_entity_id) REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT ac_accdep_fk   FOREIGN KEY (accumulated_depreciation_account_id, legal_entity_id) REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT ac_depexp_fk   FOREIGN KEY (depreciation_expense_account_id, legal_entity_id) REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT ac_imploss_fk  FOREIGN KEY (impairment_loss_account_id, legal_entity_id) REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT ac_accimp_fk   FOREIGN KEY (accumulated_impairment_account_id, legal_entity_id) REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT ac_revsurp_fk  FOREIGN KEY (revaluation_surplus_account_id, legal_entity_id) REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT ac_gain_fk     FOREIGN KEY (gain_account_id, legal_entity_id) REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT ac_loss_fk     FOREIGN KEY (loss_account_id, legal_entity_id) REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT ac_scope_uq UNIQUE (id, legal_entity_id)
);

CREATE TABLE fixed_assets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id    uuid NOT NULL,
  asset_category_id  uuid NOT NULL,
  branch_id          uuid REFERENCES branches(id),
  asset_number       text NOT NULL,
  name               text NOT NULL,
  description        text,
  serial_number      text,
  asset_tag          text,
  acquisition_source text CHECK (acquisition_source IN ('PURCHASE','MANUAL','MIGRATION','CIP','DONATION')),
  vendor_bill_line_id uuid,
  acquisition_date   date,
  in_service_date    date,
  currency           char(3) NOT NULL REFERENCES currencies(code),
  acquisition_cost   numeric(24,8) NOT NULL DEFAULT 0 CHECK (acquisition_cost >= 0),
  status             asset_status NOT NULL DEFAULT 'DRAFT',
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, asset_number),
  CONSTRAINT fa_category_scope_fk FOREIGN KEY (asset_category_id, legal_entity_id) REFERENCES asset_categories(id, legal_entity_id),
  CONSTRAINT fa_bill_line_fk FOREIGN KEY (vendor_bill_line_id, legal_entity_id) REFERENCES vendor_bill_lines(id, legal_entity_id),
  CONSTRAINT fa_scope_uq UNIQUE (id, legal_entity_id)
  -- F-035: dimensions live in document_line_dimensions, not a jsonb column.
);

-- doc 09: different method/life/carrying amount per book, sharing one physical
-- asset master. Each book has an independent schedule and independent journals.
CREATE TABLE asset_books (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixed_asset_id         uuid NOT NULL REFERENCES fixed_assets(id) ON DELETE RESTRICT,
  accounting_book_id     uuid NOT NULL REFERENCES accounting_books(id),
  legal_entity_id        uuid NOT NULL,
  method                 depreciation_method NOT NULL,
  proration              proration_convention NOT NULL DEFAULT 'MONTHLY',
  useful_life_months     integer NOT NULL CHECK (useful_life_months > 0),
  residual_value         numeric(24,8) NOT NULL DEFAULT 0 CHECK (residual_value >= 0),
  depreciation_start_date date NOT NULL,
  cost_basis             numeric(24,8) NOT NULL DEFAULT 0,
  accumulated_depreciation numeric(24,8) NOT NULL DEFAULT 0,
  accumulated_impairment numeric(24,8) NOT NULL DEFAULT 0,
  revaluation_surplus    numeric(24,8) NOT NULL DEFAULT 0,
  status                 asset_status NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (fixed_asset_id, accounting_book_id),
  CONSTRAINT ab_asset_scope_fk FOREIGN KEY (fixed_asset_id, legal_entity_id) REFERENCES fixed_assets(id, legal_entity_id),
  CONSTRAINT ab_book_scope_fk  FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id),
  CONSTRAINT ab_scope_uq UNIQUE (id, legal_entity_id)
);

CREATE TABLE depreciation_runs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id      uuid NOT NULL,
  accounting_book_id   uuid NOT NULL,
  accounting_period_id uuid NOT NULL,
  version              integer NOT NULL DEFAULT 1,
  status               run_status NOT NULL DEFAULT 'DRAFT',
  total_amount         numeric(24,8) NOT NULL DEFAULT 0,
  journal_entry_id     uuid REFERENCES journal_entries(id),
  approved_by          uuid REFERENCES users(id),
  approved_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dr_book_scope_fk   FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id),
  CONSTRAINT dr_period_scope_fk FOREIGN KEY (accounting_period_id, legal_entity_id) REFERENCES accounting_periods(id, legal_entity_id)
);
-- F-037 pattern: preview and rerun freely; exactly one run may reach POSTED.
CREATE UNIQUE INDEX depreciation_runs_posted_uq
  ON depreciation_runs(legal_entity_id, accounting_book_id, accounting_period_id)
  WHERE status = 'POSTED';

-- Kept from the blueprint: this UNIQUE is what makes Phase 5's "depreciation
-- rerun is idempotent for same asset/book/period" structural rather than
-- procedural. One of the blueprint's genuinely good decisions.
CREATE TABLE depreciation_schedule_lines (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_book_id        uuid NOT NULL REFERENCES asset_books(id) ON DELETE RESTRICT,
  legal_entity_id      uuid NOT NULL,
  accounting_period_id uuid NOT NULL,
  revision             integer NOT NULL DEFAULT 1,
  scheduled_amount     numeric(24,8) NOT NULL,
  posted_amount        numeric(24,8) NOT NULL DEFAULT 0,
  status               depreciation_line_status NOT NULL DEFAULT 'SCHEDULED',
  depreciation_run_id  uuid REFERENCES depreciation_runs(id),
  journal_entry_id     uuid REFERENCES journal_entries(id),
  UNIQUE (asset_book_id, accounting_period_id),
  CONSTRAINT dsl_period_scope_fk FOREIGN KEY (accounting_period_id, legal_entity_id) REFERENCES accounting_periods(id, legal_entity_id),
  CONSTRAINT dsl_posted_has_journal
    CHECK (status <> 'POSTED' OR journal_entry_id IS NOT NULL)
);

-- doc 09: complete transaction history. Absent from the blueprint (F-201).
CREATE TABLE asset_transactions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id     uuid NOT NULL,
  fixed_asset_id      uuid NOT NULL REFERENCES fixed_assets(id),
  asset_book_id       uuid REFERENCES asset_books(id),
  kind                asset_transaction_type NOT NULL,
  posting_date        date NOT NULL,
  amount              numeric(24,8) NOT NULL,
  currency            char(3) NOT NULL REFERENCES currencies(code),
  -- doc 09: revaluation and impairment store reason, evidence, date and approval.
  reason              text,
  valuation_evidence_file_id uuid REFERENCES files(id),
  approved_by         uuid REFERENCES users(id),
  approved_at         timestamptz,
  journal_entry_id    uuid REFERENCES journal_entries(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- ADR-0001: IAS 36 caps a reversal at the carrying amount that would have
  -- applied without the original impairment. Asserted in the domain service;
  -- the linkage below makes it checkable.
  reverses_transaction_id uuid REFERENCES asset_transactions(id),
  CONSTRAINT at_reversal_only_for_impairment
    CHECK (reverses_transaction_id IS NULL OR kind = 'IMPAIRMENT_REVERSAL'),
  CONSTRAINT at_controlled_needs_approval
    CHECK (kind NOT IN ('IMPAIRMENT','IMPAIRMENT_REVERSAL','REVALUATION') OR reason IS NOT NULL)
);
CREATE INDEX asset_transactions_asset_idx ON asset_transactions(fixed_asset_id, posting_date);

CREATE TABLE asset_location_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixed_asset_id  uuid NOT NULL REFERENCES fixed_assets(id) ON DELETE RESTRICT,
  branch_id       uuid REFERENCES branches(id),
  warehouse_location_id uuid REFERENCES warehouse_locations(id),
  free_text_location text,
  valid_from      date NOT NULL,
  valid_to        date
);
ALTER TABLE asset_location_assignments ADD CONSTRAINT ala_no_overlap
  EXCLUDE USING gist (fixed_asset_id WITH =, daterange(valid_from, valid_to, '[)') WITH &&);

CREATE TABLE asset_custodian_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fixed_asset_id  uuid NOT NULL REFERENCES fixed_assets(id) ON DELETE RESTRICT,
  custodian_user_id uuid REFERENCES users(id),
  custodian_name  text,
  valid_from      date NOT NULL,
  valid_to        date
);
ALTER TABLE asset_custodian_assignments ADD CONSTRAINT aca_no_overlap
  EXCLUDE USING gist (fixed_asset_id WITH =, daterange(valid_from, valid_to, '[)') WITH &&);

CREATE TABLE disposal_records (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id        uuid NOT NULL,
  fixed_asset_id         uuid NOT NULL REFERENCES fixed_assets(id),
  asset_book_id          uuid NOT NULL REFERENCES asset_books(id),
  kind                   disposal_type NOT NULL,
  disposal_date          date NOT NULL,
  proceeds_amount        numeric(24,8) NOT NULL DEFAULT 0,
  carrying_amount        numeric(24,8) NOT NULL,
  accumulated_depreciation_removed numeric(24,8) NOT NULL,
  gain_loss_amount       numeric(24,8) NOT NULL,
  buyer_contact_id       uuid REFERENCES contacts(id),
  invoice_id             uuid REFERENCES invoices(id),
  journal_entry_id       uuid REFERENCES journal_entries(id),
  approved_by            uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_book_id),                    -- one disposal per asset-book
  CONSTRAINT dr_gain_loss_derived
    CHECK (gain_loss_amount = proceeds_amount - carrying_amount)
);

COMMENT ON CONSTRAINT at_reversal_only_for_impairment ON asset_transactions IS
  'ADR-0001: impairment reversal exists under IFRS/IAS 36 and is prohibited under US GAAP. The '
  'original posting rule catalog had no rule for it because no framework had been chosen.';
COMMENT ON TABLE depreciation_schedule_lines IS
  'The UNIQUE (asset_book_id, accounting_period_id) is retained from the blueprint unchanged - it '
  'is what makes depreciation idempotency structural (Phase 5 exit criterion, Gate G).';
