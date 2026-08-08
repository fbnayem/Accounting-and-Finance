/**
 * Chart of accounts, account groups and dimensions.
 *
 * doc 03's chart rules are five sentences, and four of them are constraints the
 * database now holds (unique code per entity, archive-not-delete, type change
 * locked after posting, non-posting accounts reject lines). This service is where
 * the fifth lives — "control accounts can reject manual posting except privileged
 * adjustment" — and where the four are turned from constraint violations into
 * sentences a user can act on.
 */
import { Pool, PoolClient } from 'pg';
import {
  AppError,
  assertVersion,
  notFound,
  uuidv7,
  type AccountTypeCode,
  type NormalBalance,
} from '@acct/domain';
import { publish, recordAudit } from '@acct/database';
import { readInTenant, writeInTenant } from '@acct/database';
import { assertEntityPermission, entityScope, type TenantPrincipal } from '@acct/domain';

export interface AccountRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  legal_entity_id: string;
  code: string;
  name: string;
  account_type: AccountTypeCode;
  normal_balance: NormalBalance;
  is_posting: boolean;
  is_control: boolean;
  is_system: boolean;
  status: string;
  version: string;
}

/**
 * The normal balance implied by an account type.
 *
 * Offered as a default rather than imposed: a contra account — accumulated
 * depreciation, sales returns, treasury stock — is deliberately the other way
 * round, and refusing to let the caller say so would make half the chart
 * unrepresentable. The default is right for the other 90%.
 */
const NATURAL_BALANCE: Record<AccountTypeCode, NormalBalance> = {
  ASSET: 'DEBIT',
  EXPENSE: 'DEBIT',
  LIABILITY: 'CREDIT',
  EQUITY: 'CREDIT',
  REVENUE: 'CREDIT',
};

export class ChartService {
  constructor(private readonly pool: Pool) {}

  // -------------------------------------------------------------------------
  // Account groups (F-607)
  // -------------------------------------------------------------------------

  async listAccountGroups(
    principal: TenantPrincipal,
    filters: { legalEntityId?: string | undefined },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { where, params } = this.entityFilter(principal, 'account.view', 'g', filters);
      const { rows } = await client.query(
        `SELECT g.id, g.legal_entity_id, g.parent_id, g.code, g.name, g.sort_order, g.status,
                (SELECT count(*) FROM accounts a WHERE a.group_id = g.id)::int AS account_count
           FROM account_groups g
          WHERE ${where.join(' AND ')}
          ORDER BY g.sort_order, g.code
          LIMIT 500`,
        params,
      );
      return { data: rows };
    });
  }

  async createAccountGroup(
    principal: TenantPrincipal,
    input: {
      legalEntityId: string;
      code: string;
      name: string;
      parentId?: string | undefined;
      sortOrder?: number | undefined;
    },
  ) {
    assertEntityPermission(principal, 'account.create', input.legalEntityId);
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      if (input.parentId) {
        await this.assertInEntity(client, 'account_groups', input.parentId, input.legalEntityId);
      }
      const id = uuidv7();
      const { rows } = await client.query(
        `INSERT INTO account_groups (id, tenant_id, legal_entity_id, parent_id, code, name, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, legal_entity_id, parent_id, code, name, sort_order, status`,
        [
          id,
          principal.tenantId,
          input.legalEntityId,
          input.parentId ?? null,
          input.code,
          input.name,
          input.sortOrder ?? 0,
        ],
      );
      await recordAudit(client, context, {
        action: 'account_group.created',
        resourceType: 'account_group',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: input.legalEntityId,
        after: rows[0]!,
      });
      return rows[0]!;
    });
  }

  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------

  async listAccounts(
    principal: TenantPrincipal,
    filters: {
      legalEntityId?: string | undefined;
      accountType?: AccountTypeCode | undefined;
      status?: string | undefined;
      postingOnly?: boolean | undefined;
      search?: string | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { where, params } = this.entityFilter(principal, 'account.view', 'a', filters);
      if (filters.accountType) {
        params.push(filters.accountType);
        where.push(`a.account_type = $${params.length}::account_type`);
      }
      if (filters.status) {
        params.push(filters.status);
        where.push(`a.status = $${params.length}::record_status`);
      }
      if (filters.postingOnly) where.push('a.is_posting');
      if (filters.search) {
        params.push(`%${filters.search}%`);
        where.push(`(a.code ILIKE $${params.length} OR a.name ILIKE $${params.length})`);
      }

      const { rows } = await client.query(
        `SELECT a.id, a.legal_entity_id, a.group_id, a.parent_id, a.code, a.name, a.account_type,
                a.subtype, a.normal_balance, a.is_posting, a.is_control, a.is_system,
                a.cash_flow_classification, a.status, a.version::text AS version,
                g.code AS group_code, g.name AS group_name,
                EXISTS (SELECT 1 FROM journal_lines l WHERE l.account_id = a.id) AS has_postings
           FROM accounts a
           LEFT JOIN account_groups g ON g.id = a.group_id
          WHERE ${where.join(' AND ')}
          ORDER BY a.code
          LIMIT 2000`,
        params,
      );
      return { data: rows };
    });
  }

  async createAccount(
    principal: TenantPrincipal,
    input: {
      legalEntityId: string;
      code: string;
      name: string;
      accountType: AccountTypeCode;
      normalBalance?: NormalBalance | undefined;
      subtype?: string | undefined;
      groupId?: string | undefined;
      parentId?: string | undefined;
      isPosting?: boolean | undefined;
      isControl?: boolean | undefined;
      cashFlowClassification?: string | undefined;
    },
  ) {
    assertEntityPermission(principal, 'account.create', input.legalEntityId);

    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows: entity } = await client.query<{ organization_id: string }>(
        `SELECT organization_id FROM legal_entities WHERE id = $1 AND tenant_id = $2`,
        [input.legalEntityId, principal.tenantId],
      );
      if (!entity[0]) throw notFound('Legal entity', input.legalEntityId);

      if (input.groupId) {
        await this.assertInEntity(client, 'account_groups', input.groupId, input.legalEntityId);
      }
      if (input.parentId) {
        const parent = await this.assertInEntity(
          client,
          'accounts',
          input.parentId,
          input.legalEntityId,
        );
        // doc 03: "parent/reporting accounts cannot receive journal lines if
        // non-posting". The corollary nobody writes down is that an account which
        // has become a parent should stop being a posting account, or the chart has
        // balances at two levels of the same subtree and every roll-up double-counts.
        if ((parent as { is_posting: boolean }).is_posting) {
          await client.query(`UPDATE accounts SET is_posting = false WHERE id = $1`, [
            input.parentId,
          ]);
        }
      }

      const duplicate = await client.query(
        `SELECT id FROM accounts WHERE legal_entity_id = $1 AND code = $2`,
        [input.legalEntityId, input.code],
      );
      if (duplicate.rows[0]) {
        throw new AppError('VALIDATION_FAILED', `Account code ${input.code} is already in use.`, {
          fieldErrors: [{ field: 'code', code: 'DUPLICATE', message: 'code already exists' }],
        });
      }

      const id = uuidv7();
      const { rows } = await client.query<AccountRow>(
        `INSERT INTO accounts (id, tenant_id, legal_entity_id, group_id, parent_id, code, name,
                               account_type, subtype, normal_balance, is_posting, is_control,
                               cash_flow_classification)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::account_type,$9,$10::normal_balance,$11,$12,$13)
         RETURNING id, tenant_id, legal_entity_id, group_id, parent_id, code, name, account_type,
                   subtype, normal_balance, is_posting, is_control, is_system,
                   cash_flow_classification, status, version::text AS version`,
        [
          id,
          principal.tenantId,
          input.legalEntityId,
          input.groupId ?? null,
          input.parentId ?? null,
          input.code,
          input.name,
          input.accountType,
          input.subtype ?? null,
          input.normalBalance ?? NATURAL_BALANCE[input.accountType],
          input.isPosting ?? true,
          input.isControl ?? false,
          input.cashFlowClassification ?? null,
        ],
      );

      await publish(client, context, {
        eventType: 'account.created',
        aggregateType: 'account',
        aggregateId: id,
        tenantId: principal.tenantId,
        organizationId: entity[0].organization_id,
        legalEntityId: input.legalEntityId,
        payload: {
          code: input.code,
          name: input.name,
          account_type: input.accountType,
          is_control: input.isControl ?? false,
        },
      });
      await recordAudit(client, context, {
        action: 'account.created',
        resourceType: 'account',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: input.legalEntityId,
        after: rows[0]!,
      });
      return rows[0]!;
    });
  }

  /**
   * doc 03: "used account is archived, not deleted" and "type change after posting
   * requires controlled migration".
   *
   * Both are enforced by migration 0029 as well. The value of repeating them here is
   * the message: a trigger says ACCOUNT_TYPE_LOCKED, this says which account, how
   * many lines it carries, and what to do instead.
   */
  async updateAccount(
    principal: TenantPrincipal,
    id: string,
    ifMatch: string,
    input: {
      name?: string | undefined;
      subtype?: string | undefined;
      groupId?: string | null | undefined;
      accountType?: AccountTypeCode | undefined;
      normalBalance?: NormalBalance | undefined;
      isPosting?: boolean | undefined;
      isControl?: boolean | undefined;
      cashFlowClassification?: string | null | undefined;
      status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED' | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows: before } = await client.query<
        AccountRow & { posting_count: string; is_system: boolean }
      >(
        `SELECT a.id, a.tenant_id, a.legal_entity_id, a.group_id, a.parent_id, a.code, a.name,
                a.account_type, a.subtype, a.normal_balance, a.is_posting, a.is_control,
                a.is_system, a.cash_flow_classification, a.status, a.version::text AS version,
                (SELECT count(*) FROM journal_lines l WHERE l.account_id = a.id)::text
                  AS posting_count
           FROM accounts a WHERE a.id = $1 AND a.tenant_id = $2
           FOR UPDATE OF a`,
        [id, principal.tenantId],
      );
      const account = before[0];
      if (!account) throw notFound('Account', id);
      assertEntityPermission(principal, 'account.edit', account.legal_entity_id);
      assertVersion(account.version, ifMatch, 'Account', id);

      const postings = Number(account.posting_count);
      const changingType =
        (input.accountType !== undefined && input.accountType !== account.account_type) ||
        (input.normalBalance !== undefined && input.normalBalance !== account.normal_balance);

      if (changingType && postings > 0) {
        throw new AppError(
          'VALIDATION_FAILED',
          `${account.code} ${account.name} carries ${postings} posted line(s). Changing its type ` +
            `would restate every period it appears in, so doc 03 requires a controlled migration: ` +
            `create the correctly typed account, reverse and repost, then archive this one.`,
          {
            fieldErrors: [
              { field: 'account_type', code: 'LOCKED', message: 'the account has been posted to' },
            ],
            details: { account_code: account.code, posted_lines: postings },
          },
        );
      }
      if (input.status === 'ARCHIVED' && account.is_system) {
        throw new AppError(
          'VALIDATION_FAILED',
          `${account.code} is a system account; archiving it would leave a posting rule pointing ` +
            'at nothing.',
          { fieldErrors: [{ field: 'status', code: 'SYSTEM', message: 'system account' }] },
        );
      }
      if (input.isPosting === true) {
        const children = await client.query(`SELECT 1 FROM accounts WHERE parent_id = $1 LIMIT 1`, [
          id,
        ]);
        if (children.rows[0]) {
          throw new AppError(
            'VALIDATION_FAILED',
            `${account.code} has child accounts. A parent that also receives lines makes every ` +
              'roll-up double-count it (doc 03).',
            {
              fieldErrors: [{ field: 'is_posting', code: 'HAS_CHILDREN', message: 'has children' }],
            },
          );
        }
      }
      if (input.groupId) {
        await this.assertInEntity(client, 'account_groups', input.groupId, account.legal_entity_id);
      }

      const { rows } = await client.query<AccountRow>(
        `UPDATE accounts
            SET name = coalesce($3, name),
                subtype = coalesce($4, subtype),
                group_id = CASE WHEN $5::boolean THEN $6::uuid ELSE group_id END,
                account_type = coalesce($7::account_type, account_type),
                normal_balance = coalesce($8::normal_balance, normal_balance),
                is_posting = coalesce($9::boolean, is_posting),
                is_control = coalesce($10::boolean, is_control),
                cash_flow_classification =
                  CASE WHEN $11::boolean THEN $12::text ELSE cash_flow_classification END,
                status = coalesce($13::record_status, status),
                version = version + 1
          WHERE id = $1 AND tenant_id = $2
          RETURNING id, tenant_id, legal_entity_id, group_id, parent_id, code, name, account_type,
                    subtype, normal_balance, is_posting, is_control, is_system,
                    cash_flow_classification, status, version::text AS version`,
        [
          id,
          principal.tenantId,
          input.name ?? null,
          input.subtype ?? null,
          input.groupId !== undefined,
          input.groupId ?? null,
          input.accountType ?? null,
          input.normalBalance ?? null,
          input.isPosting ?? null,
          input.isControl ?? null,
          input.cashFlowClassification !== undefined,
          input.cashFlowClassification ?? null,
          input.status ?? null,
        ],
      );

      await publish(client, context, {
        eventType: 'account.updated',
        aggregateType: 'account',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: account.legal_entity_id,
        payload: { code: account.code, status: rows[0]!.status },
      });
      await recordAudit(client, context, {
        action: 'account.updated',
        resourceType: 'account',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: account.legal_entity_id,
        before: account,
        after: rows[0]!,
      });
      return rows[0]!;
    });
  }

  // -------------------------------------------------------------------------
  // Dimensions
  // -------------------------------------------------------------------------

  async listDimensions(
    principal: TenantPrincipal,
    filters: { legalEntityId?: string | undefined },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { where, params } = this.entityFilter(principal, 'dimension.view', 'd', filters);
      const { rows } = await client.query(
        `SELECT d.id, d.legal_entity_id, d.code, d.name, d.hierarchy_enabled, d.status,
                (SELECT count(*) FROM dimension_values v WHERE v.dimension_id = d.id)::int
                  AS value_count
           FROM dimensions d
          WHERE ${where.join(' AND ')}
          ORDER BY d.code
          LIMIT 500`,
        params,
      );
      return { data: rows };
    });
  }

  async createDimension(
    principal: TenantPrincipal,
    input: {
      legalEntityId: string;
      code: string;
      name: string;
      hierarchyEnabled?: boolean | undefined;
    },
  ) {
    assertEntityPermission(principal, 'dimension.create', input.legalEntityId);
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const id = uuidv7();
      const { rows } = await client.query(
        `INSERT INTO dimensions (id, tenant_id, legal_entity_id, code, name, hierarchy_enabled)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, legal_entity_id, code, name, hierarchy_enabled, status`,
        [
          id,
          principal.tenantId,
          input.legalEntityId,
          input.code,
          input.name,
          input.hierarchyEnabled ?? false,
        ],
      );
      await publish(client, context, {
        eventType: 'dimension.created',
        aggregateType: 'dimension',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: input.legalEntityId,
        payload: { code: input.code, name: input.name },
      });
      await recordAudit(client, context, {
        action: 'dimension.created',
        resourceType: 'dimension',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: input.legalEntityId,
        after: rows[0]!,
      });
      return rows[0]!;
    });
  }

  async listDimensionValues(
    principal: TenantPrincipal,
    filters: { legalEntityId?: string | undefined; dimensionId?: string | undefined },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { where, params } = this.entityFilter(principal, 'dimension.view', 'v', filters);
      if (filters.dimensionId) {
        params.push(filters.dimensionId);
        where.push(`v.dimension_id = $${params.length}`);
      }
      const { rows } = await client.query(
        `SELECT v.id, v.legal_entity_id, v.dimension_id, v.parent_id, v.code, v.name,
                v.manager_user_id, v.valid_from::text AS valid_from, v.valid_to::text AS valid_to,
                v.status, d.code AS dimension_code
           FROM dimension_values v
           JOIN dimensions d ON d.id = v.dimension_id
          WHERE ${where.join(' AND ')}
          ORDER BY d.code, v.code
          LIMIT 2000`,
        params,
      );
      return { data: rows };
    });
  }

  async createDimensionValue(
    principal: TenantPrincipal,
    input: {
      dimensionId: string;
      code: string;
      name: string;
      parentId?: string | undefined;
      validFrom?: string | undefined;
      validTo?: string | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows: dims } = await client.query<{
        legal_entity_id: string;
        hierarchy_enabled: boolean;
        code: string;
      }>(
        `SELECT legal_entity_id, hierarchy_enabled, code FROM dimensions
          WHERE id = $1 AND tenant_id = $2`,
        [input.dimensionId, principal.tenantId],
      );
      const dimension = dims[0];
      if (!dimension) throw notFound('Dimension', input.dimensionId);
      assertEntityPermission(principal, 'dimension.create', dimension.legal_entity_id);

      if (input.parentId && !dimension.hierarchy_enabled) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Dimension ${dimension.code} is not hierarchical, so its values cannot have parents.`,
          { fieldErrors: [{ field: 'parent_id', code: 'FLAT', message: 'dimension is flat' }] },
        );
      }

      const id = uuidv7();
      const { rows } = await client.query(
        `INSERT INTO dimension_values (id, tenant_id, legal_entity_id, dimension_id, parent_id,
                                       code, name, valid_from, valid_to)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9::date)
         RETURNING id, legal_entity_id, dimension_id, parent_id, code, name,
                   valid_from::text AS valid_from, valid_to::text AS valid_to, status`,
        [
          id,
          principal.tenantId,
          dimension.legal_entity_id,
          input.dimensionId,
          input.parentId ?? null,
          input.code,
          input.name,
          input.validFrom ?? null,
          input.validTo ?? null,
        ],
      );
      await publish(client, context, {
        eventType: 'dimension_value.created',
        aggregateType: 'dimension_value',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: dimension.legal_entity_id,
        payload: { dimension_code: dimension.code, code: input.code },
      });
      await recordAudit(client, context, {
        action: 'dimension_value.created',
        resourceType: 'dimension_value',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: dimension.legal_entity_id,
        after: rows[0]!,
      });
      return rows[0]!;
    });
  }

  // -------------------------------------------------------------------------
  // Account dimension rules (F-609)
  // -------------------------------------------------------------------------

  async getAccountDimensionRules(principal: TenantPrincipal, accountId: string) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const account = await this.loadAccount(client, principal, accountId);
      assertEntityPermission(principal, 'account.view', account.legal_entity_id);

      // Every dimension in the entity, with the account's rule where one exists.
      // Returning only the configured ones would make the screen a list of
      // exceptions with no way to see what it is an exception to.
      const { rows } = await client.query(
        `SELECT d.id AS dimension_id, d.code AS dimension_code, d.name AS dimension_name,
                coalesce(r.rule, 'OPTIONAL') AS rule, r.default_value_id,
                v.code AS default_value_code
           FROM dimensions d
           LEFT JOIN account_dimension_rules r
                  ON r.dimension_id = d.id AND r.account_id = $1
           LEFT JOIN dimension_values v ON v.id = r.default_value_id
          WHERE d.legal_entity_id = $2 AND d.status = 'ACTIVE'
          ORDER BY d.code`,
        [accountId, account.legal_entity_id],
      );
      return { data: rows, account: { id: account.id, code: account.code, name: account.name } };
    });
  }

  /**
   * Replaces the whole rule set for an account.
   *
   * PUT rather than PATCH because the alternative is an endpoint where removing a
   * REQUIRED rule needs a different call from adding one, and the two drift. Every
   * dimension not named in the body ends up OPTIONAL, which is doc 03's default
   * posture.
   */
  async setAccountDimensionRules(
    principal: TenantPrincipal,
    accountId: string,
    rules: readonly {
      dimensionId: string;
      rule: 'REQUIRED' | 'OPTIONAL' | 'PROHIBITED' | 'DEFAULTED';
      defaultValueId?: string | undefined;
    }[],
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const account = await this.loadAccount(client, principal, accountId);
      assertEntityPermission(principal, 'account.edit', account.legal_entity_id);

      const { rows: existing } = await client.query(
        `SELECT dimension_id, rule, default_value_id FROM account_dimension_rules
          WHERE account_id = $1 ORDER BY dimension_id`,
        [accountId],
      );

      await client.query(`DELETE FROM account_dimension_rules WHERE account_id = $1`, [accountId]);
      for (const rule of rules) {
        if (rule.rule === 'DEFAULTED' && !rule.defaultValueId) {
          throw new AppError(
            'VALIDATION_FAILED',
            'A DEFAULTED rule needs the value it defaults to.',
            {
              fieldErrors: [
                { field: 'default_value_id', code: 'REQUIRED', message: 'required for DEFAULTED' },
              ],
            },
          );
        }
        // OPTIONAL with no default is the absence of a rule; storing it would make
        // the table grow by one row per account per dimension for no information.
        if (rule.rule === 'OPTIONAL') continue;
        await client.query(
          `INSERT INTO account_dimension_rules (id, tenant_id, legal_entity_id, account_id,
                                                dimension_id, rule, default_value_id)
           VALUES ($1,$2,$3,$4,$5,$6::dimension_rule,$7)`,
          [
            uuidv7(),
            principal.tenantId,
            account.legal_entity_id,
            accountId,
            rule.dimensionId,
            rule.rule,
            rule.defaultValueId ?? null,
          ],
        );
      }

      const { rows: after } = await client.query(
        `SELECT dimension_id, rule, default_value_id FROM account_dimension_rules
          WHERE account_id = $1 ORDER BY dimension_id`,
        [accountId],
      );
      await recordAudit(client, context, {
        action: 'account.dimension_rules_set',
        resourceType: 'account',
        resourceId: accountId,
        tenantId: principal.tenantId,
        legalEntityId: account.legal_entity_id,
        before: { rules: existing },
        after: { rules: after },
      });
      return { data: after };
    });
  }

  // -------------------------------------------------------------------------

  private entityFilter(
    principal: TenantPrincipal,
    permission: string,
    alias: string,
    filters: { legalEntityId?: string | undefined },
  ): { where: string[]; params: unknown[] } {
    const where = [`${alias}.tenant_id = $1`];
    const params: unknown[] = [principal.tenantId];
    if (filters.legalEntityId) {
      assertEntityPermission(principal, permission, filters.legalEntityId);
      params.push(filters.legalEntityId);
      where.push(`${alias}.legal_entity_id = $${params.length}`);
    } else {
      const scope = entityScope(principal);
      if (scope.kind === 'ENTITIES') {
        params.push(scope.legalEntityIds);
        where.push(`${alias}.legal_entity_id = ANY($${params.length}::uuid[])`);
      }
    }
    return { where, params };
  }

  private async loadAccount(
    client: PoolClient,
    principal: TenantPrincipal,
    id: string,
  ): Promise<AccountRow> {
    const { rows } = await client.query<AccountRow>(
      `SELECT id, tenant_id, legal_entity_id, code, name, account_type, normal_balance,
              is_posting, is_control, is_system, status, version::text AS version
         FROM accounts WHERE id = $1 AND tenant_id = $2`,
      [id, principal.tenantId],
    );
    if (!rows[0]) throw notFound('Account', id);
    return rows[0];
  }

  /** Cross-entity reference check, phrased as the finding it prevents (F-003). */
  private async assertInEntity(
    client: PoolClient,
    table: 'accounts' | 'account_groups',
    id: string,
    legalEntityId: string,
  ): Promise<Record<string, unknown>> {
    const { rows } = await client.query(
      `SELECT * FROM ${table} WHERE id = $1 AND legal_entity_id = $2`,
      [id, legalEntityId],
    );
    if (!rows[0]) {
      throw new AppError(
        'CROSS_ENTITY_REFERENCE',
        `${table === 'accounts' ? 'Account' : 'Account group'} ${id} does not belong to this ` +
          'legal entity.',
        { details: { id, legal_entity_id: legalEntityId } },
      );
    }
    return rows[0] as Record<string, unknown>;
  }
}
