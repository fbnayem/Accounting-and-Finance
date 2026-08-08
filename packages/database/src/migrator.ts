import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';

/**
 * Migration runner and schema-drift gate.
 *
 * Phase 0 exit criterion 2 is "CI rejects schema drift". That needs two distinct
 * checks, because they catch different mistakes:
 *
 *   1. **Checksum drift** — an already-applied migration file was edited. The
 *      developer's database has the old definition, everyone else's will have the
 *      new one, and nothing else would ever notice. ADR-0008 §3 makes migrations
 *      forward-only precisely so this is always an error.
 *
 *   2. **Structural drift** — the live database no longer matches what the
 *      migrations produce, because someone ran DDL by hand. Caught by comparing a
 *      fingerprint of the live catalog against a committed snapshot.
 *
 * Migrations are the 22 files in contracts/schema/, which Deliverable 2 made the
 * single source of truth. They are read from there rather than copied, so there is
 * no second place for the schema to live.
 */

export const MIGRATIONS_TABLE = 'schema_migrations';

export interface MigrationFile {
  readonly version: string;
  readonly name: string;
  readonly path: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly version: string;
  readonly name: string;
  readonly checksum: string;
  readonly applied_at: string;
  readonly duration_ms: number;
}

export function repositoryRoot(from: string = process.cwd()): string {
  let dir = resolve(from);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(from);
}

export function migrationsDirectory(root = repositoryRoot()): string {
  return join(root, 'contracts', 'schema');
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Line endings must not change a checksum; a Windows checkout would fail every file. */
const normalise = (s: string) => s.replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n';

export async function loadMigrations(dir = migrationsDirectory()): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const out: MigrationFile[] = [];
  for (const file of entries) {
    const path = join(dir, file);
    const sql = normalise(await readFile(path, 'utf8'));
    out.push({
      version: file.slice(0, 4),
      name: file.replace(/\.sql$/, ''),
      path,
      sql,
      checksum: sha256(sql),
    });
  }
  return out;
}

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  // The one piece of DDL not in a migration file, because it is what records them.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      version     text PRIMARY KEY,
      name        text NOT NULL,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer NOT NULL DEFAULT 0
    )
  `);
}

/**
 * Reads the ledger of applied migrations. Read-only, deliberately.
 *
 * F-622: this used to call `ensureMigrationsTable` first, which is DDL. It is also
 * the readiness probe's path (`health.ts`), and the API connects as `app_runtime`,
 * which has no CREATE on schema public — so `GET /health` reported
 * `"state":"down"` with `permission denied for schema public` on every call, from
 * the moment ADR-0002's separate runtime role was introduced. A probe that reports
 * down when the system is up is worse than no probe: an orchestrator would never
 * route traffic to a healthy replica.
 *
 * An absent table is a legitimate answer here — a database with no migrations
 * applied has applied none — so it returns empty rather than throwing, and the
 * caller draws its own conclusion. `migrate()` creates the table on the write path
 * where the owner role is the one connected.
 */
export async function appliedMigrations(pool: Pool): Promise<AppliedMigration[]> {
  const { rows: present } = await pool.query<{ relation: string | null }>(
    `SELECT to_regclass($1)::text AS relation`,
    [MIGRATIONS_TABLE],
  );
  if (!present[0]?.relation) return [];

  const { rows } = await pool.query<AppliedMigration>(
    `SELECT version, name, checksum, applied_at::text, duration_ms
       FROM ${MIGRATIONS_TABLE} ORDER BY version`,
  );
  return rows;
}

export interface MigrationStatus {
  readonly pending: MigrationFile[];
  readonly applied: AppliedMigration[];
  readonly checksumMismatches: Array<{
    version: string;
    name: string;
    expected: string;
    actual: string;
  }>;
  readonly missingFiles: AppliedMigration[];
}

export async function status(pool: Pool, dir = migrationsDirectory()): Promise<MigrationStatus> {
  const files = await loadMigrations(dir);
  const applied = await appliedMigrations(pool);
  const byVersion = new Map(applied.map((a) => [a.version, a]));

  const checksumMismatches: MigrationStatus['checksumMismatches'] = [];
  const pending: MigrationFile[] = [];

  for (const file of files) {
    const record = byVersion.get(file.version);
    if (!record) {
      pending.push(file);
    } else if (record.checksum !== file.checksum) {
      checksumMismatches.push({
        version: file.version,
        name: file.name,
        expected: record.checksum,
        actual: file.checksum,
      });
    }
  }

  const fileVersions = new Set(files.map((f) => f.version));
  const missingFiles = applied.filter((a) => !fileVersions.has(a.version));

  return { pending, applied, checksumMismatches, missingFiles };
}

export class MigrationError extends Error {
  constructor(
    message: string,
    readonly version?: string,
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

export interface MigrateResult {
  readonly applied: Array<{ version: string; name: string; durationMs: number }>;
}

export async function migrate(pool: Pool, dir = migrationsDirectory()): Promise<MigrateResult> {
  // The write path is where the table gets created, because this is the only entry
  // point that runs as the owner. See appliedMigrations for why it is not done on
  // the read path (F-622).
  await ensureMigrationsTable(pool);
  const s = await status(pool, dir);

  if (s.checksumMismatches.length > 0) {
    const detail = s.checksumMismatches.map((m) => `  ${m.name}`).join('\n');
    throw new MigrationError(
      `Applied migrations have been edited:\n${detail}\n\n` +
        `Migrations are forward-only (ADR-0008 §3). Correct a mistake with a new ` +
        `migration; if this database is disposable, run \`pnpm stack:reset\`.`,
    );
  }

  const applied: MigrateResult['applied'] = [];

  for (const file of s.pending) {
    const started = Date.now();
    const client = await pool.connect();
    try {
      // Each migration is one transaction: PostgreSQL has transactional DDL, so a
      // failure halfway through leaves nothing behind to clean up by hand.
      await client.query('BEGIN');
      await client.query(file.sql);
      const durationMs = Date.now() - started;
      await client.query(
        `INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum, duration_ms)
         VALUES ($1, $2, $3, $4)`,
        [file.version, file.name, file.checksum, durationMs],
      );
      await client.query('COMMIT');
      applied.push({ version: file.version, name: file.name, durationMs });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new MigrationError(
        `${file.name} failed: ${err instanceof Error ? err.message : String(err)}`,
        file.version,
      );
    } finally {
      client.release();
    }
  }

  return { applied };
}

// ---------------------------------------------------------------------------
// Structural fingerprint
// ---------------------------------------------------------------------------

export interface SchemaSnapshot {
  readonly generated_from: string;
  readonly fingerprint: string;
  readonly counts: Record<string, number>;
  readonly objects: {
    readonly tables: string[];
    readonly enums: string[];
    readonly constraints: string[];
    readonly indexes: string[];
    readonly triggers: string[];
    readonly functions: string[];
    /**
     * Row-level security, as the catalog holds it (ADR-0002, migration 0024).
     *
     * Part of the fingerprint because this layer failed silently once already:
     * the policies existed and looked right while having no effect at all. A
     * dropped policy, or a table quietly losing FORCE, now reads as drift instead
     * of as nothing.
     */
    readonly policies: string[];
  };
}

/**
 * Reads the live catalog. Deliberately not `pg_dump`: this needs to be stable
 * across PostgreSQL patch releases and free of the formatting churn that makes a
 * dump diff unreadable, and it must run without a `pg_dump` binary in CI.
 */
export async function captureSnapshot(pool: Pool): Promise<SchemaSnapshot> {
  const q = async (sql: string): Promise<string[]> => {
    const { rows } = await pool.query<{ v: string }>(sql);
    return rows.map((r) => r.v);
  };

  const tables = await q(`
    SELECT c.relname || '(' || string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod)
             || CASE WHEN a.attnotnull THEN '!' ELSE '' END, ',' ORDER BY a.attnum) || ')' AS v
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
       AND c.relname <> '${MIGRATIONS_TABLE}'
     GROUP BY c.relname ORDER BY c.relname`);

  const enums = await q(`
    SELECT t.typname || '(' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) || ')' AS v
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public'
     GROUP BY t.typname ORDER BY t.typname`);

  const constraints = await q(`
    SELECT cl.relname || '.' || con.conname || '=' || pg_get_constraintdef(con.oid) AS v
      FROM pg_constraint con
      JOIN pg_class cl ON cl.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = cl.relnamespace
     WHERE n.nspname = 'public' AND cl.relname <> '${MIGRATIONS_TABLE}'
     ORDER BY 1`);

  const indexes = await q(`
    SELECT indexname || '=' || indexdef AS v
      FROM pg_indexes
     WHERE schemaname = 'public' AND tablename <> '${MIGRATIONS_TABLE}'
     ORDER BY 1`);

  const triggers = await q(`
    SELECT c.relname || '.' || t.tgname AS v
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal
     ORDER BY 1`);

  const functions = await q(`
    SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS v
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
     ORDER BY 1`);

  const policies = await q(`
    SELECT c.relname || '.' || pol.polname || '=' || pg_get_expr(pol.polqual, pol.polrelid)
             || ' force=' || c.relforcerowsecurity AS v
      FROM pg_policy pol
      JOIN pg_class c ON c.oid = pol.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
     ORDER BY 1`);

  const objects = { tables, enums, constraints, indexes, triggers, functions, policies };
  const counts = Object.fromEntries(Object.entries(objects).map(([k, v]) => [k, v.length]));

  return {
    generated_from: 'contracts/schema',
    fingerprint: sha256(JSON.stringify(objects)),
    counts,
    objects,
  };
}

export interface DriftReport {
  readonly matches: boolean;
  readonly expectedFingerprint: string;
  readonly actualFingerprint: string;
  readonly added: string[];
  readonly removed: string[];
}

export function compareSnapshots(expected: SchemaSnapshot, actual: SchemaSnapshot): DriftReport {
  const flatten = (s: SchemaSnapshot) =>
    new Set(
      Object.entries(s.objects).flatMap(([kind, values]) => values.map((v) => `${kind}: ${v}`)),
    );
  const e = flatten(expected);
  const a = flatten(actual);
  return {
    matches: expected.fingerprint === actual.fingerprint,
    expectedFingerprint: expected.fingerprint,
    actualFingerprint: actual.fingerprint,
    added: [...a].filter((v) => !e.has(v)).sort(),
    removed: [...e].filter((v) => !a.has(v)).sort(),
  };
}

export function snapshotPath(root = repositoryRoot()): string {
  return join(root, 'contracts', 'schema', 'schema.lock.json');
}
