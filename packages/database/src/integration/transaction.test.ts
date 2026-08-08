import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { uuidv7 } from '@acct/domain';
import {
  withTransaction,
  withReadTransaction,
  lockRowsById,
  assertIdentifier,
} from '../transaction';
import { mapDatabaseError } from '../errors';
import { testPool, testContext, createTestTenant, closeTestPool } from './helpers';

/**
 * The transaction helper and the ADR-0004 lock protocols it enforces.
 *
 * ADR-0004: "The documented lock order is load-bearing. Gate G must include a
 * deliberate deadlock test: two concurrent receipts allocating to the same two
 * invoices in opposite input order." That test is here in its Phase 0 form —
 * against `organizations` rather than invoices, because invoices arrive in
 * Phase 3, but the protocol under test is the same one.
 */
describe('transaction helper', () => {
  const pool = testPool();
  let tenantId: string;

  beforeAll(async () => {
    tenantId = await createTestTenant(pool);
  });

  const makeOrg = async (name: string): Promise<string> => {
    const id = uuidv7();
    await pool.query(`INSERT INTO organizations (id, tenant_id, name) VALUES ($1,$2,$3)`, [
      id,
      tenantId,
      name,
    ]);
    return id;
  };

  it('rolls back everything on failure', async () => {
    const id = uuidv7();
    await expect(
      withTransaction(pool, async ({ client }) => {
        await client.query(`INSERT INTO organizations (id, tenant_id, name) VALUES ($1,$2,$3)`, [
          id,
          tenantId,
          'Rolled Back',
        ]);
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');

    const { rowCount } = await pool.query(`SELECT 1 FROM organizations WHERE id = $1`, [id]);
    expect(rowCount).toBe(0);
  });

  it('exposes the correlation ID to the database session', async () => {
    const ctx = testContext({ tenantId });
    const seen = await withTransaction(
      pool,
      async ({ client }) => {
        const { rows } = await client.query<{ v: string }>(
          `SELECT current_setting('app.correlation_id', true) AS v`,
        );
        return rows[0]?.v;
      },
      { context: ctx },
    );
    // This is what ties a slow query in pg_stat_activity back to a request.
    expect(seen).toBe(ctx.correlationId);
  });

  it('refuses writes in a read transaction', async () => {
    // Writing from a reporting path is a defect in our code, not bad input, so it
    // surfaces as INTERNAL with the detail kept for the log and out of the response.
    const error = await withReadTransaction(pool, ({ client }) =>
      client.query(`INSERT INTO organizations (id, tenant_id, name) VALUES ($1,$2,$3)`, [
        uuidv7(),
        tenantId,
        'Nope',
      ]),
    ).catch((e) => e);

    expect(error).toMatchObject({ code: 'INTERNAL', httpStatus: 500, safeToExpose: false });
    expect(String((error as Error).cause)).toMatch(/read-only transaction/i);
  });

  it('does not deadlock when both sides lock the same rows in opposite input order', async () => {
    const first = await makeOrg('Lock A');
    const second = await makeOrg('Lock B');

    // Deliberately opposite orders. lockRowsById sorts, so both transactions take
    // the locks in the same sequence and one simply waits for the other.
    const results = await Promise.allSettled([
      withTransaction(pool, async ({ client }) => {
        const rows = await lockRowsById(client, 'organizations', [first, second]);
        await new Promise((r) => setTimeout(r, 150));
        return rows.length;
      }),
      withTransaction(pool, async ({ client }) => {
        const rows = await lockRowsById(client, 'organizations', [second, first]);
        await new Promise((r) => setTimeout(r, 150));
        return rows.length;
      }),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : -1))).toEqual([2, 2]);
  });

  it('surfaces a lock timeout as a typed error rather than a hang', async () => {
    const id = await makeOrg('Contended');
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT * FROM organizations WHERE id = $1 FOR UPDATE`, [id]);

      await expect(
        withTransaction(pool, ({ client }) => lockRowsById(client, 'organizations', [id]), {
          maxRetries: 0,
        }),
      ).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });

      await holder.query('ROLLBACK');
    } finally {
      holder.release();
    }
  });

  it('refuses an unsafe table identifier', () => {
    expect(() => assertIdentifier('organizations')).not.toThrow();
    expect(() => assertIdentifier('organizations; DROP TABLE tenants')).toThrow(
      /unsafe SQL identifier/,
    );
    expect(() => assertIdentifier('Organizations')).toThrow();
  });
});

describe('database error mapping', () => {
  const pool = testPool();
  let tenantId: string;

  beforeAll(async () => {
    tenantId = await createTestTenant(pool);
  });

  it('maps a unique violation to a typed conflict, without echoing the row', async () => {
    // The whole id: a uuidv7 prefix is a timestamp, so it repeats between runs.
    const slug = `dup-${uuidv7()}`;
    await pool.query(`INSERT INTO tenants (name, slug) VALUES ($1, $2)`, ['Dup A', slug]);

    try {
      await pool.query(`INSERT INTO tenants (name, slug) VALUES ($1, $2)`, ['Dup B', slug]);
      expect.unreachable('the unique constraint should have rejected this');
    } catch (raw) {
      const mapped = mapDatabaseError(raw);
      expect(mapped.code).toBe('VERSION_CONFLICT');
      expect(mapped.httpStatus).toBe(409);
      // doc 15: never a stack trace or SQL, and never the conflicting values.
      expect(mapped.message).not.toContain(slug);
      expect(mapped.message).not.toContain('INSERT');
    }
  });

  it('maps a foreign key violation', async () => {
    try {
      await pool.query(`INSERT INTO organizations (tenant_id, name) VALUES ($1, $2)`, [
        uuidv7(),
        'Orphan',
      ]);
      expect.unreachable('the foreign key should have rejected this');
    } catch (raw) {
      expect(mapDatabaseError(raw).code).toBe('VALIDATION_FAILED');
    }
  });

  it('maps the tenant-scoped storage key guard to a tenant error (F-048)', async () => {
    try {
      await pool.query(
        `INSERT INTO files (tenant_id, storage_key, original_filename) VALUES ($1, $2, $3)`,
        [tenantId, 'some-other-tenant/evidence.pdf', 'evidence.pdf'],
      );
      expect.unreachable('files_key_is_tenant_scoped should have rejected this');
    } catch (raw) {
      const mapped = mapDatabaseError(raw);
      expect(mapped.code).toBe('TENANT_MISMATCH');
    }
  });

  it('maps an exclusion violation on an effective-dated range', async () => {
    // posting_rule_versions_no_overlap and friends all report 23P01.
    const err = mapDatabaseError({
      code: '23P01',
      constraint: 'accounting_periods_no_overlap',
      message: 'x',
    });
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.message).toMatch(/overlaps an existing one/);
  });

  it('classifies deadlock and serialization failures as retryable', () => {
    expect(
      mapDatabaseError({ code: '40P01', severity: 'ERROR', message: 'deadlock detected' }).code,
    ).toBe('DEADLOCK_DETECTED');
    expect(
      mapDatabaseError({ code: '40001', severity: 'ERROR', message: 'could not serialize' }).code,
    ).toBe('VERSION_CONFLICT');
  });

  it('passes a business rule error through untouched', async () => {
    // A domain failure inside a transaction must not become "Database operation
    // failed" — that turns an actionable 422 into an opaque 500.
    class BusinessRuleError extends Error {}
    await expect(
      withTransaction(pool, async () => {
        throw new BusinessRuleError('period is soft-closed for this book');
      }),
    ).rejects.toBeInstanceOf(BusinessRuleError);
  });
});

// One pool per test file, closed once. Closing it inside a describe would end it
// while a later describe in the same file is still using it.
afterAll(closeTestPool);
