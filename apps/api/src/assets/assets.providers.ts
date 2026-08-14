/**
 * `@acct/assets`, registered with Nest.
 *
 * Same shape and same reason as `banking.providers.ts`: the package has no
 * framework in it, because the depreciation run is a period-close job a
 * scheduler must be able to construct with `new` without an HTTP hop. So the
 * wiring is explicit factories and the dependency order is written down here.
 */
import type { Provider } from '@nestjs/common';
import type { Pool } from 'pg';
import { PostingService } from '@acct/ledger';
import { DocumentPostingService } from '@acct/subledger';
import {
  AssetCapitalizationService,
  AssetCategoriesService,
  AssetDisposalService,
  AssetRegisterService,
  AssetReportsService,
  AssetValuationService,
  DepreciationRunService,
} from '@acct/assets';
import { DATABASE_POOL } from '../common/database.module';

export const ASSETS_PROVIDERS: Provider[] = [
  {
    provide: AssetCategoriesService,
    useFactory: (pool: Pool) => new AssetCategoriesService(pool),
    inject: [DATABASE_POOL],
  },
  {
    provide: AssetRegisterService,
    useFactory: (pool: Pool) => new AssetRegisterService(pool),
    inject: [DATABASE_POOL],
  },
  {
    // Capitalization, the run, valuation and disposal all post, so each needs
    // the kernel and the subledger's posting choke point — the same path an
    // invoice takes.
    provide: AssetCapitalizationService,
    useFactory: (pool: Pool, posting: PostingService, documents: DocumentPostingService) =>
      new AssetCapitalizationService(pool, posting, documents),
    inject: [DATABASE_POOL, PostingService, DocumentPostingService],
  },
  {
    provide: DepreciationRunService,
    useFactory: (pool: Pool, posting: PostingService, documents: DocumentPostingService) =>
      new DepreciationRunService(pool, posting, documents),
    inject: [DATABASE_POOL, PostingService, DocumentPostingService],
  },
  {
    provide: AssetValuationService,
    useFactory: (pool: Pool, posting: PostingService, documents: DocumentPostingService) =>
      new AssetValuationService(pool, posting, documents),
    inject: [DATABASE_POOL, PostingService, DocumentPostingService],
  },
  {
    provide: AssetDisposalService,
    useFactory: (pool: Pool, posting: PostingService, documents: DocumentPostingService) =>
      new AssetDisposalService(pool, posting, documents),
    inject: [DATABASE_POOL, PostingService, DocumentPostingService],
  },
  {
    provide: AssetReportsService,
    useFactory: (pool: Pool) => new AssetReportsService(pool),
    inject: [DATABASE_POOL],
  },
];
