import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { uuidv7 } from '@acct/domain';
import { withTransaction } from '../transaction';
import { publish } from '../outbox';
import { withIdempotency, hashRequest, reapExpiredKeys } from '../idempotency';
import { testPool, testContext, createTestTenant, countRows, closeTestPool } from './helpers';

/**
 * Phase 0 exit criterion 4:
 * "Retry of idempotent sample command does not duplicate data."
 *
 * The protocol under test is F-044, stated normatively in
 * contracts/schema/0001_platform.sql.
 */
describe('idempotency protocol (F-044)', () => {
  const pool = testPool();
  let tenantId: string;

  beforeAll(async () => {
    tenantId = await createTestTenant(pool);
  });
  afterAll(closeTestPool);

  // Names carry the *whole* key. The first eight hex characters of a uuidv7 are the
  // top bits of a millisecond timestamp and repeat roughly every 65 seconds, so a
  // truncated id is a clock reading rather than a unique value — running this file
  // twice in a minute counted the previous run's rows and failed.
  const sampleCommand = (ctx: ReturnType<typeof testContext>, name: string) => async () => {
    const orgId = uuidv7();
    await withTransaction(
      pool,
      async ({ client }) => {
        await client.query(`INSERT INTO organizations (id, tenant_id, name) VALUES ($1,$2,$3)`, [
          orgId,
          tenantId,
          name,
        ]);
        await publish(client, ctx, {
          eventType: 'organization.created',
          aggregateType: 'organization',
          aggregateId: orgId,
          tenantId,
          organizationId: orgId,
          payload: { name },
        });
      },
      { context: ctx },
    );
    return { statusCode: 201, body: { id: orgId, name }, resourceId: orgId, value: orgId };
  };

  it('executes once and replays the stored response on retry', async () => {
    const key = `key-${uuidv7()}`;
    const name = `Retry Co ${key}`;
    const ctx = testContext({ tenantId, idempotencyKey: key });
    const params = { tenantId, operation: 'createOrganization', key, requestPayload: { name } };

    const first = await withIdempotency(pool, ctx, params, sampleCommand(ctx, name));
    expect(first.kind).toBe('executed');

    const second = await withIdempotency(pool, ctx, params, sampleCommand(ctx, name));
    expect(second.kind).toBe('replayed');
    expect(second.kind === 'replayed' && second.statusCode).toBe(201);

    // The point of the criterion: one row, one event, however many retries.
    expect(await countRows(pool, 'organizations', 'name = $1', [name])).toBe(1);
    expect(await countRows(pool, 'outbox_events', "payload->>'name' = $1", [name])).toBe(1);
  });

  it('survives a burst of concurrent retries with the same key', async () => {
    const key = `key-${uuidv7()}`;
    const name = `Concurrent Co ${key}`;
    const ctx = testContext({ tenantId, idempotencyKey: key });
    const params = { tenantId, operation: 'createOrganization', key, requestPayload: { name } };

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => withIdempotency(pool, ctx, params, sampleCommand(ctx, name))),
    );

    const executed = results.filter((r) => r.status === 'fulfilled' && r.value.kind === 'executed');
    const replayed = results.filter((r) => r.status === 'fulfilled' && r.value.kind === 'replayed');
    const inProgress = results.filter(
      (r) => r.status === 'rejected' && r.reason?.code === 'IN_PROGRESS',
    );

    expect(executed).toHaveLength(1);
    expect(replayed.length + inProgress.length).toBe(7);
    expect(await countRows(pool, 'organizations', 'name = $1', [name])).toBe(1);
  });

  it('rejects the same key with a different payload', async () => {
    const key = `key-${uuidv7()}`;
    const ctx = testContext({ tenantId, idempotencyKey: key });
    const name = `Reuse Co ${key}`;

    await withIdempotency(
      pool,
      ctx,
      { tenantId, operation: 'createOrganization', key, requestPayload: { name } },
      sampleCommand(ctx, name),
    );

    await expect(
      withIdempotency(
        pool,
        ctx,
        {
          tenantId,
          operation: 'createOrganization',
          key,
          requestPayload: { name: 'something else' },
        },
        sampleCommand(ctx, 'something else'),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSE' });

    expect(await countRows(pool, 'organizations', "name = 'something else'", [])).toBe(0);
  });

  it('releases the key when the operation fails, so a corrected retry can proceed', async () => {
    const key = `key-${uuidv7()}`;
    const ctx = testContext({ tenantId, idempotencyKey: key });
    const params = { tenantId, operation: 'createOrganization', key, requestPayload: { n: 1 } };

    await expect(
      withIdempotency(pool, ctx, params, async () => {
        throw new Error('downstream exploded');
      }),
    ).rejects.toThrow(/downstream exploded/);

    // Not stuck for the whole lock window — a failed request has no response worth
    // replaying, so the same key must be usable again immediately.
    const name = `Recovered Co ${key}`;
    const retry = await withIdempotency(pool, ctx, params, sampleCommand(ctx, name));
    expect(retry.kind).toBe('executed');
  });

  it('scopes keys per tenant and per operation', async () => {
    const key = 'shared-key';
    const otherTenant = await createTestTenant(pool);
    const ctx = testContext({ tenantId, idempotencyKey: key });

    const a = await withIdempotency(
      pool,
      ctx,
      { tenantId, operation: 'opA', key, requestPayload: { x: 1 } },
      async () => ({ statusCode: 200, body: { t: 'a' }, value: 'a' }),
    );
    const b = await withIdempotency(
      pool,
      ctx,
      { tenantId, operation: 'opB', key, requestPayload: { x: 1 } },
      async () => ({ statusCode: 200, body: { t: 'b' }, value: 'b' }),
    );
    const c = await withIdempotency(
      pool,
      testContext({ tenantId: otherTenant, idempotencyKey: key }),
      { tenantId: otherTenant, operation: 'opA', key, requestPayload: { x: 1 } },
      async () => ({ statusCode: 200, body: { t: 'c' }, value: 'c' }),
    );

    expect([a.kind, b.kind, c.kind]).toEqual(['executed', 'executed', 'executed']);
  });

  it('hashes requests independently of key order', () => {
    expect(hashRequest({ a: 1, b: [2, { c: 3 }] })).toBe(hashRequest({ b: [2, { c: 3 }], a: 1 }));
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }));
    // An omitted optional field and an explicit undefined are the same request.
    expect(hashRequest({ a: 1, b: undefined })).toBe(hashRequest({ a: 1 }));
  });

  it('reaps expired keys without touching live ones', async () => {
    const key = `expiring-${uuidv7()}`;
    await pool.query(
      `INSERT INTO idempotency_keys (tenant_id, idempotency_key, operation, request_hash, expires_at)
       VALUES ($1, $2, 'opX', 'hash', now() - interval '1 day')`,
      [tenantId, key],
    );
    const before = await countRows(pool, 'idempotency_keys', 'idempotency_key = $1', [key]);
    expect(before).toBe(1);

    await reapExpiredKeys(pool);
    expect(await countRows(pool, 'idempotency_keys', 'idempotency_key = $1', [key])).toBe(0);
  });
});
