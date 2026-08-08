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

\echo '### T15 F-403  period resolution returns the REGULAR period, not the adjustment period'
SELECT name, is_adjustment FROM accounting_periods
 WHERE id = resolve_accounting_period('33333333-3333-3333-3333-333333333333','2026-01-15');

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
