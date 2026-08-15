import { describe, expect, it } from 'vitest';
import { D, MONEY_SCALE, type TrialBalanceRow } from '@acct/domain';
import { reconcileToTrialBalance, type LedgerTrialBalanceResult } from './reconciliation';

/**
 * The tie-to-trial-balance detector, both halves.
 *
 * A comparison that always reports `ties: true` is indistinguishable from one
 * that compares nothing, and it is exactly the shape of gate this codebase has
 * been burned by: `db:verify` reporting "13 privilege guards in force" while
 * checking three. So every ACCEPT below has a REJECT beside it, and each REJECT
 * breaks the input in one specific way and asserts the detector names that way.
 */

const window = (debit: string, credit: string) => ({
  debit: D(debit, MONEY_SCALE),
  credit: D(credit, MONEY_SCALE),
});

const row = (
  accountId: string,
  code: string,
  opening: [string, string],
  period: [string, string],
): TrialBalanceRow => ({
  account: {
    accountId,
    code,
    name: `Account ${code}`,
    accountType: 'ASSET',
    normalBalance: 'DEBIT',
  },
  opening: window(opening[0], opening[1]),
  period: window(period[0], period[1]),
  yearToDate: window(period[0], period[1]),
  comparative: null,
});

const ledgerRow = (
  accountId: string,
  code: string,
  opening: [string, string],
  period: [string, string],
  closing: [string, string],
) => ({
  account_id: accountId,
  account_code: code,
  account_name: `Account ${code}`,
  opening_debit: opening[0],
  opening_credit: opening[1],
  period_debit: period[0],
  period_credit: period[1],
  closing_debit: closing[0],
  closing_credit: closing[1],
});

const ledger = (data: ReturnType<typeof ledgerRow>[]): LedgerTrialBalanceResult => ({
  accounting_book_id: 'book',
  source: 'projection',
  period_from: '2026-03-01',
  period_to: '2026-03-31',
  data,
  totals: {},
  balances: true,
});

const compare = (
  statementRows: TrialBalanceRow[],
  ledgerResult: LedgerTrialBalanceResult,
  from = '2026-03-01',
  to = '2026-03-31',
) =>
  reconcileToTrialBalance({
    statementRows,
    ledger: ledgerResult,
    statementPeriodFrom: from,
    statementPeriodTo: to,
  });

describe('reconciling composed statements to the Phase 2 trial balance', () => {
  it('ties when both sides agree, and says how many accounts it actually compared', () => {
    const result = compare(
      [row('a1', '1000', ['100', '0'], ['50', '20'])],
      ledger([ledgerRow('a1', '1000', ['100', '0'], ['50', '20'], ['150', '20'])]),
    );
    expect(result.ties).toBe(true);
    expect(result.accounts_compared).toBe(1);
    expect(result.differences).toHaveLength(0);
    expect(result.message).toContain('equals');
  });

  it('catches a one-cent difference in a movement column and names the account and column', () => {
    const result = compare(
      [row('a1', '1000', ['100', '0'], ['50.01', '20'])],
      ledger([ledgerRow('a1', '1000', ['100', '0'], ['50', '20'], ['150', '20'])]),
    );
    expect(result.ties).toBe(false);
    // The period column differs, and so does the closing column derived from it.
    const columns = result.differences.map((d) => d.column).sort();
    expect(columns).toEqual(['closing_debit', 'period_debit']);
    expect(result.differences[0]!.account_code).toBe('1000');
    expect(result.message).toContain('1000');
  });

  it('catches a stale projection whose closing does not equal its own opening plus movement', () => {
    // Opening and period agree; the trial balance's stored closing does not.
    // Nothing else in the system compares those three, so this is the check.
    const result = compare(
      [row('a1', '1000', ['100', '0'], ['50', '0'])],
      ledger([ledgerRow('a1', '1000', ['100', '0'], ['50', '0'], ['140', '0'])]),
    );
    expect(result.ties).toBe(false);
    expect(result.differences.map((d) => d.column)).toEqual(['closing_debit']);
    expect(result.differences[0]!.difference).toBe(D('10', MONEY_SCALE).toString());
  });

  it('catches an account with a balance that reaches no statement', () => {
    const result = compare(
      [],
      ledger([ledgerRow('a1', '1000', ['100', '0'], ['0', '0'], ['100', '0'])]),
    );
    expect(result.ties).toBe(false);
    expect(result.only_in_trial_balance).toEqual(['1000']);
    expect(result.message).toContain('reach no statement');
  });

  it('catches an account with a balance that the trial balance does not have', () => {
    const result = compare([row('a1', '1000', ['100', '0'], ['0', '0'])], ledger([]));
    expect(result.ties).toBe(false);
    expect(result.only_in_statement_input).toEqual(['1000']);
  });

  it('does NOT report an all-zero account present on only one side', () => {
    // The Phase 2 report drops all-zero accounts by default and the statement
    // loader keeps every postable account so coverage can be checked. Both are
    // right, and neither loses money — so this must not be a difference, or the
    // check would be noisy enough to be turned off.
    const result = compare([row('a1', '1000', ['0', '0'], ['0', '0'])], ledger([]));
    expect(result.ties).toBe(true);
    expect(result.only_in_statement_input).toEqual([]);
  });

  it('refuses to call it a tie when the two sides resolved different periods', () => {
    const result = compare(
      [row('a1', '1000', ['100', '0'], ['50', '20'])],
      ledger([ledgerRow('a1', '1000', ['100', '0'], ['50', '20'], ['150', '20'])]),
      '2026-01-01',
      '2026-03-31',
    );
    expect(result.window_matches).toBe(false);
    expect(result.ties).toBe(false);
    expect(result.message).toContain('not reporting the same periods');
  });

  it('sums the column totals from both sides so a difference can be seen without reading every row', () => {
    const result = compare(
      [row('a1', '1000', ['100', '0'], ['50', '0']), row('a2', '1100', ['0', '0'], ['25', '0'])],
      ledger([
        ledgerRow('a1', '1000', ['100', '0'], ['50', '0'], ['150', '0']),
        ledgerRow('a2', '1100', ['0', '0'], ['25', '0'], ['25', '0']),
      ]),
    );
    expect(result.totals.period_debit.statement_input).toBe(D('75', MONEY_SCALE).toString());
    expect(result.totals.period_debit.trial_balance).toBe(D('75', MONEY_SCALE).toString());
    expect(result.totals.period_debit.difference).toBe(D('0', MONEY_SCALE).toString());
    expect(result.ties).toBe(true);
  });
});
