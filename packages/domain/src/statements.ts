/**
 * Financial statement composition — profit and loss, balance sheet and cash flow,
 * composed from a trial balance and nothing else.
 *
 * Pure, like everything else here: no database, no clock, no HTTP. doc 21's
 * Phase 6 exit criterion is "Core statements tie exactly to Trial Balance" and
 * Gate E adds "Balance Sheet balances", "P&L closes correctly into
 * equity/retained earnings policy" and "Cash Flow reconciles beginning cash +
 * movement = ending cash". Those are arithmetic statements about a set of
 * balances. Proving them against a database proves them for the one dataset the
 * fixture happened to contain; proving them here, over generated trial balances,
 * proves them for the shape of the input.
 *
 * Three decisions this module implements rather than re-litigates:
 *
 *   1. **Both retained-earnings methods** (ADR-0001 §2). `DERIVED` posts no
 *      closing journal, so profit-and-loss accounts carry their balances across
 *      the year boundary and retained earnings is computed at report time;
 *      `CLOSING_JOURNAL` posts PERIOD_CLOSE_PNL_TRANSFER at year end. The method
 *      is an input, and the composition below is written so that the same
 *      arithmetic serves both — what differs is which exceptions are raised and
 *      how the equity analysis is worded, not the totals.
 *   2. **Cash flow is the classification-based direct method** — doc 12: "Initial
 *      method can use configured account/cash-flow classification plus derived
 *      cash movements", and ADR-0001: "ship the classification-based direct
 *      method first ... the indirect method needs a profit reconciliation and is
 *      deferred". Every non-cash account carries a cash-flow classification; the
 *      cash effect of a class is the negated movement of the accounts in it, and
 *      double entry makes the three classes sum to the movement in cash exactly.
 *      An indirect presentation would need the profit reconciliation that ADR
 *      defers, and inventing one here would be inventing policy.
 *   3. **An account that maps to no statement line is reported, never dropped.**
 *      A statement that drops an account still balances while that account nets
 *      to zero, and is wrong the first moment it does not — which is to say it is
 *      wrong silently, at some future date, in a report someone has already
 *      signed. Unmapped accounts are swept into an explicit line so the statement
 *      still ties, and listed as exceptions so the definition can be fixed.
 */

import { D, Decimal, MONEY_SCALE } from './decimal';
import { AppError } from './errors';
import type { AccountTypeCode, NormalBalance } from './posting';

const ZERO = Decimal.zero(MONEY_SCALE);

// ---------------------------------------------------------------------------
// Vocabulary — mirrors 0000_extensions_and_types.sql and 0005_ledger.sql
// ---------------------------------------------------------------------------

/** Mirrors the `retained_earnings_method` enum exactly (ADR-0001 §2). */
export const RETAINED_EARNINGS_METHODS = ['DERIVED', 'CLOSING_JOURNAL'] as const;
export type RetainedEarningsMethod = (typeof RETAINED_EARNINGS_METHODS)[number];

/** Mirrors `accounts.cash_flow_classification` exactly, NONE included. */
export const CASH_FLOW_CLASSIFICATIONS = ['OPERATING', 'INVESTING', 'FINANCING', 'NONE'] as const;
export type CashFlowClassification = (typeof CASH_FLOW_CLASSIFICATIONS)[number];
/** The three classes doc 12 requires a cash flow to be presented in. */
export const CASH_FLOW_CLASSES = ['OPERATING', 'INVESTING', 'FINANCING'] as const;
export type CashFlowClass = (typeof CASH_FLOW_CLASSES)[number];

/**
 * The method this engine implements, stamped on every statement it produces.
 *
 * Named so that a snapshot taken today records which method produced it: when
 * the indirect presentation lands (ADR-0001 defers it with its own design note),
 * an old snapshot must not be mistaken for one.
 */
export const CASH_FLOW_METHOD = 'DIRECT_CLASSIFICATION' as const;
export type CashFlowMethod = typeof CASH_FLOW_METHOD;

/**
 * Which equity account, if any, the accounting policy points at this row.
 *
 * `accounting_policies.retained_earnings_account_id` and
 * `current_year_earnings_account_id` are the two roles that change how equity is
 * ANALYSED (never how it is totalled — see `EquityAnalysis`). A book using
 * CLOSING_JOURNAL transfers the year's result into one of them; a DERIVED book
 * leaves both untouched.
 */
export type EquityRole = 'RETAINED_EARNINGS' | 'CURRENT_YEAR_EARNINGS';

// ---------------------------------------------------------------------------
// Input — a trial balance, exactly as a ledger read model produces one
// ---------------------------------------------------------------------------

/**
 * The debit and credit columns of a trial balance for one measurement window.
 *
 * Both are sums of posted journal-line columns, so both are non-negative; a
 * negative here means the query that produced it netted somewhere it should not
 * have, and `normalizeRows` refuses it rather than reporting the consequence.
 */
export interface TrialBalanceWindow {
  readonly debit: Decimal;
  readonly credit: Decimal;
}

export interface StatementAccount {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly accountType: AccountTypeCode;
  readonly normalBalance: NormalBalance;
  /** `accounts.subtype` — a line definition may select on it. */
  readonly subtype?: string | null;
  /** `account_groups.code` — a line definition may select on it. */
  readonly groupCode?: string | null;
  readonly groupName?: string | null;
  /** Set from `accounting_policies`; see `EquityRole`. */
  readonly equityRole?: EquityRole | null;
  /**
   * True for the cash and cash-equivalent accounts the cash flow is ABOUT.
   * They are the subject of the statement, so they are never classified into
   * one of its three sections.
   */
  readonly isCash?: boolean;
  /** `accounts.cash_flow_classification`. Null and 'NONE' both mean unclassified. */
  readonly cashFlowClassification?: CashFlowClassification | null;
}

/**
 * One account's trial balance across every window a statement needs.
 *
 * `yearToDate` is required, not optional, and that is the load-bearing decision
 * in this interface. Under `DERIVED` a profit-and-loss account's closing balance
 * is its LIFE-to-date result, not its year-to-date result, so a balance sheet
 * that reads the closing balance as "this year's profit" overstates equity's
 * current-year line by every prior year the book has run. The difference between
 * the two windows is precisely the prior years, and it can only be known by
 * being given both. Deriving one from the other is the assumption that makes the
 * statement wrong for exactly one of the two supported methods.
 */
export interface TrialBalanceRow {
  readonly account: StatementAccount;
  /** Balance brought forward at the first day of the reporting period. */
  readonly opening: TrialBalanceWindow;
  /** Movement within the reporting period. */
  readonly period: TrialBalanceWindow;
  /** Movement from the first day of the fiscal year to the end of the period. */
  readonly yearToDate: TrialBalanceWindow;
  /**
   * Movement in the comparative period (doc 12 "comparison period"). Optional,
   * but all-or-nothing across the rows: a trial balance where some rows carry a
   * comparative and others do not would produce a comparative column that is
   * silently short by the missing rows.
   */
  readonly comparative?: TrialBalanceWindow | null;
}

// ---------------------------------------------------------------------------
// Statement line definitions (doc 12 "Report definitions")
// ---------------------------------------------------------------------------

/**
 * Profit-and-loss sections, in presentation order.
 *
 * `OPERATING_EXPENSE` is where the default definition puts every expense: a
 * caller with no `report_definitions` row has not told us which expenses are
 * cost of sales, and guessing would produce a gross profit nobody computed.
 */
export const PROFIT_AND_LOSS_SECTIONS = [
  'REVENUE',
  'COST_OF_SALES',
  'OPERATING_EXPENSE',
  'OTHER_INCOME',
  'OTHER_EXPENSE',
  'TAX_EXPENSE',
] as const;
export type ProfitAndLossSection = (typeof PROFIT_AND_LOSS_SECTIONS)[number];

/**
 * Balance sheet sections, in presentation order.
 *
 * `ASSET` and `LIABILITY` are the unclassified sections the default definition
 * uses. A definition that does not split current from non-current gets a single
 * "Assets" section rather than having its non-current assets filed under
 * "Current assets", which would be a lie told by the engine rather than by the
 * definition.
 */
export const BALANCE_SHEET_SECTIONS = [
  'CURRENT_ASSET',
  'NON_CURRENT_ASSET',
  'ASSET',
  'CURRENT_LIABILITY',
  'NON_CURRENT_LIABILITY',
  'LIABILITY',
  'EQUITY',
] as const;
export type BalanceSheetSection = (typeof BALANCE_SHEET_SECTIONS)[number];

const SECTION_LABELS: Record<ProfitAndLossSection | BalanceSheetSection, string> = {
  REVENUE: 'Revenue',
  COST_OF_SALES: 'Cost of sales',
  OPERATING_EXPENSE: 'Operating expenses',
  OTHER_INCOME: 'Other income',
  OTHER_EXPENSE: 'Other expenses',
  TAX_EXPENSE: 'Taxation',
  CURRENT_ASSET: 'Current assets',
  NON_CURRENT_ASSET: 'Non-current assets',
  ASSET: 'Assets',
  CURRENT_LIABILITY: 'Current liabilities',
  NON_CURRENT_LIABILITY: 'Non-current liabilities',
  LIABILITY: 'Liabilities',
  EQUITY: 'Equity',
};

/** Which account types a section may legitimately contain. */
const SECTION_ACCOUNT_TYPES: Record<
  ProfitAndLossSection | BalanceSheetSection,
  readonly AccountTypeCode[]
> = {
  REVENUE: ['REVENUE'],
  OTHER_INCOME: ['REVENUE'],
  COST_OF_SALES: ['EXPENSE'],
  OPERATING_EXPENSE: ['EXPENSE'],
  OTHER_EXPENSE: ['EXPENSE'],
  TAX_EXPENSE: ['EXPENSE'],
  CURRENT_ASSET: ['ASSET'],
  NON_CURRENT_ASSET: ['ASSET'],
  ASSET: ['ASSET'],
  CURRENT_LIABILITY: ['LIABILITY'],
  NON_CURRENT_LIABILITY: ['LIABILITY'],
  LIABILITY: ['LIABILITY'],
  EQUITY: ['EQUITY'],
};

/**
 * One row of a report definition: a label and the accounts that reach it.
 *
 * The selectors are alternatives, not a conjunction — an account reaches the
 * line if ANY supplied selector admits it, which is how `report_rows` behaves
 * with its account range, account group and explicit account list. A line with
 * no selector at all is refused: a row that can never receive an account is a
 * registered intention that never executes, and it silently shrinks the
 * statement by whatever the author believed it covered.
 */
export interface StatementLineSpec<S extends string> {
  readonly code: string;
  readonly label: string;
  readonly section: S;
  readonly sortOrder?: number;
  readonly accountIds?: readonly string[];
  readonly accountCodes?: readonly string[];
  /** Inclusive lower bound, compared by `compareAccountCodes`. */
  readonly accountCodeFrom?: string;
  /** Inclusive upper bound, compared by `compareAccountCodes`. */
  readonly accountCodeTo?: string;
  readonly accountGroupCodes?: readonly string[];
  readonly subtypes?: readonly string[];
  readonly accountTypes?: readonly AccountTypeCode[];
}

export type ProfitAndLossLineSpec = StatementLineSpec<ProfitAndLossSection>;
export type BalanceSheetLineSpec = StatementLineSpec<BalanceSheetSection>;

/**
 * The definition used when a caller supplies none.
 *
 * Exhaustive by construction — every REVENUE account reaches one line and every
 * EXPENSE account reaches the other — so the default can never produce an
 * unmapped account. That property is why the default is expressed as account
 * types rather than as the seeded chart's groups: a chart this engine has never
 * seen still maps completely.
 */
export const DEFAULT_PROFIT_AND_LOSS_LINES: readonly ProfitAndLossLineSpec[] = [
  { code: 'REVENUE', label: 'Revenue', section: 'REVENUE', accountTypes: ['REVENUE'] },
  { code: 'EXPENSES', label: 'Expenses', section: 'OPERATING_EXPENSE', accountTypes: ['EXPENSE'] },
];

export const DEFAULT_BALANCE_SHEET_LINES: readonly BalanceSheetLineSpec[] = [
  { code: 'ASSETS', label: 'Assets', section: 'ASSET', accountTypes: ['ASSET'] },
  { code: 'LIABILITIES', label: 'Liabilities', section: 'LIABILITY', accountTypes: ['LIABILITY'] },
  { code: 'EQUITY', label: 'Equity', section: 'EQUITY', accountTypes: ['EQUITY'] },
];

/** The line an unmapped account is swept into, per section. */
const UNMAPPED_LINE_CODE = 'UNMAPPED';
const UNMAPPED_LINE_LABEL = 'Unmapped accounts (report definition incomplete)';

const UNMAPPED_PNL_SECTION: Record<'REVENUE' | 'EXPENSE', ProfitAndLossSection> = {
  REVENUE: 'REVENUE',
  EXPENSE: 'OPERATING_EXPENSE',
};
const UNMAPPED_BS_SECTION: Record<'ASSET' | 'LIABILITY' | 'EQUITY', BalanceSheetSection> = {
  ASSET: 'ASSET',
  LIABILITY: 'LIABILITY',
  EQUITY: 'EQUITY',
};

/**
 * Compares two account codes the way an account range means them.
 *
 * All-numeric codes compare numerically, everything else lexicographically.
 * The distinction is not pedantry: lexicographically `'10000'` falls inside the
 * range `'1000'`–`'1999'`, so a five-digit sub-account of a six-thousand series
 * would land in the current-asset line of every chart that uses variable-length
 * codes. Numerically it does not.
 */
const ALL_DIGITS = /^\d+$/;
export function compareAccountCodes(a: string, b: string): -1 | 0 | 1 {
  if (ALL_DIGITS.test(a) && ALL_DIGITS.test(b)) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** The three columns doc 12 requires of a profit and loss. */
export interface StatementAmounts {
  readonly period: Decimal;
  /** Null when the trial balance carried no comparative window. */
  readonly comparative: Decimal | null;
  readonly yearToDate: Decimal;
}

/** A balance sheet figure is a roll-forward, not a movement. */
export interface BalanceAmounts {
  readonly opening: Decimal;
  readonly movement: Decimal;
  /** `opening + movement`, exactly. */
  readonly closing: Decimal;
}

export interface StatementAccountAmount<A> {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly accountType: AccountTypeCode;
  readonly lineCode: string;
  /** In the line's presentation sign — see `naturalAmount`. */
  readonly amounts: A;
}

export interface StatementLine<S extends string, A> {
  readonly code: string;
  readonly label: string;
  readonly section: S;
  readonly sortOrder: number;
  readonly amounts: A;
  /** doc 12's drill-down, first hop: statement total -> report row -> account. */
  readonly accounts: readonly StatementAccountAmount<A>[];
}

export interface StatementSectionTotal<S extends string, A> {
  readonly section: S;
  readonly label: string;
  readonly amounts: A;
  readonly lines: readonly StatementLine<S, A>[];
}

export type StatementExceptionCode =
  | 'ACCOUNT_UNMAPPED'
  | 'CASH_FLOW_ACCOUNT_UNCLASSIFIED'
  | 'PRIOR_YEAR_NOT_CLOSED'
  | 'CLOSING_TRANSFER_IN_DERIVED_BOOK'
  | 'RETAINED_EARNINGS_ACCOUNT_NOT_IDENTIFIED';

/**
 * Something the reader must know about a statement that nevertheless ties.
 *
 * Returned as data, not thrown: the report is still the best available answer
 * and refusing to produce it would leave the close with nothing to look at. But
 * it travels WITH the numbers, so a snapshot cannot record the totals and forget
 * the caveat.
 */
export interface StatementException {
  readonly code: StatementExceptionCode;
  readonly message: string;
  readonly accountId?: string;
  readonly accountCode?: string;
  readonly amount?: Decimal;
}

export type UnmappedPolicy = 'REPORT' | 'REJECT';

// --- profit and loss --------------------------------------------------------

export interface ProfitAndLossInput {
  readonly rows: readonly TrialBalanceRow[];
  readonly lines?: readonly ProfitAndLossLineSpec[];
  /** REJECT is for the issue/approve path: a snapshot should not record a hole. */
  readonly unmappedPolicy?: UnmappedPolicy;
}

export interface ProfitAndLoss {
  readonly sections: readonly StatementSectionTotal<ProfitAndLossSection, StatementAmounts>[];
  readonly revenue: StatementAmounts;
  readonly costOfSales: StatementAmounts;
  /** revenue − cost of sales. Equals revenue when the definition names no cost of sales. */
  readonly grossProfit: StatementAmounts;
  readonly operatingExpense: StatementAmounts;
  readonly operatingResult: StatementAmounts;
  readonly otherIncome: StatementAmounts;
  readonly otherExpense: StatementAmounts;
  readonly taxExpense: StatementAmounts;
  /** Revenue less expense, whatever the definition called them. Credit-positive. */
  readonly result: StatementAmounts;
  /** Every profit-and-loss account, flat, for the by-account presentation. */
  readonly accounts: readonly StatementAccountAmount<StatementAmounts>[];
  readonly hasComparative: boolean;
  readonly exceptions: readonly StatementException[];
  /** False when any account reached the statement without a line of its own. */
  readonly definitionIsComplete: boolean;
}

// --- balance sheet ----------------------------------------------------------

export interface BalanceSheetInput {
  readonly rows: readonly TrialBalanceRow[];
  readonly retainedEarningsMethod: RetainedEarningsMethod;
  readonly lines?: readonly BalanceSheetLineSpec[];
  readonly unmappedPolicy?: UnmappedPolicy;
}

/**
 * Equity re-sliced into the three figures a reader asks for.
 *
 * These RE-SLICE the equity section; they are not additional lines, and adding
 * them to the section total would count the year's result twice. The identity
 * that holds — and is checked in `ties` — is
 *
 *   contributedAndOther + retainedEarnings + currentYearResult = equity total
 */
export interface EquityAnalysis {
  readonly method: RetainedEarningsMethod;
  /** Equity accounts other than the retained-earnings and current-year roles. */
  readonly contributedAndOther: Decimal;
  /**
   * Retained earnings as presented: the retained-earnings account, plus anything
   * a prior year left in the current-year-earnings account, plus (the DERIVED
   * case) prior years still sitting in the profit-and-loss accounts.
   */
  readonly retainedEarnings: Decimal;
  /** The retained-earnings ledger account's own closing balance. */
  readonly retainedEarningsAccount: Decimal;
  /** Prior-year results still in profit-and-loss accounts: closing − year-to-date. */
  readonly priorYearResultsInProfitAndLoss: Decimal;
  /** Prior-year results parked in the current-year-earnings account. */
  readonly priorYearResultsInCurrentYearEarnings: Decimal;
  /**
   * doc 21 Phase 6: "the current year's result presented before year-end close".
   * Year-to-date profit and loss, plus whatever a closing journal has already
   * moved into the current-year-earnings account this year — so the figure does
   * not jump the moment PERIOD_CLOSE_PNL_TRANSFER posts.
   */
  readonly currentYearResult: Decimal;
  /** Year-to-date movement of the current-year-earnings account, credit-positive. */
  readonly currentYearEarningsTransfer: Decimal;
}

/**
 * Equity opening to closing, in the three terms that explain it.
 *
 * `closing = opening + profitAndLossForPeriod + equityAccountMovement`, exactly,
 * under BOTH methods. Under CLOSING_JOURNAL the transfer journal appears in both
 * of the last two terms with opposite signs — it debits revenue and credits
 * retained earnings — so it cancels, which is the arithmetic reason the same
 * roll-forward serves a book that closes and a book that derives.
 */
export interface EquityRollForward {
  readonly opening: Decimal;
  readonly profitAndLossForPeriod: Decimal;
  readonly equityAccountMovement: Decimal;
  readonly closing: Decimal;
}

export interface BalanceSheet {
  readonly method: RetainedEarningsMethod;
  readonly sections: readonly StatementSectionTotal<BalanceSheetSection, BalanceAmounts>[];
  readonly totalAssets: BalanceAmounts;
  readonly totalLiabilities: BalanceAmounts;
  /** Includes the current year's result, presented before year-end close. */
  readonly totalEquity: BalanceAmounts;
  readonly equity: EquityAnalysis;
  readonly equityRollForward: EquityRollForward;
  /** assets − liabilities − equity, at the closing date. Zero, or the statement is wrong. */
  readonly difference: Decimal;
  readonly balances: boolean;
  readonly accounts: readonly StatementAccountAmount<BalanceAmounts>[];
  readonly exceptions: readonly StatementException[];
  readonly definitionIsComplete: boolean;
}

// --- cash flow --------------------------------------------------------------

/** doc 12: "controlled overrides" of an account's cash-flow classification. */
export interface CashFlowOverride {
  readonly accountId: string;
  readonly classification: CashFlowClass;
  /** Required. An override nobody has to justify is not a controlled override. */
  readonly reason: string;
}

export interface CashFlowInput {
  readonly rows: readonly TrialBalanceRow[];
  readonly overrides?: readonly CashFlowOverride[];
  /** Which movement window the statement covers. Default PERIOD. */
  readonly window?: 'PERIOD' | 'YEAR_TO_DATE';
  /** REJECT refuses to present a cash flow with an unclassified movement in it. */
  readonly unclassifiedPolicy?: UnmappedPolicy;
}

export interface CashFlowAccountAmount {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  /** The account's cash effect: its movement, negated. */
  readonly amount: Decimal;
  readonly classification: CashFlowClassification;
  readonly overridden: boolean;
  readonly overrideReason?: string;
}

export interface CashFlowSection {
  readonly classification: CashFlowClass;
  readonly label: string;
  readonly amount: Decimal;
  readonly accounts: readonly CashFlowAccountAmount[];
}

export interface CashFlowStatement {
  readonly method: CashFlowMethod;
  readonly window: 'PERIOD' | 'YEAR_TO_DATE';
  readonly openingCash: Decimal;
  readonly closingCash: Decimal;
  /** closingCash − openingCash, from the cash accounts themselves. */
  readonly cashMovement: Decimal;
  readonly sections: readonly CashFlowSection[];
  readonly operating: Decimal;
  readonly investing: Decimal;
  readonly financing: Decimal;
  /** operating + investing + financing. */
  readonly netMovementClassified: Decimal;
  /** The cash effect of accounts carrying no classification. Never folded away. */
  readonly unclassifiedMovement: Decimal;
  readonly unclassifiedAccounts: readonly CashFlowAccountAmount[];
  /** cashMovement − netMovementClassified − unclassifiedMovement. */
  readonly difference: Decimal;
  /** Gate E: beginning cash + movement = ending cash, with nothing unexplained. */
  readonly reconciles: boolean;
  readonly cashAccounts: readonly CashFlowAccountAmount[];
  readonly exceptions: readonly StatementException[];
}

// --- the set ----------------------------------------------------------------

export interface WindowTotals {
  readonly debit: Decimal;
  readonly credit: Decimal;
  readonly difference: Decimal;
  readonly balances: boolean;
}

export interface TrialBalanceTotals {
  readonly opening: WindowTotals;
  readonly period: WindowTotals;
  readonly yearToDate: WindowTotals;
  readonly comparative: WindowTotals | null;
  /** Closing presented the way a trial balance presents it: net, per account. */
  readonly closing: WindowTotals;
  readonly accountCount: number;
}

export interface StatementTieCheck {
  readonly name: string;
  readonly description: string;
  readonly expected: Decimal;
  readonly actual: Decimal;
  readonly difference: Decimal;
  readonly ties: boolean;
}

export interface FinancialStatementsInput {
  readonly rows: readonly TrialBalanceRow[];
  readonly retainedEarningsMethod: RetainedEarningsMethod;
  readonly profitAndLossLines?: readonly ProfitAndLossLineSpec[];
  readonly balanceSheetLines?: readonly BalanceSheetLineSpec[];
  readonly cashFlowOverrides?: readonly CashFlowOverride[];
  readonly cashFlowWindow?: 'PERIOD' | 'YEAR_TO_DATE';
  readonly unmappedPolicy?: UnmappedPolicy;
  readonly unclassifiedCashFlowPolicy?: UnmappedPolicy;
}

export interface FinancialStatements {
  readonly retainedEarningsMethod: RetainedEarningsMethod;
  readonly trialBalance: TrialBalanceTotals;
  readonly profitAndLoss: ProfitAndLoss;
  readonly balanceSheet: BalanceSheet;
  readonly cashFlow: CashFlowStatement;
  /** Phase 6 exit criterion 1, measured rather than asserted. */
  readonly ties: readonly StatementTieCheck[];
  readonly tiesExactly: boolean;
  readonly exceptions: readonly StatementException[];
}

// ---------------------------------------------------------------------------
// Normalization and refusal
// ---------------------------------------------------------------------------

interface NormalizedRow {
  readonly account: StatementAccount;
  readonly openingDebitSigned: Decimal;
  readonly periodDebitSigned: Decimal;
  readonly yearToDateDebitSigned: Decimal;
  readonly comparativeDebitSigned: Decimal | null;
  readonly closingDebitSigned: Decimal;
}

/**
 * Positive when the amount is what an accountant would call normal FOR ITS TYPE.
 *
 * Deliberately keyed on account type and not on `normal_balance`. Accumulated
 * depreciation is an ASSET with a CREDIT normal balance; signing it by its normal
 * balance would report it as a positive asset and overstate the balance sheet by
 * twice the accumulated charge. Signing it by type reports it negative, which
 * nets it against cost exactly as a balance sheet presents it.
 */
function naturalAmount(accountType: AccountTypeCode, debitSigned: Decimal): Decimal {
  return accountType === 'ASSET' || accountType === 'EXPENSE' ? debitSigned : debitSigned.negate();
}

function refuse(message: string, details: Record<string, unknown>): AppError {
  return new AppError('VALIDATION_FAILED', message, { details });
}

function amount(value: Decimal, field: string, account: StatementAccount): Decimal {
  if (value.isNegative()) {
    throw refuse(
      `TRIAL_BALANCE_NEGATIVE_COLUMN: account ${account.code} ${account.name} has ${field} ` +
        `${value.toString()}. A trial balance column is a sum of posted debit or credit ` +
        `amounts and cannot be negative; the query that produced it has netted the columns.`,
      { account_id: account.accountId, account_code: account.code, field },
    );
  }
  const scaled = value.rescale(MONEY_SCALE);
  if (!scaled.equals(value)) {
    throw refuse(
      `TRIAL_BALANCE_AMOUNT_PRECISION: account ${account.code} ${account.name} has ${field} ` +
        `${value.toString()}, which carries more precision than the ledger's numeric(24,8). ` +
        `Rounding it here would silently move the difference into the statement's balance.`,
      { account_id: account.accountId, account_code: account.code, field },
    );
  }
  return scaled;
}

const netOf = (w: TrialBalanceWindow, field: string, account: StatementAccount): Decimal =>
  amount(w.debit, `${field} debit`, account).sub(amount(w.credit, `${field} credit`, account));

function windowTotals(
  rows: readonly TrialBalanceRow[],
  pick: (r: TrialBalanceRow) => TrialBalanceWindow | null | undefined,
): WindowTotals {
  let debit = ZERO;
  let credit = ZERO;
  for (const row of rows) {
    const w = pick(row);
    if (!w) continue;
    debit = debit.add(amount(w.debit, 'debit', row.account));
    credit = credit.add(amount(w.credit, 'credit', row.account));
  }
  const difference = debit.sub(credit);
  return { debit, credit, difference, balances: difference.isZero() };
}

function requireBalanced(totals: WindowTotals, window: string): void {
  if (totals.balances) return;
  throw refuse(
    `TRIAL_BALANCE_UNBALANCED: the ${window} column has debits ${totals.debit.toString()} ` +
      `against credits ${totals.credit.toString()}, a difference of ` +
      `${totals.difference.toString()}. Statements composed from it cannot tie, so none are ` +
      `produced; rebuild the trial balance from posted journal lines and re-run.`,
    { window, debit: totals.debit.toString(), credit: totals.credit.toString() },
  );
}

/**
 * Validates the trial balance and reduces it to signed movements.
 *
 * Everything refused here is refused because presenting it would produce a
 * statement that looks right. An unbalanced input balances anyway once the
 * difference is absorbed into whichever total is computed as a residual; a
 * duplicated account double-counts in one line and nowhere else; a comparative
 * column present on some rows only is short by the missing rows and says so
 * nowhere.
 */
function normalizeRows(rows: readonly TrialBalanceRow[]): readonly NormalizedRow[] {
  const seen = new Map<string, string>();
  let withComparative = 0;

  for (const row of rows) {
    const a = row.account;
    const previous = seen.get(a.accountId);
    if (previous !== undefined) {
      throw refuse(
        `TRIAL_BALANCE_DUPLICATE_ACCOUNT: account ${a.code} (${a.accountId}) appears twice in ` +
          `the trial balance, once as "${previous}" and once as "${a.name}". Every amount it ` +
          `carries would be counted twice.`,
        { account_id: a.accountId, account_code: a.code },
      );
    }
    seen.set(a.accountId, a.name);

    if (a.equityRole != null && a.accountType !== 'EQUITY') {
      throw refuse(
        `STATEMENT_EQUITY_ROLE_NOT_EQUITY: account ${a.code} ${a.name} is marked ` +
          `${a.equityRole} but its account type is ${a.accountType}. The retained-earnings ` +
          `analysis would subtract it from equity it was never part of.`,
        { account_id: a.accountId, account_code: a.code, equity_role: a.equityRole },
      );
    }
    if (row.comparative != null) withComparative++;
  }

  if (withComparative !== 0 && withComparative !== rows.length) {
    const missing = rows
      .filter((r) => r.comparative == null)
      .slice(0, 10)
      .map((r) => r.account.code);
    throw refuse(
      `TRIAL_BALANCE_COLUMN_INCOMPLETE: ${withComparative} of ${rows.length} rows carry a ` +
        `comparative window. A comparative column built from a subset of the accounts is ` +
        `short by the rest and balances only by accident. Missing: ${missing.join(', ')}` +
        `${rows.length - withComparative > 10 ? ', …' : ''}.`,
      { rows: rows.length, with_comparative: withComparative },
    );
  }

  requireBalanced(
    windowTotals(rows, (r) => r.opening),
    'opening',
  );
  requireBalanced(
    windowTotals(rows, (r) => r.period),
    'period',
  );
  requireBalanced(
    windowTotals(rows, (r) => r.yearToDate),
    'year-to-date',
  );
  if (withComparative > 0) {
    requireBalanced(
      windowTotals(rows, (r) => r.comparative),
      'comparative',
    );
  }

  return rows.map((row) => {
    const opening = netOf(row.opening, 'opening', row.account);
    const period = netOf(row.period, 'period', row.account);
    return {
      account: row.account,
      openingDebitSigned: opening,
      periodDebitSigned: period,
      yearToDateDebitSigned: netOf(row.yearToDate, 'year-to-date', row.account),
      comparativeDebitSigned:
        row.comparative != null ? netOf(row.comparative, 'comparative', row.account) : null,
      closingDebitSigned: opening.add(period),
    };
  });
}

/** The trial balance's own totals, including the netted closing presentation. */
export function trialBalanceTotals(rows: readonly TrialBalanceRow[]): TrialBalanceTotals {
  const normalized = normalizeRows(rows);
  let closingDebit = ZERO;
  let closingCredit = ZERO;
  for (const row of normalized) {
    if (row.closingDebitSigned.isNegative()) {
      closingCredit = closingCredit.add(row.closingDebitSigned.negate());
    } else {
      closingDebit = closingDebit.add(row.closingDebitSigned);
    }
  }
  const closingDifference = closingDebit.sub(closingCredit);
  const hasComparative = rows.some((r) => r.comparative != null);
  return {
    opening: windowTotals(rows, (r) => r.opening),
    period: windowTotals(rows, (r) => r.period),
    yearToDate: windowTotals(rows, (r) => r.yearToDate),
    comparative: hasComparative ? windowTotals(rows, (r) => r.comparative) : null,
    closing: {
      debit: closingDebit,
      credit: closingCredit,
      difference: closingDifference,
      balances: closingDifference.isZero(),
    },
    accountCount: rows.length,
  };
}

// ---------------------------------------------------------------------------
// Mapping accounts to lines
// ---------------------------------------------------------------------------

interface MappedLine<S extends string> {
  readonly code: string;
  readonly label: string;
  readonly section: S;
  readonly sortOrder: number;
  readonly rows: NormalizedRow[];
}

function hasSelector<S extends string>(spec: StatementLineSpec<S>): boolean {
  return (
    (spec.accountIds?.length ?? 0) > 0 ||
    (spec.accountCodes?.length ?? 0) > 0 ||
    (spec.accountGroupCodes?.length ?? 0) > 0 ||
    (spec.subtypes?.length ?? 0) > 0 ||
    (spec.accountTypes?.length ?? 0) > 0 ||
    spec.accountCodeFrom !== undefined ||
    spec.accountCodeTo !== undefined
  );
}

function matches<S extends string>(account: StatementAccount, spec: StatementLineSpec<S>): boolean {
  if (spec.accountIds?.includes(account.accountId)) return true;
  if (spec.accountCodes?.includes(account.code)) return true;
  if (account.groupCode != null && spec.accountGroupCodes?.includes(account.groupCode)) return true;
  if (account.subtype != null && spec.subtypes?.includes(account.subtype)) return true;
  if (spec.accountTypes?.includes(account.accountType)) return true;
  if (spec.accountCodeFrom !== undefined || spec.accountCodeTo !== undefined) {
    const from = spec.accountCodeFrom;
    const to = spec.accountCodeTo;
    const aboveFloor = from === undefined || compareAccountCodes(account.code, from) >= 0;
    const belowCeiling = to === undefined || compareAccountCodes(account.code, to) <= 0;
    if (aboveFloor && belowCeiling) return true;
  }
  return false;
}

/**
 * Assigns every row to exactly one line, and says so when it cannot.
 *
 * Two failures are refusals rather than exceptions, because neither can be
 * presented honestly: an account matched by two lines is counted twice in a
 * statement whose total then disagrees with its own sections, and an account
 * matched by a line whose section cannot hold its type has been filed under a
 * heading that misstates what it is.
 */
function mapToLines<S extends string>(
  rows: readonly NormalizedRow[],
  specs: readonly StatementLineSpec<S>[],
  statement: string,
  unmappedSection: (t: AccountTypeCode) => S,
  policy: UnmappedPolicy,
): { lines: MappedLine<S>[]; exceptions: StatementException[] } {
  const codes = new Set<string>();
  for (const spec of specs) {
    if (codes.has(spec.code)) {
      throw refuse(
        `STATEMENT_LINE_DUPLICATE_CODE: the ${statement} definition declares line ` +
          `"${spec.code}" twice. Line codes key the drill-down, so a duplicate makes one of ` +
          `the two unreachable from its total.`,
        { statement, line_code: spec.code },
      );
    }
    codes.add(spec.code);
    if (!hasSelector(spec)) {
      throw refuse(
        `STATEMENT_LINE_NO_SELECTOR: ${statement} line "${spec.code}" (${spec.label}) selects ` +
          `no accounts at all. A line that can never receive an account silently shrinks the ` +
          `statement by whatever it was meant to carry; give it accounts, a code range, a ` +
          `group, a subtype or an account type.`,
        { statement, line_code: spec.code },
      );
    }
    if (
      spec.accountCodeFrom !== undefined &&
      spec.accountCodeTo !== undefined &&
      compareAccountCodes(spec.accountCodeFrom, spec.accountCodeTo) > 0
    ) {
      throw refuse(
        `STATEMENT_LINE_RANGE_INVERTED: ${statement} line "${spec.code}" ranges from ` +
          `${spec.accountCodeFrom} to ${spec.accountCodeTo}, which is empty. No account can ` +
          `ever reach it.`,
        { statement, line_code: spec.code },
      );
    }
  }

  const lines = new Map<string, MappedLine<S>>();
  specs.forEach((spec, index) => {
    lines.set(spec.code, {
      code: spec.code,
      label: spec.label,
      section: spec.section,
      sortOrder: spec.sortOrder ?? index,
      rows: [],
    });
  });

  const exceptions: StatementException[] = [];
  const unmapped: NormalizedRow[] = [];

  for (const row of rows) {
    const hits = specs.filter((spec) => matches(row.account, spec));
    if (hits.length > 1) {
      throw refuse(
        `STATEMENT_ACCOUNT_MAPPED_TWICE: account ${row.account.code} ${row.account.name} ` +
          `matches ${hits.length} ${statement} lines (${hits.map((h) => h.code).join(', ')}). ` +
          `Its balance would be counted once per line and the statement would not tie to the ` +
          `trial balance. Narrow the selectors so each account reaches exactly one line.`,
        {
          account_id: row.account.accountId,
          account_code: row.account.code,
          line_codes: hits.map((h) => h.code),
        },
      );
    }
    const hit = hits[0];
    if (hit === undefined) {
      unmapped.push(row);
      continue;
    }
    const allowed =
      SECTION_ACCOUNT_TYPES[hit.section as ProfitAndLossSection | BalanceSheetSection];
    if (!allowed.includes(row.account.accountType)) {
      throw refuse(
        `STATEMENT_LINE_TYPE_MISMATCH: account ${row.account.code} ${row.account.name} is a ` +
          `${row.account.accountType} account but ${statement} line "${hit.code}" sits in the ` +
          `${hit.section} section, which holds ${allowed.join('/')} accounts. Presenting it ` +
          `there would file it under a heading that misstates what it is.`,
        {
          account_id: row.account.accountId,
          account_code: row.account.code,
          line_code: hit.code,
          section: hit.section,
        },
      );
    }
    lines.get(hit.code)?.rows.push(row);
  }

  if (unmapped.length > 0) {
    const listed = unmapped
      .slice(0, 10)
      .map((r) => `${r.account.code} ${r.account.name}`)
      .join(', ');
    const message =
      `STATEMENT_ACCOUNT_UNMAPPED: ${unmapped.length} account(s) reach the ${statement} with ` +
      `no line of their own: ${listed}${unmapped.length > 10 ? ', …' : ''}. A statement that ` +
      `drops an account still balances while that account nets to zero and is wrong the ` +
      `moment it does not, so their balances are presented on an explicit "${UNMAPPED_LINE_LABEL}" ` +
      `line. Add them to the report definition.`;
    if (policy === 'REJECT') {
      throw refuse(message, {
        statement,
        unmapped: unmapped.map((r) => r.account.code),
      });
    }
    for (const row of unmapped) {
      const section = unmappedSection(row.account.accountType);
      const code = `${UNMAPPED_LINE_CODE}:${section}`;
      let line = lines.get(code);
      if (line === undefined) {
        line = {
          code,
          label: UNMAPPED_LINE_LABEL,
          section,
          sortOrder: Number.MAX_SAFE_INTEGER,
          rows: [],
        };
        lines.set(code, line);
      }
      line.rows.push(row);
      exceptions.push({
        code: 'ACCOUNT_UNMAPPED',
        message:
          `Account ${row.account.code} ${row.account.name} has no line in the ${statement} ` +
          `definition and is presented under "${UNMAPPED_LINE_LABEL}".`,
        accountId: row.account.accountId,
        accountCode: row.account.code,
      });
    }
  }

  return { lines: [...lines.values()], exceptions };
}

function orderSections<S extends string, A>(
  order: readonly S[],
  lines: readonly MappedLine<S>[],
  amountsOf: (rows: readonly NormalizedRow[]) => A,
  accountAmountsOf: (row: NormalizedRow) => A,
  add: (a: A, b: A) => A,
  zero: A,
): {
  sections: StatementSectionTotal<S, A>[];
  accounts: StatementAccountAmount<A>[];
  totals: Map<S, A>;
} {
  const sections: StatementSectionTotal<S, A>[] = [];
  const accounts: StatementAccountAmount<A>[] = [];
  const totals = new Map<S, A>();

  for (const section of order) {
    const sectionLines = lines
      .filter((l) => l.section === section)
      .sort((a, b) =>
        a.sortOrder - b.sortOrder !== 0 ? a.sortOrder - b.sortOrder : a.code < b.code ? -1 : 1,
      );
    let sectionTotal = zero;
    const built: StatementLine<S, A>[] = [];
    for (const line of sectionLines) {
      const lineAccounts = line.rows.map((row) => {
        const entry: StatementAccountAmount<A> = {
          accountId: row.account.accountId,
          code: row.account.code,
          name: row.account.name,
          accountType: row.account.accountType,
          lineCode: line.code,
          amounts: accountAmountsOf(row),
        };
        accounts.push(entry);
        return entry;
      });
      const lineAmounts = amountsOf(line.rows);
      sectionTotal = add(sectionTotal, lineAmounts);
      built.push({
        code: line.code,
        label: line.label,
        section: line.section,
        sortOrder: line.sortOrder,
        amounts: lineAmounts,
        accounts: lineAccounts,
      });
    }
    totals.set(section, sectionTotal);
    sections.push({
      section,
      label: SECTION_LABELS[section as ProfitAndLossSection | BalanceSheetSection],
      amounts: sectionTotal,
      lines: built,
    });
  }
  return { sections, accounts, totals };
}

// ---------------------------------------------------------------------------
// Profit and loss
// ---------------------------------------------------------------------------

const addAmounts = (a: StatementAmounts, b: StatementAmounts): StatementAmounts => ({
  period: a.period.add(b.period),
  comparative:
    a.comparative === null && b.comparative === null
      ? null
      : (a.comparative ?? ZERO).add(b.comparative ?? ZERO),
  yearToDate: a.yearToDate.add(b.yearToDate),
});

const subAmounts = (a: StatementAmounts, b: StatementAmounts): StatementAmounts => ({
  period: a.period.sub(b.period),
  comparative:
    a.comparative === null && b.comparative === null
      ? null
      : (a.comparative ?? ZERO).sub(b.comparative ?? ZERO),
  yearToDate: a.yearToDate.sub(b.yearToDate),
});

const zeroAmounts = (hasComparative: boolean): StatementAmounts => ({
  period: ZERO,
  comparative: hasComparative ? ZERO : null,
  yearToDate: ZERO,
});

function rowAmounts(row: NormalizedRow, hasComparative: boolean): StatementAmounts {
  const t = row.account.accountType;
  return {
    period: naturalAmount(t, row.periodDebitSigned),
    comparative:
      hasComparative && row.comparativeDebitSigned !== null
        ? naturalAmount(t, row.comparativeDebitSigned)
        : null,
    yearToDate: naturalAmount(t, row.yearToDateDebitSigned),
  };
}

function composeProfitAndLossFrom(
  normalized: readonly NormalizedRow[],
  specs: readonly ProfitAndLossLineSpec[],
  policy: UnmappedPolicy,
): ProfitAndLoss {
  const rows = normalized.filter(
    (r) => r.account.accountType === 'REVENUE' || r.account.accountType === 'EXPENSE',
  );
  const hasComparative =
    normalized.length > 0 && normalized.every((r) => r.comparativeDebitSigned !== null);
  const zero = zeroAmounts(hasComparative);

  const { lines, exceptions } = mapToLines<ProfitAndLossSection>(
    rows,
    specs,
    'profit and loss',
    (t) => UNMAPPED_PNL_SECTION[t === 'REVENUE' ? 'REVENUE' : 'EXPENSE'],
    policy,
  );

  const { sections, accounts, totals } = orderSections<ProfitAndLossSection, StatementAmounts>(
    PROFIT_AND_LOSS_SECTIONS,
    lines,
    (rs) =>
      rs.reduce<StatementAmounts>((acc, r) => addAmounts(acc, rowAmounts(r, hasComparative)), zero),
    (r) => rowAmounts(r, hasComparative),
    addAmounts,
    zero,
  );

  const of = (s: ProfitAndLossSection): StatementAmounts => totals.get(s) ?? zero;
  const revenue = of('REVENUE');
  const costOfSales = of('COST_OF_SALES');
  const grossProfit = subAmounts(revenue, costOfSales);
  const operatingExpense = of('OPERATING_EXPENSE');
  const operatingResult = subAmounts(grossProfit, operatingExpense);
  const otherIncome = of('OTHER_INCOME');
  const otherExpense = of('OTHER_EXPENSE');
  const taxExpense = of('TAX_EXPENSE');
  const result = subAmounts(
    subAmounts(addAmounts(operatingResult, otherIncome), otherExpense),
    taxExpense,
  );

  return {
    sections,
    revenue,
    costOfSales,
    grossProfit,
    operatingExpense,
    operatingResult,
    otherIncome,
    otherExpense,
    taxExpense,
    result,
    accounts,
    hasComparative,
    exceptions,
    definitionIsComplete: exceptions.length === 0,
  };
}

export function composeProfitAndLoss(input: ProfitAndLossInput): ProfitAndLoss {
  return composeProfitAndLossFrom(
    normalizeRows(input.rows),
    input.lines ?? DEFAULT_PROFIT_AND_LOSS_LINES,
    input.unmappedPolicy ?? 'REPORT',
  );
}

// ---------------------------------------------------------------------------
// Balance sheet
// ---------------------------------------------------------------------------

const addBalances = (a: BalanceAmounts, b: BalanceAmounts): BalanceAmounts => ({
  opening: a.opening.add(b.opening),
  movement: a.movement.add(b.movement),
  closing: a.closing.add(b.closing),
});

const ZERO_BALANCE: BalanceAmounts = { opening: ZERO, movement: ZERO, closing: ZERO };

function rowBalances(row: NormalizedRow): BalanceAmounts {
  const t = row.account.accountType;
  return {
    opening: naturalAmount(t, row.openingDebitSigned),
    movement: naturalAmount(t, row.periodDebitSigned),
    closing: naturalAmount(t, row.closingDebitSigned),
  };
}

/** Sums a set of rows in credit-positive terms, for the equity analysis. */
function creditPositive(
  rows: readonly NormalizedRow[],
  pick: (r: NormalizedRow) => Decimal,
): Decimal {
  return rows.reduce<Decimal>((acc, r) => acc.sub(pick(r)), ZERO);
}

function composeBalanceSheetFrom(
  normalized: readonly NormalizedRow[],
  method: RetainedEarningsMethod,
  specs: readonly BalanceSheetLineSpec[],
  policy: UnmappedPolicy,
): BalanceSheet {
  const balanceRows = normalized.filter(
    (r) =>
      r.account.accountType === 'ASSET' ||
      r.account.accountType === 'LIABILITY' ||
      r.account.accountType === 'EQUITY',
  );
  const pnlRows = normalized.filter(
    (r) => r.account.accountType === 'REVENUE' || r.account.accountType === 'EXPENSE',
  );

  const { lines, exceptions } = mapToLines<BalanceSheetSection>(
    balanceRows,
    specs,
    'balance sheet',
    (t) =>
      UNMAPPED_BS_SECTION[t === 'ASSET' ? 'ASSET' : t === 'LIABILITY' ? 'LIABILITY' : 'EQUITY'],
    policy,
  );

  // The year's result, in credit-positive terms, over each window.
  const pnlClosing = creditPositive(pnlRows, (r) => r.closingDebitSigned);
  const pnlYearToDate = creditPositive(pnlRows, (r) => r.yearToDateDebitSigned);
  const pnlPeriod = creditPositive(pnlRows, (r) => r.periodDebitSigned);
  const pnlOpening = creditPositive(pnlRows, (r) => r.openingDebitSigned);
  // DERIVED books never close, so what is in the accounts beyond this year is
  // prior years' results. Under CLOSING_JOURNAL it should be nothing, and if it
  // is not, a prior year was never closed — reported below, never absorbed.
  const priorYearResultsInPnl = pnlClosing.sub(pnlYearToDate);

  const equityRows = balanceRows.filter((r) => r.account.accountType === 'EQUITY');
  const reRows = equityRows.filter((r) => r.account.equityRole === 'RETAINED_EARNINGS');
  const cyeRows = equityRows.filter((r) => r.account.equityRole === 'CURRENT_YEAR_EARNINGS');
  const otherEquityRows = equityRows.filter((r) => r.account.equityRole == null);

  const retainedEarningsAccount = creditPositive(reRows, (r) => r.closingDebitSigned);
  const cyeClosing = creditPositive(cyeRows, (r) => r.closingDebitSigned);
  const cyeYearToDate = creditPositive(cyeRows, (r) => r.yearToDateDebitSigned);
  const priorYearResultsInCye = cyeClosing.sub(cyeYearToDate);
  const contributedAndOther = creditPositive(otherEquityRows, (r) => r.closingDebitSigned);

  // The two figures that re-slice equity. Their sum with contributedAndOther is
  // the equity section total, exactly — asserted as a tie check, not assumed.
  const retainedEarnings = retainedEarningsAccount
    .add(priorYearResultsInCye)
    .add(priorYearResultsInPnl);
  const currentYearResult = pnlYearToDate.add(cyeYearToDate);

  // The profit-and-loss accounts' contribution to equity, as two presented lines.
  const syntheticEquityLines: MappedLine<BalanceSheetSection>[] = [];
  if (!priorYearResultsInPnl.isZero() || method === 'DERIVED') {
    syntheticEquityLines.push({
      code: 'RETAINED_EARNINGS_DERIVED',
      label: 'Retained earnings from prior years (derived from profit and loss accounts)',
      section: 'EQUITY',
      sortOrder: Number.MAX_SAFE_INTEGER - 2,
      rows: [],
    });
  }
  syntheticEquityLines.push({
    code: 'CURRENT_YEAR_RESULT',
    label: 'Result for the year (per profit and loss accounts)',
    section: 'EQUITY',
    sortOrder: Number.MAX_SAFE_INTEGER - 1,
    rows: [],
  });

  const { sections, accounts, totals } = orderSections<BalanceSheetSection, BalanceAmounts>(
    BALANCE_SHEET_SECTIONS,
    lines,
    (rs) => rs.reduce<BalanceAmounts>((acc, r) => addBalances(acc, rowBalances(r)), ZERO_BALANCE),
    rowBalances,
    addBalances,
    ZERO_BALANCE,
  );

  // The synthetic equity lines carry no accounts of their own — their drill-down
  // is the profit and loss — so they are appended after mapping rather than
  // pushed through it.
  const derivedPrior: BalanceAmounts = {
    opening: pnlOpening.sub(pnlYearToDate.sub(pnlPeriod)),
    movement: ZERO,
    closing: priorYearResultsInPnl,
  };
  const currentYear: BalanceAmounts = {
    opening: pnlYearToDate.sub(pnlPeriod),
    movement: pnlPeriod,
    closing: pnlYearToDate,
  };
  const equityExtraLines: StatementLine<BalanceSheetSection, BalanceAmounts>[] = [];
  for (const spec of syntheticEquityLines) {
    equityExtraLines.push({
      code: spec.code,
      label: spec.label,
      section: 'EQUITY',
      sortOrder: spec.sortOrder,
      amounts: spec.code === 'CURRENT_YEAR_RESULT' ? currentYear : derivedPrior,
      accounts: [],
    });
  }
  const equityTotalFromLines = equityExtraLines.reduce<BalanceAmounts>(
    (acc, l) => addBalances(acc, l.amounts),
    totals.get('EQUITY') ?? ZERO_BALANCE,
  );
  const withEquity: StatementSectionTotal<BalanceSheetSection, BalanceAmounts>[] = sections.map(
    (s) =>
      s.section === 'EQUITY'
        ? {
            section: s.section,
            label: s.label,
            amounts: equityTotalFromLines,
            lines: [...s.lines, ...equityExtraLines],
          }
        : s,
  );

  const totalAssets = addBalances(
    addBalances(
      totals.get('CURRENT_ASSET') ?? ZERO_BALANCE,
      totals.get('NON_CURRENT_ASSET') ?? ZERO_BALANCE,
    ),
    totals.get('ASSET') ?? ZERO_BALANCE,
  );
  const totalLiabilities = addBalances(
    addBalances(
      totals.get('CURRENT_LIABILITY') ?? ZERO_BALANCE,
      totals.get('NON_CURRENT_LIABILITY') ?? ZERO_BALANCE,
    ),
    totals.get('LIABILITY') ?? ZERO_BALANCE,
  );
  const totalEquity = equityTotalFromLines;
  const difference = totalAssets.closing.sub(totalLiabilities.closing).sub(totalEquity.closing);

  const equityAccountMovement = creditPositive(equityRows, (r) => r.periodDebitSigned);

  const methodExceptions: StatementException[] = [];
  if (method === 'CLOSING_JOURNAL' && !priorYearResultsInPnl.isZero()) {
    methodExceptions.push({
      code: 'PRIOR_YEAR_NOT_CLOSED',
      message:
        `This book closes its result with PERIOD_CLOSE_PNL_TRANSFER, but the profit and loss ` +
        `accounts still carry ${priorYearResultsInPnl.toString()} from before the current ` +
        `fiscal year. A prior year was never closed to retained earnings; the amount is ` +
        `presented within retained earnings so the balance sheet ties, but the ledger and the ` +
        `policy disagree.`,
      amount: priorYearResultsInPnl,
    });
  }
  if (method === 'DERIVED' && !cyeYearToDate.isZero()) {
    methodExceptions.push({
      code: 'CLOSING_TRANSFER_IN_DERIVED_BOOK',
      message:
        `This book derives retained earnings and should post no closing journal, but the ` +
        `current-year-earnings account moved ${cyeYearToDate.toString()} year to date. Some ` +
        `process posted a PERIOD_CLOSE_PNL_TRANSFER into a DERIVED book.`,
      amount: cyeYearToDate,
    });
  }
  if (reRows.length === 0 && (method === 'CLOSING_JOURNAL' || !retainedEarnings.isZero())) {
    methodExceptions.push({
      code: 'RETAINED_EARNINGS_ACCOUNT_NOT_IDENTIFIED',
      message:
        `No account in this trial balance is marked RETAINED_EARNINGS, so retained earnings of ` +
        `${retainedEarnings.toString()} is presented entirely as a derived figure. Set ` +
        `accounting_policies.retained_earnings_account_id so the presented amount can be ` +
        `traced to the ledger account that holds it.`,
      amount: retainedEarnings,
    });
  }

  return {
    method,
    sections: withEquity,
    totalAssets,
    totalLiabilities,
    totalEquity,
    equity: {
      method,
      contributedAndOther,
      retainedEarnings,
      retainedEarningsAccount,
      priorYearResultsInProfitAndLoss: priorYearResultsInPnl,
      priorYearResultsInCurrentYearEarnings: priorYearResultsInCye,
      currentYearResult,
      currentYearEarningsTransfer: cyeYearToDate,
    },
    equityRollForward: {
      opening: totalEquity.opening,
      profitAndLossForPeriod: pnlPeriod,
      equityAccountMovement,
      closing: totalEquity.closing,
    },
    difference,
    balances: difference.isZero(),
    accounts,
    exceptions: [...exceptions, ...methodExceptions],
    definitionIsComplete: exceptions.length === 0,
  };
}

export function composeBalanceSheet(input: BalanceSheetInput): BalanceSheet {
  return composeBalanceSheetFrom(
    normalizeRows(input.rows),
    input.retainedEarningsMethod,
    input.lines ?? DEFAULT_BALANCE_SHEET_LINES,
    input.unmappedPolicy ?? 'REPORT',
  );
}

// ---------------------------------------------------------------------------
// Cash flow — classification-based direct method (doc 12, ADR-0001)
// ---------------------------------------------------------------------------

const CASH_FLOW_LABELS: Record<CashFlowClass, string> = {
  OPERATING: 'Cash flows from operating activities',
  INVESTING: 'Cash flows from investing activities',
  FINANCING: 'Cash flows from financing activities',
};

function composeCashFlowFrom(
  normalized: readonly NormalizedRow[],
  overrides: readonly CashFlowOverride[],
  window: 'PERIOD' | 'YEAR_TO_DATE',
  policy: UnmappedPolicy,
): CashFlowStatement {
  const byId = new Map(normalized.map((r) => [r.account.accountId, r]));
  const overrideById = new Map<string, CashFlowOverride>();
  for (const override of overrides) {
    const row = byId.get(override.accountId);
    if (row === undefined) {
      // An override registered against an account that is not in the trial
      // balance never executes, and the reader sees a classification policy that
      // silently did nothing.
      throw refuse(
        `CASH_FLOW_OVERRIDE_UNKNOWN_ACCOUNT: a cash-flow classification override names account ` +
          `${override.accountId}, which is not in this trial balance. The override would never ` +
          `apply and the statement would present the account's configured classification instead.`,
        { account_id: override.accountId, classification: override.classification },
      );
    }
    if (override.reason.trim() === '') {
      throw refuse(
        `CASH_FLOW_OVERRIDE_WITHOUT_REASON: the override moving account ${row.account.code} ` +
          `${row.account.name} to ${override.classification} carries no reason. doc 12 permits ` +
          `controlled overrides; an override nobody has to justify is not controlled.`,
        { account_id: override.accountId, account_code: row.account.code },
      );
    }
    if (row.account.isCash === true) {
      throw refuse(
        `CASH_FLOW_OVERRIDE_ON_CASH_ACCOUNT: account ${row.account.code} ${row.account.name} is ` +
          `a cash account, so it is the subject of the cash flow rather than a classified ` +
          `movement within it. The override would have no effect.`,
        { account_id: override.accountId, account_code: row.account.code },
      );
    }
    if (overrideById.has(override.accountId)) {
      throw refuse(
        `CASH_FLOW_OVERRIDE_DUPLICATE: account ${row.account.code} ${row.account.name} carries ` +
          `two cash-flow overrides. Which one applied would depend on ordering.`,
        { account_id: override.accountId, account_code: row.account.code },
      );
    }
    overrideById.set(override.accountId, override);
  }

  const movementOf = (r: NormalizedRow): Decimal =>
    window === 'PERIOD' ? r.periodDebitSigned : r.yearToDateDebitSigned;

  const cashRows = normalized.filter((r) => r.account.isCash === true);
  const closingCash = cashRows.reduce<Decimal>((acc, r) => acc.add(r.closingDebitSigned), ZERO);
  const cashMovement = cashRows.reduce<Decimal>((acc, r) => acc.add(movementOf(r)), ZERO);
  const openingCash = closingCash.sub(cashMovement);

  const buckets = new Map<CashFlowClass, CashFlowAccountAmount[]>([
    ['OPERATING', []],
    ['INVESTING', []],
    ['FINANCING', []],
  ]);
  const unclassifiedAccounts: CashFlowAccountAmount[] = [];
  const exceptions: StatementException[] = [];

  for (const row of normalized) {
    if (row.account.isCash === true) continue;
    // The cash effect of a non-cash movement is its negation: the other side of
    // every one of its entries is, eventually, cash. Summed over every non-cash
    // account this is exactly the movement in cash, because debits equal credits.
    const effect = movementOf(row).negate();
    const override = overrideById.get(row.account.accountId);
    // Null and 'NONE' are the same thing here, and both must be treated as
    // unclassified: a NULL that compares as "not NONE" is the failure mode that
    // lets an unclassified account slip into a total unnoticed.
    const configured = row.account.cashFlowClassification ?? 'NONE';
    const classification: CashFlowClassification = override?.classification ?? configured;
    const entry: CashFlowAccountAmount = {
      accountId: row.account.accountId,
      code: row.account.code,
      name: row.account.name,
      amount: effect,
      classification,
      overridden: override !== undefined,
      ...(override !== undefined ? { overrideReason: override.reason } : {}),
    };
    if (classification === 'NONE') {
      unclassifiedAccounts.push(entry);
      if (!effect.isZero()) {
        exceptions.push({
          code: 'CASH_FLOW_ACCOUNT_UNCLASSIFIED',
          message:
            `Account ${row.account.code} ${row.account.name} moved ${effect.toString()} of cash ` +
            `effect in this window but carries no cash-flow classification` +
            `${row.account.cashFlowClassification == null ? ' (it is null)' : ''}. It is ` +
            `excluded from operating, investing and financing, so those three do not add up to ` +
            `the movement in cash. Set accounts.cash_flow_classification or record a ` +
            `controlled override.`,
          accountId: row.account.accountId,
          accountCode: row.account.code,
          amount: effect,
        });
      }
      continue;
    }
    buckets.get(classification)?.push(entry);
  }

  if (policy === 'REJECT' && exceptions.length > 0) {
    const listed = exceptions
      .slice(0, 10)
      .map((e) => e.accountCode ?? '')
      .join(', ');
    throw refuse(
      `CASH_FLOW_ACCOUNT_UNCLASSIFIED: ${exceptions.length} account(s) moved cash in this ` +
        `window with no cash-flow classification (${listed}). Operating, investing and ` +
        `financing would not sum to the movement in cash, so no cash flow is produced.`,
      { unclassified: exceptions.map((e) => e.accountCode) },
    );
  }

  const sections: CashFlowSection[] = CASH_FLOW_CLASSES.map((classification) => {
    const entries = buckets.get(classification) ?? [];
    return {
      classification,
      label: CASH_FLOW_LABELS[classification],
      amount: entries.reduce<Decimal>((acc, e) => acc.add(e.amount), ZERO),
      accounts: entries,
    };
  });

  const amountOf = (c: CashFlowClass): Decimal =>
    sections.find((s) => s.classification === c)?.amount ?? ZERO;
  const operating = amountOf('OPERATING');
  const investing = amountOf('INVESTING');
  const financing = amountOf('FINANCING');
  const netMovementClassified = operating.add(investing).add(financing);
  const unclassifiedMovement = unclassifiedAccounts.reduce<Decimal>(
    (acc, e) => acc.add(e.amount),
    ZERO,
  );
  const difference = cashMovement.sub(netMovementClassified).sub(unclassifiedMovement);

  return {
    method: CASH_FLOW_METHOD,
    window,
    openingCash,
    closingCash,
    cashMovement,
    sections,
    operating,
    investing,
    financing,
    netMovementClassified,
    unclassifiedMovement,
    unclassifiedAccounts,
    difference,
    // Gate E wants beginning + movement = ending. It is not reconciled if part
    // of the movement sits in a bucket the statement does not present.
    reconciles: difference.isZero() && unclassifiedMovement.isZero(),
    cashAccounts: cashRows.map((r) => ({
      accountId: r.account.accountId,
      code: r.account.code,
      name: r.account.name,
      amount: movementOf(r),
      classification: 'NONE' as const,
      overridden: false,
    })),
    exceptions,
  };
}

export function composeCashFlow(input: CashFlowInput): CashFlowStatement {
  return composeCashFlowFrom(
    normalizeRows(input.rows),
    input.overrides ?? [],
    input.window ?? 'PERIOD',
    input.unclassifiedPolicy ?? 'REPORT',
  );
}

// ---------------------------------------------------------------------------
// The set, and the checks that make "ties exactly" a measurement
// ---------------------------------------------------------------------------

function tie(
  name: string,
  description: string,
  expected: Decimal,
  actual: Decimal,
): StatementTieCheck {
  const difference = actual.sub(expected);
  return { name, description, expected, actual, difference, ties: difference.isZero() };
}

export function composeFinancialStatements(input: FinancialStatementsInput): FinancialStatements {
  const normalized = normalizeRows(input.rows);
  const unmappedPolicy = input.unmappedPolicy ?? 'REPORT';

  const profitAndLoss = composeProfitAndLossFrom(
    normalized,
    input.profitAndLossLines ?? DEFAULT_PROFIT_AND_LOSS_LINES,
    unmappedPolicy,
  );
  const balanceSheet = composeBalanceSheetFrom(
    normalized,
    input.retainedEarningsMethod,
    input.balanceSheetLines ?? DEFAULT_BALANCE_SHEET_LINES,
    unmappedPolicy,
  );
  const cashFlow = composeCashFlowFrom(
    normalized,
    input.cashFlowOverrides ?? [],
    input.cashFlowWindow ?? 'PERIOD',
    input.unclassifiedCashFlowPolicy ?? 'REPORT',
  );

  // Recomputed straight from the trial balance rows, by a path that does not go
  // through the line mapping. That is the whole point: if the mapping dropped an
  // account or counted one twice, these are the numbers that disagree.
  const assetsFromRows = normalized
    .filter((r) => r.account.accountType === 'ASSET')
    .reduce<Decimal>((acc, r) => acc.add(r.closingDebitSigned), ZERO);
  const resultFromRows = creditPositive(
    normalized.filter(
      (r) => r.account.accountType === 'REVENUE' || r.account.accountType === 'EXPENSE',
    ),
    (r) => r.yearToDateDebitSigned,
  );

  const ties: StatementTieCheck[] = [
    tie(
      'BALANCE_SHEET_BALANCES',
      'assets − liabilities − equity, from the composed statement lines, at the closing date',
      ZERO,
      balanceSheet.totalAssets.closing
        .sub(balanceSheet.totalLiabilities.closing)
        .sub(balanceSheet.totalEquity.closing),
    ),
    tie(
      'BALANCE_SHEET_TIES_TO_TRIAL_BALANCE',
      'composed total assets against the asset rows of the trial balance',
      assetsFromRows,
      balanceSheet.totalAssets.closing,
    ),
    tie(
      'PROFIT_AND_LOSS_TIES_TO_TRIAL_BALANCE',
      'composed year-to-date result against revenue less expense in the trial balance',
      resultFromRows,
      profitAndLoss.result.yearToDate,
    ),
    tie(
      'EQUITY_ROLL_FORWARD',
      'opening equity + result for the period + equity account movement = closing equity',
      balanceSheet.equityRollForward.closing,
      balanceSheet.equityRollForward.opening
        .add(balanceSheet.equityRollForward.profitAndLossForPeriod)
        .add(balanceSheet.equityRollForward.equityAccountMovement),
    ),
    tie(
      'EQUITY_ANALYSIS',
      'contributed and other + retained earnings + result for the year = total equity',
      balanceSheet.totalEquity.closing,
      balanceSheet.equity.contributedAndOther
        .add(balanceSheet.equity.retainedEarnings)
        .add(balanceSheet.equity.currentYearResult),
    ),
    tie(
      'CURRENT_YEAR_RESULT_TIES_TO_PROFIT_AND_LOSS',
      "the balance sheet's result for the year against the profit and loss, including any " +
        'amount a closing journal has already transferred',
      profitAndLoss.result.yearToDate.add(balanceSheet.equity.currentYearEarningsTransfer),
      balanceSheet.equity.currentYearResult,
    ),
    tie(
      'CASH_FLOW_RECONCILES',
      'closing cash − opening cash = operating + investing + financing + unclassified',
      cashFlow.cashMovement,
      cashFlow.netMovementClassified.add(cashFlow.unclassifiedMovement),
    ),
  ];

  return {
    retainedEarningsMethod: input.retainedEarningsMethod,
    trialBalance: trialBalanceTotals(input.rows),
    profitAndLoss,
    balanceSheet,
    cashFlow,
    ties,
    tiesExactly: ties.every((t) => t.ties),
    exceptions: [...profitAndLoss.exceptions, ...balanceSheet.exceptions, ...cashFlow.exceptions],
  };
}

/**
 * Throws unless every tie holds exactly.
 *
 * For the paths that issue statements rather than display them — the financial
 * snapshot, the close run's statement approval. A tie that fails is not a bad
 * request from the caller; it is this engine's arithmetic disagreeing with
 * itself, so it surfaces as INTERNAL and the detail stays in the log.
 */
export function assertStatementsTie(statements: FinancialStatements): void {
  const failed = statements.ties.filter((t) => !t.ties);
  if (failed.length === 0) return;
  throw new AppError(
    'INTERNAL',
    `STATEMENTS_DO_NOT_TIE: ${failed
      .map((f) => `${f.name} out by ${f.difference.toString()} (${f.description})`)
      .join('; ')}.`,
    {
      safeToExpose: false,
      details: {
        failed: failed.map((f) => ({
          name: f.name,
          expected: f.expected.toString(),
          actual: f.actual.toString(),
          difference: f.difference.toString(),
        })),
      },
    },
  );
}

/** Convenience for callers that only need the money, as wire-format strings. */
export const statementAmountStrings = (a: StatementAmounts): Record<string, string | null> => ({
  period: a.period.toString(),
  comparative: a.comparative === null ? null : a.comparative.toString(),
  year_to_date: a.yearToDate.toString(),
});

/**
 * Builds a `TrialBalanceWindow` from decimal strings, for callers reading SQL rows.
 *
 * Deliberately parses at the string's own scale rather than rescaling to
 * MONEY_SCALE: rescaling here would round a value carrying more precision than
 * numeric(24,8) into range, and the rounding would be invisible. Left alone, the
 * composition refuses it by name (TRIAL_BALANCE_AMOUNT_PRECISION).
 */
export const trialBalanceWindow = (debit: string, credit: string): TrialBalanceWindow => ({
  debit: D(debit),
  credit: D(credit),
});
