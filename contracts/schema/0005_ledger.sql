-- =============================================================================
-- 0005 — Accounting kernel: chart of accounts, dimensions, journals
-- =============================================================================
-- Phase 2. The highest-stakes file in the schema. Resolves:
--   F-001 zero-value lines forbidden        F-002 lines lacked scope
--   F-003 cross-entity account references   F-006 undefined header currency
--   F-007 chart grain                       F-008 no branch on entries
--   F-009 dimension representations         F-010 overlapping rule versions
-- Immutability (F-004) and the balance assertion (F-005) are in 0006.
-- =============================================================================

CREATE TABLE account_groups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  parent_id       uuid REFERENCES account_groups(id),
  code            text NOT NULL,
  name            text NOT NULL,
  sort_order      integer NOT NULL DEFAULT 0,
  status          record_status NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (legal_entity_id, code),                     -- blueprint had no unique at all
  CONSTRAINT account_groups_entity_scope_fk
    FOREIGN KEY (legal_entity_id, tenant_id) REFERENCES legal_entities(id, tenant_id),
  CONSTRAINT account_groups_scope_uq UNIQUE (id, legal_entity_id)
);

-- ----------------------------------------------------------------------------
-- Chart of accounts — ADR-0003 §2 (F-007).
-- The blueprint keyed accounts on accounting_book_id while account_groups,
-- dimensions and tax_codes were entity-scoped. That forced a full chart copy per
-- book in Phase 10 and made invoice_lines.revenue_account_id unresolvable from
-- an invoice that had no book (F-019). Accounts are now ENTITY-scoped; genuinely
-- book-specific attributes live in account_book_settings below.
-- ----------------------------------------------------------------------------
CREATE TABLE accounts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id          uuid NOT NULL REFERENCES legal_entities(id),
  group_id                 uuid,
  parent_id                uuid REFERENCES accounts(id),
  code                     text NOT NULL,
  name                     text NOT NULL,
  account_type             account_type NOT NULL,
  subtype                  text,
  normal_balance           normal_balance NOT NULL,
  is_posting               boolean NOT NULL DEFAULT true,
  is_control               boolean NOT NULL DEFAULT false,
  is_system                boolean NOT NULL DEFAULT false,
  cash_flow_classification text CHECK (cash_flow_classification IN ('OPERATING','INVESTING','FINANCING','NONE')),
  valid_from               date,
  valid_to                 date,
  status                   record_status NOT NULL DEFAULT 'ACTIVE',
  settings                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, code),
  CONSTRAINT accounts_entity_scope_fk
    FOREIGN KEY (legal_entity_id, tenant_id) REFERENCES legal_entities(id, tenant_id),
  CONSTRAINT accounts_group_scope_fk
    FOREIGN KEY (group_id, legal_entity_id) REFERENCES account_groups(id, legal_entity_id),
  -- ADR-0002: the composite key every account reference in the schema uses.
  CONSTRAINT accounts_scope_uq UNIQUE (id, legal_entity_id)
);
CREATE INDEX accounts_entity_type_idx ON accounts(legal_entity_id, account_type, status);
CREATE INDEX accounts_control_idx     ON accounts(legal_entity_id) WHERE is_control;

-- Book-specific overrides. Replaces chart duplication (ADR-0003 §2).
CREATE TABLE account_book_settings (
  account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  accounting_book_id uuid NOT NULL REFERENCES accounting_books(id) ON DELETE RESTRICT,
  legal_entity_id    uuid NOT NULL,
  is_posting         boolean,
  is_control         boolean,
  status             record_status NOT NULL DEFAULT 'ACTIVE',
  settings           jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (account_id, accounting_book_id),
  CONSTRAINT abs_account_scope_fk FOREIGN KEY (account_id, legal_entity_id) REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT abs_book_scope_fk    FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id)
);

-- ----------------------------------------------------------------------------
-- Dimensions
-- ----------------------------------------------------------------------------
CREATE TABLE dimensions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id   uuid NOT NULL REFERENCES legal_entities(id),
  code              text NOT NULL,
  name              text NOT NULL,
  hierarchy_enabled boolean NOT NULL DEFAULT false,
  status            record_status NOT NULL DEFAULT 'ACTIVE',
  settings          jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (legal_entity_id, code),
  CONSTRAINT dimensions_entity_scope_fk
    FOREIGN KEY (legal_entity_id, tenant_id) REFERENCES legal_entities(id, tenant_id),
  CONSTRAINT dimensions_scope_uq UNIQUE (id, legal_entity_id)
);

CREATE TABLE dimension_values (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL,
  dimension_id    uuid NOT NULL REFERENCES dimensions(id),
  parent_id       uuid REFERENCES dimension_values(id),
  code            text NOT NULL,
  name            text NOT NULL,
  manager_user_id uuid REFERENCES users(id),
  valid_from      date,
  valid_to        date,
  status          record_status NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (dimension_id, code),
  CONSTRAINT dimension_values_dim_scope_fk
    FOREIGN KEY (dimension_id, legal_entity_id) REFERENCES dimensions(id, legal_entity_id),
  CONSTRAINT dimension_values_scope_uq UNIQUE (id, legal_entity_id)
);

-- doc 03: per account/source module, a dimension is REQUIRED, OPTIONAL,
-- PROHIBITED or DEFAULTED. The blueprint had nowhere to express this, so the
-- rule could not be validated (part of F-009).
CREATE TABLE account_dimension_rules (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id       uuid NOT NULL,
  account_id            uuid NOT NULL,
  dimension_id          uuid NOT NULL,
  rule                  dimension_rule NOT NULL DEFAULT 'OPTIONAL',
  default_value_id      uuid REFERENCES dimension_values(id),
  UNIQUE (account_id, dimension_id),
  CONSTRAINT adr_account_fk   FOREIGN KEY (account_id, legal_entity_id) REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT adr_dimension_fk FOREIGN KEY (dimension_id, legal_entity_id) REFERENCES dimensions(id, legal_entity_id),
  CONSTRAINT adr_default_requires_defaulted
    CHECK (rule <> 'DEFAULTED' OR default_value_id IS NOT NULL)
);

-- ----------------------------------------------------------------------------
-- Journal definitions and posting rules
-- ----------------------------------------------------------------------------
CREATE TABLE journals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id    uuid NOT NULL,
  accounting_book_id uuid NOT NULL,
  code               text NOT NULL,
  name               text NOT NULL,
  journal_type       text NOT NULL CHECK (journal_type IN
    ('GENERAL','SALES','PURCHASE','BANK','CASH','INVENTORY','ASSET','TAX','PAYROLL','CONSOLIDATION','OPENING')),
  status             record_status NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (accounting_book_id, code),
  CONSTRAINT journals_book_scope_fk
    FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id),
  CONSTRAINT journals_scope_uq UNIQUE (id, accounting_book_id)
);

CREATE TABLE posting_rule_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id    uuid NOT NULL,
  accounting_book_id uuid NOT NULL,
  event_type         text NOT NULL,            -- e.g. SALES_INVOICE_POSTED
  version            integer NOT NULL,
  valid_from         timestamptz NOT NULL,
  valid_to           timestamptz,
  rule_definition    jsonb NOT NULL,
  -- ADR-0001: which framework treatment this rule encodes. Phase 10 multi-book
  -- carries divergent local GAAP as a separate book, not a branched rule.
  framework          text NOT NULL DEFAULT 'IFRS',
  status             record_status NOT NULL DEFAULT 'ACTIVE',
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (accounting_book_id, event_type, version),
  CONSTRAINT prv_book_scope_fk
    FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id),
  CONSTRAINT prv_dates CHECK (valid_to IS NULL OR valid_to > valid_from)
);
-- F-010: two versions of the same event_type could be simultaneously effective,
-- making rule resolution (doc 03 step 5) non-deterministic. doc 01 rule 7 makes
-- versioned, effective-dated posting rules non-negotiable.
ALTER TABLE posting_rule_versions ADD CONSTRAINT posting_rule_versions_no_overlap
  EXCLUDE USING gist (
    accounting_book_id WITH =,
    event_type WITH =,
    tstzrange(valid_from, valid_to, '[)') WITH &&
  );

-- ----------------------------------------------------------------------------
-- Journal entries
-- ----------------------------------------------------------------------------
CREATE TABLE journal_entries (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id          uuid NOT NULL,
  accounting_book_id       uuid NOT NULL,
  journal_id               uuid NOT NULL,
  accounting_period_id     uuid NOT NULL,
  branch_id                uuid REFERENCES branches(id),      -- F-008
  entry_number             text,
  posting_date             date NOT NULL,
  document_date            date,
  description              text,
  source_type              text NOT NULL,
  source_id                uuid,
  source_event_id          uuid,
  posting_rule_version_id  uuid REFERENCES posting_rule_versions(id),
  reversal_of_id           uuid REFERENCES journal_entries(id),
  -- F-006: the blueprint's `currency` had undefined semantics above lines that
  -- carry both transaction and base currency. Defined: the book's base currency
  -- snapshotted at posting time. Mixed TRANSACTION currencies remain valid.
  base_currency            char(3) NOT NULL REFERENCES currencies(code),
  status                   journal_status NOT NULL DEFAULT 'DRAFT',
  approval_state           approval_status NOT NULL DEFAULT 'NOT_REQUIRED',
  submitted_at             timestamptz,
  approved_at              timestamptz,
  approved_by              uuid REFERENCES users(id),
  posted_at                timestamptz,
  posted_by                uuid REFERENCES users(id),
  reversal_reason          text,
  created_by               uuid REFERENCES users(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  metadata                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT je_book_scope_fk
    FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id),
  CONSTRAINT je_journal_scope_fk
    FOREIGN KEY (journal_id, accounting_book_id) REFERENCES journals(id, accounting_book_id),
  CONSTRAINT je_period_scope_fk
    FOREIGN KEY (accounting_period_id, legal_entity_id) REFERENCES accounting_periods(id, legal_entity_id),
  CONSTRAINT je_posted_has_number CHECK (status <> 'POSTED' OR entry_number IS NOT NULL),
  -- ADR-0003 §1: the composite key journal_lines references, which makes the
  -- denormalised scope columns STRUCTURALLY guaranteed to match the parent
  -- rather than trigger-checked.
  CONSTRAINT je_line_scope_uq
    UNIQUE (id, legal_entity_id, accounting_book_id, accounting_period_id, posting_date)
);
-- Kept from the blueprint — this index is what makes "duplicate accounting event
-- cannot double-post" structural (Phase 2 exit criterion, Gate C).
CREATE UNIQUE INDEX journal_entries_source_event_uq
  ON journal_entries(legal_entity_id, accounting_book_id, source_event_id)
  WHERE source_event_id IS NOT NULL;
CREATE UNIQUE INDEX journal_entries_number_uq
  ON journal_entries(accounting_book_id, entry_number) WHERE entry_number IS NOT NULL;
CREATE INDEX journal_entries_period_idx ON journal_entries(accounting_book_id, accounting_period_id, status);
CREATE INDEX journal_entries_source_idx ON journal_entries(source_type, source_id);
CREATE INDEX journal_entries_posting_date_idx ON journal_entries(accounting_book_id, posting_date);

-- ----------------------------------------------------------------------------
-- Journal lines — ADR-0003 §1 and §5.
--
-- F-002: the blueprint carried only tenant_id. Every Trial Balance, GL, P&L,
-- Balance Sheet, aging and subledger reconciliation filters on entity + book +
-- period and aggregates over lines; all of them had to join the parent. The
-- denormalised columns are also what ADR-0002's composite FKs need, and what
-- makes partitioning by posting_date possible (blueprint note 6).
--
-- F-001: the blueprint's CHECK (base_debit > 0 OR base_credit > 0) rejected
-- zero-cost inventory issues, 100%-discount lines, FX lines rounding to zero in
-- base, and memo lines. Dropped. "At least one non-zero line per journal" is a
-- posting-service rule, enforced at the journal level where it belongs.
-- ----------------------------------------------------------------------------
CREATE TABLE journal_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  journal_entry_id      uuid NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  -- F-002 denormalised scope
  legal_entity_id       uuid NOT NULL,
  accounting_book_id    uuid NOT NULL,
  accounting_period_id  uuid NOT NULL,
  posting_date          date NOT NULL,
  branch_id             uuid REFERENCES branches(id),
  line_no               integer NOT NULL,
  account_id            uuid NOT NULL,
  description           text,
  transaction_currency  char(3) NOT NULL REFERENCES currencies(code),
  transaction_debit     numeric(24,8) NOT NULL DEFAULT 0,
  transaction_credit    numeric(24,8) NOT NULL DEFAULT 0,
  base_currency         char(3) NOT NULL REFERENCES currencies(code),
  base_debit            numeric(24,8) NOT NULL DEFAULT 0,
  base_credit           numeric(24,8) NOT NULL DEFAULT 0,
  exchange_rate         numeric(28,12),
  exchange_rate_date    date,
  exchange_rate_source  text,
  contact_id            uuid,                 -- FK in 0007
  tax_transaction_id    uuid,                 -- FK in 0008
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT jl_nonneg CHECK (transaction_debit >= 0 AND transaction_credit >= 0
                          AND base_debit >= 0 AND base_credit >= 0),
  -- doc 03: "validate each line has debit XOR credit". Kept from the blueprint.
  CONSTRAINT jl_txn_xor  CHECK (NOT (transaction_debit > 0 AND transaction_credit > 0)),
  CONSTRAINT jl_base_xor CHECK (NOT (base_debit > 0 AND base_credit > 0)),
  -- F-001: NO `base_debit > 0 OR base_credit > 0` constraint. Zero lines are legal.
  UNIQUE (journal_entry_id, line_no),
  -- ADR-0003: scope columns cannot disagree with the parent entry.
  CONSTRAINT jl_entry_scope_fk
    FOREIGN KEY (journal_entry_id, legal_entity_id, accounting_book_id, accounting_period_id, posting_date)
    REFERENCES journal_entries(id, legal_entity_id, accounting_book_id, accounting_period_id, posting_date),
  -- F-003 (S1): the account MUST belong to this line's legal entity. Previously
  -- a bug could post entity A's transaction into entity B's ledger, balanced and
  -- undetectable until a control account failed to reconcile weeks later.
  CONSTRAINT jl_account_scope_fk
    FOREIGN KEY (account_id, legal_entity_id) REFERENCES accounts(id, legal_entity_id)
);
-- ADR-0009: the covering index for Trial Balance / GL / subledger reconciliation.
CREATE INDEX journal_lines_tb_idx
  ON journal_lines(accounting_book_id, accounting_period_id, account_id)
  INCLUDE (base_debit, base_credit);
CREATE INDEX journal_lines_account_date_idx ON journal_lines(account_id, posting_date);
CREATE INDEX journal_lines_entry_idx        ON journal_lines(journal_entry_id);
CREATE INDEX journal_lines_contact_idx      ON journal_lines(contact_id) WHERE contact_id IS NOT NULL;

CREATE TABLE journal_line_dimensions (
  journal_line_id    uuid NOT NULL REFERENCES journal_lines(id) ON DELETE RESTRICT,
  legal_entity_id    uuid NOT NULL,
  dimension_id       uuid NOT NULL,
  dimension_value_id uuid NOT NULL,
  PRIMARY KEY (journal_line_id, dimension_id),
  CONSTRAINT jld_dimension_scope_fk
    FOREIGN KEY (dimension_id, legal_entity_id) REFERENCES dimensions(id, legal_entity_id),
  CONSTRAINT jld_value_scope_fk
    FOREIGN KEY (dimension_value_id, legal_entity_id) REFERENCES dimension_values(id, legal_entity_id)
);
CREATE INDEX jld_value_idx ON journal_line_dimensions(dimension_value_id);

-- ----------------------------------------------------------------------------
-- F-009: ONE dimension representation. The blueprint had journal_line_dimensions
-- (typed) alongside `dimensions jsonb` on invoice_lines, vendor_bill_lines,
-- budget_lines and fixed_assets — untyped, unenforceable against the REQUIRED /
-- PROHIBITED rules, and unindexable for doc 12's dimensional reporting.
-- Source documents use this table; the ledger uses journal_line_dimensions.
-- ----------------------------------------------------------------------------
CREATE TABLE document_line_dimensions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id    uuid NOT NULL,
  resource_type      text NOT NULL,      -- F-050: enumerated in the application registry
  resource_id        uuid NOT NULL,
  dimension_id       uuid NOT NULL,
  dimension_value_id uuid NOT NULL,
  UNIQUE (resource_type, resource_id, dimension_id),
  CONSTRAINT dld_dimension_scope_fk
    FOREIGN KEY (dimension_id, legal_entity_id) REFERENCES dimensions(id, legal_entity_id),
  CONSTRAINT dld_value_scope_fk
    FOREIGN KEY (dimension_value_id, legal_entity_id) REFERENCES dimension_values(id, legal_entity_id)
);
CREATE INDEX dld_resource_idx ON document_line_dimensions(resource_type, resource_id);

-- ----------------------------------------------------------------------------
-- Recurring journals (doc 03)
-- ----------------------------------------------------------------------------
CREATE TABLE recurring_journal_templates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id    uuid NOT NULL,
  accounting_book_id uuid NOT NULL,
  journal_id         uuid NOT NULL,
  name               text NOT NULL,
  version            integer NOT NULL DEFAULT 1,
  frequency          text NOT NULL CHECK (frequency IN ('DAILY','WEEKLY','MONTHLY','QUARTERLY','ANNUAL')),
  start_date         date NOT NULL,
  end_date           date,
  next_run_date      date,
  auto_post          boolean NOT NULL DEFAULT false,
  requires_approval  boolean NOT NULL DEFAULT true,
  line_template      jsonb NOT NULL,
  status             record_status NOT NULL DEFAULT 'ACTIVE',
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rjt_book_scope_fk
    FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id),
  CONSTRAINT rjt_scope_uq UNIQUE (id, accounting_book_id)
);

-- doc 03: "occurrence is idempotent" — enforced structurally.
CREATE TABLE recurring_journal_occurrences (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id         uuid NOT NULL REFERENCES recurring_journal_templates(id) ON DELETE RESTRICT,
  occurrence_date     date NOT NULL,
  template_version    integer NOT NULL,
  journal_entry_id    uuid REFERENCES journal_entries(id),
  generated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, occurrence_date)
);

-- ----------------------------------------------------------------------------
-- Ledger balance read model.
-- Blueprint note 7: "treat all *_balance read models as rebuildable projections,
-- never source of truth". Phase 2 exit criterion requires the rebuild to produce
-- identical balances. ADR-0009 targets a full rebuild of 500k lines in <10 min.
-- ----------------------------------------------------------------------------
CREATE TABLE ledger_account_balances (
  accounting_book_id   uuid NOT NULL,
  accounting_period_id uuid NOT NULL,
  account_id           uuid NOT NULL,
  legal_entity_id      uuid NOT NULL,
  base_currency        char(3) NOT NULL REFERENCES currencies(code),
  opening_debit        numeric(24,8) NOT NULL DEFAULT 0,
  opening_credit       numeric(24,8) NOT NULL DEFAULT 0,
  period_debit         numeric(24,8) NOT NULL DEFAULT 0,
  period_credit        numeric(24,8) NOT NULL DEFAULT 0,
  closing_debit        numeric(24,8) NOT NULL DEFAULT 0,
  closing_credit       numeric(24,8) NOT NULL DEFAULT 0,
  rebuilt_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (accounting_book_id, accounting_period_id, account_id),
  CONSTRAINT lab_account_scope_fk FOREIGN KEY (account_id, legal_entity_id) REFERENCES accounts(id, legal_entity_id)
);
COMMENT ON TABLE ledger_account_balances IS
  'Rebuildable projection. NEVER a source of truth (blueprint note 7). Phase 2 exit criterion: '
  'destroy and rebuild from journal_lines must produce identical balances.';

ALTER TABLE accounts ADD CONSTRAINT accounts_group_fk FOREIGN KEY (group_id) REFERENCES account_groups(id);
CREATE TRIGGER accounts_updated_at BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Accounting policy account FKs, deferred from 0003 until accounts existed.
ALTER TABLE accounting_policies
  ADD CONSTRAINT ap_ar_control_fk        FOREIGN KEY (ar_control_account_id)            REFERENCES accounts(id),
  ADD CONSTRAINT ap_ap_control_fk        FOREIGN KEY (ap_control_account_id)            REFERENCES accounts(id),
  ADD CONSTRAINT ap_cash_clearing_fk     FOREIGN KEY (cash_clearing_account_id)         REFERENCES accounts(id),
  ADD CONSTRAINT ap_payment_clearing_fk  FOREIGN KEY (payment_clearing_account_id)      REFERENCES accounts(id),
  ADD CONSTRAINT ap_retained_earnings_fk FOREIGN KEY (retained_earnings_account_id)     REFERENCES accounts(id),
  ADD CONSTRAINT ap_cy_earnings_fk       FOREIGN KEY (current_year_earnings_account_id) REFERENCES accounts(id),
  ADD CONSTRAINT ap_rounding_fk          FOREIGN KEY (rounding_account_id)              REFERENCES accounts(id),
  ADD CONSTRAINT ap_rfx_gain_fk          FOREIGN KEY (realized_fx_gain_account_id)      REFERENCES accounts(id),
  ADD CONSTRAINT ap_rfx_loss_fk          FOREIGN KEY (realized_fx_loss_account_id)      REFERENCES accounts(id),
  ADD CONSTRAINT ap_ufx_gain_fk          FOREIGN KEY (unrealized_fx_gain_account_id)    REFERENCES accounts(id),
  ADD CONSTRAINT ap_ufx_loss_fk          FOREIGN KEY (unrealized_fx_loss_account_id)    REFERENCES accounts(id),
  ADD CONSTRAINT ap_bad_debt_fk          FOREIGN KEY (bad_debt_account_id)              REFERENCES accounts(id),
  ADD CONSTRAINT ap_cust_advance_fk      FOREIGN KEY (customer_advance_account_id)      REFERENCES accounts(id),
  ADD CONSTRAINT ap_vend_advance_fk      FOREIGN KEY (vendor_advance_account_id)        REFERENCES accounts(id),
  ADD CONSTRAINT ap_grni_fk              FOREIGN KEY (grni_account_id)                  REFERENCES accounts(id),
  ADD CONSTRAINT ap_suspense_fk          FOREIGN KEY (suspense_account_id)              REFERENCES accounts(id);

COMMENT ON CONSTRAINT jl_account_scope_fk ON journal_lines IS
  'F-003 (S1): makes a cross-entity account reference impossible rather than merely unlikely.';
COMMENT ON CONSTRAINT jl_entry_scope_fk ON journal_lines IS
  'ADR-0003: denormalised scope columns cannot disagree with the parent entry.';
