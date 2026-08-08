-- =============================================================================
-- 0037 — A filed tax return is immutable in the direction it can actually change
-- =============================================================================
-- F-719. 0008 says, in its own comment, "A FILED return is an immutable snapshot;
-- doc 07 forbids silently rewriting it" — and then attaches the guard to DELETE
-- only. Nobody deletes a tax return; the way a filed return gets rewritten is an
-- UPDATE, which was permitted. The comment described a control the trigger did
-- not implement, which is the same shape as F-619 and F-621: a guard that exists,
-- is believed, and does nothing on the path that matters.
--
-- doc 07's machine is OPEN -> PREPARING -> READY -> FILED -> AMENDED. So FILED is
-- not fully frozen: it has exactly one legal successor, and reaching it is how a
-- correction is recorded rather than made. Everything else about the row — the
-- snapshot it was filed on, the reference the authority gave it, who prepared and
-- approved it, the period and form it covers — is a filed fact.
--
-- Forward-only (ADR-0008): 0008 is applied, so the DELETE trigger stays and this
-- adds the UPDATE half beside it.
-- =============================================================================

CREATE OR REPLACE FUNCTION guard_filed_return_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'FILED' THEN
    RETURN NEW;
  END IF;

  -- The one permitted transition. `amends_return_id` on the *successor* is what
  -- links the two; this row only changes status.
  IF NEW.status = 'AMENDED'
     AND NEW.id                      IS NOT DISTINCT FROM OLD.id
     AND NEW.tenant_id               IS NOT DISTINCT FROM OLD.tenant_id
     AND NEW.legal_entity_id         IS NOT DISTINCT FROM OLD.legal_entity_id
     AND NEW.tax_period_id           IS NOT DISTINCT FROM OLD.tax_period_id
     AND NEW.form_code               IS NOT DISTINCT FROM OLD.form_code
     AND NEW.version                 IS NOT DISTINCT FROM OLD.version
     AND NEW.prepared_by             IS NOT DISTINCT FROM OLD.prepared_by
     AND NEW.approved_by             IS NOT DISTINCT FROM OLD.approved_by
     AND NEW.filed_at                IS NOT DISTINCT FROM OLD.filed_at
     AND NEW.filing_reference        IS NOT DISTINCT FROM OLD.filing_reference
     AND NEW.filing_evidence_file_id IS NOT DISTINCT FROM OLD.filing_evidence_file_id
     AND NEW.snapshot                IS NOT DISTINCT FROM OLD.snapshot
     AND NEW.localization_version_id IS NOT DISTINCT FROM OLD.localization_version_id
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'POSTED_IMMUTABLE: tax return % is FILED. A filed return is corrected by filing an '
    'amendment (a new return with amends_return_id), which moves this one to AMENDED and '
    'changes nothing else about it (doc 07).',
    OLD.id
    USING ERRCODE = 'restrict_violation';
END $$;

COMMENT ON FUNCTION guard_filed_return_immutable() IS
  'F-719. doc 07: a FILED return is an immutable snapshot with exactly one legal '
  'successor, AMENDED. 0008 guarded DELETE only, which is not how a return gets rewritten.';

CREATE TRIGGER tax_returns_filed_update_immutable
  BEFORE UPDATE ON tax_returns
  FOR EACH ROW EXECUTE FUNCTION guard_filed_return_immutable();

-- The named columns are read from the row type rather than from a string, so a
-- renamed column is a migration-time error here rather than a silent hole. This
-- block asserts the same thing 0036 asserts about its own frozen-column lists:
-- that every name the guard depends on still exists.
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(c, ', ') INTO v_missing
    FROM unnest(ARRAY[
      'id','tenant_id','legal_entity_id','tax_period_id','form_code','version','status',
      'prepared_by','approved_by','filed_at','filing_reference','filing_evidence_file_id',
      'snapshot','localization_version_id'
    ]) AS c
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tax_returns' AND column_name = c
   );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'guard_filed_return_immutable references columns that do not exist: %',
      v_missing;
  END IF;
END $$;
