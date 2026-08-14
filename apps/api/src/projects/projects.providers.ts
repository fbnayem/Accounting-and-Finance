/**
 * `@acct/projects`, registered with Nest.
 *
 * Same shape and same reason as `banking.providers.ts`: the package has no
 * framework in it, because reports and eventually the worker consume management
 * accounting without HTTP. So the wiring is explicit factories and the
 * dependency order is written down here.
 */
import type { Provider } from '@nestjs/common';
import type { Pool } from 'pg';
import { ArService } from '@acct/subledger';
import {
  BudgetControlService,
  BudgetsService,
  CommitmentsService,
  ForecastsService,
  ProjectsService,
} from '@acct/projects';
import { DATABASE_POOL } from '../common/database.module';

export const PROJECTS_PROVIDERS: Provider[] = [
  {
    // Billing proposals hand off to ArService so the invoice draft they produce
    // has AR's numbering, tax and credit limit — the project module never posts
    // revenue directly (doc 10).
    provide: ProjectsService,
    useFactory: (pool: Pool, ar: ArService) => new ProjectsService(pool, ar),
    inject: [DATABASE_POOL, ArService],
  },
  {
    provide: BudgetsService,
    useFactory: (pool: Pool) => new BudgetsService(pool),
    inject: [DATABASE_POOL],
  },
  {
    provide: BudgetControlService,
    useFactory: (pool: Pool) => new BudgetControlService(pool),
    inject: [DATABASE_POOL],
  },
  {
    // No route of its own: commitments are consequences of what happens to a
    // purchase order, so this is registered for the procurement mutation paths
    // to inject and call in their own transactions.
    provide: CommitmentsService,
    useFactory: (pool: Pool) => new CommitmentsService(pool),
    inject: [DATABASE_POOL],
  },
  {
    provide: ForecastsService,
    useFactory: (pool: Pool) => new ForecastsService(pool),
    inject: [DATABASE_POOL],
  },
];
