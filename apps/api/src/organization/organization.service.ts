/**
 * Organizations, legal entities and branches — the top three levels of doc 01's
 * hierarchy (`Tenant -> Organization -> Legal Entity -> Branch -> Accounting Book`).
 *
 * Two rules run through everything here and are worth stating once:
 *
 *   - Scope never comes from the request. The tenant comes from the session and the
 *     entity is checked against the caller's memberships. A body that names a
 *     tenant is ignored; a body that names an entity is validated, never trusted.
 *   - A structural change that would invalidate posted history is refused once
 *     posting exists (doc 02: "Structural settings that would invalidate history
 *     become locked after first posting"). Currency is the one that matters, and
 *     doc 02's acceptance criterion names it: "Base currency cannot be casually
 *     changed after posting exists."
 */
import { Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { AppError, notFound, uuidv7 } from '@acct/domain';
import { publish, recordAudit } from '@acct/database';
import { DATABASE_POOL } from '../common/database.module';
import { readInTenant, writeInTenant } from '../common/db';
import { listWithCursor } from '../common/list';
import { assertEntityPermission, entityScope, type TenantPrincipal } from '../common/principal';
import { PLATFORM_DEFAULTS, resolveSettings, type SettingSource } from './settings';

export interface OrganizationRow {
  [column: string]: unknown;
  id: string;
  tenant_id: string;
  name: string;
  display_name: string | null;
  status: string;
  settings: Record<string, unknown>;
  version: string;
  created_at: Date;
}

export interface LegalEntityRow {
  [column: string]: unknown;
  id: string;
  tenant_id: string;
  organization_id: string;
  code: string;
  legal_name: string;
  display_name: string | null;
  registration_number: string | null;
  tax_identifier: string | null;
  country_code: string;
  functional_currency: string;
  timezone: string;
  status: string;
  activated_at: Date | null;
  posting_enabled: boolean;
  settings: Record<string, unknown>;
  version: string;
}

@Injectable()
export class OrganizationService {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  // -------------------------------------------------------------------------
  // Organizations
  // -------------------------------------------------------------------------

  async listOrganizations(
    principal: TenantPrincipal,
    page: { cursor?: string | undefined; limit?: number | undefined },
  ) {
    return readInTenant(this.pool, principal, ({ client }) => {
      const scope = entityScope(principal);
      const where = ['o.tenant_id = $1'];
      const params: unknown[] = [principal.tenantId];
      // An organization-scoped membership sees its own organizations and no others.
      if (scope.kind === 'ORGANIZATIONS') {
        params.push(scope.organizationIds);
        where.push(`o.id = ANY($${params.length}::uuid[])`);
      } else if (scope.kind === 'ENTITIES') {
        params.push(scope.legalEntityIds);
        where.push(
          `o.id IN (SELECT le.organization_id FROM legal_entities le WHERE le.id = ANY($${params.length}::uuid[]))`,
        );
      }

      return listWithCursor<OrganizationRow & { cursor_key: string }>(
        client,
        {
          select: `SELECT o.id, o.tenant_id, o.name, o.display_name, o.status, o.settings,
                          o.version::text AS version, o.created_at, o.name AS cursor_key
                     FROM organizations o`,
          where,
          params,
          sortColumn: 'o.name',
          idColumn: 'o.id',
        },
        page,
      );
    });
  }

  async getOrganization(principal: TenantPrincipal, id: string): Promise<OrganizationRow> {
    const row = await readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query<OrganizationRow>(
        `SELECT id, tenant_id, name, display_name, status, settings, version::text AS version, created_at
           FROM organizations WHERE id = $1 AND tenant_id = $2`,
        [id, principal.tenantId],
      );
      return rows[0] ?? null;
    });
    // Gate B: cross-tenant probes return NOT_FOUND, never a different error that
    // would tell the caller the id exists somewhere.
    if (!row) throw notFound('Organization', id);
    return row;
  }

  async createOrganization(
    principal: TenantPrincipal,
    input: { name: string; displayName?: string | undefined; settings?: Record<string, unknown> },
  ): Promise<OrganizationRow> {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const id = uuidv7();
      const { rows } = await client.query<OrganizationRow>(
        `INSERT INTO organizations (id, tenant_id, name, display_name, settings)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         RETURNING id, tenant_id, name, display_name, status, settings, version::text AS version, created_at`,
        [
          id,
          principal.tenantId,
          input.name,
          input.displayName ?? null,
          JSON.stringify(input.settings ?? {}),
        ],
      );
      const organization = rows[0]!;

      await publish(client, context, {
        eventType: 'organization.created',
        aggregateType: 'organization',
        aggregateId: id,
        tenantId: principal.tenantId,
        organizationId: id,
        payload: { name: input.name },
      });
      await recordAudit(client, context, {
        action: 'organization.created',
        resourceType: 'organization',
        resourceId: id,
        tenantId: principal.tenantId,
        organizationId: id,
        after: { name: input.name, display_name: input.displayName ?? null },
      });
      return organization;
    });
  }

  async updateOrganization(
    principal: TenantPrincipal,
    id: string,
    ifMatch: string,
    input: { name?: string; displayName?: string | null; settings?: Record<string, unknown> },
  ): Promise<OrganizationRow> {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const before = await this.lockOrganization(client, principal, id);
      assertVersion(before.version, ifMatch, 'Organization', id);

      const { rows } = await client.query<OrganizationRow>(
        `UPDATE organizations
            SET name = coalesce($3, name),
                display_name = CASE WHEN $4::boolean THEN $5 ELSE display_name END,
                settings = CASE WHEN $6::boolean THEN $7::jsonb ELSE settings END,
                version = version + 1
          WHERE id = $1 AND tenant_id = $2
          RETURNING id, tenant_id, name, display_name, status, settings, version::text AS version, created_at`,
        [
          id,
          principal.tenantId,
          input.name ?? null,
          input.displayName !== undefined,
          input.displayName ?? null,
          input.settings !== undefined,
          JSON.stringify(input.settings ?? {}),
        ],
      );
      const after = rows[0]!;

      // doc 02: "Audit trail records sensitive setup/permission changes" (Gate B).
      // Before and after, not a description of the change: a diff computed later
      // from prose is a diff nobody can defend in an audit.
      await recordAudit(client, context, {
        action: 'organization.updated',
        resourceType: 'organization',
        resourceId: id,
        tenantId: principal.tenantId,
        organizationId: id,
        before: { name: before.name, display_name: before.display_name, settings: before.settings },
        after: { name: after.name, display_name: after.display_name, settings: after.settings },
      });
      return after;
    });
  }

  private async lockOrganization(
    client: PoolClient,
    principal: TenantPrincipal,
    id: string,
  ): Promise<OrganizationRow> {
    const { rows } = await client.query<OrganizationRow>(
      `SELECT id, tenant_id, name, display_name, status, settings, version::text AS version, created_at
         FROM organizations WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [id, principal.tenantId],
    );
    if (!rows[0]) throw notFound('Organization', id);
    return rows[0];
  }

  // -------------------------------------------------------------------------
  // Legal entities
  // -------------------------------------------------------------------------

  async listLegalEntities(
    principal: TenantPrincipal,
    page: { cursor?: string | undefined; limit?: number | undefined },
  ) {
    return readInTenant(this.pool, principal, ({ client }) => {
      const scope = entityScope(principal);
      const where = ['le.tenant_id = $1'];
      const params: unknown[] = [principal.tenantId];
      // Phase 1 exit criterion 2. The restriction is in the WHERE clause rather
      // than in a filter after the fetch, because a row that was read is a row
      // whose existence leaks through counts and cursors.
      if (scope.kind === 'ORGANIZATIONS') {
        params.push(scope.organizationIds);
        where.push(`le.organization_id = ANY($${params.length}::uuid[])`);
      } else if (scope.kind === 'ENTITIES') {
        params.push(scope.legalEntityIds);
        where.push(`le.id = ANY($${params.length}::uuid[])`);
      }

      return listWithCursor<LegalEntityRow & { cursor_key: string }>(
        client,
        {
          select: `SELECT le.id, le.tenant_id, le.organization_id, le.code, le.legal_name,
                          le.display_name, le.registration_number, le.tax_identifier,
                          le.country_code, le.functional_currency, le.timezone, le.status,
                          le.activated_at, le.posting_enabled, le.settings,
                          le.version::text AS version, le.code AS cursor_key
                     FROM legal_entities le`,
          where,
          params,
          sortColumn: 'le.code',
          idColumn: 'le.id',
        },
        page,
      );
    });
  }

  async getLegalEntity(principal: TenantPrincipal, id: string): Promise<LegalEntityRow> {
    const row = await readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query<LegalEntityRow>(
        `SELECT id, tenant_id, organization_id, code, legal_name, display_name, registration_number,
                tax_identifier, country_code, functional_currency, timezone, status, activated_at,
                posting_enabled, settings, version::text AS version
           FROM legal_entities WHERE id = $1 AND tenant_id = $2`,
        [id, principal.tenantId],
      );
      return rows[0] ?? null;
    });
    if (!row) throw notFound('Legal entity', id);
    // Two separate questions, asked in this order on purpose: does it exist in your
    // tenant (no -> 404, so ids cannot be probed across tenants), and may you see
    // it (no -> 403, because within a tenant the id is not a secret).
    assertEntityPermission(principal, 'legal_entity.view', id);
    return row;
  }

  async createLegalEntity(
    principal: TenantPrincipal,
    input: {
      organizationId: string;
      code: string;
      legalName: string;
      displayName?: string | undefined;
      registrationNumber?: string | undefined;
      taxIdentifier?: string | undefined;
      countryCode: string;
      functionalCurrency: string;
      timezone: string;
    },
  ): Promise<LegalEntityRow> {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const organization = await client.query<{ id: string }>(
        `SELECT id FROM organizations WHERE id = $1 AND tenant_id = $2`,
        [input.organizationId, principal.tenantId],
      );
      if (!organization.rows[0]) throw notFound('Organization', input.organizationId);

      const currency = await client.query<{ code: string }>(
        `SELECT code FROM currencies WHERE code = $1 AND is_active`,
        [input.functionalCurrency],
      );
      if (!currency.rows[0]) {
        throw new AppError(
          'VALIDATION_FAILED',
          `${input.functionalCurrency} is not an active currency.`,
          {
            fieldErrors: [
              { field: 'functional_currency', code: 'UNKNOWN', message: 'not an active currency' },
            ],
          },
        );
      }

      const id = uuidv7();
      const { rows } = await client.query<LegalEntityRow>(
        `INSERT INTO legal_entities (id, tenant_id, organization_id, code, legal_name, display_name,
                                     registration_number, tax_identifier, country_code,
                                     functional_currency, timezone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id, tenant_id, organization_id, code, legal_name, display_name,
                   registration_number, tax_identifier, country_code, functional_currency,
                   timezone, status, activated_at, posting_enabled, settings, version::text AS version`,
        [
          id,
          principal.tenantId,
          input.organizationId,
          input.code,
          input.legalName,
          input.displayName ?? null,
          input.registrationNumber ?? null,
          input.taxIdentifier ?? null,
          input.countryCode,
          input.functionalCurrency,
          input.timezone,
        ],
      );
      const entity = rows[0]!;

      // The primary book is created with the entity, not by a separate call.
      //
      // F-606: `activateLegalEntity` requires a primary book, `accounting_books`
      // has a unique index allowing exactly one per entity, and the route catalog
      // has `GET /accounting-books` and no POST — so an entity created through the
      // API could never reach posting-ready status. doc 02's onboarding list has
      // "On completion create: primary accounting book", which says the same thing:
      // the primary book is part of creating an entity, not a thing you go and make
      // afterwards. ADR-0003 makes the book's base currency authoritative for
      // posting and F-014 makes the entity's functional currency the statutory
      // default that seeds it, which is the relationship written below.
      const bookId = uuidv7();
      await client.query(
        `INSERT INTO accounting_books (id, tenant_id, legal_entity_id, code, name, base_currency,
                                       kind, is_primary)
         VALUES ($1, $2, $3, 'PRIMARY', $4, $5, 'PRIMARY', true)`,
        [
          bookId,
          principal.tenantId,
          id,
          `${input.legalName} — primary book`,
          input.functionalCurrency,
        ],
      );

      await publish(client, context, {
        eventType: 'legal_entity.created',
        aggregateType: 'legal_entity',
        aggregateId: id,
        tenantId: principal.tenantId,
        organizationId: input.organizationId,
        legalEntityId: id,
        payload: {
          code: input.code,
          legal_name: input.legalName,
          country_code: input.countryCode,
          functional_currency: input.functionalCurrency,
          primary_accounting_book_id: bookId,
        },
      });
      await recordAudit(client, context, {
        action: 'legal_entity.created',
        resourceType: 'legal_entity',
        resourceId: id,
        tenantId: principal.tenantId,
        organizationId: input.organizationId,
        legalEntityId: id,
        after: {
          code: input.code,
          legal_name: input.legalName,
          primary_accounting_book_id: bookId,
        },
      });
      return entity;
    });
  }

  async updateLegalEntity(
    principal: TenantPrincipal,
    id: string,
    ifMatch: string,
    input: {
      legalName?: string;
      displayName?: string | null;
      registrationNumber?: string | null;
      taxIdentifier?: string | null;
      timezone?: string;
      functionalCurrency?: string;
      settings?: Record<string, unknown>;
    },
  ): Promise<LegalEntityRow> {
    assertEntityPermission(principal, 'legal_entity.configure', id);

    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows: locked } = await client.query<LegalEntityRow>(
        `SELECT id, tenant_id, organization_id, code, legal_name, display_name, registration_number,
                tax_identifier, country_code, functional_currency, timezone, status, activated_at,
                posting_enabled, settings, version::text AS version
           FROM legal_entities WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [id, principal.tenantId],
      );
      const before = locked[0];
      if (!before) throw notFound('Legal entity', id);
      assertVersion(before.version, ifMatch, 'Legal entity', id);

      // doc 02 acceptance: "Base currency cannot be casually changed after posting
      // exists." Once a journal is posted the functional currency is embedded in
      // every base amount already written, and changing it would silently reinterpret
      // history rather than convert it.
      if (input.functionalCurrency && input.functionalCurrency !== before.functional_currency) {
        const posted = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM journal_entries
              WHERE legal_entity_id = $1 AND status = 'POSTED' LIMIT 1
           ) AS exists`,
          [id],
        );
        if (posted.rows[0]?.exists) {
          throw new AppError(
            'POSTED_IMMUTABLE',
            `The functional currency of ${before.code} cannot be changed: posted journals already ` +
              'carry base amounts in ' +
              `${before.functional_currency}. Changing it would reinterpret history rather than ` +
              'convert it. Use a secondary accounting book, or migrate the entity.',
            { details: { legal_entity_id: id, current: before.functional_currency } },
          );
        }
      }

      const { rows } = await client.query<LegalEntityRow>(
        `UPDATE legal_entities
            SET legal_name = coalesce($3, legal_name),
                display_name = CASE WHEN $4::boolean THEN $5 ELSE display_name END,
                registration_number = CASE WHEN $6::boolean THEN $7 ELSE registration_number END,
                tax_identifier = CASE WHEN $8::boolean THEN $9 ELSE tax_identifier END,
                timezone = coalesce($10, timezone),
                functional_currency = coalesce($11, functional_currency),
                settings = CASE WHEN $12::boolean THEN $13::jsonb ELSE settings END,
                version = version + 1
          WHERE id = $1 AND tenant_id = $2
          RETURNING id, tenant_id, organization_id, code, legal_name, display_name,
                    registration_number, tax_identifier, country_code, functional_currency,
                    timezone, status, activated_at, posting_enabled, settings, version::text AS version`,
        [
          id,
          principal.tenantId,
          input.legalName ?? null,
          input.displayName !== undefined,
          input.displayName ?? null,
          input.registrationNumber !== undefined,
          input.registrationNumber ?? null,
          input.taxIdentifier !== undefined,
          input.taxIdentifier ?? null,
          input.timezone ?? null,
          input.functionalCurrency ?? null,
          input.settings !== undefined,
          JSON.stringify(input.settings ?? {}),
        ],
      );
      const after = rows[0]!;

      await recordAudit(client, context, {
        action: 'legal_entity.updated',
        resourceType: 'legal_entity',
        resourceId: id,
        tenantId: principal.tenantId,
        organizationId: before.organization_id,
        legalEntityId: id,
        before,
        after,
      });
      return after;
    });
  }

  /**
   * doc 02: "Posting remains disabled until required setup validation passes."
   *
   * The readiness list is data, not a chain of ifs, because it grows: Phase 2 adds
   * "a chart of accounts exists", Phase 3 adds tax registration. A caller gets the
   * whole list of what is missing, not the first failure — telling someone to fix
   * one thing four times is how setup wizards earn their reputation.
   */
  async activateLegalEntity(
    principal: TenantPrincipal,
    id: string,
  ): Promise<{ entity: LegalEntityRow; checks: ReadinessCheck[] }> {
    assertEntityPermission(principal, 'legal_entity.configure', id);

    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows: locked } = await client.query<LegalEntityRow>(
        `SELECT id, tenant_id, organization_id, code, legal_name, display_name, registration_number,
                tax_identifier, country_code, functional_currency, timezone, status, activated_at,
                posting_enabled, settings, version::text AS version
           FROM legal_entities WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [id, principal.tenantId],
      );
      const entity = locked[0];
      if (!entity) throw notFound('Legal entity', id);

      const checks = await readiness(client, id);
      const failed = checks.filter((c) => !c.satisfied);
      if (failed.length > 0) {
        throw new AppError(
          'VALIDATION_FAILED',
          `${entity.code} is not ready to post: ${failed.map((c) => c.label).join('; ')}.`,
          {
            fieldErrors: failed.map((c) => ({
              field: c.key,
              code: 'SETUP_INCOMPLETE',
              message: c.label,
            })),
            details: { checks },
          },
        );
      }

      const { rows } = await client.query<LegalEntityRow>(
        `UPDATE legal_entities
            SET posting_enabled = true,
                activated_at = coalesce(activated_at, now()),
                version = version + 1
          WHERE id = $1 AND tenant_id = $2
          RETURNING id, tenant_id, organization_id, code, legal_name, display_name,
                    registration_number, tax_identifier, country_code, functional_currency,
                    timezone, status, activated_at, posting_enabled, settings, version::text AS version`,
        [id, principal.tenantId],
      );
      const activated = rows[0]!;

      await publish(client, context, {
        eventType: 'legal_entity.activated',
        aggregateType: 'legal_entity',
        aggregateId: id,
        tenantId: principal.tenantId,
        organizationId: entity.organization_id,
        legalEntityId: id,
        payload: { code: entity.code, checks: checks.map((c) => c.key) },
      });
      await recordAudit(client, context, {
        action: 'legal_entity.activated',
        resourceType: 'legal_entity',
        resourceId: id,
        tenantId: principal.tenantId,
        organizationId: entity.organization_id,
        legalEntityId: id,
        before: { posting_enabled: entity.posting_enabled },
        after: { posting_enabled: true, checks },
      });

      return { entity: activated, checks };
    });
  }

  // -------------------------------------------------------------------------
  // Branches
  // -------------------------------------------------------------------------

  async listBranches(
    principal: TenantPrincipal,
    page: { cursor?: string | undefined; limit?: number | undefined },
    filters: { legalEntityId?: string | undefined },
  ) {
    return readInTenant(this.pool, principal, ({ client }) => {
      const scope = entityScope(principal);
      const where = ['b.tenant_id = $1'];
      const params: unknown[] = [principal.tenantId];

      if (filters.legalEntityId) {
        assertEntityPermission(principal, 'branch.view', filters.legalEntityId);
        params.push(filters.legalEntityId);
        where.push(`b.legal_entity_id = $${params.length}`);
      } else if (scope.kind === 'ENTITIES') {
        params.push(scope.legalEntityIds);
        where.push(`b.legal_entity_id = ANY($${params.length}::uuid[])`);
      } else if (scope.kind === 'ORGANIZATIONS') {
        params.push(scope.organizationIds);
        where.push(
          `b.legal_entity_id IN (SELECT id FROM legal_entities WHERE organization_id = ANY($${params.length}::uuid[]))`,
        );
      }

      return listWithCursor(
        client,
        {
          select: `SELECT b.id, b.tenant_id, b.legal_entity_id, b.code, b.name, b.country_code,
                          b.address, b.manager_user_id, b.valid_from::text AS valid_from,
                          b.valid_to::text AS valid_to, b.status, b.settings, b.code AS cursor_key
                     FROM branches b`,
          where,
          params,
          sortColumn: 'b.code',
          idColumn: 'b.id',
        },
        page,
      );
    });
  }

  async createBranch(
    principal: TenantPrincipal,
    input: {
      legalEntityId: string;
      code: string;
      name: string;
      countryCode?: string | undefined;
      address?: Record<string, unknown> | undefined;
      managerUserId?: string | undefined;
      validFrom?: string | undefined;
      validTo?: string | undefined;
    },
  ) {
    assertEntityPermission(principal, 'branch.create', input.legalEntityId);

    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const entity = await client.query<{ id: string; organization_id: string }>(
        `SELECT id, organization_id FROM legal_entities WHERE id = $1 AND tenant_id = $2`,
        [input.legalEntityId, principal.tenantId],
      );
      if (!entity.rows[0]) throw notFound('Legal entity', input.legalEntityId);

      const id = uuidv7();
      const { rows } = await client.query(
        `INSERT INTO branches (id, tenant_id, legal_entity_id, code, name, country_code, address,
                               manager_user_id, valid_from, valid_to)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::date,$10::date)
         RETURNING id, tenant_id, legal_entity_id, code, name, country_code, address,
                   manager_user_id, valid_from::text AS valid_from, valid_to::text AS valid_to,
                   status, settings`,
        [
          id,
          principal.tenantId,
          input.legalEntityId,
          input.code,
          input.name,
          input.countryCode ?? null,
          input.address ? JSON.stringify(input.address) : null,
          input.managerUserId ?? null,
          input.validFrom ?? null,
          input.validTo ?? null,
        ],
      );

      await publish(client, context, {
        eventType: 'branch.created',
        aggregateType: 'branch',
        aggregateId: id,
        tenantId: principal.tenantId,
        organizationId: entity.rows[0].organization_id,
        legalEntityId: input.legalEntityId,
        branchId: id,
        payload: { code: input.code, name: input.name },
      });
      await recordAudit(client, context, {
        action: 'branch.created',
        resourceType: 'branch',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: input.legalEntityId,
        after: { code: input.code, name: input.name },
      });
      return rows[0]!;
    });
  }

  // -------------------------------------------------------------------------
  // Effective settings — doc 01's precedence chain
  // -------------------------------------------------------------------------

  async effectiveSettings(
    principal: TenantPrincipal,
    scopeIn: { legalEntityId?: string | undefined; branchId?: string | undefined },
  ): Promise<Record<string, unknown>> {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const sources: SettingSource[] = [
        { level: 'platform', settings: PLATFORM_DEFAULTS, sourceId: null },
      ];

      let organizationId: string | null = null;
      if (scopeIn.legalEntityId) {
        assertEntityPermission(principal, 'organization.view', scopeIn.legalEntityId);
        const { rows } = await client.query<{
          organization_id: string;
          settings: Record<string, unknown>;
        }>(
          `SELECT organization_id, settings FROM legal_entities WHERE id = $1 AND tenant_id = $2`,
          [scopeIn.legalEntityId, principal.tenantId],
        );
        if (!rows[0]) throw notFound('Legal entity', scopeIn.legalEntityId);
        organizationId = rows[0].organization_id;

        // Level 2 is the localization package. Phase 3 installs those; until then
        // the level exists in the chain and contributes nothing, which is different
        // from the level not existing.
        sources.push({
          level: 'legal_entity',
          settings: rows[0].settings,
          sourceId: scopeIn.legalEntityId,
        });
      }

      const organizations = await client.query<{
        id: string;
        settings: Record<string, unknown>;
      }>(
        organizationId
          ? `SELECT id, settings FROM organizations WHERE id = $1 AND tenant_id = $2`
          : `SELECT id, settings FROM organizations WHERE tenant_id = $2 ORDER BY created_at LIMIT 1`,
        organizationId ? [organizationId, principal.tenantId] : [null, principal.tenantId],
      );
      if (organizations.rows[0]) {
        sources.push({
          level: 'organization',
          settings: organizations.rows[0].settings,
          sourceId: organizations.rows[0].id,
        });
      }

      if (scopeIn.branchId) {
        const { rows } = await client.query<{
          id: string;
          legal_entity_id: string;
          settings: Record<string, unknown>;
        }>(`SELECT id, legal_entity_id, settings FROM branches WHERE id = $1 AND tenant_id = $2`, [
          scopeIn.branchId,
          principal.tenantId,
        ]);
        if (!rows[0]) throw notFound('Branch', scopeIn.branchId);
        assertEntityPermission(principal, 'branch.view', rows[0].legal_entity_id);
        sources.push({ level: 'branch', settings: rows[0].settings, sourceId: rows[0].id });
      }

      const { effective, provenance } = resolveSettings(sources);
      return {
        scope: {
          tenant_id: principal.tenantId,
          organization_id: organizationId ?? organizations.rows[0]?.id ?? null,
          legal_entity_id: scopeIn.legalEntityId ?? null,
          branch_id: scopeIn.branchId ?? null,
        },
        settings: effective,
        // Which level supplied each value. The question "why is this entity
        // formatting dates differently" has one query behind it instead of four.
        provenance,
        chain: sources.map((s) => ({ level: s.level, source_id: s.sourceId })),
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Setup readiness
// ---------------------------------------------------------------------------

export interface ReadinessCheck {
  readonly key: string;
  readonly label: string;
  readonly satisfied: boolean;
  readonly phase: number;
}

/**
 * What "posting-ready" means, as a list that later phases extend.
 *
 * Phase 1 owns four of these. Phase 2 adds the chart of accounts and the default
 * journals; Phase 3 adds tax registration where the localization requires it. The
 * list is returned to the caller either way, so a half-configured entity can show
 * a progress indicator rather than an error.
 */
export async function readiness(
  client: PoolClient,
  legalEntityId: string,
): Promise<ReadinessCheck[]> {
  const { rows } = await client.query<{
    books: string;
    primary_books: string;
    fiscal_years: string;
    periods: string;
    policies: string;
    sequences: string;
  }>(
    `SELECT (SELECT count(*) FROM accounting_books WHERE legal_entity_id = $1)::text AS books,
            (SELECT count(*) FROM accounting_books WHERE legal_entity_id = $1 AND is_primary)::text AS primary_books,
            (SELECT count(*) FROM fiscal_years WHERE legal_entity_id = $1)::text AS fiscal_years,
            (SELECT count(*) FROM accounting_periods WHERE legal_entity_id = $1)::text AS periods,
            (SELECT count(*) FROM accounting_policies WHERE legal_entity_id = $1)::text AS policies,
            (SELECT count(*) FROM number_sequences WHERE legal_entity_id = $1)::text AS sequences`,
    [legalEntityId],
  );
  const counts = rows[0]!;

  return [
    {
      key: 'primary_accounting_book',
      label: 'a primary accounting book exists',
      satisfied: Number(counts.primary_books) > 0,
      phase: 1,
    },
    {
      key: 'fiscal_calendar',
      label: 'a fiscal year with accounting periods exists',
      satisfied: Number(counts.fiscal_years) > 0 && Number(counts.periods) > 0,
      phase: 1,
    },
    {
      key: 'accounting_policy',
      label: 'an accounting policy version is effective',
      satisfied: Number(counts.policies) > 0,
      phase: 1,
    },
    {
      key: 'number_sequences',
      label: 'at least one document number sequence is configured',
      satisfied: Number(counts.sequences) > 0,
      phase: 1,
    },
  ];
}

// `assertVersion` moved to @acct/domain in Phase 2 so the ledger kernel package can
// use it without importing from apps/api. Re-exported here because eleven Phase 1
// call sites import it from this module and the move is not their business.
export { assertVersion } from '@acct/domain';
import { assertVersion } from '@acct/domain';
