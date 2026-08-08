import { loadDotenv } from '@acct/config';
import { createPool, migrate, status } from '@acct/database';

/**
 * Brings the disposable test database up to the current schema and makes sure the
 * `app_runtime` login role exists.
 *
 * The role matters here more than anywhere: the isolation tests connect as it, and
 * connecting as the owner instead would make them pass while proving nothing —
 * a superuser bypasses the migration 0024 policies entirely.
 */
export async function setup(): Promise<void> {
  loadDotenv();
  applyTestEnvironment();

  const pool = createPool({
    connectionString: process.env.DATABASE_URL!,
    max: 4,
    applicationName: 'acct-api-test-setup',
    statementTimeoutMs: 600_000,
    lockTimeoutMs: 30_000,
  });

  try {
    const before = await status(pool);
    if (before.pending.length > 0) {
      const result = await migrate(pool);
      console.log(`[api-test-setup] applied ${result.applied.length} migration(s)`);
    }

    const runtime = new URL(process.env.APP_DATABASE_URL!);
    const user = decodeURIComponent(runtime.username);
    const password = decodeURIComponent(runtime.password);
    const database = runtime.pathname.replace(/^\//, '');

    const { rows: exists } = await pool.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
      [user],
    );
    const { rows: quoted } = await pool.query<{ role: string; secret: string; db: string }>(
      'SELECT quote_ident($1) AS role, quote_literal($2) AS secret, quote_ident($3) AS db',
      [user, password, database],
    );
    const { role, secret, db } = quoted[0]!;
    await pool.query(
      exists[0]?.exists
        ? `ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOBYPASSRLS INHERIT PASSWORD ${secret}`
        : `CREATE ROLE ${role} WITH LOGIN NOSUPERUSER NOBYPASSRLS INHERIT PASSWORD ${secret}`,
    );
    await pool.query(`GRANT CONNECT ON DATABASE ${db} TO ${role}`);
    await pool.query(`GRANT app_runtime TO ${role}`);
  } finally {
    await pool.end();
  }
}

/**
 * Exported and called again from `setup-file.ts`.
 *
 * Vitest runs `globalSetup` in the main process and the tests in workers, and the
 * workers are not guaranteed to inherit a variable the main process set after
 * launch. Applying it in both places costs nothing and removes a class of
 * "passes locally, fails in CI" that is miserable to diagnose.
 */
export function applyTestEnvironment(): void {
  const owner = process.env.TEST_DATABASE_URL;
  const runtime = process.env.TEST_APP_DATABASE_URL;
  if (!owner || !runtime) {
    throw new Error(
      'TEST_DATABASE_URL and TEST_APP_DATABASE_URL must be set. Run `pnpm stack:up`, which ' +
        'appends anything missing from .env.example.',
    );
  }
  process.env.DATABASE_URL = owner;
  process.env.APP_DATABASE_URL = runtime;
  process.env.NODE_ENV = 'test';
  process.env.ENABLE_PHASE0_SAMPLE = 'false';
  // The suite deliberately provokes hundreds of 401s and 403s. At `debug` each one
  // prints a stack, and the signal — which assertion failed — drowns.
  process.env.LOG_LEVEL ??= 'error';
  if (process.env.LOG_LEVEL === 'debug') process.env.LOG_LEVEL = 'error';
}
