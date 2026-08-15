/**
 * `@acct/reporting`, registered with Nest.
 *
 * Same shape and same reason as `banking.providers.ts` and `ledger.providers.ts`:
 * the package has no framework in it, because the close worker, the snapshot path
 * and the report-run executor construct these classes with `new`. So the wiring is
 * explicit factories, and the dependency order is written down here.
 *
 * Two of the dependencies are the point of the file:
 *
 *   - `StatementsService` takes `LedgerReportsService`, the Phase 2 trial balance,
 *     rather than a private copy of its query. It is the OTHER implementation —
 *     the one exit criterion 1 requires the statements to tie to — so it must be
 *     the same class the `/reports/trial-balance` route reads through. Injecting a
 *     second instance of the same class is fine; injecting a second implementation
 *     would make the comparison compare this package with itself.
 *
 *   - `ReportRunsService` takes an optional `ReportRunSink`, and there is none
 *     here. With no sink a run still COMPLETES, still records what it produced and
 *     leaves `output_file_id` null — the honest record of "produced, not stored" —
 *     and `createReportRun` answers `executor_wired: false` so a queued job with
 *     nothing to run it is distinguishable from one that will run. Wiring the sink
 *     to the Phase 3 file store, and a worker to `executeReportRun`, is an
 *     INTEGRATION NOTE rather than something this file can invent: a file store
 *     assumed here would put statement bytes somewhere nothing else can find them.
 */
import type { Provider } from '@nestjs/common';
import type { Pool } from 'pg';
import { LedgerReportsService } from '@acct/ledger';
import {
  AuditWorkspaceService,
  ReportDefinitionsService,
  ReportDrillService,
  ReportRunsService,
  StatementsService,
} from '@acct/reporting';
import { DATABASE_POOL } from '../common/database.module';

export const REPORTING_PROVIDERS: Provider[] = [
  {
    provide: StatementsService,
    useFactory: (pool: Pool, ledgerReports: LedgerReportsService) =>
      new StatementsService(pool, ledgerReports),
    inject: [DATABASE_POOL, LedgerReportsService],
  },
  {
    provide: ReportDrillService,
    useFactory: (pool: Pool) => new ReportDrillService(pool),
    inject: [DATABASE_POOL],
  },
  {
    provide: ReportDefinitionsService,
    useFactory: (pool: Pool) => new ReportDefinitionsService(pool),
    inject: [DATABASE_POOL],
  },
  {
    // The executor composes through StatementsService, so an exported statement
    // is the same code path as the interactive one. An export produced by a
    // second implementation would be a second set of numbers with a filename on
    // it.
    provide: ReportRunsService,
    useFactory: (pool: Pool, statements: StatementsService) =>
      new ReportRunsService(pool, statements),
    inject: [DATABASE_POOL, StatementsService],
  },
  {
    provide: AuditWorkspaceService,
    useFactory: (pool: Pool) => new AuditWorkspaceService(pool),
    inject: [DATABASE_POOL],
  },
];
