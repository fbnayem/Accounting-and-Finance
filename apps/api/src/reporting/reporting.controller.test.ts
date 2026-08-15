/**
 * What this controller is: ten routes, and the translation between the wire and
 * `@acct/reporting`. So that is what is measured here — no database, no ledger.
 *
 *   1. Every route is mounted at the method and path `contracts/openapi.yaml`
 *      declares for the operation it names, checked by walking the router the
 *      application actually builds rather than by reading the decorators back.
 *   2. Every snake_case field arrives at the service as the camelCase input its
 *      signature declares, with its type intact. A binding that drops
 *      `comparative_to` or spells `unmappedPolicy` wrong still compiles, still
 *      answers 200, and silently composes a different statement.
 *
 * Both halves of every refusal are here: the request that must be refused AND the
 * neighbouring one that must be accepted. A book-id check that rejects everything
 * would pass a REJECT-only test.
 */
import {
  Module,
  type INestApplication,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { OPERATIONS } from '@acct/contracts';
import {
  AuditWorkspaceService,
  ReportDefinitionsService,
  ReportDrillService,
  ReportRunsService,
  StatementsService,
} from '@acct/reporting';
import { ReportingController } from './reporting.controller';
import { CorrelationMiddleware } from '../common/correlation.middleware';
import { HttpExceptionFilter } from '../common/http-exception.filter';
import { createLogger } from '../common/logger';
import { reconcileRoutes } from '../common/operation';
import type { AuthenticatedRequest } from '../common/auth.guard';

interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

const calls: RecordedCall[] = [];

function stub(...methods: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    methods.map((method) => [
      method,
      (...args: unknown[]) => {
        calls.push({ method, args });
        return Promise.resolve({ data: [] });
      },
    ]),
  );
}

/** The principal the guards would have established. Not under test here. */
function principalMiddleware(req: Request, _res: Response, next: NextFunction): void {
  (req as AuthenticatedRequest).principal = {
    userId: '00000000-0000-0000-0000-0000000000a1',
    sessionId: '00000000-0000-0000-0000-0000000000a2',
    email: 'reporter@example.test',
    displayName: 'Reporter',
    tenantId: '00000000-0000-0000-0000-0000000000a3',
    grants: [],
    mfaSatisfied: true,
    mfaVerifiedAt: null,
    impersonatedBy: null,
  };
  next();
}

@Module({
  controllers: [ReportingController],
  providers: [
    { provide: StatementsService, useValue: stub('profitAndLoss', 'balanceSheet', 'cashFlow') },
    { provide: ReportDrillService, useValue: stub('drillDown') },
    {
      provide: ReportDefinitionsService,
      useValue: stub('listReportDefinitions', 'createReportDefinition'),
    },
    { provide: ReportRunsService, useValue: stub('listReportRuns', 'createReportRun') },
    { provide: AuditWorkspaceService, useValue: stub('listAuditRequests', 'createAuditRequest') },
  ],
})
class ReportingTestModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware, principalMiddleware).forRoutes('*');
  }
}

let app: INestApplication;

const BOOK = '11111111-1111-1111-1111-111111111111';
const OTHER_BOOK = '22222222-2222-2222-2222-222222222222';
const ACCOUNT_A = '33333333-3333-3333-3333-333333333333';
const ACCOUNT_B = '44444444-4444-4444-4444-444444444444';
const ENTITY = '55555555-5555-5555-5555-555555555555';
const ORG = '66666666-6666-6666-6666-666666666666';

function http() {
  return request(app.getHttpServer());
}

function lastCall(method: string): RecordedCall {
  const call = [...calls].reverse().find((c) => c.method === method);
  if (!call) throw new Error(`${method} was never called`);
  return call;
}

/** The service input, which is always the second argument after the principal. */
function inputOf(method: string): Record<string, unknown> {
  return lastCall(method).args[1] as Record<string, unknown>;
}

beforeAll(async () => {
  app = await NestFactory.create(ReportingTestModule, { logger: false });
  // The same filter the application registers, because the refusals asserted below
  // are refusals in the contract's `Error` shape — a 422 with `field_errors` — and
  // without it every AppError would surface as an untranslated 500.
  app.useGlobalFilters(
    new HttpExceptionFilter(
      createLogger({ level: 'silent', service: 'test', environment: 'test', buildSha: 'test' }),
    ),
  );
  await app.init();
});

afterAll(async () => {
  await app.close();
});

describe('the routes are the contract’s routes', () => {
  const MINE = [
    'getProfitLoss',
    'getBalanceSheet',
    'getCashFlow',
    'drillDownToJournalLines',
    'listReportDefinitions',
    'createReportDefinition',
    'listReportRuns',
    'createReportRun',
    'listAuditRequests',
    'createAuditRequest',
  ] as const;

  it('mounts all ten, each at the method and path the contract declares', () => {
    // `phases: []` asks only the direction this controller can answer: every route
    // it mounts agrees with the contract. The other direction — that no phase-6
    // operation is missing a handler — belongs to the assembled application, and
    // asserting it here would fail on the close and workflow routes this file does
    // not own.
    const { mismatches, matched } = reconcileRoutes(app, { phases: [] });
    expect(mismatches).toEqual([]);
    expect(matched).toBe(MINE.length);
  });

  it('answers each one with the status code the contract declares', async () => {
    // 202 for the queued export and 201 for the two creates are not defaults;
    // they come from the contract through @Operation.
    expect(OPERATIONS.createReportRun.successStatus).toBe(202);
    await http()
      .post('/report-runs')
      .send({
        legal_entity_id: ENTITY,
        report_type: 'PROFIT_LOSS',
        parameters: { accounting_book_id: BOOK },
      })
      .expect(202);
    await http()
      .post('/audit-requests')
      .send({ legal_entity_id: ENTITY, title: 'Bank confirmations' })
      .expect(201);
    await http().get('/reports/profit-loss').query({ accounting_book_id: BOOK }).expect(200);
  });
});

describe('statements: the wire becomes a StatementQuery', () => {
  it('carries every parameter through, with types intact', async () => {
    await http()
      .get('/reports/profit-loss')
      .query({
        accounting_book_id: BOOK,
        period_from: '2026-01-01',
        period_to: '2026-03-31',
        comparative_from: '2025-01-01',
        comparative_to: '2025-03-31',
        source: 'journal_lines',
        report_definition_id: ORG,
        unmapped_policy: 'REJECT',
        reconcile: 'true',
      })
      .expect(200);

    expect(inputOf('profitAndLoss')).toEqual({
      accountingBookId: BOOK,
      periodFrom: '2026-01-01',
      periodTo: '2026-03-31',
      comparativeFrom: '2025-01-01',
      comparativeTo: '2025-03-31',
      source: 'journal_lines',
      reportDefinitionId: ORG,
      unmappedPolicy: 'REJECT',
      reconcile: true,
    });
  });

  it('sends reconcile=false as false, not as Boolean("false")', async () => {
    // The reason `booleanQuery` exists. With `z.coerce.boolean()` this assertion
    // reads `true`, the tie to /reports/trial-balance is measured when the caller
    // asked for it not to be, and no test that only checks `reconcile=true` would
    // ever notice.
    await http()
      .get('/reports/balance-sheet')
      .query({ accounting_book_id: BOOK, reconcile: 'false' })
      .expect(200);
    expect(inputOf('balanceSheet')['reconcile']).toBe(false);

    await http()
      .get('/reports/balance-sheet')
      .query({ accounting_book_id: BOOK, reconcile: 'true' })
      .expect(200);
    expect(inputOf('balanceSheet')['reconcile']).toBe(true);

    await http().get('/reports/balance-sheet').query({ accounting_book_id: BOOK }).expect(200);
    expect(inputOf('balanceSheet')['reconcile']).toBeUndefined();
  });

  it('passes the cash flow window only on the cash flow route', async () => {
    await http()
      .get('/reports/cash-flow')
      .query({ accounting_book_id: BOOK, cash_flow_window: 'YEAR_TO_DATE' })
      .expect(200);
    expect(inputOf('cashFlow')['cashFlowWindow']).toBe('YEAR_TO_DATE');

    await http().get('/reports/cash-flow').query({ accounting_book_id: BOOK }).expect(200);
    expect(inputOf('cashFlow')['cashFlowWindow']).toBeUndefined();
  });

  it('accepts either spelling of the book, and refuses two different books', async () => {
    await http().get('/reports/profit-loss').query({ book_id: BOOK }).expect(200);
    expect(inputOf('profitAndLoss')['accountingBookId']).toBe(BOOK);

    await http().get('/reports/profit-loss').query({ accounting_book_id: BOOK }).expect(200);
    expect(inputOf('profitAndLoss')['accountingBookId']).toBe(BOOK);

    // The same book under both names is one book, not a conflict.
    await http()
      .get('/reports/profit-loss')
      .query({ accounting_book_id: BOOK, book_id: BOOK })
      .expect(200);
    expect(inputOf('profitAndLoss')['accountingBookId']).toBe(BOOK);

    const conflict = await http()
      .get('/reports/profit-loss')
      .query({ accounting_book_id: BOOK, book_id: OTHER_BOOK })
      .expect(422);
    expect(conflict.body.code).toBe('VALIDATION_FAILED');
    expect(conflict.body.message).toContain('two different accounting books');
  });

  it('refuses a statement with no book at all', async () => {
    const refused = await http().get('/reports/profit-loss').expect(422);
    expect(refused.body.code).toBe('VALIDATION_FAILED');
    expect(refused.body.field_errors).toContainEqual({
      field: 'accounting_book_id',
      code: 'REQUIRED',
      message: 'a uuid',
    });
  });
});

describe('the drill', () => {
  it('takes the whole account set a statement line drills with', async () => {
    // The drill token a profit-and-loss line carries is `account_ids`, plural. If
    // only `account_id` were accepted, every line covering more than one account
    // would be undrillable and exit criterion 2 would hold for single-account
    // lines only.
    await http()
      .get('/reports/drill-down')
      .query({ accounting_book_id: BOOK, account_ids: `${ACCOUNT_A},${ACCOUNT_B}` })
      .expect(200);
    expect(inputOf('drillDown')['accountIds']).toEqual([ACCOUNT_A, ACCOUNT_B]);

    // Repeated parameters are the other spelling of the same list.
    await http()
      .get(
        `/reports/drill-down?accounting_book_id=${BOOK}` +
          `&account_ids=${ACCOUNT_A}&account_ids=${ACCOUNT_B}`,
      )
      .expect(200);
    expect(inputOf('drillDown')['accountIds']).toEqual([ACCOUNT_A, ACCOUNT_B]);

    // And the contract's singular still works on its own.
    await http()
      .get('/reports/drill-down')
      .query({ accounting_book_id: BOOK, account_id: ACCOUNT_A })
      .expect(200);
    expect(inputOf('drillDown')['accountId']).toBe(ACCOUNT_A);
    expect(inputOf('drillDown')['accountIds']).toBeUndefined();
  });

  it('refuses an account list that is not uuids', async () => {
    const refused = await http()
      .get('/reports/drill-down')
      .query({ accounting_book_id: BOOK, account_ids: 'not-a-uuid' })
      .expect(422);
    expect(refused.body.code).toBe('VALIDATION_FAILED');
  });

  it('passes the report row, the dimension, the snapshot and the page through', async () => {
    await http()
      .get('/reports/drill-down')
      .query({
        report_definition_id: ORG,
        row_no: '40',
        dimension_value_id: ENTITY,
        financial_snapshot_id: ACCOUNT_B,
        period_from: '2026-01-01',
        period_to: '2026-01-31',
        limit: '25',
      })
      .expect(200);

    expect(inputOf('drillDown')).toEqual({
      accountingBookId: undefined,
      periodFrom: '2026-01-01',
      periodTo: '2026-01-31',
      accountId: undefined,
      accountIds: undefined,
      reportDefinitionId: ORG,
      // An integer, not the string "40": a row number compared as a string
      // matches no row.
      rowNo: 40,
      dimensionValueId: ENTITY,
      financialSnapshotId: ACCOUNT_B,
      cursor: undefined,
      limit: 25,
    });
  });

  it('refuses a limit above the contract’s maximum', async () => {
    await http()
      .get('/reports/drill-down')
      .query({ accounting_book_id: BOOK, limit: '201' })
      .expect(422);
    await http()
      .get('/reports/drill-down')
      .query({ accounting_book_id: BOOK, limit: '200' })
      .expect(200);
    expect(inputOf('drillDown')['limit']).toBe(200);
  });
});

describe('report definitions', () => {
  it('maps a definition, its rows, its columns and its mappings', async () => {
    await http()
      .post('/report-definitions')
      .send({
        organization_id: ORG,
        legal_entity_id: ENTITY,
        code: 'STATUTORY_PL',
        name: 'Statutory profit and loss',
        report_type: 'PROFIT_LOSS',
        retained_earnings_method: 'DERIVED',
        rounding_display_unit: 'THOUSAND',
        rows: [
          {
            row_no: 10,
            label: 'Revenue',
            row_type: 'ACCOUNT_RANGE',
            account_from: '4000',
            account_to: '4999',
            sign_reversal: true,
            indent_level: 1,
            is_bold: false,
            hide_if_zero: true,
          },
          { row_no: 20, label: 'Gross profit', row_type: 'SUBTOTAL', formula: 'R10' },
        ],
        columns: [{ column_no: 1, label: 'This period', column_type: 'PERIOD', period_offset: 0 }],
        account_mappings: [
          { account_id: ACCOUNT_A, legal_entity_id: ENTITY, row_no: 10 },
          {
            account_id: ACCOUNT_B,
            legal_entity_id: ENTITY,
            row_no: null,
            exclusion_reason: 'Memo account, never presented',
          },
        ],
      })
      .expect(201);

    const input = inputOf('createReportDefinition');
    expect(input['organizationId']).toBe(ORG);
    expect(input['legalEntityId']).toBe(ENTITY);
    expect(input['code']).toBe('STATUTORY_PL');
    expect(input['reportType']).toBe('PROFIT_LOSS');
    expect(input['retainedEarningsMethod']).toBe('DERIVED');
    expect(input['roundingDisplayUnit']).toBe('THOUSAND');
    expect(input['rows']).toEqual([
      {
        rowNo: 10,
        label: 'Revenue',
        rowType: 'ACCOUNT_RANGE',
        accountFrom: '4000',
        accountTo: '4999',
        accountGroupId: undefined,
        formula: undefined,
        signReversal: true,
        indentLevel: 1,
        isBold: false,
        hideIfZero: true,
      },
      {
        rowNo: 20,
        label: 'Gross profit',
        rowType: 'SUBTOTAL',
        accountFrom: undefined,
        accountTo: undefined,
        accountGroupId: undefined,
        formula: 'R10',
        signReversal: undefined,
        indentLevel: undefined,
        isBold: undefined,
        hideIfZero: undefined,
      },
    ]);
    expect(input['columns']).toEqual([
      {
        columnNo: 1,
        label: 'This period',
        columnType: 'PERIOD',
        periodOffset: 0,
        budgetId: undefined,
        legalEntityId: undefined,
        formula: undefined,
      },
    ]);
    expect(input['accountMappings']).toEqual([
      { accountId: ACCOUNT_A, legalEntityId: ENTITY, rowNo: 10, exclusionReason: undefined },
      {
        accountId: ACCOUNT_B,
        legalEntityId: ENTITY,
        // Null, not dropped: a null row_no IS the recorded exclusion, and an
        // undefined one would be read as "not stated".
        rowNo: null,
        exclusionReason: 'Memo account, never presented',
      },
    ]);
  });

  it('refuses an unknown row type and accepts every known one', async () => {
    await http()
      .post('/report-definitions')
      .send({
        organization_id: ORG,
        code: 'BAD',
        name: 'Bad',
        report_type: 'PROFIT_LOSS',
        rows: [{ row_no: 10, label: 'Revenue', row_type: 'ACCOUNT_TREE' }],
      })
      .expect(422);

    for (const rowType of [
      'ACCOUNT_RANGE',
      'ACCOUNT_GROUP',
      'FORMULA',
      'SUBTOTAL',
      'HEADER',
      'SPACER',
    ]) {
      await http()
        .post('/report-definitions')
        .send({
          organization_id: ORG,
          code: 'OK',
          name: 'Ok',
          report_type: 'PROFIT_LOSS',
          rows: [{ row_no: 10, label: 'Revenue', row_type: rowType }],
        })
        .expect(201);
      expect((inputOf('createReportDefinition')['rows'] as { rowType: string }[])[0]?.rowType).toBe(
        rowType,
      );
    }
  });

  it('shows the current version unless every version is asked for', async () => {
    await http()
      .get('/report-definitions')
      .query({ legal_entity_id: ENTITY, report_type: 'BALANCE_SHEET', include_all_versions: '1' })
      .expect(200);
    expect(inputOf('listReportDefinitions')).toEqual({
      legalEntityId: ENTITY,
      organizationId: undefined,
      reportType: 'BALANCE_SHEET',
      code: undefined,
      includeAllVersions: true,
    });

    await http().get('/report-definitions').query({ include_all_versions: '0' }).expect(200);
    expect(inputOf('listReportDefinitions')['includeAllVersions']).toBe(false);
  });
});

describe('report runs', () => {
  it('maps the export request, parameters included', async () => {
    await http()
      .post('/report-runs')
      .send({
        legal_entity_id: ENTITY,
        report_type: 'BALANCE_SHEET',
        report_definition_id: ORG,
        output_format: 'CSV',
        parameters: {
          accounting_book_id: BOOK,
          period_from: '2026-01-01',
          period_to: '2026-03-31',
          comparative_from: '2025-01-01',
          comparative_to: '2025-03-31',
          source: 'projection',
        },
      })
      .expect(202);

    expect(inputOf('createReportRun')).toEqual({
      legalEntityId: ENTITY,
      reportType: 'BALANCE_SHEET',
      reportDefinitionId: ORG,
      outputFormat: 'CSV',
      parameters: {
        accountingBookId: BOOK,
        periodFrom: '2026-01-01',
        periodTo: '2026-03-31',
        comparativeFrom: '2025-01-01',
        comparativeTo: '2025-03-31',
        source: 'projection',
      },
    });
  });

  it('refuses an output format the executor cannot produce, and accepts the four it can', async () => {
    await http()
      .post('/report-runs')
      .send({
        legal_entity_id: ENTITY,
        report_type: 'PROFIT_LOSS',
        output_format: 'DOCX',
        parameters: { accounting_book_id: BOOK },
      })
      .expect(422);

    for (const format of ['CSV', 'XLSX', 'PDF', 'JSON']) {
      await http()
        .post('/report-runs')
        .send({
          legal_entity_id: ENTITY,
          report_type: 'PROFIT_LOSS',
          output_format: format,
          parameters: { accounting_book_id: BOOK },
        })
        .expect(202);
      expect(inputOf('createReportRun')['outputFormat']).toBe(format);
    }
  });

  it('pages the run list', async () => {
    await http()
      .get('/report-runs')
      .query({ legal_entity_id: ENTITY, status: 'QUEUED', report_type: 'CASH_FLOW', limit: '10' })
      .expect(200);
    expect(inputOf('listReportRuns')).toEqual({
      legalEntityId: ENTITY,
      status: 'QUEUED',
      reportType: 'CASH_FLOW',
      cursor: undefined,
      limit: 10,
    });
  });
});

describe('the auditor workspace', () => {
  it('maps a request, its period, its owner and its due date', async () => {
    await http()
      .post('/audit-requests')
      .send({
        legal_entity_id: ENTITY,
        accounting_period_id: ORG,
        title: 'Bank confirmations for Q1',
        description: 'All accounts, including closed ones.',
        owner_user_id: ACCOUNT_A,
        due_at: '2026-04-30T17:00:00Z',
      })
      .expect(201);

    expect(inputOf('createAuditRequest')).toEqual({
      legalEntityId: ENTITY,
      accountingPeriodId: ORG,
      title: 'Bank confirmations for Q1',
      description: 'All accounts, including closed ones.',
      ownerUserId: ACCOUNT_A,
      dueAt: '2026-04-30T17:00:00Z',
    });
  });

  it('takes a plain date as a due date and refuses a non-date', async () => {
    await http()
      .post('/audit-requests')
      .send({ legal_entity_id: ENTITY, title: 'Inventory observation', due_at: '2026-04-30' })
      .expect(201);
    expect(inputOf('createAuditRequest')['dueAt']).toBe('2026-04-30');

    await http()
      .post('/audit-requests')
      .send({ legal_entity_id: ENTITY, title: 'Inventory observation', due_at: 'next Friday' })
      .expect(422);
  });

  it('filters the workspace, and open_only=false means false', async () => {
    await http()
      .get('/audit-requests')
      .query({
        legal_entity_id: ENTITY,
        accounting_period_id: ORG,
        status: 'IN_PROGRESS',
        owner_user_id: ACCOUNT_A,
        open_only: 'true',
        limit: '5',
      })
      .expect(200);
    expect(inputOf('listAuditRequests')).toEqual({
      legalEntityId: ENTITY,
      accountingPeriodId: ORG,
      status: 'IN_PROGRESS',
      ownerUserId: ACCOUNT_A,
      openOnly: true,
      cursor: undefined,
      limit: 5,
    });

    await http().get('/audit-requests').query({ open_only: 'false' }).expect(200);
    expect(inputOf('listAuditRequests')['openOnly']).toBe(false);
  });
});
