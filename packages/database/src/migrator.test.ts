import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadMigrations,
  migrationsDirectory,
  compareSnapshots,
  snapshotPath,
  appliedMigrations,
} from './migrator';
import type { SchemaSnapshot } from './migrator';
import type { Pool } from 'pg';

describe('migration loading', () => {
  it('reads every migration in a contiguous, ordered sequence', async () => {
    // Deliberately not a count. A hardcoded total fails on the day a phase adds a
    // migration, which trains people to update the number without looking — and
    // the number was never the thing worth protecting. Contiguity is: a gap means
    // a migration was deleted or misnumbered, and a misnumbered one applies in the
    // wrong order on a fresh database while looking correct on an existing one.
    const migrations = await loadMigrations();
    expect(migrations.length).toBeGreaterThan(20);
    expect(migrations[0]?.name).toBe('0000_extensions_and_types');
    expect(migrations.map((m) => m.version)).toEqual(
      migrations.map((_, i) => String(i).padStart(4, '0')),
    );
  });

  it('gives every migration a distinct checksum', async () => {
    const migrations = await loadMigrations();
    expect(new Set(migrations.map((m) => m.checksum)).size).toBe(migrations.length);
  });

  it('produces a checksum that survives a line-ending change', async () => {
    // A Windows checkout with autocrlf would otherwise fail every checksum on
    // first run, and the fix people reach for is to disable the check.
    const migrations = await loadMigrations();
    const first = migrations[0]!;
    const raw = readFileSync(first.path, 'utf8');
    expect(first.sql).not.toContain('\r');
    expect(raw.replace(/\r\n/g, '\n').trimEnd()).toBe(first.sql.trimEnd());
  });

  it('points at contracts/schema, not a copy', () => {
    expect(migrationsDirectory()).toContain(join('contracts', 'schema'));
  });
});

describe('reading the applied ledger', () => {
  /**
   * A pool that answers `to_regclass` however the test asks, returns one row for
   * the SELECT, and refuses to be used for DDL.
   */
  function recordingPool(tablePresent: boolean): { pool: Pool; sql: string[] } {
    const sql: string[] = [];
    const pool = {
      query: async (text: string) => {
        sql.push(text);
        if (/^\s*(CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\b/i.test(text)) {
          // What PostgreSQL says to app_runtime, which has no CREATE on public.
          throw new Error('permission denied for schema public');
        }
        if (text.includes('to_regclass')) {
          return { rows: [{ relation: tablePresent ? 'schema_migrations' : null }] };
        }
        return {
          rows: [
            { version: '0000', name: '0000_x', checksum: 'a', applied_at: 'now', duration_ms: 1 },
          ],
        };
      },
    } as unknown as Pool;
    return { pool, sql };
  }

  it('issues no DDL, because the readiness probe reads it as the runtime role', async () => {
    // F-622: this path used to CREATE TABLE IF NOT EXISTS first. The API connects
    // as app_runtime (ADR-0002), which has no CREATE on schema public, so GET
    // /health answered "down / permission denied for schema public" on every call
    // while the system was in fact healthy.
    const { pool, sql } = recordingPool(true);
    const rows = await appliedMigrations(pool);

    expect(rows).toHaveLength(1);
    expect(sql.some((s) => /^\s*(CREATE|ALTER|DROP)\b/i.test(s))).toBe(false);
  });

  it('reports an absent table as nothing applied rather than an error', async () => {
    // A fresh database has applied no migrations, which is an answer, not a fault.
    // The health check turns it into "35 pending" — down for the right reason.
    const { pool } = recordingPool(false);
    await expect(appliedMigrations(pool)).resolves.toEqual([]);
  });
});

describe('drift comparison', () => {
  const base: SchemaSnapshot = {
    generated_from: 'contracts/schema',
    fingerprint: 'a',
    counts: { tables: 2 },
    objects: {
      tables: ['tenants(id:uuid!)', 'organizations(id:uuid!)'],
      enums: [],
      constraints: [],
      indexes: [],
      triggers: [],
      functions: [],
    },
  };

  it('reports an added object', () => {
    const drifted: SchemaSnapshot = {
      ...base,
      fingerprint: 'b',
      objects: { ...base.objects, tables: [...base.objects.tables, 'rogue(id:uuid!)'] },
    };
    const report = compareSnapshots(base, drifted);
    expect(report.matches).toBe(false);
    expect(report.added).toContain('tables: rogue(id:uuid!)');
    expect(report.removed).toHaveLength(0);
  });

  it('reports a removed object', () => {
    const drifted: SchemaSnapshot = {
      ...base,
      fingerprint: 'c',
      objects: { ...base.objects, tables: ['tenants(id:uuid!)'] },
    };
    const report = compareSnapshots(base, drifted);
    expect(report.matches).toBe(false);
    expect(report.removed).toContain('tables: organizations(id:uuid!)');
  });

  it('reports a changed column type as one removal and one addition', () => {
    const drifted: SchemaSnapshot = {
      ...base,
      fingerprint: 'd',
      objects: { ...base.objects, tables: ['tenants(id:text!)', 'organizations(id:uuid!)'] },
    };
    const report = compareSnapshots(base, drifted);
    expect(report.added).toContain('tables: tenants(id:text!)');
    expect(report.removed).toContain('tables: tenants(id:uuid!)');
  });

  it('matches an identical snapshot', () => {
    expect(compareSnapshots(base, base).matches).toBe(true);
  });

  it('locates the committed snapshot inside contracts/schema', () => {
    expect(snapshotPath()).toContain(join('contracts', 'schema', 'schema.lock.json'));
  });
});
