/**
 * `@acct/banking`, registered with Nest.
 *
 * Same shape and same reason as `ledger.providers.ts` and
 * `subledger.providers.ts`: the package has no framework in it, because the
 * worker constructs these classes with `new` to sync feeds on a schedule and
 * alert on expiring connections. So the wiring is explicit factories and the
 * dependency order is written down here.
 */
import type { Provider } from '@nestjs/common';
import type { Pool } from 'pg';
import { PostingService } from '@acct/ledger';
import { DocumentPostingService } from '@acct/subledger';
import {
  BankAccountsService,
  BankImportService,
  BankMatchingService,
  BankReconciliationService,
  TreasuryService,
} from '@acct/banking';
import { DATABASE_POOL } from '../common/database.module';

export const BANKING_PROVIDERS: Provider[] = [
  {
    provide: BankAccountsService,
    useFactory: (pool: Pool) => new BankAccountsService(pool),
    inject: [DATABASE_POOL],
  },
  {
    provide: BankImportService,
    useFactory: (pool: Pool) => new BankImportService(pool),
    inject: [DATABASE_POOL],
  },
  {
    provide: BankMatchingService,
    useFactory: (pool: Pool) => new BankMatchingService(pool),
    inject: [DATABASE_POOL],
  },
  {
    provide: BankReconciliationService,
    useFactory: (pool: Pool) => new BankReconciliationService(pool),
    inject: [DATABASE_POOL],
  },
  {
    // Transfers and settlement post, so this one needs the kernel and the
    // subledger's posting choke point — the same path an invoice takes.
    provide: TreasuryService,
    useFactory: (pool: Pool, posting: PostingService, documents: DocumentPostingService) =>
      new TreasuryService(pool, posting, documents),
    inject: [DATABASE_POOL, PostingService, DocumentPostingService],
  },
];
