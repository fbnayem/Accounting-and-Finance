-- =============================================================================
-- 0031 — The system actor
-- =============================================================================
-- Phase 2. `journal_entries.posted_by` and `audit_events.actor_id` are foreign
-- keys to `users`, and the scheduler posts scheduled reversals and recurring
-- journals with no human behind them. There were three options:
--
--   1. Leave posted_by NULL. The column permits it, and the audit trail then says
--      nothing about half the postings in a month-end.
--   2. Attribute the posting to whoever created the schedule. Tempting, and wrong:
--      they authorised the schedule, not this posting into this period, and a
--      reversal that fails because July closed is not their doing.
--   3. A named actor that exists, is visibly not a person, and can never log in.
--
-- This is option 3. `password_hash` is NULL and `status` is INACTIVE, so the
-- credential path in apps/api/src/auth rejects it before it looks at anything else;
-- there is no password to guess because there is no password.
--
-- The id is fixed rather than generated: the worker needs it at startup without a
-- lookup, and a constant in a migration is easier to audit than a bootstrapping
-- query that silently creates a second one if the first is missing.
-- =============================================================================

INSERT INTO users (id, email, display_name, password_hash, status, locale)
VALUES (
  '00000000-0000-4000-8000-00000000005c',
  'system@accounting.internal',
  'System (scheduled jobs)',
  NULL,
  'INACTIVE',
  'en'
)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE users IS
  'Platform-level identities (ADR-0005). One row is not a person: the system actor '
  '00000000-0000-4000-8000-00000000005c is what scheduled reversals and recurring journals are '
  'posted by, so posted_by and audit_events.actor_id are never null and never misattributed.';

-- A login attempt would fail on the null password_hash anyway. Asserted rather than
-- assumed, because "the system account cannot log in" is the kind of thing that
-- stops being true when someone adds a password reset flow.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM users
     WHERE id = '00000000-0000-4000-8000-00000000005c'
       AND (password_hash IS NOT NULL OR status = 'ACTIVE')
  ) THEN
    RAISE EXCEPTION 'the system actor must have no password and must not be ACTIVE';
  END IF;
END $$;
