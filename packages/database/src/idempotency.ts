import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import {
  RequestContext,
  idempotencyInProgress,
  idempotencyKeyReuse,
  isValidIdempotencyKey,
  AppError,
} from '@acct/domain';

/**
 * Idempotency — F-044, and the protocol stated normatively in
 * contracts/schema/0001_platform.sql so it cannot drift from the table:
 *
 *   new key                          -> insert row, execute, store response
 *   row exists, locked_until > now   -> 409 IN_PROGRESS
 *   row exists, response stored      -> replay stored response
 *   row exists, request_hash differs -> 422 IDEMPOTENCY_KEY_REUSE
 *
 * Phase 0 exit criterion 4 — "Retry of idempotent sample command does not
 * duplicate data" — is this file.
 *
 * The reservation commits in its own transaction *before* the operation runs.
 * That is the whole mechanism: a concurrent retry has to be able to see the
 * reservation, and it cannot see anything still inside an uncommitted
 * transaction. Reserving inside the operation's transaction would make the
 * unique constraint useless against exactly the concurrent case it exists for.
 */

export interface IdempotencyRecord {
  id: string;
  tenant_id: string;
  idempotency_key: string;
  operation: string;
  request_hash: string;
  response_code: number | null;
  response_body: unknown;
  resource_type: string | null;
  resource_id: string | null;
  locked_until: string | null;
  created_at: string;
}

export type IdempotencyOutcome<T> =
  | { readonly kind: 'executed'; readonly value: T }
  | { readonly kind: 'replayed'; readonly statusCode: number; readonly body: unknown };

export interface StoredResponse {
  readonly statusCode: number;
  readonly body: unknown;
  readonly resourceType?: string | null;
  readonly resourceId?: string | null;
}

/** Stable across key ordering, so a client that reorders JSON keys is not punished. */
export function hashRequest(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** How long a reservation is considered in-flight before another attempt may take it. */
export const DEFAULT_LOCK_SECONDS = 60;

export interface IdempotencyOptions {
  readonly lockSeconds?: number;
}

/**
 * Runs `operation` at most once per (tenant, operation, key).
 *
 * `operation` returns the response to store. It must do its own database work in
 * its own transaction — this function deliberately does not wrap it, because the
 * reservation and the work have to commit separately for the protocol above to
 * hold.
 */
export async function withIdempotency<T>(
  pool: Pool,
  ctx: RequestContext,
  params: {
    readonly tenantId: string;
    readonly operation: string;
    readonly key: string;
    readonly requestPayload: unknown;
  },
  operation: () => Promise<StoredResponse & { value: T }>,
  options: IdempotencyOptions = {},
): Promise<IdempotencyOutcome<T>> {
  const { tenantId, operation: operationId, key } = params;

  if (!isValidIdempotencyKey(key)) {
    throw new AppError('VALIDATION_FAILED', 'Idempotency-Key must be 1-255 printable characters.', {
      fieldErrors: [
        { field: 'Idempotency-Key', code: 'INVALID', message: '1-255 printable characters' },
      ],
    });
  }

  const requestHash = hashRequest(params.requestPayload);
  const lockSeconds = options.lockSeconds ?? DEFAULT_LOCK_SECONDS;

  // 1. Reserve. ON CONFLICT ... DO NOTHING makes this a single atomic decision:
  //    either this attempt owns the key, or someone else already does.
  const reserved = await pool.query<{ id: string }>(
    `INSERT INTO idempotency_keys (tenant_id, idempotency_key, operation, request_hash, locked_until)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))
     ON CONFLICT (tenant_id, operation, idempotency_key) DO NOTHING
     RETURNING id`,
    [tenantId, key, operationId, requestHash, lockSeconds],
  );

  if (reserved.rowCount === 0) {
    const existing = await loadRecord(pool, tenantId, operationId, key);
    if (!existing) {
      // The row vanished between the conflict and the read — only possible if the
      // reaper deleted an expired key. Treat as a fresh attempt.
      return withIdempotency(pool, ctx, params, operation, options);
    }
    if (existing.request_hash !== requestHash) throw idempotencyKeyReuse(key);
    if (existing.response_code !== null) {
      return { kind: 'replayed', statusCode: existing.response_code, body: existing.response_body };
    }
    if (existing.locked_until && new Date(existing.locked_until).getTime() > Date.now()) {
      throw idempotencyInProgress(key);
    }
    // The lock expired without a stored response: the previous attempt died.
    // Take ownership by extending the lock, but only if nobody else has.
    const taken = await pool.query(
      `UPDATE idempotency_keys
          SET locked_until = now() + make_interval(secs => $2)
        WHERE id = $1 AND response_code IS NULL
          AND (locked_until IS NULL OR locked_until <= now())`,
      [existing.id, lockSeconds],
    );
    if (taken.rowCount === 0) throw idempotencyInProgress(key);
  }

  // 2. Execute.
  let response: StoredResponse & { value: T };
  try {
    response = await operation();
  } catch (err) {
    // Release the reservation so a corrected retry is not blocked for the whole
    // lock window. A *failed* request has no response worth replaying.
    await pool
      .query(
        `DELETE FROM idempotency_keys
          WHERE tenant_id = $1 AND operation = $2 AND idempotency_key = $3
            AND response_code IS NULL`,
        [tenantId, operationId, key],
      )
      .catch(() => undefined);
    throw err;
  }

  // 3. Store the response for replay.
  await pool.query(
    `UPDATE idempotency_keys
        SET response_code = $4, response_body = $5,
            resource_type = $6, resource_id = $7, locked_until = NULL
      WHERE tenant_id = $1 AND operation = $2 AND idempotency_key = $3`,
    [
      tenantId,
      operationId,
      key,
      response.statusCode,
      JSON.stringify(response.body ?? null),
      response.resourceType ?? null,
      response.resourceId ?? null,
    ],
  );

  return { kind: 'executed', value: response.value };
}

async function loadRecord(
  pool: Pool,
  tenantId: string,
  operation: string,
  key: string,
): Promise<IdempotencyRecord | null> {
  const { rows } = await pool.query<IdempotencyRecord>(
    `SELECT id, tenant_id, idempotency_key, operation, request_hash,
            response_code, response_body, resource_type, resource_id,
            locked_until::text, created_at::text
       FROM idempotency_keys
      WHERE tenant_id = $1 AND operation = $2 AND idempotency_key = $3`,
    [tenantId, operation, key],
  );
  return rows[0] ?? null;
}

/** F-044 retention: keys expire after 30 days. Run from the maintenance queue. */
export async function reapExpiredKeys(pool: Pool, limit = 10_000): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM idempotency_keys
      WHERE ctid IN (SELECT ctid FROM idempotency_keys WHERE expires_at < now() LIMIT $1)`,
    [limit],
  );
  return rowCount ?? 0;
}
