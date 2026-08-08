import { Pool } from 'pg';
import { loadDotenv } from '@acct/config';
import { RequestContext, newCorrelationId, uuidv7 } from '@acct/domain';
import { createPool } from '../pool';

loadDotenv();

let pool: Pool | undefined;

export function testPool(): Pool {
  if (!pool) {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('TEST_DATABASE_URL is not set — run `pnpm stack:up`');
    pool = createPool({
      connectionString: url,
      max: 10,
      applicationName: 'acct-test',
      // Short, so a lock-ordering defect fails the test in seconds rather than
      // hanging the suite.
      lockTimeoutMs: 2_000,
      statementTimeoutMs: 15_000,
    });
  }
  return pool;
}

export async function closeTestPool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

export function testContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    correlationId: newCorrelationId(),
    actorKind: 'SYSTEM',
    ...overrides,
  };
}

/**
 * Creates an isolated tenant so concurrent test files never collide.
 *
 * The slug uses the whole identifier: a uuidv7's first eight characters are its
 * millisecond timestamp, so two tenants created in the same millisecond would
 * collide on `tenants_slug_key`.
 */
export async function createTestTenant(db: Pool = testPool()): Promise<string> {
  const id = uuidv7();
  const slug = `test-${id}`;
  await db.query(`INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)`, [id, slug, slug]);
  return id;
}

/** ADR-0005: identity is global, so a user is not tenant-scoped. */
export async function createTestUser(db: Pool = testPool(), label = 'tester'): Promise<string> {
  const id = uuidv7();
  await db.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [
    id,
    `${label}-${id}@example.test`,
    label,
  ]);
  return id;
}

export async function countRows(
  db: Pool,
  table: string,
  where: string,
  params: readonly unknown[],
): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table} WHERE ${where}`,
    params as unknown[],
  );
  return Number(rows[0]?.n ?? 0);
}
