import { describe, it, expect } from 'vitest';
import { AppError } from './errors';
import { D, MONEY_SCALE } from './decimal';
import { BOOTSTRAP_CURRENCIES, type CurrencyPrecision } from './currency';
import {
  preparePosting,
  reverseLines,
  signedBalance,
  accountingEquation,
  type PostingAccount,
  type PostingContext,
  type DraftLineInput,
} from './posting';

const CURRENCIES = new Map<string, CurrencyPrecision>(BOOTSTRAP_CURRENCIES.map((c) => [c.code, c]));

function account(over: Partial<PostingAccount> & { id: string }): PostingAccount {
  return {
    code: over.id.toUpperCase(),
    name: `Account ${over.id}`,
    accountType: 'EXPENSE',
    normalBalance: 'DEBIT',
    isPosting: true,
    isControl: false,
    status: 'ACTIVE',
    dimensionRules: [],
    ...over,
  };
}

const CASH = account({ id: 'cash', code: '1000', accountType: 'ASSET', normalBalance: 'DEBIT' });
const EXPENSE = account({ id: 'expense', code: '6000' });
const AR = account({
  id: 'ar',
  code: '1100',
  accountType: 'ASSET',
  normalBalance: 'DEBIT',
  isControl: true,
});
const HEADING = account({ id: 'heading', code: '1', isPosting: false });
const ARCHIVED = account({ id: 'archived', code: '6999', status: 'ARCHIVED' });
const ROUNDING = account({ id: 'rounding', code: '7999' });

function context(over: Partial<PostingContext> = {}): PostingContext {
  return {
    baseCurrency: 'USD',
    accounts: new Map(
      [CASH, EXPENSE, AR, HEADING, ARCHIVED, ROUNDING].map((a) => [a.id, a] as const),
    ),
    currencies: CURRENCIES,
    roundingAccountId: ROUNDING.id,
    ...over,
  };
}

const line = (over: Partial<DraftLineInput> & { accountId: string }): DraftLineInput => ({
  debit: '0',
  credit: '0',
  ...over,
});

describe('preparePosting — balance', () => {
  it('accepts a balanced two-line journal', () => {
    const result = preparePosting(
      [
        line({ accountId: EXPENSE.id, debit: '100.00' }),
        line({ accountId: CASH.id, credit: '100.00' }),
      ],
      context(),
    );
    expect(result.totalBaseDebit).toBe(result.totalBaseCredit);
    expect(result.roundingAdjustment).toBeNull();
    expect(result.lines).toHaveLength(2);
  });

  it('refuses an unbalanced journal with no converted line, and says why', () => {
    expect(() =>
      preparePosting(
        [
          line({ accountId: EXPENSE.id, debit: '100.00' }),
          line({ accountId: CASH.id, credit: '90.00' }),
        ],
        context(),
      ),
    ).toThrow(/No line was currency-converted/);
  });

  it('rejects a journal whose every line is zero', () => {
    // F-001 permits a zero line; 0006 refuses a journal that is only zero lines.
    expect(() =>
      preparePosting(
        [line({ accountId: EXPENSE.id, debit: '0' }), line({ accountId: CASH.id, credit: '0' })],
        context(),
      ),
    ).toThrow(/no non-zero line|records nothing/);
  });

  it('permits an individual zero-value line (F-001)', () => {
    const result = preparePosting(
      [
        line({ accountId: EXPENSE.id, debit: '100.00' }),
        line({ accountId: EXPENSE.id, debit: '0', description: 'zero-cost issue' }),
        line({ accountId: CASH.id, credit: '100.00' }),
      ],
      context(),
    );
    expect(result.lines).toHaveLength(3);
    expect(result.totalBaseDebit).toBe(result.totalBaseCredit);
  });

  it('refuses a line carrying both a debit and a credit', () => {
    expect(() =>
      preparePosting(
        [
          line({ accountId: EXPENSE.id, debit: '10.00', credit: '10.00' }),
          line({ accountId: CASH.id, credit: '10.00' }),
        ],
        context(),
      ),
    ).toThrow(/debit or a credit, never both/);
  });

  it('refuses a negative amount rather than storing a negative debit', () => {
    try {
      preparePosting([line({ accountId: EXPENSE.id, debit: '-10.00' })], context());
      expect.unreachable();
    } catch (e) {
      expect(AppError.isAppError(e)).toBe(true);
      expect((e as AppError).fieldErrors[0]?.code).toBe('NEGATIVE');
    }
  });
});

describe('preparePosting — accounts', () => {
  it('refuses a heading account and reports ACCOUNT_NOT_POSTABLE', () => {
    try {
      preparePosting(
        [
          line({ accountId: HEADING.id, debit: '5.00' }),
          line({ accountId: CASH.id, credit: '5.00' }),
        ],
        context(),
      );
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('ACCOUNT_NOT_POSTABLE');
    }
  });

  it('refuses an archived account', () => {
    expect(() =>
      preparePosting(
        [
          line({ accountId: ARCHIVED.id, debit: '5.00' }),
          line({ accountId: CASH.id, credit: '5.00' }),
        ],
        context(),
      ),
    ).toThrow(/ARCHIVED/);
  });

  it('reports every problem at once rather than the first', () => {
    try {
      preparePosting(
        [
          line({ accountId: HEADING.id, debit: '5.00' }),
          line({ accountId: ARCHIVED.id, credit: '5.00' }),
          line({ accountId: 'nope', debit: '1.00' }),
        ],
        context(),
      );
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).fieldErrors.length).toBe(3);
    }
  });

  it('names the control accounts it touched without deciding the permission', () => {
    const result = preparePosting(
      [line({ accountId: AR.id, debit: '5.00' }), line({ accountId: CASH.id, credit: '5.00' })],
      context(),
    );
    expect(result.controlAccounts).toEqual([AR.id]);
  });
});

describe('preparePosting — dimensions (doc 03 step 9)', () => {
  const DEPT = 'dept-dimension';
  const withRules = (rule: 'REQUIRED' | 'PROHIBITED' | 'DEFAULTED' | 'OPTIONAL') =>
    context({
      accounts: new Map([
        [
          EXPENSE.id,
          account({
            id: EXPENSE.id,
            code: '6000',
            dimensionRules: [
              {
                dimensionId: DEPT,
                dimensionCode: 'DEPT',
                rule,
                defaultValueId: rule === 'DEFAULTED' ? 'dept-default' : null,
              },
            ],
          }),
        ],
        [CASH.id, CASH],
        [ROUNDING.id, ROUNDING],
      ]),
    });

  it('REQUIRED refuses a line without the dimension', () => {
    expect(() =>
      preparePosting(
        [
          line({ accountId: EXPENSE.id, debit: '5.00' }),
          line({ accountId: CASH.id, credit: '5.00' }),
        ],
        withRules('REQUIRED'),
      ),
    ).toThrow(/requires a DEPT value/);
  });

  it('PROHIBITED refuses a line that supplies one', () => {
    expect(() =>
      preparePosting(
        [
          line({ accountId: EXPENSE.id, debit: '5.00', dimensions: { [DEPT]: 'sales' } }),
          line({ accountId: CASH.id, credit: '5.00' }),
        ],
        withRules('PROHIBITED'),
      ),
    ).toThrow(/does not accept a DEPT value/);
  });

  it('DEFAULTED fills the configured value in', () => {
    const result = preparePosting(
      [
        line({ accountId: EXPENSE.id, debit: '5.00' }),
        line({ accountId: CASH.id, credit: '5.00' }),
      ],
      withRules('DEFAULTED'),
    );
    expect(result.lines[0]?.dimensions).toEqual([
      { dimensionId: DEPT, dimensionValueId: 'dept-default' },
    ]);
  });

  it('DEFAULTED prefers an explicitly supplied value over the default', () => {
    const result = preparePosting(
      [
        line({ accountId: EXPENSE.id, debit: '5.00', dimensions: { [DEPT]: 'chosen' } }),
        line({ accountId: CASH.id, credit: '5.00' }),
      ],
      withRules('DEFAULTED'),
    );
    expect(result.lines[0]?.dimensions[0]?.dimensionValueId).toBe('chosen');
  });

  it('OPTIONAL accepts either', () => {
    const without = preparePosting(
      [
        line({ accountId: EXPENSE.id, debit: '5.00' }),
        line({ accountId: CASH.id, credit: '5.00' }),
      ],
      withRules('OPTIONAL'),
    );
    expect(without.lines[0]?.dimensions).toEqual([]);
  });
});

describe('preparePosting — currency (ADR-0006)', () => {
  it('converts a foreign line once, at the given rate', () => {
    const result = preparePosting(
      [
        line({
          accountId: EXPENSE.id,
          debit: '100.00',
          transactionCurrency: 'EUR',
          exchangeRate: '1.1',
        }),
        line({ accountId: CASH.id, credit: '110.00' }),
      ],
      context(),
    );
    expect(result.lines[0]?.baseDebit).toBe(D('110', MONEY_SCALE).toFixed(MONEY_SCALE));
    expect(result.totalBaseDebit).toBe(result.totalBaseCredit);
  });

  it('requires a rate for a foreign line', () => {
    expect(() =>
      preparePosting(
        [line({ accountId: EXPENSE.id, debit: '100.00', transactionCurrency: 'EUR' })],
        context(),
      ),
    ).toThrow(/needs an exchange rate/);
  });

  it('refuses an amount with more precision than the currency has minor units', () => {
    // JPY has none. 100.50 JPY is not a rounding question, it is a wrong number.
    expect(() =>
      preparePosting(
        [
          line({
            accountId: EXPENSE.id,
            debit: '100.50',
            transactionCurrency: 'JPY',
            exchangeRate: '1',
          }),
        ],
        context(),
      ),
    ).toThrow(/more precision than JPY's 0 minor units/);
  });

  it('absorbs a sub-minor-unit residual into the rounding account', () => {
    // 33.33 EUR at 1.115 = 37.163... -> 37.16, three times = 111.48; the credit is
    // 111.49. One cent, attributable to three converted lines.
    const result = preparePosting(
      [
        ...([1, 2, 3] as const).map(() =>
          line({
            accountId: EXPENSE.id,
            debit: '33.33',
            transactionCurrency: 'EUR',
            exchangeRate: '1.115',
          }),
        ),
        line({ accountId: CASH.id, credit: '111.49' }),
      ],
      context(),
    );
    expect(result.totalBaseDebit).toBe(result.totalBaseCredit);
    const adjustment = result.lines.find((l) => l.isRoundingAdjustment);
    expect(adjustment).toBeDefined();
    expect(adjustment?.accountId).toBe(ROUNDING.id);
  });

  it('refuses a residual larger than the converted lines can explain', () => {
    expect(() =>
      preparePosting(
        [
          line({
            accountId: EXPENSE.id,
            debit: '100.00',
            transactionCurrency: 'EUR',
            exchangeRate: '1.1',
          }),
          line({ accountId: CASH.id, credit: '105.00' }),
        ],
        context(),
      ),
    ).toThrow(/exceeds the .* attributable to rounding/);
  });

  it('refuses to adjust when the policy configures no rounding account', () => {
    expect(() =>
      preparePosting(
        [
          line({
            accountId: EXPENSE.id,
            debit: '33.33',
            transactionCurrency: 'EUR',
            exchangeRate: '1.115',
          }),
          line({ accountId: CASH.id, credit: '37.17' }),
        ],
        context({ roundingAccountId: null }),
      ),
    ).toThrow(/needs a rounding account/);
  });
});

describe('reverseLines', () => {
  it('inverts every side and changes nothing else', () => {
    const original = preparePosting(
      [
        line({
          accountId: EXPENSE.id,
          debit: '100.00',
          transactionCurrency: 'EUR',
          exchangeRate: '1.1',
        }),
        line({ accountId: CASH.id, credit: '110.00' }),
      ],
      context(),
    );
    const reversed = reverseLines(original.lines);

    for (const [i, r] of reversed.entries()) {
      const o = original.lines[i]!;
      expect(r.baseDebit).toBe(o.baseCredit);
      expect(r.baseCredit).toBe(o.baseDebit);
      // doc 03: a reversal copies, it does not recompute. Re-deriving the base
      // amount from today's rate would produce a reversal that does not cancel.
      expect(r.exchangeRate).toBe(o.exchangeRate);
      expect(r.accountId).toBe(o.accountId);
    }
  });

  it('produces a net effect of exactly zero when applied to the original', () => {
    const original = preparePosting(
      [
        line({ accountId: EXPENSE.id, debit: '12.34' }),
        line({ accountId: AR.id, credit: '12.34' }),
      ],
      context(),
    );
    const both = [...original.lines, ...reverseLines(original.lines)];
    const net = both.reduce(
      (acc, l) => acc.add(D(l.baseDebit, MONEY_SCALE)).sub(D(l.baseCredit, MONEY_SCALE)),
      D('0', MONEY_SCALE),
    );
    expect(net.isZero()).toBe(true);
    for (const accountId of new Set(both.map((l) => l.accountId))) {
      const perAccount = both
        .filter((l) => l.accountId === accountId)
        .reduce(
          (acc, l) => acc.add(D(l.baseDebit, MONEY_SCALE)).sub(D(l.baseCredit, MONEY_SCALE)),
          D('0', MONEY_SCALE),
        );
      expect(perAccount.isZero()).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Gate C: "Property tests cannot create an unbalanced POSTED journal."
// ---------------------------------------------------------------------------

/** Deterministic PRNG — a failing case must be reproducible from the seed alone. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe('property: preparePosting either balances exactly or throws', () => {
  const CURRENCY_CODES = ['USD', 'EUR', 'JPY', 'KWD'] as const;

  it('holds across 20,000 generated journals', () => {
    let balanced = 0;
    let rejected = 0;
    let adjusted = 0;

    for (let seed = 1; seed <= 20_000; seed++) {
      const next = rng(seed);
      const currency = CURRENCY_CODES[Math.floor(next() * CURRENCY_CODES.length)] as string;
      const minorUnit = CURRENCIES.get(currency)!.minorUnit;
      const lineCount = 1 + Math.floor(next() * 6);
      const rate = currency === 'USD' ? null : (0.5 + next() * 3).toFixed(6);

      // Debits and credits that balance in TRANSACTION currency. Whether they
      // still balance in base after conversion is the interesting part, and is
      // exactly what the rounding boundary decides.
      const amounts: string[] = [];
      let total = 0n;
      for (let i = 0; i < lineCount; i++) {
        const units = BigInt(Math.floor(next() * 1_000_000));
        total += units;
        amounts.push(D(units.toString(), 0).rescale(0).toString());
      }
      const scaled = (units: string) =>
        D(units, 0)
          .div(D(10 ** minorUnit, 0), minorUnit, 'DOWN')
          .toString();

      const debits: DraftLineInput[] = amounts.map((a) =>
        line({
          accountId: EXPENSE.id,
          debit: scaled(a),
          transactionCurrency: currency,
          ...(rate ? { exchangeRate: rate } : {}),
        }),
      );
      const credit = line({
        accountId: CASH.id,
        credit: scaled(total.toString()),
        transactionCurrency: currency,
        ...(rate ? { exchangeRate: rate } : {}),
      });

      let result;
      try {
        result = preparePosting([...debits, credit], context());
      } catch (e) {
        // The only permitted rejections: an all-zero journal, or a residual the
        // converted lines cannot account for.
        expect(AppError.isAppError(e)).toBe(true);
        expect((e as AppError).code).toBe('UNBALANCED_JOURNAL');
        rejected++;
        continue;
      }

      // The property itself. Not "close enough" — exactly equal, as strings.
      expect(result.totalBaseDebit).toBe(result.totalBaseCredit);
      if (result.roundingAdjustment !== null) adjusted++;
      balanced++;
    }

    // If the generator stopped producing interesting cases, the property would
    // still pass while proving nothing. These assert it kept exercising all three.
    expect(balanced).toBeGreaterThan(15_000);
    expect(adjusted).toBeGreaterThan(100);
    expect(rejected).toBeLessThan(1_000);
  });
});

describe('signedBalance', () => {
  it('does not swap columns when a debit-normal account is in credit', () => {
    // Values stay at the storage scale of numeric(24,8) all the way to the wire;
    // the presentation layer formats by minor_unit and never re-rounds (ADR-0006).
    expect(D(signedBalance('10', '30', 'DEBIT')).toString()).toBe('-20.00000000');
    expect(D(signedBalance('10', '30', 'CREDIT')).toString()).toBe('20.00000000');
  });
});

describe('accountingEquation', () => {
  it('balances when current-year earnings are left in place', () => {
    const equation = accountingEquation([
      { accountType: 'ASSET', debit: '1000', credit: '0' },
      { accountType: 'LIABILITY', debit: '0', credit: '400' },
      { accountType: 'EQUITY', debit: '0', credit: '500' },
      { accountType: 'REVENUE', debit: '0', credit: '300' },
      { accountType: 'EXPENSE', debit: '200', credit: '0' },
    ]);
    expect(equation.balances).toBe(true);
    expect(D(equation.currentYearEarnings).equals(D('100'))).toBe(true);
    // The literal reading of the exit criterion — Assets = Liabilities + Equity —
    // would be 1000 = 900 and would fail on a perfectly correct mid-year cutover.
    expect(D(equation.assets).equals(D(equation.liabilities).add(D(equation.equity)))).toBe(false);
  });

  it('reports the difference when a trial balance does not balance', () => {
    const equation = accountingEquation([
      { accountType: 'ASSET', debit: '1000', credit: '0' },
      { accountType: 'LIABILITY', debit: '0', credit: '400' },
    ]);
    expect(equation.balances).toBe(false);
    expect(D(equation.difference).equals(D('600'))).toBe(true);
  });
});
