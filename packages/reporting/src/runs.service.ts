/**
 * `createReportRun` and `listReportRuns` (contracts/openapi.yaml, phase 6, F-106).
 *
 * The route is an asynchronous export job and answers 202. doc 02 names "export
 * all financial data" among the seven high-risk permissions, so `report.export`
 * is high-risk in the registry and is asserted against the entity being exported
 * rather than merely held somewhere in the tenant.
 *
 * The parameters are validated at QUEUE time, not at run time, and that is the
 * point of this file rather than an insert. A run row that names a book the
 * caller cannot see, a definition from another organization or a period window
 * with a hole in it is a registered intention that can never execute — it sits in
 * the list looking pending until somebody investigates, and the person who asked
 * for the export finds out it never ran when they needed the file.
 *
 * `executeReportRun` is here for the same reason. A QUEUED row nothing can
 * execute is the same failure one step later, so the executor exists, claims a
 * run atomically and records what it produced. What schedules it is a worker, and
 * that wiring is an INTEGRATION NOTE rather than something this package can do
 * to itself.
 */

import type { Pool } from 'pg';
import {
  AppError,
  assertEntityPermission,
  assertPermission,
  buildPage,
  encodeCursor,
  entityScope,
  notFound,
  resolvePage,
  uuidv7,
  type TenantPrincipal,
} from '@acct/domain';
import { readInTenant, recordAudit, writeInTenant } from '@acct/database';
import { REPORT_TYPES, type ReportType } from './semantic-model';
import type { StatementsService } from './statements.service';
import type { BalanceSource } from './trial-balance.loader';

export const OUTPUT_FORMATS = ['CSV', 'XLSX', 'PDF', 'JSON'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export interface CreateReportRunInput {
  readonly legalEntityId: string;
  readonly reportType: ReportType;
  readonly reportDefinitionId?: string | null;
  readonly outputFormat?: OutputFormat;
  readonly parameters: {
    readonly accountingBookId: string;
    readonly periodFrom?: string | null;
    readonly periodTo?: string | null;
    readonly comparativeFrom?: string | null;
    readonly comparativeTo?: string | null;
    readonly source?: BalanceSource | null;
  };
}

/**
 * Where a produced export goes.
 *
 * Injected rather than assumed, because this package has no file store and
 * inventing one would put the statement bytes somewhere nothing else can find
 * them. With no sink the run still COMPLETES and still records what it produced —
 * the payload is returned to the executor — and `output_file_id` stays null,
 * which is the honest record of "produced, not stored".
 */
export interface ReportRunSink {
  deliver(run: {
    readonly id: string;
    readonly tenantId: string;
    readonly legalEntityId: string;
    readonly outputFormat: OutputFormat;
    readonly payload: unknown;
  }): Promise<{ fileId: string | null }>;
}

export class ReportRunsService {
  constructor(
    private readonly pool: Pool,
    private readonly statements: StatementsService,
    private readonly sink?: ReportRunSink,
  ) {}

  async createReportRun(principal: TenantPrincipal, input: CreateReportRunInput) {
    if (!(REPORT_TYPES as readonly string[]).includes(input.reportType)) {
      throw new AppError(
        'VALIDATION_FAILED',
        `"${String(input.reportType)}" is not a report type. The model admits ` +
          `${REPORT_TYPES.join(', ')}.`,
      );
    }
    const format = input.outputFormat ?? 'JSON';
    if (!(OUTPUT_FORMATS as readonly string[]).includes(format)) {
      throw new AppError(
        'VALIDATION_FAILED',
        `"${String(format)}" is not an output format. The model admits ` +
          `${OUTPUT_FORMATS.join(', ')}.`,
      );
    }

    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      // doc 02's high-risk export, checked against the entity whose data leaves.
      assertEntityPermission(principal, 'report.export', input.legalEntityId);

      const { rows: books } = await client.query<{ id: string; legal_entity_id: string }>(
        `SELECT id, legal_entity_id FROM accounting_books WHERE id = $1 AND tenant_id = $2`,
        [input.parameters.accountingBookId, principal.tenantId],
      );
      const book = books[0];
      if (!book) throw notFound('Accounting book', input.parameters.accountingBookId);
      if (book.legal_entity_id !== input.legalEntityId) {
        throw new AppError(
          'CROSS_ENTITY_REFERENCE',
          `Accounting book ${book.id} belongs to a different legal entity than the one this ` +
            `export is scoped to. The export would carry another entity's ledger under this ` +
            `entity's permission check.`,
          { details: { book_id: book.id, legal_entity_id: input.legalEntityId } },
        );
      }

      if (input.reportDefinitionId) {
        const { rows: definitions } = await client.query<{
          id: string;
          legal_entity_id: string | null;
          organization_id: string;
        }>(
          `SELECT id, legal_entity_id, organization_id FROM report_definitions
            WHERE id = $1 AND tenant_id = $2`,
          [input.reportDefinitionId, principal.tenantId],
        );
        const definition = definitions[0];
        if (!definition) throw notFound('Report definition', input.reportDefinitionId);
        if (
          definition.legal_entity_id !== null &&
          definition.legal_entity_id !== input.legalEntityId
        ) {
          throw new AppError(
            'CROSS_ENTITY_REFERENCE',
            `Report definition ${definition.id} is scoped to another legal entity, so an export ` +
              `of ${input.legalEntityId} rendered under it would present one entity's accounts ` +
              `under another's headings.`,
          );
        }
      }

      // The window, resolved now. `report_period_window` refuses a window the
      // ledger orders other periods inside; discovering that when the worker
      // picks the job up would leave a FAILED run and no explanation the
      // requester ever sees.
      await client.query(
        `SELECT 1 FROM report_period_window_bounds($1::uuid, $2::date, $3::date)`,
        [
          book.legal_entity_id,
          input.parameters.periodFrom ?? null,
          input.parameters.periodTo ?? null,
        ],
      );

      const id = uuidv7();
      const { rows } = await client.query(
        `INSERT INTO report_runs
           (id, tenant_id, legal_entity_id, report_definition_id, report_type, parameters,
            requested_by, output_format, status)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'QUEUED')
         RETURNING id, legal_entity_id, report_definition_id, report_type, parameters,
                   status::text AS status, output_format, requested_by, requested_at,
                   output_file_id, row_count, duration_ms, error, completed_at`,
        [
          id,
          principal.tenantId,
          input.legalEntityId,
          input.reportDefinitionId ?? null,
          input.reportType,
          JSON.stringify(input.parameters),
          principal.userId,
          format,
        ],
      );

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        action: 'report_run.requested',
        resourceType: 'report_run',
        resourceId: id,
        legalEntityId: input.legalEntityId,
        after: {
          report_type: input.reportType,
          output_format: format,
          report_definition_id: input.reportDefinitionId ?? null,
          parameters: input.parameters,
          high_risk: true,
        },
      });

      return {
        ...rows[0],
        // A queued job with nothing scheduled to run it is a registered intention.
        // The response says which it is rather than letting a 202 imply the other.
        executor_wired: this.sink !== undefined,
      };
    });
  }

  async listReportRuns(
    principal: TenantPrincipal,
    query: {
      legalEntityId?: string | undefined;
      status?: string | undefined;
      reportType?: string | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    },
  ) {
    const page = resolvePage({ cursor: query.cursor, limit: query.limit });
    return readInTenant(this.pool, principal, async ({ client }) => {
      assertPermission(principal, 'report.view');

      const params: unknown[] = [principal.tenantId];
      const where = ['r.tenant_id = $1'];
      if (query.legalEntityId) {
        assertEntityPermission(principal, 'report.view', query.legalEntityId);
        params.push(query.legalEntityId);
        where.push(`r.legal_entity_id = $${params.length}`);
      } else {
        const scope = entityScope(principal);
        if (scope.kind === 'ENTITIES') {
          params.push(scope.legalEntityIds);
          where.push(`r.legal_entity_id = ANY($${params.length}::uuid[])`);
        }
      }
      if (query.status) {
        params.push(query.status);
        where.push(`r.status = $${params.length}::job_status`);
      }
      if (query.reportType) {
        params.push(query.reportType);
        where.push(`r.report_type = $${params.length}`);
      }
      if (page.after) {
        params.push(page.after.k, page.after.id);
        where.push(
          `(r.requested_at, r.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
        );
      }
      params.push(page.limit + 1);

      const { rows } = await client.query<{
        id: string;
        requested_at: string;
      }>(
        `SELECT r.id, r.legal_entity_id, r.report_definition_id, r.report_type, r.parameters,
                r.status::text AS status, r.output_format, r.output_file_id, r.row_count,
                r.duration_ms, r.error, r.requested_by, r.requested_at::text AS requested_at,
                r.completed_at
           FROM report_runs r
          WHERE ${where.join(' AND ')}
          ORDER BY r.requested_at DESC, r.id DESC
          LIMIT $${params.length}`,
        params,
      );

      const built = buildPage(rows, page.limit, 'desc', (row) => ({
        k: row.requested_at,
        id: row.id,
      }));
      const last = built.data[built.data.length - 1];
      return {
        data: built.data,
        meta: {
          has_more: built.meta.has_more,
          next_cursor:
            built.meta.has_more && last
              ? encodeCursor({ k: last.requested_at, id: last.id, d: 'desc' })
              : null,
          limit: page.limit,
          limit_source: query.limit === undefined ? 'DEFAULT' : 'REQUEST',
        },
      };
    });
  }

  /**
   * Claims one QUEUED run and produces it.
   *
   * The claim is a conditional UPDATE returning the row, so two workers cannot
   * both take the same job — the second one's UPDATE matches nothing and it is
   * told the run is already claimed rather than producing a second export of the
   * same data under the same id.
   *
   * The composition itself is `StatementsService.financialStatements`, which is
   * the same code path the interactive routes use. An export produced by a second
   * implementation would be a second set of numbers with a filename on it.
   */
  async executeReportRun(principal: TenantPrincipal, runId: string) {
    const started = Date.now();

    const claimed = await writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows } = await client.query<{
        id: string;
        legal_entity_id: string;
        report_definition_id: string | null;
        report_type: string;
        parameters: Record<string, unknown>;
        output_format: OutputFormat | null;
      }>(
        `UPDATE report_runs
            SET status = 'RUNNING'
          WHERE id = $1 AND tenant_id = $2 AND status = 'QUEUED'
        RETURNING id, legal_entity_id, report_definition_id, report_type, parameters,
                  output_format`,
        [runId, principal.tenantId],
      );
      const run = rows[0];
      if (!run) {
        const { rows: current } = await client.query<{ status: string }>(
          `SELECT status::text AS status FROM report_runs WHERE id = $1 AND tenant_id = $2`,
          [runId, principal.tenantId],
        );
        if (!current[0]) throw notFound('Report run', runId);
        throw new AppError(
          'IN_PROGRESS',
          `Report run ${runId} is ${current[0].status}, not QUEUED. Only a queued run can be ` +
            `claimed; re-running a completed export would produce a second file under the same ` +
            `job id.`,
          { details: { run_id: runId, status: current[0].status } },
        );
      }
      assertEntityPermission(principal, 'report.export', run.legal_entity_id);
      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        action: 'report_run.started',
        resourceType: 'report_run',
        resourceId: run.id,
        legalEntityId: run.legal_entity_id,
        after: { status: 'RUNNING' },
      });
      return run;
    });

    try {
      const parameters = claimed.parameters as {
        accountingBookId?: string;
        periodFrom?: string | null;
        periodTo?: string | null;
        comparativeFrom?: string | null;
        comparativeTo?: string | null;
        source?: BalanceSource | null;
      };
      if (!parameters.accountingBookId) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Report run ${runId} records no accounting book in its parameters, so there is no ` +
            `ledger to export.`,
        );
      }

      const payload = await this.statements.financialStatements(principal, {
        accountingBookId: parameters.accountingBookId,
        periodFrom: parameters.periodFrom ?? undefined,
        periodTo: parameters.periodTo ?? undefined,
        comparativeFrom: parameters.comparativeFrom ?? undefined,
        comparativeTo: parameters.comparativeTo ?? undefined,
        source: parameters.source ?? undefined,
        reportDefinitionId: claimed.report_definition_id ?? undefined,
      });

      const format = claimed.output_format ?? 'JSON';
      const delivered = this.sink
        ? await this.sink.deliver({
            id: claimed.id,
            tenantId: principal.tenantId,
            legalEntityId: claimed.legal_entity_id,
            outputFormat: format,
            payload,
          })
        : { fileId: null };

      const rowCount =
        payload.profit_and_loss.accounts.length + payload.balance_sheet.accounts.length;

      const completed = await writeInTenant(this.pool, principal, async ({ client, context }) => {
        const { rows } = await client.query(
          `UPDATE report_runs
              SET status = 'COMPLETED', completed_at = now(), row_count = $3, duration_ms = $4,
                  output_file_id = $5, error = NULL
            WHERE id = $1 AND tenant_id = $2
          RETURNING id, legal_entity_id, report_type, status::text AS status, output_format,
                    output_file_id, row_count, duration_ms, requested_at, completed_at`,
          [claimed.id, principal.tenantId, rowCount, Date.now() - started, delivered.fileId],
        );
        await recordAudit(client, context, {
          tenantId: principal.tenantId,
          action: 'report_run.completed',
          resourceType: 'report_run',
          resourceId: claimed.id,
          legalEntityId: claimed.legal_entity_id,
          after: {
            row_count: rowCount,
            duration_ms: Date.now() - started,
            output_file_id: delivered.fileId,
            ties_to_trial_balance: payload.criterion.ties_to_trial_balance,
          },
        });
        return rows[0];
      });

      return {
        ...completed,
        // Stated rather than implied: a COMPLETED run with no file behind it has
        // produced the report and stored nothing, and a caller looking for a
        // download must be able to tell that from a stored one.
        stored: delivered.fileId !== null,
        payload,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeInTenant(this.pool, principal, async ({ client, context }) => {
        await client.query(
          `UPDATE report_runs
              SET status = 'FAILED', completed_at = now(), duration_ms = $3, error = $4
            WHERE id = $1 AND tenant_id = $2`,
          [claimed.id, principal.tenantId, Date.now() - started, message.slice(0, 2000)],
        );
        await recordAudit(client, context, {
          tenantId: principal.tenantId,
          action: 'report_run.failed',
          resourceType: 'report_run',
          resourceId: claimed.id,
          legalEntityId: claimed.legal_entity_id,
          after: { error: message.slice(0, 2000) },
        });
      });
      throw error;
    }
  }
}
