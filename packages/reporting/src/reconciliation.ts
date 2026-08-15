/**
 * Phase 6 exit criterion 1, measured: "Core statements tie exactly to Trial Balance."
 *
 * The Trial Balance in that sentence is the one Phase 2 ships —
 * `/reports/trial-balance`, `LedgerReportsService.trialBalance` — and it is a
 * different query, written by different people, against either the balance
 * projection or the raw journal lines. This file compares it, account by account
 * and column by column, with the trial balance the statements were actually
 * composed from.
 *
 * Comparing the statements with the rows they were built from would measure
 * nothing: it is the same numbers on both sides of the equals sign, and it would
 * report success about something it never checked. The comparison that means
 * something is against the OTHER implementation, and it is exposed on every
 * statement response rather than left for a caller to assemble — a criterion that
 * only holds when somebody remembers to check it is not a criterion.
 *
 * Three ways it can fail, all reported rather than absorbed:
 *
 *   1. a column differs for an account — the balance source disagrees with itself;
 *   2. an account is on one side and not the other with a non-zero balance —
 *      one of the two queries is dropping money;
 *   3. the resolved period windows differ — the two are not reporting the same
 *      months, which makes every other agreement a coincidence.
 */

import { D, Decimal, MONEY_SCALE } from '@acct/domain';
import type { TrialBalanceRow } from '@acct/domain';

const ZERO = Decimal.zero(MONEY_SCALE);

/** The Phase 2 trial balance row shape, exactly as `@acct/ledger` returns it. */
export interface LedgerTrialBalanceRow {
  account_id: string;
  account_code: string;
  account_name: string;
  opening_debit: string;
  opening_credit: string;
  period_debit: string;
  period_credit: string;
  closing_debit: string;
  closing_credit: string;
}

export interface LedgerTrialBalanceResult {
  accounting_book_id: string;
  source: string;
  period_from: string | null;
  period_to: string | null;
  data: readonly LedgerTrialBalanceRow[];
  totals: Record<string, string>;
  balances: boolean;
}

export type TrialBalanceColumn =
  | 'opening_debit'
  | 'opening_credit'
  | 'period_debit'
  | 'period_credit'
  | 'closing_debit'
  | 'closing_credit';

const COLUMNS: readonly TrialBalanceColumn[] = [
  'opening_debit',
  'opening_credit',
  'period_debit',
  'period_credit',
  'closing_debit',
  'closing_credit',
];

export interface ColumnDifference {
  readonly account_id: string;
  readonly account_code: string;
  readonly account_name: string;
  readonly column: TrialBalanceColumn;
  readonly trial_balance: string;
  readonly statement_input: string;
  readonly difference: string;
}

export interface TrialBalanceReconciliation {
  readonly checked: true;
  readonly source: string;
  readonly trial_balance_period_from: string | null;
  readonly trial_balance_period_to: string | null;
  readonly statement_period_from: string;
  readonly statement_period_to: string;
  readonly window_matches: boolean;
  readonly accounts_compared: number;
  readonly differences: readonly ColumnDifference[];
  readonly only_in_trial_balance: readonly string[];
  readonly only_in_statement_input: readonly string[];
  readonly totals: Record<
    TrialBalanceColumn,
    { trial_balance: string; statement_input: string; difference: string }
  >;
  readonly ties: boolean;
  readonly message: string;
}

/** The comparison was not run, and says so rather than reporting a silent `true`. */
export interface TrialBalanceReconciliationSkipped {
  readonly checked: false;
  readonly ties: null;
  readonly message: string;
}

function columnsOf(row: TrialBalanceRow): Record<TrialBalanceColumn, Decimal> {
  return {
    opening_debit: row.opening.debit,
    opening_credit: row.opening.credit,
    period_debit: row.period.debit,
    period_credit: row.period.credit,
    // The statement's closing is its opening plus its movement, by definition —
    // and comparing it with the trial balance's own closing column is what checks
    // the balance projection's roll-forward rather than assuming it.
    closing_debit: row.opening.debit.add(row.period.debit),
    closing_credit: row.opening.credit.add(row.period.credit),
  };
}

function ledgerColumnsOf(row: LedgerTrialBalanceRow): Record<TrialBalanceColumn, Decimal> {
  return {
    opening_debit: D(row.opening_debit, MONEY_SCALE),
    opening_credit: D(row.opening_credit, MONEY_SCALE),
    period_debit: D(row.period_debit, MONEY_SCALE),
    period_credit: D(row.period_credit, MONEY_SCALE),
    closing_debit: D(row.closing_debit, MONEY_SCALE),
    closing_credit: D(row.closing_credit, MONEY_SCALE),
  };
}

const allZero = (columns: Record<TrialBalanceColumn, Decimal>): boolean =>
  COLUMNS.every((c) => columns[c].isZero());

/**
 * Compares the two trial balances.
 *
 * A row present on only one side with every column zero is not a difference: the
 * Phase 2 report drops all-zero accounts by default and the statement loader
 * keeps every postable account so the report definition's coverage can be
 * checked. Both are correct, and neither loses money. A row present on only one
 * side with a NON-zero column is exactly the failure this exists to catch, and it
 * is listed by account rather than netted into a total.
 */
export function reconcileToTrialBalance(input: {
  readonly statementRows: readonly TrialBalanceRow[];
  readonly ledger: LedgerTrialBalanceResult;
  readonly statementPeriodFrom: string;
  readonly statementPeriodTo: string;
}): TrialBalanceReconciliation {
  const mine = new Map(input.statementRows.map((r) => [r.account.accountId, r]));
  const theirs = new Map(input.ledger.data.map((r) => [r.account_id, r]));

  const differences: ColumnDifference[] = [];
  const onlyInTrialBalance: string[] = [];
  const onlyInStatement: string[] = [];
  const totals = Object.fromEntries(
    COLUMNS.map((c) => [c, { ledger: ZERO, statement: ZERO }]),
  ) as Record<TrialBalanceColumn, { ledger: Decimal; statement: Decimal }>;

  const accountIds = new Set<string>([...mine.keys(), ...theirs.keys()]);
  for (const accountId of accountIds) {
    const row = mine.get(accountId);
    const ledgerRow = theirs.get(accountId);
    const statementColumns = row ? columnsOf(row) : null;
    const ledgerColumns = ledgerRow ? ledgerColumnsOf(ledgerRow) : null;

    if (statementColumns === null) {
      if (ledgerColumns !== null && !allZero(ledgerColumns)) {
        onlyInTrialBalance.push(ledgerRow!.account_code);
      }
    } else if (ledgerColumns === null) {
      if (!allZero(statementColumns)) onlyInStatement.push(row!.account.code);
    }

    for (const column of COLUMNS) {
      const statement = statementColumns?.[column] ?? ZERO;
      const ledger = ledgerColumns?.[column] ?? ZERO;
      totals[column].statement = totals[column].statement.add(statement);
      totals[column].ledger = totals[column].ledger.add(ledger);
      const difference = statement.sub(ledger);
      if (!difference.isZero()) {
        differences.push({
          account_id: accountId,
          account_code: row?.account.code ?? ledgerRow?.account_code ?? accountId,
          account_name: row?.account.name ?? ledgerRow?.account_name ?? '',
          column,
          trial_balance: ledger.toString(),
          statement_input: statement.toString(),
          difference: difference.toString(),
        });
      }
    }
  }

  const windowMatches =
    input.ledger.period_from === input.statementPeriodFrom &&
    input.ledger.period_to === input.statementPeriodTo;

  const ties =
    differences.length === 0 &&
    onlyInTrialBalance.length === 0 &&
    onlyInStatement.length === 0 &&
    windowMatches;

  const message = ties
    ? `Every account and every column of the ${input.ledger.source} trial balance for ` +
      `${input.statementPeriodFrom}..${input.statementPeriodTo} equals the trial balance these ` +
      `statements were composed from.`
    : [
        !windowMatches
          ? `The trial balance resolved the window as ${input.ledger.period_from}..` +
            `${input.ledger.period_to} and the statements resolved it as ` +
            `${input.statementPeriodFrom}..${input.statementPeriodTo}; they are not reporting ` +
            `the same periods, so every other agreement below is a coincidence.`
          : null,
        differences.length > 0
          ? `${differences.length} column(s) differ, starting with account ` +
            `${differences[0]!.account_code} ${differences[0]!.column} out by ` +
            `${differences[0]!.difference}.`
          : null,
        onlyInTrialBalance.length > 0
          ? `${onlyInTrialBalance.length} account(s) carry a balance in the trial balance and ` +
            `reach no statement: ${onlyInTrialBalance.slice(0, 10).join(', ')}.`
          : null,
        onlyInStatement.length > 0
          ? `${onlyInStatement.length} account(s) carry a balance in the statements and are ` +
            `absent from the trial balance: ${onlyInStatement.slice(0, 10).join(', ')}.`
          : null,
      ]
        .filter((line): line is string => line !== null)
        .join(' ');

  return {
    checked: true,
    source: input.ledger.source,
    trial_balance_period_from: input.ledger.period_from,
    trial_balance_period_to: input.ledger.period_to,
    statement_period_from: input.statementPeriodFrom,
    statement_period_to: input.statementPeriodTo,
    window_matches: windowMatches,
    accounts_compared: accountIds.size,
    differences,
    only_in_trial_balance: onlyInTrialBalance,
    only_in_statement_input: onlyInStatement,
    totals: Object.fromEntries(
      COLUMNS.map((c) => [
        c,
        {
          trial_balance: totals[c].ledger.toString(),
          statement_input: totals[c].statement.toString(),
          difference: totals[c].statement.sub(totals[c].ledger).toString(),
        },
      ]),
    ) as TrialBalanceReconciliation['totals'],
    ties,
    message,
  };
}
