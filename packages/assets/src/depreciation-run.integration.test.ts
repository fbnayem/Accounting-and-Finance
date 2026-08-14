import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AppError, D, uuidv7, type Grant, type TenantPrincipal } from '@acct/domain';
import { createPool, migrate } from '@acct/database';
import { LedgerProjectionService, PostingService } from '@acct/ledger';
import { DocumentPostingService, TaxService } from '@acct/subledger';
import { AssetCapitalizationService } from './capitalization.service';
import { DepreciationRunService } from './depreciation.service';

/**
 * Phase 5 exit criterion 5 against a real database, both halves.
 *
 *   (a) A rerun over an asset book that already posted for the period posts
 *       NOTHING again: no second journal, no second charge, and the caller gets
 *       the run that did the work rather than an error.
 *   (b) An asset capitalized AFTER that run — a late vendor bill, an in-service
 *       date inside the month just closed — still reaches a POSTED run of its
 *       own, in the SAME period, with its own journal.
 *
 * Both, because either alone is satisfiable by a service that is wrong. A
 * service that refused every second run would pass (a) perfectly and fail the
 * criterion, which is exactly what 0013's depreciation_runs_posted_uq forced
 * and what 0046 removes.
 *
 * Against PostgreSQL rather than a mock: what is being asserted is that two
 * runs produce two journals and one charge per asset book, and every one of
 * those facts is a row.
 */
const url = testDatabaseUrl();

interface RunResult {
  readonly id: string;
  readonly status: string;
  readonly total_amount: string;
  readonly journal_entry_id: string | null;
  readonly version: number;
  readonly lines_posted: number;
  readonly replayed: boolean;
}

/** The entity, its chart, its calendar and one asset category, all disposable. */
interface Fixture {
  tenantId: string;
  userId: string;
  legalEntityId: string;
  bookId: string;
  periodJan: string;
  categoryId: string;
  clearingAccountId: string;
  principal: TenantPrincipal;
}

describe.skipIf(!url)('the depreciation run, against a real database', () => {
  let pool: Pool;
  let fixture: Fixture;
  let capitalization: AssetCapitalizationService;
  let depreciation: DepreciationRunService;

  beforeAll(async () => {
    pool = createPool({
      connectionString: url!,
      max: 4,
      applicationName: 'acct-assets-test',
      statementTimeoutMs: 60_000,
    });
    // Idempotent: applies only what is pending. Called here rather than assumed
    // so this file is runnable against a clean database on its own, and so a
    // stale test database fails as "migration applied" rather than as a
    // mystifying assertion about an index that is still there.
    await migrate(pool);

    fixture = await createFixture(pool);
    const posting = new PostingService(new LedgerProjectionService());
    const documents = new DocumentPostingService(posting, new TaxService(pool));
    capitalization = new AssetCapitalizationService(pool, posting, documents);
    depreciation = new DepreciationRunService(pool, posting, documents);
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
  });

  it('posts, reruns to nothing, absorbs a late asset, and reruns to nothing again', async () => {
    // ---- the month-end run -------------------------------------------------
    const early = await createAsset(pool, fixture, { number: 'FA-EARLY', cost: '1200.00' });
    await capitalization.capitalizeAsset(fixture.principal, early, {
      postingDate: '2026-01-15',
      creditAccountId: fixture.clearingAccountId,
      inServiceDate: '2026-01-01',
    });

    const first = (await depreciation.createDepreciationRun(fixture.principal, {
      accountingBookId: fixture.bookId,
      accountingPeriodId: fixture.periodJan,
    })) as unknown as RunResult;

    expect(first.status).toBe('POSTED');
    expect(first.replayed).toBe(false);
    expect(first.lines_posted).toBe(1);
    expect(D(first.total_amount).equals(D('100'))).toBe(true);
    expect(await depreciationJournalCount(pool, fixture)).toBe(1);

    // ---- (a) the rerun -----------------------------------------------------
    // Same book, same period, immediately again. The one thing that must not
    // happen is a second journal; the second thing is an error, because a
    // month-end job that is retried has to be boring.
    const rerun = (await depreciation.createDepreciationRun(fixture.principal, {
      accountingBookId: fixture.bookId,
      accountingPeriodId: fixture.periodJan,
    })) as unknown as RunResult;

    expect(rerun.replayed).toBe(true);
    expect(rerun.lines_posted).toBe(0);
    expect(rerun.id).toBe(first.id);
    expect(rerun.journal_entry_id).toBe(first.journal_entry_id);
    expect(await depreciationJournalCount(pool, fixture)).toBe(1);
    expect(await postedRunCount(pool, fixture)).toBe(1);
    // The charge itself, not just the absence of a journal: an asset book that
    // was charged twice would show 200 here even if the second run had somehow
    // reused the first journal.
    expect(await accumulatedDepreciation(pool, early)).toEqual(['100.00000000']);

    // ---- (b) the asset that arrived after the run --------------------------
    // Capitalized on 3 February with an in-service date of 1 January: the
    // invoice was late, the machine was not. Its January schedule line is
    // SCHEDULED in a period whose depreciation has already been posted.
    const late = await createAsset(pool, fixture, { number: 'FA-LATE', cost: '600.00' });
    await capitalization.capitalizeAsset(fixture.principal, late, {
      postingDate: '2026-02-03',
      creditAccountId: fixture.clearingAccountId,
      inServiceDate: '2026-01-01',
    });

    const incremental = (await depreciation.createDepreciationRun(fixture.principal, {
      accountingBookId: fixture.bookId,
      accountingPeriodId: fixture.periodJan,
    })) as unknown as RunResult;

    expect(incremental.status).toBe('POSTED');
    expect(incremental.replayed).toBe(false);
    expect(incremental.lines_posted).toBe(1);
    expect(D(incremental.total_amount).equals(D('50'))).toBe(true);
    // Its own run and its own journal. Replaying the month-end entry would put
    // the charge for an asset into a journal written before the asset existed.
    expect(incremental.id).not.toBe(first.id);
    expect(incremental.journal_entry_id).not.toBe(first.journal_entry_id);
    expect(await depreciationJournalCount(pool, fixture)).toBe(2);
    expect(await postedRunCount(pool, fixture)).toBe(2);

    // The early asset was NOT touched by the incremental run: one charge each.
    expect(await accumulatedDepreciation(pool, early)).toEqual(['100.00000000']);
    expect(await accumulatedDepreciation(pool, late)).toEqual(['50.00000000']);

    // ---- (a) again, now that the period holds two runs ---------------------
    const rerunAgain = (await depreciation.createDepreciationRun(fixture.principal, {
      accountingBookId: fixture.bookId,
      accountingPeriodId: fixture.periodJan,
    })) as unknown as RunResult;

    expect(rerunAgain.replayed).toBe(true);
    expect(rerunAgain.lines_posted).toBe(0);
    // The most recent run, deterministically — not whichever row the planner
    // returned first.
    expect(rerunAgain.id).toBe(incremental.id);
    expect(await depreciationJournalCount(pool, fixture)).toBe(2);
    expect(await postedRunCount(pool, fixture)).toBe(2);

    // Every January line for this book is POSTED exactly once, each against the
    // journal of the run that posted it.
    const { rows: lines } = await pool.query<{ status: string; journal_entry_id: string }>(
      `SELECT l.status::text AS status, l.journal_entry_id
         FROM depreciation_schedule_lines l
         JOIN asset_books b ON b.id = l.asset_book_id
        WHERE l.accounting_period_id = $1 AND b.accounting_book_id = $2
        ORDER BY l.id`,
      [fixture.periodJan, fixture.bookId],
    );
    expect(lines.map((l) => l.status)).toEqual(['POSTED', 'POSTED']);
    expect(new Set(lines.map((l) => l.journal_entry_id)).size).toBe(2);
  }, 120_000);

  it('refuses a run that would charge an asset book already POSTED for the period', async () => {
    // The refusal that replaces the dropped run-level key, exercised by taking
    // away the control it stands on.
    //
    // `UNIQUE (asset_book_id, accounting_period_id)` makes "a SCHEDULED line
    // beside a POSTED one for the same asset book and period" impossible, so
    // the service's check for it cannot fire while that UNIQUE is in place —
    // which is exactly why it is worth proving it fires when the UNIQUE is not.
    // 0046 dropped depreciation_runs_posted_uq on the strength of this
    // constraint; if it ever disappears, the second charge must be refused by
    // name and not posted.
    const asset = await createAsset(pool, fixture, { number: 'FA-DOUBLE', cost: '1200.00' });
    await capitalization.capitalizeAsset(fixture.principal, asset, {
      postingDate: '2026-01-20',
      creditAccountId: fixture.clearingAccountId,
      inServiceDate: '2026-01-01',
    });
    const posted = (await depreciation.createDepreciationRun(fixture.principal, {
      accountingBookId: fixture.bookId,
      accountingPeriodId: fixture.periodJan,
    })) as unknown as RunResult;
    expect(posted.lines_posted).toBe(1);

    const { rows: books } = await pool.query<{ id: string }>(
      `SELECT id FROM asset_books WHERE fixed_asset_id = $1`,
      [asset],
    );
    const assetBookId = books[0]!.id;
    const journalsBefore = await depreciationJournalCount(pool, fixture);

    const constraint = 'depreciation_schedule_lines_asset_book_id_accounting_period_key';
    let injected: string | undefined;
    try {
      await pool.query(`ALTER TABLE depreciation_schedule_lines DROP CONSTRAINT ${constraint}`);
      injected = uuidv7();
      await pool.query(
        `INSERT INTO depreciation_schedule_lines
           (id, tenant_id, asset_book_id, legal_entity_id, accounting_period_id, revision,
            scheduled_amount, status)
         VALUES ($1,$2,$3,$4,$5,2,$6,'SCHEDULED')`,
        [injected, fixture.tenantId, assetBookId, fixture.legalEntityId, fixture.periodJan, '100'],
      );

      await expect(
        depreciation.createDepreciationRun(fixture.principal, {
          accountingBookId: fixture.bookId,
          accountingPeriodId: fixture.periodJan,
        }),
      ).rejects.toMatchObject({ code: 'POSTED_IMMUTABLE' });

      // AppError.details is log-only, so the refusal has to be actionable from
      // the message alone (the envelope carries code and message and nothing
      // else). It names the book that already depreciated and the remedy.
      const error = await depreciation
        .createDepreciationRun(fixture.principal, {
          accountingBookId: fixture.bookId,
          accountingPeriodId: fixture.periodJan,
        })
        .catch((err: unknown) => err as AppError);
      expect(error.message).toContain(assetBookId);
      expect(error.message).toContain('at most once per period');

      // Refused, not posted: no journal, no run, no second charge.
      expect(await depreciationJournalCount(pool, fixture)).toBe(journalsBefore);
      expect(await accumulatedDepreciation(pool, asset)).toEqual(['100.00000000']);
    } finally {
      if (injected) {
        await pool.query(`DELETE FROM depreciation_schedule_lines WHERE id = $1`, [injected]);
      }
      await pool.query(
        `ALTER TABLE depreciation_schedule_lines
           ADD CONSTRAINT ${constraint} UNIQUE (asset_book_id, accounting_period_id)`,
      );
    }

    // The control is back, and this test has not left the database weaker than
    // it found it.
    const { rows: restored } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_constraint WHERE conname = $1`,
      [constraint],
    );
    expect(restored[0]!.n).toBe('1');
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * The test database, from the environment or from the repository's `.env`.
 *
 * `loadDotenv` in @acct/config is the real implementation and this file cannot
 * reach it: @acct/assets does not depend on @acct/config, and adding the
 * dependency is a package.json change outside this task's scope (it is in the
 * integration notes). So: test-only, one lookup, no export, no interpolation,
 * and it stops as soon as the environment already answers.
 */
function testDatabaseUrl(): string | undefined {
  const fromEnv = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (fromEnv) return fromEnv;

  let dir = resolve(process.cwd());
  for (let depth = 0; depth < 4; depth++) {
    const file = join(dir, '.env');
    if (existsSync(file)) {
      const found: Record<string, string> = {};
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const match = /^\s*(TEST_DATABASE_URL|DATABASE_URL)\s*=\s*(.*?)\s*$/.exec(line);
        if (match) found[match[1]!] = match[2]!.replace(/^["']|["']$/g, '');
      }
      return found.TEST_DATABASE_URL ?? found.DATABASE_URL;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const PERMISSIONS = ['asset.capitalize', 'asset.depreciate', 'asset.view'] as const;

async function createFixture(pool: Pool): Promise<Fixture> {
  const tenantId = uuidv7();
  const userId = uuidv7();
  const organizationId = uuidv7();
  const legalEntityId = uuidv7();
  const bookId = uuidv7();
  const fiscalYearId = uuidv7();
  const categoryId = uuidv7();
  const slug = `assets-${tenantId}`;

  await pool.query(`INSERT INTO tenants (id, name, slug) VALUES ($1,$2,$3)`, [
    tenantId,
    slug,
    slug,
  ]);
  await pool.query(`INSERT INTO users (id, email, display_name) VALUES ($1,$2,$3)`, [
    userId,
    `${userId}@example.test`,
    'assets test',
  ]);
  await pool.query(`INSERT INTO organizations (id, tenant_id, name) VALUES ($1,$2,$3)`, [
    organizationId,
    tenantId,
    'Assets Org',
  ]);
  // posting_enabled defaults false (doc 02: posting stays disabled until setup
  // validation passes). Activation is a route, not something this fixture
  // should reimplement, so the flag is set directly and named here rather than
  // discovered as "Posting is disabled for this legal entity".
  await pool.query(
    `INSERT INTO legal_entities
       (id, tenant_id, organization_id, code, legal_name, country_code, functional_currency,
        timezone, activated_at, posting_enabled)
     VALUES ($1,$2,$3,'AST','Assets Entity','US','USD','UTC',now(),true)`,
    [legalEntityId, tenantId, organizationId],
  );
  await pool.query(
    `INSERT INTO accounting_books
       (id, tenant_id, legal_entity_id, code, name, base_currency, is_primary)
     VALUES ($1,$2,$3,'PRI','Primary','USD',true)`,
    [bookId, tenantId, legalEntityId],
  );
  await pool.query(
    `INSERT INTO fiscal_years (id, tenant_id, legal_entity_id, name, start_date, end_date)
     VALUES ($1,$2,$3,'FY26','2026-01-01','2026-12-31')`,
    [fiscalYearId, tenantId, legalEntityId],
  );

  // Twelve months, because a twelve-month schedule must find a period for every
  // one of them — capitalization refuses a schedule with a hole in it.
  const periods: string[] = [];
  for (let month = 1; month <= 12; month++) {
    const id = uuidv7();
    periods.push(id);
    const start = `2026-${String(month).padStart(2, '0')}-01`;
    await pool.query(
      `INSERT INTO accounting_periods
         (id, tenant_id, legal_entity_id, fiscal_year_id, period_no, name, start_date, end_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7::date,($7::date + interval '1 month - 1 day')::date)`,
      [id, tenantId, legalEntityId, fiscalYearId, month, `M${month}-26`, start],
    );
  }

  const accounts = {
    asset: uuidv7(),
    accumulated: uuidv7(),
    expense: uuidv7(),
    clearing: uuidv7(),
  };
  const chart: Array<[string, string, string, string, string]> = [
    [accounts.asset, '1500', 'Machinery', 'ASSET', 'DEBIT'],
    [accounts.accumulated, '1590', 'Accumulated depreciation', 'ASSET', 'CREDIT'],
    [accounts.expense, '6100', 'Depreciation expense', 'EXPENSE', 'DEBIT'],
    [accounts.clearing, '2100', 'Asset clearing', 'LIABILITY', 'CREDIT'],
  ];
  for (const [id, code, name, type, normal] of chart) {
    await pool.query(
      `INSERT INTO accounts
         (id, tenant_id, legal_entity_id, code, name, account_type, normal_balance)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, tenantId, legalEntityId, code, name, type, normal],
    );
  }

  await pool.query(
    `INSERT INTO asset_categories
       (id, tenant_id, legal_entity_id, code, name, asset_account_id,
        accumulated_depreciation_account_id, depreciation_expense_account_id)
     VALUES ($1,$2,$3,'MACH','Machinery',$4,$5,$6)`,
    [categoryId, tenantId, legalEntityId, accounts.asset, accounts.accumulated, accounts.expense],
  );

  const grant: Grant = {
    membershipId: uuidv7(),
    roleId: uuidv7(),
    roleCode: 'ASSET_ACCOUNTANT',
    organizationId,
    legalEntityId,
    branchId: null,
    permissions: new Set<string>(PERMISSIONS),
  };

  return {
    tenantId,
    userId,
    legalEntityId,
    bookId,
    periodJan: periods[0]!,
    categoryId,
    clearingAccountId: accounts.clearing,
    principal: {
      userId,
      sessionId: uuidv7(),
      email: `${userId}@example.test`,
      displayName: 'assets test',
      tenantId,
      grants: [grant],
      mfaSatisfied: true,
      mfaVerifiedAt: new Date(),
      impersonatedBy: null,
    },
  };
}

/** A DRAFT asset with one book on the primary accounting book, ready to capitalize. */
async function createAsset(
  pool: Pool,
  fixture: Fixture,
  input: { number: string; cost: string },
): Promise<string> {
  const assetId = uuidv7();
  await pool.query(
    `INSERT INTO fixed_assets
       (id, tenant_id, legal_entity_id, asset_category_id, asset_number, name, currency,
        acquisition_source, acquisition_date, acquisition_cost, status)
     VALUES ($1,$2,$3,$4,$5,$6,'USD','PURCHASE','2026-01-01',$7,'DRAFT')`,
    [
      assetId,
      fixture.tenantId,
      fixture.legalEntityId,
      fixture.categoryId,
      input.number,
      input.number,
      input.cost,
    ],
  );
  await pool.query(
    `INSERT INTO asset_books
       (id, tenant_id, fixed_asset_id, accounting_book_id, legal_entity_id, method, proration,
        useful_life_months, depreciation_start_date, cost_basis)
     VALUES ($1,$2,$3,$4,$5,'STRAIGHT_LINE','MONTHLY',12,'2026-01-01',$6)`,
    [uuidv7(), fixture.tenantId, assetId, fixture.bookId, fixture.legalEntityId, input.cost],
  );
  return assetId;
}

/** Journals produced by depreciation runs in this book, which is the count that matters. */
async function depreciationJournalCount(pool: Pool, fixture: Fixture): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM journal_entries
      WHERE accounting_book_id = $1 AND source_type = 'depreciation_run'`,
    [fixture.bookId],
  );
  return Number(rows[0]!.n);
}

async function postedRunCount(pool: Pool, fixture: Fixture): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM depreciation_runs
      WHERE accounting_book_id = $1 AND accounting_period_id = $2 AND status = 'POSTED'`,
    [fixture.bookId, fixture.periodJan],
  );
  return Number(rows[0]!.n);
}

/** Compared as stored text — an exact decimal never becomes a JavaScript number. */
async function accumulatedDepreciation(pool: Pool, fixedAssetId: string): Promise<string[]> {
  const { rows } = await pool.query<{ accumulated: string }>(
    `SELECT accumulated_depreciation::text AS accumulated
       FROM asset_books WHERE fixed_asset_id = $1 ORDER BY id`,
    [fixedAssetId],
  );
  return rows.map((r) => r.accumulated);
}
