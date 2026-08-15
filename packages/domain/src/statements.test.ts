import { describe, it, expect } from 'vitest';
import { AppError } from './errors';
import { D, Decimal, MONEY_SCALE } from './decimal';
import type { AccountTypeCode } from './posting';
import {
  compareAccountCodes,
  composeBalanceSheet,
  composeCashFlow,
  composeFinancialStatements,
  composeProfitAndLoss,
  assertStatementsTie,
  statementAmountStrings,
  trialBalanceTotals,
  trialBalanceWindow,
  DEFAULT_BALANCE_SHEET_LINES,
  DEFAULT_PROFIT_AND_LOSS_LINES,
  type BalanceSheetLineSpec,
  type CashFlowClassification,
  type EquityRole,
  type ProfitAndLossLineSpec,
  type RetainedEarningsMethod,
  type StatementAccount,
  type TrialBalanceRow,
  type TrialBalanceWindow,
} from './statements';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const w = (debit: string, credit = '0'): TrialBalanceWindow => ({
  debit: D(debit, MONEY_SCALE),
  credit: D(credit, MONEY_SCALE),
});
const NIL = w('0', '0');

interface AccountOptions {
  readonly subtype?: string;
  readonly groupCode?: string;
  readonly equityRole?: EquityRole;
  readonly isCash?: boolean;
  readonly cashFlow?: CashFlowClassification | null;
  readonly normalBalance?: 'DEBIT' | 'CREDIT';
}

function account(
  code: string,
  name: string,
  accountType: AccountTypeCode,
  options: AccountOptions = {},
): StatementAccount {
  const natural = accountType === 'ASSET' || accountType === 'EXPENSE' ? 'DEBIT' : 'CREDIT';
  return {
    accountId: `acct-${code}`,
    code,
    name,
    accountType,
    normalBalance: options.normalBalance ?? natural,
    subtype: options.subtype ?? null,
    groupCode: options.groupCode ?? null,
    equityRole: options.equityRole ?? null,
    isCash: options.isCash ?? false,
    cashFlowClassification: options.cashFlow === undefined ? null : options.cashFlow,
  };
}

interface RowOptions {
  readonly opening?: TrialBalanceWindow;
  readonly period?: TrialBalanceWindow;
  readonly yearToDate?: TrialBalanceWindow;
  readonly comparative?: TrialBalanceWindow;
}

function row(acct: StatementAccount, windows: RowOptions = {}): TrialBalanceRow {
  const base: TrialBalanceRow = {
    account: acct,
    opening: windows.opening ?? NIL,
    period: windows.period ?? NIL,
    yearToDate: windows.yearToDate ?? windows.period ?? NIL,
  };
  return windows.comparative ? { ...base, comparative: windows.comparative } : base;
}

const BANK = account('1010', 'Bank current account', 'ASSET', {
  isCash: true,
  groupCode: 'CA',
});
const AR = account('1100', 'Accounts receivable', 'ASSET', {
  cashFlow: 'OPERATING',
  groupCode: 'CA',
});
const PPE = account('1500', 'Property, plant and equipment', 'ASSET', {
  cashFlow: 'INVESTING',
  groupCode: 'NCA',
});
const ACC_DEP = account('1510', 'Accumulated depreciation', 'ASSET', {
  normalBalance: 'CREDIT',
  cashFlow: 'INVESTING',
  groupCode: 'NCA',
});
const AP = account('2000', 'Accounts payable', 'LIABILITY', {
  cashFlow: 'OPERATING',
  groupCode: 'CL',
});
const LOAN = account('2500', 'Long-term borrowings', 'LIABILITY', {
  cashFlow: 'FINANCING',
  groupCode: 'NCL',
});
const CAPITAL = account('3000', 'Share capital', 'EQUITY', {
  cashFlow: 'FINANCING',
  groupCode: 'EQ',
});
const RETAINED = account('3100', 'Retained earnings', 'EQUITY', {
  equityRole: 'RETAINED_EARNINGS',
  cashFlow: 'NONE',
  groupCode: 'EQ',
});
const CURRENT_YEAR = account('3110', 'Current year earnings', 'EQUITY', {
  equityRole: 'CURRENT_YEAR_EARNINGS',
  cashFlow: 'NONE',
  groupCode: 'EQ',
});
const REVENUE = account('4000', 'Product revenue', 'REVENUE', {
  cashFlow: 'OPERATING',
  groupCode: 'REV',
});
const RETURNS = account('4090', 'Sales returns', 'REVENUE', {
  normalBalance: 'DEBIT',
  cashFlow: 'OPERATING',
  groupCode: 'REV',
});
const COGS = account('5000', 'Cost of goods sold', 'EXPENSE', {
  cashFlow: 'OPERATING',
  groupCode: 'COS',
});
const RENT = account('6010', 'Rent', 'EXPENSE', { cashFlow: 'OPERATING', groupCode: 'OPX' });
const DEPRECIATION = account('6060', 'Depreciation', 'EXPENSE', {
  cashFlow: 'NONE',
  groupCode: 'OPX',
});

/**
 * A small but complete book, in month 2 of its second fiscal year, keeping its
 * retained earnings the DERIVED way — so the prior year's profit is still
 * sitting in the revenue account.
 *
 *   Prior year: 3,000 capital in, 1,000 of cash sales, 3,500 spent on equipment.
 *   Month 1:    300 of cash sales, 100 of rent paid.
 *   Month 2:    500 sale on credit, 200 collected, 150 rent paid, 600 equipment.
 *
 * Every window is built from balanced entries, which is the only way a trial
 * balance is ever built.
 */
function tradingBook(): TrialBalanceRow[] {
  return [
    row(BANK, {
      opening: w('4300', '3600'),
      period: w('200', '750'),
      yearToDate: w('500', '850'),
    }),
    row(AR, {
      opening: NIL,
      period: w('500', '200'),
      yearToDate: w('500', '200'),
    }),
    row(PPE, { opening: w('3500'), period: w('600'), yearToDate: w('600') }),
    row(AP, { opening: NIL, period: NIL, yearToDate: NIL }),
    row(CAPITAL, { opening: w('0', '3000'), period: NIL, yearToDate: NIL }),
    row(RETAINED, { opening: NIL, period: NIL, yearToDate: NIL }),
    row(REVENUE, {
      // Opening carries the prior year's 1,000 and month 1's 300; year to date
      // is month 1 + month 2 only. The difference is the prior year.
      opening: w('0', '1300'),
      period: w('0', '500'),
      yearToDate: w('0', '800'),
    }),
    row(RENT, {
      opening: w('100'),
      period: w('150'),
      yearToDate: w('250'),
    }),
  ];
}

// ---------------------------------------------------------------------------
// Account code comparison
// ---------------------------------------------------------------------------

describe('compareAccountCodes', () => {
  it('compares all-numeric codes numerically, not lexicographically', () => {
    // The case that matters: a five-digit sub-account is lexicographically
    // inside 1000-1999 and numerically nowhere near it.
    expect(compareAccountCodes('10000', '1999')).toBe(1);
    expect(compareAccountCodes('1100', '1999')).toBe(-1);
    expect(compareAccountCodes('0100', '100')).toBe(0);
  });

  it('falls back to lexicographic comparison for non-numeric codes', () => {
    expect(compareAccountCodes('A100', 'A200')).toBe(-1);
    expect(compareAccountCodes('B100', 'A200')).toBe(1);
    expect(compareAccountCodes('A100', 'A100')).toBe(0);
  });

  it('selects a code range by the numeric ordering', () => {
    const rows = [
      row(account('1100', 'AR', 'ASSET'), { opening: w('100'), period: NIL }),
      row(account('10000', 'Deep sub-account', 'ASSET'), { opening: w('50'), period: NIL }),
      row(account('3000', 'Capital', 'EQUITY'), { opening: w('0', '150'), period: NIL }),
    ];
    const lines: BalanceSheetLineSpec[] = [
      {
        code: 'CA',
        label: 'Current assets',
        section: 'CURRENT_ASSET',
        accountCodeFrom: '1000',
        accountCodeTo: '1999',
      },
      { code: 'EQ', label: 'Equity', section: 'EQUITY', accountTypes: ['EQUITY'] },
    ];
    const bs = composeBalanceSheet({
      rows,
      retainedEarningsMethod: 'DERIVED',
      lines,
    });
    const current = bs.sections.find((s) => s.section === 'CURRENT_ASSET');
    expect(current?.amounts.closing.toString()).toBe('100.00000000');
    // 10000 did not slip into the range; it is reported unmapped rather than dropped.
    expect(bs.exceptions.map((e) => e.accountCode)).toContain('10000');
    expect(bs.totalAssets.closing.toString()).toBe('150.00000000');
    expect(bs.balances).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Trial balance validation — every refusal with its matching acceptance
// ---------------------------------------------------------------------------

describe('trial balance validation', () => {
  it('accepts a balanced trial balance and reports its totals', () => {
    const totals = trialBalanceTotals(tradingBook());
    expect(totals.opening.balances).toBe(true);
    expect(totals.period.balances).toBe(true);
    expect(totals.yearToDate.balances).toBe(true);
    expect(totals.closing.balances).toBe(true);
    expect(totals.comparative).toBeNull();
    expect(totals.accountCount).toBe(8);
    // Closing is presented netted per account, the way a trial balance presents it.
    expect(totals.closing.debit.toString()).toBe(totals.closing.credit.toString());
  });

  it('refuses an unbalanced period column and names the difference', () => {
    const rows = tradingBook();
    rows[1] = row(AR, { opening: w('0'), period: w('500', '199'), yearToDate: w('500', '200') });
    expect(() => composeFinancialStatements({ rows, retainedEarningsMethod: 'DERIVED' })).toThrow(
      /TRIAL_BALANCE_UNBALANCED: the period column .* difference of 1\.00000000/s,
    );
  });

  it('refuses an unbalanced opening column', () => {
    const rows = tradingBook();
    rows[3] = row(AP, { opening: w('0', '499'), period: NIL, yearToDate: NIL });
    expect(() => trialBalanceTotals(rows)).toThrow(/TRIAL_BALANCE_UNBALANCED: the opening column/);
  });

  it('refuses an unbalanced year-to-date column', () => {
    const rows = tradingBook();
    rows[7] = row(RENT, { opening: w('100'), period: w('150'), yearToDate: w('249') });
    expect(() => trialBalanceTotals(rows)).toThrow(
      /TRIAL_BALANCE_UNBALANCED: the year-to-date column/,
    );
  });

  it('refuses a negative column rather than reporting its consequence', () => {
    const rows = tradingBook();
    rows[1] = row(AR, {
      opening: w('0'),
      period: { debit: D('-300', MONEY_SCALE), credit: D('0', MONEY_SCALE) },
      yearToDate: w('500', '200'),
    });
    expect(() => trialBalanceTotals(rows)).toThrow(/TRIAL_BALANCE_NEGATIVE_COLUMN: account 1100/);
  });

  it('refuses an amount carrying more precision than numeric(24,8)', () => {
    const rows = tradingBook();
    rows[1] = row(AR, {
      opening: { debit: D('0.000000001'), credit: D('0') },
      period: w('500', '200'),
      yearToDate: w('500', '200'),
    });
    expect(() => trialBalanceTotals(rows)).toThrow(/TRIAL_BALANCE_AMOUNT_PRECISION/);
  });

  it('refuses the same account twice', () => {
    const rows = tradingBook();
    rows.push(row(AR, { opening: NIL, period: NIL }));
    expect(() => trialBalanceTotals(rows)).toThrow(/TRIAL_BALANCE_DUPLICATE_ACCOUNT: account 1100/);
  });

  it('refuses an equity role on an account that is not equity', () => {
    const rows = [
      row(account('1900', 'Not equity', 'ASSET', { equityRole: 'RETAINED_EARNINGS' }), {
        opening: w('10'),
      }),
      row(CAPITAL, { opening: w('0', '10') }),
    ];
    expect(() => composeBalanceSheet({ rows, retainedEarningsMethod: 'DERIVED' })).toThrow(
      /STATEMENT_EQUITY_ROLE_NOT_EQUITY: account 1900/,
    );
  });

  describe('comparative column completeness', () => {
    const base = (): TrialBalanceRow[] => [
      row(BANK, { opening: w('100'), period: w('50'), comparative: w('20') }),
      row(REVENUE, { opening: w('0', '100'), period: w('0', '50'), comparative: w('0', '20') }),
    ];

    it('accepts a comparative present on every row', () => {
      const pnl = composeProfitAndLoss({ rows: base() });
      expect(pnl.hasComparative).toBe(true);
      expect(pnl.result.comparative?.toString()).toBe('20.00000000');
    });

    it('accepts a trial balance with no comparative at all', () => {
      const rows = base().map((r) => row(r.account, { opening: r.opening, period: r.period }));
      const pnl = composeProfitAndLoss({ rows });
      expect(pnl.hasComparative).toBe(false);
      expect(pnl.result.comparative).toBeNull();
    });

    it('refuses a comparative present on some rows only — the NULL case specifically', () => {
      const rows = base();
      // Exactly the shape rule 5 warns about: the missing row is NULL, so any
      // comparison against it passes and the column is quietly short by 20.
      rows[1] = row(REVENUE, { opening: w('0', '100'), period: w('0', '50') });
      expect(() => composeProfitAndLoss({ rows })).toThrow(
        /TRIAL_BALANCE_COLUMN_INCOMPLETE: 1 of 2 rows carry a comparative window.*Missing: 4000/s,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Profit and loss
// ---------------------------------------------------------------------------

describe('profit and loss', () => {
  const rows = (): TrialBalanceRow[] => [
    row(REVENUE, {
      opening: w('0', '1000'),
      period: w('0', '900'),
      yearToDate: w('0', '1600'),
      comparative: w('0', '700'),
    }),
    row(RETURNS, {
      opening: w('50'),
      period: w('100'),
      yearToDate: w('120'),
      comparative: w('10'),
    }),
    row(COGS, { opening: w('400'), period: w('300'), yearToDate: w('500'), comparative: w('250') }),
    row(RENT, { opening: w('200'), period: w('150'), yearToDate: w('280'), comparative: w('140') }),
    // The balancing side: it mirrors the profit and loss exactly, so every
    // window balances. Its own composition is the balance sheet's problem.
    row(AP, {
      opening: w('1000', '650'),
      period: w('900', '550'),
      yearToDate: w('1600', '900'),
      comparative: w('700', '400'),
    }),
  ];

  const CUSTOM: ProfitAndLossLineSpec[] = [
    { code: 'SALES', label: 'Sales', section: 'REVENUE', accountCodes: ['4000', '4090'] },
    { code: 'COGS', label: 'Cost of sales', section: 'COST_OF_SALES', accountCodes: ['5000'] },
    {
      code: 'OPEX',
      label: 'Operating expenses',
      section: 'OPERATING_EXPENSE',
      accountCodes: ['6010'],
    },
  ];

  it('reports revenue net of a contra revenue account (signed by type, not normal balance)', () => {
    const pnl = composeProfitAndLoss({ rows: rows(), lines: CUSTOM });
    // 900 revenue less 100 returns. Signing by normal_balance would have made the
    // debit-normal returns account ADD to revenue.
    expect(pnl.revenue.period.toString()).toBe('800.00000000');
    expect(pnl.revenue.yearToDate.toString()).toBe('1480.00000000');
    expect(pnl.revenue.comparative?.toString()).toBe('690.00000000');
  });

  it('computes the subtotals doc 12 names, in all three columns', () => {
    const pnl = composeProfitAndLoss({ rows: rows(), lines: CUSTOM });
    expect(pnl.costOfSales.period.toString()).toBe('300.00000000');
    expect(pnl.grossProfit.period.toString()).toBe('500.00000000');
    expect(pnl.operatingExpense.period.toString()).toBe('150.00000000');
    expect(pnl.operatingResult.period.toString()).toBe('350.00000000');
    expect(pnl.result.period.toString()).toBe('350.00000000');
    expect(pnl.result.yearToDate.toString()).toBe('700.00000000');
    expect(pnl.result.comparative?.toString()).toBe('300.00000000');
  });

  it('presents by account as well as by line, for the drill-down', () => {
    const pnl = composeProfitAndLoss({ rows: rows(), lines: CUSTOM });
    const sales = pnl.sections
      .find((s) => s.section === 'REVENUE')
      ?.lines.find((l) => l.code === 'SALES');
    expect(sales?.accounts.map((a) => a.code)).toEqual(['4000', '4090']);
    expect(sales?.accounts.find((a) => a.code === '4090')?.amounts.period.toString()).toBe(
      '-100.00000000',
    );
    // Every profit-and-loss account appears exactly once in the flat list.
    expect(pnl.accounts.map((a) => a.code).sort()).toEqual(['4000', '4090', '5000', '6010']);
  });

  it('maps every account with the default definition', () => {
    const pnl = composeProfitAndLoss({ rows: rows() });
    expect(pnl.definitionIsComplete).toBe(true);
    expect(pnl.exceptions).toHaveLength(0);
    // No cost-of-sales line was declared, so gross profit is revenue. It is not
    // invented from the account codes.
    expect(pnl.grossProfit.period.toString()).toBe(pnl.revenue.period.toString());
    expect(pnl.result.period.toString()).toBe('350.00000000');
  });

  it('excludes balance sheet accounts from the profit and loss', () => {
    const pnl = composeProfitAndLoss({ rows: rows() });
    expect(pnl.accounts.map((a) => a.code)).not.toContain('2000');
  });
});

// ---------------------------------------------------------------------------
// The failure mode: an account that maps to no line
// ---------------------------------------------------------------------------

describe('unmapped accounts are reported, never dropped', () => {
  const rows = (): TrialBalanceRow[] => [
    row(REVENUE, { opening: NIL, period: w('0', '1000') }),
    row(RENT, { opening: NIL, period: w('400') }),
    row(COGS, { opening: NIL, period: w('600') }),
    row(BANK, { opening: NIL, period: NIL }),
  ];
  const PARTIAL: ProfitAndLossLineSpec[] = [
    { code: 'SALES', label: 'Sales', section: 'REVENUE', accountCodes: ['4000'] },
    {
      code: 'OPEX',
      label: 'Operating expenses',
      section: 'OPERATING_EXPENSE',
      accountCodes: ['6010'],
    },
  ];

  it('reports the account, keeps its balance in the statement, and still ties', () => {
    const pnl = composeProfitAndLoss({ rows: rows(), lines: PARTIAL });
    expect(pnl.definitionIsComplete).toBe(false);
    expect(pnl.exceptions).toHaveLength(1);
    expect(pnl.exceptions[0]?.code).toBe('ACCOUNT_UNMAPPED');
    expect(pnl.exceptions[0]?.accountCode).toBe('5000');
    // The whole point: 5000 is still IN the result. A statement that dropped it
    // would report a profit of 600 instead of 0 and would look perfectly fine.
    expect(pnl.result.period.toString()).toBe('0.00000000');
    expect(pnl.accounts.map((a) => a.code).sort()).toEqual(['4000', '5000', '6010']);
    const unmappedLine = pnl.sections
      .flatMap((s) => s.lines)
      .find((l) => l.code.startsWith('UNMAPPED'));
    expect(unmappedLine?.label).toMatch(/report definition incomplete/);
    expect(unmappedLine?.amounts.period.toString()).toBe('600.00000000');
  });

  it('refuses to compose at all under the REJECT policy, and says what to do', () => {
    expect(() =>
      composeProfitAndLoss({ rows: rows(), lines: PARTIAL, unmappedPolicy: 'REJECT' }),
    ).toThrow(/STATEMENT_ACCOUNT_UNMAPPED: 1 account\(s\).*5000 Cost of goods sold/s);
  });

  it('reports nothing when the definition is complete — the matching acceptance', () => {
    const complete: ProfitAndLossLineSpec[] = [
      ...PARTIAL,
      { code: 'COGS', label: 'Cost of sales', section: 'COST_OF_SALES', accountCodes: ['5000'] },
    ];
    const pnl = composeProfitAndLoss({ rows: rows(), lines: complete });
    expect(pnl.exceptions).toHaveLength(0);
    expect(pnl.definitionIsComplete).toBe(true);
    expect(pnl.result.period.toString()).toBe('0.00000000');
  });

  it('refuses a definition that maps one account to two lines', () => {
    const overlapping: ProfitAndLossLineSpec[] = [
      { code: 'A', label: 'A', section: 'OPERATING_EXPENSE', accountCodes: ['6010'] },
      {
        code: 'B',
        label: 'B',
        section: 'OPERATING_EXPENSE',
        accountCodeFrom: '6000',
        accountCodeTo: '6999',
      },
      { code: 'REV', label: 'Revenue', section: 'REVENUE', accountTypes: ['REVENUE'] },
      { code: 'C', label: 'C', section: 'COST_OF_SALES', accountCodes: ['5000'] },
    ];
    expect(() => composeProfitAndLoss({ rows: rows(), lines: overlapping })).toThrow(
      /STATEMENT_ACCOUNT_MAPPED_TWICE: account 6010 Rent matches 2 profit and loss lines \(A, B\)/,
    );
  });

  it('refuses a line whose section cannot hold the account type it selects', () => {
    const wrong: ProfitAndLossLineSpec[] = [
      { code: 'X', label: 'Misfiled', section: 'REVENUE', accountCodes: ['6010'] },
    ];
    expect(() => composeProfitAndLoss({ rows: rows(), lines: wrong })).toThrow(
      /STATEMENT_LINE_TYPE_MISMATCH: account 6010 Rent is a EXPENSE account/,
    );
  });

  it('refuses a line that selects nothing at all', () => {
    const empty: ProfitAndLossLineSpec[] = [{ code: 'X', label: 'Header', section: 'REVENUE' }];
    expect(() => composeProfitAndLoss({ rows: rows(), lines: empty })).toThrow(
      /STATEMENT_LINE_NO_SELECTOR: profit and loss line "X"/,
    );
  });

  it('refuses an inverted account range', () => {
    const inverted: ProfitAndLossLineSpec[] = [
      { code: 'X', label: 'X', section: 'REVENUE', accountCodeFrom: '4999', accountCodeTo: '4000' },
    ];
    expect(() => composeProfitAndLoss({ rows: rows(), lines: inverted })).toThrow(
      /STATEMENT_LINE_RANGE_INVERTED/,
    );
  });

  it('refuses two lines with the same code', () => {
    const duplicated: ProfitAndLossLineSpec[] = [
      { code: 'X', label: 'One', section: 'REVENUE', accountCodes: ['4000'] },
      { code: 'X', label: 'Two', section: 'REVENUE', accountCodes: ['4090'] },
    ];
    expect(() => composeProfitAndLoss({ rows: rows(), lines: duplicated })).toThrow(
      /STATEMENT_LINE_DUPLICATE_CODE/,
    );
  });
});

// ---------------------------------------------------------------------------
// Balance sheet and both retained-earnings methods (ADR-0001 §2)
// ---------------------------------------------------------------------------

describe('balance sheet', () => {
  it('balances, and nets a contra asset against its cost rather than adding it', () => {
    const rows = [
      row(PPE, { opening: w('10000'), period: NIL }),
      row(ACC_DEP, { opening: w('0', '4000'), period: w('0', '250'), yearToDate: w('0', '250') }),
      row(DEPRECIATION, { opening: NIL, period: w('250'), yearToDate: w('250') }),
      row(CAPITAL, { opening: w('0', '6000'), period: NIL }),
    ];
    const bs = composeBalanceSheet({ rows, retainedEarningsMethod: 'DERIVED' });
    // 10,000 cost less 4,250 accumulated. Signing by normal_balance would give 14,250.
    expect(bs.totalAssets.closing.toString()).toBe('5750.00000000');
    expect(bs.totalEquity.closing.toString()).toBe('5750.00000000');
    expect(bs.balances).toBe(true);
    expect(bs.difference.isZero()).toBe(true);
  });

  it('DERIVED: prior years sit in retained earnings, this year sits on its own line', () => {
    const bs = composeBalanceSheet({
      rows: tradingBook(),
      retainedEarningsMethod: 'DERIVED',
    });
    // Prior year profit of 1,000 never closed: it is derived into retained earnings.
    expect(bs.equity.priorYearResultsInProfitAndLoss.toString()).toBe('1000.00000000');
    expect(bs.equity.retainedEarningsAccount.toString()).toBe('0.00000000');
    expect(bs.equity.retainedEarnings.toString()).toBe('1000.00000000');
    // Year to date: revenue 800 less rent 250.
    expect(bs.equity.currentYearResult.toString()).toBe('550.00000000');
    expect(bs.equity.contributedAndOther.toString()).toBe('3000.00000000');
    expect(bs.totalEquity.closing.toString()).toBe('4550.00000000');
    expect(bs.balances).toBe(true);
    expect(bs.exceptions).toHaveLength(0);
  });

  it('DERIVED: presents the result of the year before any year-end close', () => {
    const bs = composeBalanceSheet({ rows: tradingBook(), retainedEarningsMethod: 'DERIVED' });
    const line = bs.sections
      .find((s) => s.section === 'EQUITY')
      ?.lines.find((l) => l.code === 'CURRENT_YEAR_RESULT');
    expect(line?.amounts.closing.toString()).toBe('550.00000000');
    expect(line?.amounts.movement.toString()).toBe('350.00000000');
    // Opening + movement = closing, on the synthetic line as much as any other.
    expect(line?.amounts.opening.add(line.amounts.movement).toString()).toBe(
      line?.amounts.closing.toString(),
    );
  });

  /**
   * The same book under CLOSING_JOURNAL, before and after
   * PERIOD_CLOSE_PNL_TRANSFER. Total equity and the result for the year must be
   * identical either side of the transfer — the journal moves money between two
   * equity presentations, it does not create or destroy any.
   */
  describe('CLOSING_JOURNAL', () => {
    // Prior years: 3,000 capital and 1,200 of closed profit, all in the bank.
    // Month 1: 1,500 of cash sales, 700 of rent. Month 2: 300 and 300.
    const beforeClose = (): TrialBalanceRow[] => [
      row(BANK, {
        opening: w('5700', '700'),
        period: w('300', '300'),
        yearToDate: w('1800', '1000'),
      }),
      row(CAPITAL, { opening: w('0', '3000'), period: NIL, yearToDate: NIL }),
      row(RETAINED, { opening: w('0', '1200'), period: NIL, yearToDate: NIL }),
      row(CURRENT_YEAR, { opening: NIL, period: NIL, yearToDate: NIL }),
      row(REVENUE, { opening: w('0', '1500'), period: w('0', '300'), yearToDate: w('0', '1800') }),
      row(RENT, { opening: w('700'), period: w('300'), yearToDate: w('1000') }),
    ];

    const afterClose = (): TrialBalanceRow[] => [
      row(BANK, {
        opening: w('5700', '700'),
        period: w('300', '300'),
        yearToDate: w('1800', '1000'),
      }),
      row(CAPITAL, { opening: w('0', '3000'), period: NIL, yearToDate: NIL }),
      row(RETAINED, { opening: w('0', '1200'), period: NIL, yearToDate: NIL }),
      // The transfer: Dr revenue 1,800 / Cr rent 1,000 / Cr current-year earnings 800.
      row(CURRENT_YEAR, { opening: NIL, period: w('0', '800'), yearToDate: w('0', '800') }),
      row(REVENUE, {
        opening: w('0', '1500'),
        period: w('1800', '300'),
        yearToDate: w('1800', '1800'),
      }),
      row(RENT, { opening: w('700'), period: w('300', '1000'), yearToDate: w('1000', '1000') }),
    ];

    it('presents the year result from the profit and loss accounts before the transfer', () => {
      const bs = composeBalanceSheet({
        rows: beforeClose(),
        retainedEarningsMethod: 'CLOSING_JOURNAL',
      });
      expect(bs.equity.currentYearResult.toString()).toBe('800.00000000');
      expect(bs.equity.currentYearEarningsTransfer.toString()).toBe('0.00000000');
      expect(bs.equity.retainedEarnings.toString()).toBe('1200.00000000');
      expect(bs.totalEquity.closing.toString()).toBe('5000.00000000');
      expect(bs.balances).toBe(true);
      expect(bs.exceptions).toHaveLength(0);
    });

    it('presents the same year result and the same total equity after the transfer', () => {
      const bs = composeBalanceSheet({
        rows: afterClose(),
        retainedEarningsMethod: 'CLOSING_JOURNAL',
      });
      expect(bs.equity.currentYearResult.toString()).toBe('800.00000000');
      expect(bs.equity.currentYearEarningsTransfer.toString()).toBe('800.00000000');
      expect(bs.equity.retainedEarnings.toString()).toBe('1200.00000000');
      expect(bs.totalEquity.closing.toString()).toBe('5000.00000000');
      expect(bs.balances).toBe(true);
      // The profit and loss accounts are now flat for the year, as they must be.
      const pnl = composeProfitAndLoss({ rows: afterClose() });
      expect(pnl.result.yearToDate.toString()).toBe('0.00000000');
      // …and the balance sheet still shows the 800, because it reads the transfer.
      const all = composeFinancialStatements({
        rows: afterClose(),
        retainedEarningsMethod: 'CLOSING_JOURNAL',
      });
      expect(all.tiesExactly).toBe(true);
    });

    it('reports a prior year that was never closed instead of absorbing it', () => {
      const rows = beforeClose();
      // Revenue's opening carries only the current year, so prior-year profit in
      // the profit and loss is nil. Add 400 of unclosed prior-year sales, banked.
      rows[4] = row(REVENUE, {
        opening: w('0', '1900'),
        period: w('0', '300'),
        yearToDate: w('0', '1800'),
      });
      rows[0] = row(BANK, {
        opening: w('6100', '700'),
        period: w('300', '300'),
        yearToDate: w('1800', '1000'),
      });
      const bs = composeBalanceSheet({ rows, retainedEarningsMethod: 'CLOSING_JOURNAL' });
      expect(bs.exceptions.map((e) => e.code)).toContain('PRIOR_YEAR_NOT_CLOSED');
      expect(bs.equity.priorYearResultsInProfitAndLoss.toString()).toBe('400.00000000');
      // Reported, and still presented: the balance sheet ties either way.
      expect(bs.balances).toBe(true);
    });

    it('reports a closing transfer that happened inside a DERIVED book', () => {
      const bs = composeBalanceSheet({
        rows: afterClose(),
        retainedEarningsMethod: 'DERIVED',
      });
      expect(bs.exceptions.map((e) => e.code)).toContain('CLOSING_TRANSFER_IN_DERIVED_BOOK');
      expect(bs.balances).toBe(true);
    });

    it('reports a book with no retained-earnings account identified', () => {
      const rows = beforeClose().filter((r) => r.account.code !== '3100');
      rows.push(row(account('3199', 'Reserves', 'EQUITY'), { opening: w('0', '1200') }));
      const bs = composeBalanceSheet({ rows, retainedEarningsMethod: 'CLOSING_JOURNAL' });
      expect(bs.exceptions.map((e) => e.code)).toContain(
        'RETAINED_EARNINGS_ACCOUNT_NOT_IDENTIFIED',
      );
      // The acceptance half is every other test in this block: with 3100 marked,
      // no such exception is raised.
      const clean = composeBalanceSheet({
        rows: beforeClose(),
        retainedEarningsMethod: 'CLOSING_JOURNAL',
      });
      expect(clean.exceptions).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Cash flow — classification-based direct method
// ---------------------------------------------------------------------------

describe('cash flow', () => {
  /**
   * Opening cash 1,000. In the period: 200 received from a customer, 150 rent
   * paid, 600 spent on equipment, 700 drawn on a loan.
   */
  const rows = (): TrialBalanceRow[] => [
    row(BANK, { opening: w('1000'), period: w('900', '750'), yearToDate: w('900', '750') }),
    row(AR, { opening: w('500'), period: w('0', '200'), yearToDate: w('0', '200') }),
    row(PPE, { opening: w('2000'), period: w('600'), yearToDate: w('600') }),
    row(LOAN, { opening: NIL, period: w('0', '700'), yearToDate: w('0', '700') }),
    row(RENT, { opening: NIL, period: w('150'), yearToDate: w('150') }),
    row(CAPITAL, { opening: w('0', '3500'), period: NIL, yearToDate: NIL }),
  ];

  it('classifies derived cash movements and reconciles beginning + movement = ending', () => {
    const cf = composeCashFlow({ rows: rows() });
    expect(cf.method).toBe('DIRECT_CLASSIFICATION');
    expect(cf.openingCash.toString()).toBe('1000.00000000');
    expect(cf.closingCash.toString()).toBe('1150.00000000');
    // 200 collected less 150 rent paid.
    expect(cf.operating.toString()).toBe('50.00000000');
    expect(cf.investing.toString()).toBe('-600.00000000');
    expect(cf.financing.toString()).toBe('700.00000000');
    expect(cf.netMovementClassified.toString()).toBe('150.00000000');
    expect(cf.cashMovement.toString()).toBe('150.00000000');
    expect(cf.unclassifiedMovement.toString()).toBe('0.00000000');
    expect(cf.difference.isZero()).toBe(true);
    expect(cf.reconciles).toBe(true);
    expect(cf.exceptions).toHaveLength(0);
  });

  it('drills each section down to the accounts that produced it', () => {
    const cf = composeCashFlow({ rows: rows() });
    const operating = cf.sections.find((s) => s.classification === 'OPERATING');
    expect(operating?.accounts.map((a) => a.code).sort()).toEqual(['1100', '6010']);
    expect(operating?.accounts.find((a) => a.code === '1100')?.amount.toString()).toBe(
      '200.00000000',
    );
    expect(cf.cashAccounts.map((a) => a.code)).toEqual(['1010']);
  });

  it('reports an account with a NULL classification instead of quietly excluding it', () => {
    const r = rows();
    // Rent with no classification at all — the NULL case, not the 'NONE' case.
    r[4] = row(account('6010', 'Rent', 'EXPENSE', { cashFlow: null }), {
      opening: NIL,
      period: w('150'),
      yearToDate: w('150'),
    });
    const cf = composeCashFlow({ rows: r });
    expect(cf.exceptions).toHaveLength(1);
    expect(cf.exceptions[0]?.code).toBe('CASH_FLOW_ACCOUNT_UNCLASSIFIED');
    expect(cf.exceptions[0]?.message).toMatch(/it is null/);
    expect(cf.unclassifiedMovement.toString()).toBe('-150.00000000');
    expect(cf.operating.toString()).toBe('200.00000000');
    // The identity still holds — nothing was dropped, it was set aside visibly.
    expect(cf.netMovementClassified.add(cf.unclassifiedMovement).toString()).toBe(
      cf.cashMovement.toString(),
    );
    // …but the statement does not claim to reconcile.
    expect(cf.reconciles).toBe(false);
  });

  it('treats an explicit NONE exactly as it treats a NULL', () => {
    const r = rows();
    r[4] = row(account('6010', 'Rent', 'EXPENSE', { cashFlow: 'NONE' }), {
      opening: NIL,
      period: w('150'),
      yearToDate: w('150'),
    });
    const cf = composeCashFlow({ rows: r });
    expect(cf.exceptions.map((e) => e.code)).toEqual(['CASH_FLOW_ACCOUNT_UNCLASSIFIED']);
    expect(cf.reconciles).toBe(false);
  });

  it('does not report an unclassified account that did not move', () => {
    const r = rows();
    r.push(row(account('6099', 'Dormant', 'EXPENSE', { cashFlow: null }), { opening: NIL }));
    const cf = composeCashFlow({ rows: r });
    expect(cf.exceptions).toHaveLength(0);
    expect(cf.reconciles).toBe(true);
    // Present in the unclassified list all the same, with a zero effect.
    expect(cf.unclassifiedAccounts.map((a) => a.code)).toContain('6099');
  });

  it('refuses to present a cash flow with a hole in it under the REJECT policy', () => {
    const r = rows();
    r[4] = row(account('6010', 'Rent', 'EXPENSE', { cashFlow: null }), {
      opening: NIL,
      period: w('150'),
      yearToDate: w('150'),
    });
    expect(() => composeCashFlow({ rows: r, unclassifiedPolicy: 'REJECT' })).toThrow(
      /CASH_FLOW_ACCOUNT_UNCLASSIFIED: 1 account\(s\) moved cash/,
    );
  });

  describe('controlled overrides (doc 12)', () => {
    it('applies an override and records the reason with the amount', () => {
      const cf = composeCashFlow({
        rows: rows(),
        overrides: [
          {
            accountId: 'acct-6010',
            classification: 'FINANCING',
            reason: 'Lease rentals reclassified to financing under IFRS 16',
          },
        ],
      });
      expect(cf.operating.toString()).toBe('200.00000000');
      expect(cf.financing.toString()).toBe('550.00000000');
      expect(cf.reconciles).toBe(true);
      const moved = cf.sections
        .find((s) => s.classification === 'FINANCING')
        ?.accounts.find((a) => a.code === '6010');
      expect(moved?.overridden).toBe(true);
      expect(moved?.overrideReason).toMatch(/IFRS 16/);
    });

    it('classifies an otherwise unclassified account, and then it reconciles', () => {
      const r = rows();
      r[4] = row(account('6010', 'Rent', 'EXPENSE', { cashFlow: null }), {
        opening: NIL,
        period: w('150'),
        yearToDate: w('150'),
      });
      const cf = composeCashFlow({
        rows: r,
        overrides: [
          { accountId: 'acct-6010', classification: 'OPERATING', reason: 'Rent is operating' },
        ],
      });
      expect(cf.exceptions).toHaveLength(0);
      expect(cf.reconciles).toBe(true);
      expect(cf.operating.toString()).toBe('50.00000000');
    });

    it('refuses an override with no reason', () => {
      expect(() =>
        composeCashFlow({
          rows: rows(),
          overrides: [{ accountId: 'acct-6010', classification: 'FINANCING', reason: '   ' }],
        }),
      ).toThrow(/CASH_FLOW_OVERRIDE_WITHOUT_REASON/);
    });

    it('refuses an override naming an account that is not in the trial balance', () => {
      expect(() =>
        composeCashFlow({
          rows: rows(),
          overrides: [{ accountId: 'acct-9999', classification: 'FINANCING', reason: 'why not' }],
        }),
      ).toThrow(/CASH_FLOW_OVERRIDE_UNKNOWN_ACCOUNT/);
    });

    it('refuses an override on a cash account, which could never apply', () => {
      expect(() =>
        composeCashFlow({
          rows: rows(),
          overrides: [{ accountId: 'acct-1010', classification: 'FINANCING', reason: 'bank' }],
        }),
      ).toThrow(/CASH_FLOW_OVERRIDE_ON_CASH_ACCOUNT/);
    });

    it('refuses two overrides on one account', () => {
      expect(() =>
        composeCashFlow({
          rows: rows(),
          overrides: [
            { accountId: 'acct-6010', classification: 'FINANCING', reason: 'one' },
            { accountId: 'acct-6010', classification: 'INVESTING', reason: 'two' },
          ],
        }),
      ).toThrow(/CASH_FLOW_OVERRIDE_DUPLICATE/);
    });
  });

  it('reconciles over the year-to-date window as well as the period', () => {
    const r = rows().map((x) =>
      row(x.account, {
        opening: x.opening,
        period: x.period,
        // Year to date is the period plus an earlier month: 100 more collected.
        yearToDate:
          x.account.code === '1010'
            ? w('1000', '750')
            : x.account.code === '1100'
              ? w('0', '300')
              : x.yearToDate,
      }),
    );
    const cf = composeCashFlow({ rows: r, window: 'YEAR_TO_DATE' });
    expect(cf.window).toBe('YEAR_TO_DATE');
    expect(cf.closingCash.toString()).toBe('1150.00000000');
    expect(cf.openingCash.toString()).toBe('900.00000000');
    expect(cf.cashMovement.toString()).toBe('250.00000000');
    expect(cf.operating.toString()).toBe('150.00000000');
    expect(cf.reconciles).toBe(true);
  });

  it('reports zero cash and a zero movement for a book with no cash accounts', () => {
    const r = [
      row(AR, { opening: w('100'), period: w('50'), yearToDate: w('50') }),
      row(REVENUE, { opening: w('0', '100'), period: w('0', '50'), yearToDate: w('0', '50') }),
    ];
    const cf = composeCashFlow({ rows: r });
    expect(cf.openingCash.toString()).toBe('0.00000000');
    expect(cf.closingCash.toString()).toBe('0.00000000');
    expect(cf.netMovementClassified.toString()).toBe('0.00000000');
    expect(cf.reconciles).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The whole set, and the tie checks
// ---------------------------------------------------------------------------

describe('composeFinancialStatements', () => {
  it('ties the three statements to the trial balance and to each other', () => {
    const statements = composeFinancialStatements({
      rows: tradingBook(),
      retainedEarningsMethod: 'DERIVED',
    });
    expect(statements.ties.map((t) => t.name)).toEqual([
      'BALANCE_SHEET_BALANCES',
      'BALANCE_SHEET_TIES_TO_TRIAL_BALANCE',
      'PROFIT_AND_LOSS_TIES_TO_TRIAL_BALANCE',
      'EQUITY_ROLL_FORWARD',
      'EQUITY_ANALYSIS',
      'CURRENT_YEAR_RESULT_TIES_TO_PROFIT_AND_LOSS',
      'CASH_FLOW_RECONCILES',
    ]);
    expect(statements.ties.every((t) => t.ties)).toBe(true);
    expect(statements.tiesExactly).toBe(true);
    expect(() => assertStatementsTie(statements)).not.toThrow();
  });

  it('the equity roll-forward explains the movement with the result for the period', () => {
    const statements = composeFinancialStatements({
      rows: tradingBook(),
      retainedEarningsMethod: 'DERIVED',
    });
    const rf = statements.balanceSheet.equityRollForward;
    expect(rf.profitAndLossForPeriod.toString()).toBe(
      statements.profitAndLoss.result.period.toString(),
    );
    expect(rf.opening.add(rf.profitAndLossForPeriod).add(rf.equityAccountMovement).toString()).toBe(
      rf.closing.toString(),
    );
  });

  it('assertStatementsTie throws — and is capable of throwing', () => {
    // A gate that cannot fail proves nothing, so this hands it a failing check.
    const statements = composeFinancialStatements({
      rows: tradingBook(),
      retainedEarningsMethod: 'DERIVED',
    });
    const doctored = {
      ...statements,
      tiesExactly: false,
      ties: [
        ...statements.ties,
        {
          name: 'FABRICATED',
          description: 'a check that does not hold',
          expected: D('0', MONEY_SCALE),
          actual: D('0.01', MONEY_SCALE),
          difference: D('0.01', MONEY_SCALE),
          ties: false,
        },
      ],
    };
    expect(() => assertStatementsTie(doctored)).toThrow(/STATEMENTS_DO_NOT_TIE: FABRICATED/);
    try {
      assertStatementsTie(doctored);
    } catch (e) {
      expect(AppError.isAppError(e)).toBe(true);
      expect((e as AppError).code).toBe('INTERNAL');
      // Internal invariant, so the caller gets the generic message, not this one.
      expect((e as AppError).safeToExpose).toBe(false);
    }
  });

  it('collects every statement exception in one place', () => {
    const rows = tradingBook();
    const statements = composeFinancialStatements({
      rows,
      retainedEarningsMethod: 'DERIVED',
      profitAndLossLines: [
        { code: 'REV', label: 'Revenue', section: 'REVENUE', accountCodes: ['4000'] },
      ],
    });
    // Rent is unmapped in the profit and loss; the bank has no classification.
    const codes = statements.exceptions.map((e) => e.code);
    expect(codes).toContain('ACCOUNT_UNMAPPED');
    expect(statements.tiesExactly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Property: the statements tie to the trial balance, for any trial balance
// ---------------------------------------------------------------------------

/** Deterministic PRNG — a failing case must be reproducible from the seed alone. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

interface GeneratedAccount {
  readonly account: StatementAccount;
  readonly index: number;
}

describe('property: the statements tie to the trial balance exactly', () => {
  it('holds across 20,000 generated trial balances', () => {
    let composed = 0;
    let withUnmapped = 0;
    let withUnclassified = 0;
    let cashFlowReconciled = 0;
    let withComparative = 0;
    let withPriorYearNotClosed = 0;
    let withClosingTransfer = 0;
    let derivedBooks = 0;
    let closingJournalBooks = 0;

    for (let seed = 1; seed <= 20_000; seed++) {
      const next = rng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;

      const method: RetainedEarningsMethod = next() < 0.5 ? 'DERIVED' : 'CLOSING_JOURNAL';
      if (method === 'DERIVED') derivedBooks++;
      else closingJournalBooks++;

      // --- chart ----------------------------------------------------------
      const accounts: GeneratedAccount[] = [];
      const push = (
        code: string,
        name: string,
        type: AccountTypeCode,
        options: AccountOptions = {},
      ) => {
        accounts.push({ account: account(code, name, type, options), index: accounts.length });
      };
      const classification = (): CashFlowClassification | null => {
        const roll = next();
        if (roll < 0.4) return 'OPERATING';
        if (roll < 0.6) return 'INVESTING';
        if (roll < 0.8) return 'FINANCING';
        // The two shapes of "unclassified" — an explicit NONE and a NULL — in
        // equal measure, because the NULL is the one that compares as passing.
        return roll < 0.9 ? 'NONE' : null;
      };

      const cashCount = 1 + Math.floor(next() * 2);
      for (let i = 0; i < cashCount; i++) {
        push(`10${10 + i}`, `Bank ${i}`, 'ASSET', { isCash: true });
      }
      const otherAssets = 1 + Math.floor(next() * 3);
      for (let i = 0; i < otherAssets; i++) {
        push(`1${200 + i * 10}`, `Asset ${i}`, 'ASSET', {
          cashFlow: classification(),
          // One contra asset, so the type-signing rule is exercised constantly.
          normalBalance: i === 0 && next() < 0.3 ? 'CREDIT' : 'DEBIT',
        });
      }
      const liabilities = 1 + Math.floor(next() * 3);
      for (let i = 0; i < liabilities; i++) {
        push(`2${100 + i * 10}`, `Liability ${i}`, 'LIABILITY', { cashFlow: classification() });
      }
      push('3000', 'Share capital', 'EQUITY', { cashFlow: classification() });
      const hasRetained = next() < 0.8;
      if (hasRetained) {
        push('3100', 'Retained earnings', 'EQUITY', { equityRole: 'RETAINED_EARNINGS' });
      }
      const hasCurrentYear = next() < 0.6;
      if (hasCurrentYear) {
        push('3110', 'Current year earnings', 'EQUITY', { equityRole: 'CURRENT_YEAR_EARNINGS' });
      }
      const revenues = 1 + Math.floor(next() * 3);
      for (let i = 0; i < revenues; i++) {
        push(`4${100 + i * 10}`, `Revenue ${i}`, 'REVENUE', { cashFlow: classification() });
      }
      const expenses = 1 + Math.floor(next() * 3);
      for (let i = 0; i < expenses; i++) {
        push(`6${100 + i * 10}`, `Expense ${i}`, 'EXPENSE', { cashFlow: classification() });
      }

      const isPnl = (a: GeneratedAccount) =>
        a.account.accountType === 'REVENUE' || a.account.accountType === 'EXPENSE';
      const balanceSheetAccounts = accounts.filter((a) => !isPnl(a));

      // --- movements ------------------------------------------------------
      // Four windows built from balanced entries, which is the only way a real
      // trial balance is ever built: every amount debits one account and credits
      // another, so the columns balance by construction rather than by a plug.
      const columns = accounts.map(() => ({
        priorDebit: Decimal.zero(MONEY_SCALE),
        priorCredit: Decimal.zero(MONEY_SCALE),
        earlierDebit: Decimal.zero(MONEY_SCALE),
        earlierCredit: Decimal.zero(MONEY_SCALE),
        periodDebit: Decimal.zero(MONEY_SCALE),
        periodCredit: Decimal.zero(MONEY_SCALE),
        comparativeDebit: Decimal.zero(MONEY_SCALE),
        comparativeCredit: Decimal.zero(MONEY_SCALE),
      }));

      const amount = (): Decimal => {
        const units = BigInt(Math.floor(next() * 5_000_00));
        // Every tenth amount carries the full numeric(24,8) scale, because a
        // rounding bug hides perfectly behind two decimal places.
        return next() < 0.1
          ? D(units.toString(), 0).div(D('1000000'), MONEY_SCALE)
          : D(units.toString(), 0).div(D('100'), 2).rescale(MONEY_SCALE);
      };
      const post = (
        window: 'prior' | 'earlier' | 'period' | 'comparative',
        debit: GeneratedAccount,
        credit: GeneratedAccount,
        value: Decimal,
      ) => {
        const d = columns[debit.index];
        const c = columns[credit.index];
        if (!d || !c) return;
        if (window === 'prior') {
          d.priorDebit = d.priorDebit.add(value);
          c.priorCredit = c.priorCredit.add(value);
        } else if (window === 'earlier') {
          d.earlierDebit = d.earlierDebit.add(value);
          c.earlierCredit = c.earlierCredit.add(value);
        } else if (window === 'period') {
          d.periodDebit = d.periodDebit.add(value);
          c.periodCredit = c.periodCredit.add(value);
        } else {
          d.comparativeDebit = d.comparativeDebit.add(value);
          c.comparativeCredit = c.comparativeCredit.add(value);
        }
      };

      // Prior fiscal years. A CLOSING_JOURNAL book that closed properly has no
      // profit-and-loss balance left from before this year; half of them here
      // did not, so the exception path is exercised too.
      const priorTouchesPnl = method === 'DERIVED' || next() < 0.5;
      const priorPool = priorTouchesPnl ? accounts : balanceSheetAccounts;
      for (let i = 0; i < 1 + Math.floor(next() * 4); i++) {
        post('prior', pick(priorPool), pick(priorPool), amount());
      }
      // Earlier months of the current fiscal year, then the reporting period.
      for (let i = 0; i < 1 + Math.floor(next() * 4); i++) {
        post('earlier', pick(accounts), pick(accounts), amount());
      }
      for (let i = 0; i < 1 + Math.floor(next() * 5); i++) {
        post('period', pick(accounts), pick(accounts), amount());
      }
      // A year-end closing transfer, in the books that post one.
      const currentYearAccount = accounts.find(
        (a) => a.account.equityRole === 'CURRENT_YEAR_EARNINGS',
      );
      const revenueAccount = accounts.find((a) => a.account.accountType === 'REVENUE');
      const transfers =
        currentYearAccount !== undefined && revenueAccount !== undefined && next() < 0.3;
      if (transfers && currentYearAccount && revenueAccount) {
        post('earlier', revenueAccount, currentYearAccount, amount());
        withClosingTransfer++;
      }
      const comparative = next() < 0.5;
      if (comparative) {
        withComparative++;
        for (let i = 0; i < 1 + Math.floor(next() * 4); i++) {
          post('comparative', pick(accounts), pick(accounts), amount());
        }
      }

      const rows: TrialBalanceRow[] = accounts.map((a) => {
        const c = columns[a.index]!;
        const base: TrialBalanceRow = {
          account: a.account,
          opening: {
            debit: c.priorDebit.add(c.earlierDebit),
            credit: c.priorCredit.add(c.earlierCredit),
          },
          period: { debit: c.periodDebit, credit: c.periodCredit },
          yearToDate: {
            debit: c.earlierDebit.add(c.periodDebit),
            credit: c.earlierCredit.add(c.periodCredit),
          },
        };
        return comparative
          ? { ...base, comparative: { debit: c.comparativeDebit, credit: c.comparativeCredit } }
          : base;
      });

      // --- definitions ----------------------------------------------------
      // Half the runs use a deliberately partial definition, so the unmapped
      // path is exercised by the property and not only by its own example.
      const partial = next() < 0.5;
      const pnlLines: ProfitAndLossLineSpec[] | undefined = partial
        ? [
            {
              code: 'REV',
              label: 'Revenue',
              section: 'REVENUE',
              accountCodes: [
                accounts.find((a) => a.account.accountType === 'REVENUE')!.account.code,
              ],
            },
            {
              code: 'OPEX',
              label: 'Operating expenses',
              section: 'OPERATING_EXPENSE',
              accountCodes: [
                accounts.find((a) => a.account.accountType === 'EXPENSE')!.account.code,
              ],
            },
          ]
        : undefined;
      const bsLines: BalanceSheetLineSpec[] | undefined = partial
        ? [
            {
              code: 'CA',
              label: 'Current assets',
              section: 'CURRENT_ASSET',
              accountCodeFrom: '1000',
              accountCodeTo: '1099',
            },
            { code: 'EQ', label: 'Equity', section: 'EQUITY', accountTypes: ['EQUITY'] },
          ]
        : undefined;

      const statements = composeFinancialStatements({
        rows,
        retainedEarningsMethod: method,
        ...(pnlLines ? { profitAndLossLines: pnlLines } : {}),
        ...(bsLines ? { balanceSheetLines: bsLines } : {}),
      });
      composed++;

      const where = `seed ${seed} (${method}${partial ? ', partial definition' : ''})`;

      // 1. Every tie check, exactly. This is the Phase 6 exit criterion.
      for (const check of statements.ties) {
        expect(check.difference.toString(), `${where}: ${check.name} — ${check.description}`).toBe(
          '0.00000000',
        );
      }
      expect(statements.tiesExactly, where).toBe(true);
      expect(() => assertStatementsTie(statements)).not.toThrow();

      // 2. Assets − liabilities − equity = 0, to the cent, from the composed lines.
      const bs = statements.balanceSheet;
      expect(bs.difference.toString(), `${where}: balance sheet`).toBe('0.00000000');
      expect(bs.balances, where).toBe(true);

      // 3. Recomputed from the raw rows by a path that never touches the mapping.
      const direct = (
        types: readonly AccountTypeCode[],
        pickWindow: (r: TrialBalanceRow) => TrialBalanceWindow,
      ) =>
        rows
          .filter((r) => types.includes(r.account.accountType))
          .reduce<Decimal>(
            (acc, r) => acc.add(pickWindow(r).debit).sub(pickWindow(r).credit),
            Decimal.zero(MONEY_SCALE),
          );
      const closingOf = (r: TrialBalanceRow) => ({
        debit: r.opening.debit.add(r.period.debit),
        credit: r.opening.credit.add(r.period.credit),
      });
      expect(bs.totalAssets.closing.toString(), `${where}: assets`).toBe(
        direct(['ASSET'], closingOf).toString(),
      );
      expect(bs.totalLiabilities.closing.toString(), `${where}: liabilities`).toBe(
        direct(['LIABILITY'], closingOf).negate().toString(),
      );
      expect(bs.totalEquity.closing.toString(), `${where}: equity`).toBe(
        direct(['EQUITY', 'REVENUE', 'EXPENSE'], closingOf).negate().toString(),
      );
      expect(
        statements.profitAndLoss.result.yearToDate.toString(),
        `${where}: year-to-date result`,
      ).toBe(
        direct(['REVENUE', 'EXPENSE'], (r) => r.yearToDate)
          .negate()
          .toString(),
      );
      expect(statements.profitAndLoss.result.period.toString(), `${where}: period result`).toBe(
        direct(['REVENUE', 'EXPENSE'], (r) => r.period)
          .negate()
          .toString(),
      );

      // 4. The P&L result equals the movement in retained earnings plus the
      //    current-year result: equity moved by exactly the period's profit and
      //    whatever the equity accounts themselves did.
      const rollForward = bs.equityRollForward;
      expect(
        rollForward.opening
          .add(rollForward.profitAndLossForPeriod)
          .add(rollForward.equityAccountMovement)
          .toString(),
        `${where}: equity roll-forward`,
      ).toBe(rollForward.closing.toString());
      expect(rollForward.profitAndLossForPeriod.toString(), `${where}: result for the period`).toBe(
        statements.profitAndLoss.result.period.toString(),
      );

      // 5. No account is dropped and none is counted twice — the failure that a
      //    balancing statement hides for exactly as long as the account nets to zero.
      const presented = [
        ...statements.profitAndLoss.accounts.map((a) => a.accountId),
        ...bs.accounts.map((a) => a.accountId),
      ].sort();
      expect(presented, `${where}: every account presented exactly once`).toEqual(
        rows.map((r) => r.account.accountId).sort(),
      );

      // 6. Sections sum to the totals they claim to summarise.
      const sectionSum = statements.profitAndLoss.sections.reduce<Decimal>(
        (acc, s) =>
          s.section === 'REVENUE' || s.section === 'OTHER_INCOME'
            ? acc.add(s.amounts.yearToDate)
            : acc.sub(s.amounts.yearToDate),
        Decimal.zero(MONEY_SCALE),
      );
      expect(sectionSum.toString(), `${where}: profit and loss sections`).toBe(
        statements.profitAndLoss.result.yearToDate.toString(),
      );

      // 7. Cash flow: beginning + movement = ending, with the unexplained part
      //    named rather than folded into a total.
      const cf = statements.cashFlow;
      expect(
        cf.openingCash.add(cf.netMovementClassified).add(cf.unclassifiedMovement).toString(),
        `${where}: cash flow`,
      ).toBe(cf.closingCash.toString());
      expect(cf.reconciles, `${where}: reconciles iff nothing is unclassified`).toBe(
        cf.unclassifiedMovement.isZero() && cf.difference.isZero(),
      );

      // --- branch counters -------------------------------------------------
      const codes = statements.exceptions.map((e) => e.code);
      if (codes.includes('ACCOUNT_UNMAPPED')) {
        withUnmapped++;
        // Every unmapped account is still presented somewhere.
        for (const exception of statements.exceptions) {
          if (exception.code !== 'ACCOUNT_UNMAPPED') continue;
          expect(presented, `${where}: unmapped account still presented`).toContain(
            exception.accountId,
          );
        }
      }
      if (codes.includes('CASH_FLOW_ACCOUNT_UNCLASSIFIED')) withUnclassified++;
      if (codes.includes('PRIOR_YEAR_NOT_CLOSED')) withPriorYearNotClosed++;
      if (cf.reconciles) cashFlowReconciled++;
    }

    // A property that stopped generating interesting cases would still pass while
    // proving nothing. These assert that every branch was actually walked.
    expect(composed).toBe(20_000);
    expect(derivedBooks).toBeGreaterThan(5_000);
    expect(closingJournalBooks).toBeGreaterThan(5_000);
    expect(withComparative).toBeGreaterThan(5_000);
    expect(withUnmapped).toBeGreaterThan(5_000);
    expect(withUnclassified).toBeGreaterThan(1_000);
    expect(cashFlowReconciled).toBeGreaterThan(500);
    expect(withPriorYearNotClosed).toBeGreaterThan(500);
    expect(withClosingTransfer).toBeGreaterThan(500);
  });
});

describe('property: an account that maps to no line is always reported', () => {
  it('over 20,000 partial definitions, the exceptions name exactly the unmapped accounts', () => {
    for (let seed = 1; seed <= 20_000; seed++) {
      const next = rng(seed * 7919);
      const size = 2 + Math.floor(next() * 6);
      const rows: TrialBalanceRow[] = [];
      let assets = Decimal.zero(MONEY_SCALE);
      for (let i = 0; i < size; i++) {
        const units = BigInt(Math.floor(next() * 100_00));
        const value = D(units.toString(), 0).div(D('100'), 2).rescale(MONEY_SCALE);
        assets = assets.add(value);
        rows.push(
          row(account(`1${200 + i * 10}`, `Asset ${i}`, 'ASSET'), {
            opening: { debit: value, credit: Decimal.zero(MONEY_SCALE) },
          }),
        );
      }
      rows.push(row(CAPITAL, { opening: { debit: Decimal.zero(MONEY_SCALE), credit: assets } }));

      // Map a random subset of the asset accounts.
      const mapped = rows
        .filter((r) => r.account.accountType === 'ASSET' && next() < 0.5)
        .map((r) => r.account.code);
      const lines: BalanceSheetLineSpec[] = [
        { code: 'EQ', label: 'Equity', section: 'EQUITY', accountTypes: ['EQUITY'] },
        ...(mapped.length > 0
          ? [
              {
                code: 'CA',
                label: 'Current assets',
                section: 'CURRENT_ASSET' as const,
                accountCodes: mapped,
              },
            ]
          : []),
      ];

      const bs = composeBalanceSheet({ rows, retainedEarningsMethod: 'DERIVED', lines });
      const reported = bs.exceptions
        .filter((e) => e.code === 'ACCOUNT_UNMAPPED')
        .map((e) => e.accountCode)
        .sort();
      const expected = rows
        .filter((r) => r.account.accountType === 'ASSET' && !mapped.includes(r.account.code))
        .map((r) => r.account.code)
        .sort();
      expect(reported, `seed ${seed}`).toEqual(expected);
      // Reported AND still counted: total assets never depends on the definition.
      expect(bs.totalAssets.closing.toString(), `seed ${seed}`).toBe(assets.toString());
      expect(bs.balances, `seed ${seed}`).toBe(true);
      expect(bs.definitionIsComplete, `seed ${seed}`).toBe(expected.length === 0);
    }
  });
});

describe('helpers for the service layer', () => {
  it('builds a window from the strings a numeric(24,8) column produces', () => {
    const window = trialBalanceWindow('1234.56000000', '0.00000000');
    expect(window.debit.toString()).toBe('1234.56000000');
    expect(window.credit.toString()).toBe('0.00000000');
    const totals = trialBalanceTotals([
      row(BANK, { opening: window }),
      row(CAPITAL, { opening: trialBalanceWindow('0', '1234.56') }),
    ]);
    expect(totals.opening.balances).toBe(true);
  });

  it('does not round a value that is too precise for the ledger — it lets it be refused', () => {
    const window = trialBalanceWindow('0.000000001', '0');
    // Not silently zero: the value survives to the guard that names the problem.
    expect(window.debit.isZero()).toBe(false);
    expect(() => trialBalanceTotals([row(BANK, { opening: window })])).toThrow(
      /TRIAL_BALANCE_AMOUNT_PRECISION/,
    );
  });

  it('renders the three columns as wire-format strings', () => {
    const pnl = composeProfitAndLoss({
      rows: [
        row(REVENUE, { opening: NIL, period: w('0', '100'), comparative: w('0', '60') }),
        row(BANK, { opening: NIL, period: w('100'), comparative: w('60') }),
      ],
    });
    expect(statementAmountStrings(pnl.result)).toEqual({
      period: '100.00000000',
      comparative: '60.00000000',
      year_to_date: '100.00000000',
    });
    const noComparative = composeProfitAndLoss({
      rows: [
        row(REVENUE, { opening: NIL, period: w('0', '100') }),
        row(BANK, { opening: NIL, period: w('100') }),
      ],
    });
    expect(statementAmountStrings(noComparative.result).comparative).toBeNull();
  });
});

// The default definitions exist so that a caller with no report definition still
// gets a complete statement; if they ever stop covering a type, every account of
// that type becomes an exception rather than a silent omission — but they should
// not stop.
describe('default definitions', () => {
  it('cover every account type they are responsible for', () => {
    expect(DEFAULT_PROFIT_AND_LOSS_LINES.flatMap((l) => l.accountTypes ?? []).sort()).toEqual([
      'EXPENSE',
      'REVENUE',
    ]);
    expect(DEFAULT_BALANCE_SHEET_LINES.flatMap((l) => l.accountTypes ?? []).sort()).toEqual([
      'ASSET',
      'EQUITY',
      'LIABILITY',
    ]);
  });
});
