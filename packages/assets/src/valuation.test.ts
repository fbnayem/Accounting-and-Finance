import { describe, it, expect } from 'vitest';
import { AppError, D } from '@acct/domain';
import {
  carryingAmount,
  assertImpairmentAllowed,
  assertImpairmentReversalAllowed,
  revaluationSplit,
  type BookValuation,
} from './valuation.service';

/**
 * IAS 36's reversal cap (ADR-0001) and IAS 16's surplus/P&L split, held down
 * as arithmetic. These are the two places doc 09's "controlled transactions"
 * can go quietly wrong: a reversal that overshoots writes an asset UP past its
 * own history, and a split that ignores prior P&L decreases parks income in
 * OCI where the P&L never sees it.
 */

const valuation = (over: Partial<BookValuation> = {}): BookValuation => ({
  costBasis: D('12000.00'),
  revaluationTotal: D('0'),
  accumulatedDepreciation: D('4000.00'),
  accumulatedImpairment: D('0'),
  ...over,
});

describe('carryingAmount', () => {
  it('derives cost + revaluations − accumulated depreciation − accumulated impairment', () => {
    // Derived, never stored — doc 09 forbids overwriting historical
    // cost/accumulated values, so this expression IS the carrying amount
    // everywhere in the package. If a stored copy existed it could disagree.
    const v = valuation({
      revaluationTotal: D('500.00'),
      accumulatedImpairment: D('1500.00'),
    });
    expect(carryingAmount(v).toString()).toBe('7000.00');
  });
});

describe('assertImpairmentAllowed', () => {
  it('refuses an impairment that would drive carrying below zero', () => {
    // IAS 36 writes down to the recoverable amount, which is never negative.
    // Allowing 9000 against a carrying of 8000 would leave a negative asset.
    expect(() => assertImpairmentAllowed(valuation(), D('9000.00'))).toThrowError(AppError);
    expect(() => assertImpairmentAllowed(valuation(), D('8000.00'))).not.toThrow();
  });

  it('refuses a zero or negative impairment', () => {
    expect(() => assertImpairmentAllowed(valuation(), D('0'))).toThrowError(AppError);
    expect(() => assertImpairmentAllowed(valuation(), D('-100.00'))).toThrowError(AppError);
  });
});

describe('assertImpairmentReversalAllowed (IAS 36 cap, ADR-0001)', () => {
  const impaired = valuation({ accumulatedImpairment: D('1500.00') });

  it('permits a reversal up to the accumulated impairment and no further', () => {
    expect(() => assertImpairmentReversalAllowed(impaired, D('1500.00'))).not.toThrow();
    expect(() => assertImpairmentReversalAllowed(impaired, D('1500.01'))).toThrowError(AppError);
  });

  it('names the cap numbers in the refusal', () => {
    // The cap is "the carrying amount that would have applied had the original
    // impairment never happened". The refusal must say what that number IS —
    // 8000.00 here (12000 − 4000) against a current carrying of 6500 — or the
    // caller cannot tell a typo from a rule.
    let thrown: AppError | undefined;
    try {
      assertImpairmentReversalAllowed(impaired, D('2000.00'));
    } catch (error) {
      thrown = error as AppError;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect(thrown!.details).toMatchObject({
      accumulated_impairment: '1500.00',
      carrying_amount: '6500.00',
      carrying_amount_without_impairment: '8000.00',
      amount: '2000.00',
    });
    expect(thrown!.message).toContain('1500.00');
    expect(thrown!.message).toContain('8000.00');
  });

  it('refuses any reversal when nothing was impaired', () => {
    // With no impairment on the book the cap is zero: a "reversal" here would
    // be an upward revaluation wearing the wrong posting rule, bypassing the
    // asset.revalue permission and the surplus split.
    expect(() => assertImpairmentReversalAllowed(valuation(), D('0.01'))).toThrowError(AppError);
  });
});

describe('revaluationSplit (IAS 16, ADR-0001)', () => {
  it('a first increase goes wholly to revaluation surplus', () => {
    const split = revaluationSplit({
      amount: D('1000.00'),
      surplusBalance: D('0'),
      priorRevaluationTotal: D('0'),
    });
    expect(split.surplus.toString()).toBe('1000.00');
    expect(split.profitAndLoss.isZero()).toBe(true);
  });

  it('a first decrease goes wholly to P&L — there is no surplus to consume', () => {
    const split = revaluationSplit({
      amount: D('-800.00'),
      surplusBalance: D('0'),
      priorRevaluationTotal: D('0'),
    });
    expect(split.surplus.isZero()).toBe(true);
    expect(split.profitAndLoss.toString()).toBe('-800.00');
  });

  it('a decrease consumes the existing surplus before touching P&L', () => {
    // Surplus 300 absorbs the first 300 of a 500 decrease; only 200 is a loss.
    // Sending the whole 500 to P&L overstates the loss and strands the surplus.
    const split = revaluationSplit({
      amount: D('-500.00'),
      surplusBalance: D('300.00'),
      priorRevaluationTotal: D('300.00'),
    });
    expect(split.surplus.toString()).toBe('-300.00');
    expect(split.profitAndLoss.toString()).toBe('-200.00');
  });

  it('an increase reverses a prior P&L decrease through P&L before building surplus', () => {
    // History: decrease of 100 hit P&L (no surplus existed). A later increase
    // of 150 returns 100 through P&L and only the excess 50 becomes surplus.
    // Crediting all 150 to OCI is the classic way a recovery never reaches
    // the income statement.
    const split = revaluationSplit({
      amount: D('150.00'),
      surplusBalance: D('0'),
      priorRevaluationTotal: D('-100.00'),
    });
    expect(split.profitAndLoss.toString()).toBe('100.00');
    expect(split.surplus.toString()).toBe('50.00');
  });

  it('the split always sums to the revaluation amount', () => {
    // Whatever the history, surplus + P&L must equal the delta or the journal
    // the split feeds cannot balance against the asset-side leg.
    const cases = [
      { amount: D('150.00'), surplusBalance: D('40.00'), priorRevaluationTotal: D('-60.00') },
      { amount: D('-75.50'), surplusBalance: D('40.00'), priorRevaluationTotal: D('100.00') },
      { amount: D('0.01'), surplusBalance: D('0'), priorRevaluationTotal: D('0') },
    ];
    for (const c of cases) {
      const split = revaluationSplit(c);
      expect(split.surplus.add(split.profitAndLoss).toString()).toBe(c.amount.toString());
    }
  });
});
