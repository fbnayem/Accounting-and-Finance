-- =============================================================================
-- 0054 — Period-end entries: accruals, prepaids and deferred revenue (F-1004)
-- =============================================================================
-- Phase 6. doc 21's close management requires "accrual/prepaid/deferred entries"
-- and the contract has carried the four period-end-entry operations since the
-- Phase 6 routes were added — but no table existed to record one. The journals
-- themselves are NOT stored here: every posting goes through the Phase 2/3
-- kernel (DocumentPostingService) under the catalog rules EXPENSE_ACCRUAL,
-- PREPAID_PURCHASE, DEFERRED_REVENUE_BILLING, PREPAID_AMORTIZATION and
-- REVENUE_RECOGNIZED. What these tables record is the SCHEDULE — the balance an
-- entry still carries, and which period's portion has already been released —
-- because a prepaid spread over twelve months is twelve postings against one
-- balance and journal rows alone cannot say whether the eleventh happened.
--
-- An ACCRUAL carries no recognition schedule at all: its unwind is a
-- scheduled_reversals row (F-612), claimed by ledger_claim_due_reversals and
-- posted by the same worker that posts every other scheduled reversal. A second
-- reversal machine here would be a second answer about when an accrual unwinds,
-- so `pee_accrual_reverses` makes the schedule row a precondition of the entry.
--
-- Forward-only (ADR-0008): adds beside 0016/0029/0050, follows their patterns —
-- scope keys named *_scope_fk (CROSS_ENTITY_REFERENCE mapping), RLS enabled,
-- forced, registered.
-- =============================================================================

CREATE TABLE period_end_entries (
  id                     uuid PRIMARY KEY,
  tenant_id              uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id        uuid NOT NULL,
  accounting_book_id     uuid NOT NULL,
  -- The period the initial posting landed in, as resolved by the kernel (F-403).
  accounting_period_id   uuid NOT NULL,
  entry_type             text NOT NULL CHECK (entry_type IN ('ACCRUAL','PREPAID','DEFERRAL')),
  description            text NOT NULL,
  currency               char(3) NOT NULL REFERENCES currencies(code),
  total_amount           numeric(24,8) NOT NULL CHECK (total_amount > 0),
  -- The balance-sheet account that carries the balance: accrued liability,
  -- prepaid asset or deferred revenue.
  balance_account_id     uuid NOT NULL,
  -- The P&L account recognition (or the accrual itself) posts to.
  pl_account_id          uuid NOT NULL,
  -- The other side of the initial posting for PREPAID (Cr AP/bank) and DEFERRAL
  -- (Dr AR/bank). An accrual's initial posting is Dr expense / Cr liability and
  -- has no third account.
  settlement_account_id  uuid,
  recognition_start_date date,
  recognition_periods    integer CHECK (recognition_periods IS NULL OR recognition_periods BETWEEN 1 AND 120),
  posting_date           date NOT NULL,
  -- The initial journal, posted by the kernel in the same transaction.
  journal_entry_id       uuid NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  -- The F-612 schedule that unwinds an accrual. NOT NULL for ACCRUAL by the
  -- constraint below: an accrual that is created but never reverses is a
  -- permanent misstatement, so the schedule is a precondition of the row.
  scheduled_reversal_id  uuid REFERENCES scheduled_reversals(id),
  status                 text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','FULLY_RECOGNIZED')),
  created_by             uuid REFERENCES users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pee_tenant_uq UNIQUE (id, tenant_id),
  CONSTRAINT pee_entity_uq UNIQUE (id, legal_entity_id),
  CONSTRAINT pee_entity_scope_fk  FOREIGN KEY (legal_entity_id, tenant_id)
      REFERENCES legal_entities(id, tenant_id),
  CONSTRAINT pee_book_scope_fk    FOREIGN KEY (accounting_book_id, legal_entity_id)
      REFERENCES accounting_books(id, legal_entity_id),
  CONSTRAINT pee_period_scope_fk  FOREIGN KEY (accounting_period_id, legal_entity_id)
      REFERENCES accounting_periods(id, legal_entity_id),
  CONSTRAINT pee_balance_account_scope_fk FOREIGN KEY (balance_account_id, legal_entity_id)
      REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT pee_pl_account_scope_fk      FOREIGN KEY (pl_account_id, legal_entity_id)
      REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT pee_settlement_account_scope_fk FOREIGN KEY (settlement_account_id, legal_entity_id)
      REFERENCES accounts(id, legal_entity_id),
  -- The two sides of one posting cannot be one account.
  CONSTRAINT pee_two_accounts CHECK (balance_account_id <> pl_account_id),
  -- PREPAID and DEFERRAL name the account their initial posting settles against;
  -- an accrual has none.
  CONSTRAINT pee_settlement_by_type CHECK (
    (entry_type = 'ACCRUAL' AND settlement_account_id IS NULL)
    OR (entry_type <> 'ACCRUAL' AND settlement_account_id IS NOT NULL)),
  -- An accrual reverses; a prepaid/deferral recognises on a schedule. Each shape
  -- carries exactly the columns its unwind needs, and no others.
  CONSTRAINT pee_accrual_reverses CHECK (entry_type <> 'ACCRUAL' OR scheduled_reversal_id IS NOT NULL),
  CONSTRAINT pee_accrual_has_no_schedule CHECK (
    entry_type <> 'ACCRUAL' OR (recognition_start_date IS NULL AND recognition_periods IS NULL)),
  CONSTRAINT pee_schedule_by_type CHECK (
    entry_type = 'ACCRUAL' OR (recognition_start_date IS NOT NULL AND recognition_periods IS NOT NULL)),
  -- An accrual is never "recognised" — its lifecycle is the schedule's.
  CONSTRAINT pee_accrual_stays_active CHECK (entry_type <> 'ACCRUAL' OR status = 'ACTIVE')
);
CREATE INDEX period_end_entries_period_idx
  ON period_end_entries(tenant_id, legal_entity_id, accounting_period_id);
CREATE INDEX period_end_entries_book_idx
  ON period_end_entries(accounting_book_id, status, posting_date DESC);

COMMENT ON TABLE period_end_entries IS
  'F-1004: doc 21 Phase 6 "accrual/prepaid/deferred entries". The journal is composed by '
  'DocumentPostingService under EXPENSE_ACCRUAL / PREPAID_PURCHASE / DEFERRED_REVENUE_BILLING; '
  'this row records the balance and the schedule those postings serve. An ACCRUAL''s unwind is a '
  'scheduled_reversals row (F-612) — one reversal machine, not two.';

CREATE TABLE period_end_recognitions (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id       uuid NOT NULL,
  period_end_entry_id   uuid NOT NULL,
  accounting_period_id  uuid NOT NULL,
  amount                numeric(24,8) NOT NULL CHECK (amount > 0),
  journal_entry_id      uuid NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  recognized_by         uuid REFERENCES users(id),
  recognized_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT per_entry_scope_fk  FOREIGN KEY (period_end_entry_id, legal_entity_id)
      REFERENCES period_end_entries(id, legal_entity_id) ON DELETE RESTRICT,
  CONSTRAINT per_period_scope_fk FOREIGN KEY (accounting_period_id, legal_entity_id)
      REFERENCES accounting_periods(id, legal_entity_id),
  -- The idempotency 0046 gave depreciation runs: one release per entry and
  -- period, structurally, so a rerun cannot post a second month of amortization.
  CONSTRAINT per_once_per_period UNIQUE (period_end_entry_id, accounting_period_id)
);

COMMENT ON CONSTRAINT per_once_per_period ON period_end_recognitions IS
  'F-1004: recognizePeriodEndEntry is idempotent per entry and period — the property 0046 gave '
  'depreciation runs. A rerun finds this row and posts nothing.';

-- ----------------------------------------------------------------------------
-- The balance bound, enforced where the application cannot forget it.
--
-- Deferred, like journal_entries_balanced and for the same reason: the check is
-- about the SUM across rows, and it must see the whole transaction's writes.
-- Recognising more than the entry's total would release expense or revenue that
-- was never deferred — the misstatement Gate D exists to make explainable.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_recognition_within_total()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_entry uuid;
  v_type text;
  v_total numeric(24,8);
  v_recognized numeric(24,8);
BEGIN
  v_entry := coalesce(NEW.period_end_entry_id, OLD.period_end_entry_id);
  SELECT entry_type, total_amount INTO v_type, v_total
    FROM period_end_entries WHERE id = v_entry;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_type = 'ACCRUAL' THEN
    RAISE EXCEPTION
      'RECOGNITION_ON_ACCRUAL: period-end entry % is an ACCRUAL; it unwinds through its scheduled '
      'reversal (F-612), never through a recognition row.', v_entry
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT coalesce(sum(amount), 0) INTO v_recognized
    FROM period_end_recognitions WHERE period_end_entry_id = v_entry;
  IF v_recognized > v_total THEN
    RAISE EXCEPTION
      'RECOGNITION_EXCEEDS_TOTAL: period-end entry % has recognised % against a total of %.',
      v_entry, v_recognized, v_total
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER period_end_recognitions_within_total
  AFTER INSERT OR UPDATE ON period_end_recognitions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_recognition_within_total();

-- ----------------------------------------------------------------------------
-- Row-level security — ADR-0002, same shape as 0050, registered so db:verify
-- sees both directions.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_table text;
  v_tables text[] := ARRAY['period_end_entries','period_end_recognitions'];
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', v_table);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (app_rls_bypassed() OR tenant_id = app_current_tenant()) '
      'WITH CHECK (app_rls_bypassed() OR tenant_id = app_current_tenant())',
      v_table || '_tenant_isolation', v_table);
    INSERT INTO rls_protected_tables (table_name, phase, rationale)
      VALUES (v_table, 6,
              'Phase 6 period-end entry fact (F-1004): tenant-scoped and directly readable, so '
              'ADR-0002 requires the second layer as well as the scope key.')
      ON CONFLICT (table_name) DO NOTHING;
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Gate C — the schedule is history once its journal is posted. Correcting a
-- period-end entry is done by reversal through the kernel, never by removing
-- the record that the deferral existed; without the row, the balance on the
-- balance-sheet account becomes a number no schedule explains.
-- ----------------------------------------------------------------------------
INSERT INTO schema_guard_requirements (id, statement, rationale, gate) VALUES
  ('revoke_period_end_entry_delete',
   'REVOKE DELETE ON period_end_entries, period_end_recognitions FROM app_runtime',
   'F-1004: a period-end entry and its recognitions explain the balance a control or deferral '
   'account carries. Deleting the schedule leaves the posted journals unexplained.',
   'Gate C')
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id, statement FROM schema_guard_requirements
            WHERE applied_at IS NULL ORDER BY id
  LOOP
    EXECUTE r.statement;
    UPDATE schema_guard_requirements SET applied_at = now() WHERE id = r.id;
    RAISE NOTICE 'applied schema guard %', r.id;
  END LOOP;
END $$;

-- Both halves: the revocation landed, and the working paths survived it.
DO $$
BEGIN
  IF has_table_privilege('app_runtime', 'period_end_entries', 'DELETE')
     OR has_table_privilege('app_runtime', 'period_end_recognitions', 'DELETE') THEN
    RAISE EXCEPTION 'app_runtime retains DELETE on the period-end tables (Gate C)';
  END IF;
  IF NOT has_table_privilege('app_runtime', 'period_end_entries', 'INSERT')
     OR NOT has_table_privilege('app_runtime', 'period_end_entries', 'UPDATE')
     OR NOT has_table_privilege('app_runtime', 'period_end_recognitions', 'INSERT') THEN
    RAISE EXCEPTION
      'app_runtime cannot record a period-end entry or a recognition; the revocation above took a '
      'working path with it';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- Prove the columns the trigger names exist (0036's habit): a typo inside
-- plpgsql is a runtime failure on a path nobody exercises until it matters.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_pair text;
  v_pairs text[] := ARRAY[
    'period_end_entries.entry_type',
    'period_end_entries.total_amount',
    'period_end_entries.scheduled_reversal_id',
    'period_end_recognitions.period_end_entry_id',
    'period_end_recognitions.amount',
    'scheduled_reversals.journal_entry_id'
  ];
BEGIN
  FOREACH v_pair IN ARRAY v_pairs LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name  = split_part(v_pair, '.', 1)
         AND column_name = split_part(v_pair, '.', 2)
    ) THEN
      v_missing := v_missing || v_pair;
    END IF;
  END LOOP;
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '0054 references columns that do not exist: %', array_to_string(v_missing, ', ');
  END IF;
END $$;
