import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import pino from 'pino';
import { loadWorkerEnv, loadOrExit } from '@acct/config';
import { createPool, markProcessed, reapExpiredKeys } from '@acct/database';
import { runWithContext, currentContext, type RequestContext } from '@acct/domain';
import { SYSTEM_ACTOR_ID } from '@acct/ledger';
import { OutboxDrainer } from './outbox-drainer';
import { LedgerScheduler } from './ledger-scheduler';

/**
 * The worker process.
 *
 * Three responsibilities:
 *   - drain the transactional outbox onto the queue          (Phase 0)
 *   - consume domain events idempotently, recording what it has seen   (Phase 0)
 *   - post due scheduled reversals and generate recurring journals     (Phase 2)
 *
 * Phase 0 exit criterion 5 is demonstrated end to end here: a correlation ID
 * created by the API travels through the outbox envelope, onto the queue payload,
 * and into this process's log lines.
 *
 * The third one calls @acct/ledger. It is worth saying why that package exists at
 * all: doc 21 requires that "later modules must call the accounting kernel through
 * commands/services; they must not create ledger rows directly", and a worker that
 * could only reach the kernel over HTTP would end up with its own INSERT instead.
 */

export const DOMAIN_EVENTS_QUEUE = 'domain-events';
export const MAINTENANCE_QUEUE = 'maintenance';
const CONSUMER_NAME = 'worker.domain-events';

const env = loadOrExit(() => loadWorkerEnv());

const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'worker', env: env.NODE_ENV, build: env.BUILD_SHA },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
    log: (object) => {
      const ctx = currentContext();
      return ctx
        ? {
            ...object,
            correlation_id: ctx.correlationId,
            ...(ctx.tenantId ? { tenant_id: ctx.tenantId } : {}),
            ...(ctx.causationId ? { causation_id: ctx.causationId } : {}),
          }
        : object;
    },
  },
});

const pool = createPool({
  // APP_DATABASE_URL, never DATABASE_URL: the request path connects as
  // `app_runtime`, which is not a superuser and therefore the only role the
  // migration 0024 row-level security policies actually apply to.
  connectionString: env.APP_DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
  lockTimeoutMs: env.DATABASE_LOCK_TIMEOUT_MS,
  ssl: env.DATABASE_SSL,
  applicationName: 'acct-worker',
});

// BullMQ requires this setting and refuses to start without it; being explicit
// beats discovering it from a stack trace.
const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

const eventsQueue = new Queue(DOMAIN_EVENTS_QUEUE, { connection });
const drainer = new OutboxDrainer(pool, eventsQueue, logger, {
  pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
  batchSize: env.OUTBOX_BATCH_SIZE,
  consumer: 'outbox.drainer',
});

interface EventJobData {
  event_id: string;
  event_type: string;
  tenant_id: string;
  organization_id: string | null;
  legal_entity_id: string | null;
  correlation_id: string | null;
  causation_id: string | null;
  aggregate_type: string;
  aggregate_id: string;
  data: Record<string, unknown>;
}

const eventsWorker = new Worker<EventJobData>(
  DOMAIN_EVENTS_QUEUE,
  async (job: Job<EventJobData>) => {
    const context: RequestContext = {
      correlationId: job.data.correlation_id ?? 'worker',
      causationId: job.data.event_id,
      tenantId: job.data.tenant_id,
      ...(job.data.organization_id ? { organizationId: job.data.organization_id } : {}),
      ...(job.data.legal_entity_id ? { legalEntityId: job.data.legal_entity_id } : {}),
      actorKind: 'SERVICE',
    };

    return runWithContext(context, async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // doc 01: "Consumers must be idempotent and record processed event_ids."
        // A redelivery — from a retry, a replay, or a drainer restart — must be a
        // no-op, not a second effect.
        const isFirstDelivery = await markProcessed(client, CONSUMER_NAME, job.data.event_id);
        if (!isFirstDelivery) {
          await client.query('COMMIT');
          logger.debug({ event_id: job.data.event_id }, 'event already processed; skipping');
          return { skipped: true };
        }

        // Phase 0 has no domain consumers yet. The log line is the deliverable:
        // it is what exit criterion 5 is checked against.
        logger.info(
          {
            event_type: job.data.event_type,
            event_id: job.data.event_id,
            aggregate_type: job.data.aggregate_type,
            aggregate_id: job.data.aggregate_id,
          },
          'domain event consumed',
        );

        await client.query('COMMIT');
        return { processed: true };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    });
  },
  { connection, concurrency: env.WORKER_CONCURRENCY },
);

eventsWorker.on('failed', (job, err) => {
  logger.error({ err, job_id: job?.id, event_type: job?.name }, 'event job failed');
});

// F-044 retention: idempotency keys expire after 30 days. Hourly is ample; the
// index on expires_at keeps the sweep cheap.
const maintenance = setInterval(
  () => {
    void reapExpiredKeys(pool)
      .then((n) => n > 0 && logger.info({ removed: n }, 'expired idempotency keys reaped'))
      .catch((err) => logger.error({ err }, 'idempotency reap failed'));
  },
  60 * 60 * 1000,
);

const scheduler = new LedgerScheduler(pool, logger, {
  intervalMs: env.LEDGER_SCHEDULER_INTERVAL_MS,
  batchSize: env.LEDGER_SCHEDULER_BATCH_SIZE,
  actorId: SYSTEM_ACTOR_ID,
});

drainer.start();
if (env.LEDGER_SCHEDULER_ENABLED) scheduler.start();
logger.info(
  {
    concurrency: env.WORKER_CONCURRENCY,
    ledger_scheduler: env.LEDGER_SCHEDULER_ENABLED ? env.LEDGER_SCHEDULER_INTERVAL_MS : 'disabled',
  },
  'worker started',
);

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'worker shutting down');
  clearInterval(maintenance);
  await scheduler.stop();
  await drainer.stop();
  await eventsWorker.close();
  await eventsQueue.close();
  await connection.quit();
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
