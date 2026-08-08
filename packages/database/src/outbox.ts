import { PoolClient, Pool } from 'pg';
import { RequestContext, uuidv7, AppError } from '@acct/domain';
import { isKnownEvent, eventScope } from '@acct/contracts';

/**
 * Transactional outbox — doc 21 Phase 0, doc 01 rule:
 * "Outbox publication occurs only after the originating database transaction commits."
 *
 * `publish` takes a `PoolClient`, not a `Pool`. That signature is the guarantee:
 * an event can only be written on the same connection, inside the same
 * transaction, as the aggregate change that caused it. There is no overload that
 * publishes outside a transaction, so "wrote the row but lost the event" is not a
 * state this codebase can reach.
 *
 * Phase 0 exit criterion 3 — "API can write a sample transaction and outbox event
 * atomically" — is this function plus `withTransaction`.
 */

export interface OutboxEventInput {
  readonly eventType: string;
  readonly eventVersion?: number;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
  readonly tenantId: string;
  readonly organizationId?: string | null;
  readonly legalEntityId?: string | null;
  readonly accountingBookId?: string | null;
  readonly branchId?: string | null;
  readonly sourceSystem?: string | null;
  readonly metadata?: Record<string, unknown>;
}

export interface OutboxEventRow {
  id: string;
  event_id: string;
  event_type: string;
  event_version: number;
  tenant_id: string;
  organization_id: string | null;
  legal_entity_id: string | null;
  accounting_book_id: string | null;
  branch_id: string | null;
  aggregate_type: string;
  aggregate_id: string;
  actor_id: string | null;
  actor_kind: string | null;
  payload: Record<string, unknown>;
  correlation_id: string | null;
  causation_id: string | null;
  idempotency_key: string | null;
  source_system: string | null;
  occurred_at: string;
  published_at: string | null;
  attempts: number;
  last_error: string | null;
}

export class UnknownEventTypeError extends AppError {
  constructor(eventType: string) {
    super(
      'INTERNAL',
      `Event type "${eventType}" is not in contracts/events.yaml. Event types are a ` +
        `published contract: add it there first, with a status and a phase.`,
      { safeToExpose: false, details: { eventType } },
    );
    this.name = 'UnknownEventTypeError';
  }
}

/**
 * Writes one event to the outbox within the caller's transaction.
 *
 * The event type is checked against the canonical contract at the moment of
 * writing. F-101 found 22 events published under two different names because
 * nothing ever compared prose to catalog; this is the check that makes that
 * class of drift impossible to commit. It is also DoD item "new event ⇒ in
 * events.yaml", enforced at runtime rather than at review.
 */
export async function publish(
  client: PoolClient,
  ctx: RequestContext,
  event: OutboxEventInput,
): Promise<string> {
  if (!isKnownEvent(event.eventType)) throw new UnknownEventTypeError(event.eventType);

  // envelope: legal_entity_id is required except for platform-scope events.
  const scope = eventScope(event.eventType);
  if (scope !== 'platform' && !event.legalEntityId) {
    throw new AppError(
      'INTERNAL',
      `Event ${event.eventType} is entity-scoped; legal_entity_id is required on the envelope ` +
        `(contracts/events.yaml, F-041).`,
      { safeToExpose: false },
    );
  }

  const eventId = uuidv7();
  await client.query(
    `INSERT INTO outbox_events (
       event_id, event_type, event_version,
       tenant_id, organization_id, legal_entity_id, accounting_book_id, branch_id,
       aggregate_type, aggregate_id,
       actor_id, actor_kind, payload,
       correlation_id, causation_id, idempotency_key, source_system
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      eventId,
      event.eventType,
      event.eventVersion ?? 1,
      event.tenantId,
      event.organizationId ?? ctx.organizationId ?? null,
      event.legalEntityId ?? ctx.legalEntityId ?? null,
      event.accountingBookId ?? ctx.accountingBookId ?? null,
      event.branchId ?? ctx.branchId ?? null,
      event.aggregateType,
      event.aggregateId,
      ctx.actorId ?? null,
      ctx.actorKind ?? 'SYSTEM',
      JSON.stringify({
        ...event.payload,
        ...(event.metadata ? { _metadata: event.metadata } : {}),
      }),
      ctx.correlationId,
      ctx.causationId ?? null,
      ctx.idempotencyKey ?? null,
      event.sourceSystem ?? null,
    ],
  );
  return eventId;
}

// ---------------------------------------------------------------------------
// Draining — the worker side
// ---------------------------------------------------------------------------

/**
 * Claims a batch of unpublished events.
 *
 * `FOR UPDATE SKIP LOCKED` is what lets several worker replicas drain the same
 * table without coordinating: each takes rows the others are not holding, and none
 * of them block. Ordering by `occurred_at` keeps per-aggregate causal order in the
 * common case; consumers are required to be idempotent regardless, because the
 * envelope's `event_id` is the deduplication key (doc 01).
 */
export async function claimBatch(client: PoolClient, batchSize: number): Promise<OutboxEventRow[]> {
  const { rows } = await client.query<OutboxEventRow>(
    `SELECT * FROM outbox_events
      WHERE published_at IS NULL
      ORDER BY occurred_at, id
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [batchSize],
  );
  return rows;
}

export async function markPublished(client: PoolClient, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await client.query(
    `UPDATE outbox_events SET published_at = now(), last_error = NULL WHERE id = ANY($1::uuid[])`,
    [ids],
  );
}

export async function markFailed(client: PoolClient, id: string, error: string): Promise<void> {
  await client.query(
    `UPDATE outbox_events
        SET attempts = attempts + 1,
            last_error = left($2, 2000)
      WHERE id = $1`,
    [id, error],
  );
}

/** Consumer-side idempotency — doc 01: "consumers record checkpoints/event IDs". */
export async function markProcessed(
  client: PoolClient,
  consumer: string,
  eventId: string,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2)
       ON CONFLICT (consumer, event_id) DO NOTHING`,
    [consumer, eventId],
  );
  return (rowCount ?? 0) > 0; // false means this consumer already handled it
}

export async function updateCheckpoint(
  client: PoolClient,
  consumer: string,
  eventId: string,
  occurredAt: string,
): Promise<void> {
  await client.query(
    `INSERT INTO outbox_consumer_checkpoints (consumer, last_event_id, last_occurred_at, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (consumer) DO UPDATE
       SET last_event_id = EXCLUDED.last_event_id,
           last_occurred_at = EXCLUDED.last_occurred_at,
           updated_at = now()`,
    [consumer, eventId, occurredAt],
  );
}

/**
 * ADR-0009 alert threshold: "Outbox unpublished age p99 > 60 s". Exposed for the
 * health endpoint and the metrics exporter so the threshold has a signal to watch.
 */
export async function unpublishedLag(
  pool: Pool,
): Promise<{ count: number; oldestSeconds: number }> {
  const { rows } = await pool.query<{ count: string; oldest_seconds: string | null }>(
    `SELECT count(*)::text AS count,
            EXTRACT(EPOCH FROM (now() - min(occurred_at)))::text AS oldest_seconds
       FROM outbox_events WHERE published_at IS NULL`,
  );
  const row = rows[0];
  return {
    count: Number(row?.count ?? 0),
    oldestSeconds: Math.round(Number(row?.oldest_seconds ?? 0)),
  };
}
