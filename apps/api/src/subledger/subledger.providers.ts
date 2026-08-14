/**
 * `@acct/subledger`, registered with Nest.
 *
 * Same shape and same reason as `ledger.providers.ts`: the package has no
 * framework in it, because the worker constructs these classes with `new` to
 * generate recurring invoices and advance dunning stages. So the wiring is
 * explicit factories, and the dependency order is written down here rather than
 * inferred from constructor metadata esbuild does not emit.
 *
 * The storage signer is the one provider with an environment behind it. It is
 * injected into `FilesService` rather than imported by it, so the service can be
 * exercised without an object store — and so the production adapter stays a thin
 * translation that a reader can check by eye.
 */
import type { Provider } from '@nestjs/common';
import type { Pool } from 'pg';
import { PostingService } from '@acct/ledger';
import {
  ApService,
  ArService,
  DocumentPostingService,
  FilesService,
  LocalizationService,
  ProcurementService,
  SalesService,
  SubledgerReportsService,
  TaxReturnService,
  TaxService,
  type StorageSigner,
} from '@acct/subledger';
import { CommitmentsService } from '@acct/projects';
import type { loadApiEnv } from '@acct/config';
import { API_ENV, DATABASE_POOL } from '../common/database.module';
import { S3Storage } from './s3-storage';

export const STORAGE_SIGNER = Symbol('STORAGE_SIGNER');

export const SUBLEDGER_PROVIDERS: Provider[] = [
  {
    provide: TaxService,
    useFactory: (pool: Pool) => new TaxService(pool),
    inject: [DATABASE_POOL],
  },
  {
    provide: DocumentPostingService,
    useFactory: (posting: PostingService, tax: TaxService) =>
      new DocumentPostingService(posting, tax),
    inject: [PostingService, TaxService],
  },
  {
    provide: ArService,
    useFactory: (
      pool: Pool,
      posting: PostingService,
      documents: DocumentPostingService,
      tax: TaxService,
    ) => new ArService(pool, posting, documents, tax),
    inject: [DATABASE_POOL, PostingService, DocumentPostingService, TaxService],
  },
  {
    // ApService takes ArService because `contacts` is one table with a kind, and
    // the vendor read/update methods delegate rather than carrying a second copy
    // of the same SQL.
    //
    // CommitmentsService arrives as `CommitmentReliefPort`: posting a bill against
    // a PO line has to relieve that line's commitment in the posting transaction,
    // or doc 10's formula counts the same spend as an open commitment and as an
    // actual (F-106). The dependency points apps/api -> @acct/projects, never
    // @acct/subledger -> @acct/projects, which is already taken.
    provide: ApService,
    useFactory: (
      pool: Pool,
      posting: PostingService,
      documents: DocumentPostingService,
      tax: TaxService,
      ar: ArService,
      commitments: CommitmentsService,
    ) => new ApService(pool, posting, documents, tax, ar, commitments),
    inject: [
      DATABASE_POOL,
      PostingService,
      DocumentPostingService,
      TaxService,
      ArService,
      CommitmentsService,
    ],
  },
  {
    provide: SalesService,
    useFactory: (
      pool: Pool,
      posting: PostingService,
      documents: DocumentPostingService,
      ar: ArService,
      // The e-invoice provider is left at its default. `NoEInvoiceProviderConnected`
      // records the submission as PENDING with the reason, rather than reporting a
      // success from a provider that was never called — no network integration
      // ships in this phase and the row says so.
    ) => new SalesService(pool, posting, documents, ar),
    inject: [DATABASE_POOL, PostingService, DocumentPostingService, ArService],
  },
  {
    // The same CommitmentsService, arriving as `CommitmentPort`. This is the
    // seam that makes doc 10's budget control enforceable: approving a purchase
    // order checks every line against the available budget and writes the
    // commitment inside one transaction, and closing or cancelling the order
    // releases what is left. Both were implemented and unreachable before this
    // argument existed.
    provide: ProcurementService,
    useFactory: (
      pool: Pool,
      posting: PostingService,
      documents: DocumentPostingService,
      tax: TaxService,
      ap: ApService,
      commitments: CommitmentsService,
    ) => new ProcurementService(pool, posting, documents, tax, ap, commitments),
    inject: [
      DATABASE_POOL,
      PostingService,
      DocumentPostingService,
      TaxService,
      ApService,
      CommitmentsService,
    ],
  },
  {
    provide: TaxReturnService,
    useFactory: (pool: Pool) => new TaxReturnService(pool),
    inject: [DATABASE_POOL],
  },
  {
    provide: LocalizationService,
    useFactory: (pool: Pool) => new LocalizationService(pool),
    inject: [DATABASE_POOL],
  },
  {
    provide: SubledgerReportsService,
    useFactory: (pool: Pool) => new SubledgerReportsService(pool),
    inject: [DATABASE_POOL],
  },
  {
    provide: STORAGE_SIGNER,
    useFactory: (env: ReturnType<typeof loadApiEnv>): StorageSigner =>
      new S3Storage({
        endpoint: env.S3_ENDPOINT,
        region: env.S3_REGION,
        bucket: env.S3_BUCKET,
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
      }),
    inject: [API_ENV],
  },
  {
    provide: FilesService,
    useFactory: (pool: Pool, storage: StorageSigner) => new FilesService(pool, storage),
    inject: [DATABASE_POOL, STORAGE_SIGNER],
  },
];
