-- =============================================================================
-- 0015 — Multi-currency, intercompany and consolidation
-- =============================================================================
-- Phase 7. Resolves F-036 (S1: nullable tenant_id in the exchange_rates unique
-- key left global rates unconstrained), F-037 (only one FX remeasurement run per
-- period was ever possible), F-039 (consolidation mapped to a group chart that
-- did not exist), F-040 (intercompany pairs not tenant-checked).
-- =============================================================================

CREATE TABLE exchange_rate_sets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid REFERENCES tenants(id),
  code          text NOT NULL,
  name          text NOT NULL,
  rate_type     text NOT NULL CHECK (rate_type IN ('SPOT','AVERAGE','CLOSING','HISTORICAL')),
  status        record_status NOT NULL DEFAULT 'ACTIVE',
  CONSTRAINT ers_uq UNIQUE NULLS NOT DISTINCT (tenant_id, code)
);

-- ----------------------------------------------------------------------------
-- F-036 (S1). The blueprint had:
--   tenant_id uuid REFERENCES tenants(id),        -- nullable
--   UNIQUE (tenant_id, rate_date, from_currency, to_currency, rate_type, source)
-- PostgreSQL treats NULL as distinct in unique constraints, so EVERY
-- platform-global rate row was unconstrained: a provider sync running twice
-- inserted two rows for the same date and pair, and rate resolution then
-- returned an arbitrary one. Re-running a report could produce different numbers
-- with no visible cause — worse than the in-place update doc 11 forbids.
-- ----------------------------------------------------------------------------
CREATE TABLE exchange_rates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid REFERENCES tenants(id),          -- null = platform-global
  exchange_rate_set_id uuid REFERENCES exchange_rate_sets(id),
  rate_date          date NOT NULL,
  from_currency      char(3) NOT NULL REFERENCES currencies(code),
  to_currency        char(3) NOT NULL REFERENCES currencies(code),
  rate_type          text NOT NULL DEFAULT 'SPOT' CHECK (rate_type IN ('SPOT','AVERAGE','CLOSING','HISTORICAL')),
  rate               numeric(28,12) NOT NULL CHECK (rate > 0),
  source             text NOT NULL,
  provider_reference text,
  -- doc 11: "Manual override requires permission and audit reason."
  is_manual_override boolean NOT NULL DEFAULT false,
  override_reason    text,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (from_currency <> to_currency),
  CONSTRAINT fx_override_has_reason CHECK (NOT is_manual_override OR override_reason IS NOT NULL),
  -- F-036: NULLS NOT DISTINCT closes the global-rate hole (ADR-0008 requires PG16).
  CONSTRAINT exchange_rates_uq
    UNIQUE NULLS NOT DISTINCT (tenant_id, rate_date, from_currency, to_currency, rate_type, source)
);
CREATE INDEX exchange_rates_lookup_idx ON exchange_rates(from_currency, to_currency, rate_type, rate_date DESC);

-- ----------------------------------------------------------------------------
-- F-037. The blueprint had UNIQUE (entity, book, period) on the run table, so
-- only ONE remeasurement run per period was possible ever. doc 11 requires
-- "produce preview per account/currency/open item" and Phase 7's exit criterion
-- is "period-end remeasurement is reversible/repeatable without duplication".
-- The intent (no double-posting) was right; the mechanism was too blunt.
-- ----------------------------------------------------------------------------
CREATE TABLE fx_remeasurement_runs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id      uuid NOT NULL,
  accounting_book_id   uuid NOT NULL,
  accounting_period_id uuid NOT NULL,
  version              integer NOT NULL DEFAULT 1,
  rate_date            date NOT NULL,
  exchange_rate_set_id uuid REFERENCES exchange_rate_sets(id),
  status               run_status NOT NULL DEFAULT 'DRAFT',
  total_gain           numeric(24,8) NOT NULL DEFAULT 0,
  total_loss           numeric(24,8) NOT NULL DEFAULT 0,
  journal_entry_id     uuid REFERENCES journal_entries(id),
  reversal_journal_entry_id uuid REFERENCES journal_entries(id),
  auto_reverse_next_period boolean NOT NULL DEFAULT true,
  created_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, accounting_book_id, accounting_period_id, version),
  CONSTRAINT fxr_book_scope_fk   FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id),
  CONSTRAINT fxr_period_scope_fk FOREIGN KEY (accounting_period_id, legal_entity_id) REFERENCES accounting_periods(id, legal_entity_id)
);
-- Preview and rerun freely; exactly one run may reach POSTED.
CREATE UNIQUE INDEX fx_remeasurement_posted_uq
  ON fx_remeasurement_runs(legal_entity_id, accounting_book_id, accounting_period_id)
  WHERE status = 'POSTED';

CREATE TABLE fx_remeasurement_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fx_remeasurement_run_id uuid NOT NULL REFERENCES fx_remeasurement_runs(id) ON DELETE RESTRICT,
  legal_entity_id       uuid NOT NULL,
  account_id            uuid NOT NULL,
  currency              char(3) NOT NULL REFERENCES currencies(code),
  source_type           text,
  source_id             uuid,
  -- doc 11: "Run stores original carrying amount, closing rate and delta."
  foreign_amount        numeric(24,8) NOT NULL,
  original_base_amount  numeric(24,8) NOT NULL,
  closing_rate          numeric(28,12) NOT NULL,
  remeasured_base_amount numeric(24,8) NOT NULL,
  delta_amount          numeric(24,8) NOT NULL,
  CONSTRAINT fxl_delta_derived CHECK (delta_amount = remeasured_base_amount - original_base_amount),
  CONSTRAINT fxl_account_scope_fk FOREIGN KEY (account_id, legal_entity_id) REFERENCES accounts(id, legal_entity_id)
);

-- ------------------------------------------------------------ intercompany ---
CREATE TABLE intercompany_relationships (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id),
  organization_id         uuid NOT NULL REFERENCES organizations(id),
  entity_id               uuid NOT NULL,
  counterparty_entity_id  uuid NOT NULL,
  due_from_account_id     uuid,
  due_to_account_id       uuid,
  status                  record_status NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (entity_id, counterparty_entity_id),
  CHECK (entity_id <> counterparty_entity_id),
  -- F-040: both entities must belong to the same organization, hence the same
  -- tenant. The blueprint constrained neither.
  CONSTRAINT icr_entity_fk       FOREIGN KEY (entity_id, organization_id) REFERENCES legal_entities(id, organization_id),
  CONSTRAINT icr_counterparty_fk FOREIGN KEY (counterparty_entity_id, organization_id) REFERENCES legal_entities(id, organization_id),
  CONSTRAINT icr_due_from_fk FOREIGN KEY (due_from_account_id, entity_id) REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT icr_due_to_fk   FOREIGN KEY (due_to_account_id, entity_id)   REFERENCES accounts(id, legal_entity_id)
);

CREATE TABLE intercompany_transactions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id),
  organization_id         uuid NOT NULL REFERENCES organizations(id),
  source_entity_id        uuid NOT NULL,
  counterparty_entity_id  uuid NOT NULL,
  transaction_type        text NOT NULL CHECK (transaction_type IN ('CHARGE','SETTLEMENT','ALLOCATION','LOAN')),
  source_document_type    text,
  source_document_id      uuid,
  currency                char(3) NOT NULL REFERENCES currencies(code),
  amount                  numeric(24,8) NOT NULL,
  transaction_date        date NOT NULL,
  status                  text NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','MATCHED','SETTLED','EXCEPTION','CANCELLED')),
  paired_transaction_id   uuid REFERENCES intercompany_transactions(id),
  journal_entry_id        uuid REFERENCES journal_entries(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (source_entity_id <> counterparty_entity_id),
  CONSTRAINT ict_source_fk       FOREIGN KEY (source_entity_id, organization_id) REFERENCES legal_entities(id, organization_id),
  CONSTRAINT ict_counterparty_fk FOREIGN KEY (counterparty_entity_id, organization_id) REFERENCES legal_entities(id, organization_id)
);
CREATE INDEX ict_open_idx ON intercompany_transactions(organization_id, status) WHERE status IN ('OPEN','EXCEPTION');

-- ----------------------------------------------------------- consolidation ---
CREATE TABLE consolidation_groups (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  code               text NOT NULL,
  name               text NOT NULL,
  reporting_currency char(3) NOT NULL REFERENCES currencies(code),
  status             record_status NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (organization_id, code),
  CONSTRAINT cg_org_scope_fk FOREIGN KEY (organization_id, tenant_id) REFERENCES organizations(id, tenant_id),
  CONSTRAINT cg_scope_uq UNIQUE (id, organization_id)
);

-- F-039: the blueprint mapped to `group_account_code text` — a free string with
-- no table behind it, so doc 11's "missing required mapping blocks final
-- consolidation and appears in exception report" had no enumerable target set.
CREATE TABLE group_accounts (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consolidation_group_id uuid NOT NULL REFERENCES consolidation_groups(id) ON DELETE RESTRICT,
  code                   text NOT NULL,
  name                   text NOT NULL,
  account_type           account_type NOT NULL,
  normal_balance         normal_balance NOT NULL,
  parent_id              uuid REFERENCES group_accounts(id),
  is_required            boolean NOT NULL DEFAULT false,
  UNIQUE (consolidation_group_id, code),
  CONSTRAINT ga_scope_uq UNIQUE (id, consolidation_group_id)
);

CREATE TABLE consolidation_group_entities (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consolidation_group_id uuid NOT NULL REFERENCES consolidation_groups(id) ON DELETE RESTRICT,
  legal_entity_id        uuid NOT NULL REFERENCES legal_entities(id),
  ownership_percent      numeric(9,6) NOT NULL DEFAULT 1 CHECK (ownership_percent BETWEEN 0 AND 1),
  consolidation_method   text NOT NULL DEFAULT 'FULL'
    CHECK (consolidation_method IN ('FULL','PROPORTIONAL','EQUITY','NONE')),
  valid_from             date NOT NULL,
  valid_to               date
);
-- F-010 pattern: ownership cannot overlap for the same entity in the same group.
ALTER TABLE consolidation_group_entities ADD CONSTRAINT cge_no_overlap
  EXCLUDE USING gist (
    consolidation_group_id WITH =, legal_entity_id WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  );

CREATE TABLE consolidation_account_mappings (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consolidation_group_id uuid NOT NULL,
  legal_entity_id        uuid NOT NULL,
  source_account_id      uuid NOT NULL,
  group_account_id       uuid NOT NULL,        -- F-039: a real FK, not a string
  valid_from             date NOT NULL,
  valid_to               date,
  CONSTRAINT cam_source_fk FOREIGN KEY (source_account_id, legal_entity_id) REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT cam_group_fk  FOREIGN KEY (group_account_id, consolidation_group_id) REFERENCES group_accounts(id, consolidation_group_id)
);
ALTER TABLE consolidation_account_mappings ADD CONSTRAINT cam_no_overlap
  EXCLUDE USING gist (
    consolidation_group_id WITH =, source_account_id WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  );

CREATE TABLE elimination_rules (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consolidation_group_id uuid NOT NULL REFERENCES consolidation_groups(id) ON DELETE RESTRICT,
  code                   text NOT NULL,
  name                   text NOT NULL,
  version                integer NOT NULL DEFAULT 1,
  definition             jsonb NOT NULL,
  valid_from             date NOT NULL,
  valid_to               date,
  status                 record_status NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (consolidation_group_id, code, version)
);
ALTER TABLE elimination_rules ADD CONSTRAINT elimination_rules_no_overlap
  EXCLUDE USING gist (
    consolidation_group_id WITH =, code WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  );

CREATE TABLE consolidation_runs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id),
  consolidation_group_id uuid NOT NULL REFERENCES consolidation_groups(id),
  accounting_period_id   uuid NOT NULL REFERENCES accounting_periods(id),
  reporting_currency     char(3) NOT NULL REFERENCES currencies(code),
  exchange_rate_set_id   uuid REFERENCES exchange_rate_sets(id),
  version                integer NOT NULL DEFAULT 1,
  status                 run_status NOT NULL DEFAULT 'DRAFT',
  -- doc 11: "lock reproducible consolidation snapshot".
  input_snapshot         jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_snapshot        jsonb,
  approved_by            uuid REFERENCES users(id),
  completed_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (consolidation_group_id, accounting_period_id, version)
);
CREATE UNIQUE INDEX consolidation_runs_posted_uq
  ON consolidation_runs(consolidation_group_id, accounting_period_id) WHERE status = 'POSTED';

CREATE TABLE consolidation_adjustments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consolidation_run_id  uuid NOT NULL REFERENCES consolidation_runs(id) ON DELETE RESTRICT,
  adjustment_type       text NOT NULL
    CHECK (adjustment_type IN ('ELIMINATION','TRANSLATION','MANUAL','MINORITY_INTEREST','CTA')),
  elimination_rule_id   uuid REFERENCES elimination_rules(id),
  reference             text,
  description           text,
  lines                 jsonb NOT NULL,
  -- doc 11: "Always references source entity balances/transactions used."
  source_links          jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE consolidation_adjustments IS
  'doc 11: consolidation NEVER changes source statutory ledgers. These rows exist only in the '
  'consolidation layer; there is deliberately no journal_entry_id writing back to an entity book.';

CREATE TABLE translation_adjustments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consolidation_run_id uuid NOT NULL REFERENCES consolidation_runs(id) ON DELETE RESTRICT,
  legal_entity_id      uuid NOT NULL REFERENCES legal_entities(id),
  group_account_id     uuid REFERENCES group_accounts(id),
  opening_cta          numeric(24,8) NOT NULL DEFAULT 0,
  movement_cta         numeric(24,8) NOT NULL DEFAULT 0,
  closing_cta          numeric(24,8) NOT NULL DEFAULT 0,
  CONSTRAINT cta_rollforward CHECK (closing_cta = opening_cta + movement_cta)
);

CREATE TABLE consolidation_balances (
  consolidation_run_id uuid NOT NULL REFERENCES consolidation_runs(id) ON DELETE CASCADE,
  legal_entity_id      uuid NOT NULL REFERENCES legal_entities(id),
  group_account_id     uuid NOT NULL REFERENCES group_accounts(id),
  local_debit          numeric(24,8) NOT NULL DEFAULT 0,
  local_credit         numeric(24,8) NOT NULL DEFAULT 0,
  translated_debit     numeric(24,8) NOT NULL DEFAULT 0,
  translated_credit    numeric(24,8) NOT NULL DEFAULT 0,
  translation_rate     numeric(28,12),
  PRIMARY KEY (consolidation_run_id, legal_entity_id, group_account_id)
);

COMMENT ON CONSTRAINT exchange_rates_uq ON exchange_rates IS
  'F-036 (S1): the blueprint''s equivalent used default NULLS DISTINCT, leaving every '
  'platform-global rate row unconstrained and rate resolution non-deterministic.';
