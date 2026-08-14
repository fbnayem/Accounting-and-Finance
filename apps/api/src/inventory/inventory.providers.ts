/**
 * `@acct/inventory`, registered with Nest.
 *
 * Same shape and same reason as `banking.providers.ts`: the package has no
 * framework in it, so a worker that settles provisional costs or reruns a
 * valuation on a schedule can construct these classes with `new`. The wiring is
 * explicit factories and the dependency order is written down here.
 */
import type { Provider } from '@nestjs/common';
import type { Pool } from 'pg';
import { PostingService } from '@acct/ledger';
import { DocumentPostingService } from '@acct/subledger';
import {
  InventoryDocumentsService,
  InventoryPostingService,
  InventoryReportsService,
  ItemsService,
  LandedCostService,
  StockCountsService,
  WarehousesService,
} from '@acct/inventory';
import { DATABASE_POOL } from '../common/database.module';

export const INVENTORY_PROVIDERS: Provider[] = [
  {
    provide: ItemsService,
    useFactory: (pool: Pool) => new ItemsService(pool),
    inject: [DATABASE_POOL],
  },
  {
    provide: WarehousesService,
    useFactory: (pool: Pool) => new WarehousesService(pool),
    inject: [DATABASE_POOL],
  },
  {
    // Creation writes DRAFT documents only, but it still needs the ledger
    // kernel for loadBookContext — the book, period and entity checks happen at
    // creation so a clerk hears about a closed period before the goods move.
    provide: InventoryDocumentsService,
    useFactory: (pool: Pool, posting: PostingService) =>
      new InventoryDocumentsService(pool, posting),
    inject: [DATABASE_POOL, PostingService],
  },
  {
    // Posting and reversal produce journals, so this one needs the kernel and
    // the subledger's posting choke point — the same path an invoice takes.
    provide: InventoryPostingService,
    useFactory: (pool: Pool, posting: PostingService, documents: DocumentPostingService) =>
      new InventoryPostingService(pool, posting, documents),
    inject: [DATABASE_POOL, PostingService, DocumentPostingService],
  },
  {
    provide: StockCountsService,
    useFactory: (pool: Pool) => new StockCountsService(pool),
    inject: [DATABASE_POOL],
  },
  {
    // Landed cost posts at creation (allocation and capitalisation are one
    // act), so it takes the same posting pair as InventoryPostingService.
    provide: LandedCostService,
    useFactory: (pool: Pool, posting: PostingService, documents: DocumentPostingService) =>
      new LandedCostService(pool, posting, documents),
    inject: [DATABASE_POOL, PostingService, DocumentPostingService],
  },
  {
    provide: InventoryReportsService,
    useFactory: (pool: Pool) => new InventoryReportsService(pool),
    inject: [DATABASE_POOL],
  },
];
