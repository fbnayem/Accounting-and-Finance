/**
 * Statement objects, on the wire.
 *
 * Every monetary value leaves as a decimal STRING (ADR-0006 §1). Nothing here
 * calls `Number()` or `parseFloat` on an amount, and nothing rounds: a statement
 * that ties to the cent stops tying the moment a figure passes through a float.
 *
 * The shapes are deliberately flat and complete rather than trimmed to what a
 * screen shows today. A statement response is what a snapshot is taken from
 * (doc 12, Gate E), and a field the response omits is a field the snapshot cannot
 * record.
 */

import type { Decimal } from '@acct/domain';
import type {
  BalanceAmounts,
  BalanceSheet,
  CashFlowAccountAmount,
  CashFlowStatement,
  FinancialStatements,
  ProfitAndLoss,
  StatementAmounts,
  StatementException,
  StatementTieCheck,
  TrialBalanceTotals,
  WindowTotals,
} from '@acct/domain';
import { realAccountId } from './trial-balance.loader';

const s = (d: Decimal): string => d.toString();
const sn = (d: Decimal | null): string | null => (d === null ? null : d.toString());

export const amounts = (a: StatementAmounts) => ({
  period: s(a.period),
  comparative: sn(a.comparative),
  year_to_date: s(a.yearToDate),
});

export const balances = (b: BalanceAmounts) => ({
  opening: s(b.opening),
  movement: s(b.movement),
  closing: s(b.closing),
});

export const windowTotals = (w: WindowTotals) => ({
  debit: s(w.debit),
  credit: s(w.credit),
  difference: s(w.difference),
  balances: w.balances,
});

export const trialBalanceTotals = (t: TrialBalanceTotals) => ({
  opening: windowTotals(t.opening),
  period: windowTotals(t.period),
  year_to_date: windowTotals(t.yearToDate),
  comparative: t.comparative === null ? null : windowTotals(t.comparative),
  closing: windowTotals(t.closing),
  account_count: t.accountCount,
});

export const exception = (e: StatementException) => ({
  code: e.code,
  message: e.message,
  account_id: e.accountId ?? null,
  account_code: e.accountCode ?? null,
  amount: e.amount === undefined ? null : s(e.amount),
});

export const tieCheck = (t: StatementTieCheck) => ({
  name: t.name,
  description: t.description,
  expected: s(t.expected),
  actual: s(t.actual),
  difference: s(t.difference),
  ties: t.ties,
});

/**
 * A drill token: everything `/reports/drill-down` needs to explain this figure.
 *
 * Attached to every line and every account of every statement, so exit criterion
 * 2 — "every financial report amount can drill to ledger lines" — is answerable
 * without the caller reconstructing the parameters from the request it made. A
 * drill the caller has to assemble is a drill that is one forgotten parameter
 * away from explaining a different number than the one on the page.
 */
export interface DrillToken {
  /** The column of the statement this token explains. */
  readonly explains: string;
  readonly accounting_book_id: string;
  /** Null means "from the start of the calendar" — what a closing balance is. */
  readonly period_from: string | null;
  readonly period_to: string;
  readonly account_ids: readonly string[];
  readonly report_definition_id: string | null;
  readonly row_no: number | null;
}

/**
 * One token per column, because one token cannot explain three numbers.
 *
 * A profit-and-loss line shows a period figure and a year-to-date figure over
 * different windows, and a balance sheet line shows an opening balance, a
 * movement and a closing balance over three more. A single drill link beside all
 * of them explains one of them and silently mis-explains the rest — which is the
 * same failure as a truncated drill, wearing a different hat.
 */
export type DrillTokens = Readonly<Record<string, DrillToken>>;

export type DrillBuilder = (accountIds: readonly string[], rowNo: number | null) => DrillTokens;

export const profitAndLoss = (pnl: ProfitAndLoss, drill: DrillBuilder) => ({
  sections: pnl.sections.map((section) => ({
    section: section.section,
    label: section.label,
    amounts: amounts(section.amounts),
    lines: section.lines.map((line) => ({
      code: line.code,
      label: line.label,
      section: line.section,
      sort_order: line.sortOrder,
      amounts: amounts(line.amounts),
      accounts: line.accounts.map((account) => ({
        account_id: account.accountId,
        account_code: account.code,
        account_name: account.name,
        account_type: account.accountType,
        line_code: account.lineCode,
        amounts: amounts(account.amounts),
        drill: drill([account.accountId], null),
      })),
      drill: drill(
        line.accounts.map((a) => a.accountId),
        null,
      ),
    })),
    drill: drill(
      section.lines.flatMap((l) => l.accounts.map((a) => a.accountId)),
      null,
    ),
  })),
  revenue: amounts(pnl.revenue),
  cost_of_sales: amounts(pnl.costOfSales),
  gross_profit: amounts(pnl.grossProfit),
  operating_expense: amounts(pnl.operatingExpense),
  operating_result: amounts(pnl.operatingResult),
  other_income: amounts(pnl.otherIncome),
  other_expense: amounts(pnl.otherExpense),
  tax_expense: amounts(pnl.taxExpense),
  result: amounts(pnl.result),
  accounts: pnl.accounts.map((account) => ({
    account_id: account.accountId,
    account_code: account.code,
    account_name: account.name,
    account_type: account.accountType,
    line_code: account.lineCode,
    amounts: amounts(account.amounts),
    drill: drill([account.accountId], null),
  })),
  has_comparative: pnl.hasComparative,
  definition_is_complete: pnl.definitionIsComplete,
  exceptions: pnl.exceptions.map(exception),
});

export const balanceSheet = (bs: BalanceSheet, drill: DrillBuilder) => ({
  retained_earnings_method: bs.method,
  sections: bs.sections.map((section) => ({
    section: section.section,
    label: section.label,
    amounts: balances(section.amounts),
    lines: section.lines.map((line) => ({
      code: line.code,
      label: line.label,
      section: line.section,
      sort_order: line.sortOrder,
      amounts: balances(line.amounts),
      accounts: line.accounts.map((account) => ({
        account_id: account.accountId,
        account_code: account.code,
        account_name: account.name,
        account_type: account.accountType,
        line_code: account.lineCode,
        amounts: balances(account.amounts),
        drill: drill([account.accountId], null),
      })),
      drill: drill(
        line.accounts.map((a) => a.accountId),
        null,
      ),
    })),
  })),
  total_assets: balances(bs.totalAssets),
  total_liabilities: balances(bs.totalLiabilities),
  total_equity: balances(bs.totalEquity),
  equity: {
    method: bs.equity.method,
    contributed_and_other: s(bs.equity.contributedAndOther),
    retained_earnings: s(bs.equity.retainedEarnings),
    retained_earnings_account: s(bs.equity.retainedEarningsAccount),
    prior_year_results_in_profit_and_loss: s(bs.equity.priorYearResultsInProfitAndLoss),
    prior_year_results_in_current_year_earnings: s(bs.equity.priorYearResultsInCurrentYearEarnings),
    current_year_result: s(bs.equity.currentYearResult),
    current_year_earnings_transfer: s(bs.equity.currentYearEarningsTransfer),
  },
  equity_roll_forward: {
    opening: s(bs.equityRollForward.opening),
    profit_and_loss_for_period: s(bs.equityRollForward.profitAndLossForPeriod),
    equity_account_movement: s(bs.equityRollForward.equityAccountMovement),
    closing: s(bs.equityRollForward.closing),
  },
  difference: s(bs.difference),
  balances: bs.balances,
  accounts: bs.accounts.map((account) => ({
    account_id: account.accountId,
    account_code: account.code,
    account_name: account.name,
    account_type: account.accountType,
    line_code: account.lineCode,
    amounts: balances(account.amounts),
    drill: drill([account.accountId], null),
  })),
  definition_is_complete: bs.definitionIsComplete,
  exceptions: bs.exceptions.map(exception),
});

/**
 * A cash-flow account entry, with its real account id restored.
 *
 * An account whose lines carry controlled overrides is split into one engine row
 * per effective classification (see `cashFlowRows`), so `accountId` may be
 * synthetic. `account_id` here is always the account that exists in the chart —
 * a drill from a cash flow section has to reach a real account or the chain
 * doc 12 describes stops at the section heading.
 */
const cashFlowAccount = (entry: CashFlowAccountAmount, drill: DrillBuilder) => {
  const accountId = realAccountId(entry.accountId);
  return {
    account_id: accountId,
    account_code: entry.code,
    account_name: entry.name,
    amount: s(entry.amount),
    classification: entry.classification,
    reclassified: accountId !== entry.accountId,
    overridden: entry.overridden || accountId !== entry.accountId,
    override_reason: entry.overrideReason ?? null,
    drill: drill([accountId], null),
  };
};

export const cashFlow = (cf: CashFlowStatement, drill: DrillBuilder) => ({
  method: cf.method,
  window: cf.window,
  opening_cash: s(cf.openingCash),
  closing_cash: s(cf.closingCash),
  cash_movement: s(cf.cashMovement),
  sections: cf.sections.map((section) => ({
    classification: section.classification,
    label: section.label,
    amount: s(section.amount),
    accounts: section.accounts.map((a) => cashFlowAccount(a, drill)),
    drill: drill(
      section.accounts.map((a) => realAccountId(a.accountId)),
      null,
    ),
  })),
  operating: s(cf.operating),
  investing: s(cf.investing),
  financing: s(cf.financing),
  net_movement_classified: s(cf.netMovementClassified),
  unclassified_movement: s(cf.unclassifiedMovement),
  unclassified_accounts: cf.unclassifiedAccounts.map((a) => cashFlowAccount(a, drill)),
  difference: s(cf.difference),
  reconciles: cf.reconciles,
  cash_accounts: cf.cashAccounts.map((a) => cashFlowAccount(a, drill)),
  exceptions: cf.exceptions.map(exception),
});

export const financialStatements = (statements: FinancialStatements, drill: DrillBuilder) => ({
  retained_earnings_method: statements.retainedEarningsMethod,
  trial_balance: trialBalanceTotals(statements.trialBalance),
  profit_and_loss: profitAndLoss(statements.profitAndLoss, drill),
  balance_sheet: balanceSheet(statements.balanceSheet, drill),
  cash_flow: cashFlow(statements.cashFlow, drill),
  ties: statements.ties.map(tieCheck),
  ties_exactly: statements.tiesExactly,
  exceptions: statements.exceptions.map(exception),
});
