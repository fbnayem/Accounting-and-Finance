import { Pool } from 'pg';
import { loadDotenv } from '@acct/config';
import { createPool } from '../pool';
import { migrate, status } from '../migrator';

/**
 * Brings the integration test database up to the current schema, once per run.
 *
 * Doc 19 requires raw-SQL paths to be tested against a real PostgreSQL, and
 * ADR-0008 §2 puts everything in this package on the raw-SQL side of the line.
 * A mock would not exercise a deferred constraint trigger, a `FOR UPDATE SKIP
 * LOCKED` claim or a deadlock, which is most of what there is to test here.
 */
export async function setup(): Promise<void> {
  loadDotenv();
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Run `pnpm stack:up` (it starts a disposable test database ' +
        'on its own port so the suite never truncates your working data).',
    );
  }

  const pool = createPool({
    connectionString: url,
    max: 4,
    applicationName: 'acct-test-setup',
    statementTimeoutMs: 600_000,
    lockTimeoutMs: 30_000,
  });

  try {
    const before = await status(pool);
    if (before.pending.length > 0) {
      const result = await migrate(pool);
      console.log(`[test-setup] applied ${result.applied.length} migration(s)`);
    }

    // The isolation tests connect as app_runtime, because that is the only role the
    // 0024 policies apply to. Creating it here rather than expecting `pnpm stack:up`
    // to have done it keeps `pnpm test` runnable from a clean database.
    const runtime = process.env.TEST_APP_DATABASE_URL;
    if (runtime) await ensureRuntimeRole(pool, runtime);
  } finally {
    await pool.end();
  }
}

async function ensureRuntimeRole(owner: Pool, runtimeUrl: string): Promise<void> {
  const target = new URL(runtimeUrl);
  const user = decodeURIComponent(target.username);
  const password = decodeURIComponent(target.password);
  const database = target.pathname.replace(/^\//, '');
  if (!user || !password) return;

  const { rows } = await owner.query<{ exists: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
    [user],
  );
  const { rows: quoted } = await owner.query<{ role: string; secret: string; db: string }>(
    'SELECT quote_ident($1) AS role, quote_literal($2) AS secret, quote_ident($3) AS db',
    [user, password, database],
  );
  const { role, secret, db } = quoted[0]!;
  await owner.query(
    rows[0]?.exists
      ? `ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOBYPASSRLS INHERIT PASSWORD ${secret}`
      : `CREATE ROLE ${role} WITH LOGIN NOSUPERUSER NOBYPASSRLS INHERIT PASSWORD ${secret}`,
  );
  await owner.query(`GRANT CONNECT ON DATABASE ${db} TO ${role}`);
  await owner.query(`GRANT app_runtime TO ${role}`);
}
