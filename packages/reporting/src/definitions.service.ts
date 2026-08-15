/**
 * `createReportDefinition` and `listReportDefinitions` (contracts/openapi.yaml,
 * phase 6, F-106).
 *
 * doc 12: "Changing report definition creates a new version. Historical approved
 * statement snapshot stores definition version." So a change is never an edit.
 * `createReportDefinition` writes version n+1 of the same (organization, code)
 * and leaves version n exactly as it was — a snapshot taken under it has to stay
 * reproducible, and rewriting the definition a signed statement was rendered from
 * would make the signature meaningless.
 *
 * Every caller-supplied value in a definition passes `validateReportDefinition`
 * before a row is written. That function IS the safety boundary and its header
 * documents the whole of it; the short version is that a definition can say which
 * accounts roll up to which line and what arithmetic combines the lines, and
 * cannot say anything else — no table, no column, no function, no filter, no
 * other tenant.
 */

import type { Pool, PoolClient } from 'pg';
import {
  AppError,
  assertEntityPermission,
  assertPermission,
  canInOrganization,
  entityScope,
  notFound,
  uuidv7,
  type TenantPrincipal,
} from '@acct/domain';
import { readInTenant, recordAudit, writeInTenant } from '@acct/database';
import {
  SEMANTIC_MODEL_BOUNDARY,
  validateReportColumns,
  validateReportDefinition,
  type ReportDefinitionSpec,
} from './semantic-model';

export interface AccountMappingSpec {
  readonly accountId: string;
  readonly legalEntityId: string;
  /** The row this account rolls up to. Null only for a recorded exclusion. */
  readonly rowNo?: number | null;
  readonly exclusionReason?: string | null;
}

export interface CreateReportDefinitionInput extends ReportDefinitionSpec {
  readonly accountMappings?: readonly AccountMappingSpec[];
}

export class ReportDefinitionsService {
  constructor(private readonly pool: Pool) {}

  async createReportDefinition(principal: TenantPrincipal, input: CreateReportDefinitionInput) {
    // Refused before the transaction opens: a definition that cannot be
    // rendered should not consume a version number, because a version number is
    // what a snapshot cites.
    const validated = validateReportDefinition(input);
    validateReportColumns(input.columns ?? []);

    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      await this.assertManagePermission(client, principal, input);

      const { rows: existing } = await client.query<{ version: number }>(
        `SELECT max(version) AS version FROM report_definitions
          WHERE organization_id = $1 AND code = $2 AND tenant_id = $3`,
        [input.organizationId, input.code, principal.tenantId],
      );
      const version = (existing[0]?.version ?? 0) + 1;

      const id = uuidv7();
      const { rows: created } = await client.query(
        `INSERT INTO report_definitions
           (id, tenant_id, legal_entity_id, organization_id, code, name, report_type, version,
            retained_earnings_method, rounding_display_unit, cash_flow_method, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::retained_earnings_method,$10,$11,$12)
         RETURNING id, legal_entity_id, organization_id, code, name, report_type, version,
                   retained_earnings_method::text AS retained_earnings_method,
                   rounding_display_unit, cash_flow_method, status::text AS status, created_at`,
        [
          id,
          principal.tenantId,
          input.legalEntityId ?? null,
          input.organizationId,
          input.code,
          input.name,
          input.reportType,
          version,
          input.retainedEarningsMethod ?? null,
          input.roundingDisplayUnit ?? null,
          input.cashFlowMethod ?? null,
          principal.userId,
        ],
      );

      const rowIdByRowNo = new Map<number, string>();
      for (const row of validated.rows) {
        const rowId = uuidv7();
        rowIdByRowNo.set(row.rowNo, rowId);
        await client.query(
          `INSERT INTO report_rows
             (id, tenant_id, report_definition_id, row_no, label, row_type, account_from,
              account_to, account_group_id, formula, sign_reversal, indent_level, is_bold,
              hide_if_zero)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            rowId,
            principal.tenantId,
            id,
            row.rowNo,
            row.label,
            row.rowType,
            row.accountFrom ?? null,
            row.accountTo ?? null,
            row.accountGroupId ?? null,
            row.formula ?? null,
            row.signReversal ?? false,
            row.indentLevel ?? 0,
            row.isBold ?? false,
            row.hideIfZero ?? false,
          ],
        );
      }

      for (const column of input.columns ?? []) {
        await client.query(
          `INSERT INTO report_columns
             (id, tenant_id, report_definition_id, column_no, label, column_type, period_offset,
              budget_id, legal_entity_id, formula)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            uuidv7(),
            principal.tenantId,
            id,
            column.columnNo,
            column.label,
            column.columnType,
            column.periodOffset ?? 0,
            column.budgetId ?? null,
            column.legalEntityId ?? null,
            column.formula ?? null,
          ],
        );
      }

      for (const mapping of input.accountMappings ?? []) {
        const rowId =
          mapping.rowNo === null || mapping.rowNo === undefined
            ? null
            : rowIdByRowNo.get(mapping.rowNo);
        if (mapping.rowNo != null && rowId === undefined) {
          throw new AppError(
            'VALIDATION_FAILED',
            `Account mapping points at row ${mapping.rowNo}, which this definition does not ` +
              `declare. The account would map to nothing and would be missing from the ` +
              `statement while looking mapped.`,
            { details: { row_no: mapping.rowNo, account_id: mapping.accountId } },
          );
        }
        // The XOR is a database CHECK (sam_line_xor_exclusion, 0053) and is
        // repeated here only so the caller is told which of the two it forgot.
        if (rowId === null && (mapping.exclusionReason ?? '').trim() === '') {
          throw new AppError(
            'VALIDATION_FAILED',
            `Account ${mapping.accountId} is mapped to no row and gives no exclusion reason. ` +
              `An account left off a statement with no recorded reason is indistinguishable ` +
              `from one nobody noticed; say why, or give it a row.`,
            { details: { account_id: mapping.accountId } },
          );
        }
        await client.query(
          `INSERT INTO statement_account_mappings
             (id, tenant_id, report_definition_id, legal_entity_id, account_id, report_row_id,
              exclusion_reason, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            uuidv7(),
            principal.tenantId,
            id,
            mapping.legalEntityId,
            mapping.accountId,
            rowId,
            rowId === null ? mapping.exclusionReason : null,
            principal.userId,
          ],
        );
      }

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        action: 'report_definition.created',
        resourceType: 'report_definition',
        resourceId: id,
        organizationId: input.organizationId,
        legalEntityId: input.legalEntityId ?? null,
        after: {
          code: input.code,
          version,
          report_type: input.reportType,
          rows: validated.rows.length,
          columns: (input.columns ?? []).length,
          mappings: (input.accountMappings ?? []).length,
        },
      });

      return {
        ...created[0],
        rows: validated.rows.map((r) => ({
          row_no: r.rowNo,
          label: r.label,
          row_type: r.rowType,
          account_from: r.accountFrom ?? null,
          account_to: r.accountTo ?? null,
          account_group_id: r.accountGroupId ?? null,
          formula: r.formula ?? null,
          references: r.referencedRows,
        })),
        evaluation_order: validated.evaluationOrder,
        semantic_model: SEMANTIC_MODEL_BOUNDARY,
      };
    });
  }

  async listReportDefinitions(
    principal: TenantPrincipal,
    query: {
      legalEntityId?: string | undefined;
      organizationId?: string | undefined;
      reportType?: string | undefined;
      code?: string | undefined;
      includeAllVersions?: boolean | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      assertPermission(principal, 'report.view');

      const params: unknown[] = [principal.tenantId];
      const where = ['d.tenant_id = $1'];

      if (query.legalEntityId) {
        assertEntityPermission(principal, 'report.view', query.legalEntityId);
        params.push(query.legalEntityId);
        // An organization-wide template (legal_entity_id IS NULL) applies to every
        // entity of the organization, so filtering by entity must not hide it —
        // hiding it would make the definition that renders the statement invisible
        // in the list of definitions.
        where.push(
          `(d.legal_entity_id = $${params.length} OR (d.legal_entity_id IS NULL AND
             d.organization_id = (SELECT organization_id FROM legal_entities
                                   WHERE id = $${params.length})))`,
        );
      } else {
        const scope = entityScope(principal);
        if (scope.kind === 'ENTITIES') {
          params.push(scope.legalEntityIds);
          where.push(
            `(d.legal_entity_id = ANY($${params.length}::uuid[]) OR d.legal_entity_id IS NULL)`,
          );
        } else if (scope.kind === 'ORGANIZATIONS') {
          params.push(scope.organizationIds);
          where.push(`d.organization_id = ANY($${params.length}::uuid[])`);
        }
      }
      if (query.organizationId) {
        params.push(query.organizationId);
        where.push(`d.organization_id = $${params.length}`);
      }
      if (query.reportType) {
        params.push(query.reportType);
        where.push(`d.report_type = $${params.length}`);
      }
      if (query.code) {
        params.push(query.code);
        where.push(`d.code = $${params.length}`);
      }
      if (!query.includeAllVersions) {
        where.push(
          `d.version = (SELECT max(v.version) FROM report_definitions v
                         WHERE v.organization_id = d.organization_id AND v.code = d.code
                           AND v.tenant_id = d.tenant_id)`,
        );
      }

      const { rows } = await client.query(
        `SELECT d.id, d.legal_entity_id, d.organization_id, d.code, d.name, d.report_type,
                d.version,
                d.retained_earnings_method::text AS retained_earnings_method,
                d.rounding_display_unit, d.cash_flow_method,
                d.status::text AS status, d.created_at,
                (d.version = (SELECT max(v.version) FROM report_definitions v
                               WHERE v.organization_id = d.organization_id AND v.code = d.code
                                 AND v.tenant_id = d.tenant_id)) AS is_latest,
                (SELECT coalesce(jsonb_agg(jsonb_build_object(
                          'id', r.id, 'row_no', r.row_no, 'label', r.label,
                          'row_type', r.row_type, 'account_from', r.account_from,
                          'account_to', r.account_to, 'account_group_id', r.account_group_id,
                          'formula', r.formula, 'sign_reversal', r.sign_reversal,
                          'indent_level', r.indent_level, 'is_bold', r.is_bold,
                          'hide_if_zero', r.hide_if_zero) ORDER BY r.row_no), '[]'::jsonb)
                   FROM report_rows r WHERE r.report_definition_id = d.id) AS rows,
                (SELECT coalesce(jsonb_agg(jsonb_build_object(
                          'column_no', c.column_no, 'label', c.label,
                          'column_type', c.column_type, 'period_offset', c.period_offset,
                          'budget_id', c.budget_id, 'legal_entity_id', c.legal_entity_id,
                          'formula', c.formula) ORDER BY c.column_no), '[]'::jsonb)
                   FROM report_columns c WHERE c.report_definition_id = d.id) AS columns,
                (SELECT count(*) FROM statement_account_mappings m
                  WHERE m.report_definition_id = d.id AND m.report_row_id IS NOT NULL)::int
                  AS mapped_account_count,
                (SELECT count(*) FROM statement_account_mappings m
                  WHERE m.report_definition_id = d.id AND m.report_row_id IS NULL)::int
                  AS excluded_account_count
           FROM report_definitions d
          WHERE ${where.join(' AND ')}
          ORDER BY d.code, d.version DESC`,
        params,
      );

      return { data: rows, semantic_model: SEMANTIC_MODEL_BOUNDARY };
    });
  }

  /**
   * The accounts of a definition's scope that reach no line, from 0053's
   * `statement_unmapped_accounts`.
   *
   * Not decoration. A statement that drops an account still balances while that
   * account nets to zero, and is wrong the first moment it does not — silently,
   * at some future date, in a report someone has already signed.
   */
  async coverage(principal: TenantPrincipal, definitionId: string, legalEntityId?: string) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      assertPermission(principal, 'report.view');
      const { rows: definitions } = await client.query<{
        id: string;
        legal_entity_id: string | null;
        code: string;
        version: number;
        report_type: string;
      }>(
        `SELECT id, legal_entity_id, code, version, report_type
           FROM report_definitions WHERE id = $1 AND tenant_id = $2`,
        [definitionId, principal.tenantId],
      );
      const definition = definitions[0];
      if (!definition) throw notFound('Report definition', definitionId);
      const entity = legalEntityId ?? definition.legal_entity_id;
      if (entity) assertEntityPermission(principal, 'report.view', entity);

      const { rows } = await client.query(
        `SELECT legal_entity_id, account_id, account_code, account_name,
                account_type::text AS account_type
           FROM statement_unmapped_accounts($1::uuid, $2::uuid[])`,
        [definitionId, entity ? [entity] : null],
      );
      return {
        report_definition_id: definitionId,
        code: definition.code,
        version: definition.version,
        report_type: definition.report_type,
        legal_entity_id: entity,
        unmapped_accounts: rows,
        complete: rows.length === 0,
      };
    });
  }

  /**
   * `report.manage`, asked about the right scope.
   *
   * An entity-scoped definition is checked against that entity. An
   * ORGANIZATION-WIDE template is checked against the organization, because it
   * will render statements for every entity in it — checking it against no entity
   * at all is how an entity-restricted user writes the definition every other
   * entity's statements are produced from.
   */
  private async assertManagePermission(
    client: PoolClient,
    principal: TenantPrincipal,
    input: CreateReportDefinitionInput,
  ): Promise<void> {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM organizations WHERE id = $1 AND tenant_id = $2`,
      [input.organizationId, principal.tenantId],
    );
    if (!rows[0]) throw notFound('Organization', input.organizationId);

    if (input.legalEntityId) {
      const { rows: entities } = await client.query<{ organization_id: string }>(
        `SELECT organization_id FROM legal_entities WHERE id = $1 AND tenant_id = $2`,
        [input.legalEntityId, principal.tenantId],
      );
      const entity = entities[0];
      if (!entity) throw notFound('Legal entity', input.legalEntityId);
      if (entity.organization_id !== input.organizationId) {
        throw new AppError(
          'CROSS_ENTITY_REFERENCE',
          `Legal entity ${input.legalEntityId} does not belong to organization ` +
            `${input.organizationId}, so a definition cannot be scoped to both.`,
        );
      }
      assertEntityPermission(principal, 'report.manage', input.legalEntityId);
      return;
    }

    if (!canInOrganization(principal, 'report.manage', input.organizationId)) {
      throw new AppError(
        'ENTITY_ACCESS_DENIED',
        'An organization-wide report definition renders statements for every entity in the ' +
          'organization, so it needs report.manage across the organization rather than in one ' +
          'entity.',
        { details: { permission: 'report.manage', organization_id: input.organizationId } },
      );
    }
  }
}
