-- =============================================================================
-- 0046 — depreciation_runs_posted_uq is dropped: the run was never the invariant
-- =============================================================================
-- Phase 5, exit criterion 5. The criterion has two halves, and 0013's key made
-- the second one unreachable:
--
--   (a) "Depreciation rerun is idempotent for same asset/book/period" — a
--       second run over an asset book that is already posted for the period
--       must post nothing again.
--   (b) An asset capitalized into a period that has ALREADY been run must still
--       reach a POSTED run of its own, in that same period. Month end is not an
--       instant: a late vendor bill arrives on the 3rd, the asset is
--       capitalized into the month just run, and that month's depreciation has
--       to include it. Nothing in doc 09 says a period depreciates once; it
--       says an asset depreciates once per period.
--
-- `depreciation_runs_posted_uq` is keyed
--   (legal_entity_id, accounting_book_id, accounting_period_id) WHERE status = 'POSTED'
-- with no asset anywhere in the key. So it admits exactly ONE posted run per
-- entity/book/period, and (b) is not merely hard, it is unreachable: the late
-- asset's SCHEDULED line has a charge to post and no run that can ever carry
-- it. @acct/assets had to refuse the incremental run in so many words rather
-- than let the unique violation surface as a 500 at COMMIT (the F-809 lesson) —
-- which made the refusal honest and left the capability missing.
--
-- The invariant that actually matters is not "one run per period". It is "an
-- asset book depreciates at most once per period", and that is ALREADY
-- structural without this index, in two places:
--
--   1. depreciation_schedule_lines UNIQUE (asset_book_id, accounting_period_id)
--      — at most one line per asset book per period, so a second run cannot
--      INSERT a second charge for a book the first run already charged. It is
--      also why "already posted" and "still schedulable" cannot coexist for one
--      asset book and period: there is only ever the one row.
--   2. guard_depreciation_line_posted (0043) refuses ANY update or delete of a
--      POSTED line. That closes the hole the UNIQUE cannot see (F-916): a rerun
--      does not INSERT anything — it finds the existing line and UPDATEs
--      posted_amount and journal_entry_id, and the index never fires.
--
-- Together those two hold the criterion at the grain the criterion is stated at
-- — the asset book — and they hold it against this service being bypassed
-- entirely, which is the standard 0043 set. The run-level key was a proxy for
-- the same invariant at a coarser grain: it forbids nothing those two permit,
-- and it additionally forbids a legitimate second run. It costs a real
-- capability and adds nothing.
--
-- A migration that drops one control on the strength of two others has to prove
-- those two are actually there — 0036's habit, for 0036's reason: a control
-- that is assumed rather than checked is exactly how a guard ends up
-- decorative. Both are asserted against the live catalog below, and the DROP
-- does not run if either is missing or inert. What those controls DO is proven
-- behaviourally by the guard suite (T108, T109, T118-T123), not here; this file
-- only refuses to trade away a control for two that do not exist.
-- =============================================================================

DO $$
DECLARE
  v_index    text;
  v_guard    oid;
  v_trigger  record;
BEGIN
  -- --------------------------------------------------------------------------
  -- Control 1 — one schedule line per asset book per period.
  --
  -- Located by its COLUMNS rather than by its name. The name is Postgres's own
  -- truncation of a table constraint
  -- (`depreciation_schedule_lines_asset_book_id_accounting_period_key`), and a
  -- name-based check passes happily against an index that has been rebuilt over
  -- different columns. The index must also be unique, valid, and TOTAL: a
  -- partial index would exempt precisely the rows somebody chose to exempt, and
  -- a key with extra columns in it is not this invariant.
  -- --------------------------------------------------------------------------
  SELECT c.relname INTO v_index
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = 'depreciation_schedule_lines'::regclass
     AND i.indisunique
     AND i.indisvalid
     AND i.indpred IS NULL
     AND i.indnatts = 2
     AND i.indnkeyatts = 2
     AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
            FROM pg_attribute a
           WHERE a.attrelid = i.indrelid
             AND a.attnum = ANY (i.indkey::smallint[]))
         = ARRAY['accounting_period_id', 'asset_book_id']
   LIMIT 1;

  IF v_index IS NULL THEN
    RAISE EXCEPTION
      'refusing to drop depreciation_runs_posted_uq: depreciation_schedule_lines has no total, valid UNIQUE index over exactly (asset_book_id, accounting_period_id). That index is one of the two controls this migration is trading the run-level key for; without it an asset book could be charged twice in one period.';
  END IF;

  -- --------------------------------------------------------------------------
  -- Control 2 — a POSTED schedule line is frozen (0043, F-916).
  --
  -- Presence, wiring AND enablement. A trigger that exists but is disabled
  -- (tgenabled = 'D') enforces nothing, and BEFORE UPDATE alone would leave the
  -- delete-and-reinsert path open, which is the T109 scenario.
  -- --------------------------------------------------------------------------
  v_guard := to_regproc('guard_depreciation_line_posted');
  IF v_guard IS NULL THEN
    RAISE EXCEPTION
      'refusing to drop depreciation_runs_posted_uq: guard_depreciation_line_posted() does not exist. It is the control that refuses the rerun the UNIQUE cannot see (F-916), and it is the second of the two this migration relies on.';
  END IF;

  SELECT t.tgname, t.tgenabled, t.tgtype INTO v_trigger
    FROM pg_trigger t
   WHERE t.tgrelid = 'depreciation_schedule_lines'::regclass
     AND NOT t.tgisinternal
     AND t.tgfoid = v_guard
   LIMIT 1;

  IF v_trigger IS NULL THEN
    RAISE EXCEPTION
      'refusing to drop depreciation_runs_posted_uq: guard_depreciation_line_posted() exists but no trigger on depreciation_schedule_lines calls it. A guard function nobody fires is a comment.';
  END IF;

  -- tgtype bits (pg_trigger.h): 1 = FOR EACH ROW, 2 = BEFORE, 8 = DELETE,
  -- 16 = UPDATE. All four are required: the guard reads OLD, so a statement-level
  -- or AFTER firing would be either wrong or too late.
  IF (v_trigger.tgtype & 1) = 0 OR (v_trigger.tgtype & 2) = 0
     OR (v_trigger.tgtype & 8) = 0 OR (v_trigger.tgtype & 16) = 0 THEN
    RAISE EXCEPTION
      'refusing to drop depreciation_runs_posted_uq: trigger % is not BEFORE UPDATE OR DELETE FOR EACH ROW (tgtype %), so it does not cover the rerun path it exists for.',
      v_trigger.tgname, v_trigger.tgtype;
  END IF;

  IF v_trigger.tgenabled = 'D' THEN
    RAISE EXCEPTION
      'refusing to drop depreciation_runs_posted_uq: trigger % on depreciation_schedule_lines is DISABLED.',
      v_trigger.tgname;
  END IF;

  -- The guard has to refuse with a prefix packages/database/src/errors.ts maps.
  -- An unmapped prefix reaches the caller as a 500 INTERNAL (F-809), which is
  -- indistinguishable from a crash — and a control nobody can act on is not a
  -- control this migration should be trading anything for.
  IF pg_get_functiondef(v_guard) NOT LIKE '%POSTED_IMMUTABLE%' THEN
    RAISE EXCEPTION
      'refusing to drop depreciation_runs_posted_uq: guard_depreciation_line_posted() does not raise a POSTED_IMMUTABLE-prefixed message, so its refusal would surface as a 500 (F-809).';
  END IF;

  RAISE NOTICE
    'depreciation idempotency stands on %(asset_book_id, accounting_period_id) and trigger %; dropping the run-level key.',
    v_index, v_trigger.tgname;
END $$;

-- The drop itself. Unqualified and without IF EXISTS: if 0013's index is not
-- there, this migration's premise is wrong and it should say so rather than
-- succeed quietly.
DROP INDEX depreciation_runs_posted_uq;

-- The lookup the index was also serving. `createDepreciationRun` reads
-- depreciation_runs by (legal_entity_id, accounting_book_id, accounting_period_id)
-- on every run — once to find the period's posted run, once to number the new
-- one — so the access path stays; only the uniqueness goes.
CREATE INDEX depreciation_runs_period_idx
  ON depreciation_runs(legal_entity_id, accounting_book_id, accounting_period_id);

COMMENT ON TABLE depreciation_runs IS
  'A depreciation run is a batch of schedule lines that posted together, not a period-level lock. '
  'A period may hold several POSTED runs: the month-end run, and an incremental run for each asset '
  'capitalized into that period afterwards. 0013''s depreciation_runs_posted_uq admitted only one '
  'and was dropped by 0046 — Phase 5 exit criterion 5 is "an asset book depreciates at most once '
  'per period", which depreciation_schedule_lines'' UNIQUE (asset_book_id, accounting_period_id) '
  'and guard_depreciation_line_posted (0043) already hold at that grain.';
