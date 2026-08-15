/**
 * `@acct/approvals`, registered with Nest.
 *
 * Same shape and same reason as `banking.providers.ts`: the package is
 * framework-free, so the wiring is explicit factories over `DATABASE_POOL`.
 *
 * Two services, because two are all the contract's Workflow operations reach.
 * `ApprovalEngine` is deliberately NOT registered here: it has no route
 * (`requestApproval` is called by the domain command that submits a document,
 * through `requestApprovalInTransaction`, inside that command's own transaction —
 * doc 14's "calling a post/pay endpoint directly cannot bypass active approval
 * workflow" is a property of the submitting command, not of a button), and
 * `sweepExpirations` belongs to the worker, which constructs it with `new`.
 * Registering it would advertise an injectable nothing injects.
 */
import type { Provider } from '@nestjs/common';
import type { Pool } from 'pg';
import { ApprovalTaskService, ApprovalWorkflowService } from '@acct/approvals';
import { DATABASE_POOL } from '../common/database.module';

export const APPROVALS_PROVIDERS: Provider[] = [
  {
    provide: ApprovalWorkflowService,
    useFactory: (pool: Pool) => new ApprovalWorkflowService(pool),
    inject: [DATABASE_POOL],
  },
  {
    provide: ApprovalTaskService,
    useFactory: (pool: Pool) => new ApprovalTaskService(pool),
    inject: [DATABASE_POOL],
  },
];
