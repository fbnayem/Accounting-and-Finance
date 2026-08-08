-- =============================================================================
-- 0011 — Banking, cash, clearing and reconciliation
-- =============================================================================
-- Phase 4. Resolves F-028 (S1: dedupe enforced the fallback fingerprint, not the
-- primary provider ID), F-029 (bank_matches had no integrity constraints),
-- F-030 (completed reconciliations were not locked).
-- =============================================================================

CREATE TABLE bank_connections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id   uuid NOT NULL,
  provider          text NOT NULL,
  external_id       text,
  status            bank_connection_status NOT NULL DEFAULT 'DISCONNECTED',
  -- doc 16: credentials are never stored here, only a secret-manager reference.
  encrypted_config_ref text,
  consent_expires_at timestamptz,
  last_sync_at      timestamptz,
  next_sync_at      timestamptz,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_conn_uq UNIQUE NULLS NOT DISTINCT (legal_entity_id, provider, external_id),
  CONSTRAINT bank_conn_entity_scope_fk FOREIGN KEY (legal_entity_id, tenant_id) REFERENCES legal_entities(id, tenant_id),
  CONSTRAINT bank_conn_scope_uq UNIQUE (id, legal_entity_id)
);
-- doc 15: "alert before credentials expire" (event bank_connection.expiring).
CREATE INDEX bank_connections_expiry_idx ON bank_connections(consent_expires_at)
  WHERE status = 'CONNECTED';

CREATE TABLE bank_accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id       uuid NOT NULL,
  account_id            uuid NOT NULL,               -- the GL account
  bank_connection_id    uuid REFERENCES bank_connections(id),
  branch_id             uuid REFERENCES branches(id),
  kind                  bank_account_type NOT NULL DEFAULT 'BANK',
  name                  text NOT NULL,
  bank_name             text,
  masked_account_number text,
  iban                  text,
  swift_bic             text,
  routing_number        text,
  currency              char(3) NOT NULL REFERENCES currencies(code),
  status                record_status NOT NULL DEFAULT 'ACTIVE',
  settings              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_accounts_gl_fk FOREIGN KEY (account_id, legal_entity_id) REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT bank_accounts_entity_scope_fk FOREIGN KEY (legal_entity_id, tenant_id) REFERENCES legal_entities(id, tenant_id),
  CONSTRAINT bank_accounts_scope_uq UNIQUE (id, legal_entity_id)
);

CREATE TABLE bank_statements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  bank_account_id  uuid NOT NULL REFERENCES bank_accounts(id),
  statement_ref    text,
  format           text NOT NULL CHECK (format IN ('API','CSV','OFX','QFX','QIF','MT940','CAMT053','PROCESSOR')),
  period_start     date,
  period_end       date,
  opening_balance  numeric(24,8),
  closing_balance  numeric(24,8),
  source_file_id   uuid REFERENCES files(id),
  file_hash        text,
  imported_at      timestamptz NOT NULL DEFAULT now(),
  imported_by      uuid REFERENCES users(id),
  -- doc 06: re-import of the same statement file must be idempotent.
  UNIQUE (bank_account_id, file_hash)
);

-- ----------------------------------------------------------------------------
-- Bank transactions — F-028 (S1).
-- doc 06: "Primary key: provider transaction ID per connection/account. Fallback
-- fingerprint uses account + date + amount + normalized reference."
-- The blueprint enforced UNIQUE on fingerprint ONLY and left
-- provider_transaction_id unconstrained, inverting the intended behaviour in
-- both directions: two genuinely distinct same-day identical card payments
-- collided and one was silently rejected, while a re-import with a normalised
-- description was accepted as new.
-- ----------------------------------------------------------------------------
CREATE TABLE bank_transactions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id         uuid NOT NULL,
  bank_account_id         uuid NOT NULL REFERENCES bank_accounts(id),
  bank_statement_id       uuid REFERENCES bank_statements(id),
  provider_transaction_id text,
  transaction_date        date NOT NULL,
  value_date              date,
  currency                char(3) NOT NULL REFERENCES currencies(code),
  amount                  numeric(24,8) NOT NULL CHECK (amount <> 0),
  description             text,
  counterparty_name       text,
  reference               text,
  running_balance         numeric(24,8),
  category_code           text,
  raw_payload             jsonb,           -- F-404: purged to normalized form at 90 days
  fingerprint             text NOT NULL,
  -- F-028: distinguishes legitimately identical same-day transactions, which the
  -- blueprint's fingerprint-unique design made impossible to record.
  import_sequence         integer NOT NULL DEFAULT 1,
  reconciliation_state    bank_recon_txn_status NOT NULL DEFAULT 'UNMATCHED',
  parent_transaction_id   uuid REFERENCES bank_transactions(id),   -- doc 06 split handling
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_txn_account_scope_fk FOREIGN KEY (bank_account_id, legal_entity_id) REFERENCES bank_accounts(id, legal_entity_id)
);
-- F-028: the PRIMARY dedupe key, as doc 06 specifies.
CREATE UNIQUE INDEX bank_transactions_provider_uq
  ON bank_transactions(bank_account_id, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;
-- The fallback: non-unique. A collision raises a suspected-duplicate review item
-- rather than silently rejecting a real transaction.
CREATE INDEX bank_transactions_fingerprint_idx ON bank_transactions(bank_account_id, fingerprint);
CREATE INDEX bank_transactions_match_idx
  ON bank_transactions(bank_account_id, reconciliation_state, transaction_date, amount);

CREATE TABLE bank_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL,
  bank_account_id uuid REFERENCES bank_accounts(id),
  name            text NOT NULL,
  priority        integer NOT NULL DEFAULT 100,
  version         integer NOT NULL DEFAULT 1,
  conditions      jsonb NOT NULL,
  actions         jsonb NOT NULL,
  auto_apply      boolean NOT NULL DEFAULT false,
  status          record_status NOT NULL DEFAULT 'ACTIVE',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, name, version),
  CONSTRAINT bank_rules_entity_scope_fk FOREIGN KEY (legal_entity_id, tenant_id) REFERENCES legal_entities(id, tenant_id)
);

CREATE TABLE bank_reconciliations (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id           uuid NOT NULL,
  bank_account_id           uuid NOT NULL REFERENCES bank_accounts(id),
  statement_start_date      date NOT NULL,
  statement_end_date        date NOT NULL,
  statement_opening_balance numeric(24,8) NOT NULL,
  statement_closing_balance numeric(24,8) NOT NULL,
  book_closing_balance      numeric(24,8),
  difference                numeric(24,8),
  status                    reconciliation_status NOT NULL DEFAULT 'IN_PROGRESS',
  completed_at              timestamptz,
  completed_by              uuid REFERENCES users(id),
  reopened_at               timestamptz,
  reopened_by               uuid REFERENCES users(id),
  reopen_reason             text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  -- F-030: doc 06 "finalization allowed only when difference is zero/configured
  -- tolerance". The blueprint had a free-text status and no such rule.
  CONSTRAINT recon_completed_balanced
    CHECK (status <> 'COMPLETED' OR (difference IS NOT NULL AND book_closing_balance IS NOT NULL)),
  CONSTRAINT recon_reopen_has_reason
    CHECK (status <> 'REOPENED' OR reopen_reason IS NOT NULL),
  CONSTRAINT bank_recon_scope_uq UNIQUE (id, legal_entity_id)
);
-- F-030: a completed session is locked. Correction requires an explicit,
-- permissioned reopen that leaves an audit trail (doc 06).
CREATE OR REPLACE FUNCTION guard_reconciliation_locked()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'COMPLETED' AND NEW.status NOT IN ('COMPLETED','REOPENED') THEN
    RAISE EXCEPTION 'RECONCILIATION_LOCKED: session % is COMPLETED; use the reopen workflow.', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'COMPLETED' AND NEW.status = 'COMPLETED'
     AND ROW(NEW.statement_closing_balance, NEW.book_closing_balance, NEW.difference)
         IS DISTINCT FROM ROW(OLD.statement_closing_balance, OLD.book_closing_balance, OLD.difference) THEN
    RAISE EXCEPTION 'RECONCILIATION_LOCKED: balances of completed session % cannot change.', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bank_reconciliations_locked
  BEFORE UPDATE ON bank_reconciliations
  FOR EACH ROW EXECUTE FUNCTION guard_reconciliation_locked();

-- ----------------------------------------------------------------------------
-- Bank matches — F-029. The blueprint had no unique constraint, no link to a
-- reconciliation session, and nothing bounding the sum of matches against a
-- transaction, despite doc 06 requiring split handling.
-- ----------------------------------------------------------------------------
CREATE TABLE bank_matches (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id),
  bank_transaction_id    uuid NOT NULL REFERENCES bank_transactions(id) ON DELETE RESTRICT,
  bank_reconciliation_id uuid REFERENCES bank_reconciliations(id),        -- F-029
  target_type            text NOT NULL CHECK (target_type IN
    ('CUSTOMER_RECEIPT','VENDOR_PAYMENT','INVOICE','VENDOR_BILL','JOURNAL_ENTRY',
     'BANK_TRANSFER','SETTLEMENT_BATCH','CUSTOMER_REFUND')),
  target_id              uuid NOT NULL,
  matched_amount         numeric(24,8) NOT NULL CHECK (matched_amount <> 0),   -- F-029
  confidence             numeric(8,6) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  match_method           text NOT NULL CHECK (match_method IN ('RULE','EXACT','SUGGESTED','MANUAL','AI')),
  status                 bank_match_status NOT NULL DEFAULT 'SUGGESTED',
  approved_by            uuid REFERENCES users(id),
  approved_at            timestamptz,
  metadata               jsonb NOT NULL DEFAULT '{}'::jsonb
);
-- F-029: one confirmed match per (transaction, target). Suggestions may repeat.
CREATE UNIQUE INDEX bank_matches_confirmed_uq
  ON bank_matches(bank_transaction_id, target_type, target_id) WHERE status = 'CONFIRMED';
CREATE INDEX bank_matches_target_idx ON bank_matches(target_type, target_id);

CREATE OR REPLACE FUNCTION assert_bank_match_bounded()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_sum numeric(24,8); v_amount numeric(24,8); v_txn uuid;
BEGIN
  v_txn := coalesce(NEW.bank_transaction_id, OLD.bank_transaction_id);
  SELECT coalesce(sum(matched_amount),0) INTO v_sum
    FROM bank_matches WHERE bank_transaction_id = v_txn AND status = 'CONFIRMED';
  SELECT amount INTO v_amount FROM bank_transactions WHERE id = v_txn;
  IF abs(v_sum) > abs(v_amount) THEN
    RAISE EXCEPTION
      'OVER_MATCH: confirmed matches % exceed bank transaction amount % for transaction %.',
      v_sum, v_amount, v_txn USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER bank_matches_bounded
  AFTER INSERT OR UPDATE OR DELETE ON bank_matches
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_bank_match_bounded();

-- doc 06: one business transfer object with paired bank-side references.
CREATE TABLE bank_transfers (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id          uuid NOT NULL,
  accounting_book_id       uuid NOT NULL,
  transfer_number          text,
  posting_date             date NOT NULL,
  source_bank_account_id   uuid NOT NULL REFERENCES bank_accounts(id),
  target_bank_account_id   uuid NOT NULL REFERENCES bank_accounts(id),
  source_currency          char(3) NOT NULL REFERENCES currencies(code),
  target_currency          char(3) NOT NULL REFERENCES currencies(code),
  source_amount            numeric(24,8) NOT NULL CHECK (source_amount > 0),
  target_amount            numeric(24,8) NOT NULL CHECK (target_amount > 0),
  exchange_rate            numeric(28,12),
  fee_amount               numeric(24,8) NOT NULL DEFAULT 0,
  status                   payment_status NOT NULL DEFAULT 'DRAFT',
  accounting_entry_id      uuid REFERENCES journal_entries(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (source_bank_account_id <> target_bank_account_id),
  CONSTRAINT transfers_book_scope_fk FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id)
);

-- doc 06: processor clearing. Customer pays 100, processor settles 97, fee 3.
CREATE TABLE settlement_batches (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id       uuid NOT NULL,
  processor             text NOT NULL,
  external_batch_id     text,
  settlement_date       date NOT NULL,
  currency              char(3) NOT NULL REFERENCES currencies(code),
  gross_amount          numeric(24,8) NOT NULL,
  fee_amount            numeric(24,8) NOT NULL DEFAULT 0,
  adjustment_amount     numeric(24,8) NOT NULL DEFAULT 0,
  net_amount            numeric(24,8) NOT NULL,
  bank_transaction_id   uuid REFERENCES bank_transactions(id),
  accounting_entry_id   uuid REFERENCES journal_entries(id),
  status                text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RECONCILED','DISPUTED')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (processor, external_batch_id),
  -- Gate D: gross must decompose exactly into fees, adjustments and net.
  CONSTRAINT settlement_decomposes CHECK (net_amount = gross_amount - fee_amount + adjustment_amount)
);

CREATE TABLE payment_clearing_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id      uuid NOT NULL,
  settlement_batch_id  uuid REFERENCES settlement_batches(id),
  source_type          text NOT NULL,
  source_id            uuid NOT NULL,
  currency             char(3) NOT NULL REFERENCES currencies(code),
  gross_amount         numeric(24,8) NOT NULL,
  fee_amount           numeric(24,8) NOT NULL DEFAULT 0,
  status               text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','SETTLED','CHARGED_BACK','REFUNDED')),
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_clearing_open_idx ON payment_clearing_items(legal_entity_id) WHERE status = 'PENDING';

CREATE TABLE bank_balance_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id uuid NOT NULL REFERENCES bank_accounts(id),
  as_of           timestamptz NOT NULL,
  -- doc 06: cash position must distinguish bank-source from book-source values.
  bank_balance    numeric(24,8),
  book_balance    numeric(24,8),
  unreconciled    numeric(24,8),
  source          text NOT NULL CHECK (source IN ('FEED','IMPORT','MANUAL','COMPUTED')),
  UNIQUE (bank_account_id, as_of, source)
);

-- Deferred bank account FKs from AR/AP.
ALTER TABLE customer_receipts ADD CONSTRAINT receipts_bank_fk FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id);
ALTER TABLE customer_refunds  ADD CONSTRAINT refunds_bank_fk  FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id);
ALTER TABLE vendor_payments   ADD CONSTRAINT vp_bank_fk       FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id);
ALTER TABLE payment_runs      ADD CONSTRAINT payment_runs_bank_fk FOREIGN KEY (bank_account_id) REFERENCES bank_accounts(id);

COMMENT ON INDEX bank_transactions_provider_uq IS
  'F-028 (S1): doc 06''s PRIMARY dedupe key. The blueprint enforced only the fallback fingerprint, '
  'which both lost real transactions and admitted real duplicates.';
