import { PoolClient } from 'pg';
import {
  BOOTSTRAP_CURRENCIES,
  accountingDate,
  addMonths,
  addDays,
  type AccountingDate,
} from '@acct/domain';
import { DeterministicRandom } from '../random';
import { SeedProfile } from '../profiles';
import { ACCOUNT_GROUPS, CHART_OF_ACCOUNTS } from './chart-of-accounts';

/**
 * Seeds everything the ledger depends on: currencies, a tenant, an organization,
 * legal entities with branches, an accounting policy, fiscal years and periods, a
 * primary book, journals and a chart of accounts.
 *
 * The order here is the dependency order the ADR-0002 composite foreign keys
 * impose. It cannot be rearranged, which is the point: the schema will not let a
 * child exist before the parent that scopes it.
 */

export interface SeededEntity {
  readonly id: string;
  readonly code: string;
  readonly bookId: string;
  readonly branchId: string;
  readonly generalJournalId: string;
  readonly baseCurrency: string;
  /** account code -> id, for the ledger seeder. */
  readonly accounts: ReadonlyMap<string, string>;
  /** period id and posting-date window, in order. */
  readonly periods: ReadonlyArray<{ id: string; from: AccountingDate; to: AccountingDate }>;
}

export interface Foundation {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly entities: readonly SeededEntity[];
  /**
   * Journal lines already in this tenant — set only when resuming (F-812).
   *
   * Printed by the seeder so the tenant a `--only` run chose is visible in its
   * output. The whole failure this guards against was invisible because every
   * number the resumed run printed was about rows it had just written.
   */
  readonly ledgerLines?: number;
}

export async function seedCurrencies(client: PoolClient): Promise<void> {
  // ADR-0006 §2 reference data. Seeded idempotently: currencies are global and a
  // reseed must not disturb a minor_unit that transactions already depend on.
  for (const c of BOOTSTRAP_CURRENCIES) {
    await client.query(
      `INSERT INTO currencies (code, name, minor_unit, cash_rounding_increment, symbol)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (code) DO NOTHING`,
      [c.code, c.code, c.minorUnit, c.cashRoundingIncrement?.toString() ?? null, null],
    );
  }
}

/**
 * Reads back the foundation a previous run wrote, for `--only`.
 *
 * Neither this seeder nor the ledger seeder is idempotent — both mint fixed ids
 * from a fixed stream, so a second run collides on the primary key. That was
 * invisible while the seed was one all-or-nothing operation, and became a problem
 * the moment Phase 3 added a stage: the only way to seed the new stage was to
 * destroy the volumes and regenerate everything, which is a heavy price for
 * adding 4,000 rows. This reads what is already there instead.
 *
 * **The tenant with the largest ledger wins, not the most recent one (F-812).**
 * Recency was the original rule and it is wrong in the one case that matters: a
 * database can hold more than one seeded tenant — a full seed that failed after
 * the foundation commit leaves a complete chart of accounts and no ledger behind
 * it — and `resolveBenchScope` chooses the entity with the most journal lines.
 * When the two rules disagree, `--only` seeds a stage onto an entity the
 * benchmark never looks at, and every symptom of that is a silent zero: the
 * stage reports the rows it wrote, the benchmark reports a very fast query, and
 * nothing connects them. Measured here: 5,000 bank transactions written to a
 * husk tenant created six days after the one holding all 20,000 journal lines
 * and 2,000 invoices. Choosing by ledger size makes the seeder and the benchmark
 * agree by construction.
 *
 * `accounts` comes back empty: only the ledger seeder needs it, and the ledger
 * stage cannot be resumed anyway.
 */
export async function loadFoundation(client: PoolClient): Promise<Foundation> {
  const { rows: roots } = await client.query<{
    tenant_id: string;
    organization_id: string;
    user_id: string;
    lines: string;
  }>(
    `SELECT o.tenant_id, o.id AS organization_id,
            (SELECT id FROM users WHERE email LIKE 'seed-%@example.test'
              ORDER BY created_at DESC LIMIT 1) AS user_id,
            (SELECT count(*) FROM journal_lines l WHERE l.tenant_id = t.id)::text AS lines
       FROM organizations o
       JOIN tenants t ON t.id = o.tenant_id
      WHERE t.slug LIKE 'seed-%'
      -- Ledger size first, recency only to break a tie. The benchmark's scope
      -- resolver ranks by exactly this, and the two must not diverge.
      ORDER BY (SELECT count(*) FROM journal_lines l WHERE l.tenant_id = t.id) DESC,
               t.created_at DESC
      LIMIT 1`,
  );
  const root = roots[0];
  if (!root) throw new Error('no seeded tenant found — run a full `pnpm db:seed` first');
  if (Number(root.lines) === 0) {
    // Not a warning. Every stage that resumes onto an empty ledger produces rows
    // no workload will ever read, and reports success while doing it.
    throw new Error(
      'the seeded tenants all have an empty ledger — run a full `pnpm db:seed` before resuming a stage',
    );
  }

  const { rows: entityRows } = await client.query<{
    id: string;
    code: string;
    book_id: string;
    branch_id: string;
    journal_id: string;
    base_currency: string;
  }>(
    // DISTINCT ON, because an entity has one primary book but several branches and
    // several journals: a plain join returns one row per combination and the
    // caller would seed the same entity once per journal it happens to own.
    `SELECT DISTINCT ON (le.id)
            le.id, le.code, b.id AS book_id, br.id AS branch_id, j.id AS journal_id,
            b.base_currency
       FROM legal_entities le
       JOIN accounting_books b ON b.legal_entity_id = le.id AND b.is_primary
       JOIN branches br        ON br.legal_entity_id = le.id
       JOIN journals j         ON j.legal_entity_id = le.id
      WHERE le.tenant_id = $1
      ORDER BY le.id, br.code, j.code`,
    [root.tenant_id],
  );

  const entities: SeededEntity[] = [];
  for (const e of entityRows) {
    const { rows: periods } = await client.query<{ id: string; from: string; to: string }>(
      `SELECT p.id, p.start_date::text AS from, p.end_date::text AS to
         FROM accounting_periods p
         JOIN fiscal_years fy ON fy.id = p.fiscal_year_id
        WHERE fy.legal_entity_id = $1 AND NOT p.is_adjustment
        ORDER BY p.start_date`,
      [e.id],
    );
    entities.push({
      id: e.id,
      code: e.code,
      bookId: e.book_id,
      branchId: e.branch_id,
      generalJournalId: e.journal_id,
      baseCurrency: e.base_currency,
      accounts: new Map(),
      // Through `accountingDate` rather than cast: the brand exists so a date that
      // came out of a database is validated on the way in, exactly like one that
      // came from a request.
      periods: periods.map((p) => ({
        id: p.id,
        from: accountingDate(p.from),
        to: accountingDate(p.to),
      })),
    });
  }

  return {
    tenantId: root.tenant_id,
    organizationId: root.organization_id,
    userId: root.user_id,
    entities,
    ledgerLines: Number(root.lines),
  };
}

export async function seedFoundation(
  client: PoolClient,
  profile: SeedProfile,
  rng: DeterministicRandom,
): Promise<Foundation> {
  await seedCurrencies(client);

  const suffix = profile.name;
  const { rows: tenantRows } = await client.query<{ id: string }>(
    `INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id`,
    [`Seed ${suffix}`, `seed-${suffix}-${Date.now().toString(36)}`],
  );
  const tenantId = tenantRows[0]!.id;

  const { rows: userRows } = await client.query<{ id: string }>(
    `INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id`,
    [`seed-${suffix}-${Date.now().toString(36)}@example.test`, 'Seed User'],
  );
  const userId = userRows[0]!.id;

  const { rows: orgRows } = await client.query<{ id: string }>(
    `INSERT INTO organizations (tenant_id, name) VALUES ($1, $2) RETURNING id`,
    [tenantId, `Seed Organization (${suffix})`],
  );
  const organizationId = orgRows[0]!.id;

  const entities: SeededEntity[] = [];

  for (let e = 0; e < profile.legalEntities; e++) {
    const code = `E${String(e + 1).padStart(2, '0')}`;
    const baseCurrency = 'USD';

    const { rows: entityRows } = await client.query<{ id: string }>(
      `INSERT INTO legal_entities
         (tenant_id, organization_id, code, legal_name, country_code, functional_currency,
          timezone, activated_at, posting_enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now(), true)
       RETURNING id`,
      [tenantId, organizationId, code, `Seed Entity ${code}`, 'US', baseCurrency, 'UTC'],
    );
    const legalEntityId = entityRows[0]!.id;

    const { rows: branchRows } = await client.query<{ id: string }>(
      `INSERT INTO branches (tenant_id, legal_entity_id, code, name, country_code)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [tenantId, legalEntityId, 'HQ', 'Head office', 'US'],
    );
    const branchId = branchRows[0]!.id;

    const { rows: bookRows } = await client.query<{ id: string }>(
      `INSERT INTO accounting_books
         (tenant_id, legal_entity_id, code, name, base_currency, kind, is_primary)
       VALUES ($1,$2,'PRIMARY','Primary book',$3,'PRIMARY',true)
       RETURNING id`,
      [tenantId, legalEntityId, baseCurrency],
    );
    const bookId = bookRows[0]!.id;

    // --- chart of accounts -------------------------------------------------
    const groupIds = new Map<string, string>();
    for (const g of ACCOUNT_GROUPS) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO account_groups (tenant_id, legal_entity_id, code, name, sort_order)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [tenantId, legalEntityId, g.code, g.name, g.sortOrder],
      );
      groupIds.set(g.code, rows[0]!.id);
    }

    const accounts = new Map<string, string>();
    for (const a of CHART_OF_ACCOUNTS) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO accounts
           (tenant_id, legal_entity_id, group_id, code, name, account_type, normal_balance,
            is_control, is_system, cash_flow_classification)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id`,
        [
          tenantId,
          legalEntityId,
          groupIds.get(a.group) ?? null,
          a.code,
          a.name,
          a.type,
          a.normalBalance,
          a.isControl ?? false,
          a.isSystem ?? false,
          a.cashFlow ?? null,
        ],
      );
      accounts.set(a.code, rows[0]!.id);
    }

    // --- accounting policy --------------------------------------------------
    // ADR-0001 §2: both retained-earnings methods exist and the tenant chooses.
    // The seed alternates so both paths have coverage from the first fixture —
    // the audit's point was that only one of them was ever specified.
    const retainedEarningsMethod = e % 2 === 0 ? 'DERIVED' : 'CLOSING_JOURNAL';
    const policyColumns = CHART_OF_ACCOUNTS.filter((a) => a.policyRole);
    const columnNames = policyColumns.map((a) => a.policyRole as string);
    const columnValues = policyColumns.map((a) => accounts.get(a.code) ?? null);

    await client.query(
      `INSERT INTO accounting_policies
         (tenant_id, legal_entity_id, accounting_book_id, version, valid_from,
          retained_earnings_method, rounding_mode ${columnNames.length ? ', ' + columnNames.join(', ') : ''})
       VALUES ($1,$2,$3,1,$4,$5,'HALF_UP'
         ${columnNames.map((_, i) => `, $${i + 6}`).join('')})`,
      [
        tenantId,
        legalEntityId,
        bookId,
        profile.firstFiscalYearStart,
        retainedEarningsMethod,
        ...columnValues,
      ],
    );

    // --- fiscal years and periods ------------------------------------------
    const periods: Array<{ id: string; from: AccountingDate; to: AccountingDate }> = [];
    let yearStart = accountingDate(profile.firstFiscalYearStart);

    for (let y = 0; y < profile.fiscalYears; y++) {
      const yearEnd = addDays(addMonths(yearStart, 12), -1);
      const { rows: fyRows } = await client.query<{ id: string }>(
        `INSERT INTO fiscal_years (tenant_id, legal_entity_id, name, start_date, end_date)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [tenantId, legalEntityId, `FY${yearStart.slice(0, 4)}`, yearStart, yearEnd],
      );
      const fiscalYearId = fyRows[0]!.id;

      for (let m = 0; m < 12; m++) {
        const from = addMonths(yearStart, m);
        const to = addDays(addMonths(from, 1), -1);
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO accounting_periods
             (tenant_id, legal_entity_id, fiscal_year_id, period_no, name, start_date, end_date, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'OPEN') RETURNING id`,
          [tenantId, legalEntityId, fiscalYearId, m + 1, `${from.slice(0, 7)}`, from, to],
        );
        periods.push({ id: rows[0]!.id, from, to });
      }

      // F-011: one adjustment period per year, deliberately overlapping period 12.
      // The exclusion constraint covers non-adjustment periods only, so this is
      // the seeded proof that adjustment periods still work.
      const p12 = periods[periods.length - 1]!;
      await client.query(
        `INSERT INTO accounting_periods
           (tenant_id, legal_entity_id, fiscal_year_id, period_no, name, start_date, end_date,
            is_adjustment, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true,'OPEN')`,
        [
          tenantId,
          legalEntityId,
          fiscalYearId,
          13,
          `${yearStart.slice(0, 4)}-ADJ`,
          p12.from,
          p12.to,
        ],
      );

      yearStart = addMonths(yearStart, 12);
    }

    // --- journals -----------------------------------------------------------
    const journalTypes: ReadonlyArray<readonly [string, string, string]> = [
      ['GJ', 'General journal', 'GENERAL'],
      ['SJ', 'Sales journal', 'SALES'],
      ['PJ', 'Purchase journal', 'PURCHASE'],
      ['BJ', 'Bank journal', 'BANK'],
      ['OJ', 'Opening journal', 'OPENING'],
    ];
    let generalJournalId = '';
    for (const [jCode, jName, jType] of journalTypes) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO journals (tenant_id, legal_entity_id, accounting_book_id, code, name, journal_type)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [tenantId, legalEntityId, bookId, jCode, jName, jType],
      );
      if (jType === 'GENERAL') generalJournalId = rows[0]!.id;
    }

    entities.push({
      id: legalEntityId,
      code,
      bookId,
      branchId,
      generalJournalId,
      baseCurrency,
      accounts,
      periods,
    });

    // Keeps entity-to-entity variation deterministic but not identical.
    rng.next();
  }

  return { tenantId, organizationId, userId, entities };
}
