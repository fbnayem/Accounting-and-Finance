-- =============================================================================
-- Guard tests for migrations 0000-0006.
-- Seeds the Gate C / Gate B structural test suite.
--
-- Run against a database with 0000-0006 applied:
--   psql -f contracts/schema/tests/0006_guards_test.sql
--
-- Each REJECTED marker below is a defect the audit found in the original
-- blueprint that the database now refuses structurally.
-- =============================================================================
\set ON_ERROR_STOP 0

-- ------------------------------------------------------------------ fixture --
-- ON CONFLICT because migration 0027 now seeds ISO 4217 reference data, so USD and
-- EUR already exist by the time this runs. The fixture only needs them to be there,
-- not to be the thing that put them there.
INSERT INTO currencies(code,name,minor_unit) VALUES ('USD','US Dollar',2),('EUR','Euro',2)
  ON CONFLICT (code) DO NOTHING;
INSERT INTO tenants(id,name,slug) VALUES ('11111111-1111-1111-1111-111111111111','T1','t1');
INSERT INTO organizations(id,tenant_id,name)
  VALUES ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','O1');
INSERT INTO legal_entities(id,tenant_id,organization_id,code,legal_name,country_code,functional_currency,timezone) VALUES
  ('33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','E1','Entity One','US','USD','UTC'),
  ('44444444-4444-4444-4444-444444444444','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','E2','Entity Two','US','USD','UTC');
INSERT INTO accounting_books(id,tenant_id,legal_entity_id,code,name,base_currency,is_primary)
  VALUES ('55555555-5555-5555-5555-555555555555','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','PRI','Primary','USD',true);
INSERT INTO fiscal_years(id,tenant_id,legal_entity_id,name,start_date,end_date)
  VALUES ('66666666-6666-6666-6666-666666666666','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','FY26','2026-01-01','2026-12-31');
INSERT INTO accounting_periods(id,tenant_id,legal_entity_id,fiscal_year_id,period_no,name,start_date,end_date)
  VALUES ('77777777-7777-7777-7777-777777777777','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','66666666-6666-6666-6666-666666666666',1,'Jan-26','2026-01-01','2026-01-31');
INSERT INTO journals(id,tenant_id,legal_entity_id,accounting_book_id,code,name,journal_type)
  VALUES ('88888888-8888-8888-8888-888888888888','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','GJ','General','GENERAL');
INSERT INTO accounts(id,tenant_id,legal_entity_id,code,name,account_type,normal_balance) VALUES
  ('a0000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','1000','Cash','ASSET','DEBIT'),
  ('a0000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','4000','Revenue','REVENUE','CREDIT'),
  -- an account belonging to ENTITY TWO, used by T7
  ('b0000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444444','1000','Cash E2','ASSET','DEBIT');

\echo '### T1  F-015  overlapping fiscal year -> expect REJECT via fiscal_years_no_overlap'
INSERT INTO fiscal_years(tenant_id,legal_entity_id,name,start_date,end_date)
  VALUES ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','FY26b','2026-06-01','2027-05-31');

\echo '### T2  F-011  overlapping REGULAR period -> expect REJECT via accounting_periods_no_overlap'
INSERT INTO accounting_periods(tenant_id,legal_entity_id,fiscal_year_id,period_no,name,start_date,end_date)
  VALUES ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','66666666-6666-6666-6666-666666666666',99,'Overlap','2026-01-15','2026-02-15');

\echo '### T3  F-011  ADJUSTMENT period overlapping period 1 -> expect ACCEPT'
INSERT INTO accounting_periods(tenant_id,legal_entity_id,fiscal_year_id,period_no,name,start_date,end_date,is_adjustment)
  VALUES ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','66666666-6666-6666-6666-666666666666',13,'ADJ-26','2026-01-01','2026-12-31',true);

\echo '### T4  F-013  second primary book -> expect REJECT via accounting_books_one_primary_idx'
INSERT INTO accounting_books(tenant_id,legal_entity_id,code,name,base_currency,is_primary)
  VALUES ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','SEC','Second','USD',true);

\echo '### T5  F-001  balanced journal INCLUDING a zero-value line -> expect ACCEPT'
BEGIN;
INSERT INTO journal_entries(id,tenant_id,legal_entity_id,accounting_book_id,journal_id,accounting_period_id,entry_number,posting_date,source_type,base_currency,status,posted_at)
  VALUES ('c0000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','88888888-8888-8888-8888-888888888888','77777777-7777-7777-7777-777777777777','JE-1','2026-01-15','MANUAL','USD','POSTED',now());
INSERT INTO journal_lines(tenant_id,journal_entry_id,legal_entity_id,accounting_book_id,accounting_period_id,posting_date,line_no,account_id,transaction_currency,transaction_debit,base_currency,base_debit)
  VALUES ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','77777777-7777-7777-7777-777777777777','2026-01-15',1,'a0000000-0000-0000-0000-000000000001','USD',100,'USD',100);
INSERT INTO journal_lines(tenant_id,journal_entry_id,legal_entity_id,accounting_book_id,accounting_period_id,posting_date,line_no,account_id,transaction_currency,transaction_credit,base_currency,base_credit)
  VALUES ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','77777777-7777-7777-7777-777777777777','2026-01-15',2,'a0000000-0000-0000-0000-000000000002','USD',100,'USD',100);
-- the zero line the blueprint's CHECK (base_debit > 0 OR base_credit > 0) rejected
INSERT INTO journal_lines(tenant_id,journal_entry_id,legal_entity_id,accounting_book_id,accounting_period_id,posting_date,line_no,account_id,transaction_currency,base_currency,description)
  VALUES ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','77777777-7777-7777-7777-777777777777','2026-01-15',3,'a0000000-0000-0000-0000-000000000002','USD','USD','zero-cost issue');
COMMIT;

\echo '### T6  F-005  UNBALANCED posted journal -> expect REJECT at COMMIT via UNBALANCED_JOURNAL'
BEGIN;
INSERT INTO journal_entries(id,tenant_id,legal_entity_id,accounting_book_id,journal_id,accounting_period_id,entry_number,posting_date,source_type,base_currency,status,posted_at)
  VALUES ('c0000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','88888888-8888-8888-8888-888888888888','77777777-7777-7777-7777-777777777777','JE-2','2026-01-16','MANUAL','USD','POSTED',now());
INSERT INTO journal_lines(tenant_id,journal_entry_id,legal_entity_id,accounting_book_id,accounting_period_id,posting_date,line_no,account_id,transaction_currency,transaction_debit,base_currency,base_debit)
  VALUES ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000002','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','77777777-7777-7777-7777-777777777777','2026-01-16',1,'a0000000-0000-0000-0000-000000000001','USD',100,'USD',100);
COMMIT;

\echo '### T7  F-003  journal line referencing ANOTHER ENTITY''s account -> expect REJECT via jl_account_scope_fk'
BEGIN;
INSERT INTO journal_entries(id,tenant_id,legal_entity_id,accounting_book_id,journal_id,accounting_period_id,entry_number,posting_date,source_type,base_currency,status)
  VALUES ('c0000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','88888888-8888-8888-8888-888888888888','77777777-7777-7777-7777-777777777777','JE-3','2026-01-17','MANUAL','USD','DRAFT');
INSERT INTO journal_lines(tenant_id,journal_entry_id,legal_entity_id,accounting_book_id,accounting_period_id,posting_date,line_no,account_id,transaction_currency,transaction_debit,base_currency,base_debit)
  VALUES ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000003','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','77777777-7777-7777-7777-777777777777','2026-01-17',1,'b0000000-0000-0000-0000-000000000001','USD',100,'USD',100);
COMMIT;

\echo '### T8  F-004  UPDATE a posted journal line -> expect REJECT via POSTED_IMMUTABLE'
UPDATE journal_lines SET base_debit = 999
  WHERE journal_entry_id='c0000000-0000-0000-0000-000000000001' AND line_no=1;

\echo '### T9  F-004  DELETE a posted journal entry -> expect REJECT via POSTED_IMMUTABLE'
DELETE FROM journal_entries WHERE id='c0000000-0000-0000-0000-000000000001';

\echo '### T10 doc01r4 POSTED -> REVERSED -> expect ACCEPT'
UPDATE journal_entries SET status='REVERSED' WHERE id='c0000000-0000-0000-0000-000000000001';

\echo '### T11 F-010  overlapping posting rule versions -> first ACCEPT, second REJECT via posting_rule_versions_no_overlap'
INSERT INTO posting_rule_versions(tenant_id,legal_entity_id,accounting_book_id,event_type,version,valid_from,rule_definition)
  VALUES ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','SALES_INVOICE_POSTED',1,'2026-01-01','{}');
INSERT INTO posting_rule_versions(tenant_id,legal_entity_id,accounting_book_id,event_type,version,valid_from,rule_definition)
  VALUES ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','SALES_INVOICE_POSTED',2,'2026-06-01','{}');

\echo '### T12 F-048  file storage_key outside its tenant prefix -> expect REJECT via files_key_is_tenant_scoped'
INSERT INTO files(tenant_id,storage_key,original_filename)
  VALUES ('11111111-1111-1111-1111-111111111111','99999999/evil.pdf','evil.pdf');

\echo '### T13 F-043  UPDATE an audit event -> expect REJECT via POSTED_IMMUTABLE'
INSERT INTO audit_events(tenant_id,actor_kind,action,resource_type)
  VALUES ('11111111-1111-1111-1111-111111111111','USER','test','x');
UPDATE audit_events SET action='tampered' WHERE action='test';

\echo '### T14 F-017  duplicate tenant-wide membership (all scope cols NULL) -> expect REJECT via memberships_uq'
-- Migration 0022 seeds the whole registry, so this is now a no-op that only needs
-- the row to exist. Without ON CONFLICT it failed on permissions_pkey and the
-- scenario was rejected for the wrong reason entirely — reported as a pass,
-- because it had been asked only whether the block was rejected.
INSERT INTO permissions(code,resource,action,description) VALUES ('journal.post','journal','post','Post a journal')
  ON CONFLICT (code) DO NOTHING;
INSERT INTO roles(id,tenant_id,code,name) VALUES ('d0000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','ACC','Accountant');
INSERT INTO users(id,email,display_name) VALUES ('e0000000-0000-0000-0000-000000000001','a@example.com','A');
INSERT INTO memberships(tenant_id,user_id,role_id)
  VALUES ('11111111-1111-1111-1111-111111111111','e0000000-0000-0000-0000-000000000001','d0000000-0000-0000-0000-000000000001');
INSERT INTO memberships(tenant_id,user_id,role_id)
  VALUES ('11111111-1111-1111-1111-111111111111','e0000000-0000-0000-0000-000000000001','d0000000-0000-0000-0000-000000000001');

\echo '### T15 F-403  period resolution returns the REGULAR period, not the adjustment period -> expect ACCEPT'
-- Was a bare SELECT for 116 scenarios' worth of history: it printed the row and
-- asserted nothing, so resolution could have started returning the adjustment
-- period and this scenario would have reported a pass either way. The runner
-- counted 116 asserted out of 117 labelled, which is how it was found. Stated as
-- a DO block that raises, so the ACCEPT expectation has something to hold.
DO $$
DECLARE v record;
BEGIN
  SELECT name, is_adjustment INTO v FROM accounting_periods
   WHERE id = resolve_accounting_period('33333333-3333-3333-3333-333333333333','2026-01-15');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'F-403: no period resolved for 2026-01-15; the posting date is inside a regular period';
  END IF;
  IF v.is_adjustment THEN
    RAISE EXCEPTION
      'F-403: resolved the adjustment period % for an ordinary posting date; an adjustment period is entered deliberately, never inferred from a date (doc 03).',
      v.name;
  END IF;
END $$;

-- ============================================================================
-- Phase 2 additions. Each of these guards a rule doc 03 states in prose and the
-- schema previously left to whoever wrote the INSERT.
-- ============================================================================

\echo '### T16 doc03  line on a NON-POSTING heading account -> expect REJECT via ACCOUNT_NOT_POSTABLE'
INSERT INTO accounts(id,tenant_id,legal_entity_id,code,name,account_type,normal_balance,is_posting)
  VALUES ('a0000000-0000-0000-0000-00000000000f','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','9000','Reporting heading','EXPENSE','DEBIT',false);
BEGIN;
INSERT INTO journal_entries(id,tenant_id,legal_entity_id,accounting_book_id,journal_id,accounting_period_id,posting_date,source_type,base_currency,status)
  VALUES ('c0000000-0000-0000-0000-00000000000f','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','88888888-8888-8888-8888-888888888888','77777777-7777-7777-7777-777777777777','2026-01-20','MANUAL','USD','DRAFT');
INSERT INTO journal_lines(tenant_id,journal_entry_id,legal_entity_id,accounting_book_id,accounting_period_id,posting_date,line_no,account_id,transaction_currency,transaction_debit,base_currency,base_debit)
  VALUES ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-00000000000f','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','77777777-7777-7777-7777-777777777777','2026-01-20',1,'a0000000-0000-0000-0000-00000000000f','USD',10,'USD',10);
COMMIT;

\echo '### T17 doc03  changing the TYPE of a posted-to account -> expect REJECT via ACCOUNT_TYPE_LOCKED'
UPDATE accounts SET account_type = 'EXPENSE'
 WHERE id = 'a0000000-0000-0000-0000-000000000001';

\echo '### T18 doc03  changing the type of an UNUSED account -> expect ACCEPT'
UPDATE accounts SET account_type = 'LIABILITY', normal_balance = 'CREDIT'
 WHERE id = 'a0000000-0000-0000-0000-00000000000f';

\echo '### T19 F-615  dimension value from ANOTHER ENTITY on a line -> expect REJECT via jld_line_scope_fk'
INSERT INTO dimensions(id,tenant_id,legal_entity_id,code,name)
  VALUES ('f0000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444444','DEPT','Department');
INSERT INTO dimension_values(id,tenant_id,legal_entity_id,dimension_id,code,name)
  VALUES ('f0000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444444','f0000000-0000-0000-0000-000000000001','SALES','Sales');
-- Entity 2's dimension attached to entity 1's line. It moves no money, so every
-- balance check passes and only the composite key notices.
INSERT INTO journal_line_dimensions(tenant_id,journal_line_id,legal_entity_id,dimension_id,dimension_value_id)
  SELECT '11111111-1111-1111-1111-111111111111', l.id, '44444444-4444-4444-4444-444444444444',
         'f0000000-0000-0000-0000-000000000001','f0000000-0000-0000-0000-000000000002'
    FROM journal_lines l
   WHERE l.journal_entry_id = 'c0000000-0000-0000-0000-000000000001' AND l.line_no = 1;

\echo '### T20 F-619  ledger_clear_draft_lines on a POSTED entry -> expect REJECT via POSTED_IMMUTABLE'
-- The tenant is set because migration 0034 checks it FIRST. Without it the call is
-- rejected with NOT_FOUND, which is correct and is not what this scenario tests —
-- and the `via` clause is what says so rather than letting it read as a pass.
BEGIN;
SELECT set_config('app.tenant_id','11111111-1111-1111-1111-111111111111',true);
SELECT ledger_clear_draft_lines('c0000000-0000-0000-0000-000000000001');
COMMIT;

\echo '### T21 F-619  ledger_discard_draft on a POSTED entry -> expect REJECT via POSTED_IMMUTABLE'
BEGIN;
SELECT set_config('app.tenant_id','11111111-1111-1111-1111-111111111111',true);
SELECT ledger_discard_draft('c0000000-0000-0000-0000-000000000001');
COMMIT;

\echo '### T22 F-619  a DRAFT entry with one line, for the two scenarios below -> expect ACCEPT'
-- Its own scenario, not a preamble to T21. The runner rolls a rejected block back,
-- and the first draft of this put the fixture inside T21 — so the rows never
-- existed, T23 was rejected with an honest NOT_FOUND, and the tenant check it
-- claims to test was never reached.
INSERT INTO journal_entries(id,tenant_id,legal_entity_id,accounting_book_id,journal_id,accounting_period_id,posting_date,source_type,base_currency,status)
  VALUES ('c0000000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','88888888-8888-8888-8888-888888888888','77777777-7777-7777-7777-777777777777','2026-01-21','MANUAL','USD','DRAFT');
INSERT INTO journal_lines(tenant_id,journal_entry_id,legal_entity_id,accounting_book_id,accounting_period_id,posting_date,line_no,account_id,transaction_currency,transaction_debit,base_currency,base_debit)
  VALUES ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000004','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','77777777-7777-7777-7777-777777777777','2026-01-21',1,'a0000000-0000-0000-0000-000000000002','USD',5,'USD',5);

\echo '### T23 F-619  ledger_clear_draft_lines on another tenant DRAFT -> expect REJECT via NOT_FOUND'
-- SECURITY DEFINER runs as the function owner and therefore bypasses row-level
-- security outright. The tenant check inside the function is the only thing
-- standing between one tenant and another tenant drafts.
--
-- F-621: the first version of this ran under SET LOCAL ROLE app_runtime and was
-- ACCEPTED, which is how the defect was found — inside a SECURITY DEFINER function
-- current_user is the definer, so the exemption the check consulted was always
-- true. Migration 0034 removed the exemption; the role no longer matters, because
-- there is no longer a role that is allowed past this.
BEGIN;
SELECT set_config('app.tenant_id','99999999-9999-9999-9999-999999999999',true);
SELECT ledger_clear_draft_lines('c0000000-0000-0000-0000-000000000004');
COMMIT;

\echo '### T24 F-619  the same call on the caller own draft -> expect ACCEPT'
-- The other half. Without it, T23 passes whether the function checks the tenant or
-- simply cannot find anything, because both answer NOT_FOUND by design.
BEGIN;
SELECT set_config('app.tenant_id','11111111-1111-1111-1111-111111111111',true);
SELECT ledger_clear_draft_lines('c0000000-0000-0000-0000-000000000004');
COMMIT;

\echo '### T25 F-403  an ADJUSTMENT period is never resolved from a posting date -> expect ACCEPT'
SELECT count(*) AS adjustment_periods_resolved
  FROM accounting_periods p
 WHERE p.is_adjustment
   AND p.id = resolve_accounting_period('33333333-3333-3333-3333-333333333333', p.start_date);

-- =============================================================================
-- Phase 3 — the subledger guards (migration 0036).
-- =============================================================================

\echo '### T26 fixture  a customer, an AR account and a POSTED invoice with one line -> expect ACCEPT'
-- Its own labelled scenario, not a preamble. The runner rolls a rejected block
-- back, so a fixture that rides along with the previous scenario disappears with
-- it and every assertion afterwards passes against nothing. That is exactly how
-- T22/T23 reported a pass twice in Phase 2.
--
-- The invoice is created DRAFT and only then marked POSTED, because the guard
-- being tested below refuses a line on a posted invoice — including the one the
-- fixture is trying to write.
INSERT INTO contacts(id,tenant_id,organization_id,kind,legal_name)
  VALUES ('d0000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','CUSTOMER','Customer One');
INSERT INTO accounts(id,tenant_id,legal_entity_id,code,name,account_type,normal_balance)
  VALUES ('a0000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','1100','Accounts receivable','ASSET','DEBIT');
INSERT INTO invoices(id,tenant_id,legal_entity_id,accounting_book_id,customer_id,invoice_number,document_date,posting_date,currency,status,subtotal,tax_total,total,base_total,amount_due)
  VALUES ('e0000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','d0000000-0000-0000-0000-000000000001','INV-1','2026-01-10','2026-01-10','USD','DRAFT',100,0,100,100,100);
INSERT INTO invoice_lines(id,tenant_id,invoice_id,legal_entity_id,line_no,description,quantity,unit_price,revenue_account_id,net_amount,gross_amount)
  VALUES ('e1000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','e0000000-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333',1,'Consulting',1,100,'a0000000-0000-0000-0000-000000000002',100,100);
UPDATE invoices SET status = 'POSTED' WHERE id = 'e0000000-0000-0000-0000-000000000001';

\echo '### T27 F-703  settlement exceeding the invoice total -> expect REJECT via invoices_settlement_bounded'
-- The three terms are independent, so the bound has to be on their sum. A
-- per-term CHECK would let 60 paid plus 60 credited through on a 100 invoice.
UPDATE invoices SET amount_paid = 60, amount_credited = 60, amount_due = -20
  WHERE id = 'e0000000-0000-0000-0000-000000000001';

\echo '### T28 F-703  a partial write-off reducing the open balance -> expect ACCEPT'
UPDATE invoices SET amount_written_off = 30, amount_due = 70
  WHERE id = 'e0000000-0000-0000-0000-000000000001';

\echo '### T29 doc01r4  editing the total of a POSTED invoice -> expect REJECT via POSTED_IMMUTABLE'
-- What this really tests is the frozen-column list. A guard that reads its column
-- names out of a string freezes nothing at all if one is misspelled, which is why
-- 0036 checks the names against the catalog at migration time — and why this
-- asserts a specific column rather than trusting that it did.
UPDATE invoices SET total = 999 WHERE id = 'e0000000-0000-0000-0000-000000000001';

\echo '### T30 doc01r4  changing the posting date of a POSTED invoice -> expect REJECT via POSTED_IMMUTABLE'
UPDATE invoices SET posting_date = '2026-02-01' WHERE id = 'e0000000-0000-0000-0000-000000000001';

\echo '### T31 doc01r4  recording a payment against a POSTED invoice -> expect ACCEPT'
-- The other half of T29, and the one that matters more: a guard that froze the
-- whole row would be trivially correct and would also make an invoice unpayable.
UPDATE invoices SET amount_paid = 40, amount_due = 30
  WHERE id = 'e0000000-0000-0000-0000-000000000001';

\echo '### T32 doc01r4  deleting a line of a POSTED invoice -> expect REJECT via POSTED_IMMUTABLE'
DELETE FROM invoice_lines WHERE id = 'e1000000-0000-0000-0000-000000000001';

\echo '### T33 doc01r4  adding a line to a POSTED invoice -> expect REJECT via POSTED_IMMUTABLE'
-- INSERT, not only UPDATE: an invoice whose journal is already written must not
-- acquire a line afterwards, and a guard on UPDATE alone would permit exactly that.
INSERT INTO invoice_lines(tenant_id,invoice_id,legal_entity_id,line_no,description,quantity,unit_price,revenue_account_id,net_amount,gross_amount)
  VALUES ('11111111-1111-1111-1111-111111111111','e0000000-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333',2,'Sneaked in',1,50,'a0000000-0000-0000-0000-000000000002',50,50);

\echo '### T34 doc01r4  deleting a POSTED invoice -> expect REJECT via POSTED_IMMUTABLE'
DELETE FROM invoices WHERE id = 'e0000000-0000-0000-0000-000000000001';

\echo '### T35 F-704  a credit note applied beyond its own total -> expect REJECT via OVER_ALLOCATION'
BEGIN;
INSERT INTO credit_notes(id,tenant_id,legal_entity_id,accounting_book_id,customer_id,credit_note_number,document_date,posting_date,currency,status,total,amount_available)
  VALUES ('e2000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','d0000000-0000-0000-0000-000000000001','CN-1','2026-01-12','2026-01-12','USD','POSTED',50,50);
INSERT INTO credit_note_applications(tenant_id,credit_note_id,invoice_id,amount,base_amount) VALUES
  ('11111111-1111-1111-1111-111111111111','e2000000-0000-0000-0000-000000000001','e0000000-0000-0000-0000-000000000001',30,30),
  ('11111111-1111-1111-1111-111111111111','e2000000-0000-0000-0000-000000000001','e0000000-0000-0000-0000-000000000001',30,30);
COMMIT;

\echo '### T36 F-702  billing more than was accepted on a receipt line -> expect REJECT via grl_billed_bounded'
-- Rejecting goods and paying for them anyway is the failure three-way matching
-- exists to prevent, so it is refused structurally as well.
BEGIN;
INSERT INTO goods_receipts(id,tenant_id,legal_entity_id,accounting_book_id,vendor_id,receipt_date,posting_date)
  VALUES ('e3000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','d0000000-0000-0000-0000-000000000001','2026-01-14','2026-01-14');
INSERT INTO goods_receipt_lines(tenant_id,goods_receipt_id,legal_entity_id,line_no,description,quantity_received,quantity_accepted,quantity_rejected,quantity_billed)
  VALUES ('11111111-1111-1111-1111-111111111111','e3000000-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333',1,'Widgets',10,8,2,9);
COMMIT;

\echo '### T37 F-702  accepting more than was received -> expect REJECT via grl_accepted_bounded'
BEGIN;
INSERT INTO goods_receipts(id,tenant_id,legal_entity_id,accounting_book_id,vendor_id,receipt_date,posting_date)
  VALUES ('e3000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','d0000000-0000-0000-0000-000000000001','2026-01-14','2026-01-14');
INSERT INTO goods_receipt_lines(tenant_id,goods_receipt_id,legal_entity_id,line_no,description,quantity_received,quantity_accepted,quantity_rejected)
  VALUES ('11111111-1111-1111-1111-111111111111','e3000000-0000-0000-0000-000000000002','33333333-3333-3333-3333-333333333333',1,'Widgets',10,9,2);
COMMIT;

\echo '### T38 F-702  a receipt line and a bill line on the same PO line -> expect ACCEPT'
-- The three-way match needs all three documents to point at the same order line.
-- Asserting the shape here means the matching service is comparing quantities
-- rather than discovering that it cannot join.
BEGIN;
INSERT INTO purchase_orders(id,tenant_id,legal_entity_id,vendor_id,po_number,document_date,currency)
  VALUES ('e6000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','d0000000-0000-0000-0000-000000000001','PO-1','2026-01-02','USD');
INSERT INTO purchase_order_lines(id,tenant_id,purchase_order_id,legal_entity_id,line_no,description,quantity_ordered,unit_price,net_amount,gross_amount)
  VALUES ('e6100000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','e6000000-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333',1,'Widgets',10,5,50,50);
INSERT INTO goods_receipts(id,tenant_id,legal_entity_id,accounting_book_id,vendor_id,purchase_order_id,receipt_date,posting_date)
  VALUES ('e3000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','d0000000-0000-0000-0000-000000000001','e6000000-0000-0000-0000-000000000001','2026-01-14','2026-01-14');
INSERT INTO goods_receipt_lines(id,tenant_id,goods_receipt_id,legal_entity_id,line_no,purchase_order_line_id,description,quantity_received,quantity_accepted)
  VALUES ('e3100000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','e3000000-0000-0000-0000-000000000003','33333333-3333-3333-3333-333333333333',1,'e6100000-0000-0000-0000-000000000001','Widgets',10,10);
INSERT INTO vendor_bills(id,tenant_id,legal_entity_id,accounting_book_id,vendor_id,purchase_order_id,vendor_invoice_number,document_date,posting_date,currency,total,amount_due)
  VALUES ('e7000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','d0000000-0000-0000-0000-000000000001','e6000000-0000-0000-0000-000000000001','V-1','2026-01-16','2026-01-16','USD',50,50);
INSERT INTO vendor_bill_lines(tenant_id,vendor_bill_id,legal_entity_id,line_no,purchase_order_line_id,goods_receipt_line_id,description,quantity,unit_price,destination_account_id,net_amount,gross_amount)
  VALUES ('11111111-1111-1111-1111-111111111111','e7000000-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333',1,'e6100000-0000-0000-0000-000000000001','e3100000-0000-0000-0000-000000000001','Widgets',10,5,'a0000000-0000-0000-0000-000000000001',50,50);
COMMIT;

\echo '### T39 F-705  a COMPLETED file with no completion time -> expect REJECT via files_completed_has_time'
INSERT INTO files(tenant_id,storage_key,original_filename,upload_state)
  VALUES ('11111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111/x.pdf','x.pdf','COMPLETED');

\echo '### T40 F-701  a quote line whose tax code belongs to another entity -> expect REJECT via quote_lines_tax_fk'
-- F-003, two documents further down. The composite key is what makes it
-- structural rather than a rule someone has to remember to write.
BEGIN;
INSERT INTO tax_codes(id,tenant_id,legal_entity_id,code,name,kind)
  VALUES ('e4000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444444','VAT20','VAT 20%','VAT');
INSERT INTO quotes(id,tenant_id,legal_entity_id,customer_id,document_date,currency)
  VALUES ('e5000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','d0000000-0000-0000-0000-000000000001','2026-01-05','USD');
INSERT INTO quote_lines(tenant_id,quote_id,legal_entity_id,line_no,description,quantity,unit_price,tax_code_id,net_amount,gross_amount)
  VALUES ('11111111-1111-1111-1111-111111111111','e5000000-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333',1,'Design',1,100,'e4000000-0000-0000-0000-000000000001',100,120);
COMMIT;

\echo '### T41 fixture  a FILED tax return -> expect ACCEPT'
-- Its own scenario for the reason T26 is: a fixture inside a rejected block is
-- rolled back, and everything after it then asserts against nothing.
INSERT INTO tax_periods(id,tenant_id,legal_entity_id,jurisdiction,name,start_date,end_date,status)
  VALUES ('e8000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','GB','2026-Q1','2026-01-01','2026-03-31','CLOSED');
INSERT INTO tax_returns(id,tenant_id,legal_entity_id,tax_period_id,form_code,version,status,filed_at,filing_reference,snapshot)
  VALUES ('e9000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','e8000000-0000-0000-0000-000000000001','VAT100',1,'FILED',now(),'HMRC-2026-Q1','{"box1":"1000.00"}');

\echo '### T42 F-719  rewriting a FILED return snapshot -> expect REJECT via POSTED_IMMUTABLE'
-- The whole of F-719. 0008 said a filed return is immutable and guarded DELETE,
-- which is not how a filed return gets rewritten. This is the UPDATE it permitted.
UPDATE tax_returns SET snapshot = '{"box1":"9999.00"}'
  WHERE id = 'e9000000-0000-0000-0000-000000000001';

\echo '### T43 F-719  reopening a FILED return to READY -> expect REJECT via POSTED_IMMUTABLE'
-- FILED has exactly one legal successor. Sliding back to READY would let the
-- return be re-approved and re-filed under the same version number.
UPDATE tax_returns SET status = 'READY'
  WHERE id = 'e9000000-0000-0000-0000-000000000001';

\echo '### T44 F-719  superseding a FILED return by amendment -> expect ACCEPT'
-- The permitted transition, asserted so the guard cannot be "fixed" by freezing
-- the row completely — which would make doc 07 amendments impossible.
UPDATE tax_returns SET status = 'AMENDED'
  WHERE id = 'e9000000-0000-0000-0000-000000000001';

\echo '### T45 fixture  a bank account and an accounting policy with zero tolerance -> expect ACCEPT'
-- Its own scenario, for T26's reason: a fixture inside a rejected block is rolled
-- back and everything after it asserts against nothing.
INSERT INTO accounting_policies(id,tenant_id,legal_entity_id,version,valid_from,bank_reconciliation_tolerance)
  VALUES ('f0000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333',1,'2026-01-01',0);
INSERT INTO bank_accounts(id,tenant_id,legal_entity_id,account_id,name,currency)
  VALUES ('f1000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','a0000000-0000-0000-0000-000000000001','Operating','USD');

\echo '### T46 F-801  completing a reconciliation with a difference of 500 -> expect REJECT via RECONCILIATION_UNBALANCED'
-- The whole of F-801. 0011''s CHECK asserted the balance columns were populated,
-- not that they reconciled, so this exact row was accepted before 0038.
INSERT INTO bank_reconciliations(tenant_id,legal_entity_id,bank_account_id,statement_start_date,statement_end_date,statement_opening_balance,statement_closing_balance,book_closing_balance,difference,status)
  VALUES ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','f1000000-0000-0000-0000-000000000001','2026-01-01','2026-01-31',0,1000,500,500,'COMPLETED');

\echo '### T47 F-801  completing with a self-reported difference of zero that does not follow from the balances -> expect REJECT via RECONCILIATION_UNBALANCED'
-- The client that computes its own difference. Trusting the column would let any
-- caller finalize anything by writing a zero into it.
INSERT INTO bank_reconciliations(tenant_id,legal_entity_id,bank_account_id,statement_start_date,statement_end_date,statement_opening_balance,statement_closing_balance,book_closing_balance,difference,status)
  VALUES ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','f1000000-0000-0000-0000-000000000001','2026-01-01','2026-01-31',0,1000,500,0,'COMPLETED');

\echo '### T48 F-801  completing a reconciliation that actually reconciles -> expect ACCEPT'
-- Asserted so the guard cannot be "fixed" by refusing every completion, which
-- would make doc 06''s reconciliation session impossible to finish.
INSERT INTO bank_reconciliations(id,tenant_id,legal_entity_id,bank_account_id,statement_start_date,statement_end_date,statement_opening_balance,statement_closing_balance,book_closing_balance,difference,status)
  VALUES ('f2000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','f1000000-0000-0000-0000-000000000001','2026-02-01','2026-02-28',0,1000,1000,0,'COMPLETED');

\echo '### T49 F-803  a split whose children do not sum to their parent -> expect REJECT at COMMIT via SPLIT_UNBALANCED'
BEGIN;
INSERT INTO bank_transactions(id,tenant_id,legal_entity_id,bank_account_id,transaction_date,currency,amount,fingerprint)
  VALUES ('f3000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','f1000000-0000-0000-0000-000000000001','2026-01-10','USD',100,'fp-parent-1');
INSERT INTO bank_transactions(tenant_id,legal_entity_id,bank_account_id,transaction_date,currency,amount,fingerprint,parent_transaction_id)
  VALUES ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','f1000000-0000-0000-0000-000000000001','2026-01-10','USD',60,'fp-child-1','f3000000-0000-0000-0000-000000000001'),
         ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','f1000000-0000-0000-0000-000000000001','2026-01-10','USD',30,'fp-child-2','f3000000-0000-0000-0000-000000000001');
COMMIT;

\echo '### T50 F-803  a split whose children sum exactly -> expect ACCEPT'
BEGIN;
INSERT INTO bank_transactions(id,tenant_id,legal_entity_id,bank_account_id,transaction_date,currency,amount,fingerprint,reconciliation_state)
  VALUES ('f4000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','f1000000-0000-0000-0000-000000000001','2026-01-11','USD',100,'fp-parent-2','SPLIT');
INSERT INTO bank_transactions(tenant_id,legal_entity_id,bank_account_id,transaction_date,currency,amount,fingerprint,parent_transaction_id)
  VALUES ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','f1000000-0000-0000-0000-000000000001','2026-01-11','USD',60,'fp-child-3','f4000000-0000-0000-0000-000000000001'),
         ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','f1000000-0000-0000-0000-000000000001','2026-01-11','USD',40,'fp-child-4','f4000000-0000-0000-0000-000000000001');
COMMIT;

\echo '### T51 F-803  matching the parent of a split beside its children -> expect REJECT via SPLIT_PARENT_NOT_MATCHABLE'
-- Cash counted twice from one bank line: 100 on the parent and 60+40 below it.
-- bank_matches_bounded cannot see this, because it bounds each transaction
-- against its own amount and both are individually within theirs.
INSERT INTO bank_matches(tenant_id,legal_entity_id,bank_transaction_id,target_type,target_id,matched_amount,match_method,status)
  VALUES ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','f4000000-0000-0000-0000-000000000001','JOURNAL_ENTRY','c0000000-0000-0000-0000-000000000001',100,'MANUAL','CONFIRMED');

-- =============================================================================
-- Phase 5 — inventory, fixed assets and budgets (migrations 0042/0043).
--
-- Every scenario below exercises a guard 0043 installs. Phase 5 fixture rows use
-- the f5000000-... prefix; the fourth group distinguishes the table (0001
-- warehouses, 0002 locations, 0003 items, 0004 documents, 0005 movements, 0006
-- layers, 0007 consumptions, 0008 accounts, 0009 asset categories, 000a assets,
-- 000b asset books, 000c periods, 000d schedule lines, 000e budgets, 000f
-- budget lines).
--
-- Two of 0043's raise prefixes — BUDGET_IMMUTABLE: (shared with 0014) and
-- TRANSFER_UNBALANCED: — are absent from GUARD_PREFIXES in
-- packages/database/src/errors.ts. The guards still fire and these scenarios
-- still assert them; what is wrong is what a CALLER sees (F-809). Reported, not
-- patched here — this file owns the scenarios, not the mapping.
-- =============================================================================

\echo '### T52 fixture  a warehouse, an item, a POSTED receipt and issue, a DRAFT adjustment, two cost layers and a consumption -> expect ACCEPT'
-- Its own labelled scenario, for T26's reason: the runner rolls a rejected block
-- back, so a fixture riding inside a REJECT scenario vanishes with it and every
-- assertion afterwards passes against nothing.
--
-- Both posted documents are created DRAFT, given their movements, and only then
-- flipped POSTED — the order 0043 documents ("the posting service writes
-- movement costs BEFORE it flips the document to POSTED"), and the only order
-- the guards below permit.
INSERT INTO warehouses(id,tenant_id,legal_entity_id,code,name)
  VALUES ('f5000000-0000-0000-0001-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','WH1','Main warehouse');
INSERT INTO warehouse_locations(id,tenant_id,warehouse_id,legal_entity_id,code,name) VALUES
  ('f5000000-0000-0000-0002-000000000001','11111111-1111-1111-1111-111111111111','f5000000-0000-0000-0001-000000000001','33333333-3333-3333-3333-333333333333','A-01','Bin A-01'),
  ('f5000000-0000-0000-0002-000000000002','11111111-1111-1111-1111-111111111111','f5000000-0000-0000-0001-000000000001','33333333-3333-3333-3333-333333333333','A-02','Bin A-02');
INSERT INTO items(id,tenant_id,organization_id,sku,name,kind,base_uom,valuation)
  VALUES ('f5000000-0000-0000-0003-000000000001','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','WID-1','Widget','INVENTORY','EA','FIFO');
-- The receipt: 10 widgets at 5.00 into bin A-01. Source of cost layer L1.
INSERT INTO inventory_documents(id,tenant_id,legal_entity_id,accounting_book_id,document_type,document_number,document_date,posting_date,warehouse_id,source_type)
  VALUES ('f5000000-0000-0000-0004-00000000000a','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','RECEIPT','GRN-P5-1','2026-01-10','2026-01-10','f5000000-0000-0000-0001-000000000001','MANUAL');
INSERT INTO inventory_movements(id,tenant_id,legal_entity_id,inventory_document_id,line_no,item_id,to_location_id,movement_date,quantity,uom,unit_cost,total_cost,currency,cost_method)
  VALUES ('f5000000-0000-0000-0005-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','f5000000-0000-0000-0004-00000000000a',1,'f5000000-0000-0000-0003-000000000001','f5000000-0000-0000-0002-000000000001','2026-01-10',10,'EA',5,50,'USD','FIFO');
UPDATE inventory_documents SET status = 'POSTED' WHERE id = 'f5000000-0000-0000-0004-00000000000a';
-- The issue: 4 widgets out again. Its movement is what consumption C1 joins to.
INSERT INTO inventory_documents(id,tenant_id,legal_entity_id,accounting_book_id,document_type,document_number,document_date,posting_date,warehouse_id)
  VALUES ('f5000000-0000-0000-0004-00000000000c','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','ISSUE','ISS-P5-1','2026-01-12','2026-01-12','f5000000-0000-0000-0001-000000000001');
INSERT INTO inventory_movements(id,tenant_id,legal_entity_id,inventory_document_id,line_no,item_id,from_location_id,movement_date,quantity,uom,unit_cost,total_cost,currency,cost_method)
  VALUES ('f5000000-0000-0000-0005-000000000004','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','f5000000-0000-0000-0004-00000000000c',1,'f5000000-0000-0000-0003-000000000001','f5000000-0000-0000-0002-000000000001','2026-01-12',-4,'EA',5,20,'USD','FIFO');
UPDATE inventory_documents SET status = 'POSTED' WHERE id = 'f5000000-0000-0000-0004-00000000000c';
-- The DRAFT adjustment, which stays DRAFT: the ACCEPT half of the movement
-- guard lives on it.
INSERT INTO inventory_documents(id,tenant_id,legal_entity_id,accounting_book_id,document_type,document_number,document_date,posting_date,warehouse_id)
  VALUES ('f5000000-0000-0000-0004-00000000000b','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','ADJUSTMENT','ADJ-P5-1','2026-01-15','2026-01-15','f5000000-0000-0000-0001-000000000001');
INSERT INTO inventory_movements(id,tenant_id,legal_entity_id,inventory_document_id,line_no,item_id,to_location_id,movement_date,quantity,uom,unit_cost,total_cost,currency,cost_method)
  VALUES ('f5000000-0000-0000-0005-000000000002','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','f5000000-0000-0000-0004-00000000000b',1,'f5000000-0000-0000-0003-000000000001','f5000000-0000-0000-0002-000000000001','2026-01-15',1,'EA',5,5,'USD','FIFO');
-- L1: the real layer the receipt created. L2: a provisional layer (doc 08
-- negative stock) whose estimated cost 4.00 awaits settlement. INSERT of layers
-- and consumptions stays open by design — a correction is a reverse movement
-- with layers and consumptions of its own, so creating them is never guarded.
INSERT INTO inventory_cost_layers(id,tenant_id,legal_entity_id,accounting_book_id,item_id,warehouse_id,source_movement_id,received_date,original_quantity,remaining_quantity,unit_cost,currency,status,is_provisional) VALUES
  ('f5000000-0000-0000-0006-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','f5000000-0000-0000-0003-000000000001','f5000000-0000-0000-0001-000000000001','f5000000-0000-0000-0005-000000000001','2026-01-10',10,10,5,'USD','OPEN',false),
  ('f5000000-0000-0000-0006-000000000002','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','f5000000-0000-0000-0003-000000000001','f5000000-0000-0000-0001-000000000001','f5000000-0000-0000-0005-000000000004','2026-01-12',5,5,4,'USD','PROVISIONAL',true);
-- C1: the issue consumed 4 units of L1 at 5.00 — the row COGS is reproduced from.
INSERT INTO inventory_cost_consumptions(id,tenant_id,legal_entity_id,cost_layer_id,inventory_movement_id,quantity,unit_cost,total_cost)
  VALUES ('f5000000-0000-0000-0007-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','f5000000-0000-0000-0006-000000000001','f5000000-0000-0000-0005-000000000004',4,5,20);

\echo '### T53 F-915  changing the posting date of a POSTED inventory document -> expect REJECT via POSTED_IMMUTABLE'
-- The header shares guard_posted_document_immutable with invoices (T29/T30), so
-- what this really tests is that 0043 passed inventory_documents its own frozen
-- list and that posting_date is on it.
UPDATE inventory_documents SET posting_date = '2026-02-01'
  WHERE id = 'f5000000-0000-0000-0004-00000000000a';

\echo '### T54 F-915  status and metadata of a POSTED inventory document stay mutable -> expect ACCEPT'
-- The other half of T53, and the one that matters more (T31's reason): a guard
-- that froze the whole row would be trivially correct and would also end the
-- document's later life — CLOSED could never be recorded.
UPDATE inventory_documents SET status = 'CLOSED', metadata = '{"closed_reason":"period end"}'::jsonb
  WHERE id = 'f5000000-0000-0000-0004-00000000000a';
UPDATE inventory_documents SET status = 'POSTED'
  WHERE id = 'f5000000-0000-0000-0004-00000000000a';

\echo '### T55 F-915  deleting a POSTED inventory document -> expect REJECT via POSTED_IMMUTABLE'
DELETE FROM inventory_documents WHERE id = 'f5000000-0000-0000-0004-00000000000a';

\echo '### T56 F-915  editing a movement of a POSTED inventory document -> expect REJECT via POSTED_IMMUTABLE'
-- The movement is what the journal's amounts were built from. Changing its
-- quantity after posting is doc 08's "posted movement is immutable" defect,
-- verbatim.
UPDATE inventory_movements SET quantity = 12, total_cost = 60
  WHERE id = 'f5000000-0000-0000-0005-000000000001';

\echo '### T57 F-915  deleting a movement of a POSTED inventory document -> expect REJECT via POSTED_IMMUTABLE'
DELETE FROM inventory_movements WHERE id = 'f5000000-0000-0000-0005-000000000001';

\echo '### T58 F-915  adding a movement to a POSTED inventory document -> expect REJECT via POSTED_IMMUTABLE'
-- INSERT, not only UPDATE — T33's reason: a document whose journal is already
-- written must not acquire a movement afterwards. This is what forces the
-- posting service to write costs before it flips status, not after.
INSERT INTO inventory_movements(id,tenant_id,legal_entity_id,inventory_document_id,line_no,item_id,to_location_id,movement_date,quantity,uom)
  VALUES ('f5000000-0000-0000-0005-000000000005','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','f5000000-0000-0000-0004-00000000000a',2,'f5000000-0000-0000-0003-000000000001','f5000000-0000-0000-0002-000000000001','2026-01-10',5,'EA');

\echo '### T59 F-915  insert, edit and delete a movement while the document is DRAFT -> expect ACCEPT'
-- The other half of T56-T58. A DRAFT document is being written; a guard that
-- refused these would make it impossible to ever build the document the posting
-- service posts.
INSERT INTO inventory_movements(id,tenant_id,legal_entity_id,inventory_document_id,line_no,item_id,to_location_id,movement_date,quantity,uom)
  VALUES ('f5000000-0000-0000-0005-000000000003','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','f5000000-0000-0000-0004-00000000000b',2,'f5000000-0000-0000-0003-000000000001','f5000000-0000-0000-0002-000000000001','2026-01-15',5,'EA');
UPDATE inventory_movements SET quantity = 7 WHERE id = 'f5000000-0000-0000-0005-000000000003';
DELETE FROM inventory_movements WHERE id = 'f5000000-0000-0000-0005-000000000003';

\echo '### T60 F-915  deleting a cost layer -> expect REJECT via POSTED_IMMUTABLE'
-- Phase 5 exit criterion: COGS is reproducible from stored layers and
-- consumptions. A deleted layer is a reproduction that no longer reproduces.
DELETE FROM inventory_cost_layers WHERE id = 'f5000000-0000-0000-0006-000000000001';

\echo '### T61 F-915  changing what a cost layer received -> expect REJECT via POSTED_IMMUTABLE'
UPDATE inventory_cost_layers SET original_quantity = 12
  WHERE id = 'f5000000-0000-0000-0006-000000000001';

\echo '### T62 F-915  repointing a cost layer at a different movement -> expect REJECT via POSTED_IMMUTABLE'
-- The layer's provenance. A layer that can change which movement created it can
-- launder any quantity into any receipt.
UPDATE inventory_cost_layers SET source_movement_id = 'f5000000-0000-0000-0005-000000000002'
  WHERE id = 'f5000000-0000-0000-0006-000000000001';

\echo '### T63 F-915  changing a cost layer received date -> expect REJECT via POSTED_IMMUTABLE'
-- received_date is the FIFO ordering key (ADR-0004 s3). Moving it re-orders
-- history that consumption already walked in the original order.
UPDATE inventory_cost_layers SET received_date = '2026-01-02'
  WHERE id = 'f5000000-0000-0000-0006-000000000001';

\echo '### T64 F-915  re-costing a NON-provisional layer -> expect REJECT via POSTED_IMMUTABLE'
-- C1 already consumed 4 units of this layer at 5.00. A new unit cost would
-- orphan that COGS: the stored consumption and the layer it cites would
-- disagree about the same units forever.
UPDATE inventory_cost_layers SET unit_cost = 7
  WHERE id = 'f5000000-0000-0000-0006-000000000001';

\echo '### T65 F-915  FIFO consumption drawing remaining_quantity down -> expect ACCEPT'
-- The ACCEPT half the layer guard must not break: this is every stock issue in
-- the system (it records C1's 4 units). A guard that froze remaining_quantity
-- would be trivially immutable and would also end issuing stock.
UPDATE inventory_cost_layers SET remaining_quantity = 6
  WHERE id = 'f5000000-0000-0000-0006-000000000001';

\echo '### T66 F-915  settling a PROVISIONAL layer to its real cost -> expect ACCEPT'
-- Cost settlement, doc 08: the one path that may re-cost a layer, and only a
-- layer that was provisional to begin with. A guard that blocked this would
-- make provisional costing impossible to ever settle. The settlement flips
-- is_provisional off, which is what arms T67.
UPDATE inventory_cost_layers
   SET unit_cost = 4.5, is_provisional = false, status = 'SETTLED', settled_at = now()
 WHERE id = 'f5000000-0000-0000-0006-000000000002';

\echo '### T67 F-915  re-costing the same layer AFTER settlement -> expect REJECT via POSTED_IMMUTABLE'
-- Settlement happens once. The guard reads OLD.is_provisional, so the flip in
-- T66 is what closed the door — a second "settlement" is now an ordinary
-- re-cost of a real layer, refused like T64.
UPDATE inventory_cost_layers SET unit_cost = 9
  WHERE id = 'f5000000-0000-0000-0006-000000000002';

\echo '### T68 F-915  editing a cost consumption -> expect REJECT via POSTED_IMMUTABLE'
-- The consumption row IS the COGS calculation — layer, quantity, cost. There is
-- no legitimate second version of a calculation that already happened; a
-- correction is a reverse movement with consumptions of its own (which is why
-- INSERT stays open — T52 exercised it).
UPDATE inventory_cost_consumptions SET quantity = 3, total_cost = 15
  WHERE id = 'f5000000-0000-0000-0007-000000000001';

\echo '### T69 F-915  deleting a cost consumption -> expect REJECT via POSTED_IMMUTABLE'
DELETE FROM inventory_cost_consumptions WHERE id = 'f5000000-0000-0000-0007-000000000001';

\echo '### T70 fixture  two assets with books, a POSTED January schedule line and a SCHEDULED February one -> expect ACCEPT'
-- Its own scenario, for T26's reason. The February period exists only here —
-- the base fixture stops at January — and the second asset book is what T74
-- needs to prove the guard permits genuinely new depreciation.
INSERT INTO accounts(id,tenant_id,legal_entity_id,code,name,account_type,normal_balance) VALUES
  ('f5000000-0000-0000-0008-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','1500','Fixed assets','ASSET','DEBIT'),
  ('f5000000-0000-0000-0008-000000000002','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','1510','Accumulated depreciation','ASSET','CREDIT'),
  ('f5000000-0000-0000-0008-000000000003','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','6100','Depreciation expense','EXPENSE','DEBIT');
INSERT INTO accounting_periods(id,tenant_id,legal_entity_id,fiscal_year_id,period_no,name,start_date,end_date)
  VALUES ('f5000000-0000-0000-000c-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','66666666-6666-6666-6666-666666666666',2,'Feb-26','2026-02-01','2026-02-28');
INSERT INTO asset_categories(id,tenant_id,legal_entity_id,code,name,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id)
  VALUES ('f5000000-0000-0000-0009-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','MACH','Machinery','f5000000-0000-0000-0008-000000000001','f5000000-0000-0000-0008-000000000002','f5000000-0000-0000-0008-000000000003');
INSERT INTO fixed_assets(id,tenant_id,legal_entity_id,asset_category_id,asset_number,name,currency,acquisition_cost,acquisition_date,in_service_date,status) VALUES
  ('f5000000-0000-0000-000a-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','f5000000-0000-0000-0009-000000000001','FA-1','Lathe','USD',1200,'2026-01-01','2026-01-01','ACTIVE'),
  ('f5000000-0000-0000-000a-000000000002','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','f5000000-0000-0000-0009-000000000001','FA-2','Press','USD',2400,'2026-01-01','2026-01-01','ACTIVE');
INSERT INTO asset_books(id,tenant_id,fixed_asset_id,accounting_book_id,legal_entity_id,method,useful_life_months,depreciation_start_date,cost_basis) VALUES
  ('f5000000-0000-0000-000b-000000000001','11111111-1111-1111-1111-111111111111','f5000000-0000-0000-000a-000000000001','55555555-5555-5555-5555-555555555555','33333333-3333-3333-3333-333333333333','STRAIGHT_LINE',12,'2026-01-01',1200),
  ('f5000000-0000-0000-000b-000000000002','11111111-1111-1111-1111-111111111111','f5000000-0000-0000-000a-000000000002','55555555-5555-5555-5555-555555555555','33333333-3333-3333-3333-333333333333','STRAIGHT_LINE',24,'2026-01-01',2400);
-- Run one already happened for the lathe in January: its line is POSTED with a
-- journal (dsl_posted_has_journal). February is scheduled and untouched.
INSERT INTO depreciation_schedule_lines(id,tenant_id,asset_book_id,legal_entity_id,accounting_period_id,scheduled_amount,posted_amount,status,journal_entry_id) VALUES
  ('f5000000-0000-0000-000d-000000000001','11111111-1111-1111-1111-111111111111','f5000000-0000-0000-000b-000000000001','33333333-3333-3333-3333-333333333333','77777777-7777-7777-7777-777777777777',100,100,'POSTED','c0000000-0000-0000-0000-000000000001'),
  ('f5000000-0000-0000-000d-000000000002','11111111-1111-1111-1111-111111111111','f5000000-0000-0000-000b-000000000001','33333333-3333-3333-3333-333333333333','f5000000-0000-0000-000c-000000000001',100,0,'SCHEDULED',NULL);

\echo '### T71 F-916  a rerun overwriting a POSTED schedule line -> expect REJECT via POSTED_IMMUTABLE'
-- The exact shape 0013's UNIQUE cannot see: run two finds the existing line and
-- UPDATEs posted_amount and journal_entry_id to its own journal. Nothing is
-- inserted, so the index never fires — two journals, one line, the second
-- overwriting the evidence of the first. This was exit criterion 5's gap.
UPDATE depreciation_schedule_lines
   SET posted_amount = 175, journal_entry_id = 'c0000000-0000-0000-0000-000000000004'
 WHERE id = 'f5000000-0000-0000-000d-000000000001';

\echo '### T72 F-916  deleting a POSTED schedule line -> expect REJECT via POSTED_IMMUTABLE'
-- Delete-and-recreate is the way around the UNIQUE; the guard's DELETE branch
-- and the F-920 revocation below are the two controls that close it.
DELETE FROM depreciation_schedule_lines WHERE id = 'f5000000-0000-0000-000d-000000000001';

\echo '### T73 F-916  re-estimating a SCHEDULED line -> expect ACCEPT'
-- Accept half (a): prospective re-estimation under doc 09 lives on SCHEDULED
-- lines. A guard that locked the whole table would pass T71/T72 and also make
-- every useful-life change impossible.
UPDATE depreciation_schedule_lines SET scheduled_amount = 95, revision = 2
  WHERE id = 'f5000000-0000-0000-000d-000000000002';

\echo '### T74 F-916  a different asset book depreciating in the SAME period -> expect ACCEPT'
-- Accept half (b), and the one that matters most: without it, a guard that
-- simply refused all depreciation would pass every scenario above. A genuinely
-- new asset book's January line inserts (the UNIQUE constrains the pair, not
-- the period) and posts through the SCHEDULED -> POSTED transition run one uses.
INSERT INTO depreciation_schedule_lines(id,tenant_id,asset_book_id,legal_entity_id,accounting_period_id,scheduled_amount)
  VALUES ('f5000000-0000-0000-000d-000000000003','11111111-1111-1111-1111-111111111111','f5000000-0000-0000-000b-000000000002','33333333-3333-3333-3333-333333333333','77777777-7777-7777-7777-777777777777',100);
UPDATE depreciation_schedule_lines
   SET status = 'POSTED', posted_amount = 100, journal_entry_id = 'c0000000-0000-0000-0000-000000000001'
 WHERE id = 'f5000000-0000-0000-000d-000000000003';

\echo '### T75 fixture  an APPROVED budget and the DRAFT revision beside it, one line each -> expect ACCEPT'
-- Its own scenario, for T26's reason. The line is written while the budget is
-- DRAFT and the budget approved afterwards, because the guard being tested
-- refuses a line on an approved budget — including the one this fixture needs.
INSERT INTO budgets(id,tenant_id,legal_entity_id,accounting_book_id,fiscal_year_id,name,version,currency)
  VALUES ('f5000000-0000-0000-000e-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','66666666-6666-6666-6666-666666666666','OPEX-26',1,'USD');
INSERT INTO budget_lines(id,tenant_id,budget_id,legal_entity_id,accounting_period_id,account_id,amount,currency)
  VALUES ('f5000000-0000-0000-000f-000000000001','11111111-1111-1111-1111-111111111111','f5000000-0000-0000-000e-000000000001','33333333-3333-3333-3333-333333333333','77777777-7777-7777-7777-777777777777','a0000000-0000-0000-0000-000000000002',12000,'USD');
UPDATE budgets SET status = 'APPROVED', approved_at = now()
  WHERE id = 'f5000000-0000-0000-000e-000000000001';
-- The revision doc 10 prescribes: a NEW version, still DRAFT, freely editable.
INSERT INTO budgets(id,tenant_id,legal_entity_id,accounting_book_id,fiscal_year_id,name,version,currency,supersedes_budget_id)
  VALUES ('f5000000-0000-0000-000e-000000000002','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','66666666-6666-6666-6666-666666666666','OPEX-26',2,'USD','f5000000-0000-0000-000e-000000000001');
INSERT INTO budget_lines(id,tenant_id,budget_id,legal_entity_id,accounting_period_id,account_id,amount,currency)
  VALUES ('f5000000-0000-0000-000f-000000000002','11111111-1111-1111-1111-111111111111','f5000000-0000-0000-000e-000000000002','33333333-3333-3333-3333-333333333333','77777777-7777-7777-7777-777777777777','a0000000-0000-0000-0000-000000000002',9000,'USD');

\echo '### T76 F-917  editing a line of an APPROVED budget -> expect REJECT via BUDGET_IMMUTABLE'
-- guard_budget_versioning (0014) froze four header columns; doc 10's "never
-- overwrite approved budget" is about the amounts, and the amounts are here.
-- NOTE (F-809): BUDGET_IMMUTABLE is not in GUARD_PREFIXES
-- (packages/database/src/errors.ts) — callers currently see this refusal only
-- via the SQLSTATE fallback, with the guard's message discarded.
UPDATE budget_lines SET amount = 20000
  WHERE id = 'f5000000-0000-0000-000f-000000000001';

\echo '### T77 F-917  deleting a line of an APPROVED budget -> expect REJECT via BUDGET_IMMUTABLE'
DELETE FROM budget_lines WHERE id = 'f5000000-0000-0000-000f-000000000001';

\echo '### T78 F-917  adding a line to an APPROVED budget -> expect REJECT via BUDGET_IMMUTABLE'
-- A line added to an approved budget changes the approved total as surely as an
-- edit does.
INSERT INTO budget_lines(id,tenant_id,budget_id,legal_entity_id,accounting_period_id,account_id,amount,currency)
  VALUES ('f5000000-0000-0000-000f-000000000004','11111111-1111-1111-1111-111111111111','f5000000-0000-0000-000e-000000000001','33333333-3333-3333-3333-333333333333','77777777-7777-7777-7777-777777777777','a0000000-0000-0000-0000-000000000002',5000,'USD');

\echo '### T79 F-917  walking a line OUT of an approved budget into the draft -> expect REJECT via BUDGET_IMMUTABLE'
-- Both sides of an UPDATE are checked, so a line cannot be re-parented into the
-- draft revision and edited there. Only the OLD side is approved here; a guard
-- that looked only at NEW.budget_id would let this through.
UPDATE budget_lines SET budget_id = 'f5000000-0000-0000-000e-000000000002'
  WHERE id = 'f5000000-0000-0000-000f-000000000001';

\echo '### T80 F-917  the lines of the DRAFT revision stay freely editable -> expect ACCEPT'
-- The other half. Revision IS the mechanism doc 10 prescribes; a guard that
-- refused these would leave no legal way to ever change a budget again.
UPDATE budget_lines SET amount = 8000 WHERE id = 'f5000000-0000-0000-000f-000000000002';
INSERT INTO budget_lines(id,tenant_id,budget_id,legal_entity_id,accounting_period_id,account_id,amount,currency)
  VALUES ('f5000000-0000-0000-000f-000000000003','11111111-1111-1111-1111-111111111111','f5000000-0000-0000-000e-000000000002','33333333-3333-3333-3333-333333333333','77777777-7777-7777-7777-777777777777','a0000000-0000-0000-0000-000000000002',1000,'USD');
DELETE FROM budget_lines WHERE id = 'f5000000-0000-0000-000f-000000000003';

\echo '### T81 F-918  posting a transfer that does not net to zero -> expect REJECT at COMMIT via TRANSFER_UNBALANCED'
-- 60 out of bin A-01, 40 into A-02: a transfer that quietly destroyed 20 units
-- wearing a transfer's accounting (no COGS, no gain). Deferred like T49's
-- SPLIT_UNBALANCED and for the same reason — the out and in movements arrive
-- one INSERT at a time — so the scenario needs the explicit BEGIN/COMMIT for
-- the rejection to happen at COMMIT inside its own block.
-- NOTE (F-809): TRANSFER_UNBALANCED is in neither GUARD_PREFIXES nor the
-- SQLSTATE map (23000) in packages/database/src/errors.ts — a caller currently
-- sees this guard as a 500 INTERNAL.
BEGIN;
INSERT INTO inventory_documents(id,tenant_id,legal_entity_id,accounting_book_id,document_type,document_number,document_date,posting_date,warehouse_id)
  VALUES ('f5000000-0000-0000-0004-0000000000d1','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','TRANSFER','TRF-P5-1','2026-01-20','2026-01-20','f5000000-0000-0000-0001-000000000001');
INSERT INTO inventory_movements(tenant_id,legal_entity_id,inventory_document_id,line_no,item_id,from_location_id,movement_date,quantity,uom) VALUES
  ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','f5000000-0000-0000-0004-0000000000d1',1,'f5000000-0000-0000-0003-000000000001','f5000000-0000-0000-0002-000000000001','2026-01-20',-60,'EA');
INSERT INTO inventory_movements(tenant_id,legal_entity_id,inventory_document_id,line_no,item_id,to_location_id,movement_date,quantity,uom) VALUES
  ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','f5000000-0000-0000-0004-0000000000d1',2,'f5000000-0000-0000-0003-000000000001','f5000000-0000-0000-0002-000000000002','2026-01-20',40,'EA');
UPDATE inventory_documents SET status = 'POSTED' WHERE id = 'f5000000-0000-0000-0004-0000000000d1';
COMMIT;

\echo '### T82 F-918  posting a transfer that nets to zero per item -> expect ACCEPT'
-- Asserted so the guard cannot be "fixed" by refusing every transfer, which
-- would end moving stock between warehouses.
BEGIN;
INSERT INTO inventory_documents(id,tenant_id,legal_entity_id,accounting_book_id,document_type,document_number,document_date,posting_date,warehouse_id)
  VALUES ('f5000000-0000-0000-0004-0000000000d2','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','TRANSFER','TRF-P5-2','2026-01-21','2026-01-21','f5000000-0000-0000-0001-000000000001');
INSERT INTO inventory_movements(tenant_id,legal_entity_id,inventory_document_id,line_no,item_id,from_location_id,movement_date,quantity,uom) VALUES
  ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','f5000000-0000-0000-0004-0000000000d2',1,'f5000000-0000-0000-0003-000000000001','f5000000-0000-0000-0002-000000000001','2026-01-21',-60,'EA');
INSERT INTO inventory_movements(tenant_id,legal_entity_id,inventory_document_id,line_no,item_id,to_location_id,movement_date,quantity,uom) VALUES
  ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','f5000000-0000-0000-0004-0000000000d2',2,'f5000000-0000-0000-0003-000000000001','f5000000-0000-0000-0002-000000000002','2026-01-21',60,'EA');
UPDATE inventory_documents SET status = 'POSTED' WHERE id = 'f5000000-0000-0000-0004-0000000000d2';
COMMIT;

\echo '### T83 F-918  a half-built DRAFT transfer, unbalanced and left DRAFT -> expect ACCEPT'
-- Its own scenario for two reasons. It is T84's fixture, and the runner rolls a
-- rejected block back (T26's lesson), so it cannot ride inside T84. And it is
-- an assertion in itself: a DRAFT entered across several requests is
-- legitimately half-built between them, and a guard that checked balance before
-- posting would reject the first half of every legal transfer.
INSERT INTO inventory_documents(id,tenant_id,legal_entity_id,accounting_book_id,document_type,document_number,document_date,posting_date,warehouse_id)
  VALUES ('f5000000-0000-0000-0004-0000000000d3','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','TRANSFER','TRF-P5-3','2026-01-22','2026-01-22','f5000000-0000-0000-0001-000000000001');
INSERT INTO inventory_movements(tenant_id,legal_entity_id,inventory_document_id,line_no,item_id,from_location_id,movement_date,quantity,uom) VALUES
  ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','f5000000-0000-0000-0004-0000000000d3',1,'f5000000-0000-0000-0003-000000000001','f5000000-0000-0000-0002-000000000001','2026-01-22',-60,'EA');
INSERT INTO inventory_movements(tenant_id,legal_entity_id,inventory_document_id,line_no,item_id,to_location_id,movement_date,quantity,uom) VALUES
  ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','f5000000-0000-0000-0004-0000000000d3',2,'f5000000-0000-0000-0003-000000000001','f5000000-0000-0000-0002-000000000002','2026-01-22',40,'EA');

\echo '### T84 F-918  posting that draft WITHOUT touching its movements -> expect REJECT at COMMIT via TRANSFER_UNBALANCED'
-- The document-side trigger, isolated. This posting transaction touches no
-- movement row, so the movement-side trigger never queues — 0043 installs the
-- trigger on BOTH tables precisely because a movement-side trigger alone would
-- let this exact case straight through.
BEGIN;
UPDATE inventory_documents SET status = 'POSTED' WHERE id = 'f5000000-0000-0000-0004-0000000000d3';
COMMIT;

\echo '### T85 F-919  an item negative-stock policy outside the taxonomy -> expect REJECT via items_negative_stock_policy_chk'
-- 0043 installs the policy DATA at doc 08's grain (item, with a per-entity
-- override); enforcement is layer_remaining_bounded (0012) plus the
-- provisional-layer path, which only a permitting policy may take. What is
-- structural here is that the policy can only ever hold a value the consumption
-- service's resolution understands.
UPDATE items SET negative_stock_policy = 'NEGATIVE_OK'
  WHERE id = 'f5000000-0000-0000-0003-000000000001';

\echo '### T86 F-919  a per-entity override outside the taxonomy -> expect REJECT via ias_negative_stock_policy_chk'
INSERT INTO item_accounting_settings(item_id,legal_entity_id,tenant_id,negative_stock_policy)
  VALUES ('f5000000-0000-0000-0003-000000000001','33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111','SOMETIMES');

\echo '### T87 F-919  the item permits, the entity overrides, the override can revert to inherit -> expect ACCEPT'
-- The resolution chain doc 08 requires, written as data: override -> item ->
-- entity, most specific wins, NULL meaning "inherit the item's". T86 rolled its
-- row back, so the override row is created here.
UPDATE items SET negative_stock_policy = 'ALLOW_PROVISIONAL'
  WHERE id = 'f5000000-0000-0000-0003-000000000001';
INSERT INTO item_accounting_settings(item_id,legal_entity_id,tenant_id,negative_stock_policy)
  VALUES ('f5000000-0000-0000-0003-000000000001','33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111','BLOCK');
UPDATE item_accounting_settings SET negative_stock_policy = NULL
  WHERE item_id = 'f5000000-0000-0000-0003-000000000001'
    AND legal_entity_id = '33333333-3333-3333-3333-333333333333';

\echo '### T88 F-920  app_runtime cannot DELETE the Phase 5 accounting facts, and can still write them -> expect ACCEPT'
-- Both privilege layers, both directions. The catalog half reads
-- has_table_privilege so a later GRANT restoring what 0043 revoked fails the
-- suite whatever role the harness runs as; the demonstration half actually
-- attempts the DELETEs as app_runtime (T23's old technique, legitimate here
-- because no SECURITY DEFINER is involved) when the harness role is able to SET
-- ROLE. WHERE false makes each attempt reach the privilege check and touch
-- nothing. The write-path assertions are the ACCEPT half: 0038's lesson is that
-- a revocation sweep that over-reaches makes posting itself impossible.
DO $$
DECLARE
  v_table    text;
  v_tables   text[] := ARRAY['inventory_movements','inventory_cost_layers',
                             'inventory_cost_consumptions','depreciation_schedule_lines'];
  v_problems text[] := ARRAY[]::text[];
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    IF has_table_privilege('app_runtime', v_table, 'DELETE') THEN
      v_problems := v_problems || (v_table || ': app_runtime holds DELETE (revocation undone)');
    END IF;
  END LOOP;
  IF NOT has_table_privilege('app_runtime', 'inventory_cost_layers', 'UPDATE') THEN
    v_problems := v_problems || 'inventory_cost_layers: app_runtime lost UPDATE; consumption could not draw layers down';
  END IF;
  IF NOT has_table_privilege('app_runtime', 'inventory_movements', 'INSERT') THEN
    v_problems := v_problems || 'inventory_movements: app_runtime lost INSERT; posting a movement would be impossible';
  END IF;

  IF pg_has_role(current_user, 'app_runtime', 'MEMBER') THEN
    PERFORM set_config('role', 'app_runtime', true);
    FOREACH v_table IN ARRAY v_tables LOOP
      BEGIN
        EXECUTE format('DELETE FROM %I WHERE false', v_table);
        v_problems := v_problems || (v_table || ': DELETE executed as app_runtime');
      EXCEPTION WHEN insufficient_privilege THEN
        NULL;  -- the refusal Gate C requires
      END;
    END LOOP;
    PERFORM set_config('role', 'none', true);
  END IF;

  IF cardinality(v_problems) > 0 THEN
    RAISE EXCEPTION 'F-920: %', array_to_string(v_problems, '; ');
  END IF;
END $$;

-- =============================================================================
-- Phase 5 — isolation and the operational-fact guards (migrations 0042/0043).
-- Appended concurrently with T52-T88 above and renumbered T89-T117 so every
-- scenario keeps a unique number; fixture codes WH1B / MACH2 / FA-3 sidestep
-- the UNIQUE keys the T52/T70 fixtures already hold (WH1, MACH, FA-1).
-- =============================================================================

\echo '### T89 fixture  warehouses, locations, an item, and entity-two scaffolding -> expect ACCEPT'
-- Its own labelled scenario, for T26 reason: a fixture inside a rejected block
-- is rolled back and everything after it asserts against nothing. Entity two
-- gets a warehouse, a bin, a fiscal year and a period so the cross-entity
-- scenarios below violate exactly ONE scope key each — a row that trips two
-- constraints at once is rejected by whichever fires first, which is not what
-- the label would be claiming to test.
INSERT INTO warehouses(id,tenant_id,legal_entity_id,code,name) VALUES
  ('aa000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','WH1B','Main'),
  ('aa000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444444','WH2','Entity two');
INSERT INTO warehouse_locations(id,tenant_id,warehouse_id,legal_entity_id,code,name) VALUES
  ('ab000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','aa000000-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','A-01','Receiving'),
  ('ab000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','aa000000-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','A-02','Storage'),
  ('ab000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','aa000000-0000-0000-0000-000000000002','44444444-4444-4444-4444-444444444444','B-01','Entity two bin');
INSERT INTO items(id,tenant_id,organization_id,sku,name,kind,base_uom)
  VALUES ('ac000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','SKU-1','Widget','INVENTORY','EA');
INSERT INTO fiscal_years(id,tenant_id,legal_entity_id,name,start_date,end_date)
  VALUES ('b7000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444444','FY26-E2','2026-01-01','2026-12-31');
INSERT INTO accounting_periods(id,tenant_id,legal_entity_id,fiscal_year_id,period_no,name,start_date,end_date)
  VALUES ('b7000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444444','b7000000-0000-0000-0000-000000000001',1,'Jan-26-E2','2026-01-01','2026-01-31');

\echo '### T90 fixture  a POSTED receipt with one movement, and its cost layer -> expect ACCEPT'
-- Created DRAFT and only then marked POSTED, for T26 reason: the guard being
-- tested below refuses a movement on a posted document, including the one the
-- fixture is trying to write. The cost layer is inserted after posting because
-- that is when the posting service writes it — layers deliberately have no
-- INSERT guard.
BEGIN;
INSERT INTO inventory_documents(id,tenant_id,legal_entity_id,accounting_book_id,document_type,document_date,posting_date,source_type)
  VALUES ('ad000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','RECEIPT','2026-01-10','2026-01-10','OPENING_BALANCE');
INSERT INTO inventory_movements(id,tenant_id,legal_entity_id,inventory_document_id,line_no,item_id,to_location_id,movement_date,quantity,uom,unit_cost,total_cost,currency)
  VALUES ('ae000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','ad000000-0000-0000-0000-000000000001',1,'ac000000-0000-0000-0000-000000000001','ab000000-0000-0000-0000-000000000001','2026-01-10',10,'EA',5,50,'USD');
UPDATE inventory_documents SET status = 'POSTED' WHERE id = 'ad000000-0000-0000-0000-000000000001';
COMMIT;
INSERT INTO inventory_cost_layers(id,tenant_id,legal_entity_id,accounting_book_id,item_id,warehouse_id,source_movement_id,received_date,original_quantity,remaining_quantity,unit_cost,currency)
  VALUES ('af000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','ac000000-0000-0000-0000-000000000001','aa000000-0000-0000-0000-000000000001','ae000000-0000-0000-0000-000000000001','2026-01-10',10,10,5,'USD');

\echo '### T91 F-919  the item default is BLOCK and an entity may override it -> expect ACCEPT'
-- doc 08: "enterprise default should remain block". The SELECT would surface a
-- changed default; the override is per item AND entity, which is the grain
-- item_accounting_settings exists for (F-033).
SELECT negative_stock_policy FROM items WHERE id = 'ac000000-0000-0000-0000-000000000001';
INSERT INTO item_accounting_settings(item_id,legal_entity_id,tenant_id,negative_stock_policy)
  VALUES ('ac000000-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111','ALLOW_PROVISIONAL');

\echo '### T92 F-919  a negative-stock policy that is not a policy -> expect REJECT via items_negative_stock_policy_chk'
UPDATE items SET negative_stock_policy = 'SOMETIMES'
  WHERE id = 'ac000000-0000-0000-0000-000000000001';

\echo '### T93 F-915  changing the posting date of a POSTED inventory document -> expect REJECT via POSTED_IMMUTABLE'
UPDATE inventory_documents SET posting_date = '2026-02-01'
  WHERE id = 'ad000000-0000-0000-0000-000000000001';

\echo '### T94 F-915  annotating a POSTED document -> expect ACCEPT'
-- The other half of T93: metadata is deliberately outside the frozen list. A
-- guard that froze the whole row would be trivially correct and would also make
-- a posted document unannotatable.
UPDATE inventory_documents SET metadata = '{"note":"cycle count verified"}'
  WHERE id = 'ad000000-0000-0000-0000-000000000001';

\echo '### T95 F-915  editing the quantity of a posted movement -> expect REJECT via POSTED_IMMUTABLE'
-- The whole of doc 08 rule: "Posted movement is immutable; correction creates
-- reverse movement." This is the edit it forbids.
UPDATE inventory_movements SET quantity = 12
  WHERE id = 'ae000000-0000-0000-0000-000000000001';

\echo '### T96 F-915  adding a movement to a POSTED document -> expect REJECT via POSTED_IMMUTABLE'
-- INSERT, not only UPDATE: a document whose journal is already written must not
-- acquire a movement afterwards.
INSERT INTO inventory_movements(tenant_id,legal_entity_id,inventory_document_id,line_no,item_id,to_location_id,movement_date,quantity,uom)
  VALUES ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','ad000000-0000-0000-0000-000000000001',2,'ac000000-0000-0000-0000-000000000001','ab000000-0000-0000-0000-000000000001','2026-01-10',3,'EA');

\echo '### T97 F-915  deleting a posted movement -> expect REJECT via POSTED_IMMUTABLE'
DELETE FROM inventory_movements WHERE id = 'ae000000-0000-0000-0000-000000000001';

\echo '### T98 F-915  the correction path: an issue consumes the layer -> expect ACCEPT'
-- The accept half that matters most: consumption INSERTs a calculation row and
-- UPDATEs the layer it drew down. A guard that froze remaining_quantity or
-- refused new consumptions would make every stock issue impossible.
BEGIN;
INSERT INTO inventory_documents(id,tenant_id,legal_entity_id,accounting_book_id,document_type,document_date,posting_date)
  VALUES ('ad000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','ISSUE','2026-01-12','2026-01-12');
INSERT INTO inventory_movements(id,tenant_id,legal_entity_id,inventory_document_id,line_no,item_id,from_location_id,movement_date,quantity,uom,unit_cost,total_cost,currency)
  VALUES ('ae000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','ad000000-0000-0000-0000-000000000002',1,'ac000000-0000-0000-0000-000000000001','ab000000-0000-0000-0000-000000000001','2026-01-12',-4,'EA',5,20,'USD');
UPDATE inventory_documents SET status = 'POSTED' WHERE id = 'ad000000-0000-0000-0000-000000000002';
INSERT INTO inventory_cost_consumptions(id,tenant_id,legal_entity_id,cost_layer_id,inventory_movement_id,quantity,unit_cost,total_cost)
  VALUES ('b1000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','af000000-0000-0000-0000-000000000001','ae000000-0000-0000-0000-000000000002',4,5,20);
UPDATE inventory_cost_layers SET remaining_quantity = 6 WHERE id = 'af000000-0000-0000-0000-000000000001';
COMMIT;

\echo '### T99 F-915  rewriting a stored COGS calculation -> expect REJECT via POSTED_IMMUTABLE'
-- Exit criterion 3: COGS is REPRODUCIBLE from these rows. A calculation that
-- already happened has no legitimate second version.
UPDATE inventory_cost_consumptions SET quantity = 2, total_cost = 10
  WHERE id = 'b1000000-0000-0000-0000-000000000001';

\echo '### T100 F-915  re-costing a layer that is not provisional -> expect REJECT via POSTED_IMMUTABLE'
-- 4 units were already issued at 5.00. Re-costing the layer to 9.00 would
-- orphan that COGS with no journal ever hearing about it.
UPDATE inventory_cost_layers SET unit_cost = 9
  WHERE id = 'af000000-0000-0000-0000-000000000001';

\echo '### T101 F-915  settling a PROVISIONAL layer re-costs it once -> expect ACCEPT'
-- doc 08: "provisional costing and later cost settlement must be deterministic
-- and visible". Settlement is the one path that may touch unit_cost, and only
-- because the layer was provisional to begin with.
INSERT INTO inventory_cost_layers(id,tenant_id,legal_entity_id,accounting_book_id,item_id,warehouse_id,source_movement_id,received_date,original_quantity,remaining_quantity,unit_cost,currency,status,is_provisional)
  VALUES ('af000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','ac000000-0000-0000-0000-000000000001','aa000000-0000-0000-0000-000000000001','ae000000-0000-0000-0000-000000000002','2026-01-12',3,3,5,'USD','PROVISIONAL',true);
UPDATE inventory_cost_layers
   SET unit_cost = 6, is_provisional = false, status = 'SETTLED', settled_at = now()
 WHERE id = 'af000000-0000-0000-0000-000000000002';

\echo '### T102 F-918  a transfer that destroys two units in transit -> expect REJECT at COMMIT via TRANSFER_UNBALANCED'
-- Five out of one bin, three into the other: a transfer wearing an issue's
-- effect with none of its accounting. No COGS, no gain — value just leaks.
BEGIN;
INSERT INTO inventory_documents(id,tenant_id,legal_entity_id,accounting_book_id,document_type,document_date,posting_date)
  VALUES ('ad000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','TRANSFER','2026-01-13','2026-01-13');
INSERT INTO inventory_movements(tenant_id,legal_entity_id,inventory_document_id,line_no,item_id,from_location_id,movement_date,quantity,uom)
  VALUES ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','ad000000-0000-0000-0000-000000000003',1,'ac000000-0000-0000-0000-000000000001','ab000000-0000-0000-0000-000000000001','2026-01-13',-5,'EA');
INSERT INTO inventory_movements(tenant_id,legal_entity_id,inventory_document_id,line_no,item_id,to_location_id,movement_date,quantity,uom)
  VALUES ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','ad000000-0000-0000-0000-000000000003',2,'ac000000-0000-0000-0000-000000000001','ab000000-0000-0000-0000-000000000002','2026-01-13',3,'EA');
UPDATE inventory_documents SET status = 'POSTED' WHERE id = 'ad000000-0000-0000-0000-000000000003';
COMMIT;

\echo '### T103 F-918  a transfer that nets to zero per item -> expect ACCEPT'
-- Asserted so the guard cannot be "fixed" by refusing every transfer, which
-- would make relocating stock impossible.
BEGIN;
INSERT INTO inventory_documents(id,tenant_id,legal_entity_id,accounting_book_id,document_type,document_date,posting_date)
  VALUES ('ad000000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','TRANSFER','2026-01-14','2026-01-14');
INSERT INTO inventory_movements(tenant_id,legal_entity_id,inventory_document_id,line_no,item_id,from_location_id,movement_date,quantity,uom)
  VALUES ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','ad000000-0000-0000-0000-000000000004',1,'ac000000-0000-0000-0000-000000000001','ab000000-0000-0000-0000-000000000001','2026-01-14',-5,'EA');
INSERT INTO inventory_movements(tenant_id,legal_entity_id,inventory_document_id,line_no,item_id,to_location_id,movement_date,quantity,uom)
  VALUES ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','ad000000-0000-0000-0000-000000000004',2,'ac000000-0000-0000-0000-000000000001','ab000000-0000-0000-0000-000000000002','2026-01-14',5,'EA');
UPDATE inventory_documents SET status = 'POSTED' WHERE id = 'ad000000-0000-0000-0000-000000000004';
COMMIT;

\echo '### T104 F-913  a movement into ANOTHER ENTITY''s location -> expect REJECT via im_to_location_scope_fk'
-- T7 and T19, two phases later: it moves no money out of balance, so only the
-- composite key notices. The document and movement are entity one's; the
-- destination bin belongs to entity two.
BEGIN;
INSERT INTO inventory_documents(id,tenant_id,legal_entity_id,accounting_book_id,document_type,document_date,posting_date)
  VALUES ('ad000000-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','ADJUSTMENT','2026-01-15','2026-01-15');
INSERT INTO inventory_movements(tenant_id,legal_entity_id,inventory_document_id,line_no,item_id,to_location_id,movement_date,quantity,uom)
  VALUES ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','ad000000-0000-0000-0000-000000000005',1,'ac000000-0000-0000-0000-000000000001','ab000000-0000-0000-0000-000000000003','2026-01-15',1,'EA');
COMMIT;

\echo '### T105 fixture  an asset category, an asset, a book and a SCHEDULED line -> expect ACCEPT'
INSERT INTO asset_categories(id,tenant_id,legal_entity_id,code,name,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id)
  VALUES ('b2000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','MACH2','Machinery','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000002');
INSERT INTO fixed_assets(id,tenant_id,legal_entity_id,asset_category_id,asset_number,name,currency,acquisition_cost,status)
  VALUES ('b3000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','b2000000-0000-0000-0000-000000000001','FA-3','Lathe','USD',1200,'ACTIVE');
INSERT INTO asset_books(id,tenant_id,fixed_asset_id,accounting_book_id,legal_entity_id,method,useful_life_months,depreciation_start_date,cost_basis)
  VALUES ('b4000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','b3000000-0000-0000-0000-000000000001','55555555-5555-5555-5555-555555555555','33333333-3333-3333-3333-333333333333','STRAIGHT_LINE',12,'2026-01-01',1200);
INSERT INTO depreciation_schedule_lines(id,tenant_id,asset_book_id,legal_entity_id,accounting_period_id,scheduled_amount)
  VALUES ('b5000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','b4000000-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','77777777-7777-7777-7777-777777777777',100);

\echo '### T106 F-916  revising a SCHEDULED line prospectively -> expect ACCEPT'
-- doc 09: "changes to estimate apply prospectively". The lock is on POSTED
-- lines only; a guard that froze SCHEDULED ones would forbid re-estimation.
UPDATE depreciation_schedule_lines SET scheduled_amount = 90, revision = 2
  WHERE id = 'b5000000-0000-0000-0000-000000000001';

\echo '### T107 F-916  the run posts the line -> expect ACCEPT'
UPDATE depreciation_schedule_lines
   SET status = 'POSTED', posted_amount = 90, journal_entry_id = 'c0000000-0000-0000-0000-000000000001'
 WHERE id = 'b5000000-0000-0000-0000-000000000001';

\echo '### T108 F-916  a rerun UPDATEs the already-POSTED line -> expect REJECT via POSTED_IMMUTABLE'
-- The whole of F-916. 0013's UNIQUE constrains INSERT; this rerun never inserts
-- — it finds the line and posts over it, and before 0043 that row was accepted.
UPDATE depreciation_schedule_lines
   SET posted_amount = 180, journal_entry_id = 'c0000000-0000-0000-0000-000000000001'
 WHERE id = 'b5000000-0000-0000-0000-000000000001';

\echo '### T109 F-916  deleting the POSTED line to dodge the UNIQUE -> expect REJECT via POSTED_IMMUTABLE'
DELETE FROM depreciation_schedule_lines WHERE id = 'b5000000-0000-0000-0000-000000000001';

\echo '### T110 fixture  a DRAFT budget whose line is still editable -> expect ACCEPT'
-- Drafting IS editing; doc 10's rule begins at approval.
INSERT INTO budgets(id,tenant_id,legal_entity_id,accounting_book_id,fiscal_year_id,name,currency)
  VALUES ('b6000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','66666666-6666-6666-6666-666666666666','FY26 OPEX','USD');
INSERT INTO budget_lines(id,tenant_id,budget_id,legal_entity_id,accounting_period_id,account_id,amount,currency)
  VALUES ('b8000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','b6000000-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','77777777-7777-7777-7777-777777777777','a0000000-0000-0000-0000-000000000001',1000,'USD');
UPDATE budget_lines SET amount = 1200 WHERE id = 'b8000000-0000-0000-0000-000000000001';

\echo '### T111 F-913  a budget line claiming a different entity than its budget -> expect REJECT via bl_budget_scope_fk'
-- The line's own account and period are entity two's, so both of those keys
-- hold; the only disagreement is with the budget — which is the disagreement
-- every variance report would silently inherit.
INSERT INTO budget_lines(tenant_id,budget_id,legal_entity_id,accounting_period_id,account_id,amount,currency)
  VALUES ('11111111-1111-1111-1111-111111111111','b6000000-0000-0000-0000-000000000001','44444444-4444-4444-4444-444444444444','b7000000-0000-0000-0000-000000000002','b0000000-0000-0000-0000-000000000001',500,'USD');

\echo '### T112 F-917  approving the budget -> expect ACCEPT'
UPDATE budgets SET status = 'APPROVED', approved_at = now()
  WHERE id = 'b6000000-0000-0000-0000-000000000001';

\echo '### T113 F-917  editing an amount of the APPROVED budget -> expect REJECT via BUDGET_IMMUTABLE'
-- guard_budget_versioning (0014) would have allowed this: it protects four
-- header columns, and the amounts are not among them.
UPDATE budget_lines SET amount = 9999 WHERE id = 'b8000000-0000-0000-0000-000000000001';

\echo '### T114 F-917  adding a line to the APPROVED budget -> expect REJECT via BUDGET_IMMUTABLE'
-- A new line changes the approved total as surely as an edit does.
INSERT INTO budget_lines(tenant_id,budget_id,legal_entity_id,accounting_period_id,account_id,amount,currency)
  VALUES ('11111111-1111-1111-1111-111111111111','b6000000-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','77777777-7777-7777-7777-777777777777','a0000000-0000-0000-0000-000000000002',500,'USD');

\echo '### T115 F-917  deleting a line of the APPROVED budget -> expect REJECT via BUDGET_IMMUTABLE'
DELETE FROM budget_lines WHERE id = 'b8000000-0000-0000-0000-000000000001';

\echo '### T116 F-920  DELETE a movement as app_runtime -> expect REJECT via permission'
-- Gate C's second control: the trigger is one layer, and a privilege the
-- application does not hold is the other. 0038 registered its revocations and
-- never executed them, so this scenario is also what stops that recurring.
BEGIN;
SET LOCAL ROLE app_runtime;
DELETE FROM inventory_movements WHERE id = 'ae000000-0000-0000-0000-000000000002';
COMMIT;

\echo '### T117 F-920  app_runtime can still draw a layer down -> expect ACCEPT'
-- The other half: DELETE is revoked, UPDATE is not — consumption and settlement
-- are how the application does its job. A revoke that took UPDATE too would
-- make every stock issue impossible.
BEGIN;
SET LOCAL ROLE app_runtime;
SELECT set_config('app.tenant_id','11111111-1111-1111-1111-111111111111',true);
UPDATE inventory_cost_layers SET remaining_quantity = 5
  WHERE id = 'af000000-0000-0000-0000-000000000001';
COMMIT;

-- =============================================================================
-- Phase 5 exit criterion 5, BOTH halves — migration 0046.
--
-- T105-T109 hold the first half: a POSTED schedule line accepts no second
-- posting, by UNIQUE (asset_book_id, accounting_period_id) and by
-- guard_depreciation_line_posted. What follows is the half 0013's
-- depreciation_runs_posted_uq made unreachable — an asset capitalized into a
-- period that has ALREADY been run still reaching a POSTED run of its own —
-- and the evidence that dropping that index left the first half exactly where
-- it was. The ACCEPT scenarios are the load-bearing ones: a schema that simply
-- refused every second run would pass every REJECT scenario in this file and
-- still fail the criterion.
-- =============================================================================

\echo '### T118 fixture  the month-end run that posted the January line of FA-3 -> expect ACCEPT'
-- The run row T107 posted without: the line was flipped to POSTED first, and
-- guard_depreciation_line_posted now refuses to back-fill its
-- depreciation_run_id, which is the guard doing its job rather than a gap. What
-- matters below is the run row itself — the period now has one POSTED run.
INSERT INTO depreciation_runs(id,tenant_id,legal_entity_id,accounting_book_id,accounting_period_id,version,status,total_amount,journal_entry_id,approved_at)
  VALUES ('b9000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','77777777-7777-7777-7777-777777777777',1,'POSTED',90,'c0000000-0000-0000-0000-000000000001',now());

\echo '### T119 F-916  an asset capitalized into the already-run period gets a SCHEDULED line -> expect ACCEPT'
-- Month end is not an instant. The late vendor bill arrives, FA-4 is
-- capitalized into January, and January has already been depreciated. Its
-- schedule line is SCHEDULED in the same period that holds the POSTED line of
-- FA-3, which the asset-book UNIQUE permits precisely because that UNIQUE is
-- keyed on the ASSET BOOK and not on the period.
INSERT INTO fixed_assets(id,tenant_id,legal_entity_id,asset_category_id,asset_number,name,currency,acquisition_cost,status)
  VALUES ('b9000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','b2000000-0000-0000-0000-000000000001','FA-4','Late press','USD',600,'ACTIVE');
INSERT INTO asset_books(id,tenant_id,fixed_asset_id,accounting_book_id,legal_entity_id,method,useful_life_months,depreciation_start_date,cost_basis)
  VALUES ('b9000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','b9000000-0000-0000-0000-000000000002','55555555-5555-5555-5555-555555555555','33333333-3333-3333-3333-333333333333','STRAIGHT_LINE',12,'2026-01-01',600);
INSERT INTO depreciation_schedule_lines(id,tenant_id,asset_book_id,legal_entity_id,accounting_period_id,scheduled_amount)
  VALUES ('b9000000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','b9000000-0000-0000-0000-000000000003','33333333-3333-3333-3333-333333333333','77777777-7777-7777-7777-777777777777',50);

\echo '### T120 0046  a SECOND POSTED run in a period that already has one -> expect ACCEPT'
-- The whole of 0046. Before it, depreciation_runs_posted_uq was keyed
-- (legal_entity_id, accounting_book_id, accounting_period_id) WHERE status =
-- POSTED, with no asset anywhere in the key, so this INSERT was rejected and
-- FA-4 could never depreciate for the month it entered service. The incremental
-- run posts its OWN journal: replaying the month-end entry would put the charge
-- for FA-4 into a journal that was written before FA-4 existed.
BEGIN;
INSERT INTO journal_entries(id,tenant_id,legal_entity_id,accounting_book_id,journal_id,accounting_period_id,entry_number,posting_date,source_type,base_currency,status,posted_at)
  VALUES ('ba000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','88888888-8888-8888-8888-888888888888','77777777-7777-7777-7777-777777777777','JE-DEP-2','2026-01-31','MANUAL','USD','POSTED',now());
INSERT INTO journal_lines(tenant_id,journal_entry_id,legal_entity_id,accounting_book_id,accounting_period_id,posting_date,line_no,account_id,transaction_currency,transaction_debit,base_currency,base_debit)
  VALUES ('11111111-1111-1111-1111-111111111111','ba000000-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','77777777-7777-7777-7777-777777777777','2026-01-31',1,'a0000000-0000-0000-0000-000000000002','USD',50,'USD',50);
INSERT INTO journal_lines(tenant_id,journal_entry_id,legal_entity_id,accounting_book_id,accounting_period_id,posting_date,line_no,account_id,transaction_currency,transaction_credit,base_currency,base_credit)
  VALUES ('11111111-1111-1111-1111-111111111111','ba000000-0000-0000-0000-000000000001','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','77777777-7777-7777-7777-777777777777','2026-01-31',2,'a0000000-0000-0000-0000-000000000001','USD',50,'USD',50);
INSERT INTO depreciation_runs(id,tenant_id,legal_entity_id,accounting_book_id,accounting_period_id,version,status,total_amount,journal_entry_id,approved_at)
  VALUES ('b9000000-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','77777777-7777-7777-7777-777777777777',2,'POSTED',50,'ba000000-0000-0000-0000-000000000001',now());
UPDATE depreciation_schedule_lines
   SET status = 'POSTED', posted_amount = 50,
       depreciation_run_id = 'b9000000-0000-0000-0000-000000000005',
       journal_entry_id = 'ba000000-0000-0000-0000-000000000001'
 WHERE id = 'b9000000-0000-0000-0000-000000000004';
COMMIT;

\echo '### T121 0046  a second schedule line for an asset book already scheduled in the period -> expect REJECT via depreciation_schedule_lines_asset_book_id_accounting_period_key'
-- The control 0046 traded the run-level key for, still refusing what the run
-- key was only a proxy for: one charge per asset book per period. FA-4
-- depreciated for January in T120; a second line for the same book and period
-- is the double charge, whichever run tries to carry it.
INSERT INTO depreciation_schedule_lines(id,tenant_id,asset_book_id,legal_entity_id,accounting_period_id,scheduled_amount)
  VALUES ('b9000000-0000-0000-0000-000000000006','11111111-1111-1111-1111-111111111111','b9000000-0000-0000-0000-000000000003','33333333-3333-3333-3333-333333333333','77777777-7777-7777-7777-777777777777',50);

\echo '### T122 0046  a rerun UPDATEs the POSTED line of the incremental run -> expect REJECT via POSTED_IMMUTABLE'
-- T108 proved this for the month-end run line. Repeated for the line the SECOND
-- run posted, because that is the line 0046 made reachable: a capability added
-- without the guard following it is how the rerun hole reopens for exactly the
-- assets the new capability serves.
UPDATE depreciation_schedule_lines
   SET posted_amount = 100, journal_entry_id = 'c0000000-0000-0000-0000-000000000001'
 WHERE id = 'b9000000-0000-0000-0000-000000000004';

\echo '### T123 0046  the run key is gone and the two controls it was traded for are present -> expect ACCEPT'
-- The trade, asserted rather than assumed. 0046 refuses to apply without these
-- two; this is the standing check that a later migration cannot quietly drop
-- one of them and leave depreciation idempotency resting on nothing. tgtype
-- 26 = BEFORE (2) + DELETE (8) + UPDATE (16), and the guard reads OLD, so an
-- AFTER or statement-level firing would be too late or blind.
DO $$
BEGIN
  IF to_regclass('depreciation_runs_posted_uq') IS NOT NULL THEN
    RAISE EXCEPTION 'depreciation_runs_posted_uq is back; T120 would be passing for the wrong reason';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indrelid = 'depreciation_schedule_lines'::regclass
       AND i.indisunique AND i.indisvalid AND i.indpred IS NULL
       AND i.indnatts = 2 AND i.indnkeyatts = 2
       AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
              FROM pg_attribute a
             WHERE a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey::smallint[]))
           = ARRAY['accounting_period_id','asset_book_id'])
  THEN
    RAISE EXCEPTION 'depreciation_schedule_lines lost its UNIQUE (asset_book_id, accounting_period_id)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'depreciation_schedule_lines'::regclass
       AND NOT t.tgisinternal
       AND t.tgfoid = to_regproc('guard_depreciation_line_posted')
       AND t.tgenabled <> 'D'
       AND (t.tgtype & 26) = 26)
  THEN
    RAISE EXCEPTION 'guard_depreciation_line_posted no longer fires BEFORE UPDATE OR DELETE FOR EACH ROW';
  END IF;
END $$;

-- =============================================================================
-- F-923 — a reversed issue gives its value back, and only through a reversal.
-- Migration 0048.
--
-- `restoreConsumedLayers` gave back the layer QUANTITIES an issue drew down and
-- wrote no cost fact, while the reversal journal debited the control account by
-- the reversed COGS. For a weighted-average item the valuation is received
-- minus issued over the stored rows (F-922), so it stayed short by exactly that
-- COGS: measured over HTTP on the doc 08 example, a `difference` and an
-- `unexplained` of 254.40 that no reconciling item could name.
--
-- The fix is a stored fact — `inventory_cost_restorations` — and the whole risk
-- of adding one is that it becomes a way around 0043's freeze of consumption
-- rows: a row that cancels a posted COGS calculation would be exactly the
-- second version of a calculation T99 refuses. So the ACCEPT scenarios and the
-- REJECT scenarios below are equally load-bearing. T125, T131 and T133 prove a
-- genuine reversal can record one — a schema that refused every restoration
-- would pass every REJECT here and leave the defect in place — and T126-T130
-- and T132 prove nothing else can.
-- =============================================================================

\echo '### T124 fixture  a 20-unit layer and three issues drawing 6, 5 and 3 from it -> expect ACCEPT'
-- Three separate issues so each scenario below has its own consumption to act
-- on: a REJECT scenario reaching for a row an earlier ACCEPT had already used
-- would be rejected by the wrong control, which is T14's lesson.
BEGIN;
INSERT INTO inventory_documents(id,tenant_id,legal_entity_id,accounting_book_id,document_type,document_date,posting_date,source_type)
  VALUES ('ad000000-0000-0000-0000-000000000006','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','RECEIPT','2026-01-20','2026-01-20','OPENING_BALANCE');
INSERT INTO inventory_movements(id,tenant_id,legal_entity_id,inventory_document_id,line_no,item_id,to_location_id,movement_date,quantity,uom,unit_cost,total_cost,currency)
  VALUES ('ae000000-0000-0000-0000-000000000006','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','ad000000-0000-0000-0000-000000000006',1,'ac000000-0000-0000-0000-000000000001','ab000000-0000-0000-0000-000000000001','2026-01-20',20,'EA',4,80,'USD');
UPDATE inventory_documents SET status = 'POSTED' WHERE id = 'ad000000-0000-0000-0000-000000000006';
INSERT INTO inventory_cost_layers(id,tenant_id,legal_entity_id,accounting_book_id,item_id,warehouse_id,source_movement_id,received_date,original_quantity,remaining_quantity,unit_cost,currency)
  VALUES ('af000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','ac000000-0000-0000-0000-000000000001','aa000000-0000-0000-0000-000000000001','ae000000-0000-0000-0000-000000000006','2026-01-20',20,20,4,'USD');
INSERT INTO inventory_documents(id,tenant_id,legal_entity_id,accounting_book_id,document_type,document_date,posting_date)
  VALUES ('ad000000-0000-0000-0000-000000000007','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','ISSUE','2026-01-21','2026-01-21');
INSERT INTO inventory_movements(id,tenant_id,legal_entity_id,inventory_document_id,line_no,item_id,from_location_id,movement_date,quantity,uom,unit_cost,total_cost,currency)
  VALUES ('ae000000-0000-0000-0000-000000000007','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','ad000000-0000-0000-0000-000000000007',1,'ac000000-0000-0000-0000-000000000001','ab000000-0000-0000-0000-000000000001','2026-01-21',-6,'EA',4,24,'USD');
UPDATE inventory_documents SET status = 'POSTED' WHERE id = 'ad000000-0000-0000-0000-000000000007';
INSERT INTO inventory_cost_consumptions(id,tenant_id,legal_entity_id,cost_layer_id,inventory_movement_id,quantity,unit_cost,total_cost)
  VALUES ('b1000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','af000000-0000-0000-0000-000000000003','ae000000-0000-0000-0000-000000000007',6,4,24);
INSERT INTO inventory_documents(id,tenant_id,legal_entity_id,accounting_book_id,document_type,document_date,posting_date)
  VALUES ('ad000000-0000-0000-0000-000000000009','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','ISSUE','2026-01-22','2026-01-22');
INSERT INTO inventory_movements(id,tenant_id,legal_entity_id,inventory_document_id,line_no,item_id,from_location_id,movement_date,quantity,uom,unit_cost,total_cost,currency)
  VALUES ('ae000000-0000-0000-0000-000000000009','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','ad000000-0000-0000-0000-000000000009',1,'ac000000-0000-0000-0000-000000000001','ab000000-0000-0000-0000-000000000001','2026-01-22',-5,'EA',4,20,'USD');
UPDATE inventory_documents SET status = 'POSTED' WHERE id = 'ad000000-0000-0000-0000-000000000009';
INSERT INTO inventory_cost_consumptions(id,tenant_id,legal_entity_id,cost_layer_id,inventory_movement_id,quantity,unit_cost,total_cost)
  VALUES ('b1000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','af000000-0000-0000-0000-000000000003','ae000000-0000-0000-0000-000000000009',5,4,20);
INSERT INTO inventory_documents(id,tenant_id,legal_entity_id,accounting_book_id,document_type,document_date,posting_date)
  VALUES ('ad000000-0000-0000-0000-00000000000b','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','ISSUE','2026-01-23','2026-01-23');
INSERT INTO inventory_movements(id,tenant_id,legal_entity_id,inventory_document_id,line_no,item_id,from_location_id,movement_date,quantity,uom,unit_cost,total_cost,currency)
  VALUES ('ae000000-0000-0000-0000-00000000000b','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','ad000000-0000-0000-0000-00000000000b',1,'ac000000-0000-0000-0000-000000000001','ab000000-0000-0000-0000-000000000001','2026-01-23',-3,'EA',4,12,'USD');
UPDATE inventory_documents SET status = 'POSTED' WHERE id = 'ad000000-0000-0000-0000-00000000000b';
INSERT INTO inventory_cost_consumptions(id,tenant_id,legal_entity_id,cost_layer_id,inventory_movement_id,quantity,unit_cost,total_cost)
  VALUES ('b1000000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','af000000-0000-0000-0000-000000000003','ae000000-0000-0000-0000-00000000000b',3,4,12);
UPDATE inventory_cost_layers SET remaining_quantity = 6 WHERE id = 'af000000-0000-0000-0000-000000000003';
COMMIT;

\echo '### T125 F-923  a posted reversal of issue A gives back its consumption -> expect ACCEPT'
-- The scenario the whole migration exists for, and the one a defensive schema
-- would break: the reversal document mirrors the issue inbound, the layer gets
-- its 6 units back, and the restoration records that the 24.00 the issue
-- charged is no longer out of the pool. Without this row the valuation stays
-- 24.00 short of the control account the reversal journal has just re-debited.
BEGIN;
INSERT INTO inventory_documents(id,tenant_id,legal_entity_id,accounting_book_id,document_type,document_date,posting_date,source_type,source_id)
  VALUES ('ad000000-0000-0000-0000-000000000008','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','ISSUE','2026-01-24','2026-01-24','reversal','ad000000-0000-0000-0000-000000000007');
INSERT INTO inventory_movements(id,tenant_id,legal_entity_id,inventory_document_id,line_no,item_id,to_location_id,movement_date,quantity,uom,unit_cost,total_cost,currency)
  VALUES ('ae000000-0000-0000-0000-000000000008','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','ad000000-0000-0000-0000-000000000008',1,'ac000000-0000-0000-0000-000000000001','ab000000-0000-0000-0000-000000000001','2026-01-24',6,'EA',4,24,'USD');
INSERT INTO inventory_cost_restorations(id,tenant_id,legal_entity_id,inventory_cost_consumption_id,inventory_movement_id)
  VALUES ('bb000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','b1000000-0000-0000-0000-000000000002','ae000000-0000-0000-0000-000000000008');
UPDATE inventory_cost_layers SET remaining_quantity = 12 WHERE id = 'af000000-0000-0000-0000-000000000003';
UPDATE inventory_documents SET status = 'POSTED' WHERE id = 'ad000000-0000-0000-0000-000000000008';
COMMIT;

\echo '### T126 F-923  giving the same consumption back twice -> expect REJECT via inventory_cost_restorations_inventory_cost_consumption_id_key'
-- The invariant a signed consumption row could not express, which is why the
-- restoration is its own table: a reversal may return what the issue took and
-- no more. A second restoration puts 24.00 back into a pool that never lost it
-- twice, and only the value side would ever notice.
INSERT INTO inventory_cost_restorations(tenant_id,legal_entity_id,inventory_cost_consumption_id,inventory_movement_id)
  VALUES ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','b1000000-0000-0000-0000-000000000002','ae000000-0000-0000-0000-000000000008');

\echo '### T127 F-923  a reversal of issue A giving back issue B''s consumption -> expect REJECT via POSTED_IMMUTABLE'
-- The way around T99. 0043 freezes consumption rows because a posted
-- calculation has no second version; a restoration cancels one, so being able
-- to point any inbound movement at any consumption would be that second version
-- wearing a different table. The document must be the declared reversal of the
-- document the consumption's issue belongs to, and this one reverses A.
INSERT INTO inventory_cost_restorations(tenant_id,legal_entity_id,inventory_cost_consumption_id,inventory_movement_id)
  VALUES ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','b1000000-0000-0000-0000-000000000003','ae000000-0000-0000-0000-000000000008');

\echo '### T128 F-923  re-pointing a restoration at another movement -> expect REJECT via POSTED_IMMUTABLE'
UPDATE inventory_cost_restorations SET inventory_movement_id = 'ae000000-0000-0000-0000-000000000002'
  WHERE id = 'bb000000-0000-0000-0000-000000000001';

\echo '### T129 F-923  deleting a restoration -> expect REJECT via POSTED_IMMUTABLE'
-- Deleting one takes 24.00 back out of the valuation with no journal saying so
-- — the erasure T99 refuses, from the other side.
DELETE FROM inventory_cost_restorations WHERE id = 'bb000000-0000-0000-0000-000000000001';

\echo '### T130 F-923  a restoration on a reversal that never posts -> expect REJECT at COMMIT via POSTED_IMMUTABLE'
-- The reversal document is necessarily DRAFT while its movements are written
-- (T96: a POSTED document accepts no new movement), so the check is deferred to
-- COMMIT rather than dropped. A draft that is never posted would leave the
-- value restored on the subledger with nothing on the ledger.
BEGIN;
INSERT INTO inventory_documents(id,tenant_id,legal_entity_id,accounting_book_id,document_type,document_date,posting_date,source_type,source_id)
  VALUES ('ad000000-0000-0000-0000-00000000000a','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','ISSUE','2026-01-25','2026-01-25','reversal','ad000000-0000-0000-0000-000000000009');
INSERT INTO inventory_movements(id,tenant_id,legal_entity_id,inventory_document_id,line_no,item_id,to_location_id,movement_date,quantity,uom,unit_cost,total_cost,currency)
  VALUES ('ae000000-0000-0000-0000-00000000000a','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','ad000000-0000-0000-0000-00000000000a',1,'ac000000-0000-0000-0000-000000000001','ab000000-0000-0000-0000-000000000001','2026-01-25',5,'EA',4,20,'USD');
INSERT INTO inventory_cost_restorations(id,tenant_id,legal_entity_id,inventory_cost_consumption_id,inventory_movement_id)
  VALUES ('bb000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','b1000000-0000-0000-0000-000000000003','ae000000-0000-0000-0000-00000000000a');
UPDATE inventory_cost_layers SET remaining_quantity = 17 WHERE id = 'af000000-0000-0000-0000-000000000003';
COMMIT;

\echo '### T131 F-923  the same reversal, posted before COMMIT -> expect ACCEPT'
-- The half that keeps T130 from being satisfied by a schema that refuses every
-- restoration. Identical rows, identical ids — T130 rolled back in full — with
-- the status flip the posting service performs last.
BEGIN;
INSERT INTO inventory_documents(id,tenant_id,legal_entity_id,accounting_book_id,document_type,document_date,posting_date,source_type,source_id)
  VALUES ('ad000000-0000-0000-0000-00000000000a','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','ISSUE','2026-01-25','2026-01-25','reversal','ad000000-0000-0000-0000-000000000009');
INSERT INTO inventory_movements(id,tenant_id,legal_entity_id,inventory_document_id,line_no,item_id,to_location_id,movement_date,quantity,uom,unit_cost,total_cost,currency)
  VALUES ('ae000000-0000-0000-0000-00000000000a','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','ad000000-0000-0000-0000-00000000000a',1,'ac000000-0000-0000-0000-000000000001','ab000000-0000-0000-0000-000000000001','2026-01-25',5,'EA',4,20,'USD');
INSERT INTO inventory_cost_restorations(id,tenant_id,legal_entity_id,inventory_cost_consumption_id,inventory_movement_id)
  VALUES ('bb000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','b1000000-0000-0000-0000-000000000003','ae000000-0000-0000-0000-00000000000a');
UPDATE inventory_cost_layers SET remaining_quantity = 17 WHERE id = 'af000000-0000-0000-0000-000000000003';
UPDATE inventory_documents SET status = 'POSTED' WHERE id = 'ad000000-0000-0000-0000-00000000000a';
COMMIT;

\echo '### T132 F-920  DELETE a restoration as app_runtime -> expect REJECT via permission'
-- Gate C's second control on the new fact, for 0043 section 6's reason: the
-- trigger is one layer and a privilege the application does not hold is the
-- other. The application only ever inserts here.
BEGIN;
SET LOCAL ROLE app_runtime;
SELECT set_config('app.tenant_id','11111111-1111-1111-1111-111111111111',true);
DELETE FROM inventory_cost_restorations WHERE id = 'bb000000-0000-0000-0000-000000000001';
COMMIT;

\echo '### T133 F-923  app_runtime records a whole reversal of issue C -> expect ACCEPT'
-- The other half of T132, and of the revoke that carries it: UPDATE and DELETE
-- are gone and INSERT is not, because reversing a stock issue is the
-- application's job. Run under row-level security with the tenant GUC set, so
-- it also proves the provenance guard can see its subject as the runtime role —
-- a guard whose SELECTs were filtered to nothing by RLS would refuse every
-- legitimate reversal instead, which is a failure no REJECT scenario can see.
BEGIN;
SET LOCAL ROLE app_runtime;
SELECT set_config('app.tenant_id','11111111-1111-1111-1111-111111111111',true);
INSERT INTO inventory_documents(id,tenant_id,legal_entity_id,accounting_book_id,document_type,document_date,posting_date,source_type,source_id)
  VALUES ('ad000000-0000-0000-0000-00000000000c','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','ISSUE','2026-01-26','2026-01-26','reversal','ad000000-0000-0000-0000-00000000000b');
INSERT INTO inventory_movements(id,tenant_id,legal_entity_id,inventory_document_id,line_no,item_id,to_location_id,movement_date,quantity,uom,unit_cost,total_cost,currency)
  VALUES ('ae000000-0000-0000-0000-00000000000c','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','ad000000-0000-0000-0000-00000000000c',1,'ac000000-0000-0000-0000-000000000001','ab000000-0000-0000-0000-000000000001','2026-01-26',3,'EA',4,12,'USD');
INSERT INTO inventory_cost_restorations(id,tenant_id,legal_entity_id,inventory_cost_consumption_id,inventory_movement_id)
  VALUES ('bb000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','b1000000-0000-0000-0000-000000000004','ae000000-0000-0000-0000-00000000000c');
UPDATE inventory_cost_layers SET remaining_quantity = 20 WHERE id = 'af000000-0000-0000-0000-000000000003';
UPDATE inventory_documents SET status = 'POSTED' WHERE id = 'ad000000-0000-0000-0000-00000000000c';
COMMIT;

\echo '### T134 F-923  the controls 0048 installed are all in force -> expect ACCEPT'
-- T123's habit, for the new table. The scenarios above are only worth what the
-- catalog says they are: a later migration that dropped one would leave every
-- REJECT here passing for the wrong reason until someone changed the fixture.
-- tgtype 26 = BEFORE (2) + DELETE (8) + UPDATE (16); 5 = BEFORE (2) + INSERT
-- (4); the deferred one must be initially deferred, because an immediate check
-- would reject every legal reversal instead.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'inventory_cost_restorations'::regclass AND NOT t.tgisinternal
       AND t.tgfoid = to_regproc('guard_cost_restoration_provenance')
       AND t.tgenabled <> 'D' AND (t.tgtype & 5) = 5)
  THEN
    RAISE EXCEPTION 'guard_cost_restoration_provenance no longer fires BEFORE INSERT FOR EACH ROW';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'inventory_cost_restorations'::regclass AND NOT t.tgisinternal
       AND t.tgfoid = to_regproc('reject_mutation_of_posted')
       AND t.tgenabled <> 'D' AND (t.tgtype & 26) = 26)
  THEN
    RAISE EXCEPTION 'a restoration is no longer immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'inventory_cost_restorations'::regclass AND NOT t.tgisinternal
       AND t.tgfoid = to_regproc('assert_restoration_document_posted')
       AND t.tgenabled <> 'D' AND t.tgdeferrable AND t.tginitdeferred)
  THEN
    RAISE EXCEPTION 'the deferred posted-document check on restorations is gone or no longer deferred';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indrelid = 'inventory_cost_restorations'::regclass
       AND i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indnkeyatts = 1
       AND (SELECT a.attname FROM pg_attribute a
             WHERE a.attrelid = i.indrelid AND a.attnum = i.indkey[0]) = 'inventory_cost_consumption_id')
  THEN
    RAISE EXCEPTION 'a consumption can be given back more than once; the UNIQUE is gone';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
      JOIN rls_protected_tables r ON r.table_name = c.relname
     WHERE c.relname = 'inventory_cost_restorations'
       AND c.relrowsecurity AND c.relforcerowsecurity)
  THEN
    RAISE EXCEPTION 'inventory_cost_restorations lost row-level security or its registration';
  END IF;
  IF has_table_privilege('app_runtime','inventory_cost_restorations','UPDATE')
     OR has_table_privilege('app_runtime','inventory_cost_restorations','DELETE') THEN
    RAISE EXCEPTION 'app_runtime regained UPDATE or DELETE on inventory_cost_restorations';
  END IF;
END $$;
