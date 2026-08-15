import { loadDotenv } from '@acct/config';
import { createPool, migrate, status } from '@acct/database';

/**
 * Brings the test database to a state these tests can be run against — and then
 * ASSERTS that state rather than assuming it.
 *
 * The assertion half matters more than the migration half. Every test in this
 * package is about a control that lives partly in the schema: the approval
 * tables and their tenant columns (0017, 0050), the maker/checker CHECK and the
 * deferred approval-threshold trigger (0049). If any of those were missing, the
 * suite would still run — and every test would pass for the wrong reason, because
 * the writes it makes would simply succeed. A setup that reports success about
 * something it never measured is exactly the failure this codebase keeps finding.
 */
const REQUIRED_TABLES = [
  'approval_workflows',
  'approval_requests',
  'approval_steps',
  'segregation_rules',
  'delegations',
  'escalation_rules',
  'tasks',
];

export async function setup(): Promise<void> {
  loadDotenv();
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Run `pnpm stack:up` (it starts a disposable test database ' +
        'on its own port so the suite never touches your working data).',
    );
  }

  const pool = createPool({
    connectionString: url,
    max: 4,
    applicationName: 'acct-approvals-test-setup',
    statementTimeoutMs: 600_000,
    lockTimeoutMs: 30_000,
  });

  try {
    const { rows: present } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [REQUIRED_TABLES],
    );
    // Only migrate a database that has never seen 0017 at all. Applying whatever
    // is pending would run migrations other work in flight is still writing,
    // which is a much bigger side effect than a test setup is entitled to.
    if (present.length === 0) {
      const before = await status(pool);
      if (before.pending.length > 0) {
        const result = await migrate(pool);
        console.log(`[approvals-test-setup] applied ${result.applied.length} migration(s)`);
      }
    }

    const missing = REQUIRED_TABLES.filter((t) => !present.some((p) => p.table_name === t));
    const problems: string[] = [];
    if (missing.length > 0 && present.length > 0) {
      problems.push(`missing table(s): ${missing.join(', ')}`);
    }

    const { rows: tenantColumn } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'approval_steps'
          AND column_name = 'tenant_id' AND is_nullable = 'NO'`,
    );
    if (tenantColumn[0]?.n === '0') {
      problems.push('approval_steps has no NOT NULL tenant_id (migration 0050 not applied)');
    }

    const { rows: makerChecker } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_constraint
        WHERE conname = 'je_maker_checker' AND conrelid = 'journal_entries'::regclass`,
    );
    if (makerChecker[0]?.n === '0') {
      problems.push('je_maker_checker is absent (migration 0049 not applied)');
    }

    const { rows: threshold } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_trigger t
        WHERE t.tgrelid = 'journal_entries'::regclass AND NOT t.tgisinternal
          AND t.tgfoid = to_regproc('assert_journal_approval')
          AND t.tgdeferrable AND t.tginitdeferred`,
    );
    if (threshold[0]?.n === '0') {
      problems.push(
        'the deferred journal approval-threshold trigger is absent (migration 0049 not applied)',
      );
    }

    if (problems.length > 0) {
      throw new Error(
        `The test database is not in a state these tests can measure anything against: ` +
          `${problems.join('; ')}. Run \`pnpm db:migrate\`.`,
      );
    }
  } finally {
    await pool.end();
  }
}
