/**
 * The Phase 2 scheduler.
 *
 * Runs the two pieces of dated ledger work doc 03 asks for — scheduled reversals
 * and recurring journals — by calling `@acct/ledger` rather than by writing to the
 * ledger itself. That distinction is the whole reason the kernel is a package: the
 * worker gets the period lock, the number allocation, the control-account check and
 * the balance assertion for free, and there is still exactly one code path that can
 * produce a posted journal.
 *
 * `today` comes from the process clock, in UTC. Dates in this system are calendar
 * dates rather than instants (doc 01), and a worker in one timezone deciding that
 * a 31 March accrual is not yet due would silently move it into April.
 */
import type { Pool } from 'pg';
import {
  JournalService,
  LedgerProjectionService,
  PostingService,
  runDueRecurringJournals,
  runDueReversals,
  type SchedulerLogger,
} from '@acct/ledger';

export interface LedgerSchedulerOptions {
  readonly intervalMs: number;
  readonly batchSize: number;
  /**
   * The `users.id` recorded as the actor. A real row rather than a synthetic id:
   * `journal_entries.posted_by` is a foreign key, and the audit trail is worth less
   * if half of it points at a user that does not exist.
   */
  readonly actorId: string;
  readonly now?: () => Date;
}

export class LedgerScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly journals: JournalService;

  constructor(
    private readonly pool: Pool,
    private readonly logger: SchedulerLogger,
    private readonly options: LedgerSchedulerOptions,
  ) {
    const projections = new LedgerProjectionService();
    this.journals = new JournalService(pool, new PostingService(projections));
  }

  start(): void {
    if (this.timer) return;
    // `unref` so the interval never keeps the process alive on its own; shutdown is
    // driven by SIGTERM, not by an outstanding timer.
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.timer.unref();
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Let an in-flight tick finish rather than tearing the pool out from under a
    // posting transaction; a half-written journal is not a thing this system has.
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 25));
  }

  async tick(): Promise<void> {
    if (this.running) return; // a slow tick must not overlap the next one
    this.running = true;
    const today = (this.options.now?.() ?? new Date()).toISOString().slice(0, 10);

    try {
      const reversals = await runDueReversals(this.pool, this.journals, this.logger, {
        today,
        limit: this.options.batchSize,
        actorId: this.options.actorId,
      });
      const recurring = await runDueRecurringJournals(this.pool, this.journals, this.logger, {
        today,
        limit: this.options.batchSize,
        actorId: this.options.actorId,
      });

      if (reversals.considered + recurring.considered > 0) {
        this.logger.info(
          {
            today,
            reversals_posted: reversals.succeeded,
            reversals_failed: reversals.failed,
            recurring_generated: recurring.succeeded,
            recurring_failed: recurring.failed,
          },
          'ledger scheduler tick complete',
        );
      }
    } catch (err) {
      // A failure here is infrastructure — the claim query, the pool. Per-item
      // failures are handled inside the two run functions and never reach this.
      this.logger.error({ err, today }, 'ledger scheduler tick failed');
    } finally {
      this.running = false;
    }
  }
}
