import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { uuidv7 } from '@acct/domain';
import { withTransaction } from '../transaction';
import { publish, claimBatch, markPublished, markProcessed, unpublishedLag } from '../outbox';
import { testPool, testContext, createTestTenant, countRows, closeTestPool } from './helpers';

/**
 * Phase 0 exit criterion 3:
 * "API can write a sample transaction and outbox event atomically."
 */
describe('transactional outbox', () => {
  const pool = testPool();
  let tenantId: string;

  beforeAll(async () => {
    tenantId = await createTestTenant(pool);
  });
  afterAll(closeTestPool);

  it('commits the aggregate row and its event together', async () => {
    const ctx = testContext({ tenantId });
    const orgId = uuidv7();

    await withTransaction(
      pool,
      async ({ client }) => {
        await client.query(`INSERT INTO organizations (id, tenant_id, name) VALUES ($1,$2,$3)`, [
          orgId,
          tenantId,
          'Atomic Co',
        ]);
        await publish(client, ctx, {
          eventType: 'organization.created',
          aggregateType: 'organization',
          aggregateId: orgId,
          tenantId,
          organizationId: orgId,
          payload: { name: 'Atomic Co' },
        });
      },
      { context: ctx },
    );

    expect(await countRows(pool, 'organizations', 'id = $1', [orgId])).toBe(1);
    expect(await countRows(pool, 'outbox_events', 'aggregate_id = $1', [orgId])).toBe(1);
  });

  it('loses the event when the transaction rolls back — never one without the other', async () => {
    const ctx = testContext({ tenantId });
    const orgId = uuidv7();

    await expect(
      withTransaction(
        pool,
        async ({ client }) => {
          await client.query(`INSERT INTO organizations (id, tenant_id, name) VALUES ($1,$2,$3)`, [
            orgId,
            tenantId,
            'Doomed Co',
          ]);
          await publish(client, ctx, {
            eventType: 'organization.created',
            aggregateType: 'organization',
            aggregateId: orgId,
            tenantId,
            organizationId: orgId,
            payload: {},
          });
          throw new Error('business rule failed after the event was written');
        },
        { context: ctx },
      ),
    ).rejects.toThrow(/business rule failed/);

    expect(await countRows(pool, 'organizations', 'id = $1', [orgId])).toBe(0);
    expect(await countRows(pool, 'outbox_events', 'aggregate_id = $1', [orgId])).toBe(0);
  });

  it('refuses an event type that is not in the canonical contract', async () => {
    const ctx = testContext({ tenantId });
    await expect(
      withTransaction(
        pool,
        ({ client }) =>
          publish(client, ctx, {
            eventType: 'organization.probably_created',
            aggregateType: 'organization',
            aggregateId: uuidv7(),
            tenantId,
            payload: {},
          }),
        { context: ctx },
      ),
    ).rejects.toThrow(/not in contracts\/events\.yaml/);
  });

  it('refuses a superseded event name (F-101)', async () => {
    const ctx = testContext({ tenantId });
    await expect(
      withTransaction(
        pool,
        ({ client }) =>
          publish(client, ctx, {
            // doc 05's prose spelling; the canonical name is vendor_bill.posted.
            eventType: 'bill.posted',
            aggregateType: 'vendor_bill',
            aggregateId: uuidv7(),
            tenantId,
            legalEntityId: uuidv7(),
            payload: {},
          }),
        { context: ctx },
      ),
    ).rejects.toThrow(/not in contracts\/events\.yaml/);
  });

  it('requires legal_entity_id on an entity-scoped event (F-041)', async () => {
    const ctx = testContext({ tenantId });
    await expect(
      withTransaction(
        pool,
        ({ client }) =>
          publish(client, ctx, {
            // Book-scoped, so it is entity-scoped too: legal_entity_id is required.
            eventType: 'journal.posted',
            aggregateType: 'journal_entry',
            aggregateId: uuidv7(),
            tenantId,
            payload: {},
          }),
        { context: ctx },
      ),
    ).rejects.toThrow(/entity-scoped; legal_entity_id is required/);
  });

  it('stamps the envelope with the correlation ID, not the payload', async () => {
    const actorId = uuidv7();
    const ctx = testContext({ tenantId, actorId, actorKind: 'USER' });
    const orgId = uuidv7();

    await withTransaction(
      pool,
      async ({ client }) => {
        await client.query(`INSERT INTO organizations (id, tenant_id, name) VALUES ($1,$2,$3)`, [
          orgId,
          tenantId,
          'Traced Co',
        ]);
        await publish(client, ctx, {
          eventType: 'organization.created',
          aggregateType: 'organization',
          aggregateId: orgId,
          tenantId,
          organizationId: orgId,
          payload: { name: 'Traced Co' },
        });
      },
      { context: ctx },
    );

    const { rows } = await pool.query(
      `SELECT correlation_id, actor_id, actor_kind, organization_id, event_version
         FROM outbox_events WHERE aggregate_id = $1`,
      [orgId],
    );
    expect(rows[0]).toMatchObject({
      correlation_id: ctx.correlationId,
      actor_id: actorId,
      actor_kind: 'USER',
      organization_id: orgId,
      event_version: 1,
    });
  });

  it('lets concurrent drainers claim disjoint batches', async () => {
    const ctx = testContext({ tenantId });
    const ids = [uuidv7(), uuidv7(), uuidv7(), uuidv7()];

    await withTransaction(
      pool,
      async ({ client }) => {
        for (const id of ids) {
          await client.query(`INSERT INTO organizations (id, tenant_id, name) VALUES ($1,$2,$3)`, [
            id,
            tenantId,
            `Batch ${id}`,
          ]);
          await publish(client, ctx, {
            eventType: 'organization.created',
            aggregateType: 'organization',
            aggregateId: id,
            tenantId,
            organizationId: id,
            payload: {},
          });
        }
      },
      { context: ctx },
    );

    // Two drainers, holding their claims at the same time.
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const batchA = await claimBatch(a, 2);
      const batchB = await claimBatch(b, 2);
      const overlap = batchA.filter((x) => batchB.some((y) => y.id === x.id));
      expect(overlap).toHaveLength(0); // SKIP LOCKED: never the same row twice
      expect(batchA.length).toBeGreaterThan(0);
      expect(batchB.length).toBeGreaterThan(0);

      await markPublished(
        a,
        batchA.map((e) => e.id),
      );
      await a.query('COMMIT');
      await b.query('ROLLBACK');
    } finally {
      a.release();
      b.release();
    }
  });

  it('deduplicates a redelivered event per consumer', async () => {
    const eventId = uuidv7();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      expect(await markProcessed(client, 'test-consumer', eventId)).toBe(true);
      expect(await markProcessed(client, 'test-consumer', eventId)).toBe(false);
      // A different consumer has its own dedupe window.
      expect(await markProcessed(client, 'other-consumer', eventId)).toBe(true);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  it('reports unpublished lag for the ADR-0009 alert threshold', async () => {
    const lag = await unpublishedLag(pool);
    expect(lag.count).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(lag.oldestSeconds)).toBe(true);
  });
});
