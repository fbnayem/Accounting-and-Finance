import { Pool } from 'pg';
import { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { runWithContext, type RequestContext } from '@acct/domain';
import {
  claimBatch,
  markPublished,
  markFailed,
  updateCheckpoint,
  type OutboxEventRow,
} from '@acct/database';

/**
 * Drains the transactional outbox onto the queue.
 *
 * The whole reason the outbox exists is that "write to the database and publish to
 * a broker" cannot be made atomic. So the aggregate change and its event commit
 * together in PostgreSQL, and this process moves them onward afterwards — doc 01:
 * "Outbox publication occurs only after the originating database transaction
 * commits."
 *
 * Phase 0 exit criterion 5 is closed here: the envelope's `correlation_id` is
 * restored into the async context before anything is logged, so the worker's lines
 * carry the same ID as the API request that caused them.
 */

export interface DrainerOptions {
  readonly pollIntervalMs: number;
  readonly batchSize: number;
  readonly consumer: string;
}

export interface DrainResult {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
}

export class OutboxDrainer {
  private running = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly pool: Pool,
    private readonly queue: Queue,
    private readonly logger: Logger,
    private readonly options: DrainerOptions,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.info(
      { interval_ms: this.options.pollIntervalMs, batch: this.options.batchSize },
      'outbox drainer started',
    );
    this.scheduleNext(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    try {
      const result = await this.drainOnce();
      // A full batch means there is more waiting; poll again immediately rather
      // than sleeping through a backlog.
      this.scheduleNext(result.claimed >= this.options.batchSize ? 0 : this.options.pollIntervalMs);
    } catch (err) {
      this.logger.error({ err }, 'outbox drain failed');
      this.scheduleNext(this.options.pollIntervalMs);
    }
  }

  /**
   * One drain pass, in a single transaction.
   *
   * The claim is held with `FOR UPDATE SKIP LOCKED` for the whole pass, so several
   * worker replicas drain the same table concurrently without coordinating and
   * without blocking each other.
   */
  async drainOnce(): Promise<DrainResult> {
    const client = await this.pool.connect();
    const published: string[] = [];
    let failed = 0;
    let claimed = 0;
    let last: OutboxEventRow | undefined;

    try {
      await client.query('BEGIN');
      const batch = await claimBatch(client, this.options.batchSize);
      claimed = batch.length;

      for (const event of batch) {
        const context: RequestContext = {
          // Exit criterion 5: the trace continues here, it does not restart.
          correlationId: event.correlation_id ?? 'outbox',
          // This event is the cause of whatever the consumer does next.
          causationId: event.event_id,
          tenantId: event.tenant_id,
          ...(event.organization_id ? { organizationId: event.organization_id } : {}),
          ...(event.legal_entity_id ? { legalEntityId: event.legal_entity_id } : {}),
          ...(event.actor_id ? { actorId: event.actor_id } : {}),
          actorKind: 'SERVICE',
        };

        try {
          await runWithContext(context, async () => {
            await this.queue.add(
              event.event_type,
              {
                event_id: event.event_id,
                event_type: event.event_type,
                event_version: event.event_version,
                tenant_id: event.tenant_id,
                organization_id: event.organization_id,
                legal_entity_id: event.legal_entity_id,
                accounting_book_id: event.accounting_book_id,
                branch_id: event.branch_id,
                aggregate_type: event.aggregate_type,
                aggregate_id: event.aggregate_id,
                occurred_at: event.occurred_at,
                correlation_id: event.correlation_id,
                causation_id: event.causation_id,
                actor_id: event.actor_id,
                actor_type: event.actor_kind,
                data: event.payload,
              },
              {
                // The envelope's event_id is the deduplication key (doc 01), so
                // reusing it as the job id makes a redelivery a no-op on the queue
                // as well as at the consumer.
                jobId: event.event_id,
                removeOnComplete: { age: 3600, count: 5000 },
                removeOnFail: { age: 86_400 },
                attempts: 5,
                backoff: { type: 'exponential', delay: 1000 },
              },
            );
            this.logger.debug(
              { event_type: event.event_type, event_id: event.event_id },
              'event published',
            );
          });
          published.push(event.id);
          last = event;
        } catch (err) {
          failed++;
          await markFailed(client, event.id, err instanceof Error ? err.message : String(err));
          this.logger.warn(
            { err, event_id: event.event_id, event_type: event.event_type },
            'event publication failed; will retry',
          );
        }
      }

      await markPublished(client, published);
      if (last) {
        await updateCheckpoint(client, this.options.consumer, last.event_id, last.occurred_at);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    if (claimed > 0) {
      this.logger.info({ claimed, published: published.length, failed }, 'outbox drained');
    }
    return { claimed, published: published.length, failed };
  }
}
