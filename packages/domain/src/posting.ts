/**
 * The posting service algorithm, as a pure function.
 *
 * doc 03 numbers seventeen steps. Steps 1-5 and 13-17 need a database — the source
 * event, the period, the rule version, the number sequence, the insert. Steps 6-12
 * do not:
 *
 *    6. Build lines from immutable source facts.
 *    8. Validate accounts active/postable.
 *    9. Validate dimension rules.
 *   10. Validate each line has debit XOR credit.
 *   11. Validate base debit total equals base credit total.
 *   12. Add permitted explicit rounding line if required.
 *
 * They live here, with no `pg` import, because Gate C's first criterion is
 * "property tests cannot create an unbalanced POSTED journal" and a property test
 * that needs a transaction per case runs a hundred cases, not a hundred thousand.
 * The service in apps/api resolves the facts and calls this; the database asserts
 * the same invariant a third time at COMMIT (0006). Three layers, one rule.
 *
 * Everything here is total: it either returns a journal that balances exactly in
 * base currency, or it throws. There is no third outcome, and no path that rounds
 * an imbalance away silently — ADR-0006 §5: "Rounding is never used to absorb an
 * unexplained imbalance."
 */
import { AppError, type ErrorCode, type FieldError } from './errors';
import { Decimal, D, MONEY_SCALE, type RoundingMode, DEFAULT_ROUNDING } from './decimal';
import { Money } from './money';
import { type CurrencyPrecision, UnknownCurrencyError } from './currency';
import { convertToBase, roundToMinorUnit } from './rounding';

export type AccountTypeCode = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
export type NormalBalance = 'DEBIT' | 'CREDIT';
export type DimensionRuleCode = 'REQUIRED' | 'OPTIONAL' | 'PROHIBITED' | 'DEFAULTED';
export type AccountStatus = 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';

/** doc 03: "For each account/source module configure dimension rule." */
export interface AccountDimensionRule {
  readonly dimensionId: string;
  readonly dimensionCode: string;
  readonly rule: DimensionRuleCode;
  readonly defaultValueId: string | null;
}

export interface PostingAccount {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly accountType: AccountTypeCode;
  readonly normalBalance: NormalBalance;
  readonly isPosting: boolean;
  readonly isControl: boolean;
  readonly status: AccountStatus;
  readonly dimensionRules: readonly AccountDimensionRule[];
}

export interface DraftLineInput {
  readonly lineNo?: number;
  readonly accountId: string;
  readonly description?: string | null;
  /** Defaults to the book's base currency. */
  readonly transactionCurrency?: string | undefined;
  readonly debit?: string | undefined;
  readonly credit?: string | undefined;
  /** Required when the transaction currency is not the base currency. */
  readonly exchangeRate?: string | null | undefined;
  readonly exchangeRateDate?: string | null | undefined;
  readonly exchangeRateSource?: string | null | undefined;
  readonly branchId?: string | null | undefined;
  readonly contactId?: string | null | undefined;
  /** dimension id -> dimension value id. */
  readonly dimensions?: Readonly<Record<string, string>> | undefined;
}

export interface PreparedLine {
  readonly lineNo: number;
  readonly accountId: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly accountType: AccountTypeCode;
  readonly isControl: boolean;
  readonly description: string | null;
  readonly transactionCurrency: string;
  readonly transactionDebit: string;
  readonly transactionCredit: string;
  readonly baseCurrency: string;
  readonly baseDebit: string;
  readonly baseCredit: string;
  readonly exchangeRate: string | null;
  readonly exchangeRateDate: string | null;
  readonly exchangeRateSource: string | null;
  readonly branchId: string | null;
  readonly contactId: string | null;
  readonly dimensions: readonly { dimensionId: string; dimensionValueId: string }[];
  /** True for the line step 12 added, so it can be labelled and audited as such. */
  readonly isRoundingAdjustment: boolean;
}

export interface PreparedJournal {
  readonly baseCurrency: string;
  readonly lines: readonly PreparedLine[];
  readonly totalBaseDebit: string;
  readonly totalBaseCredit: string;
  /** Signed: positive means debits exceeded credits before the adjustment. */
  readonly roundingAdjustment: string | null;
  /** Drives the journal.post_control check; the caller holds the permission, not this module. */
  readonly controlAccounts: readonly string[];
}

export interface PostingContext {
  readonly baseCurrency: string;
  readonly accounts: ReadonlyMap<string, PostingAccount>;
  readonly currencies: ReadonlyMap<string, CurrencyPrecision>;
  readonly roundingMode?: RoundingMode | undefined;
  /** `accounting_policies.rounding_account_id`. Without it, no adjustment is possible. */
  readonly roundingAccountId?: string | null | undefined;
  /** `accounting_policies.rounding_tolerance`, an absolute amount in base currency. */
  readonly roundingTolerance?: string | null | undefined;
}

// ---------------------------------------------------------------------------

/**
 * Exported because document calculation (`documents.ts`) needs the same
 * behaviour, and a second implementation would be a second answer to "what does
 * a validation failure look like" — which is how a caller ends up parsing two
 * error shapes for the same class of problem.
 */
export class ProblemList {
  private readonly problems: FieldError[] = [];
  private worst: ErrorCode | null = null;

  add(field: string, code: string, message: string, escalateTo?: ErrorCode): void {
    this.problems.push({ field, code, message });
    // The most specific accounting code wins, so a caller matching on
    // ACCOUNT_NOT_POSTABLE still sees every other problem in field_errors rather
    // than discovering them one deploy at a time.
    if (escalateTo && this.worst === null) this.worst = escalateTo;
  }

  get length(): number {
    return this.problems.length;
  }

  /**
   * The summary quotes the problems themselves, not their count.
   *
   * `field_errors` carries the structured form for a form to render, but plenty of
   * callers log or display `message` alone — a CLI, an integration, a worker's
   * failure record. "3 problem(s) in its lines" tells that reader nothing they can
   * act on, which is the same defect as a stack trace: technically a message.
   */
  throwIfAny(prefix: string): void {
    if (this.problems.length === 0) return;
    const shown = this.problems.slice(0, 3).map((p) => p.message);
    const more = this.problems.length > 3 ? ` (+${this.problems.length - 3} more)` : '';
    throw new AppError(this.worst ?? 'VALIDATION_FAILED', `${prefix} ${shown.join(' ')}${more}`, {
      fieldErrors: this.problems,
      details: { problems: this.problems.length },
    });
  }
}

const ZERO = '0';

function parseAmount(
  raw: string | undefined,
  field: string,
  problems: ProblemList,
): Decimal | null {
  if (raw === undefined || raw === null || raw === '') return Decimal.zero(MONEY_SCALE);
  let value: Decimal;
  try {
    value = D(raw, MONEY_SCALE);
  } catch {
    problems.add(field, 'NOT_A_DECIMAL', `"${raw}" is not a decimal amount.`);
    return null;
  }
  if (value.isNegative()) {
    // journal_lines.jl_nonneg rejects it anyway. Refusing here means the caller is
    // told to flip the side, rather than reading a constraint name out of a 500.
    problems.add(
      field,
      'NEGATIVE',
      'Amounts are unsigned; a negative value is the other side of the entry, not a negative debit.',
    );
    return null;
  }
  return value;
}

/**
 * doc 03 steps 6 and 8-12.
 *
 * `postingDate` is not an input: period resolution happens against the database
 * before this is called, and passing the date here would invite a second, subtly
 * different resolution (F-403 is exactly that defect).
 */
export function preparePosting(
  input: readonly DraftLineInput[],
  context: PostingContext,
): PreparedJournal {
  const { prepared, controlAccounts, convertedLines } = prepareLines(input, context);
  return balance(prepared, controlAccounts, convertedLines, context);
}

/**
 * The same line validation, without the balance assertion.
 *
 * doc 03: "Draft may be temporarily unbalanced; POSTED may never be unbalanced." A
 * draft is a work in progress — an accountant enters one side, goes to look up the
 * other, and comes back. Refusing to save that is refusing to be used.
 *
 * Everything else still applies: the accounts must exist and be postable, the
 * dimension rules must hold, and the base amounts are computed the same way, so
 * what the draft shows is what posting will produce. Only the totals are allowed to
 * disagree, and `isBalanced` says whether they do.
 */
export function prepareDraft(
  input: readonly DraftLineInput[],
  context: PostingContext,
): PreparedJournal & { readonly isBalanced: boolean } {
  const { prepared, controlAccounts } = prepareLines(input, context);
  const debit = prepared.reduce(
    (a, l) => a.add(D(l.baseDebit, MONEY_SCALE)),
    Decimal.zero(MONEY_SCALE),
  );
  const credit = prepared.reduce(
    (a, l) => a.add(D(l.baseCredit, MONEY_SCALE)),
    Decimal.zero(MONEY_SCALE),
  );
  return {
    baseCurrency: context.baseCurrency,
    lines: prepared,
    totalBaseDebit: debit.toFixed(MONEY_SCALE),
    totalBaseCredit: credit.toFixed(MONEY_SCALE),
    roundingAdjustment: null,
    controlAccounts,
    isBalanced: debit.equals(credit),
  };
}

function prepareLines(
  input: readonly DraftLineInput[],
  context: PostingContext,
): { prepared: PreparedLine[]; controlAccounts: string[]; convertedLines: number } {
  const problems = new ProblemList();
  const mode = context.roundingMode ?? DEFAULT_ROUNDING;
  const basePrecision = context.currencies.get(context.baseCurrency);
  if (!basePrecision) throw new UnknownCurrencyError(context.baseCurrency);

  if (input.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'A journal must have at least one line.', {
      fieldErrors: [{ field: 'lines', code: 'REQUIRED', message: 'at least one line is required' }],
    });
  }

  const prepared: PreparedLine[] = [];
  const controlAccounts: string[] = [];
  let convertedLines = 0;

  input.forEach((line, index) => {
    const at = `lines[${index}]`;
    const lineNo = line.lineNo ?? index + 1;

    // --- step 8: the account -------------------------------------------------
    const account = context.accounts.get(line.accountId);
    if (!account) {
      problems.add(`${at}.account_id`, 'UNKNOWN', `No account ${line.accountId} in this entity.`);
      return;
    }
    if (!account.isPosting) {
      problems.add(
        `${at}.account_id`,
        'NOT_POSTABLE',
        `${account.code} ${account.name} is a heading account and cannot receive lines (doc 03).`,
        'ACCOUNT_NOT_POSTABLE',
      );
    }
    if (account.status !== 'ACTIVE') {
      problems.add(
        `${at}.account_id`,
        'NOT_ACTIVE',
        `${account.code} ${account.name} is ${account.status}.`,
        'ACCOUNT_NOT_POSTABLE',
      );
    }
    if (account.isControl && !controlAccounts.includes(account.id))
      controlAccounts.push(account.id);

    // --- step 10: debit XOR credit ------------------------------------------
    const debit = parseAmount(line.debit, `${at}.debit`, problems);
    const credit = parseAmount(line.credit, `${at}.credit`, problems);
    if (debit === null || credit === null) return;
    if (debit.isPositive() && credit.isPositive()) {
      problems.add(
        `${at}.debit`,
        'DEBIT_XOR_CREDIT',
        'A line carries a debit or a credit, never both (doc 03 step 10).',
      );
      return;
    }

    // --- currency and rate ---------------------------------------------------
    const txnCurrency = (line.transactionCurrency ?? context.baseCurrency).toUpperCase();
    const txnPrecision = context.currencies.get(txnCurrency);
    if (!txnPrecision) {
      problems.add(
        `${at}.transaction_currency`,
        'UNKNOWN_CURRENCY',
        `${txnCurrency} is not an active currency.`,
      );
      return;
    }

    // Amounts must already sit on the currency's minor unit. ADR-0006 step 6
    // asserts rather than rounds: a value arriving here with more precision means
    // an earlier boundary was skipped, and rounding it now would hide that.
    for (const [name, value] of [
      ['debit', debit],
      ['credit', credit],
    ] as const) {
      const reduced = value.rescale(txnPrecision.minorUnit, 'DOWN').rescale(MONEY_SCALE);
      if (!reduced.equals(value)) {
        problems.add(
          `${at}.${name}`,
          'PRECISION',
          `${value.toString()} has more precision than ${txnCurrency}'s ${txnPrecision.minorUnit} ` +
            `minor units (ADR-0006 step 6).`,
        );
      }
    }

    let rate: Decimal | null = null;
    if (txnCurrency !== context.baseCurrency) {
      if (
        line.exchangeRate === undefined ||
        line.exchangeRate === null ||
        line.exchangeRate === ''
      ) {
        problems.add(
          `${at}.exchange_rate`,
          'REQUIRED',
          `A ${txnCurrency} line in a ${context.baseCurrency} book needs an exchange rate.`,
        );
        return;
      }
      try {
        rate = D(line.exchangeRate);
      } catch {
        problems.add(`${at}.exchange_rate`, 'NOT_A_DECIMAL', 'The exchange rate is not a decimal.');
        return;
      }
      if (!rate.isPositive()) {
        problems.add(`${at}.exchange_rate`, 'NOT_POSITIVE', 'An exchange rate must be positive.');
        return;
      }
      convertedLines += 1;
    }

    // --- step 9: dimension rules --------------------------------------------
    const supplied = { ...(line.dimensions ?? {}) };
    const resolved: { dimensionId: string; dimensionValueId: string }[] = [];
    for (const rule of account.dimensionRules) {
      const value = supplied[rule.dimensionId];
      delete supplied[rule.dimensionId];
      switch (rule.rule) {
        case 'REQUIRED':
          if (!value) {
            problems.add(
              `${at}.dimensions.${rule.dimensionCode}`,
              'REQUIRED',
              `${account.code} requires a ${rule.dimensionCode} value.`,
            );
          } else {
            resolved.push({ dimensionId: rule.dimensionId, dimensionValueId: value });
          }
          break;
        case 'PROHIBITED':
          if (value) {
            problems.add(
              `${at}.dimensions.${rule.dimensionCode}`,
              'PROHIBITED',
              `${account.code} does not accept a ${rule.dimensionCode} value.`,
            );
          }
          break;
        case 'DEFAULTED':
          // The rule guarantees a default exists (adr_default_requires_defaulted),
          // and the default is scoped to the entity (adr_default_scope_fk), so this
          // cannot quietly introduce another entity's value.
          if (value) resolved.push({ dimensionId: rule.dimensionId, dimensionValueId: value });
          else if (rule.defaultValueId) {
            resolved.push({ dimensionId: rule.dimensionId, dimensionValueId: rule.defaultValueId });
          }
          break;
        case 'OPTIONAL':
          if (value) resolved.push({ dimensionId: rule.dimensionId, dimensionValueId: value });
          break;
      }
    }
    // Anything left over has no rule on this account. Accepted — doc 03 makes
    // OPTIONAL the default posture, and PROHIBITED is how you say no.
    for (const [dimensionId, dimensionValueId] of Object.entries(supplied)) {
      resolved.push({ dimensionId, dimensionValueId });
    }

    // --- step 5 of ADR-0006: base conversion, once, per line -----------------
    const toBase = (value: Decimal): string => {
      if (value.isZero()) return Money.zero(context.baseCurrency).toStorageString();
      if (rate === null) {
        return roundToMinorUnit(
          Money.of(value, context.baseCurrency),
          basePrecision,
          mode,
        ).toStorageString();
      }
      return convertToBase(
        Money.of(value, txnCurrency),
        rate,
        basePrecision,
        mode,
      ).toStorageString();
    };

    prepared.push({
      lineNo,
      accountId: account.id,
      accountCode: account.code,
      accountName: account.name,
      accountType: account.accountType,
      isControl: account.isControl,
      description: line.description ?? null,
      transactionCurrency: txnCurrency,
      transactionDebit: debit.toFixed(MONEY_SCALE),
      transactionCredit: credit.toFixed(MONEY_SCALE),
      baseCurrency: context.baseCurrency,
      baseDebit: toBase(debit),
      baseCredit: toBase(credit),
      exchangeRate: rate === null ? null : rate.toString(),
      exchangeRateDate: line.exchangeRateDate ?? null,
      exchangeRateSource: line.exchangeRateSource ?? null,
      branchId: line.branchId ?? null,
      contactId: line.contactId ?? null,
      dimensions: resolved,
      isRoundingAdjustment: false,
    });
  });

  problems.throwIfAny('This journal cannot be posted.');
  return { prepared, controlAccounts, convertedLines };
}

/** Steps 11 and 12, applied to lines that have already passed 6 and 8-10. */
function balance(
  prepared: PreparedLine[],
  controlAccounts: readonly string[],
  convertedLines: number,
  context: PostingContext,
): PreparedJournal {
  const basePrecision = context.currencies.get(context.baseCurrency);
  if (!basePrecision) throw new UnknownCurrencyError(context.baseCurrency);
  const mode = context.roundingMode ?? DEFAULT_ROUNDING;

  const sum = (pick: (l: PreparedLine) => string): Decimal =>
    prepared.reduce((acc, l) => acc.add(D(pick(l), MONEY_SCALE)), Decimal.zero(MONEY_SCALE));

  let debitTotal = sum((l) => l.baseDebit);
  let creditTotal = sum((l) => l.baseCredit);

  // F-001 / 0006: zero lines are legal, a journal of nothing but zero lines is not.
  if (debitTotal.isZero() && creditTotal.isZero()) {
    throw new AppError(
      'UNBALANCED_JOURNAL',
      'Every line is zero. A journal with no non-zero line records nothing (0006).',
      { details: { lines: prepared.length } },
    );
  }

  let adjustment: Decimal | null = null;
  const delta = debitTotal.sub(creditTotal);
  if (!delta.isZero()) {
    const line = roundingLine(delta, prepared, {
      context,
      basePrecision,
      convertedLines,
      mode,
    });
    prepared.push(line);
    adjustment = delta;
    debitTotal = sum((l) => l.baseDebit);
    creditTotal = sum((l) => l.baseCredit);
  }

  // Belt and braces: after the adjustment the totals must be exactly equal. If this
  // ever fires, the adjustment arithmetic is wrong, and it is far better to learn
  // that here than from a deferred constraint trigger at COMMIT.
  if (!debitTotal.equals(creditTotal)) {
    throw new AppError(
      'UNBALANCED_JOURNAL',
      `Journal is unbalanced after adjustment: debits ${debitTotal.toString()} vs credits ` +
        `${creditTotal.toString()} ${context.baseCurrency}.`,
      { details: { debit: debitTotal.toString(), credit: creditTotal.toString() } },
    );
  }

  return {
    baseCurrency: context.baseCurrency,
    lines: prepared,
    totalBaseDebit: debitTotal.toFixed(MONEY_SCALE),
    totalBaseCredit: creditTotal.toFixed(MONEY_SCALE),
    roundingAdjustment: adjustment === null ? null : adjustment.toString(),
    controlAccounts,
  };
}

/**
 * ADR-0006 §5 and the catalog's ROUNDING_ADJUSTMENT rule.
 *
 * The tolerance is the larger of the configured `rounding_tolerance` and one minor
 * unit per line the posting service itself converted. The second term is the
 * principled one: base conversion is the only rounding this module performs, so a
 * line given directly in base currency cannot have contributed error, and counting
 * it would widen the tolerance for free. A delta beyond that is not a rounding
 * residual and is refused — the catalog's own words are "Never use rounding to hide
 * an unexplained imbalance."
 */
function roundingLine(
  delta: Decimal,
  lines: readonly PreparedLine[],
  options: {
    context: PostingContext;
    basePrecision: CurrencyPrecision;
    convertedLines: number;
    mode: RoundingMode;
  },
): PreparedLine {
  const { context, basePrecision, convertedLines } = options;
  const oneMinorUnit = Decimal.fromUnits(1n, basePrecision.minorUnit).rescale(MONEY_SCALE);
  const structural = oneMinorUnit.mul(D(Math.max(convertedLines, 0))).rescale(MONEY_SCALE);
  const configured = context.roundingTolerance
    ? D(context.roundingTolerance, MONEY_SCALE)
    : Decimal.zero(MONEY_SCALE);
  const tolerance = structural.gt(configured) ? structural : configured;

  if (delta.abs().gt(tolerance)) {
    throw new AppError(
      'UNBALANCED_JOURNAL',
      `Debits and credits differ by ${delta.toString()} ${context.baseCurrency}. ` +
        (convertedLines === 0
          ? 'No line was currency-converted, so no part of this is a rounding residual — the ' +
            'entry itself does not balance.'
          : `That exceeds the ${tolerance.toString()} attributable to rounding across ` +
            `${convertedLines} converted line(s) (ADR-0006 §5).`),
      {
        details: {
          delta: delta.toString(),
          tolerance: tolerance.toString(),
          converted_lines: convertedLines,
        },
      },
    );
  }

  const roundingAccountId = context.roundingAccountId;
  if (!roundingAccountId) {
    throw new AppError(
      'ROUNDING_IMBALANCE',
      `A rounding residual of ${delta.toString()} ${context.baseCurrency} needs a rounding ` +
        'account, and the accounting policy has none configured (ADR-0006 §5).',
      { details: { delta: delta.toString() } },
    );
  }
  const account = context.accounts.get(roundingAccountId);
  if (!account) {
    throw new AppError(
      'ROUNDING_IMBALANCE',
      `The accounting policy names rounding account ${roundingAccountId}, which does not exist ` +
        'in this entity.',
      { details: { rounding_account_id: roundingAccountId } },
    );
  }

  // The adjustment takes the opposite side of the residual: debits exceeded
  // credits, so the adjustment is a credit.
  const magnitude = delta.abs().toFixed(MONEY_SCALE);
  const zero = Decimal.zero(MONEY_SCALE).toFixed(MONEY_SCALE);
  const onDebitSide = delta.isNegative();

  return {
    lineNo: (lines[lines.length - 1]?.lineNo ?? 0) + 1,
    accountId: account.id,
    accountCode: account.code,
    accountName: account.name,
    accountType: account.accountType,
    isControl: account.isControl,
    description: `Rounding adjustment (ADR-0006 §5): residual ${delta.toString()} across ${convertedLines} converted line(s)`,
    transactionCurrency: context.baseCurrency,
    transactionDebit: onDebitSide ? magnitude : zero,
    transactionCredit: onDebitSide ? zero : magnitude,
    baseCurrency: context.baseCurrency,
    baseDebit: onDebitSide ? magnitude : zero,
    baseCredit: onDebitSide ? zero : magnitude,
    exchangeRate: null,
    exchangeRateDate: null,
    exchangeRateSource: null,
    branchId: null,
    contactId: null,
    dimensions: [],
    isRoundingAdjustment: true,
  };
}

/**
 * The reversal of a prepared journal: the same lines with debit and credit swapped.
 *
 * doc 03: "Full reversal copies original lines with debit/credit inverted." Copies,
 * not recomputes — re-deriving base amounts from today's exchange rate would make a
 * reversal that does not cancel the original, which is the one thing a reversal has
 * to do. The rounding adjustment line is inverted along with everything else for
 * the same reason.
 */
export function reverseLines(lines: readonly PreparedLine[]): PreparedLine[] {
  return lines.map((line) => ({
    ...line,
    transactionDebit: line.transactionCredit,
    transactionCredit: line.transactionDebit,
    baseDebit: line.baseCredit,
    baseCredit: line.baseDebit,
  }));
}

/**
 * Signed balance in the account's own reporting direction.
 *
 * Trial Balance and the account activity report both need it, and the sign
 * convention is the thing every ad-hoc implementation gets subtly different:
 * a debit-normal account with more credits than debits has a NEGATIVE balance,
 * it does not swap columns.
 */
export function signedBalance(
  debit: string | Decimal,
  credit: string | Decimal,
  normalBalance: NormalBalance,
): Decimal {
  const d = D(debit, MONEY_SCALE);
  const c = D(credit, MONEY_SCALE);
  return normalBalance === 'DEBIT' ? d.sub(c) : c.sub(d);
}

/**
 * The accounting equation, in the only form that is true mid-year.
 *
 * doc 21's Phase 2 exit criterion says the opening trial balance "validates
 * Assets = Liabilities + Equity". Taken literally that is false for any cutover
 * that is not on the first day of a fiscal year: a mid-year opening balance
 * legitimately carries year-to-date revenue and expense, and those close into
 * equity only at year end. Assets = Liabilities + Equity + (Revenue - Expenses) is
 * the same statement with current-year earnings left where they are, and it is
 * equivalent to debits = credits, which is what makes it checkable at all.
 */
export interface AccountingEquation {
  readonly assets: string;
  readonly liabilities: string;
  readonly equity: string;
  readonly revenue: string;
  readonly expenses: string;
  readonly currentYearEarnings: string;
  readonly leftSide: string;
  readonly rightSide: string;
  readonly difference: string;
  readonly balances: boolean;
}

export function accountingEquation(
  rows: readonly { accountType: AccountTypeCode; debit: string; credit: string }[],
): AccountingEquation {
  const totals: Record<AccountTypeCode, Decimal> = {
    ASSET: Decimal.zero(MONEY_SCALE),
    LIABILITY: Decimal.zero(MONEY_SCALE),
    EQUITY: Decimal.zero(MONEY_SCALE),
    REVENUE: Decimal.zero(MONEY_SCALE),
    EXPENSE: Decimal.zero(MONEY_SCALE),
  };
  // Each type accumulates in its own natural direction, so every figure below is
  // reported positive when it is what an accountant would call normal.
  for (const row of rows) {
    const d = D(row.debit || ZERO, MONEY_SCALE);
    const c = D(row.credit || ZERO, MONEY_SCALE);
    const natural = row.accountType === 'ASSET' || row.accountType === 'EXPENSE';
    totals[row.accountType] = totals[row.accountType].add(natural ? d.sub(c) : c.sub(d));
  }

  const earnings = totals.REVENUE.sub(totals.EXPENSE);
  const left = totals.ASSET;
  const right = totals.LIABILITY.add(totals.EQUITY).add(earnings);
  const difference = left.sub(right);

  return {
    assets: totals.ASSET.toString(),
    liabilities: totals.LIABILITY.toString(),
    equity: totals.EQUITY.toString(),
    revenue: totals.REVENUE.toString(),
    expenses: totals.EXPENSE.toString(),
    currentYearEarnings: earnings.toString(),
    leftSide: left.toString(),
    rightSide: right.toString(),
    difference: difference.toString(),
    balances: difference.isZero(),
  };
}
