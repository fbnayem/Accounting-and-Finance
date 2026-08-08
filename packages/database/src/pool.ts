import { Pool, PoolClient, PoolConfig, types } from 'pg';

/**
 * Connection pool and type parsers.
 *
 * The type parser configuration below is not a preference. node-postgres by
 * default converts `date` columns into JavaScript `Date` objects at midnight UTC,
 * which is the previous calendar day everywhere west of Greenwich. `posting_date`
 * is a `date` column and doc 01 makes it the value that selects the accounting
 * period, so the default behaviour would silently post into the wrong period for
 * roughly half the world. Every `date` therefore stays a `YYYY-MM-DD` string, as
 * `@acct/domain`'s `AccountingDate` expects.
 *
 * `numeric` likewise stays a string: converting `numeric(24,8)` to a float is the
 * exact thing ADR-0006 §1 forbids.
 */

const OID = {
  INT8: 20,
  NUMERIC: 1700,
  DATE: 1082,
  TIMESTAMP: 1114,
  INT8_ARRAY: 1016,
  NUMERIC_ARRAY: 1231,
} as const;

let parsersInstalled = false;

export function installTypeParsers(): void {
  if (parsersInstalled) return;
  parsersInstalled = true;

  // Calendar day, never an instant. See the note above.
  types.setTypeParser(OID.DATE, (v) => v);
  // Exact decimal, never a float (ADR-0006 §1).
  types.setTypeParser(OID.NUMERIC, (v) => v);
  // bigint beyond 2^53 loses precision as a number; audit_events.id is bigserial.
  types.setTypeParser(OID.INT8, (v) => v);
  // `timestamp without time zone` has no zone to interpret it in; anything that
  // matters is timestamptz, so leave this as text rather than guess.
  types.setTypeParser(OID.TIMESTAMP, (v) => v);
}

export interface DatabaseOptions {
  readonly connectionString: string;
  readonly max?: number;
  readonly statementTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly ssl?: boolean;
  readonly applicationName?: string;
}

export function createPool(options: DatabaseOptions): Pool {
  installTypeParsers();

  // Sent as PostgreSQL startup parameters rather than as `SET` statements on a
  // 'connect' handler. The handler form races the driver's own handshake, and —
  // more importantly — a connection could be handed to a caller before the SETs
  // land, so the first query on a fresh connection would run with no lock timeout.
  // As startup options they are in force before the connection is usable at all.
  //
  // ADR-0004: posting takes row locks, and a lock wait beyond the timeout is a
  // defect (usually a lock-ordering violation), so it must fail loudly.
  const startupOptions = [
    `-c statement_timeout=${Number(options.statementTimeoutMs ?? 30_000)}`,
    `-c lock_timeout=${Number(options.lockTimeoutMs ?? 5_000)}`,
    `-c idle_in_transaction_session_timeout=60000`,
    `-c timezone=UTC`,
  ].join(' ');

  // There is deliberately no "bypass RLS" option here. Migration 0024 keys the
  // exemption to membership of `app_maintenance`, so a connection is exempt because
  // of the role in its URL and for no other reason. A pool flag would put that
  // decision back where a caller could make it.

  const config: PoolConfig = {
    connectionString: options.connectionString,
    max: options.max ?? 20,
    application_name: options.applicationName ?? 'acct',
    options: startupOptions,
    // A connection that cannot be established quickly is a dependency failure,
    // not something to queue behind.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    ...(options.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
  };

  const pool = new Pool(config);

  pool.on('error', (err) => {
    // An idle client erroring must not take the process down.
    console.error({ err: err.message }, 'idle database client error');
  });

  return pool;
}

export type Queryable = Pool | PoolClient;

export interface SqlRow {
  [column: string]: unknown;
}

export async function query<T extends SqlRow = SqlRow>(
  db: Queryable,
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await db.query<T>(text, params as unknown[]);
  return result.rows;
}

export async function queryOne<T extends SqlRow = SqlRow>(
  db: Queryable,
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(db, text, params);
  return rows[0] ?? null;
}

export async function execute(
  db: Queryable,
  text: string,
  params: readonly unknown[] = [],
): Promise<number> {
  const result = await db.query(text, params as unknown[]);
  return result.rowCount ?? 0;
}
