-- =============================================================================
-- 0023 — IAM runtime: invitations, MFA factors, session credentials
-- =============================================================================
-- Phase 1. doc 02 "Authentication and sessions" requires an invite/accept flow,
-- an MFA foundation in the first production version, and session listing and
-- revocation. 0002_identity.sql modelled the *result* of all three — users,
-- memberships, a sessions row — but nothing that makes them reachable: no
-- invitation to accept, no factor to verify against, and no credential on the
-- session for a request to present.
--
-- Raised as F-604 while building Phase 1; see contracts/README.md.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- Invitations — doc 02 "Invite/accept flow".
--
-- The invitation carries the scope the membership will get, not a membership.
-- Creating the membership up front and marking it inactive would mean a row in
-- `memberships` for someone who has never accepted, and every "who can see this
-- entity" query would then have to remember to exclude them. ADR-0005 makes
-- memberships the sole source of authorization scope; a pending invitation is not
-- yet authorization.
-- ----------------------------------------------------------------------------
CREATE TABLE user_invitations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  email           citext NOT NULL,
  role_id         uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  organization_id uuid REFERENCES organizations(id),
  legal_entity_id uuid REFERENCES legal_entities(id),
  branch_id       uuid REFERENCES branches(id),
  -- sha256 of the token that was mailed. The token itself is shown once and never
  -- stored: a leaked database must not yield a working invitation.
  token_hash      text NOT NULL UNIQUE,
  status          text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','ACCEPTED','REVOKED','EXPIRED')),
  expires_at      timestamptz NOT NULL,
  invited_by      uuid NOT NULL REFERENCES users(id),
  accepted_at     timestamptz,
  accepted_user_id uuid REFERENCES users(id),
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_invitations_role_scope_fk
    FOREIGN KEY (role_id, tenant_id) REFERENCES roles(id, tenant_id),
  CONSTRAINT user_invitations_accepted_shape
    CHECK ((status = 'ACCEPTED') = (accepted_at IS NOT NULL)),
  CONSTRAINT user_invitations_accepted_user
    CHECK (accepted_user_id IS NULL OR status = 'ACCEPTED')
);
-- One live invitation per address per tenant. Re-inviting revokes and reissues,
-- so two valid tokens for the same person can never be in flight at once.
CREATE UNIQUE INDEX user_invitations_pending_uq
  ON user_invitations(tenant_id, email) WHERE status = 'PENDING';
CREATE INDEX user_invitations_reap_idx ON user_invitations(expires_at) WHERE status = 'PENDING';

-- ----------------------------------------------------------------------------
-- MFA — doc 02 "MFA foundation in first production version".
--
-- A TOTP secret has to be recoverable to verify a code, so unlike every other
-- credential here it cannot be hashed. It is stored encrypted with a key held
-- outside the database (AES-256-GCM, key from MFA_ENCRYPTION_KEY), which is what
-- makes a database dump alone insufficient to mint codes. `nonce` and `auth_tag`
-- are columns rather than a packed blob so a future key rotation can be written
-- as a migration instead of a parser.
-- ----------------------------------------------------------------------------
CREATE TABLE mfa_factors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind            text NOT NULL CHECK (kind IN ('TOTP')),
  label           text,
  secret_ciphertext bytea NOT NULL,
  secret_nonce    bytea NOT NULL,
  secret_auth_tag bytea NOT NULL,
  key_version     integer NOT NULL DEFAULT 1,
  confirmed_at    timestamptz,
  last_used_at    timestamptz,
  -- Replay defence: TOTP codes stay valid for a whole step, so a code observed in
  -- transit works again until the step ends unless the last accepted one is kept.
  last_used_step  bigint,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX mfa_factors_confirmed_uq
  ON mfa_factors(user_id, kind) WHERE confirmed_at IS NOT NULL;

CREATE TABLE mfa_recovery_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  code_hash    text NOT NULL,
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash)
);

-- ----------------------------------------------------------------------------
-- Session credentials.
--
-- Tokens are opaque and checked against this row on every request, rather than
-- self-contained JWTs. ADR-0005 requires that suspending a user "terminate live
-- sessions immediately", and doc 02's acceptance criterion is that "a suspended
-- user loses active access" — with a self-contained token that is only true once
-- the token expires, unless a denylist is introduced, which is a session table
-- with extra steps. The cost is one primary-key read per request, measured under
-- Gate H like everything else.
-- ----------------------------------------------------------------------------
ALTER TABLE sessions
  ADD COLUMN access_token_hash   text,
  ADD COLUMN access_expires_at   timestamptz,
  ADD COLUMN refresh_token_hash  text,
  ADD COLUMN refresh_expires_at  timestamptz,
  -- Set when MFA was last satisfied. High-risk permissions (ADR-0005 §3) require
  -- it to be recent, not merely present.
  ADD COLUMN mfa_verified_at     timestamptz,
  -- Rotation chain. A refresh token presented after it was rotated away means the
  -- old token leaked; the whole chain is then revoked rather than the request
  -- merely refused.
  ADD COLUMN rotated_from        uuid REFERENCES sessions(id),
  ADD COLUMN rotation_count      integer NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX sessions_access_token_idx  ON sessions(access_token_hash)
  WHERE access_token_hash IS NOT NULL;
CREATE UNIQUE INDEX sessions_refresh_token_idx ON sessions(refresh_token_hash)
  WHERE refresh_token_hash IS NOT NULL;

COMMENT ON TABLE user_invitations IS
  'F-604: doc 02 requires an invite/accept flow; the route catalog had POST /users/invite and '
  'no acceptance path, so an invited user could never join.';
COMMENT ON COLUMN mfa_factors.secret_ciphertext IS
  'AES-256-GCM under MFA_ENCRYPTION_KEY. The one credential in this schema that cannot be hashed, '
  'because verifying a TOTP code requires the secret back.';
COMMENT ON COLUMN sessions.rotated_from IS
  'Refresh-token rotation chain. Presenting a rotated token revokes the chain (reuse detection).';

-- doc 02 also lists "Service principals for integrations" under authentication.
-- No Phase 1 route creates or uses one, and integration.manage (phase 9) owns that
-- surface, so it is deliberately not modelled here rather than half-modelled now.
