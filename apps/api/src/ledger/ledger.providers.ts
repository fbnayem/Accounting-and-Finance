/**
 * The ledger kernel, registered with Nest.
 *
 * `@acct/ledger` deliberately has no framework in it — the worker constructs the
 * same classes with `new`. So the wiring is explicit factories rather than
 * decorators, which also means the dependency order is written down in one place
 * instead of inferred from constructor metadata that esbuild does not emit anyway
 * (the `emitDecoratorMetadata` problem Phase 1 spent an afternoon on).
 */
import type { Provider } from '@nestjs/common';
import type { Pool } from 'pg';
import {
  ChartService,
  JournalService,
  LedgerProjectionService,
  LedgerReportsService,
  LedgerRulesService,
  PostingService,
} from '@acct/ledger';
import { DATABASE_POOL } from '../common/database.module';

export const LEDGER_PROVIDERS: Provider[] = [
  {
    provide: LedgerProjectionService,
    useFactory: () => new LedgerProjectionService(),
  },
  {
    provide: PostingService,
    useFactory: (projections: LedgerProjectionService) => new PostingService(projections),
    inject: [LedgerProjectionService],
  },
  {
    provide: ChartService,
    useFactory: (pool: Pool) => new ChartService(pool),
    inject: [DATABASE_POOL],
  },
  {
    provide: JournalService,
    useFactory: (pool: Pool, posting: PostingService) => new JournalService(pool, posting),
    inject: [DATABASE_POOL, PostingService],
  },
  {
    provide: LedgerRulesService,
    useFactory: (pool: Pool, posting: PostingService, journals: JournalService) =>
      new LedgerRulesService(pool, posting, journals),
    inject: [DATABASE_POOL, PostingService, JournalService],
  },
  {
    provide: LedgerReportsService,
    useFactory: (pool: Pool, projections: LedgerProjectionService) =>
      new LedgerReportsService(pool, projections),
    inject: [DATABASE_POOL, LedgerProjectionService],
  },
];
