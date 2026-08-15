import { Body, Controller, Get, Inject, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { validationFailed } from '@acct/domain';
import {
  AuditWorkspaceService,
  CASH_FLOW_METHODS,
  OUTPUT_FORMATS,
  REPORT_COLUMN_TYPES,
  REPORT_ROW_TYPES,
  REPORT_TYPES,
  ROUNDING_DISPLAY_UNITS,
  ReportDefinitionsService,
  ReportDrillService,
  ReportRunsService,
  StatementsService,
  type StatementQuery,
} from '@acct/reporting';
import { Operation } from '../common/operation';
import { code, isoDate, name, pageQuery, parse, uuid } from '../common/validation';
import type { AuthenticatedRequest } from '../common/auth.guard';
import { tenantPrincipal } from '../common/request';

/**
 * The ten phase-6 operations tagged `Reports` and `Audit` — the three statements,
 * the drill, report definitions, the export job and the auditor workspace.
 *
 * One controller because they are one subject: a statement, the definition that
 * shapes it, the journal lines behind each of its figures, the file it is exported
 * as, and the request an auditor raises against it. Splitting them by table would
 * put `/reports/drill-down` somewhere other than the statements whose amounts it
 * explains.
 *
 * Each handler declares only which contract operation it is. The permission
 * (`report.view`, `report.drill_down`, `report.manage`, `report.export`,
 * `audit.view`, `audit.manage`), whether an Idempotency-Key is required and the
 * success status (202 for a queued export, 201 for a created definition or
 * request) all come from `contracts/openapi.yaml` at request time.
 *
 * There is no arithmetic in this file, and there is deliberately no money in it
 * either: none of these ten operations takes a monetary value in a body or a
 * query. Every amount in a reporting response is produced by the statement engine
 * in `@acct/domain/statements` and serialised by `@acct/reporting` as a decimal
 * string; nothing here reads, rounds or re-renders one.
 */

/**
 * A boolean flag as it arrives in a query string.
 *
 * NOT `z.coerce.boolean()`, which is `Boolean("false") === true`: every non-empty
 * string coerces to true, so `?reconcile=false` would silently mean `reconcile=true`.
 * On these routes that matters — `reconcile` governs whether the tie to
 * `/reports/trial-balance` is measured at all, and `open_only` governs whether a
 * closed audit request is in the list. A flag that cannot be turned off is a flag
 * whose value nobody chose.
 */
const booleanQuery = z
  .enum(['true', 'false', '1', '0'], {
    errorMap: () => ({ message: 'true, false, 1 or 0' }),
  })
  .transform((v) => v === 'true' || v === '1');

/** A `timestamptz` as a caller writes one: a date, or a full ISO-8601 instant. */
const timestamp = z.union([isoDate, z.string().trim().datetime({ offset: true })]);

/**
 * A uuid list from a query string: repeated (`a=1&a=2`) or comma-separated.
 *
 * Needed by the drill because a statement line's drill token carries
 * `account_ids` — a profit-and-loss line covers every account that rolls up to it,
 * and `ReportDrillService.drillDown` takes that whole set. Accepting only the
 * contract's singular `account_id` would make every multi-account drill token
 * unreplayable over HTTP, which leaves exit criterion 2 ("every financial report
 * amount can drill to ledger lines") provable only for single-account lines — and
 * a criterion proved on part of its domain is proved on none of it. Reported as an
 * INTEGRATION NOTE for the contract; the route accepts it now so the token that
 * the statement already emits works.
 */
const uuidList = z
  .union([z.string(), z.array(z.string())])
  .transform((v) =>
    (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter((s) => s !== ''),
  )
  .pipe(z.array(uuid).min(1));

/**
 * The book a report is read from.
 *
 * `contracts/openapi.yaml` names the parameter `accounting_book_id`
 * (`components/parameters/BookId`) and the phase-2 report routes read `book_id`.
 * Both are accepted, and naming two different books in one request is refused
 * rather than resolved by precedence — a silent winner there means a statement
 * composed from one book and reconciled against another.
 */
const bookFields = {
  accounting_book_id: uuid.optional(),
  book_id: uuid.optional(),
};

type BookFields = { accounting_book_id?: string | undefined; book_id?: string | undefined };

function optionalBookId(q: BookFields): string | undefined {
  if (q.accounting_book_id && q.book_id && q.accounting_book_id !== q.book_id) {
    throw validationFailed(
      [
        {
          field: 'accounting_book_id',
          code: 'CONFLICT',
          message: `accounting_book_id=${q.accounting_book_id} and book_id=${q.book_id}`,
        },
      ],
      'This request names two different accounting books. Pass one: a report composed from ' +
        'one book and reconciled against another would tie to nothing.',
    );
  }
  return q.accounting_book_id ?? q.book_id;
}

function requiredBookId(q: BookFields): string {
  const id = optionalBookId(q);
  if (id === undefined) {
    throw validationFailed(
      [{ field: 'accounting_book_id', code: 'REQUIRED', message: 'a uuid' }],
      'A statement is composed from one accounting book. Pass accounting_book_id.',
    );
  }
  return id;
}

const statementFields = {
  ...bookFields,
  period_from: isoDate.optional(),
  period_to: isoDate.optional(),
  comparative_from: isoDate.optional(),
  comparative_to: isoDate.optional(),
  // doc 03's acceptance criterion as a parameter, and the loader's own: the same
  // statement composed from the projection and from raw journal lines.
  source: z.enum(['projection', 'journal_lines']).optional(),
  report_definition_id: uuid.optional(),
  // REJECT refuses to present a statement that leaves an account on no line.
  unmapped_policy: z.enum(['REPORT', 'REJECT']).optional(),
  // Off only where the comparison has already been made. The response says which
  // it was: with reconcile=false, `criterion.measured` is false and
  // `criterion.satisfied` is false with it, so a skipped check can never read as a
  // passed one.
  reconcile: booleanQuery.optional(),
};

const StatementQuerySchema = z.object(statementFields);
const CashFlowQuerySchema = z.object({
  ...statementFields,
  cash_flow_window: z.enum(['PERIOD', 'YEAR_TO_DATE']).optional(),
});

function statementQuery(q: z.infer<typeof StatementQuerySchema>): StatementQuery {
  return {
    accountingBookId: requiredBookId(q),
    periodFrom: q.period_from,
    periodTo: q.period_to,
    comparativeFrom: q.comparative_from,
    comparativeTo: q.comparative_to,
    source: q.source,
    reportDefinitionId: q.report_definition_id,
    unmappedPolicy: q.unmapped_policy,
    reconcile: q.reconcile,
  };
}

const ReportRowBody = z.object({
  row_no: z.number().int(),
  label: z.string().min(1),
  row_type: z.enum(REPORT_ROW_TYPES),
  account_from: z.string().nullish(),
  account_to: z.string().nullish(),
  account_group_id: uuid.nullish(),
  formula: z.string().nullish(),
  sign_reversal: z.boolean().optional(),
  indent_level: z.number().int().optional(),
  is_bold: z.boolean().optional(),
  hide_if_zero: z.boolean().optional(),
});

const ReportColumnBody = z.object({
  column_no: z.number().int(),
  label: z.string().min(1),
  column_type: z.enum(REPORT_COLUMN_TYPES),
  period_offset: z.number().int().optional(),
  budget_id: uuid.nullish(),
  legal_entity_id: uuid.nullish(),
  formula: z.string().nullish(),
});

/**
 * The definition body.
 *
 * Structural only. Whether a SUBTOTAL carries a formula, whether a range is
 * inverted, whether a formula references a row that does not exist or forms a
 * cycle — all of that is `validateReportDefinition`, which refuses with a sentence
 * naming the row. Repeating any of it here would produce two answers to the same
 * question, and the weaker one would be the one callers saw first.
 */
const CreateReportDefinitionBody = z.object({
  organization_id: uuid,
  legal_entity_id: uuid.nullish(),
  code,
  name,
  report_type: z.enum(REPORT_TYPES),
  retained_earnings_method: z.enum(['DERIVED', 'CLOSING_JOURNAL']).nullish(),
  rounding_display_unit: z.enum(ROUNDING_DISPLAY_UNITS).nullish(),
  cash_flow_method: z.enum(CASH_FLOW_METHODS).nullish(),
  rows: z.array(ReportRowBody),
  columns: z.array(ReportColumnBody).optional(),
  account_mappings: z
    .array(
      z.object({
        account_id: uuid,
        legal_entity_id: uuid,
        /** Null is a recorded exclusion — an account deliberately on no line. */
        row_no: z.number().int().nullish(),
        exclusion_reason: z.string().nullish(),
      }),
    )
    .optional(),
});

const CreateReportRunBody = z.object({
  legal_entity_id: uuid,
  report_type: z.enum(REPORT_TYPES),
  report_definition_id: uuid.nullish(),
  output_format: z.enum(OUTPUT_FORMATS).optional(),
  parameters: z.object({
    accounting_book_id: uuid,
    period_from: isoDate.nullish(),
    period_to: isoDate.nullish(),
    comparative_from: isoDate.nullish(),
    comparative_to: isoDate.nullish(),
    source: z.enum(['projection', 'journal_lines']).nullish(),
  }),
});

const CreateAuditRequestBody = z.object({
  legal_entity_id: uuid,
  accounting_period_id: uuid.nullish(),
  title: z.string().min(1),
  description: z.string().nullish(),
  owner_user_id: uuid.nullish(),
  due_at: timestamp.nullish(),
});

@Controller()
export class ReportingController {
  constructor(
    @Inject(StatementsService) private readonly statements: StatementsService,
    @Inject(ReportDrillService) private readonly drill: ReportDrillService,
    @Inject(ReportDefinitionsService) private readonly definitions: ReportDefinitionsService,
    @Inject(ReportRunsService) private readonly runs: ReportRunsService,
    @Inject(AuditWorkspaceService) private readonly audit: AuditWorkspaceService,
  ) {}

  // --- the three statements ------------------------------------------------

  @Get('reports/profit-loss')
  @Operation('getProfitLoss')
  async profitLoss(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(StatementQuerySchema, query);
    return this.statements.profitAndLoss(tenantPrincipal(req), statementQuery(q));
  }

  @Get('reports/balance-sheet')
  @Operation('getBalanceSheet')
  async balanceSheet(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(StatementQuerySchema, query);
    return this.statements.balanceSheet(tenantPrincipal(req), statementQuery(q));
  }

  @Get('reports/cash-flow')
  @Operation('getCashFlow')
  async cashFlow(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(CashFlowQuerySchema, query);
    return this.statements.cashFlow(tenantPrincipal(req), {
      ...statementQuery(q),
      cashFlowWindow: q.cash_flow_window,
    });
  }

  // --- the drill -----------------------------------------------------------

  /**
   * Exit criterion 2's last hop: from a report amount to the journal lines behind
   * it.
   *
   * `accounting_book_id` is optional here and required on the statements, which is
   * not an inconsistency: a drill launched from a `financial_snapshot_id` takes the
   * book from the snapshot, and the service refuses when neither is present —
   * naming the book of one statement while drilling another is exactly the mistake
   * it checks for.
   */
  @Get('reports/drill-down')
  @Operation('drillDownToJournalLines')
  async drillDown(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(
      pageQuery.extend({
        ...bookFields,
        period_from: isoDate.optional(),
        period_to: isoDate.optional(),
        account_id: uuid.optional(),
        account_ids: uuidList.optional(),
        report_definition_id: uuid.optional(),
        row_no: z.coerce.number().int().optional(),
        dimension_value_id: uuid.optional(),
        financial_snapshot_id: uuid.optional(),
      }),
      query,
    );
    return this.drill.drillDown(tenantPrincipal(req), {
      accountingBookId: optionalBookId(q),
      periodFrom: q.period_from,
      periodTo: q.period_to,
      accountId: q.account_id,
      accountIds: q.account_ids,
      reportDefinitionId: q.report_definition_id,
      rowNo: q.row_no,
      dimensionValueId: q.dimension_value_id,
      financialSnapshotId: q.financial_snapshot_id,
      cursor: q.cursor,
      limit: q.limit,
    });
  }

  // --- report definitions --------------------------------------------------

  @Get('report-definitions')
  @Operation('listReportDefinitions')
  async listDefinitions(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(
      z.object({
        legal_entity_id: uuid.optional(),
        organization_id: uuid.optional(),
        report_type: z.enum(REPORT_TYPES).optional(),
        code: code.optional(),
        // Off by default the list shows the current version of each definition.
        // A snapshot cites the version it was rendered under, so the superseded
        // ones have to remain reachable.
        include_all_versions: booleanQuery.optional(),
      }),
      query,
    );
    return this.definitions.listReportDefinitions(tenantPrincipal(req), {
      legalEntityId: q.legal_entity_id,
      organizationId: q.organization_id,
      reportType: q.report_type,
      code: q.code,
      includeAllVersions: q.include_all_versions,
    });
  }

  @Post('report-definitions')
  @Operation('createReportDefinition')
  async createDefinition(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const b = parse(CreateReportDefinitionBody, body);
    return this.definitions.createReportDefinition(tenantPrincipal(req), {
      organizationId: b.organization_id,
      legalEntityId: b.legal_entity_id,
      code: b.code,
      name: b.name,
      reportType: b.report_type,
      retainedEarningsMethod: b.retained_earnings_method,
      roundingDisplayUnit: b.rounding_display_unit,
      cashFlowMethod: b.cash_flow_method,
      rows: b.rows.map((r) => ({
        rowNo: r.row_no,
        label: r.label,
        rowType: r.row_type,
        accountFrom: r.account_from,
        accountTo: r.account_to,
        accountGroupId: r.account_group_id,
        formula: r.formula,
        signReversal: r.sign_reversal,
        indentLevel: r.indent_level,
        isBold: r.is_bold,
        hideIfZero: r.hide_if_zero,
      })),
      columns: b.columns?.map((c) => ({
        columnNo: c.column_no,
        label: c.label,
        columnType: c.column_type,
        periodOffset: c.period_offset,
        budgetId: c.budget_id,
        legalEntityId: c.legal_entity_id,
        formula: c.formula,
      })),
      accountMappings: b.account_mappings?.map((m) => ({
        accountId: m.account_id,
        legalEntityId: m.legal_entity_id,
        rowNo: m.row_no,
        exclusionReason: m.exclusion_reason,
      })),
    });
  }

  // --- the export job ------------------------------------------------------

  @Get('report-runs')
  @Operation('listReportRuns')
  async listRuns(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(
      pageQuery.extend({
        legal_entity_id: uuid.optional(),
        status: z.string().optional(),
        report_type: z.enum(REPORT_TYPES).optional(),
      }),
      query,
    );
    return this.runs.listReportRuns(tenantPrincipal(req), {
      legalEntityId: q.legal_entity_id,
      status: q.status,
      reportType: q.report_type,
      cursor: q.cursor,
      limit: q.limit,
    });
  }

  /**
   * Queues an export. doc 02's "export all financial data" is one of the seven
   * high-risk permissions, so `report.export` is high-risk in the registry and the
   * guard demands re-authentication for it — from the contract, not from here.
   */
  @Post('report-runs')
  @Operation('createReportRun')
  async createRun(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const b = parse(CreateReportRunBody, body);
    return this.runs.createReportRun(tenantPrincipal(req), {
      legalEntityId: b.legal_entity_id,
      reportType: b.report_type,
      reportDefinitionId: b.report_definition_id,
      outputFormat: b.output_format,
      parameters: {
        accountingBookId: b.parameters.accounting_book_id,
        periodFrom: b.parameters.period_from,
        periodTo: b.parameters.period_to,
        comparativeFrom: b.parameters.comparative_from,
        comparativeTo: b.parameters.comparative_to,
        source: b.parameters.source,
      },
    });
  }

  // --- the auditor workspace ----------------------------------------------

  @Get('audit-requests')
  @Operation('listAuditRequests')
  async listAuditRequests(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(
      pageQuery.extend({
        legal_entity_id: uuid.optional(),
        accounting_period_id: uuid.optional(),
        // Not an enum here: the service refuses an unknown status with the list of
        // the five `audit_requests.status` admits, which is the same check in one
        // place rather than two.
        status: z.string().optional(),
        owner_user_id: uuid.optional(),
        open_only: booleanQuery.optional(),
      }),
      query,
    );
    return this.audit.listAuditRequests(tenantPrincipal(req), {
      legalEntityId: q.legal_entity_id,
      accountingPeriodId: q.accounting_period_id,
      status: q.status,
      ownerUserId: q.owner_user_id,
      openOnly: q.open_only,
      cursor: q.cursor,
      limit: q.limit,
    });
  }

  @Post('audit-requests')
  @Operation('createAuditRequest')
  async createAuditRequest(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const b = parse(CreateAuditRequestBody, body);
    return this.audit.createAuditRequest(tenantPrincipal(req), {
      legalEntityId: b.legal_entity_id,
      accountingPeriodId: b.accounting_period_id,
      title: b.title,
      description: b.description,
      ownerUserId: b.owner_user_id,
      dueAt: b.due_at,
    });
  }
}
