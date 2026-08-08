-- =============================================================================
-- 0026 — Branch-level settings
-- =============================================================================
-- Phase 1. F-605, raised while building `GET /settings/effective`.
--
-- doc 01 states the configuration precedence chain normatively:
--
--   Platform default -> Localization default -> Organization -> Legal entity
--   -> Branch -> Transaction override (only where allowed)
--
-- `organizations` and `legal_entities` both carry a `settings jsonb`. `branches`
-- carries `address` and nothing else, so the fifth level of a six-level chain had
-- nowhere to store a value. The resolver would have had to skip it silently, and
-- doc 01's precedence rules would have been untestable at exactly the level where
-- overrides are most common (branch-specific document numbering, branch cash
-- accounts, branch tax registration).
-- =============================================================================

ALTER TABLE branches
  ADD COLUMN settings jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN branches.settings IS
  'F-605: level 5 of doc 01''s configuration precedence chain. Organization and legal entity both '
  'had a settings column; branch did not, which made the documented chain unimplementable.';
