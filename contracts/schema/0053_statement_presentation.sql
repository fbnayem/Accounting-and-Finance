-- =============================================================================
-- 0053 — Statement presentation: the account-to-line mapping, the cash flow
--        method, and ONE definition of a reporting period window
-- =============================================================================
-- Phase 6, exit criterion 1: "Core statements tie exactly to Trial Balance."
-- 0016 built the report DEFINITION (rows, columns, versions) and 0050 made all 25
-- Phase 6 tables safe to serve. Neither made the criterion checkable, because
-- three things it depends on did not exist:
--
--   S1-A  Nothing maps an account to a statement line, and nothing detects an
--         account that maps to none. report_rows can name an account CODE RANGE
--         (`account_from`/`account_to`, two untyped text columns with no foreign
--         key) or an account group, so a mapping is a string comparison nothing
--         validates and no query can invert. There was therefore no way to ask
--         "which accounts appear on no statement line?" — and a statement that
--         silently drops an account still balances, still looks finished, and
--         ties to nothing.
--
--   S1-B  Cash flow had a classification COLUMN (accounts.cash_flow_classification,
--         0005) and nothing else: no declared method, nothing that detects an
--         account carrying no classification, no marker saying which accounts ARE
--         cash — so "beginning cash + movement = ending cash" (Gate E) summed an
--         empty set and reported 0 = 0 — and no override point at all.
--
--   S1-C  The two trial-balance sources compute their period window differently.
--         `trialBalanceFromProjection` filters by the SET of period ids the window
--         selected; `trialBalanceFromLines` filters by the ordinal RANGE
--         [first, first + count - 1]. Those are the same answer only when the
--         selected periods are contiguous in the ledger's period ordering, which
--         is a property of the seeded calendar and not of the schema — 0004 lets
--         an ADJUSTMENT period overlap any date (F-011, and deliberately so), and
--         the projection orders by (fiscal year start, period_no) rather than by
--         date on purpose. One mid-year adjustment period and the two sources read
--         different months while both look correct. §1 proves the divergence is
--         reachable and closes it.
--
-- What the Phase 6 audit got WRONG, verified against the live catalog before
-- writing a line of this file, is recorded in §7. Two of its findings were already
-- closed by 0050 and one of its two S1s was half true; a finding is a claim.
--
-- Follows 0042/0050: assert against the catalog rather than assume, register RLS
-- in `rls_protected_tables` with the both-directions closing check, and name every
-- composite foreign key `*_scope_fk` so CONSTRAINT_CODES maps it to
-- CROSS_ENTITY_REFERENCE with no error-mapping change.
--
-- Forward-only (ADR-0008).
-- =============================================================================


-- ============================================================================
-- 1. S1-C — one definition of a reporting period window.
--
-- The window is a DATE range; the ledger is ordered by (fiscal year start,
-- period_no). Those two orderings do not agree in general, and where they
-- disagree "opening + movement = closing" is not merely computed differently by
-- the two trial-balance sources — it is undefined for BOTH of them:
--
--   * the id-set form sums the movement of the selected periods, but its opening
--     is the first selected period's opening and its closing the last selected
--     period's closing, and those two bracket the periods in BETWEEN as well;
--   * the ordinal-range form silently substitutes those in-between periods for
--     the selected ones.
--
-- So the fix is not to make one form imitate the other. It is to state the
-- calendar once, flag the window on it, and refuse a window that is not a
-- contiguous run — because such a window has no trial balance to be right about.
-- Both sources then read their ids AND their ordinals from the same call, and
-- agreement is structural rather than a property of the fixture.
-- ----------------------------------------------------------------------------

-- The calendar, stated once. `ordinal` is the ledger's own ordering — the same
-- expression LedgerProjectionService.RECOMPUTE rolls its balances by, so an
-- opening balance and an "everything before the window" sum mean the same thing.
CREATE OR REPLACE FUNCTION report_period_calendar(
  p_legal_entity_id uuid,
  p_from            date DEFAULT NULL,
  p_to              date DEFAULT NULL)
RETURNS TABLE (
  accounting_period_id uuid,
  ordinal              integer,
  period_no            integer,
  is_adjustment        boolean,
  start_date           date,
  end_date             date,
  in_window            boolean)
LANGUAGE sql STABLE AS $$
  WITH calendar AS (
    SELECT p.id, p.period_no, p.is_adjustment, p.start_date, p.end_date,
           row_number() OVER (ORDER BY fy.start_date, p.period_no)::integer AS ord
      FROM accounting_periods p
      JOIN fiscal_years fy ON fy.id = p.fiscal_year_id
     WHERE p.legal_entity_id = p_legal_entity_id
  ),
  -- An omitted bound means "the whole calendar", which is what a report with no
  -- period parameters asks for. Taken from the calendar rather than from
  -- -infinity so the bounds a caller is told about are real period dates.
  bounds AS (
    SELECT coalesce(p_from, min(c.start_date)) AS win_from,
           coalesce(p_to,   max(c.end_date))   AS win_to
      FROM calendar c
  )
  SELECT c.id, c.ord, c.period_no, c.is_adjustment, c.start_date, c.end_date,
         (c.end_date >= b.win_from AND c.start_date <= b.win_to)
    FROM calendar c CROSS JOIN bounds b
   ORDER BY c.ord
$$;

COMMENT ON FUNCTION report_period_calendar(uuid, date, date) IS
  'The entity calendar in the ledger''s own period order, with the requested date window flagged. '
  'The single definition of "which periods does this report cover"; report_period_window() adds the '
  'refusal. Callers that need a validated window MUST use report_period_window().';

-- The same calendar, with the refusal.
CREATE OR REPLACE FUNCTION report_period_window(
  p_legal_entity_id uuid,
  p_from            date DEFAULT NULL,
  p_to              date DEFAULT NULL)
RETURNS TABLE (
  accounting_period_id uuid,
  ordinal              integer,
  period_no            integer,
  is_adjustment        boolean,
  start_date           date,
  end_date             date,
  in_window            boolean)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_total    integer;
  v_selected integer;
  v_first    integer;
  v_last     integer;
  v_names    text;
BEGIN
  SELECT count(*)::integer,
         count(*) FILTER (WHERE c.in_window)::integer,
         min(c.ordinal) FILTER (WHERE c.in_window),
         max(c.ordinal) FILTER (WHERE c.in_window)
    INTO v_total, v_selected, v_first, v_last
    FROM report_period_calendar(p_legal_entity_id, p_from, p_to) c;

  IF v_total = 0 THEN
    RAISE EXCEPTION
      'NO_PERIOD_FOR_DATE: this entity has no accounting periods, so there is nothing to report on.'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF v_selected = 0 THEN
    RAISE EXCEPTION
      'NO_PERIOD_FOR_DATE: no accounting period falls between % and %.',
      coalesce(p_from::text, '(start of calendar)'), coalesce(p_to::text, '(end of calendar)')
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- The whole point. A selection of n periods spanning ordinals first..last is a
  -- reportable window only when n = last - first + 1; otherwise the ledger places
  -- periods BETWEEN the selected ones that the window excludes, and no opening
  -- balance, movement and closing balance over that set are consistent with each
  -- other. Naming the intruders, because "discontiguous" is not actionable and the
  -- cause is almost always one adjustment period the caller forgot exists.
  IF v_selected <> v_last - v_first + 1 THEN
    SELECT string_agg(p.name, ', ' ORDER BY c.ordinal)
      INTO v_names
      FROM report_period_calendar(p_legal_entity_id, p_from, p_to) c
      JOIN accounting_periods p ON p.id = c.accounting_period_id
     WHERE NOT c.in_window AND c.ordinal BETWEEN v_first AND v_last;
    RAISE EXCEPTION
      'REPORT_WINDOW_DISCONTIGUOUS: the dates % to % select % period(s) that the ledger orders '
      'either side of %, which the window excludes. Opening balance, movement and closing balance '
      'have no consistent meaning over that set. Widen the window to include them, or report the '
      'periods separately.',
      coalesce(p_from::text, '(start of calendar)'), coalesce(p_to::text, '(end of calendar)'),
      v_selected, v_names
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN QUERY SELECT * FROM report_period_calendar(p_legal_entity_id, p_from, p_to);
END $$;

COMMENT ON FUNCTION report_period_window(uuid, date, date) IS
  'S1-C: the validated reporting window. Both trial-balance sources take their period ids AND their '
  'ordinal bounds from this one call, so the set form and the range form cannot disagree — and a '
  'window over which they WOULD disagree is refused rather than answered differently twice.';

-- What a caller actually needs in one row: the id set for a projection read, the
-- ordinal bounds for a journal-line read, and the resolved dates to echo back.
-- Deriving both from report_period_window() is what makes "by construction" true:
-- there is no second query for the two forms to drift between.
CREATE OR REPLACE FUNCTION report_period_window_bounds(
  p_legal_entity_id uuid,
  p_from            date DEFAULT NULL,
  p_to              date DEFAULT NULL)
RETURNS TABLE (
  period_ids     uuid[],
  first_ordinal  integer,
  last_ordinal   integer,
  period_from    date,
  period_to      date)
LANGUAGE sql STABLE AS $$
  SELECT array_agg(w.accounting_period_id ORDER BY w.ordinal) FILTER (WHERE w.in_window),
         min(w.ordinal) FILTER (WHERE w.in_window),
         max(w.ordinal) FILTER (WHERE w.in_window),
         min(w.start_date) FILTER (WHERE w.in_window),
         max(w.end_date)   FILTER (WHERE w.in_window)
    FROM report_period_window(p_legal_entity_id, p_from, p_to) w
$$;


-- ============================================================================
-- 2. S1-A — the account-to-statement-line mapping, and the detection.
--
-- report_rows.account_from / account_to are text CODES with no foreign key: a
-- range that matches nothing renders an empty line, a range that overlaps another
-- renders the account twice, and neither is answerable by a query. The mapping is
-- therefore stated as rows over ACCOUNT IDS, one per account per definition —
-- which makes three things true that the range form cannot make true at all:
--
--   * an account appears on AT MOST one line (the uniqueness below), so a
--     statement cannot double-count;
--   * "which accounts appear on no statement line?" is a NOT EXISTS, so the
--     omission is detectable; and
--   * deliberately leaving an account off a statement is a RECORDED decision with
--     a reason, not an absence indistinguishable from an oversight.
--
-- The last is the reason for the nullable report_row_id: coverage means every
-- account has a decision, not that every account is on a line.
-- ----------------------------------------------------------------------------

-- The key the mapping is referenced BY. report_rows had only its surrogate key, so
-- a mapping could name a row of a DIFFERENT definition and the statement would
-- render a number under someone else's heading.
ALTER TABLE report_rows
  ADD CONSTRAINT rr_definition_uq UNIQUE (id, report_definition_id);

CREATE TABLE statement_account_mappings (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  report_definition_id uuid NOT NULL,
  -- No bare foreign key, like every Phase 5 and Phase 6 fact: the entity is pinned
  -- by the composite keys below, which say the stronger thing — that the account
  -- belongs to the SAME entity the mapping claims, and that entity to the same
  -- tenant as the definition.
  legal_entity_id      uuid NOT NULL,
  account_id           uuid NOT NULL,
  -- Null ONLY for a deliberate exclusion, which must say why.
  report_row_id        uuid,
  exclusion_reason     text,
  created_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),

  -- One decision per account per definition. This is what makes "ties exactly"
  -- provable: an account cannot be counted on two lines, and a total is the sum
  -- of a partition rather than of an arbitrary cover.
  CONSTRAINT sam_account_uq UNIQUE (report_definition_id, account_id),
  -- NULL-safe on both sides, and negative-tested both ways: a row with neither a
  -- line nor a reason is the silent omission this table exists to prevent, and a
  -- row with both is a line pretending to be an exclusion. btrim() because an
  -- empty string is an absent reason wearing a NOT NULL.
  CONSTRAINT sam_line_xor_exclusion CHECK (
    (report_row_id IS NOT NULL AND exclusion_reason IS NULL)
    OR (report_row_id IS NULL AND exclusion_reason IS NOT NULL AND btrim(exclusion_reason) <> '')),
  CONSTRAINT sam_definition_scope_fk FOREIGN KEY (report_definition_id, tenant_id)
    REFERENCES report_definitions(id, tenant_id),
  CONSTRAINT sam_row_scope_fk FOREIGN KEY (report_row_id, report_definition_id)
    REFERENCES report_rows(id, report_definition_id),
  CONSTRAINT sam_account_scope_fk FOREIGN KEY (account_id, legal_entity_id)
    REFERENCES accounts(id, legal_entity_id),
  CONSTRAINT sam_entity_scope_fk FOREIGN KEY (legal_entity_id, tenant_id)
    REFERENCES legal_entities(id, tenant_id)
);
CREATE INDEX statement_account_mappings_row_idx
  ON statement_account_mappings(report_row_id) WHERE report_row_id IS NOT NULL;

COMMENT ON TABLE statement_account_mappings IS
  'S1-A: which statement line an account rolls up to, or the recorded reason it appears on none. '
  'The unique key is what makes a statement total the sum of a partition of the chart rather than '
  'of whatever the code ranges happened to cover.';

-- The definition's own scope, which no composite key can express: a definition
-- scoped to an entity accepts only that entity's accounts, and an ORGANIZATION-WIDE
-- template (report_definitions.legal_entity_id IS NULL, 0016) accepts any account of
-- an entity in that organization and nothing else. Written as two explicit branches
-- because the NULL case is the one a single comparison would let through.
CREATE OR REPLACE FUNCTION assert_statement_mapping_in_scope()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d record;
BEGIN
  SELECT r.legal_entity_id, r.organization_id INTO d
    FROM report_definitions r WHERE r.id = NEW.report_definition_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'CROSS_ENTITY_REFERENCE: report definition % does not exist, so this mapping has no statement '
      'to belong to.', NEW.report_definition_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF d.legal_entity_id IS NOT NULL AND d.legal_entity_id <> NEW.legal_entity_id THEN
    RAISE EXCEPTION
      'CROSS_ENTITY_REFERENCE: this report definition is scoped to entity %, so it cannot present '
      'an account of entity %.', d.legal_entity_id, NEW.legal_entity_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF d.legal_entity_id IS NULL AND NOT EXISTS (
       SELECT 1 FROM legal_entities e
        WHERE e.id = NEW.legal_entity_id AND e.organization_id = d.organization_id) THEN
    RAISE EXCEPTION
      'CROSS_ENTITY_REFERENCE: entity % is not part of organization %, whose template this is.',
      NEW.legal_entity_id, d.organization_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER statement_account_mappings_in_scope
  BEFORE INSERT OR UPDATE ON statement_account_mappings
  FOR EACH ROW EXECUTE FUNCTION assert_statement_mapping_in_scope();

-- Which account types a core statement is responsible for. Stated once, because
-- the detection, the refusal and any future renderer must agree about the domain
-- — "a criterion proved on part of its domain is proved on none of it".
-- CASH_FLOW is deliberately empty here: its coverage is the classification in §3,
-- not a line mapping. CUSTOM and TRIAL_BALANCE are empty because neither claims to
-- present the whole chart, and that is exactly why they are not core statements.
CREATE OR REPLACE FUNCTION statement_account_domain(p_report_type text)
RETURNS account_type[] LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_report_type
           WHEN 'PROFIT_LOSS'   THEN ARRAY['REVENUE','EXPENSE']::account_type[]
           WHEN 'BALANCE_SHEET' THEN ARRAY['ASSET','LIABILITY','EQUITY']::account_type[]
           ELSE ARRAY[]::account_type[]
         END
$$;

-- "Which accounts appear on no statement line?", answered.
CREATE OR REPLACE FUNCTION statement_unmapped_accounts(
  p_report_definition_id uuid,
  p_legal_entity_ids     uuid[] DEFAULT NULL)
RETURNS TABLE (
  legal_entity_id uuid,
  account_id      uuid,
  account_code    text,
  account_name    text,
  account_type    account_type)
LANGUAGE sql STABLE AS $$
  SELECT a.legal_entity_id, a.id, a.code, a.name, a.account_type
    FROM report_definitions d
    JOIN legal_entities e
      ON e.organization_id = d.organization_id
     AND (d.legal_entity_id IS NULL OR e.id = d.legal_entity_id)
     AND (p_legal_entity_ids IS NULL OR e.id = ANY (p_legal_entity_ids))
    JOIN accounts a ON a.legal_entity_id = e.id
   WHERE d.id = p_report_definition_id
     -- Postable and active: a heading account carries no balance and an archived
     -- one carries no future balance, so requiring a line for either would make
     -- the control noisy enough to be turned off, which is how controls die.
     AND a.is_posting AND a.status = 'ACTIVE'
     AND a.account_type = ANY (statement_account_domain(d.report_type))
     AND NOT EXISTS (
           SELECT 1 FROM statement_account_mappings m
            WHERE m.report_definition_id = d.id AND m.account_id = a.id)
   ORDER BY a.legal_entity_id, a.code
$$;


-- ============================================================================
-- 3. S1-B — cash flow: the method, the complete classification, the cash marker
--           and the override point.
--
-- doc 12: "Initial method can use configured account/cash-flow classification plus
-- derived cash movements. Support operating/investing/financing classification and
-- controlled overrides. Later support indirect/direct presentation variants by
-- market need."
--
-- That is the DIRECT method, and the choice is the spec's rather than this
-- migration's: the required initial method derives the movements of cash itself
-- and classifies them by the configured classification of the accounts on the
-- other side of each entry. The indirect method is a different statement built
-- from different facts — net profit plus non-cash adjustments plus working-capital
-- movements — and needs schema this does not add (a non-cash marker per account
-- and a working-capital section per balance-sheet line). It is named in the spec
-- as a LATER variant, so `cash_flow_method` records which one a definition claims
-- and the issue guard in §4 refuses INDIRECT rather than quietly rendering direct
-- figures under an indirect heading. A registered intention is not an executed one.
--
-- What the direct method needs, and what was missing:
--   * which accounts ARE cash — without it "beginning cash + movement = ending
--     cash" (Gate E) sums an empty set and reports 0 = 0, the exact shape of a
--     gate that reports success about something it never measured;
--   * a classification on every other account, and a way to find the ones that
--     have none;
--   * a controlled override, because an account's usual classification is wrong
--     for particular entries (a fixed-asset purchase settled through a payables
--     account, an interest element inside a lease payment).
-- ----------------------------------------------------------------------------

-- 0005 gave accounts a cash_flow_classification and no way to say which of them
-- IS cash. bank_accounts.gl_account_id names some of them, but cash on hand, undeposited
-- funds and cash equivalents are not bank accounts, so the register is not the answer.
ALTER TABLE accounts
  ADD COLUMN is_cash_equivalent boolean NOT NULL DEFAULT false;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_cash_equivalent_is_asset
    CHECK (NOT is_cash_equivalent OR account_type = 'ASSET');

COMMENT ON COLUMN accounts.is_cash_equivalent IS
  'Gate E: the accounts whose movement IS the cash flow statement. Without it the criterion '
  '"beginning cash + movement = ending cash" had no subject and summed nothing.';

-- doc 12: "Later support indirect/direct presentation variants." A definition must
-- SAY which it is, and only a cash flow definition may say anything at all.
ALTER TABLE report_definitions
  ADD COLUMN cash_flow_method text
    CHECK (cash_flow_method IN ('DIRECT','INDIRECT'));

-- Gate A: "migrations apply forward on empty and representative populated
-- databases." An existing cash flow definition predates the column, and the method
-- it was rendered by is not a guess — doc 12 names the classification-driven direct
-- method as the initial one, and §4 refuses to issue anything else, so DIRECT is
-- the only value consistent with what such a definition can already have produced.
UPDATE report_definitions
   SET cash_flow_method = 'DIRECT'
 WHERE report_type = 'CASH_FLOW' AND cash_flow_method IS NULL;

ALTER TABLE report_definitions
  ADD CONSTRAINT rd_cash_flow_method_present
    CHECK ((report_type = 'CASH_FLOW') = (cash_flow_method IS NOT NULL));

-- ------------------------------------------------------------------ override --
-- The override is a separate fact rather than a column on journal_lines, and that
-- is not a convenience: a posted journal line is immutable (0006), so a column on
-- it could only ever be written at posting time, by whoever posted — which is the
-- one person a controlled override should not be decided by alone, and the one
-- moment the classification is least likely to be known.
CREATE TABLE cash_flow_overrides (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL,
  -- One answer per line. Two overrides would make the derivation ambiguous, and an
  -- ambiguous classification is indistinguishable from none at the point it matters.
  journal_line_id uuid NOT NULL UNIQUE,
  classification  text NOT NULL
    CHECK (classification IN ('OPERATING','INVESTING','FINANCING','NONE')),
  reason          text NOT NULL,
  -- NOT NULL, and negative-tested: `created_by` is the whole difference between a
  -- controlled override and an anonymous edit, and a nullable actor column is how
  -- that difference disappears.
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cfo_reason_present CHECK (btrim(reason) <> ''),
  CONSTRAINT cfo_line_scope_fk FOREIGN KEY (journal_line_id, legal_entity_id)
    REFERENCES journal_lines(id, legal_entity_id),
  CONSTRAINT cfo_entity_scope_fk FOREIGN KEY (legal_entity_id, tenant_id)
    REFERENCES legal_entities(id, tenant_id)
);

COMMENT ON TABLE cash_flow_overrides IS
  'doc 12 "controlled overrides": the classification of one journal line, with a reason and an '
  'actor. DELETE is revoked from app_runtime (§6) because an override changed what an issued '
  'statement said, and removing it would leave the statement unexplainable.';

-- An override on a CASH line is meaningless and dangerous: the cash lines ARE the
-- movement being classified, so classifying one would count the same cash twice —
-- once as the movement and once as its own explanation.
CREATE OR REPLACE FUNCTION assert_cash_flow_override_target()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v record;
BEGIN
  SELECT a.code, a.name, a.is_cash_equivalent INTO v
    FROM journal_lines l JOIN accounts a ON a.id = l.account_id
   WHERE l.id = NEW.journal_line_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'CASH_FLOW_OVERRIDE_INVALID: journal line % does not exist, so there is nothing to classify.',
      NEW.journal_line_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v.is_cash_equivalent THEN
    RAISE EXCEPTION
      'CASH_FLOW_OVERRIDE_INVALID: account % (%) is cash, and a cash line IS the movement a cash flow '
      'statement classifies. Override the line on the other side of the entry instead.',
      v.code, v.name USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER cash_flow_overrides_target
  BEFORE INSERT OR UPDATE ON cash_flow_overrides
  FOR EACH ROW EXECUTE FUNCTION assert_cash_flow_override_target();

-- --------------------------------------------------------------- derivation --
-- The classification actually applied to a line: the override if there is one,
-- otherwise the account's configured classification, otherwise nothing. Stated as
-- a function so the statement, the detection and any drill-down give one answer.
CREATE OR REPLACE FUNCTION cash_flow_line_classification(p_journal_line_id uuid)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(o.classification, a.cash_flow_classification)
    FROM journal_lines l
    JOIN accounts a ON a.id = l.account_id
    LEFT JOIN cash_flow_overrides o ON o.journal_line_id = l.id
   WHERE l.id = p_journal_line_id
$$;

-- Accounts that could carry a cash flow classification and do not. Cash accounts
-- are excluded because their own classification is never read: they are the
-- movement, not its explanation.
CREATE OR REPLACE FUNCTION cash_flow_unclassified_accounts(p_legal_entity_ids uuid[] DEFAULT NULL)
RETURNS TABLE (
  legal_entity_id uuid,
  account_id      uuid,
  account_code    text,
  account_name    text,
  account_type    account_type)
LANGUAGE sql STABLE AS $$
  SELECT a.legal_entity_id, a.id, a.code, a.name, a.account_type
    FROM accounts a
   WHERE (p_legal_entity_ids IS NULL OR a.legal_entity_id = ANY (p_legal_entity_ids))
     AND a.is_posting AND a.status = 'ACTIVE'
     AND NOT a.is_cash_equivalent
     AND a.cash_flow_classification IS NULL
   ORDER BY a.legal_entity_id, a.code
$$;

-- The statement itself, by the direct method.
--
-- For every entry that touched cash inside the window, the movement of cash is
-- explained by the entry's OTHER lines: an entry balances, so the signed sum of
-- the non-cash lines equals the signed movement of the cash lines exactly. Each of
-- those lines carries its own classification, so the three sections sum to the
-- cash movement by construction rather than by a reconciling plug — which is what
-- makes Gate E's "beginning cash + movement = ending cash" checkable rather than
-- asserted. A transfer between two cash accounts has no non-cash line and
-- therefore contributes nothing, which is correct: it moved no cash in or out.
CREATE OR REPLACE FUNCTION cash_flow_statement(
  p_accounting_book_id uuid,
  p_from               date DEFAULT NULL,
  p_to                 date DEFAULT NULL)
RETURNS TABLE (classification text, amount numeric)
LANGUAGE plpgsql STABLE AS $$
DECLARE v_entity uuid;
BEGIN
  SELECT b.legal_entity_id INTO v_entity
    FROM accounting_books b WHERE b.id = p_accounting_book_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accounting book % does not exist', p_accounting_book_id
      USING ERRCODE = 'no_data_found';
  END IF;

  RETURN QUERY
  WITH win AS (
    SELECT w.accounting_period_id
      FROM report_period_window(v_entity, p_from, p_to) w
     WHERE w.in_window
  ),
  cash_entries AS (
    SELECT DISTINCT l.journal_entry_id
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.journal_entry_id
      JOIN accounts a ON a.id = l.account_id
      JOIN win ON win.accounting_period_id = l.accounting_period_id
     WHERE l.accounting_book_id = p_accounting_book_id
       -- REVERSED counts, for the reason projection.service.ts gives: the original
       -- lines are never deleted and the reversal is a separate entry, so excluding
       -- REVERSED would leave every reversed movement counted once, backwards.
       AND e.status IN ('POSTED', 'REVERSED')
       AND a.is_cash_equivalent
  ),
  counterparts AS (
    SELECT coalesce(o.classification, a.cash_flow_classification, 'UNCLASSIFIED') AS cls,
           l.base_credit - l.base_debit AS amount
      FROM journal_lines l
      JOIN cash_entries ce ON ce.journal_entry_id = l.journal_entry_id
      JOIN accounts a ON a.id = l.account_id
      LEFT JOIN cash_flow_overrides o ON o.journal_line_id = l.id
     WHERE NOT a.is_cash_equivalent
  )
  SELECT c.cls, sum(c.amount) FROM counterparts c GROUP BY c.cls ORDER BY c.cls;
END $$;

-- Gate E, as one row. Every component is returned, including the two that must be
-- zero, because a control that reports only its verdict cannot be debugged and a
-- verdict with nothing behind it is the thing this codebase keeps finding.
CREATE OR REPLACE FUNCTION cash_flow_reconciliation(
  p_accounting_book_id uuid,
  p_from               date DEFAULT NULL,
  p_to                 date DEFAULT NULL)
RETURNS TABLE (
  opening_cash       numeric,
  operating          numeric,
  investing          numeric,
  financing          numeric,
  unsectioned        numeric,
  unclassified       numeric,
  movement           numeric,
  closing_cash       numeric,
  cash_account_count integer,
  ties               boolean)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_entity  uuid;
  v_first   integer;
  v_last    integer;
  v_open    numeric := 0;
  v_close   numeric := 0;
  v_move    numeric := 0;
  v_op      numeric := 0;
  v_inv     numeric := 0;
  v_fin     numeric := 0;
  v_none    numeric := 0;
  v_unc     numeric := 0;
  v_cash    integer := 0;
BEGIN
  SELECT b.legal_entity_id INTO v_entity
    FROM accounting_books b WHERE b.id = p_accounting_book_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'accounting book % does not exist', p_accounting_book_id
      USING ERRCODE = 'no_data_found';
  END IF;

  SELECT b.first_ordinal, b.last_ordinal INTO v_first, v_last
    FROM report_period_window_bounds(v_entity, p_from, p_to) b;

  SELECT count(*)::integer INTO v_cash
    FROM accounts a
   WHERE a.legal_entity_id = v_entity AND a.is_cash_equivalent AND a.status = 'ACTIVE';

  -- Opening is everything the ledger orders BEFORE the window and closing everything
  -- up to and including its last period — the same two brackets the trial balance
  -- uses, taken from the same validated window, so the cash flow statement and the
  -- trial balance cannot disagree about which months they are describing.
  SELECT coalesce(sum(l.base_debit - l.base_credit) FILTER (WHERE c.ordinal <  v_first), 0),
         coalesce(sum(l.base_debit - l.base_credit) FILTER (WHERE c.ordinal <= v_last),  0),
         coalesce(sum(l.base_debit - l.base_credit)
                  FILTER (WHERE c.ordinal >= v_first AND c.ordinal <= v_last), 0)
    INTO v_open, v_close, v_move
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.journal_entry_id
    JOIN accounts a ON a.id = l.account_id
    JOIN report_period_calendar(v_entity, p_from, p_to) c
      ON c.accounting_period_id = l.accounting_period_id
   WHERE l.accounting_book_id = p_accounting_book_id
     AND e.status IN ('POSTED', 'REVERSED')
     AND a.is_cash_equivalent;

  SELECT coalesce(sum(s.amount) FILTER (WHERE s.classification = 'OPERATING'), 0),
         coalesce(sum(s.amount) FILTER (WHERE s.classification = 'INVESTING'), 0),
         coalesce(sum(s.amount) FILTER (WHERE s.classification = 'FINANCING'), 0),
         coalesce(sum(s.amount) FILTER (WHERE s.classification = 'NONE'), 0),
         coalesce(sum(s.amount) FILTER (WHERE s.classification = 'UNCLASSIFIED'), 0)
    INTO v_op, v_inv, v_fin, v_none, v_unc
    FROM cash_flow_statement(p_accounting_book_id, p_from, p_to) s;

  RETURN QUERY SELECT
    v_open, v_op, v_inv, v_fin, v_none, v_unc, v_move, v_close, v_cash,
    -- All five conditions, because any one of them alone is satisfiable by an
    -- entity with no cash accounts at all:
    --   the three sections must explain the whole movement (nothing unclassified,
    --   nothing parked in NONE that actually moved cash), the movement must carry
    --   opening to closing, and there must BE cash accounts for any of it to mean
    --   something.
    (v_cash > 0
     AND v_unc = 0
     AND v_none = 0
     AND v_op + v_inv + v_fin = v_move
     AND v_open + v_move = v_close);
END $$;

COMMENT ON FUNCTION cash_flow_reconciliation(uuid, date, date) IS
  'Gate E: "Cash Flow reconciles beginning cash + movement = ending cash." `ties` is false when the '
  'entity has no cash accounts, so the criterion cannot be satisfied by measuring nothing.';


-- ============================================================================
-- 4. The refusal, at the point a statement becomes a fact.
--
-- doc 12: a financial snapshot is what was ISSUED — the immutable metadata of an
-- approved statement. It is therefore the one place where "a statement run must
-- refuse rather than quietly omit" can be enforced structurally, whichever service
-- or job or import wrote it.
--
-- Every branch below refuses on ABSENCE as well as on disagreement — a snapshot
-- with no definition, a consolidated snapshot whose group has no members at the
-- period, a cash flow snapshot for an entity with no cash accounts. Those are the
-- cases where a check written the obvious way passes because there was nothing to
-- compare.
-- ----------------------------------------------------------------------------

-- snapshot_type was free text with no constraint at all, which made every guard
-- below evadable by spelling: 'P&L' is not 'PROFIT_LOSS', and a snapshot typed
-- that way would sail past a coverage check that looks for core statements.
--
-- An existing row with an unrecognised type is refused rather than rewritten, for
-- 0050's reason about audit_evidence: guessing which statement a snapshot was would
-- put a value on an IMMUTABLE accounting fact that nobody chose.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(DISTINCT s.snapshot_type, ', ') INTO bad
    FROM financial_snapshots s
   WHERE s.snapshot_type NOT IN
     ('PROFIT_LOSS','BALANCE_SHEET','CASH_FLOW','TRIAL_BALANCE','CUSTOM');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION
      'financial_snapshots carries snapshot_type value(s) this migration does not recognise: %. A '
      'snapshot is immutable, so its type cannot be corrected here. Decide what those statements '
      'were and reissue them before re-running this migration.', bad;
  END IF;
END $$;

ALTER TABLE financial_snapshots
  ADD CONSTRAINT fs_snapshot_type_known CHECK (snapshot_type IN
    ('PROFIT_LOSS','BALANCE_SHEET','CASH_FLOW','TRIAL_BALANCE','CUSTOM'));

CREATE OR REPLACE FUNCTION assert_statement_snapshot_complete()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_entities uuid[];
  v_period   record;
  v_def      record;
  v_missing  text;
  v_count    integer;
BEGIN
  IF NEW.snapshot_type NOT IN ('PROFIT_LOSS','BALANCE_SHEET','CASH_FLOW') THEN
    RETURN NEW;
  END IF;

  SELECT p.start_date, p.end_date INTO v_period
    FROM accounting_periods p WHERE p.id = NEW.accounting_period_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'STATEMENT_COVERAGE_INCOMPLETE: accounting period % does not exist.', NEW.accounting_period_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- The entities this statement claims to present. A consolidated snapshot has a
  -- group instead of an entity (0016), and the group is the half that spans
  -- entities — so it is the half a check written for the simple case skips.
  IF NEW.legal_entity_id IS NOT NULL THEN
    v_entities := ARRAY[NEW.legal_entity_id];
  ELSE
    SELECT array_agg(g.legal_entity_id) INTO v_entities
      FROM consolidation_group_entities g
     WHERE g.consolidation_group_id = NEW.consolidation_group_id
       AND g.valid_from <= v_period.end_date
       AND (g.valid_to IS NULL OR g.valid_to > v_period.end_date);
  END IF;
  IF v_entities IS NULL OR cardinality(v_entities) = 0 THEN
    RAISE EXCEPTION
      'STATEMENT_COVERAGE_INCOMPLETE: this snapshot presents no entity — a consolidation group with '
      'no member at % cannot be the subject of a statement, and issuing one would tie to nothing.',
      v_period.end_date
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- A core statement without a definition has no lines, so it has no mapping, so
  -- nothing can say which accounts it dropped. 0016 left report_definition_id
  -- nullable for TRIAL_BALANCE and CUSTOM runs; those returned above.
  IF NEW.report_definition_id IS NULL THEN
    RAISE EXCEPTION
      'STATEMENT_COVERAGE_INCOMPLETE: a % snapshot must name the report definition version it was '
      'rendered from (doc 12), otherwise nothing records which accounts it presented.',
      NEW.snapshot_type
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT d.report_type, d.cash_flow_method, d.code, d.version INTO v_def
    FROM report_definitions d WHERE d.id = NEW.report_definition_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'STATEMENT_COVERAGE_INCOMPLETE: report definition % does not exist.', NEW.report_definition_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF v_def.report_type <> NEW.snapshot_type THEN
    RAISE EXCEPTION
      'STATEMENT_COVERAGE_INCOMPLETE: this snapshot calls itself % but definition % v% renders a %. '
      'A statement issued under the wrong definition is checked against the wrong rules.',
      NEW.snapshot_type, v_def.code, v_def.version, v_def.report_type
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.snapshot_type IN ('PROFIT_LOSS','BALANCE_SHEET') THEN
    SELECT string_agg(u.account_code, ', ' ORDER BY u.account_code), count(*)::integer
      INTO v_missing, v_count
      FROM statement_unmapped_accounts(NEW.report_definition_id, v_entities) u;
    IF v_count > 0 THEN
      RAISE EXCEPTION
        'STATEMENT_COVERAGE_INCOMPLETE: % account(s) roll up to no line of definition % v% and would '
        'be dropped from this %: %. Map each to a statement line, or record the reason it belongs on '
        'none.',
        v_count, v_def.code, v_def.version, NEW.snapshot_type, v_missing
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- CASH_FLOW. IS DISTINCT FROM, not <>: rd_cash_flow_method_present makes a null
  -- method impossible on a CASH_FLOW definition today, and `<> 'DIRECT'` against a
  -- null would be NULL, which an IF treats as false — the same shape as the
  -- vacuous maker/checker CHECK 0049 had to replace.
  IF v_def.cash_flow_method IS DISTINCT FROM 'DIRECT' THEN
    RAISE EXCEPTION
      'CASH_FLOW_METHOD_UNSUPPORTED: definition % v% claims the % method. doc 12 makes the '
      'classification-driven DIRECT method the initial one and indirect/direct presentation '
      'variants a later addition; nothing renders an indirect statement yet, so issuing one would '
      'publish direct figures under an indirect heading.',
      v_def.code, v_def.version, v_def.cash_flow_method
      USING ERRCODE = 'feature_not_supported';
  END IF;

  SELECT count(*)::integer INTO v_count
    FROM accounts a
   WHERE a.legal_entity_id = ANY (v_entities) AND a.is_cash_equivalent AND a.status = 'ACTIVE';
  IF v_count = 0 THEN
    RAISE EXCEPTION
      'CASH_FLOW_NO_CASH_ACCOUNT: no account of this entity is marked as cash or a cash equivalent, '
      'so "beginning cash + movement = ending cash" would be computed over nothing and reported as '
      'balanced. Set accounts.is_cash_equivalent on the cash accounts first.'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT string_agg(u.account_code, ', ' ORDER BY u.account_code), count(*)::integer
    INTO v_missing, v_count
    FROM cash_flow_unclassified_accounts(v_entities) u;
  IF v_count > 0 THEN
    RAISE EXCEPTION
      'CASH_FLOW_UNCLASSIFIED: % account(s) carry no operating/investing/financing classification, '
      'so any cash they moved would fall outside all three sections and the statement would not tie: '
      '%. Classify each account, or override the lines that differ from it.',
      v_count, v_missing
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER financial_snapshots_coverage
  BEFORE INSERT ON financial_snapshots
  FOR EACH ROW EXECUTE FUNCTION assert_statement_snapshot_complete();

-- "Which accounts appear on no statement line?" as a standing question rather than
-- a function call, so a close dashboard or an auditor can ask it without knowing
-- which definitions exist. security_invoker because a view over RLS-protected
-- tables otherwise runs as its OWNER — the migrator — and would hand every tenant
-- every other tenant's chart of accounts through a reporting convenience.
CREATE VIEW statement_coverage_gaps WITH (security_invoker = true) AS
  SELECT d.tenant_id,
         d.id             AS report_definition_id,
         d.code           AS report_code,
         d.version        AS report_version,
         d.report_type,
         g.legal_entity_id,
         g.account_id,
         g.account_code,
         g.account_name,
         g.account_type,
         'NO_STATEMENT_LINE'::text AS gap
    FROM report_definitions d
    CROSS JOIN LATERAL statement_unmapped_accounts(d.id) g
   WHERE d.status = 'ACTIVE'
  UNION ALL
  SELECT a.tenant_id, NULL::uuid, NULL::text, NULL::integer, 'CASH_FLOW'::text,
         c.legal_entity_id, c.account_id, c.account_code, c.account_name, c.account_type,
         'NO_CASH_FLOW_CLASSIFICATION'::text
    FROM cash_flow_unclassified_accounts() c
    JOIN accounts a ON a.id = c.account_id;

COMMENT ON VIEW statement_coverage_gaps IS
  'S1-A/S1-B: every account that would be silently dropped from a core statement — no line on an '
  'active definition, or no cash flow classification. Empty is the only acceptable state before a '
  'period is closed.';


-- ============================================================================
-- 5. Row-level security on the two new tables (ADR-0002, F-914).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_table text;
  v_tables text[] := ARRAY['statement_account_mappings','cash_flow_overrides'];
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
              'Phase 6 statement presentation: what an account is presented as, and the controlled '
              'override of a line''s cash flow classification. Tenant-scoped and directly readable, '
              'so ADR-0002 requires the second layer as well as the scope key.')
      ON CONFLICT (table_name) DO NOTHING;
  END LOOP;
END $$;

-- Both directions, asserted here as well as in db:verify, so this migration cannot
-- install a registry that disagrees with what it just did (0029's habit, 0050's
-- repetition).
DO $$
DECLARE problem text;
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


-- ============================================================================
-- 6. Gate C — the privilege half, and the read paths that must survive it.
-- ----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION report_period_calendar(uuid, date, date)             FROM PUBLIC;
REVOKE ALL ON FUNCTION report_period_window(uuid, date, date)               FROM PUBLIC;
REVOKE ALL ON FUNCTION report_period_window_bounds(uuid, date, date)        FROM PUBLIC;
REVOKE ALL ON FUNCTION statement_account_domain(text)                       FROM PUBLIC;
REVOKE ALL ON FUNCTION statement_unmapped_accounts(uuid, uuid[])            FROM PUBLIC;
REVOKE ALL ON FUNCTION cash_flow_line_classification(uuid)                  FROM PUBLIC;
REVOKE ALL ON FUNCTION cash_flow_unclassified_accounts(uuid[])              FROM PUBLIC;
REVOKE ALL ON FUNCTION cash_flow_statement(uuid, date, date)                FROM PUBLIC;
REVOKE ALL ON FUNCTION cash_flow_reconciliation(uuid, date, date)           FROM PUBLIC;

INSERT INTO schema_guard_requirements (id, statement, rationale, gate) VALUES
  ('revoke_cash_flow_override_delete',
   'REVOKE DELETE ON cash_flow_overrides FROM app_runtime',
   'doc 12 "controlled overrides": an override changed which section an issued statement showed a '
   'cash movement in. Deleting it makes that statement unexplainable, which is the same failure '
   'Gate E''s snapshot immutability exists to prevent. A wrong override is corrected in place, and '
   'the reason column is NOT NULL, so a correction has to restate why.',
   'Gate C'),
  ('revoke_statement_mapping_truncate',
   'REVOKE TRUNCATE ON statement_account_mappings FROM app_runtime',
   'A mapping is configuration and must stay editable row by row, so DELETE stays. TRUNCATE does '
   'not: it removes an entire definition''s coverage in one statement and fires no row trigger. '
   '0025''s ALTER DEFAULT PRIVILEGES grants only SELECT/INSERT/UPDATE/DELETE, so app_runtime does '
   'not hold TRUNCATE today — this registers that as a checked property rather than an accident of '
   'the default, and db:verify reads the catalog for it on every run.',
   'Gate C'),
  ('grant_statement_presentation_execute',
   'GRANT EXECUTE ON FUNCTION report_period_calendar(uuid, date, date), '
   'report_period_window(uuid, date, date), report_period_window_bounds(uuid, date, date), '
   'statement_account_domain(text), statement_unmapped_accounts(uuid, uuid[]), '
   'cash_flow_line_classification(uuid), cash_flow_unclassified_accounts(uuid[]), '
   'cash_flow_statement(uuid, date, date), cash_flow_reconciliation(uuid, date, date) TO app_runtime',
   'Without EXECUTE the application cannot resolve a reporting window, detect an unmapped account '
   'or render a cash flow statement at all — and financial_snapshots_coverage would then refuse '
   'every core statement, which is a control that refuses everything rather than a control.',
   'Gate C')
ON CONFLICT (id) DO NOTHING;

-- Registered AND executed, by the `applied_at IS NULL` sweep 0043 introduced after
-- the audit found 0038 registering two revocations and executing neither.
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

-- Asserted against the catalog, not against the statements above. Both halves: a
-- revocation that also took the working path with it would leave every core
-- statement unissuable, and a control that only refuses is indistinguishable from
-- one that refuses everything.
DO $$
BEGIN
  IF has_table_privilege('app_runtime', 'cash_flow_overrides', 'DELETE')
     OR has_table_privilege('app_runtime', 'statement_account_mappings', 'TRUNCATE') THEN
    RAISE EXCEPTION 'app_runtime retains a Phase 6 statement privilege Gate C requires be revoked';
  END IF;

  IF NOT has_table_privilege('app_runtime', 'cash_flow_overrides', 'INSERT')
     OR NOT has_table_privilege('app_runtime', 'cash_flow_overrides', 'UPDATE')
     OR NOT has_table_privilege('app_runtime', 'cash_flow_overrides', 'SELECT')
     OR NOT has_table_privilege('app_runtime', 'statement_account_mappings', 'INSERT')
     OR NOT has_table_privilege('app_runtime', 'statement_account_mappings', 'UPDATE')
     OR NOT has_table_privilege('app_runtime', 'statement_account_mappings', 'DELETE')
     OR NOT has_table_privilege('app_runtime', 'statement_account_mappings', 'SELECT') THEN
    RAISE EXCEPTION
      'app_runtime cannot record a statement mapping or a cash flow override; the revocations above '
      'took a working path with them';
  END IF;

  IF NOT has_function_privilege('app_runtime', 'report_period_window(uuid,date,date)', 'EXECUTE')
     OR NOT has_function_privilege('app_runtime',
            'report_period_window_bounds(uuid,date,date)', 'EXECUTE')
     OR NOT has_function_privilege('app_runtime',
            'statement_unmapped_accounts(uuid,uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('app_runtime', 'cash_flow_statement(uuid,date,date)', 'EXECUTE')
     OR NOT has_function_privilege('app_runtime',
            'cash_flow_reconciliation(uuid,date,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'app_runtime cannot render a core financial statement; §6 revoked too much';
  END IF;
END $$;


-- ============================================================================
-- 7. Asserted against the live catalog, and what the audit got wrong.
--
-- Two of the audit's four findings for this task were already closed by 0050 and
-- were verified against the catalog rather than taken on trust:
--
--   "financial_snapshots has no uniqueness"      — FALSE as of 0050. `fs_identity_uq`
--       is a UNIQUE NULLS NOT DISTINCT over (tenant, entity, group, book, period,
--       snapshot_type, version) and is present in pg_constraint.
--   "nothing verifies content_hash"              — FALSE as of 0050. The BEFORE INSERT
--       trigger `financial_snapshots_content_hash` recomputes it from the payload
--       through financial_snapshot_content_hash(jsonb) and refuses any other value;
--       UPDATE and DELETE are refused by `financial_snapshots_immutable` and by the
--       revocation `revoke_financial_snapshot_mutation`.
--   What 0050 does NOT cover, and this migration deliberately does not change
--       because the function signature is granted and in use: the hash is taken over
--       `payload` alone, not over `parameters`, `ledger_cutoff_at` or
--       `report_definition_id`. Those columns are protected by immutability and
--       privilege rather than by the hash, so the snapshot is provably unchanged but
--       only its payload is provably self-describing.
--
--   "nothing maps an account to a statement line" — TRUE in effect, imprecise as
--       stated: report_rows CAN name an account code RANGE or a group, so a mapping
--       of a kind existed. It has no foreign key, no uniqueness and no inverse, so
--       no query could name the accounts it missed — which is the half the criterion
--       needs and the half §2 adds.
--   "cash flow has no ... classification"        — HALF TRUE: accounts.cash_flow_classification
--       has existed since 0005 with the right four values. What did not exist is
--       anything that detects an account without one, anything that says which
--       accounts are cash, a declared method, or an override point.
-- ----------------------------------------------------------------------------
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(x.name, ', ') INTO missing FROM (
    SELECT n AS name FROM unnest(ARRAY[
      'report_period_calendar','report_period_window','report_period_window_bounds',
      'statement_account_domain','statement_unmapped_accounts','cash_flow_line_classification',
      'cash_flow_unclassified_accounts','cash_flow_statement','cash_flow_reconciliation',
      'assert_statement_mapping_in_scope','assert_cash_flow_override_target',
      'assert_statement_snapshot_complete']) AS n
     WHERE to_regproc(n) IS NULL
  ) x;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0053 did not create: %', missing;
  END IF;

  IF to_regclass('statement_account_mappings') IS NULL
     OR to_regclass('cash_flow_overrides') IS NULL
     OR to_regclass('statement_coverage_gaps') IS NULL THEN
    RAISE EXCEPTION '0053 did not create its tables or the coverage view';
  END IF;

  -- The view is the one object whose default behaviour is a tenant leak, so it is
  -- checked by the catalog rather than by the CREATE above having said so.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
     WHERE c.oid = 'statement_coverage_gaps'::regclass
       AND c.reloptions @> ARRAY['security_invoker=true'])
  THEN
    RAISE EXCEPTION
      'statement_coverage_gaps is not security_invoker, so it would read the chart of accounts as '
      'its owner and bypass every tenant policy underneath it';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'financial_snapshots'::regclass
                    AND tgname = 'financial_snapshots_coverage' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'the statement coverage refusal is not attached to financial_snapshots';
  END IF;

  -- 0050's two controls, re-asserted here because §7 claims they are already in
  -- force and a claim about the catalog belongs in the catalog.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'financial_snapshots'::regclass AND conname = 'fs_identity_uq') THEN
    RAISE EXCEPTION 'fs_identity_uq is gone; a statement can be issued twice under one version again';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'financial_snapshots'::regclass
                    AND tgname = 'financial_snapshots_content_hash' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'the snapshot content hash is no longer verified against its payload';
  END IF;
END $$;

COMMENT ON CONSTRAINT sam_account_uq ON statement_account_mappings IS
  'Phase 6 exit criterion 1: an account rolls up to at most ONE line, so a statement total is the '
  'sum of a partition of the chart. Without it two overlapping code ranges double-count an account '
  'and the statement still balances.';
COMMENT ON CONSTRAINT rd_cash_flow_method_present ON report_definitions IS
  'doc 12: a cash flow definition must declare its method and nothing else may. Stated as an '
  'equality of two never-null predicates so neither half is satisfied by a NULL.';
COMMENT ON CONSTRAINT fs_snapshot_type_known ON financial_snapshots IS
  'snapshot_type was free text, so every coverage guard on it was evadable by spelling.';
