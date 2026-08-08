import { Pool, PoolClient } from 'pg';
import { RequestContext, requireContext } from '@acct/domain';
import { mapDatabaseError, isRetryable, isDatabaseError } from './errors';

/** Preserves a caller's own error; translates only errors PostgreSQL raised. */
function surface(err: unknown): unknown {
  return isDatabaseError(err) ? mapDatabaseError(err) : err;
}

/**
 * Transaction helper — doc 21 Phase 0.
 *
 * Every accounting write goes through here, which is what makes three separate
 * guarantees enforceable in one place rather than remembered in dozens:
 *
 *   - The outbox row and the aggregate row commit together or not at all
 *     (doc 01: "Outbox publication occurs only after the originating database
 *     transaction commits").
 *   - Lock acquisition follows ADR-0004's documented order, so the deadlock test
 *     Gate G requires has something deterministic to test.
 *   - A deadlock or serialization failure is retried once, transparently, rather
 *     than surfacing to a user who did nothing wrong.
 */

export interface TransactionOptions {
  readonly isolation?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
  readonly readOnly?: boolean;
  /**
   * ADR-0004 rejected SERIALIZABLE as the default because it pushes retry into
   * every caller; one bounded retry here covers the residual 40001/40P01 cases.
   */
  readonly maxRetries?: number;
  readonly context?: RequestContext;
}

export interface TransactionScope {
  readonly client: PoolClient;
  readonly context: RequestContext;
  /** Attempt number, 1-based. Non-idempotent side effects must check this. */
  readonly attempt: number;
}

const DEFAULT_MAX_RETRIES = 1;

export async function withTransaction<T>(
  pool: Pool,
  fn: (scope: TransactionScope) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const context = options.context ?? requireContext();
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const client = await pool.connect();
    try {
      const isolation = options.isolation ?? 'READ COMMITTED';
      const mode = options.readOnly ? ' READ ONLY' : '';
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}${mode}`);

      // Surfaces in pg_stat_activity and in the PostgreSQL log, so a slow or
      // stuck transaction can be tied back to the request that started it.
      await client.query('SELECT set_config($1, $2, true)', [
        'app.correlation_id',
        context.correlationId,
      ]);
      if (context.tenantId) {
        await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', context.tenantId]);
      }
      if (context.actorId) {
        await client.query('SELECT set_config($1, $2, true)', ['app.actor_id', context.actorId]);
      }

      const result = await fn({ client, context, attempt });

      // COMMIT is where DEFERRABLE INITIALLY DEFERRED constraint triggers fire —
      // the journal balance assertion among them. A failure here is a real
      // accounting rejection, not an infrastructure error.
      await client.query('COMMIT');
      return result;
    } catch (err) {
      lastError = err;
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection is already broken; the pool will discard it.
      }
      if (attempt <= maxRetries && isRetryable(err)) continue;
      throw surface(err);
    } finally {
      client.release();
    }
  }

  throw surface(lastError);
}

/** A read-only transaction — reporting queries that must see one consistent snapshot. */
export function withReadTransaction<T>(
  pool: Pool,
  fn: (scope: TransactionScope) => Promise<T>,
  options: Omit<TransactionOptions, 'readOnly'> = {},
): Promise<T> {
  return withTransaction(pool, fn, {
    ...options,
    readOnly: true,
    isolation: options.isolation ?? 'REPEATABLE READ',
  });
}

// ---------------------------------------------------------------------------
// Lock helpers — ADR-0004
//
// The ADR's phrase is "The documented lock order is load-bearing." These wrappers
// are how it stays documented: a caller that takes locks through them cannot
// choose its own order, because the order is inside the helper.
// ---------------------------------------------------------------------------

export type LockStrength = 'FOR UPDATE' | 'FOR NO KEY UPDATE' | 'FOR SHARE';

/**
 * Locks rows in a fixed, ascending-id order.
 *
 * ADR-0004 §2: "Lock order is payment first, then targets in ascending id order —
 * without a fixed order, concurrent multi-invoice allocations deadlock." Sorting
 * here means the caller's input order cannot cause it.
 */
export async function lockRowsById<T extends { id: string }>(
  client: PoolClient,
  table: string,
  ids: readonly string[],
  strength: LockStrength = 'FOR UPDATE',
): Promise<T[]> {
  if (ids.length === 0) return [];
  const ordered = [...new Set(ids)].sort();
  const { rows } = await client.query<T>(
    `SELECT * FROM ${assertIdentifier(table)}
      WHERE id = ANY($1::uuid[])
      ORDER BY id
      ${strength}`,
    [ordered],
  );
  return rows;
}

/** ADR-0004 §1 — the document-number serialisation point, held as briefly as possible. */
export async function lockSequenceForUpdate<T extends { id: string }>(
  client: PoolClient,
  sequenceId: string,
): Promise<T | null> {
  const { rows } = await client.query<T>(
    `SELECT * FROM number_sequences WHERE id = $1 FOR UPDATE`,
    [sequenceId],
  );
  return rows[0] ?? null;
}

/**
 * ADR-0004 §4 — re-checks period status inside the posting transaction.
 *
 * `FOR SHARE` and not `FOR UPDATE`: concurrent posts to the same open period must
 * not serialise against each other, but a period *close* takes `FOR UPDATE` on
 * the same row and therefore cannot interleave with an in-flight post. That is
 * doc 03's acceptance criterion, expressed as two lock strengths.
 */
export async function lockPeriodForPosting<T extends { id: string; status: string }>(
  client: PoolClient,
  periodId: string,
): Promise<T | null> {
  const { rows } = await client.query<T>(
    `SELECT * FROM accounting_periods WHERE id = $1 FOR SHARE`,
    [periodId],
  );
  return rows[0] ?? null;
}

export async function lockPeriodForClose<T extends { id: string; status: string }>(
  client: PoolClient,
  periodId: string,
): Promise<T | null> {
  const { rows } = await client.query<T>(
    `SELECT * FROM accounting_periods WHERE id = $1 FOR UPDATE`,
    [periodId],
  );
  return rows[0] ?? null;
}

/**
 * An advisory lock for work that has no single row to lock — a close run, a
 * depreciation run, an FX remeasurement. Released at COMMIT.
 */
export async function advisoryXactLock(
  client: PoolClient,
  namespace: string,
  key: string,
): Promise<void> {
  // Single-bigint form. The two-argument overload is (int4, int4) and
  // hashtextextended returns bigint, so the pair form does not typecheck; folding
  // the namespace into the hashed string keeps the full 64 bits.
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))`, [
    namespace,
    key,
  ]);
}

/** Guards against SQL injection through a table name; identifiers cannot be parameterised. */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
export function assertIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`unsafe SQL identifier: ${JSON.stringify(name)}`);
  return name;
}

/**
 * Defers all deferrable constraints for the remainder of the transaction.
 *
 * Used by the bulk import and opening-balance paths, where intermediate states are
 * legitimately unbalanced and only the final state must satisfy the assertions.
 */
export async function deferConstraints(client: PoolClient): Promise<void> {
  await client.query('SET CONSTRAINTS ALL DEFERRED');
}
