import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { D, MONEY_SCALE, uuidv7, type Grant, type TenantPrincipal } from '@acct/domain';
import { createPool, migrate } from '@acct/database';
import {
  JournalService,
  LedgerProjectionService,
  LedgerReportsService,
  PostingService,
} from '@acct/ledger';
import { StatementsService } from './statements.service';
import { ReportDrillService } from './drill.service';
import { ReportDefinitionsService } from './definitions.service';
import { ReportRunsService } from './runs.service';
import { AuditWorkspaceService } from './audit-workspace.service';

/**
 * Phase 6's two exit criteria, against a real PostgreSQL, over a real ledger.
 *
 *   1. "Core statements tie exactly to Trial Balance."
 *   2. "Every financial report amount can drill to ledger lines."
 *
 * The fixture is built to defeat the easy pass. In particular:
 *
 *   * There are TWO fiscal years, with real postings in both, so a
 *     profit-and-loss account's closing balance is not its year-to-date result.
 *     Under the DERIVED retained-earnings method (ADR-0001 §2) a statement that
 *     confuses the two overstates the current year by every prior year the book
 *     has run — and still balances, which is why nothing else catches it.
 *   * The reporting window is ONE month inside the second year, so period,
 *     year-to-date and closing are three different numbers. A criterion proved on
 *     a window where they coincide is proved on none of its domain.
 *   * Every assertion is run against BOTH balance sources — the cached projection
 *     and a rebuild from raw journal lines — because a tie that only holds for one
 *     of them is a tie that holds for whichever one the fixture happened to use.
 *   * The drill is asserted to be COMPLETE, not merely present: the sum of every
 *     line it returns, paged one row at a time, must equal the figure on the
 *     statement, and the page must announce the rest rather than stopping quietly.
 */

const url = testDatabaseUrl();

interface Fixture {
  tenantId: string;
  userId: string;
  organizationId: string;
  legalEntityId: string;
  bookId: string;
  journalId: string;
  accounts: Record<string, string>;
  periodMar2026: string;
  principal: TenantPrincipal;
}

const WINDOW = { periodFrom: '2026-03-01', periodTo: '2026-03-31' } as const;
const money = (v: string) => D(v, MONEY_SCALE).toString();

describe.skipIf(!url)('Phase 6 statements, drill and definitions against a real database', () => {
  let pool: Pool;
  let fixture: Fixture;
  let statements: StatementsService;
  let drill: ReportDrillService;
  let definitions: ReportDefinitionsService;
  let runs: ReportRunsService;
  let audit: AuditWorkspaceService;

  beforeAll(async () => {
    pool = createPool({
      connectionString: url!,
      max: 6,
      applicationName: 'acct-reporting-test',
      statementTimeoutMs: 120_000,
    });
    await migrate(pool);

    fixture = await createFixture(pool);
    const posting = new PostingService(new LedgerProjectionService());
    const journals = new JournalService(pool, posting);
    await postLedger(journals, fixture);

    const ledgerReports = new LedgerReportsService(pool, new LedgerProjectionService());
    statements = new StatementsService(pool, ledgerReports);
    drill = new ReportDrillService(pool);
    definitions = new ReportDefinitionsService(pool);
    runs = new ReportRunsService(pool, statements);
    audit = new AuditWorkspaceService(pool);
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
  });

  // -------------------------------------------------------------------------
  // Criterion 1
  // -------------------------------------------------------------------------

  for (const source of ['projection', 'journal_lines'] as const) {
    it(`ties the profit and loss to the trial balance, from ${source}`, async () => {
      const pnl = await statements.profitAndLoss(fixture.principal, {
        accountingBookId: fixture.bookId,
        ...WINDOW,
        source,
      });

      // The comparison ran. A criterion whose check was skipped must never read
      // as satisfied, so this is asserted before anything it implies.
      expect(pnl.reconciliation.checked).toBe(true);
      expect(pnl.reconciliation).toMatchObject({ ties: true, window_matches: true });
      if (pnl.reconciliation.checked) {
        expect(pnl.reconciliation.differences).toEqual([]);
        expect(pnl.reconciliation.only_in_trial_balance).toEqual([]);
        expect(pnl.reconciliation.only_in_statement_input).toEqual([]);
        // It compared something. An empty comparison ties trivially.
        expect(pnl.reconciliation.accounts_compared).toBeGreaterThanOrEqual(10);
      }
      expect(pnl.criterion.satisfied).toBe(true);

      // March 2026 holds one operating expense and no sales; the year to March
      // holds the February sale as well. Three windows, three numbers.
      expect(pnl.profit_and_loss.result.period).toBe(money('-12000'));
      expect(pnl.profit_and_loss.result.year_to_date).toBe(money('48000'));
      expect(pnl.profit_and_loss.revenue.year_to_date).toBe(money('60000'));
      expect(pnl.ties.every((t) => t.ties)).toBe(true);
    });

    it(`balances the balance sheet and separates prior years from this one, from ${source}`, async () => {
      const bs = await statements.balanceSheet(fixture.principal, {
        accountingBookId: fixture.bookId,
        ...WINDOW,
        source,
      });

      expect(bs.reconciliation.checked).toBe(true);
      expect(bs.reconciliation.ties).toBe(true);
      expect(bs.balances).toBe(true);
      expect(bs.balance_sheet.difference).toBe(money('0'));

      expect(bs.balance_sheet.total_assets.closing).toBe(money('208000'));
      expect(bs.balance_sheet.total_liabilities.closing).toBe(money('35000'));
      expect(bs.balance_sheet.total_equity.closing).toBe(money('173000'));

      // The whole reason the fixture has two years. The book DERIVES retained
      // earnings, so 2025's 25 000 is still sitting in the profit-and-loss
      // accounts and must be presented as retained earnings, NOT as this year's
      // result. A statement that read the closing balance as the year's result
      // would report 73 000 here and still balance.
      expect(bs.balance_sheet.equity.retained_earnings).toBe(money('25000'));
      expect(bs.balance_sheet.equity.current_year_result).toBe(money('48000'));
      expect(bs.balance_sheet.equity.prior_year_results_in_profit_and_loss).toBe(money('25000'));
      expect(bs.balance_sheet.equity.contributed_and_other).toBe(money('100000'));
      expect(bs.retained_earnings_method).toBe('DERIVED');
    });

    it(`reconciles the cash flow, and says it measured something, from ${source}`, async () => {
      const cf = await statements.cashFlow(fixture.principal, {
        accountingBookId: fixture.bookId,
        ...WINDOW,
        source,
      });

      // Gate E's criterion has no subject without cash accounts; assert there
      // were some BEFORE asserting it reconciles, or 0 = 0 passes.
      expect(cf.cash_flow.measured).toBe(true);
      expect(cf.cash_flow.cash_account_count).toBeGreaterThan(0);
      expect(cf.cash_flow.reconciles).toBe(true);

      expect(cf.cash_flow.opening_cash).toBe(money('170000'));
      expect(cf.cash_flow.closing_cash).toBe(money('168000'));
      expect(cf.cash_flow.cash_movement).toBe(money('-2000'));
      expect(cf.cash_flow.operating).toBe(money('-12000'));
      expect(cf.cash_flow.investing).toBe(money('-20000'));
      expect(cf.cash_flow.financing).toBe(money('30000'));
      expect(cf.cash_flow.unclassified_movement).toBe(money('0'));
      expect(cf.cash_flow.difference).toBe(money('0'));
    });
  }

  it('composes all three from one read and reports every tie check green', async () => {
    const set = await statements.financialStatements(fixture.principal, {
      accountingBookId: fixture.bookId,
      ...WINDOW,
    });
    expect(set.ties_exactly).toBe(true);
    expect(set.ties.map((t) => t.name).sort()).toEqual([
      'BALANCE_SHEET_BALANCES',
      'BALANCE_SHEET_TIES_TO_TRIAL_BALANCE',
      'CASH_FLOW_RECONCILES',
      'CURRENT_YEAR_RESULT_TIES_TO_PROFIT_AND_LOSS',
      'EQUITY_ANALYSIS',
      'EQUITY_ROLL_FORWARD',
      'PROFIT_AND_LOSS_TIES_TO_TRIAL_BALANCE',
    ]);
    for (const tie of set.ties) expect(tie.difference).toBe(money('0'));
    expect(set.criterion.satisfied).toBe(true);
  });

  it('says so instead of claiming a tie when the comparison is not run', async () => {
    // The negative half of criterion 1's own reporting: a response that skipped
    // the check must be distinguishable from one that passed it.
    const pnl = await statements.profitAndLoss(fixture.principal, {
      accountingBookId: fixture.bookId,
      ...WINDOW,
      reconcile: false,
    });
    expect(pnl.reconciliation.checked).toBe(false);
    expect(pnl.reconciliation.ties).toBeNull();
    expect(pnl.criterion.satisfied).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Criterion 2
  // -------------------------------------------------------------------------

  it('drills a statement figure to journal lines whose total equals the figure', async () => {
    const pnl = await statements.profitAndLoss(fixture.principal, {
      accountingBookId: fixture.bookId,
      ...WINDOW,
    });
    const sales = pnl.profit_and_loss.accounts.find((a) => a.account_code === '4000')!;
    expect(sales.amounts.year_to_date).toBe(money('60000'));

    const token = sales.drill.year_to_date!;
    expect(token.explains).toBe('year_to_date');
    // The token is the whole request. Nothing is reconstructed from the caller's
    // own parameters, which is what makes the drill provably about this figure.
    const result = await drill.drillDown(fixture.principal, {
      accountingBookId: token.accounting_book_id,
      periodFrom: token.period_from ?? undefined,
      periodTo: token.period_to,
      accountIds: token.account_ids,
    });

    // Revenue is presented credit-positive; a drill total is debit less credit.
    expect(result.totals.net).toBe(money('-60000'));
    expect(result.totals.credit).toBe(money('60000'));
    expect(result.meta.complete).toBe(true);
    expect(result.meta.has_more).toBe(false);
    expect(result.meta.next_cursor).toBeNull();
    expect(result.explains.account_ids).toEqual([sales.account_id]);
  });

  it('drills a balance sheet closing balance over the right window', async () => {
    const bs = await statements.balanceSheet(fixture.principal, {
      accountingBookId: fixture.bookId,
      ...WINDOW,
    });
    const cash = bs.balance_sheet.accounts.find((a) => a.account_code === '1000')!;
    expect(cash.amounts.closing).toBe(money('168000'));
    expect(cash.amounts.opening).toBe(money('170000'));

    const closing = cash.drill.closing!;
    // A closing balance is every line ever posted up to the window's end, so its
    // token opens the window at the start of the calendar rather than at the
    // start of the reporting period. Using the period window here would explain
    // the movement and label it the balance.
    expect(closing.period_from).toBeNull();
    expect(closing.period_to).toBe('2026-03-31');
    const closingLines = await drill.drillDown(fixture.principal, {
      accountingBookId: closing.accounting_book_id,
      periodTo: closing.period_to,
      accountIds: closing.account_ids,
      limit: 200,
    });
    expect(closingLines.totals.net).toBe(money('168000'));

    const opening = cash.drill.opening!;
    expect(opening.period_to).toBe('2026-02-28');
    const openingLines = await drill.drillDown(fixture.principal, {
      accountingBookId: opening.accounting_book_id,
      periodTo: opening.period_to,
      accountIds: opening.account_ids,
      limit: 200,
    });
    expect(openingLines.totals.net).toBe(money('170000'));
  });

  it('pages the drill one line at a time without losing or repeating a line', async () => {
    const token = {
      accountingBookId: fixture.bookId,
      periodTo: '2026-03-31',
      accountIds: [fixture.accounts['1000']!],
    };
    const complete = await drill.drillDown(fixture.principal, { ...token, limit: 200 });
    const expected = complete.totals.line_count;
    expect(expected).toBeGreaterThan(1);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await drill.drillDown(fixture.principal, { ...token, limit: 1, cursor });
      pages++;
      expect(page.meta.limit).toBe(1);
      expect(page.meta.limit_source).toBe('REQUEST');
      // The whole point of F-1005: a page that is not the whole answer says so,
      // and says how much is missing.
      expect(page.meta.total_lines).toBe(expected);
      if (page.meta.has_more) {
        expect(page.meta.next_cursor).not.toBeNull();
        expect(page.meta.complete).toBe(false);
        expect(page.meta.lines_not_on_this_page).toBeGreaterThan(0);
      }
      for (const row of page.data) seen.push(row.id);
      if (!page.meta.has_more) {
        expect(page.meta.next_cursor).toBeNull();
        break;
      }
      cursor = page.meta.next_cursor!;
      expect(pages).toBeLessThan(expected + 2);
    }

    expect(seen).toHaveLength(expected);
    expect(new Set(seen).size).toBe(expected);
    expect(seen.sort()).toEqual(complete.data.map((r) => r.id).sort());
  });

  it('states the limit it applied and where the limit came from', async () => {
    const asked = await drill.drillDown(fixture.principal, {
      accountingBookId: fixture.bookId,
      periodTo: '2026-03-31',
      limit: 2,
    });
    expect(asked.meta).toMatchObject({ limit: 2, limit_source: 'REQUEST', has_more: true });
    expect(asked.meta.next_cursor).not.toBeNull();

    const defaulted = await drill.drillDown(fixture.principal, {
      accountingBookId: fixture.bookId,
      periodTo: '2026-03-31',
    });
    expect(defaulted.meta).toMatchObject({ limit_source: 'DEFAULT' });
    expect(defaulted.meta.limit).toBe(defaulted.meta.default_limit);
  });

  it('refuses a drill that names both accounts and a report row', async () => {
    await expect(
      drill.drillDown(fixture.principal, {
        accountingBookId: fixture.bookId,
        accountId: fixture.accounts['4000'],
        reportDefinitionId: uuidv7(),
        rowNo: 10,
      }),
    ).rejects.toThrowError(/not both/);
  });

  it('refuses a drill from a principal without report.drill_down', async () => {
    // doc 12: "a user may see an aggregate but not restricted source detail if
    // policy requires". The aggregate and the lines behind it are different
    // permissions, so this must fail for a principal that can read the report.
    const viewer = withPermissions(fixture, ['report.view']);
    await expect(
      statements.profitAndLoss(viewer, { accountingBookId: fixture.bookId, ...WINDOW }),
    ).resolves.toBeTruthy();
    await expect(
      drill.drillDown(viewer, {
        accountingBookId: fixture.bookId,
        accountId: fixture.accounts['4000'],
      }),
    ).rejects.toThrowError(/report\.drill_down/);
  });

  // -------------------------------------------------------------------------
  // Custom report definitions over the safe semantic model
  // -------------------------------------------------------------------------

  it('renders a stored definition, evaluates its formula rows, and still ties', async () => {
    const created = await definitions.createReportDefinition(fixture.principal, {
      organizationId: fixture.organizationId,
      legalEntityId: fixture.legalEntityId,
      code: 'MGMT-PNL',
      name: 'Management profit and loss',
      reportType: 'PROFIT_LOSS',
      rows: [
        {
          rowNo: 10,
          label: 'Revenue',
          rowType: 'ACCOUNT_RANGE',
          accountFrom: '4000',
          accountTo: '4999',
        },
        {
          rowNo: 20,
          label: 'Cost of sales',
          rowType: 'ACCOUNT_RANGE',
          accountFrom: '5000',
          accountTo: '5999',
        },
        {
          rowNo: 30,
          label: 'Operating expenses',
          rowType: 'ACCOUNT_RANGE',
          accountFrom: '6000',
          accountTo: '6999',
        },
        { rowNo: 40, label: 'Result', rowType: 'SUBTOTAL', formula: 'R10 - R20 - R30' },
        { rowNo: 50, label: 'Margin', rowType: 'FORMULA', formula: 'R40 / R10' },
      ],
    });
    expect(created).toMatchObject({ code: 'MGMT-PNL', version: 1 });

    const pnl = await statements.profitAndLoss(fixture.principal, {
      accountingBookId: fixture.bookId,
      ...WINDOW,
      reportDefinitionId: (created as { id: string }).id,
    });

    expect(pnl.reconciliation.checked).toBe(true);
    expect(pnl.reconciliation.ties).toBe(true);
    expect(pnl.criterion.satisfied).toBe(true);

    const rows = pnl.rows!;
    const byRow = new Map(rows.map((r) => [r.row_no, r]));
    expect(byRow.get(10)!.amounts.year_to_date).toBe(money('60000'));
    expect(byRow.get(30)!.amounts.year_to_date).toBe(money('12000'));
    // 60000 - 0 - 12000 = 48000, computed by the formula rather than by the engine.
    expect(byRow.get(40)!.amounts.year_to_date).toBe(money('48000'));
    // 48000 / 60000 = 0.8, exactly, at the money scale.
    expect(byRow.get(50)!.amounts.year_to_date).toBe(money('0.8'));
    // March has no revenue at all, so the margin has no denominator. Null, never
    // zero: a margin of 0% is a number nobody computed.
    expect(byRow.get(10)!.amounts.period).toBe(money('0'));
    expect(byRow.get(50)!.amounts.period).toBeNull();

    // The line total and the sum of its accounts are the same number.
    const line = pnl.profit_and_loss.sections
      .flatMap((s) => s.lines)
      .find((l) => l.code === 'ROW:10')!;
    expect(line.amounts.year_to_date).toBe(money('60000'));
    expect(line.accounts).toHaveLength(1);

    // And the row drills to the lines behind it.
    const rowDrill = await drill.drillDown(fixture.principal, {
      accountingBookId: fixture.bookId,
      periodFrom: '2026-01-01',
      periodTo: '2026-03-31',
      reportDefinitionId: (created as { id: string }).id,
      rowNo: 10,
    });
    expect(rowDrill.totals.net).toBe(money('-60000'));
    expect(rowDrill.explains.account_selection).toBe('REPORT_DEFINITION_ROW');
  });

  it('versions a definition instead of editing it', async () => {
    const first = await definitions.createReportDefinition(fixture.principal, {
      organizationId: fixture.organizationId,
      legalEntityId: fixture.legalEntityId,
      code: 'VERSIONED',
      name: 'v1',
      reportType: 'BALANCE_SHEET',
      rows: [
        {
          rowNo: 10,
          label: 'Assets',
          rowType: 'ACCOUNT_RANGE',
          accountFrom: '1000',
          accountTo: '1999',
        },
      ],
    });
    const second = await definitions.createReportDefinition(fixture.principal, {
      organizationId: fixture.organizationId,
      legalEntityId: fixture.legalEntityId,
      code: 'VERSIONED',
      name: 'v2',
      reportType: 'BALANCE_SHEET',
      rows: [
        {
          rowNo: 10,
          label: 'Current assets',
          rowType: 'ACCOUNT_RANGE',
          accountFrom: '1000',
          accountTo: '1499',
        },
        {
          rowNo: 20,
          label: 'Non-current assets',
          rowType: 'ACCOUNT_RANGE',
          accountFrom: '1500',
          accountTo: '1999',
        },
      ],
    });
    expect((first as { version: number }).version).toBe(1);
    expect((second as { version: number }).version).toBe(2);
    expect((first as { id: string }).id).not.toBe((second as { id: string }).id);

    const listed = await definitions.listReportDefinitions(fixture.principal, {
      code: 'VERSIONED',
    });
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]).toMatchObject({ version: 2, is_latest: true });

    const all = await definitions.listReportDefinitions(fixture.principal, {
      code: 'VERSIONED',
      includeAllVersions: true,
    });
    expect(all.data).toHaveLength(2);
  });

  it('refuses a definition whose ranges would count an account twice', async () => {
    const overlapping = await definitions.createReportDefinition(fixture.principal, {
      organizationId: fixture.organizationId,
      legalEntityId: fixture.legalEntityId,
      code: 'OVERLAP',
      name: 'Overlapping ranges',
      reportType: 'PROFIT_LOSS',
      rows: [
        {
          rowNo: 10,
          label: 'All revenue',
          rowType: 'ACCOUNT_RANGE',
          accountFrom: '4000',
          accountTo: '4999',
        },
        {
          rowNo: 20,
          label: 'Also revenue',
          rowType: 'ACCOUNT_RANGE',
          accountFrom: '4000',
          accountTo: '4500',
        },
      ],
    });
    // The overlap is only detectable against a chart, so it is caught when the
    // definition is APPLIED — and it refuses rather than rendering a statement
    // that counts 4000 twice and disagrees with its own total.
    await expect(
      statements.profitAndLoss(fixture.principal, {
        accountingBookId: fixture.bookId,
        ...WINDOW,
        reportDefinitionId: (overlapping as { id: string }).id,
      }),
    ).rejects.toThrowError(/STATEMENT_ACCOUNT_MAPPED_TWICE/);
  });

  it('refuses SQL in a definition, and accepts the legitimate value it resembles', async () => {
    await expect(
      definitions.createReportDefinition(fixture.principal, {
        organizationId: fixture.organizationId,
        legalEntityId: fixture.legalEntityId,
        code: 'INJECT',
        name: 'Injection attempt',
        reportType: 'PROFIT_LOSS',
        rows: [
          {
            rowNo: 10,
            label: 'Revenue',
            rowType: 'ACCOUNT_RANGE',
            accountFrom: "4000' UNION SELECT code FROM accounts --",
            accountTo: '4999',
          },
        ],
      }),
    ).rejects.toThrowError(/REPORT_ACCOUNT_CODE_INVALID/);

    await expect(
      definitions.createReportDefinition(fixture.principal, {
        organizationId: fixture.organizationId,
        legalEntityId: fixture.legalEntityId,
        code: 'INJECT2',
        name: 'Injection attempt 2',
        reportType: 'PROFIT_LOSS',
        rows: [
          {
            rowNo: 10,
            label: 'Revenue',
            rowType: 'ACCOUNT_RANGE',
            accountFrom: '4000',
            accountTo: '4999',
          },
          {
            rowNo: 20,
            label: 'Everything',
            rowType: 'FORMULA',
            formula: '(SELECT sum(base_debit) FROM journal_lines)',
          },
        ],
      }),
    ).rejects.toThrowError(/REPORT_FORMULA_SYNTAX/);

    // The accept half: a label MAY contain the characters a code may not, because
    // a label is never a selector and is always a bound parameter.
    const ok = await definitions.createReportDefinition(fixture.principal, {
      organizationId: fixture.organizationId,
      legalEntityId: fixture.legalEntityId,
      code: 'LABELS',
      name: "Robert'); DROP TABLE report_rows;--",
      reportType: 'PROFIT_LOSS',
      rows: [
        {
          rowNo: 10,
          label: 'Revenue -- 100% of it; DROP TABLE accounts',
          rowType: 'ACCOUNT_RANGE',
          accountFrom: '4000',
          accountTo: '4999',
        },
      ],
    });
    expect(ok).toMatchObject({ code: 'LABELS' });
    const { rows: stillThere } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM accounts WHERE legal_entity_id = $1`,
      [fixture.legalEntityId],
    );
    expect(Number(stillThere[0]!.n)).toBeGreaterThan(0);
  });

  it('reports which accounts a definition leaves off a statement', async () => {
    const partial = await definitions.createReportDefinition(fixture.principal, {
      organizationId: fixture.organizationId,
      legalEntityId: fixture.legalEntityId,
      code: 'PARTIAL',
      name: 'Revenue only',
      reportType: 'PROFIT_LOSS',
      rows: [
        {
          rowNo: 10,
          label: 'Revenue',
          rowType: 'ACCOUNT_RANGE',
          accountFrom: '4000',
          accountTo: '4999',
        },
      ],
    });
    const pnl = await statements.profitAndLoss(fixture.principal, {
      accountingBookId: fixture.bookId,
      ...WINDOW,
      reportDefinitionId: (partial as { id: string }).id,
    });
    // The expenses have no line, so they are swept into an explicit UNMAPPED line
    // rather than dropped — and the statement still ties to the trial balance,
    // which is the whole reason they are not dropped.
    expect(pnl.exceptions.some((e) => e.code === 'ACCOUNT_UNMAPPED')).toBe(true);
    expect(pnl.profit_and_loss.definition_is_complete).toBe(false);
    expect(pnl.reconciliation.ties).toBe(true);
    expect(pnl.profit_and_loss.result.year_to_date).toBe(money('48000'));

    // And the issue path refuses it outright rather than recording a hole.
    await expect(
      statements.profitAndLoss(fixture.principal, {
        accountingBookId: fixture.bookId,
        ...WINDOW,
        reportDefinitionId: (partial as { id: string }).id,
        unmappedPolicy: 'REJECT',
      }),
    ).rejects.toThrowError(/STATEMENT_ACCOUNT_UNMAPPED/);
  });

  // -------------------------------------------------------------------------
  // Export jobs and the auditor workspace
  // -------------------------------------------------------------------------

  it('queues an export, executes it, and refuses to execute it twice', async () => {
    const queued = (await runs.createReportRun(fixture.principal, {
      legalEntityId: fixture.legalEntityId,
      reportType: 'PROFIT_LOSS',
      outputFormat: 'JSON',
      parameters: {
        accountingBookId: fixture.bookId,
        periodFrom: '2026-03-01',
        periodTo: '2026-03-31',
      },
    })) as { id: string; status: string; executor_wired: boolean };
    expect(queued.status).toBe('QUEUED');
    // No sink is wired in this test, and the response says so rather than
    // implying a 202 means somebody will produce a file.
    expect(queued.executor_wired).toBe(false);

    const done = (await runs.executeReportRun(fixture.principal, queued.id)) as {
      status: string;
      row_count: number;
      stored: boolean;
      payload: { criterion: { satisfied: boolean } };
    };
    expect(done.status).toBe('COMPLETED');
    expect(done.row_count).toBeGreaterThan(0);
    expect(done.stored).toBe(false);
    expect(done.payload.criterion.satisfied).toBe(true);

    await expect(runs.executeReportRun(fixture.principal, queued.id)).rejects.toThrowError(
      /not QUEUED/,
    );

    const listed = await runs.listReportRuns(fixture.principal, {
      legalEntityId: fixture.legalEntityId,
    });
    expect(listed.data.some((r) => (r as { id: string }).id === queued.id)).toBe(true);
    expect(listed.meta.has_more).toBe(false);
  });

  it('refuses an export whose book belongs to another entity', async () => {
    const otherBook = uuidv7();
    await expect(
      runs.createReportRun(fixture.principal, {
        legalEntityId: fixture.legalEntityId,
        reportType: 'PROFIT_LOSS',
        parameters: { accountingBookId: otherBook },
      }),
    ).rejects.toThrowError(/not found/i);
  });

  it('records and lists an audit request with its evidence count', async () => {
    const created = (await audit.createAuditRequest(fixture.principal, {
      legalEntityId: fixture.legalEntityId,
      accountingPeriodId: fixture.periodMar2026,
      title: 'Support for March revenue',
      description: 'Invoices behind account 4000 for the March quarter.',
    })) as { id: string; status: string };
    expect(created.status).toBe('OPEN');

    const listed = await audit.listAuditRequests(fixture.principal, {
      legalEntityId: fixture.legalEntityId,
    });
    const row = listed.data.find((r) => (r as { id: string }).id === created.id) as {
      evidence_count: number;
      overdue: boolean;
      title: string;
    };
    expect(row.evidence_count).toBe(0);
    expect(row.overdue).toBe(false);
    expect(row.title).toBe('Support for March revenue');

    await expect(
      audit.createAuditRequest(fixture.principal, {
        legalEntityId: fixture.legalEntityId,
        title: '   ',
      }),
    ).rejects.toThrowError(/needs a title/);
  });

  /**
   * LAST, deliberately: it adds a period to the fixture's calendar and every
   * ordinal after it shifts. Everything above has already run against the
   * calendar it was written for.
   */
  it('refuses a window the ledger orders another period inside, and accepts the widened one', async () => {
    // 0053 §1's REPORT_WINDOW_DISCONTIGUOUS, made reachable the way F-011 says it
    // is reachable in the field: one adjustment period, dated in January, that the
    // ledger orders AFTER December. A window from August 2025 to January 2026 then
    // selects six periods spanning seven ordinal slots — and over that set an
    // opening balance, a movement and a closing balance have no consistent meaning
    // at all, which is why it must be refused rather than answered.
    await pool.query(
      `INSERT INTO accounting_periods
         (id, tenant_id, legal_entity_id, fiscal_year_id, period_no, name,
          start_date, end_date, is_adjustment)
       VALUES ($1,$2,$3,
               (SELECT id FROM fiscal_years WHERE legal_entity_id = $3 AND name = 'FY25'),
               13,'FY25-ADJ','2025-01-05'::date,'2025-01-06'::date,true)`,
      [uuidv7(), fixture.tenantId, fixture.legalEntityId],
    );

    const discontiguous = statements.profitAndLoss(fixture.principal, {
      accountingBookId: fixture.bookId,
      periodFrom: '2025-08-01',
      periodTo: '2026-01-31',
    });
    await expect(discontiguous).rejects.toThrow();
    // The refusal must be the window refusal and nothing else — a test that only
    // asserted "it threw" would pass just as happily on a typo in the query.
    const error = await discontiguous.then(
      () => null,
      (e: unknown) => e as { message: string; code?: string; cause?: { message?: string } },
    );
    const text = `${error?.message ?? ''} ${error?.cause?.message ?? ''}`;
    expect(text).toContain('REPORT_WINDOW_DISCONTIGUOUS');
    // Names the intruder, because "discontiguous" is not actionable.
    expect(text).toContain('FY25-ADJ');

    // The ACCEPT half. Widening the window to include the adjustment period makes
    // the same request answerable, and it still ties — so the refusal above is a
    // property of the window, not of this entity or of the report.
    const widened = await statements.profitAndLoss(fixture.principal, {
      accountingBookId: fixture.bookId,
      periodFrom: '2025-01-01',
      periodTo: '2026-01-31',
    });
    expect(widened.reconciliation.checked).toBe(true);
    expect(widened.reconciliation.ties).toBe(true);
    // The window runs Jan 2025 to Jan 2026, so its MOVEMENT is 2025's whole
    // result (40 000 revenue less 15 000 cost) plus a January 2026 that carried
    // no revenue or expense. Its YEAR TO DATE is January 2026 alone, because the
    // window closes in FY26 and year-to-date starts at that year's first day.
    // Two different numbers over one window, which is exactly the distinction a
    // statement that derived one from the other would lose.
    expect(widened.profit_and_loss.result.period).toBe(money('25000'));
    expect(widened.profit_and_loss.result.year_to_date).toBe(money('0'));
  });
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * The test database, from the environment or from the repository's `.env`.
 *
 * `loadDotenv` in @acct/config is the real implementation and this file cannot
 * reach it: @acct/reporting does not depend on @acct/config, and adding the
 * dependency is a package.json change this task does not need. Test-only, one
 * lookup, no export, no interpolation.
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

const PERMISSIONS = [
  'journal.create',
  'journal.post',
  'journal.view',
  'ledger.view',
  'report.view',
  'report.drill_down',
  'report.manage',
  'report.export',
  'audit.view',
  'audit.manage',
] as const;

function principalFor(
  fixture: { tenantId: string; userId: string; organizationId: string; legalEntityId: string },
  permissions: readonly string[],
): TenantPrincipal {
  const grant: Grant = {
    membershipId: uuidv7(),
    roleId: uuidv7(),
    roleCode: 'REPORTING_TEST',
    organizationId: fixture.organizationId,
    legalEntityId: fixture.legalEntityId,
    branchId: null,
    permissions: new Set<string>(permissions),
  };
  return {
    userId: fixture.userId,
    sessionId: uuidv7(),
    email: `${fixture.userId}@example.test`,
    displayName: 'reporting test',
    tenantId: fixture.tenantId,
    grants: [grant],
    mfaSatisfied: true,
    mfaVerifiedAt: new Date(),
    impersonatedBy: null,
  };
}

const withPermissions = (fixture: Fixture, permissions: readonly string[]): TenantPrincipal =>
  principalFor(fixture, permissions);

/**
 * The chart. Deliberately includes a contra asset and a cash account, because the
 * cash flow has no subject without the second and the balance sheet signs the
 * first by account TYPE rather than by normal balance.
 */
const CHART: ReadonlyArray<{
  code: string;
  name: string;
  type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
  normal: 'DEBIT' | 'CREDIT';
  group: string;
  cashFlow: 'OPERATING' | 'INVESTING' | 'FINANCING' | 'NONE';
  isCash?: boolean;
}> = [
  {
    code: '1000',
    name: 'Cash at bank',
    type: 'ASSET',
    normal: 'DEBIT',
    group: 'CA',
    cashFlow: 'NONE',
    isCash: true,
  },
  {
    code: '1100',
    name: 'Trade receivables',
    type: 'ASSET',
    normal: 'DEBIT',
    group: 'CA',
    cashFlow: 'OPERATING',
  },
  {
    code: '1500',
    name: 'Equipment',
    type: 'ASSET',
    normal: 'DEBIT',
    group: 'NCA',
    cashFlow: 'INVESTING',
  },
  {
    code: '1590',
    name: 'Accumulated depreciation',
    type: 'ASSET',
    normal: 'CREDIT',
    group: 'NCA',
    cashFlow: 'INVESTING',
  },
  {
    code: '2000',
    name: 'Trade payables',
    type: 'LIABILITY',
    normal: 'CREDIT',
    group: 'CL',
    cashFlow: 'OPERATING',
  },
  {
    code: '2500',
    name: 'Bank loan',
    type: 'LIABILITY',
    normal: 'CREDIT',
    group: 'NCL',
    cashFlow: 'FINANCING',
  },
  {
    code: '3000',
    name: 'Share capital',
    type: 'EQUITY',
    normal: 'CREDIT',
    group: 'EQ',
    cashFlow: 'FINANCING',
  },
  {
    code: '3100',
    name: 'Retained earnings',
    type: 'EQUITY',
    normal: 'CREDIT',
    group: 'EQ',
    cashFlow: 'NONE',
  },
  {
    code: '3200',
    name: 'Current year earnings',
    type: 'EQUITY',
    normal: 'CREDIT',
    group: 'EQ',
    cashFlow: 'NONE',
  },
  {
    code: '4000',
    name: 'Sales',
    type: 'REVENUE',
    normal: 'CREDIT',
    group: 'REV',
    cashFlow: 'OPERATING',
  },
  {
    code: '5000',
    name: 'Cost of sales',
    type: 'EXPENSE',
    normal: 'DEBIT',
    group: 'COS',
    cashFlow: 'OPERATING',
  },
  {
    code: '6000',
    name: 'Operating expenses',
    type: 'EXPENSE',
    normal: 'DEBIT',
    group: 'OPX',
    cashFlow: 'OPERATING',
  },
];

const GROUPS: ReadonlyArray<[string, string]> = [
  ['CA', 'Current assets'],
  ['NCA', 'Non-current assets'],
  ['CL', 'Current liabilities'],
  ['NCL', 'Non-current liabilities'],
  ['EQ', 'Equity'],
  ['REV', 'Revenue'],
  ['COS', 'Cost of sales'],
  ['OPX', 'Operating expenses'],
];

async function createFixture(pool: Pool): Promise<Fixture> {
  const tenantId = uuidv7();
  const userId = uuidv7();
  const organizationId = uuidv7();
  const legalEntityId = uuidv7();
  const bookId = uuidv7();
  const journalId = uuidv7();
  const slug = `reporting-${tenantId}`;

  await pool.query(`INSERT INTO tenants (id, name, slug) VALUES ($1,$2,$3)`, [
    tenantId,
    slug,
    slug,
  ]);
  await pool.query(`INSERT INTO users (id, email, display_name) VALUES ($1,$2,$3)`, [
    userId,
    `${userId}@example.test`,
    'reporting test',
  ]);
  await pool.query(`INSERT INTO organizations (id, tenant_id, name) VALUES ($1,$2,$3)`, [
    organizationId,
    tenantId,
    'Reporting Org',
  ]);
  await pool.query(
    `INSERT INTO legal_entities
       (id, tenant_id, organization_id, code, legal_name, country_code, functional_currency,
        timezone, activated_at, posting_enabled)
     VALUES ($1,$2,$3,'RPT','Reporting Entity','US','USD','UTC',now(),true)`,
    [legalEntityId, tenantId, organizationId],
  );
  await pool.query(
    `INSERT INTO accounting_books
       (id, tenant_id, legal_entity_id, code, name, base_currency, is_primary)
     VALUES ($1,$2,$3,'PRI','Primary','USD',true)`,
    [bookId, tenantId, legalEntityId],
  );
  await pool.query(
    `INSERT INTO journals (id, tenant_id, legal_entity_id, accounting_book_id, code, name,
                           journal_type)
     VALUES ($1,$2,$3,$4,'GJ','General journal','GENERAL')`,
    [journalId, tenantId, legalEntityId, bookId],
  );

  // Two fiscal years, twelve periods each. The second year is what the report
  // window sits in; the first is what makes "prior years" non-zero.
  for (const [year, start, end] of [
    ['FY25', '2025-01-01', '2025-12-31'],
    ['FY26', '2026-01-01', '2026-12-31'],
  ] as const) {
    const fiscalYearId = uuidv7();
    await pool.query(
      `INSERT INTO fiscal_years (id, tenant_id, legal_entity_id, name, start_date, end_date)
       VALUES ($1,$2,$3,$4,$5::date,$6::date)`,
      [fiscalYearId, tenantId, legalEntityId, year, start, end],
    );
    for (let month = 1; month <= 12; month++) {
      const from = `${start.slice(0, 4)}-${String(month).padStart(2, '0')}-01`;
      await pool.query(
        `INSERT INTO accounting_periods
           (id, tenant_id, legal_entity_id, fiscal_year_id, period_no, name, start_date, end_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7::date,($7::date + interval '1 month - 1 day')::date)`,
        [uuidv7(), tenantId, legalEntityId, fiscalYearId, month, `${year}-M${month}`, from],
      );
    }
    void end;
  }

  const groupIds = new Map<string, string>();
  for (const [code, name] of GROUPS) {
    const id = uuidv7();
    groupIds.set(code, id);
    await pool.query(
      `INSERT INTO account_groups (id, tenant_id, legal_entity_id, code, name)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, tenantId, legalEntityId, code, name],
    );
  }

  const accounts: Record<string, string> = {};
  for (const account of CHART) {
    const id = uuidv7();
    accounts[account.code] = id;
    await pool.query(
      `INSERT INTO accounts
         (id, tenant_id, legal_entity_id, group_id, code, name, account_type, normal_balance,
          cash_flow_classification, is_cash_equivalent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        tenantId,
        legalEntityId,
        groupIds.get(account.group),
        account.code,
        account.name,
        account.type,
        account.normal,
        account.cashFlow,
        account.isCash ?? false,
      ],
    );
  }

  // The policy names the two equity roles. Without it the balance sheet cannot
  // tell retained earnings from any other equity account and says so as an
  // exception rather than guessing.
  await pool.query(
    `INSERT INTO accounting_policies
       (id, tenant_id, legal_entity_id, version, valid_from, retained_earnings_method,
        retained_earnings_account_id, current_year_earnings_account_id)
     VALUES ($1,$2,$3,1,'2020-01-01','DERIVED',$4,$5)`,
    [uuidv7(), tenantId, legalEntityId, accounts['3100'], accounts['3200']],
  );

  const { rows: periods } = await pool.query<{ id: string }>(
    `SELECT id FROM accounting_periods
      WHERE legal_entity_id = $1 AND start_date = '2026-03-01'`,
    [legalEntityId],
  );

  return {
    tenantId,
    userId,
    organizationId,
    legalEntityId,
    bookId,
    journalId,
    accounts,
    periodMar2026: periods[0]!.id,
    principal: principalFor({ tenantId, userId, organizationId, legalEntityId }, PERMISSIONS),
  };
}

/**
 * Ten posted entries across two fiscal years.
 *
 * Posted through `JournalService`, not inserted: the balance projection, the
 * entry numbering and the deferred balance trigger are all part of what the
 * statements read, and a fixture that writes rows directly would prove the
 * statements tie to a ledger the ledger code never produced.
 */
async function postLedger(journals: JournalService, fixture: Fixture): Promise<void> {
  const a = fixture.accounts;
  const entries: Array<[string, string, [string, string], [string, string]]> = [
    // 2025 — the prior year, whose result must NOT appear as this year's.
    ['2025-06-15', 'Capital injection', [a['1000']!, '100000'], [a['3000']!, '100000']],
    ['2025-07-10', 'Sale on credit', [a['1100']!, '40000'], [a['4000']!, '40000']],
    ['2025-07-20', 'Receipt from customer', [a['1000']!, '30000'], [a['1100']!, '30000']],
    ['2025-08-05', 'Purchase on credit', [a['5000']!, '15000'], [a['2000']!, '15000']],
    ['2025-08-20', 'Payment to supplier', [a['2000']!, '10000'], [a['1000']!, '10000']],
    // 2026 — the reporting year. February carries the revenue, March the rest,
    // so period, year-to-date and closing are three different numbers.
    ['2026-02-10', 'Sale on credit', [a['1100']!, '60000'], [a['4000']!, '60000']],
    ['2026-02-15', 'Receipt from customer', [a['1000']!, '50000'], [a['1100']!, '50000']],
    ['2026-03-05', 'Equipment purchase', [a['1500']!, '20000'], [a['1000']!, '20000']],
    ['2026-03-10', 'Loan drawdown', [a['1000']!, '30000'], [a['2500']!, '30000']],
    ['2026-03-20', 'Operating expenses', [a['6000']!, '12000'], [a['1000']!, '12000']],
  ];

  for (const [postingDate, description, debit, credit] of entries) {
    const draft = (await journals.createDraft(fixture.principal, {
      accountingBookId: fixture.bookId,
      journalId: fixture.journalId,
      postingDate,
      description,
      lines: [
        { accountId: debit[0], debit: debit[1] },
        { accountId: credit[0], credit: credit[1] },
      ],
    })) as { id: string };
    await journals.post(fixture.principal, draft.id, {});
  }
}
