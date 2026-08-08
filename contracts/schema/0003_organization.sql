-- =============================================================================
-- 0003 — Organization: legal entities, branches, currencies, sequences, policy
-- =============================================================================
-- Phase 1. Resolves F-203 (accounting_policies — every posting rule resolves its
-- accounts through it), F-012 (number sequence scope), F-014 (currency fields),
-- F-051/ADR-0006 (currencies table), F-026 (contact sharing policy).
-- =============================================================================

-- ADR-0006 §2: the blueprint had no currencies table, so per-currency minor unit
-- and cash rounding had nowhere to live despite doc 01 requiring them.
CREATE TABLE currencies (
  code                     char(3) PRIMARY KEY,
  name                     text NOT NULL,
  minor_unit               smallint NOT NULL CHECK (minor_unit BETWEEN 0 AND 6),
  cash_rounding_increment  numeric(18,8),        -- e.g. 0.05 where 1c coins are withdrawn
  symbol                   text,
  symbol_position          text NOT NULL DEFAULT 'BEFORE' CHECK (symbol_position IN ('BEFORE','AFTER')),
  is_active                boolean NOT NULL DEFAULT true
);
COMMENT ON COLUMN currencies.minor_unit IS
  'ADR-0006: drives every rounding boundary. Immutable once transactions exist.';

CREATE TABLE legal_entities (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  organization_id      uuid NOT NULL REFERENCES organizations(id),
  code                 text NOT NULL,
  legal_name           text NOT NULL,
  display_name         text,
  registration_number  text,
  tax_identifier       text,
  country_code         char(2) NOT NULL,
  -- F-014: the statutory default that seeds the primary book. The BOOK's
  -- base_currency is authoritative for posting (ADR-0003).
  functional_currency  char(3) NOT NULL REFERENCES currencies(code),
  timezone             text NOT NULL,
  status               record_status NOT NULL DEFAULT 'ACTIVE',
  -- doc 02: posting stays disabled until required setup validation passes.
  activated_at         timestamptz,
  posting_enabled      boolean NOT NULL DEFAULT false,
  settings             jsonb NOT NULL DEFAULT '{}'::jsonb,
  version              bigint NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  CONSTRAINT legal_entities_org_scope_fk
    FOREIGN KEY (organization_id, tenant_id) REFERENCES organizations(id, tenant_id),
  CONSTRAINT legal_entities_scope_uq UNIQUE (id, tenant_id),
  CONSTRAINT legal_entities_org_uq   UNIQUE (id, organization_id)
);
CREATE INDEX legal_entities_org_idx ON legal_entities(organization_id, status);

CREATE TABLE branches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  code            text NOT NULL,
  name            text NOT NULL,
  country_code    char(2),
  address         jsonb,
  manager_user_id uuid REFERENCES users(id),
  valid_from      date,
  valid_to        date,
  status          record_status NOT NULL DEFAULT 'ACTIVE',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, code),
  CONSTRAINT branches_entity_scope_fk
    FOREIGN KEY (legal_entity_id, tenant_id) REFERENCES legal_entities(id, tenant_id),
  CONSTRAINT branches_scope_uq UNIQUE (id, legal_entity_id)
);

-- ----------------------------------------------------------------------------
-- Accounting policy — F-203, the S1 finding.
-- The posting rule catalog opens with "Concrete account IDs come from the
-- entity/book accounting policy". That table did not exist, so EVERY posting
-- rule resolved its accounts through nothing. Versioned and effective-dated per
-- doc 01 rule 7; historical documents retain the version they used.
-- ----------------------------------------------------------------------------
CREATE TABLE accounting_policies (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id          uuid NOT NULL REFERENCES legal_entities(id),
  accounting_book_id       uuid,                       -- FK added in 0004; null = entity default
  version                  integer NOT NULL,
  valid_from               date NOT NULL,
  valid_to                 date,

  -- ADR-0001 §2: the tenant chooses; immutable once the book has a closed year.
  retained_earnings_method retained_earnings_method NOT NULL DEFAULT 'DERIVED',

  -- Default account mappings resolved by the posting service (posting_rule_catalog).
  -- Typed UUID columns rather than JSON so ADR-0002 composite FKs can constrain them;
  -- FKs added in 0005 once `accounts` exists.
  ar_control_account_id            uuid,
  ap_control_account_id            uuid,
  cash_clearing_account_id         uuid,
  payment_clearing_account_id      uuid,
  retained_earnings_account_id     uuid,
  current_year_earnings_account_id uuid,
  rounding_account_id              uuid,
  realized_fx_gain_account_id      uuid,
  realized_fx_loss_account_id      uuid,
  unrealized_fx_gain_account_id    uuid,
  unrealized_fx_loss_account_id    uuid,
  bad_debt_account_id              uuid,
  customer_advance_account_id      uuid,
  vendor_advance_account_id        uuid,
  grni_account_id                  uuid,
  suspense_account_id              uuid,

  -- ADR-0006 rounding policy
  rounding_mode                    rounding_mode NOT NULL DEFAULT 'HALF_UP',
  rounding_tolerance               numeric(24,8) NOT NULL DEFAULT 0,

  -- F-310: thresholds had no shipped defaults, so a new tenant had undefined
  -- control behaviour and Gate F had no boundaries to test.
  capitalization_threshold         numeric(24,8) NOT NULL DEFAULT 0,
  write_off_approval_threshold     numeric(24,8) NOT NULL DEFAULT 0,
  payment_dual_approval_threshold  numeric(24,8),
  journal_approval_threshold       numeric(24,8),

  -- F-309: tolerances were named as compare dimensions with no value or unit.
  three_way_match_tolerance_pct    numeric(9,6) NOT NULL DEFAULT 0.02,
  three_way_match_tolerance_abs    numeric(24,8) NOT NULL DEFAULT 0,
  bank_reconciliation_tolerance    numeric(24,8) NOT NULL DEFAULT 0,

  -- F-311: doc 04 gives AR aging buckets a stated default (0-30/31-60/61-90/91+)
  -- but doc 05 gives AP none. Both are shipped defaults here so a new tenant has
  -- defined behaviour and the aging reports are comparable.
  ar_aging_buckets                 integer[] NOT NULL DEFAULT '{30,60,90}',
  ap_aging_buckets                 integer[] NOT NULL DEFAULT '{30,60,90}',

  default_inventory_valuation      valuation_method NOT NULL DEFAULT 'WEIGHTED_AVERAGE',
  allow_negative_stock             boolean NOT NULL DEFAULT false,
  closed_period_behaviour          text NOT NULL DEFAULT 'REJECT',
  ai_automation_enabled            boolean NOT NULL DEFAULT false,

  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, accounting_book_id, version),
  CONSTRAINT accounting_policies_entity_scope_fk
    FOREIGN KEY (legal_entity_id, tenant_id) REFERENCES legal_entities(id, tenant_id),
  CONSTRAINT accounting_policies_dates CHECK (valid_to IS NULL OR valid_to > valid_from)
);
-- F-010 pattern: only one policy version may be effective at a time.
ALTER TABLE accounting_policies ADD CONSTRAINT accounting_policies_no_overlap
  EXCLUDE USING gist (
    legal_entity_id WITH =,
    coalesce(accounting_book_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  );

-- ----------------------------------------------------------------------------
-- Number sequences — F-012 / ADR-0004 §1.
-- The blueprint had UNIQUE (legal_entity_id, scope) with `scope text`, so every
-- dimension beyond entity had to be string-encoded. doc 02 requires scope options
-- of legal entity, branch, document type and fiscal year. Modelled properly.
-- ----------------------------------------------------------------------------
CREATE TABLE number_sequences (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  document_type   text NOT NULL,
  branch_id       uuid REFERENCES branches(id),
  fiscal_year_id  uuid,                       -- FK added in 0004
  prefix          text,
  suffix          text,
  padding         integer NOT NULL DEFAULT 0 CHECK (padding BETWEEN 0 AND 20),
  next_number     bigint NOT NULL DEFAULT 1 CHECK (next_number > 0),
  reset_rule      text NOT NULL DEFAULT 'NEVER' CHECK (reset_rule IN ('NEVER','ANNUAL','MONTHLY')),
  status          record_status NOT NULL DEFAULT 'ACTIVE',
  -- F-017: NULLS NOT DISTINCT so an entity-wide sequence cannot be duplicated.
  CONSTRAINT number_sequences_uq
    UNIQUE NULLS NOT DISTINCT (legal_entity_id, document_type, branch_id, fiscal_year_id),
  CONSTRAINT number_sequences_entity_scope_fk
    FOREIGN KEY (legal_entity_id, tenant_id) REFERENCES legal_entities(id, tenant_id)
);
COMMENT ON TABLE number_sequences IS
  'ADR-0004: allocation is SELECT ... FOR UPDATE inside the posting transaction, as late as '
  'possible. PostgreSQL sequences are gap-tolerant and therefore unusable for statutory numbering.';

-- Doc 02: voided numbers are never reused and remain visible in the audit sequence.
CREATE TABLE number_allocations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number_sequence_id uuid NOT NULL REFERENCES number_sequences(id) ON DELETE RESTRICT,
  allocated_number   bigint NOT NULL,
  formatted_number   text NOT NULL,
  resource_type      text NOT NULL,
  resource_id        uuid NOT NULL,
  voided             boolean NOT NULL DEFAULT false,
  allocated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (number_sequence_id, allocated_number)
);

-- doc 02 / doc 11: exchange rate providers.
CREATE TABLE exchange_rate_providers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid REFERENCES tenants(id),    -- null = platform-wide provider
  code          text NOT NULL,
  name          text NOT NULL,
  is_default    boolean NOT NULL DEFAULT false,
  status        record_status NOT NULL DEFAULT 'ACTIVE',
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- F-036 pattern: NULLS NOT DISTINCT so a platform-wide provider is unique.
  CONSTRAINT exchange_rate_providers_uq UNIQUE NULLS NOT DISTINCT (tenant_id, code)
);

-- doc 02/07: which localization package version an entity is running.
CREATE TABLE localization_installations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id        uuid NOT NULL REFERENCES legal_entities(id),
  localization_version_id uuid,                 -- FK added in 0008
  installed_at           timestamptz NOT NULL DEFAULT now(),
  installed_by           uuid REFERENCES users(id),
  status                 record_status NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (legal_entity_id, localization_version_id)
);

-- Deferred FKs now that legal_entities and branches exist.
ALTER TABLE outbox_events  ADD CONSTRAINT outbox_entity_fk     FOREIGN KEY (legal_entity_id) REFERENCES legal_entities(id);
ALTER TABLE outbox_events  ADD CONSTRAINT outbox_branch_fk     FOREIGN KEY (branch_id)       REFERENCES branches(id);
ALTER TABLE audit_events   ADD CONSTRAINT audit_entity_fk      FOREIGN KEY (legal_entity_id) REFERENCES legal_entities(id);
ALTER TABLE memberships    ADD CONSTRAINT memberships_entity_fk FOREIGN KEY (legal_entity_id) REFERENCES legal_entities(id);
ALTER TABLE memberships    ADD CONSTRAINT memberships_branch_fk FOREIGN KEY (branch_id)       REFERENCES branches(id);

CREATE TRIGGER legal_entities_updated_at BEFORE UPDATE ON legal_entities FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE accounting_policies IS
  'F-203 (S1): the table every posting rule resolves its accounts through. It did not exist in the '
  'blueprint. Versioned and effective-dated per doc 01 rule 7.';
