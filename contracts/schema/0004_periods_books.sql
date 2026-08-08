-- =============================================================================
-- 0004 — Fiscal years, accounting periods, accounting books
-- =============================================================================
-- Phase 1. Resolves F-011 (overlapping periods, adjustment periods unmodelled),
-- F-013 (one primary book per entity), F-015 (overlapping fiscal years),
-- F-403 (ambiguous posting-date period resolution).
-- =============================================================================

CREATE TABLE fiscal_years (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  name            text NOT NULL,
  start_date      date NOT NULL,
  end_date        date NOT NULL,
  status          record_status NOT NULL DEFAULT 'ACTIVE',
  CHECK (end_date > start_date),
  UNIQUE (legal_entity_id, name),
  CONSTRAINT fiscal_years_entity_scope_fk
    FOREIGN KEY (legal_entity_id, tenant_id) REFERENCES legal_entities(id, tenant_id),
  CONSTRAINT fiscal_years_scope_uq UNIQUE (id, legal_entity_id)
);
-- F-015: the blueprint's UNIQUE (entity, start, end) prevented exact duplicates
-- only. Two overlapping-but-not-identical years were insertable.
ALTER TABLE fiscal_years ADD CONSTRAINT fiscal_years_no_overlap
  EXCLUDE USING gist (
    legal_entity_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  );

-- ----------------------------------------------------------------------------
-- Accounting periods — F-011.
-- doc 02 requires "monthly standard periods and optional adjustment periods" and
-- "validate no overlap". The blueprint had neither an adjustment flag nor an
-- overlap constraint.
--
-- F-403 / ADR-0003 §7 — period resolution is NORMATIVE:
--   posting_date resolves to the non-adjustment period containing it, UNLESS the
--   caller names an adjustment period AND holds post_to_adjustment_period.
-- Adjustment periods deliberately overlap period 12; that is what they are for,
-- which is why the exclusion constraint covers non-adjustment periods only.
-- ----------------------------------------------------------------------------
CREATE TABLE accounting_periods (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id),
  fiscal_year_id  uuid NOT NULL REFERENCES fiscal_years(id),
  period_no       integer NOT NULL CHECK (period_no > 0),
  name            text NOT NULL,
  start_date      date NOT NULL,
  end_date        date NOT NULL,
  is_adjustment   boolean NOT NULL DEFAULT false,     -- F-011
  status          period_status NOT NULL DEFAULT 'OPEN',
  closed_at       timestamptz,
  closed_by       uuid REFERENCES users(id),
  closed_reason   text,
  reopened_at     timestamptz,
  reopened_by     uuid REFERENCES users(id),
  reopened_reason text,
  version         bigint NOT NULL DEFAULT 1,
  CHECK (end_date >= start_date),
  UNIQUE (legal_entity_id, fiscal_year_id, period_no),
  CONSTRAINT accounting_periods_fy_scope_fk
    FOREIGN KEY (fiscal_year_id, legal_entity_id) REFERENCES fiscal_years(id, legal_entity_id),
  CONSTRAINT accounting_periods_scope_uq UNIQUE (id, legal_entity_id)
);
-- F-011: regular periods may not overlap. Adjustment periods are excluded from
-- the constraint because overlapping period 12 is their purpose.
ALTER TABLE accounting_periods ADD CONSTRAINT accounting_periods_no_overlap
  EXCLUDE USING gist (
    legal_entity_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  ) WHERE (NOT is_adjustment);

CREATE INDEX accounting_periods_lookup_idx
  ON accounting_periods(legal_entity_id, start_date, end_date) WHERE NOT is_adjustment;
CREATE INDEX accounting_periods_status_idx ON accounting_periods(legal_entity_id, status);

-- ----------------------------------------------------------------------------
-- Accounting books
-- ----------------------------------------------------------------------------
CREATE TABLE accounting_books (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  legal_entity_id    uuid NOT NULL REFERENCES legal_entities(id),
  code               text NOT NULL,
  name               text NOT NULL,
  -- F-014 / ADR-0003: THIS is authoritative for posting. legal_entities.
  -- functional_currency is the statutory default that seeds the primary book.
  base_currency      char(3) NOT NULL REFERENCES currencies(code),
  kind               book_type NOT NULL DEFAULT 'PRIMARY',
  is_primary         boolean NOT NULL DEFAULT false,
  status             record_status NOT NULL DEFAULT 'ACTIVE',
  settings           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, code),
  CONSTRAINT accounting_books_entity_scope_fk
    FOREIGN KEY (legal_entity_id, tenant_id) REFERENCES legal_entities(id, tenant_id),
  -- ADR-0002: children reference (id, legal_entity_id, ...) to pin scope.
  CONSTRAINT accounting_books_scope_uq UNIQUE (id, legal_entity_id),
  CONSTRAINT accounting_books_tenant_uq UNIQUE (id, tenant_id)
);
-- F-013: exactly one primary book per entity. Nothing enforced this.
CREATE UNIQUE INDEX accounting_books_one_primary_idx
  ON accounting_books(legal_entity_id) WHERE is_primary;

-- Deferred FKs now that the tables exist.
ALTER TABLE accounting_policies
  ADD CONSTRAINT accounting_policies_book_fk
    FOREIGN KEY (accounting_book_id, legal_entity_id)
    REFERENCES accounting_books(id, legal_entity_id);
ALTER TABLE number_sequences
  ADD CONSTRAINT number_sequences_fy_fk
    FOREIGN KEY (fiscal_year_id, legal_entity_id)
    REFERENCES fiscal_years(id, legal_entity_id);
ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_book_fk FOREIGN KEY (accounting_book_id) REFERENCES accounting_books(id);

-- ----------------------------------------------------------------------------
-- Period resolution helper. Single implementation so no module invents its own
-- (F-403). Returns the regular period; adjustment periods must be named
-- explicitly by a caller holding the permission.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION resolve_accounting_period(
  p_legal_entity_id uuid,
  p_posting_date    date
) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM accounting_periods
   WHERE legal_entity_id = p_legal_entity_id
     AND NOT is_adjustment
     AND p_posting_date BETWEEN start_date AND end_date
   LIMIT 1;
$$;

COMMENT ON FUNCTION resolve_accounting_period(uuid, date) IS
  'F-403: normative period resolution. Regular period only; an adjustment period must be named '
  'explicitly by a caller holding post_to_adjustment_period.';
COMMENT ON CONSTRAINT accounting_periods_no_overlap ON accounting_periods IS
  'F-011: regular periods cannot overlap. Adjustment periods are exempt by design.';
