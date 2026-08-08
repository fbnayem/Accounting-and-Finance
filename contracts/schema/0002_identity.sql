-- =============================================================================
-- 0002 — Identity: users, sessions, permissions, roles, memberships
-- =============================================================================
-- Phase 1. ADR-0005. Resolves F-016/F-207 (permission registry), F-017 (nullable
-- columns in unique keys), F-018 (global identity confirmed), F-045 (sessions).
-- =============================================================================

-- ADR-0005: users are PLATFORM-level. One person, one row, regardless of how
-- many tenants they work in. Authentication is cross-tenant; authorization is
-- entirely per-tenant and derives solely from memberships. This is what the
-- Phase 9 multi-client accountant portal requires.
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           citext NOT NULL UNIQUE,
  display_name    text NOT NULL,
  password_hash   text,
  mfa_enrolled    boolean NOT NULL DEFAULT false,
  mfa_required    boolean NOT NULL DEFAULT false,
  status          record_status NOT NULL DEFAULT 'ACTIVE',
  locale          text NOT NULL DEFAULT 'en',       -- F-405: locale carried from day one
  timezone        text,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- F-045: doc 02 "session list/revocation", doc 16 "session/device management".
-- Stateless JWTs alone cannot satisfy revocation; user.suspended must terminate
-- live sessions immediately (ADR-0005).
CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  tenant_id       uuid REFERENCES tenants(id),   -- bound at tenant-selection step
  device_label    text,
  ip_address      inet,
  user_agent      text,
  mfa_satisfied   boolean NOT NULL DEFAULT false,
  issued_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  revoked_reason  text
);
CREATE INDEX sessions_user_idx   ON sessions(user_id, revoked_at, expires_at);
CREATE INDEX sessions_active_idx ON sessions(tenant_id, expires_at) WHERE revoked_at IS NULL;

-- ----------------------------------------------------------------------------
-- Permission registry — F-016 / F-207.
-- The blueprint had `roles.permissions jsonb`, which gives no referential
-- integrity, no way to answer "which roles hold this permission", and no way to
-- flag one high-risk. Gate B's "authorization tests cover every mutation route"
-- needs an enumerable set.
--
-- SEEDED FROM contracts/openapi.yaml x-permission values (ADR-0005), so route
-- and permission cannot drift. CI fails if a route declares a permission absent
-- from this table, or a role references one that does not exist.
-- ----------------------------------------------------------------------------
CREATE TABLE permissions (
  code          text PRIMARY KEY,           -- e.g. 'invoice.post'
  resource      text NOT NULL,              -- 'invoice'
  action        text NOT NULL,              -- 'post'
  description   text NOT NULL,
  -- doc 02 names six high-risk permissions requiring distinct handling:
  -- vendor bank details, approve payments, post to control accounts, reopen
  -- periods, override tax, export all data, manage roles/integrations.
  is_high_risk  boolean NOT NULL DEFAULT false,
  requires_reauth boolean NOT NULL DEFAULT false,
  min_phase     integer NOT NULL DEFAULT 1,
  UNIQUE (resource, action)
);

CREATE TABLE roles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  code          text NOT NULL,
  name          text NOT NULL,
  description   text,
  is_system     boolean NOT NULL DEFAULT false,   -- Owner/Admin/Accountant/... templates
  status        record_status NOT NULL DEFAULT 'ACTIVE',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  CONSTRAINT roles_scope_uq UNIQUE (id, tenant_id)
);

CREATE TABLE role_permissions (
  role_id         uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES permissions(code) ON DELETE RESTRICT,
  PRIMARY KEY (role_id, permission_code)
);
CREATE INDEX role_permissions_permission_idx ON role_permissions(permission_code);

-- ----------------------------------------------------------------------------
-- Memberships — the sole source of authorization scope (ADR-0005).
-- F-017: the blueprint's UNIQUE contained three nullable columns, and PostgreSQL
-- treats NULL as distinct, so unbounded duplicate tenant-wide memberships were
-- insertable. NULLS NOT DISTINCT (PG15+, ADR-0008) closes it.
-- ----------------------------------------------------------------------------
CREATE TABLE memberships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role_id         uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  organization_id uuid REFERENCES organizations(id),
  legal_entity_id uuid,                    -- FK added in 0003
  branch_id       uuid,                    -- FK added in 0003
  status          record_status NOT NULL DEFAULT 'ACTIVE',
  -- ADR-0005: suspension applies to the membership, not the user, so a tenant
  -- suspension cannot lock someone out of their other tenants.
  suspended_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memberships_uq
    UNIQUE NULLS NOT DISTINCT (tenant_id, user_id, role_id, organization_id, legal_entity_id, branch_id),
  -- ADR-0002: the role must belong to the same tenant as the membership.
  CONSTRAINT memberships_role_scope_fk
    FOREIGN KEY (role_id, tenant_id) REFERENCES roles(id, tenant_id)
);
CREATE INDEX memberships_user_idx   ON memberships(user_id, status);
CREATE INDEX memberships_tenant_idx ON memberships(tenant_id, status);

-- Deferred FKs from 0001 now that users exists.
ALTER TABLE files
  ADD CONSTRAINT files_created_by_fk FOREIGN KEY (created_by) REFERENCES users(id);
ALTER TABLE feature_flag_overrides
  ADD CONSTRAINT feature_flag_overrides_set_by_fk FOREIGN KEY (set_by) REFERENCES users(id);
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_impersonated_by_fk FOREIGN KEY (impersonated_by) REFERENCES users(id);

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE users IS
  'ADR-0005: platform-level identity. Global unique email is intentional and required by the '
  'Phase 9 accountant portal. Tenancy comes only from memberships.';
COMMENT ON TABLE permissions IS
  'F-207: generated from contracts/openapi.yaml x-permission values. Never hand-edited.';
