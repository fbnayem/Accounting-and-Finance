-- =============================================================================
-- 0049 — The approval threshold and maker/checker become controls
-- =============================================================================
-- The worst finding of the Phase 6 audit, and it is in SHIPPED Phase 2/3 code.
--
-- `accounting_policies.journal_approval_threshold` has existed since 0003. It is
-- writable through POST /accounting-policies, it persists, it is read by
-- `PostingService.loadBookContext` into `BookContext.journalApprovalThreshold`
-- — and before this migration it was compared to nothing, anywhere. A tenant
-- could set it, watch it come back on the next GET, and receive no enforcement
-- whatsoever. Phase 6's exit criterion is "Approval bypass attempts fail at
-- API/domain layer"; there was nothing to bypass, because posting without
-- approval was the default and only path.
--
-- Three things are wrong and all three are fixed here.
--
--   1. The threshold enforced nowhere. A service check alone is not enough:
--      `commitPosting` is today's single writer, but a control that lives only
--      in the writer is bypassed by the next path that forgets it, and F-106
--      says a check outside the writing transaction is a race rather than a
--      guard. So the rule is stated twice — once in the service, once here as a
--      DEFERRABLE INITIALLY DEFERRED constraint trigger that fires at COMMIT of
--      the very transaction that writes the journal, after its lines exist.
--
--   2. Maker/checker stated but not expressible. `JournalService.approve`
--      refuses self-approval in TypeScript; the database had no opinion.
--      `vendor_bills` could not have an opinion at all — it has no preparer
--      column, so "the approver is not the preparer" was not a sentence the
--      table could form. `invoices` had a preparer and no approver.
--
--   3. Maker/checker CHECKs that go vacuous. `payment_runs.pr_maker_checker`
--      read `approved_by IS NULL OR approved_by <> created_by`. With a NULL
--      created_by that comparison is NULL, and a CHECK that evaluates to NULL
--      PASSES. The control was decorative for exactly the rows where the
--      preparer is unknown — which is the case where it matters most. Every
--      CHECK added below is written so an unknown preparer REFUSES the
--      approval rather than waving it through.
--
-- -----------------------------------------------------------------------------
-- What is deliberately NOT here
-- -----------------------------------------------------------------------------
-- The Phase 6 approval ENGINE: versioned workflow definitions, serial/parallel
-- steps, delegation, escalation, the task inbox. `approval_workflows`,
-- `approval_requests` and `approval_steps` (0017) stay unused by this migration.
-- The engine decides WHO must approve and by what route. This migration only
-- makes the answer to "was it approved, and by someone else?" a precondition of
-- POSTED, which is the part that was missing and the part the exit criterion
-- names. When the engine lands it fills `journal_entries.approved_by` through
-- its own decision path and this guard keeps holding without change.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. Maker/checker on the journal, NULL-safe.
--
-- `created_by` is the preparer and `approved_by` the checker (0005). The
-- constraint says: an approval may be recorded only when the preparer is KNOWN
-- and is a different person. The `created_by IS NOT NULL` half is the whole
-- point — without it, an entry with no recorded preparer accepts any approver,
-- including the one who wrote it, and does so silently.
--
-- Unconditional rather than threshold-conditional: "the approver is not the
-- preparer" is true of every approval, not only expensive ones.
-- ----------------------------------------------------------------------------
ALTER TABLE journal_entries
  ADD CONSTRAINT je_maker_checker
  CHECK (approved_by IS NULL OR (created_by IS NOT NULL AND approved_by <> created_by));

COMMENT ON CONSTRAINT je_maker_checker ON journal_entries IS
  'Gate F segregation of duties. NULL-safe on purpose: `approved_by <> created_by` alone is NULL '
  'when the preparer is unknown, and a NULL CHECK passes — the vacuous-control failure this '
  'codebase keeps meeting. An unknown preparer refuses the approval instead.';

-- ----------------------------------------------------------------------------
-- 2. The threshold, enforced at COMMIT of the posting transaction.
--
-- Deferred for the reason `journal_entries_balanced` is deferred: the amount of
-- a journal is an aggregate over child rows that do not all exist yet when the
-- header is written. An immediate trigger would read zero lines on the
-- subledger path (header inserted, lines written after) and pass everything.
--
-- Deferred, not external: it fires inside the transaction that writes the
-- journal, so there is no window between "checked" and "written" for a
-- concurrent policy change or a second connection to slip through. F-106.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_journal_approval()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_threshold numeric(24,8);
  v_amount    numeric(24,8);
  v_original  uuid;
BEGIN
  -- Drafts, submissions and approvals are all free. Only POSTED is the fact the
  -- threshold is about, and REVERSED is only ever reached from POSTED.
  IF NEW.status <> 'POSTED' THEN
    RETURN NULL;
  END IF;

  -- The same effective-dated resolution `PostingService.loadBookContext` uses:
  -- a book-specific policy beats the entity default, latest version wins, and
  -- the policy in force is the one covering the POSTING DATE rather than today.
  -- A journal back-dated into a period governed by a different policy version is
  -- judged by that version, which is doc 01 rule 7.
  SELECT ap.journal_approval_threshold
    INTO v_threshold
    FROM accounting_books b
    JOIN accounting_policies ap
      ON ap.legal_entity_id = b.legal_entity_id
     AND (ap.accounting_book_id = b.id OR ap.accounting_book_id IS NULL)
     AND ap.valid_from <= NEW.posting_date
     AND (ap.valid_to IS NULL OR ap.valid_to > NEW.posting_date)
   WHERE b.id = NEW.accounting_book_id
   ORDER BY ap.accounting_book_id NULLS LAST, ap.version DESC
   LIMIT 1;

  -- No policy, or a policy that leaves the column NULL, means the tenant has not
  -- asked for journal approval. NULL is the shipped default and it must stay the
  -- permissive answer, or this migration would stop every ledger in the estate.
  IF v_threshold IS NULL THEN
    RETURN NULL;
  END IF;

  -- The journal's absolute value. `greatest` rather than the debit side alone
  -- because trigger firing order among deferred constraint triggers is not
  -- something to depend on: if `journal_entries_balanced` has not run yet the
  -- two sides may still differ, and the larger of them is the honest figure to
  -- judge. Both are non-negative by 0005's line CHECKs; abs() costs nothing and
  -- removes the assumption.
  SELECT abs(greatest(coalesce(sum(base_debit), 0), coalesce(sum(base_credit), 0)))
    INTO v_amount
    FROM journal_lines
   WHERE journal_entry_id = NEW.id;

  IF coalesce(v_amount, 0) < v_threshold THEN
    RETURN NULL;                       -- under the threshold: no approval needed
  END IF;

  -- An approval on record. je_maker_checker has already proved it came from
  -- someone other than a known preparer — it is an immediate CHECK, so it fired
  -- when the column was written, long before this deferred trigger runs.
  IF NEW.approved_by IS NOT NULL THEN
    RETURN NULL;
  END IF;

  -- A reversal is the sanctioned undo of an entry that already passed this gate
  -- (doc 01 rule 4: posted history is corrected by reversal, never by editing),
  -- and no route approves a reversal — it is created and posted in one command.
  -- Demanding a second approval would trap every approved journal in the ledger
  -- forever.
  --
  -- The exemption is narrow on purpose. `reversal_of_id` is a plain column the
  -- application role can write, so "it says it is a reversal" is not evidence.
  -- It counts only when the entry named actually CARRIES an approval: a large
  -- entry claiming to reverse a small unapproved one is still refused, which is
  -- the shape any bypass through this door would have to take.
  IF NEW.reversal_of_id IS NOT NULL THEN
    SELECT approved_by INTO v_original
      FROM journal_entries WHERE id = NEW.reversal_of_id;
    IF v_original IS NOT NULL THEN
      RETURN NULL;
    END IF;
  END IF;

  -- The message names the amount AND the threshold, because AppError.details is
  -- log-only: a caller who has to act on this refusal learns nothing from a code
  -- alone. "Your journal is 25000.00 and the limit is 10000.00" is actionable;
  -- "approval required" is not.
  RAISE EXCEPTION
    'APPROVAL_REQUIRED: journal % totals % %, at or above this book''s journal approval '
    'threshold of %. It cannot post until an approval is recorded on it '
    '(journal_entries.approved_by) by someone other than the person who prepared it.',
    coalesce(NEW.entry_number, NEW.id::text), v_amount, NEW.base_currency, v_threshold
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE CONSTRAINT TRIGGER journal_entries_approval_threshold
  AFTER INSERT OR UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_approval();

COMMENT ON FUNCTION assert_journal_approval() IS
  'The threshold in accounting_policies.journal_approval_threshold, which had been read into every '
  'posting context since Phase 2 and compared to nothing. Deferred so it sees the lines, and a '
  'constraint trigger rather than an application check so a second posting path cannot forget it.';

-- ----------------------------------------------------------------------------
-- 3. An approval, once posted, is not editable.
--
-- 0006 permits exactly one UPDATE on a POSTED entry — POSTED -> REVERSED with
-- the accounting facts unchanged — and lists the frozen columns explicitly.
-- `created_by`, `approved_by` and `approved_at` were not on that list, so the
-- one permitted statement could also rewrite who approved a posted journal, or
-- erase the approval entirely. An approval that can be rewritten afterwards is
-- not a record of anything. Same function, three more columns in the frozen row.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION guard_journal_entry_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('POSTED','REVERSED') THEN
      RAISE EXCEPTION
        'POSTED_IMMUTABLE: journal_entries % is % and cannot be deleted. Use reversal (doc 01 rule 4).',
        OLD.id, OLD.status USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status IN ('POSTED','REVERSED') THEN
    IF NOT (OLD.status = 'POSTED' AND NEW.status = 'REVERSED') THEN
      RAISE EXCEPTION
        'POSTED_IMMUTABLE: journal_entries % is %; the only permitted change is POSTED -> REVERSED.',
        OLD.id, OLD.status USING ERRCODE = 'restrict_violation';
    END IF;
    IF ROW(NEW.tenant_id, NEW.legal_entity_id, NEW.accounting_book_id, NEW.journal_id,
           NEW.accounting_period_id, NEW.branch_id, NEW.entry_number, NEW.posting_date,
           NEW.document_date, NEW.source_type, NEW.source_id, NEW.source_event_id,
           NEW.posting_rule_version_id, NEW.base_currency, NEW.posted_at, NEW.posted_by,
           NEW.created_by, NEW.approved_by, NEW.approved_at)
       IS DISTINCT FROM
       ROW(OLD.tenant_id, OLD.legal_entity_id, OLD.accounting_book_id, OLD.journal_id,
           OLD.accounting_period_id, OLD.branch_id, OLD.entry_number, OLD.posting_date,
           OLD.document_date, OLD.source_type, OLD.source_id, OLD.source_event_id,
           OLD.posting_rule_version_id, OLD.base_currency, OLD.posted_at, OLD.posted_by,
           OLD.created_by, OLD.approved_by, OLD.approved_at)
    THEN
      RAISE EXCEPTION
        'POSTED_IMMUTABLE: journal_entries % - accounting facts cannot change when marking REVERSED.',
        OLD.id USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ----------------------------------------------------------------------------
-- 4. The preparer column `vendor_bills` never had, and an approver for both
--    documents the audit names.
--
-- `AP.approveVendorBill` and `AR.approveInvoice` have existed since Phase 3 and
-- recorded no approver at all — they flipped a status and published an event
-- whose payload said `approved_by`, which was the only place that fact was ever
-- written down. There was nothing to compare a preparer against, and on
-- `vendor_bills` there was no preparer either.
--
-- Nullable, because both tables are populated: an existing bill has no preparer
-- and never will, and back-filling one would be inventing an actor. The
-- consequence is deliberate and is the NULL-safe rule doing its job — an old
-- bill with an unknown preparer cannot now be approved, because nothing can
-- prove the approver is a different person.
-- ----------------------------------------------------------------------------
ALTER TABLE invoices
  ADD COLUMN approved_by uuid REFERENCES users(id),
  ADD COLUMN approved_at timestamptz;

ALTER TABLE invoices
  ADD CONSTRAINT invoices_approval_recorded
    CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  ADD CONSTRAINT invoices_maker_checker
    CHECK (approved_by IS NULL OR (created_by IS NOT NULL AND approved_by <> created_by));

ALTER TABLE vendor_bills
  ADD COLUMN created_by  uuid REFERENCES users(id),
  ADD COLUMN approved_by uuid REFERENCES users(id),
  ADD COLUMN approved_at timestamptz;

ALTER TABLE vendor_bills
  ADD CONSTRAINT vendor_bills_approval_recorded
    CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  ADD CONSTRAINT vendor_bills_maker_checker
    CHECK (approved_by IS NULL OR (created_by IS NOT NULL AND approved_by <> created_by));

-- ----------------------------------------------------------------------------
-- 4b. The constraint that made invoice approval unreachable.
--
-- Found by testing the maker/checker rule this migration adds, which is the only
-- way it could have been found: `POST /invoices/{id}/approve` has existed since
-- Phase 3 and has never once succeeded. `invoices_posted_has_number` read
--
--     CHECK (status = 'DRAFT' OR invoice_number IS NOT NULL)
--
-- and this system allocates the invoice number at POSTING. So the moment
-- `approveInvoice` set status = 'APPROVED' on a numberless draft the row violated
-- the check and the request returned 422 VALIDATION_FAILED naming a constraint.
-- `voidOrCreditInvoice` hit the same wall from the other side: voiding an
-- unposted draft sets VOID with no number.
--
-- This is not a weakening. The rule the constraint is named for — a posted
-- invoice has a number — is preserved exactly, for all three states in which an
-- invoice is an accounting fact. What is removed is the side effect that made
-- two lifecycle transitions the contract publishes structurally impossible.
-- ----------------------------------------------------------------------------
ALTER TABLE invoices DROP CONSTRAINT invoices_posted_has_number;
ALTER TABLE invoices
  ADD CONSTRAINT invoices_posted_has_number
  CHECK (status NOT IN ('POSTED','PARTIALLY_PAID','PAID') OR invoice_number IS NOT NULL);

COMMENT ON CONSTRAINT invoices_posted_has_number ON invoices IS
  'doc 02: posted numbers are never reused and a posted document has one. Stated over the three '
  'statuses in which an invoice is an accounting fact rather than over "not DRAFT", which also '
  'forbade approving and voiding a draft — neither of which allocates a number here.';

COMMENT ON COLUMN vendor_bills.created_by IS
  'The preparer. Absent until 0049, which is why doc 14''s maker/checker rule could not be stated '
  'about a vendor bill at all — not weakly, not at the service layer, not anywhere.';
COMMENT ON CONSTRAINT vendor_bills_maker_checker ON vendor_bills IS
  'NULL-safe: an unknown preparer refuses the approval. A bill created before 0049 has no '
  'preparer on record and therefore cannot be approved — correct, and visible, rather than '
  'approved by a control that quietly evaluated to NULL.';
COMMENT ON CONSTRAINT invoices_maker_checker ON invoices IS
  'NULL-safe, for the reason on vendor_bills_maker_checker.';

-- ----------------------------------------------------------------------------
-- 5. The vacuous CHECKs the audit found on `payment_runs`.
--
-- `pr_maker_checker` was `approved_by IS NULL OR approved_by <> created_by`.
-- With created_by NULL the second operand is NULL, the whole expression is
-- NULL, and PostgreSQL accepts a CHECK that is not FALSE. The rule read as
-- enforcement and behaved as nothing.
--
-- `pr_dual_approvers_differ` had the same hole one column over, plus a second:
-- it compared the second approver to the first but never to the PREPARER, so
-- the person who built the run could stand as its second approval — which is
-- the precise control doc 14 asks for ("payment over threshold requires two
-- distinct approvals") failing at the point of the money.
-- ----------------------------------------------------------------------------
ALTER TABLE payment_runs DROP CONSTRAINT pr_maker_checker;
ALTER TABLE payment_runs
  ADD CONSTRAINT pr_maker_checker
  CHECK (approved_by IS NULL OR (created_by IS NOT NULL AND approved_by <> created_by));

ALTER TABLE payment_runs DROP CONSTRAINT pr_dual_approvers_differ;
ALTER TABLE payment_runs
  ADD CONSTRAINT pr_dual_approvers_differ
  CHECK (second_approved_by IS NULL
         OR (approved_by IS NOT NULL AND created_by IS NOT NULL
             AND second_approved_by <> approved_by
             AND second_approved_by <> created_by));

COMMENT ON CONSTRAINT pr_dual_approvers_differ ON payment_runs IS
  'Two DISTINCT approvals, neither of them the preparer, and a second approval is impossible '
  'before a first. Every operand is required to be known, so the constraint cannot evaluate to '
  'NULL and pass.';

-- ----------------------------------------------------------------------------
-- 6. 0048's habit: assert this migration is describing the schema it thinks it
--    is. A CHECK naming a column that has been renamed is not a control, and a
--    trigger that was replaced by a later migration is not one either.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_missing text[] := '{}';
  v_pair    text;
BEGIN
  FOREACH v_pair IN ARRAY ARRAY[
    'journal_entries.approved_by', 'journal_entries.created_by', 'journal_entries.approved_at',
    'journal_entries.reversal_of_id', 'journal_entries.posting_date',
    'journal_lines.base_debit', 'journal_lines.base_credit',
    'accounting_policies.journal_approval_threshold', 'accounting_policies.valid_from',
    'invoices.approved_by', 'invoices.created_by',
    'vendor_bills.approved_by', 'vendor_bills.created_by',
    'payment_runs.created_by', 'payment_runs.second_approved_by'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name  = split_part(v_pair, '.', 1)
         AND column_name = split_part(v_pair, '.', 2))
    THEN
      v_missing := v_missing || v_pair;
    END IF;
  END LOOP;
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '0049 references columns that do not exist: %', array_to_string(v_missing, ', ');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'journal_entries'::regclass AND NOT t.tgisinternal
       AND t.tgfoid = to_regproc('assert_journal_approval')
       AND t.tgdeferrable AND t.tginitdeferred)
  THEN
    RAISE EXCEPTION '0049 did not install a deferred approval trigger on journal_entries';
  END IF;
END $$;
