#!/usr/bin/env node
/**
 * Database CLI.
 *
 *   up            apply pending migrations
 *   status        what is applied, what is pending, what has drifted
 *   verify        the CI gate — checksums, structural drift, and the privilege layer
 *   snapshot      rewrite schema.lock.json from the live database
 *   guards        run the 15-scenario guard suite from Deliverable 2
 *   runtime-role  create or update the login role the application connects as
 *
 * `verify` is Phase 0 exit criterion 2 ("CI rejects schema drift") on the schema
 * side; `pnpm contracts:check` is the same criterion on the contract side.
 *
 * Two connection strings, deliberately:
 *   DATABASE_URL      the owner. Migrations, seeding, benchmarks — cross-tenant by
 *                     design, and the only role that may create structure.
 *   APP_DATABASE_URL  `app_runtime`. What a request runs as: not a superuser, so the
 *                     0024 row-level security policies actually apply, and without
 *                     the privileges Gate C requires be revoked.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { loadDotenv } from '@acct/config';
import { createPool } from '../pool';
import {
  migrate,
  status,
  captureSnapshot,
  compareSnapshots,
  snapshotPath,
  repositoryRoot,
  migrationsDirectory,
  MigrationError,
  type SchemaSnapshot,
} from '../migrator';

loadDotenv();

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  bold: '\x1b[1m',
};

function connectionString(): string {
  const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env, or run `pnpm stack:up`.');
    process.exit(78);
  }
  return url;
}

/**
 * Creates or updates the login role the application connects as, and grants it
 * `app_runtime` (migration 0025).
 *
 * Separate from the migration because a migration is committed and a password is
 * a credential. The password is read from the runtime connection string, so the
 * role and the URL the application uses cannot disagree.
 */
async function ensureRuntimeRole(ownerUrl: string, runtimeUrl: string): Promise<number> {
  const target = new URL(runtimeUrl);
  const user = decodeURIComponent(target.username);
  const password = decodeURIComponent(target.password);
  const database = target.pathname.replace(/^\//, '');

  if (!user || !password) {
    console.error('APP_DATABASE_URL must carry the runtime role name and password.');
    return 78;
  }
  if (user === new URL(ownerUrl).username) {
    console.error(
      `APP_DATABASE_URL and DATABASE_URL both connect as "${user}". The point of the ` +
        'runtime role is that the application is NOT the owner: as the owner it is a superuser, ' +
        'and a superuser bypasses row-level security entirely (0024, 0025).',
    );
    return 78;
  }

  const owner = createPool({
    connectionString: ownerUrl,
    max: 1,
    applicationName: 'acct-runtime-role',
  });
  try {
    const { rows } = await owner.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
      [user],
    );
    // Identifiers cannot be parameterised; quote_ident is PostgreSQL's own escaper,
    // and the password goes through quote_literal for the same reason.
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

    console.log(
      `  ${c.green}ok${c.reset}    ${user} exists, is not a superuser, and is a member of app_runtime`,
    );
    return 0;
  } finally {
    await owner.end();
  }
}

async function main(): Promise<number> {
  const command = process.argv[2] ?? 'status';
  const pool = createPool({
    connectionString: connectionString(),
    max: 4,
    applicationName: 'acct-migrate',
    // Creating 237 tables with their indexes takes longer than a request would.
    statementTimeoutMs: 600_000,
    lockTimeoutMs: 30_000,
  });

  try {
    switch (command) {
      case 'up': {
        const result = await migrate(pool);
        if (result.applied.length === 0) {
          console.log(`${c.green}up to date${c.reset} — no pending migrations`);
        } else {
          for (const m of result.applied) {
            console.log(
              `  ${c.green}applied${c.reset} ${m.name} ${c.dim}${m.durationMs}ms${c.reset}`,
            );
          }
          console.log(`${c.green}${c.bold}${result.applied.length} migration(s) applied${c.reset}`);
        }
        return 0;
      }

      case 'status': {
        const s = await status(pool);
        console.log(`applied: ${s.applied.length}   pending: ${s.pending.length}`);
        for (const p of s.pending) console.log(`  ${c.yellow}pending${c.reset} ${p.name}`);
        for (const m of s.checksumMismatches) {
          console.log(
            `  ${c.red}edited${c.reset}  ${m.name} — applied checksum differs from the file`,
          );
        }
        for (const m of s.missingFiles) {
          console.log(`  ${c.red}missing${c.reset} ${m.name} — applied, but the file is gone`);
        }
        return s.checksumMismatches.length + s.missingFiles.length > 0 ? 1 : 0;
      }

      case 'verify': {
        let failed = 0;
        const s = await status(pool);

        if (s.pending.length > 0) {
          console.error(`  ${c.red}FAIL${c.reset}  ${s.pending.length} migration(s) not applied`);
          failed++;
        } else {
          console.log(
            `  ${c.green}ok${c.reset}    ${s.applied.length} migrations applied, none pending`,
          );
        }

        if (s.checksumMismatches.length > 0) {
          console.error(
            `  ${c.red}FAIL${c.reset}  applied migrations were edited: ` +
              s.checksumMismatches.map((m) => m.name).join(', '),
          );
          failed++;
        } else {
          console.log(`  ${c.green}ok${c.reset}    no applied migration has been edited`);
        }

        const actual = await captureSnapshot(pool);
        const lockPath = snapshotPath();
        if (!existsSync(lockPath)) {
          console.error(
            `  ${c.red}FAIL${c.reset}  ${lockPath} is missing. Run \`pnpm db:migrate:snapshot\` once ` +
              `on a freshly migrated database and commit the result.`,
          );
          failed++;
        } else {
          const expected = JSON.parse(readFileSync(lockPath, 'utf8')) as SchemaSnapshot;
          const drift = compareSnapshots(expected, actual);
          if (drift.matches) {
            console.log(
              `  ${c.green}ok${c.reset}    no structural drift ` +
                `${c.dim}(${Object.entries(actual.counts)
                  .map(([k, v]) => `${v} ${k}`)
                  .join(', ')})${c.reset}`,
            );
          } else {
            console.error(`  ${c.red}FAIL${c.reset}  schema drift detected`);
            for (const a of drift.added.slice(0, 25)) console.error(`          + ${a}`);
            for (const r of drift.removed.slice(0, 25)) console.error(`          - ${r}`);
            const extra = drift.added.length + drift.removed.length - 50;
            if (extra > 0) console.error(`          ... and ${extra} more`);
            failed++;
          }
        }

        failed += await verifySecurityLayers(pool);

        console.log('');
        if (failed > 0) {
          console.error(
            `${c.red}${c.bold}schema verification FAILED${c.reset} (${failed} check(s))`,
          );
          return 1;
        }
        console.log(`${c.green}${c.bold}schema verification passed${c.reset}`);
        return 0;
      }

      case 'runtime-role': {
        const runtime = process.env.APP_DATABASE_URL;
        if (!runtime) {
          console.error('APP_DATABASE_URL is not set. Run `pnpm stack:up`.');
          return 78;
        }
        return ensureRuntimeRole(connectionString(), runtime);
      }

      case 'snapshot': {
        const s = await status(pool);
        if (s.pending.length > 0) {
          console.error(
            `refusing to snapshot: ${s.pending.length} migration(s) pending. Run \`pnpm db:migrate\` first.`,
          );
          return 1;
        }
        const snap = await captureSnapshot(pool);
        writeFileSync(snapshotPath(), `${JSON.stringify(snap, null, 2)}\n`, 'utf8');
        console.log(
          `wrote ${snapshotPath()}\n  ` +
            Object.entries(snap.counts)
              .map(([k, v]) => `${v} ${k}`)
              .join('\n  '),
        );
        return 0;
      }

      case 'guards':
        return runGuardSuite(connectionString());

      default:
        console.error(`unknown command: ${command}. Use up | status | verify | snapshot | guards.`);
        return 1;
    }
  } catch (err) {
    if (err instanceof MigrationError) {
      console.error(`\n${c.red}${c.bold}migration failed${c.reset}\n${err.message}\n`);
      return 1;
    }
    throw err;
  } finally {
    await pool.end();
  }
}

/**
 * Checks the two layers that are easy to write down and easy to leave inert.
 *
 * Both were, before Phase 1. 0006_ledger_guards.sql §3 listed the Gate C privilege
 * revocations as a runbook step nobody had run, and 0024's row-level security had
 * no effect because the application connected as a superuser. Neither failure was
 * visible from the schema: the tables, the policies and the requirement rows all
 * existed and looked correct. So they are checked against the catalog, not against
 * the migration that was supposed to have caused them.
 */
async function verifySecurityLayers(pool: Pool): Promise<number> {
  let failed = 0;

  const { rows: role } = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_runtime'`,
  );
  if (!role[0]) {
    console.error(`  ${c.red}FAIL${c.reset}  the app_runtime role does not exist (migration 0025)`);
    return failed + 1;
  }
  if (role[0].rolsuper || role[0].rolbypassrls) {
    console.error(
      `  ${c.red}FAIL${c.reset}  app_runtime is SUPERUSER or BYPASSRLS; the RLS policies would not apply`,
    );
    failed++;
  }

  // Three separate ways the 0024 policies can be rendered inert, all invisible in
  // the schema itself: the role is a superuser, the role has BYPASSRLS, or the role
  // is a member of the exemption group. The third is checked for every login role,
  // not only for app_runtime, because it is the deployment mistake — granting the
  // application account "the same as the migrator, to fix a permission error".
  //
  // Granted membership, not `pg_has_role`: a superuser is reported as a member of
  // every role, so `pg_has_role` flags the owner and says nothing about the login
  // roles that matter.
  const { rows: exempt } = await pool.query<{ rolname: string; problem: string }>(
    `WITH RECURSIVE m AS (
       SELECT member, roleid FROM pg_auth_members
       UNION
       SELECT m.member, am.roleid FROM m JOIN pg_auth_members am ON am.member = m.roleid
     ),
     granted AS (
       SELECT m.member, g.rolname AS role FROM m JOIN pg_roles g ON g.oid = m.roleid
     )
     SELECT r.rolname,
            CASE WHEN r.rolsuper THEN 'is a SUPERUSER'
                 WHEN r.rolbypassrls THEN 'has BYPASSRLS'
                 ELSE 'is also a member of app_maintenance' END AS problem
       FROM pg_roles r
      WHERE r.rolcanlogin
        AND EXISTS (SELECT 1 FROM granted WHERE member = r.oid AND role = 'app_runtime')
        AND (r.rolsuper OR r.rolbypassrls
             OR EXISTS (SELECT 1 FROM granted WHERE member = r.oid AND role = 'app_maintenance'))`,
  );
  if (exempt.length > 0) {
    for (const r of exempt) {
      console.error(
        `  ${c.red}FAIL${c.reset}  login role "${r.rolname}" runs the application but ${r.problem}; ` +
          'row-level security would not apply to requests',
      );
    }
    failed++;
  } else {
    console.log(
      `  ${c.green}ok${c.reset}    no application login role can bypass row-level security`,
    );
  }

  // Gate C: "Posted journal application role cannot UPDATE/DELETE protected
  // accounting facts." Read from has_table_privilege rather than from the
  // requirements table, so a later GRANT that quietly restores one is caught.
  const { rows: privileges } = await pool.query<{
    id: string;
    statement: string;
    still_held: string | null;
  }>(
    `SELECT r.id, r.statement,
            nullif(concat_ws(', ',
              CASE WHEN has_table_privilege('app_runtime','journal_lines','UPDATE')
                   AND r.id = 'revoke_line_mutation' THEN 'journal_lines.UPDATE' END,
              CASE WHEN has_table_privilege('app_runtime','journal_lines','DELETE')
                   AND r.id = 'revoke_line_mutation' THEN 'journal_lines.DELETE' END,
              CASE WHEN has_table_privilege('app_runtime','journal_entries','DELETE')
                   AND r.id = 'revoke_entry_delete' THEN 'journal_entries.DELETE' END,
              CASE WHEN has_table_privilege('app_runtime','audit_events','UPDATE')
                   AND r.id = 'revoke_audit_mutation' THEN 'audit_events.UPDATE' END,
              CASE WHEN has_table_privilege('app_runtime','audit_events','DELETE')
                   AND r.id = 'revoke_audit_mutation' THEN 'audit_events.DELETE' END
            ), '') AS still_held
       FROM schema_guard_requirements r
      ORDER BY r.id`,
  );
  const restored = privileges.filter((p) => p.still_held);
  if (restored.length > 0) {
    for (const p of restored) {
      console.error(
        `  ${c.red}FAIL${c.reset}  app_runtime still holds ${p.still_held} — "${p.id}" was undone`,
      );
    }
    failed++;
  } else {
    console.log(
      `  ${c.green}ok${c.reset}    ${privileges.length} privilege guards in force on app_runtime (Gate C)`,
    );
  }

  // F-618: the required set lives in `rls_protected_tables`, seeded by the
  // migration that adds each policy. It used to be a six-name array right here,
  // which meant extending the sweep in a migration left this check silently
  // measuring a third of it. Read in both directions — a table registered without
  // a policy is a gap, and a policy on a table nobody registered is a decision
  // that was never written down.
  const { rows: rls } = await pool.query<{
    table_name: string;
    phase: number;
    state: 'ok' | 'missing' | 'unregistered';
  }>(
    `SELECT coalesce(t.table_name, c.relname) AS table_name,
            coalesce(t.phase, -1) AS phase,
            CASE
              WHEN t.table_name IS NULL                              THEN 'unregistered'
              WHEN c.oid IS NULL OR NOT c.relrowsecurity
                                OR NOT c.relforcerowsecurity         THEN 'missing'
              ELSE 'ok'
            END AS state
       FROM rls_protected_tables t
       FULL OUTER JOIN (
         SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
          WHERE c.relkind = 'r' AND c.relrowsecurity
       ) c ON c.relname = t.table_name
      ORDER BY 1`,
  );
  const rlsProblems = rls.filter((r) => r.state !== 'ok');
  if (rlsProblems.length > 0) {
    for (const r of rlsProblems) {
      console.error(
        r.state === 'missing'
          ? `  ${c.red}FAIL${c.reset}  ${r.table_name} is registered for row-level security ` +
              `(phase ${r.phase}) but it is not ENABLED and FORCED`
          : `  ${c.red}FAIL${c.reset}  ${r.table_name} has row-level security but is absent from ` +
              'rls_protected_tables; register it with a rationale or remove the policy',
      );
    }
    failed++;
  } else {
    console.log(
      `  ${c.green}ok${c.reset}    row-level security enabled and forced on ${rls.length} ` +
        'registered tables (ADR-0002)',
    );
  }

  return failed;
}

type Expectation = 'REJECT' | 'ACCEPT' | 'INFORMATIONAL';

interface Scenario {
  readonly label: string | null;
  readonly sql: string;
  readonly expectation: Expectation;
  /**
   * What must do the rejecting — a constraint name or an error code.
   *
   * "Rejected" alone is not a pass. When migration 0022 began seeding the
   * permission registry, T14's own fixture started failing on `permissions_pkey`
   * and the scenario was rejected before it reached the duplicate membership it
   * exists to test. The suite reported green, because it had only ever been asked
   * whether the block was rejected. Declaring the cause in the label closes that.
   */
  readonly via: string | null;
}

/** Splits the guard suite on its `\echo ###` markers so each scenario reports separately. */
function splitScenarios(sql: string): Scenario[] {
  const out: Scenario[] = [];
  let label: string | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    const body = buffer.join('\n').trim();
    // The expectation is declared in the scenario's own label, so the suite and
    // its pass criteria cannot drift apart. T11 reads "first ACCEPT, second
    // REJECT" and runs as one block, so an explicit "expect ACCEPT" wins and
    // anything else mentioning REJECT expects a rejection.
    const expectation: Expectation = !label
      ? 'INFORMATIONAL'
      : /expect ACCEPT/i.test(label)
        ? 'ACCEPT'
        : /REJECT/i.test(label)
          ? 'REJECT'
          : 'INFORMATIONAL';
    const via = label ? (/ via (\S+)\s*$/.exec(label)?.[1] ?? null) : null;
    if (body) out.push({ label, sql: body, expectation, via });
    buffer = [];
  };

  for (const line of sql.split(/\r?\n/)) {
    const marker = /^\\echo\s+'?###\s*(.*?)'?\s*$/.exec(line);
    if (marker) {
      flush();
      label = marker[1] ?? null;
      continue;
    }
    if (line.startsWith('\\')) continue; // other psql meta-commands
    buffer.push(line);
  }
  flush();
  return out;
}

/**
 * Runs the guard suite in a throwaway database.
 *
 * Hermetic on purpose. The suite inserts fixtures with fixed UUIDs, so a second
 * run against the same database fails on duplicate keys — and the earlier version
 * of this command reported "12 rejected, 4 accepted" and exited 0 when the
 * fixtures had silently failed and every scenario was rejected for the wrong
 * reason. That is precisely the false-green the audit exists to prevent, so the
 * suite now (a) runs against a clean database every time and (b) asserts each
 * scenario's declared expectation rather than counting outcomes.
 */
async function runGuardSuite(baseConnectionString: string): Promise<number> {
  const file = join(migrationsDirectory(repositoryRoot()), 'tests', '0006_guards_test.sql');
  const sql = readFileSync(file, 'utf8');
  const scenarios = splitScenarios(sql);

  const url = new URL(baseConnectionString);
  const scratchName = `acct_guards_${Date.now().toString(36)}`;
  const adminUrl = new URL(url.toString());
  adminUrl.pathname = '/postgres';
  const scratchUrl = new URL(url.toString());
  scratchUrl.pathname = `/${scratchName}`;

  const admin = createPool({
    connectionString: adminUrl.toString(),
    max: 1,
    applicationName: 'acct-guards',
  });
  try {
    await admin.query(`CREATE DATABASE ${scratchName}`);
  } catch (err) {
    console.error(
      `could not create the scratch database ${scratchName}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    await admin.end();
    return 1;
  }

  const scratch = createPool({
    connectionString: scratchUrl.toString(),
    max: 2,
    applicationName: 'acct-guards',
    statementTimeoutMs: 600_000,
  });

  let failures = 0;
  try {
    await migrate(scratch);

    const client = await scratch.connect();
    try {
      for (const scenario of scenarios) {
        let rejected = false;
        let message = '';
        try {
          await client.query(scenario.sql);
        } catch (err) {
          rejected = true;
          message = (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '';
          await client.query('ROLLBACK').catch(() => undefined);
        }

        if (!scenario.label) {
          // The fixture block. Everything downstream is meaningless without it,
          // so a failure here stops the run rather than producing 14 misleading
          // rejections.
          if (rejected) {
            console.error(`${c.red}FAIL${c.reset}  guard fixture failed: ${message}`);
            return 1;
          }
          console.log(`${c.dim}fixture loaded${c.reset}`);
          continue;
        }

        console.log(`${c.bold}${scenario.label}${c.reset}`);
        if (rejected) console.log(`    ${c.yellow}>> REJECTED${c.reset} ${message}`);

        if (scenario.expectation === 'REJECT' && !rejected) {
          failures++;
          console.error(
            `    ${c.red}>> FAIL${c.reset} expected a rejection; the statement was accepted`,
          );
        } else if (scenario.expectation === 'REJECT' && !scenario.via) {
          failures++;
          console.error(
            `    ${c.red}>> FAIL${c.reset} the label does not declare what should reject it. ` +
              `Append "via <constraint-or-error-code>" so a rejection for an unrelated reason ` +
              `cannot pass.`,
          );
        } else if (scenario.expectation === 'REJECT' && !message.includes(scenario.via ?? '')) {
          failures++;
          console.error(
            `    ${c.red}>> FAIL${c.reset} rejected, but not by ${scenario.via} — this scenario ` +
              `never reached what it tests`,
          );
        } else if (scenario.expectation === 'ACCEPT' && rejected) {
          failures++;
          console.error(
            `    ${c.red}>> FAIL${c.reset} expected acceptance; the statement was rejected`,
          );
        }
      }
    } finally {
      client.release();
    }
  } finally {
    await scratch.end();
    await admin.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }

  const asserted = scenarios.filter((s) => s.label && s.expectation !== 'INFORMATIONAL').length;
  console.log('');
  if (failures > 0) {
    console.error(
      `${c.red}${c.bold}guard suite FAILED${c.reset}: ${failures} of ${asserted} scenarios`,
    );
    return 1;
  }
  console.log(
    `${c.green}${c.bold}guard suite passed${c.reset}: ${asserted} scenarios behaved as declared`,
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
