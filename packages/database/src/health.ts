import { Pool } from 'pg';
import { unpublishedLag } from './outbox';
import { appliedMigrations, loadMigrations } from './migrator';

/**
 * Health checks — doc 21 Phase 0 ("structured logging, correlation/request IDs,
 * error taxonomy and health endpoints").
 *
 * Split into liveness and readiness because they answer different questions and a
 * single endpoint conflating them causes outages: a liveness probe that fails on a
 * slow database restarts every replica at exactly the moment the database is
 * struggling.
 */

export type HealthState = 'ok' | 'degraded' | 'down';

export interface CheckResult {
  readonly name: string;
  readonly state: HealthState;
  readonly latencyMs: number;
  readonly detail?: string;
}

export interface HealthReport {
  readonly state: HealthState;
  readonly checks: readonly CheckResult[];
  readonly version: string;
  readonly checkedAt: string;
}

async function timed(name: string, fn: () => Promise<string | undefined>): Promise<CheckResult> {
  const started = Date.now();
  try {
    const detail = await fn();
    return { name, state: 'ok', latencyMs: Date.now() - started, ...(detail ? { detail } : {}) };
  } catch (err) {
    return {
      name,
      state: 'down',
      latencyMs: Date.now() - started,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function checkDatabase(pool: Pool): Promise<CheckResult> {
  return timed('database', async () => {
    const { rows } = await pool.query<{ v: string }>('SELECT version() AS v');
    const version = rows[0]?.v ?? '';
    const major = Number(/PostgreSQL (\d+)/.exec(version)?.[1] ?? 0);
    // ADR-0008 §1: below 16 the schema does not merely perform worse, it fails to
    // apply. Better to say so on the health endpoint than in a migration at 02:00.
    if (major < 16) throw new Error(`PostgreSQL ${major} is below the required minimum of 16`);
    return `PostgreSQL ${major}`;
  });
}

export async function checkMigrations(pool: Pool): Promise<CheckResult> {
  return timed('migrations', async () => {
    const [files, applied] = await Promise.all([loadMigrations(), appliedMigrations(pool)]);
    const pending = files.length - applied.length;
    if (pending > 0) throw new Error(`${pending} migration(s) pending`);
    return `${applied.length} applied`;
  });
}

/** ADR-0009 alert threshold: outbox unpublished age p99 > 60 s. */
export async function checkOutbox(pool: Pool): Promise<CheckResult> {
  const started = Date.now();
  try {
    const { count, oldestSeconds } = await unpublishedLag(pool);
    // Degraded, not down: a lagging outbox means events are late, not lost, and
    // taking the API out of rotation for it would make the backlog worse.
    const state: HealthState = oldestSeconds > 60 ? 'degraded' : 'ok';
    return {
      name: 'outbox',
      state,
      latencyMs: Date.now() - started,
      detail: `${count} unpublished, oldest ${oldestSeconds}s`,
    };
  } catch (err) {
    return {
      name: 'outbox',
      state: 'down',
      latencyMs: Date.now() - started,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function readiness(pool: Pool, version: string): Promise<HealthReport> {
  const checks = await Promise.all([checkDatabase(pool), checkMigrations(pool), checkOutbox(pool)]);
  const state: HealthState = checks.some((c) => c.state === 'down')
    ? 'down'
    : checks.some((c) => c.state === 'degraded')
      ? 'degraded'
      : 'ok';
  return { state, checks, version, checkedAt: new Date().toISOString() };
}
