-- =============================================================================
-- 0000 — Extensions, shared types and shared guard functions
-- =============================================================================
-- Requires PostgreSQL 16 (ADR-0008): UNIQUE NULLS NOT DISTINCT, btree_gist,
-- deferrable constraint triggers, composite foreign keys.
--
-- Every enum here replaces a `status text` column from the original blueprint
-- (F-049: status was an enum on 12 tables and free text on 21).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- F-010/F-015/F-025: effective-date EXCLUDE constraints

-- ---------------------------------------------------------------- shared -----
CREATE TYPE record_status     AS ENUM ('ACTIVE','INACTIVE','ARCHIVED');
CREATE TYPE period_status     AS ENUM ('OPEN','SOFT_CLOSED','HARD_CLOSED');
CREATE TYPE approval_status   AS ENUM ('NOT_REQUIRED','PENDING','APPROVED','REJECTED','CANCELLED');
CREATE TYPE actor_type        AS ENUM ('USER','SERVICE','SYSTEM','AI');

-- ---------------------------------------------------------------- ledger -----
CREATE TYPE journal_status    AS ENUM ('DRAFT','SUBMITTED','APPROVED','POSTED','REVERSED');
CREATE TYPE account_type      AS ENUM ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE');
CREATE TYPE normal_balance    AS ENUM ('DEBIT','CREDIT');
CREATE TYPE dimension_rule    AS ENUM ('REQUIRED','OPTIONAL','PROHIBITED','DEFAULTED');
CREATE TYPE book_type         AS ENUM ('PRIMARY','SECONDARY','TAX','MANAGEMENT','CONSOLIDATION');

-- ADR-0001: both retained-earnings methods are supported; the tenant chooses per book.
CREATE TYPE retained_earnings_method AS ENUM ('DERIVED','CLOSING_JOURNAL');

-- --------------------------------------------------------------- documents ---
CREATE TYPE document_status   AS ENUM (
  'DRAFT','PENDING_APPROVAL','APPROVED','POSTED','PARTIALLY_PAID','PAID',
  'VOID','CANCELLED','CLOSED');
CREATE TYPE contact_type      AS ENUM ('CUSTOMER','VENDOR','BOTH');

-- --------------------------------------------------------------- lifecycles --
CREATE TYPE quote_status         AS ENUM ('DRAFT','SENT','ACCEPTED','REJECTED','EXPIRED','CONVERTED');
CREATE TYPE sales_order_status   AS ENUM ('DRAFT','APPROVAL_PENDING','APPROVED','CONFIRMED',
                                          'PARTIALLY_FULFILLED','PARTIALLY_INVOICED','COMPLETED','CANCELLED');
CREATE TYPE requisition_status   AS ENUM ('DRAFT','SUBMITTED','APPROVAL_PENDING','APPROVED','REJECTED','CONVERTED','CLOSED');
CREATE TYPE po_status            AS ENUM ('DRAFT','APPROVAL_PENDING','APPROVED','ISSUED',
                                          'PARTIALLY_RECEIVED','PARTIALLY_BILLED','COMPLETED','CANCELLED','CLOSED');
CREATE TYPE bill_match_status    AS ENUM ('UNMATCHED','MATCHED','WITHIN_TOLERANCE','EXCEPTION','MANUAL_OVERRIDE');
CREATE TYPE payment_run_status   AS ENUM ('DRAFT','APPROVAL_PENDING','APPROVED','EXECUTING','COMPLETED','CANCELLED');
CREATE TYPE payment_status       AS ENUM ('DRAFT','REQUESTED','APPROVED','SENT','PENDING','CONFIRMED','FAILED','POSTED','CANCELLED');
CREATE TYPE expense_claim_status AS ENUM ('DRAFT','SUBMITTED','APPROVAL_PENDING','APPROVED','REJECTED','POSTED','REIMBURSED');

-- ------------------------------------------------------------------ banking --
CREATE TYPE bank_account_type       AS ENUM ('BANK','CREDIT_CARD','CASH','WALLET','PROCESSOR_CLEARING');
CREATE TYPE bank_recon_txn_status   AS ENUM ('UNMATCHED','SUGGESTED','MATCHED','RECONCILED','IGNORED','SPLIT');
CREATE TYPE bank_match_status       AS ENUM ('SUGGESTED','CONFIRMED','REJECTED');
CREATE TYPE reconciliation_status   AS ENUM ('IN_PROGRESS','COMPLETED','REOPENED');
CREATE TYPE bank_connection_status  AS ENUM ('DISCONNECTED','CONNECTED','EXPIRING','EXPIRED','ERROR');

-- ---------------------------------------------------------------- inventory --
CREATE TYPE item_type              AS ENUM ('SERVICE','NON_STOCK','INVENTORY','ASSET_PURCHASE','BUNDLE');
CREATE TYPE valuation_method       AS ENUM ('FIFO','WEIGHTED_AVERAGE','STANDARD','SPECIFIC');
-- ADR-0001: LIFO is prohibited under IFRS and is deliberately absent.
CREATE TYPE inventory_doc_type     AS ENUM ('RECEIPT','ISSUE','TRANSFER','ADJUSTMENT','COUNT',
                                            'CUSTOMER_RETURN','VENDOR_RETURN','WRITE_OFF','LANDED_COST');
CREATE TYPE cost_layer_status      AS ENUM ('OPEN','CONSUMED','PROVISIONAL','SETTLED');
CREATE TYPE location_type          AS ENUM ('RECEIVING','STORAGE','PICKING','QUARANTINE','DAMAGED','RETURNS','IN_TRANSIT');

-- ------------------------------------------------------------------- assets --
CREATE TYPE asset_status           AS ENUM ('DRAFT','ACTIVE','FULLY_DEPRECIATED','IMPAIRED','DISPOSED','WRITTEN_OFF');
CREATE TYPE depreciation_method    AS ENUM ('STRAIGHT_LINE','DECLINING_BALANCE','UNITS_OF_PRODUCTION','CUSTOM');
CREATE TYPE proration_convention   AS ENUM ('EXACT_DAYS','FULL_MONTH','HALF_MONTH','MONTHLY','NONE');
CREATE TYPE depreciation_line_status AS ENUM ('SCHEDULED','POSTED','SKIPPED','REVISED');
CREATE TYPE asset_transaction_type AS ENUM ('ACQUISITION','CAPITALIZATION','TRANSFER','DEPRECIATION',
                                            'IMPAIRMENT','IMPAIRMENT_REVERSAL','REVALUATION','DISPOSAL');
CREATE TYPE disposal_type          AS ENUM ('SALE','SCRAP','LOSS','WRITE_OFF','DONATION');

-- ---------------------------------------------------------- projects/budget --
CREATE TYPE project_status         AS ENUM ('PLANNED','ACTIVE','ON_HOLD','COMPLETED','CLOSED');
CREATE TYPE budget_status          AS ENUM ('DRAFT','REVIEW','APPROVED','ACTIVE','SUPERSEDED','CLOSED');
CREATE TYPE budget_control_policy  AS ENUM ('INFORMATIONAL','WARN','BLOCK','REQUIRE_OVERRIDE');
CREATE TYPE commitment_status      AS ENUM ('OPEN','PARTIALLY_RELIEVED','RELIEVED','CANCELLED');

-- ---------------------------------------------------------------------- tax --
CREATE TYPE tax_type              AS ENUM ('VAT','GST','SALES_TAX','WITHHOLDING','EXCISE','SUPPLEMENTARY','OTHER');
CREATE TYPE tax_treatment         AS ENUM ('STANDARD','ZERO_RATED','EXEMPT','OUTSIDE_SCOPE','REVERSE_CHARGE');
CREATE TYPE tax_period_status     AS ENUM ('OPEN','PREPARING','READY','FILED','AMENDED','CLOSED');
CREATE TYPE einvoice_status       AS ENUM ('PENDING','SUBMITTED','ACCEPTED','REJECTED','CANCELLED');
CREATE TYPE rounding_mode         AS ENUM ('HALF_UP','HALF_EVEN','HALF_DOWN','UP','DOWN','TRUNCATE');

-- ------------------------------------------------------------------- close ---
CREATE TYPE close_run_status      AS ENUM ('OPEN','IN_PROGRESS','READY','COMPLETED','REOPENED');
CREATE TYPE close_task_status     AS ENUM ('OPEN','IN_PROGRESS','BLOCKED','COMPLETED','WAIVED');
CREATE TYPE recon_cert_status     AS ENUM ('DRAFT','PREPARED','CERTIFIED','APPROVED','REOPENED');
CREATE TYPE run_status            AS ENUM ('DRAFT','PREVIEW','POSTED','REVERSED','CANCELLED');

-- ---------------------------------------------------------------- workflow ---
CREATE TYPE task_status           AS ENUM ('OPEN','IN_PROGRESS','COMPLETED','CANCELLED','ESCALATED');
CREATE TYPE task_priority         AS ENUM ('LOW','NORMAL','HIGH','URGENT');
CREATE TYPE approval_decision     AS ENUM ('APPROVE','REJECT','REQUEST_CHANGES','DELEGATE');

-- ------------------------------------------------------------ ops / platform --
CREATE TYPE job_status            AS ENUM ('QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED');
CREATE TYPE delivery_status       AS ENUM ('QUEUED','DELIVERING','SUCCEEDED','FAILED','DEAD_LETTERED');
CREATE TYPE scan_status           AS ENUM ('PENDING','CLEAN','INFECTED','FAILED','SKIPPED');
CREATE TYPE subscription_status   AS ENUM ('TRIAL','ACTIVE','PAST_DUE','RESTRICTED','SUSPENDED','CANCELLED');
CREATE TYPE ai_decision_status    AS ENUM ('PROPOSED','ACCEPTED','REJECTED','EXPIRED','EXECUTED');
CREATE TYPE anomaly_status        AS ENUM ('OPEN','INVESTIGATING','RESOLVED','FALSE_POSITIVE','SUPPRESSED');
CREATE TYPE severity              AS ENUM ('INFO','LOW','MEDIUM','HIGH','CRITICAL');
CREATE TYPE migration_mode        AS ENUM ('OPENING_BALANCES','OPENING_PLUS_SUBLEDGERS','FULL_HISTORY');
CREATE TYPE migration_status      AS ENUM ('DRAFT','UPLOADING','VALIDATING','VALIDATED','IMPORTING',
                                           'IMPORTED','RECONCILING','CUTOVER','FAILED','CANCELLED');

-- =============================================================================
-- Shared guard functions
-- =============================================================================

-- Rejects any mutation of a row belonging to a POSTED accounting fact.
-- ADR-0003 §3. Gate C: "Posted journal application role cannot UPDATE/DELETE
-- protected accounting facts."
CREATE OR REPLACE FUNCTION reject_mutation_of_posted()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'POSTED_IMMUTABLE: % on %.% is not permitted once the accounting fact is POSTED. '
    'Correct posted history by reversal, credit note or adjustment (doc 01 rule 4).',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;

-- Maintains updated_at without the application having to remember.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

COMMENT ON FUNCTION reject_mutation_of_posted() IS
  'ADR-0003 immutability guard. Attached to journal_entries, journal_lines, '
  'journal_line_dimensions, audit_events and filed tax returns.';
