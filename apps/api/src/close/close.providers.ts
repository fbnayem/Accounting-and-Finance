/**
 * `@acct/close`, registered with Nest.
 *
 * Same shape and same reason as `banking.providers.ts`: the package has no
 * framework in it, because the things that read these rules are not all HTTP
 * handlers — `assertPeriodReadyForHardClose` is called from finance-setup's period
 * transition and `periodCloseReadiness` is what a scheduled close-status job wants.
 * So the wiring is explicit factories and the dependency order is written here.
 *
 * `CloseRunService` takes an `ApprovalReader` — the port through which the reopen
 * asks whether a third person approved it. `ApprovalRequestReader` is passed
 * explicitly rather than left to the constructor default so that the seam is
 * visible at the wiring: when `@acct/approvals` exposes a reader that also RAISES
 * the request, this is the one line that changes. See INTEGRATION NOTES.
 */
import type { Provider } from '@nestjs/common';
import type { Pool } from 'pg';
import { PostingService } from '@acct/ledger';
import { DocumentPostingService } from '@acct/subledger';
import {
  AccountReconciliationService,
  ApprovalRequestReader,
  CloseChecklistService,
  CloseRunService,
  FinancialSnapshotService,
  PeriodEndEntryService,
  ReconcilingItemService,
} from '@acct/close';
import { DATABASE_POOL } from '../common/database.module';

export const CLOSE_PROVIDERS: Provider[] = [
  {
    provide: CloseRunService,
    useFactory: (pool: Pool) => new CloseRunService(pool, new ApprovalRequestReader()),
    inject: [DATABASE_POOL],
  },
  {
    provide: CloseChecklistService,
    useFactory: (pool: Pool) => new CloseChecklistService(pool),
    inject: [DATABASE_POOL],
  },
  {
    provide: AccountReconciliationService,
    useFactory: (pool: Pool) => new AccountReconciliationService(pool),
    inject: [DATABASE_POOL],
  },
  {
    provide: ReconcilingItemService,
    useFactory: (pool: Pool) => new ReconcilingItemService(pool),
    inject: [DATABASE_POOL],
  },
  {
    // Period-end entries post, so this one needs the kernel and the subledger's
    // posting choke point — the same path an invoice takes (F-1004). It is the
    // only service in this module that composes accounting lines, and even it
    // never writes journal rows itself.
    provide: PeriodEndEntryService,
    useFactory: (pool: Pool, posting: PostingService, documents: DocumentPostingService) =>
      new PeriodEndEntryService(pool, posting, documents),
    inject: [DATABASE_POOL, PostingService, DocumentPostingService],
  },
  {
    provide: FinancialSnapshotService,
    useFactory: (pool: Pool) => new FinancialSnapshotService(pool),
    inject: [DATABASE_POOL],
  },
];
