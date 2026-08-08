-- =============================================================================
-- 0029 — Ledger runtime: scope, versions, scheduled reversals, ledger RLS
-- =============================================================================
-- Phase 2. Everything here was found by building the accounting kernel against
-- 0005/0006 rather than by reading them, which is why none of it is a rewrite of
-- those files: they are correct about what they cover.
--
--   F-612  Scheduled reversal cannot be a column on journal_entries. 0006's
--          immutability trigger permits exactly one UPDATE on a POSTED entry
--          (POSTED -> REVERSED, accounting facts unchanged), so a
--          `scheduled_reversal_date` on the entry could be set only before
--          posting and never cancelled afterwards. It is a separate aggregate.
--   F-615  journal_line_dimensions pins its dimension and value to a legal
--          entity but not its LINE, so entity B's cost centre could be attached
--          to entity A's posted line. Same class as F-003, one level down.
--   F-616  Five ledger tables carry no tenant_id, so 0024-style row-level
--          security could not be extended to them at all.
--   F-617  `accounts` and `journal_entries` have no version column, yet the
--          contract gives PATCH /accounts/{id} and PATCH /journals/{id} an
--          If-Match parameter. Optimistic concurrency had nothing to compare.
--
-- Plus two guards doc 03 states as chart rules and nothing enforced:
-- non-posting accounts cannot receive lines, and an account's type cannot change
-- once it has been posted to.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. F-616 — tenant_id on the ledger tables that lacked it.
--
-- Added nullable, backfilled from the parent, then made NOT NULL, so the
-- migration is correct on a populated database as well as an empty one (Gate A:
-- "migrations apply forward on empty and representative populated databases").
-- ----------------------------------------------------------------------------
ALTER TABLE account_book_settings          ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE account_dimension_rules        ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE journal_line_dimensions        ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE recurring_journal_occurrences  ADD COLUMN tenant_id uuid REFERENCES tenants(id);
ALTER TABLE ledger_account_balances        ADD COLUMN tenant_id uuid REFERENCES tenants(id);

UPDATE account_book_settings s SET tenant_id = a.tenant_id
  FROM accounts a WHERE a.id = s.account_id AND s.tenant_id IS NULL;
UPDATE account_dimension_rules r SET tenant_id = a.tenant_id
  FROM accounts a WHERE a.id = r.account_id AND r.tenant_id IS NULL;
UPDATE journal_line_dimensions d SET tenant_id = l.tenant_id
  FROM journal_lines l WHERE l.id = d.journal_line_id AND d.tenant_id IS NULL;
UPDATE recurring_journal_occurrences o SET tenant_id = t.tenant_id
  FROM recurring_journal_templates t WHERE t.id = o.template_id AND o.tenant_id IS NULL;
UPDATE ledger_account_balances b SET tenant_id = a.tenant_id
  FROM accounts a WHERE a.id = b.account_id AND b.tenant_id IS NULL;

ALTER TABLE account_book_settings          ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE account_dimension_rules        ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE journal_line_dimensions        ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE recurring_journal_occurrences  ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE ledger_account_balances        ALTER COLUMN tenant_id SET NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. F-615 — a line's dimensions must belong to the line's own entity.
--
-- 0005 constrains journal_line_dimensions.dimension_id and dimension_value_id to
-- (id, legal_entity_id) but leaves journal_line_id an unqualified reference, so
-- the row's own legal_entity_id was free to disagree with its line's. The line is
-- posted and immutable by then; the dimension is what every dimensional report
-- groups by, so the effect is entity A's costs appearing under entity B's cost
-- centre in a report that reconciles perfectly to the trial balance.
-- ----------------------------------------------------------------------------
ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_scope_uq UNIQUE (id, legal_entity_id);

ALTER TABLE journal_line_dimensions
  ADD CONSTRAINT jld_line_scope_fk
  FOREIGN KEY (journal_line_id, legal_entity_id) REFERENCES journal_lines(id, legal_entity_id);

COMMENT ON CONSTRAINT jld_line_scope_fk ON journal_line_dimensions IS
  'F-615: the dimension value and the line it annotates must belong to the same legal entity. '
  'Without it a cross-entity dimension survives every balance check, because it moves no money.';

-- The projection's book and period were likewise unpinned: a row could claim a
-- book belonging to one entity and a period belonging to another and still
-- satisfy lab_account_scope_fk.
ALTER TABLE ledger_account_balances
  ADD CONSTRAINT lab_book_scope_fk
    FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id),
  ADD CONSTRAINT lab_period_scope_fk
    FOREIGN KEY (accounting_period_id, legal_entity_id) REFERENCES accounting_periods(id, legal_entity_id);

-- account_dimension_rules.default_value_id had no scope either, so a DEFAULTED
-- rule could default to another entity's dimension value — and step 9 of doc 03's
-- posting algorithm would then insert it.
ALTER TABLE account_dimension_rules
  ADD CONSTRAINT adr_default_scope_fk
    FOREIGN KEY (default_value_id, legal_entity_id) REFERENCES dimension_values(id, legal_entity_id);

-- ----------------------------------------------------------------------------
-- 3. F-617 — optimistic concurrency for the two PATCH routes.
--
-- `version` is deliberately absent from the frozen column list in 0006's
-- guard_journal_entry_immutable(), so marking a POSTED entry REVERSED can still
-- bump it. It is not an accounting fact.
-- ----------------------------------------------------------------------------
ALTER TABLE accounts         ADD COLUMN version bigint NOT NULL DEFAULT 1;
ALTER TABLE journal_entries  ADD COLUMN version bigint NOT NULL DEFAULT 1;

-- ----------------------------------------------------------------------------
-- 4. F-612 — scheduled reversals.
--
-- doc 03: "Scheduled reversal queues a future draft/post request and still obeys
-- period status at execution." Obeying period status *at execution* is the whole
-- point: an accrual scheduled in June to reverse in July must fail loudly if July
-- has been closed by then, not post into it regardless. So the schedule stores
-- intent only, and the worker runs it through the ordinary posting service.
-- ----------------------------------------------------------------------------
CREATE TABLE scheduled_reversals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id     uuid NOT NULL,
  accounting_book_id  uuid NOT NULL,
  journal_entry_id    uuid NOT NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
  scheduled_date      date NOT NULL,
  reason              text NOT NULL,
  status              text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','EXECUTED','CANCELLED','FAILED')),
  attempts            integer NOT NULL DEFAULT 0,
  last_error          text,
  executed_at         timestamptz,
  reversal_entry_id   uuid REFERENCES journal_entries(id),
  cancelled_at        timestamptz,
  cancelled_by        uuid REFERENCES users(id),
  cancel_reason       text,
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sr_book_scope_fk
    FOREIGN KEY (accounting_book_id, legal_entity_id) REFERENCES accounting_books(id, legal_entity_id),
  CONSTRAINT sr_executed_has_entry
    CHECK (status <> 'EXECUTED' OR reversal_entry_id IS NOT NULL),
  CONSTRAINT sr_cancelled_has_reason
    CHECK (status <> 'CANCELLED' OR cancel_reason IS NOT NULL)
);
-- Two pending schedules on one entry would reverse it twice, and the second
-- reversal would balance perfectly — which is what makes it hard to notice.
CREATE UNIQUE INDEX scheduled_reversals_one_pending_idx
  ON scheduled_reversals(journal_entry_id) WHERE status = 'PENDING';
CREATE INDEX scheduled_reversals_due_idx
  ON scheduled_reversals(scheduled_date, id) WHERE status = 'PENDING';

COMMENT ON TABLE scheduled_reversals IS
  'F-612: doc 03 requires scheduled reversal. It cannot be a column on journal_entries because '
  '0006 freezes posted entries; a schedule that could not be cancelled after posting would be worse '
  'than none.';

-- ----------------------------------------------------------------------------
-- 5. Chart rules doc 03 states and nothing enforced.
--
-- "Parent/reporting accounts cannot receive journal lines if non-posting" and
-- "type change after posting requires controlled migration". Both are in the
-- posting service too; both are here because 0006's opening line is right —
-- application code is not a control.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_line_account_postable()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_code       text;
  v_is_posting boolean;
  v_status     record_status;
BEGIN
  SELECT code, is_posting, status INTO v_code, v_is_posting, v_status
    FROM accounts WHERE id = NEW.account_id;

  IF NOT v_is_posting THEN
    RAISE EXCEPTION
      'ACCOUNT_NOT_POSTABLE: account % is a heading, not a posting account (doc 03).', v_code
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_status <> 'ACTIVE' THEN
    RAISE EXCEPTION
      'ACCOUNT_NOT_POSTABLE: account % is %; a used account is archived, not deleted, and an '
      'archived account accepts no new lines (doc 03).', v_code, v_status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER journal_lines_account_postable
  BEFORE INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION assert_line_account_postable();

CREATE OR REPLACE FUNCTION guard_account_type_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_type IS DISTINCT FROM OLD.account_type
     OR NEW.normal_balance IS DISTINCT FROM OLD.normal_balance THEN
    IF EXISTS (SELECT 1 FROM journal_lines WHERE account_id = OLD.id) THEN
      RAISE EXCEPTION
        'ACCOUNT_TYPE_LOCKED: account % has posted lines; changing its type or normal balance '
        'would restate every period it appears in (doc 03: "type change after posting requires '
        'controlled migration").', OLD.code
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER accounts_type_locked
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION guard_account_type_change();

-- ----------------------------------------------------------------------------
-- 6. Row-level security across the rest of the ledger.
--
-- 0024 covered journal_entries and journal_lines. Everything a ledger read joins
-- to is now covered as well, on the same terms: FORCE, and a NULL app.tenant_id
-- denies. The chart is not less sensitive than the journals — an account list
-- names a competitor's cost structure — and the projection table holds every
-- balance in the tenant.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'account_groups', 'accounts', 'account_book_settings', 'account_dimension_rules',
    'dimensions', 'dimension_values', 'journals', 'posting_rule_versions',
    'journal_line_dimensions', 'document_line_dimensions',
    'recurring_journal_templates', 'recurring_journal_occurrences',
    'ledger_account_balances', 'opening_balance_sets', 'scheduled_reversals'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (app_rls_bypassed() OR tenant_id = app_current_tenant()) '
      'WITH CHECK (app_rls_bypassed() OR tenant_id = app_current_tenant())',
      t || '_tenant_isolation', t
    );
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 6b. F-618 — the RLS coverage check was a hardcoded list of six.
--
-- `pnpm db:verify` asserted row-level security on exactly the six tables 0024
-- named, written out again in TypeScript. Extending the sweep therefore left the
-- check passing while testing a third of what it claimed, and a Phase 3 table
-- added without a policy would never have been noticed at all — the same shape of
-- decay the guard suite had before its `via` clause.
--
-- The requirement moves into the database, next to schema_guard_requirements, and
-- the check reads it in both directions: every registered table must be protected,
-- and every protected table must be registered.
-- ----------------------------------------------------------------------------
CREATE TABLE rls_protected_tables (
  table_name  text PRIMARY KEY,
  phase       integer NOT NULL,
  rationale   text NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO rls_protected_tables (table_name, phase, rationale) VALUES
  ('journal_entries',             1, 'ADR-0002: the highest-value tables carry RLS as a second layer.'),
  ('journal_lines',               1, 'ADR-0002.'),
  ('invoices',                    1, 'ADR-0002.'),
  ('vendor_bills',                1, 'ADR-0002.'),
  ('contacts',                    1, 'ADR-0002.'),
  ('files',                       1, 'ADR-0002; F-048 also scopes the storage key.'),
  ('account_groups',              2, 'The reporting hierarchy names a tenant''s cost structure.'),
  ('accounts',                    2, 'A chart of accounts is commercially sensitive on its own.'),
  ('account_book_settings',       2, 'Book-level overrides of the chart.'),
  ('account_dimension_rules',     2, 'Reachable directly, not only through accounts.'),
  ('dimensions',                  2, 'Cost centres and projects name internal structure.'),
  ('dimension_values',            2, 'As above.'),
  ('journals',                    2, 'Journal definitions.'),
  ('posting_rule_versions',       2, 'A posting rule is the tenant''s accounting policy in data.'),
  ('journal_line_dimensions',     2, 'Every dimensional report reads this directly.'),
  ('document_line_dimensions',    2, 'Source-document half of the same data (F-009).'),
  ('recurring_journal_templates', 2, 'Contains line templates with account ids.'),
  ('recurring_journal_occurrences', 2, 'Generation history.'),
  ('ledger_account_balances',     2, 'Every balance in the tenant, in one table.'),
  ('opening_balance_sets',        2, 'The tenant''s entire opening position.'),
  ('scheduled_reversals',         2, 'Pending intent against posted entries.');

COMMENT ON TABLE rls_protected_tables IS
  'F-618: which tables must have row-level security ENABLED and FORCED. `pnpm db:verify` reads this '
  'and the catalog and fails on a difference in either direction, so a new tenant-scoped table '
  'cannot be added without either a policy or a deliberate decision not to have one.';

-- Both directions, asserted here as well so the migration itself cannot install a
-- registry that disagrees with what it just did.
DO $$
DECLARE
  problem text;
BEGIN
  SELECT string_agg(t.table_name, ', ') INTO problem
    FROM rls_protected_tables t
    LEFT JOIN pg_class c ON c.relname = t.table_name AND c.relkind = 'r'
   WHERE c.oid IS NULL OR NOT c.relrowsecurity OR NOT c.relforcerowsecurity;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'registered for RLS but not enabled and forced: %', problem;
  END IF;

  SELECT string_agg(c.relname, ', ') INTO problem
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    LEFT JOIN rls_protected_tables t ON t.table_name = c.relname
   WHERE c.relkind = 'r' AND c.relrowsecurity AND t.table_name IS NULL;
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'row-level security is enabled but the table is not registered: %', problem;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 7. Privileges for the tables this migration created.
--
-- 0025's ALTER DEFAULT PRIVILEGES covers new tables created by the same role, but
-- saying so is not the same as checking it. The projection is rebuildable by
-- definition, so unlike journal_lines it must remain deletable.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT has_table_privilege('app_runtime', 'scheduled_reversals', 'INSERT')
     OR NOT has_table_privilege('app_runtime', 'ledger_account_balances', 'DELETE') THEN
    RAISE EXCEPTION
      'app_runtime is missing privileges on the Phase 2 tables; ALTER DEFAULT PRIVILEGES did not apply';
  END IF;
  IF has_table_privilege('app_runtime', 'journal_line_dimensions', 'UPDATE')
     OR has_table_privilege('app_runtime', 'journal_line_dimensions', 'DELETE') THEN
    RAISE EXCEPTION 'app_runtime can mutate journal_line_dimensions; 0006 requires it be revoked';
  END IF;
END $$;

COMMENT ON COLUMN ledger_account_balances.tenant_id IS
  'F-616: added in 0029 so row-level security could cover the projection. Without it the one table '
  'holding every balance in the tenant was the one table RLS could not reach.';
