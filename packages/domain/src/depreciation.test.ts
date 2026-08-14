import { describe, it, expect } from 'vitest';
import { D, type Decimal } from './decimal';
import { accountingDate } from './dates';
import { AppError } from './errors';
import {
  buildSchedule,
  disposalResult,
  type DepreciationScheduleInput,
  type DepreciationScheduleLine,
} from './depreciation';

const d = accountingDate;

const base: DepreciationScheduleInput = {
  method: 'STRAIGHT_LINE',
  proration: 'MONTHLY',
  costBasis: D('12000.00'),
  residualValue: D('0'),
  usefulLifeMonths: 36,
  inServiceDate: d('2027-01-01'),
  minorUnit: 2,
};

const total = (lines: readonly DepreciationScheduleLine[]): Decimal =>
  lines.reduce((sum, line) => sum.add(line.amount), D('0'));

describe('buildSchedule — straight line', () => {
  it('absorbs the rounding residue in the final period so the schedule sums exactly', () => {
    // 12,000.00 / 36 is 333.333... -> 333.33, and 36 × 333.33 = 11,999.88 —
    // 0.12 short. If no period absorbs that, accumulated depreciation never
    // equals cost and the asset-to-GL reconciliation fails at the end of every
    // asset's life. The final period takes 333.45.
    const lines = buildSchedule(base);
    expect(lines).toHaveLength(36);
    expect(lines[0]?.amount.toString()).toBe('333.33000000');
    expect(lines[34]?.amount.toString()).toBe('333.33000000');
    expect(lines[35]?.amount.toString()).toBe('333.45000000');
    expect(total(lines).toString()).toBe('12000.00000000');
    expect(lines[35]?.closingCarryingAmount.toString()).toBe('0.00000000');
  });

  it('depreciates cost − residual, never cost, and ends on the residual exactly', () => {
    const lines = buildSchedule({ ...base, residualValue: D('1200.00') });
    // 10,800 / 36 divides evenly, so every period is 300 and nothing needs absorbing.
    expect(lines.every((l) => l.amount.toString() === '300.00000000')).toBe(true);
    expect(total(lines).toString()).toBe('10800.00000000');
    expect(lines[35]?.closingCarryingAmount.toString()).toBe('1200.00000000');
  });

  it('sums exactly for awkward bases that do not divide evenly', () => {
    const lines = buildSchedule({
      ...base,
      costBasis: D('10000.01'),
      residualValue: D('123.45'),
      usefulLifeMonths: 7,
    });
    expect(total(lines).toString()).toBe('9876.56000000');
    expect(lines.every((l) => l.amount.isPositive())).toBe(true);
  });

  it('ends early rather than overshoot when rounding up exhausts a tiny base', () => {
    // 1.00 over 36 months rounds each period UP to 0.03, which is 1.08 over the
    // life — more than the asset cost. The cap stops the schedule in month 34
    // with the sum still exact; the alternative is a negative final period.
    const lines = buildSchedule({ ...base, costBasis: D('1.00') });
    expect(lines.length).toBe(34);
    expect(lines[33]?.amount.toString()).toBe('0.01000000');
    expect(lines.every((l) => l.amount.isPositive())).toBe(true);
    expect(total(lines).toString()).toBe('1.00000000');
  });

  it('rounds at the currency minor unit, not at a hardcoded 2', () => {
    // A zero-decimal currency (JPY-style): 100,000 / 7 -> 14,286 a month, and
    // the final period absorbs the 2-unit overshoot by charging 14,284.
    const lines = buildSchedule({
      ...base,
      costBasis: D('100000'),
      usefulLifeMonths: 7,
      minorUnit: 0,
    });
    expect(lines[0]?.amount.toString()).toBe('14286.00000000');
    expect(lines[6]?.amount.toString()).toBe('14284.00000000');
    expect(total(lines).toString()).toBe('100000.00000000');
  });

  it('returns an empty schedule when cost is entirely residual', () => {
    expect(buildSchedule({ ...base, residualValue: D('12000.00') })).toEqual([]);
  });
});

describe('buildSchedule — proration conventions', () => {
  const midMonth = { ...base, inServiceDate: d('2027-03-15') };

  it('MONTHLY starts a mid-month asset in the following month', () => {
    // Whole months only: March 15 was not a whole March in service, so the
    // first charged period is April and the life still runs 36 periods.
    const lines = buildSchedule(midMonth);
    expect(lines).toHaveLength(36);
    expect(lines[0]?.period).toBe('2027-04-01');
    expect(lines[0]?.amount.toString()).toBe('333.33000000');
    expect(lines[35]?.period).toBe('2030-03-01');
  });

  it('FULL_MONTH charges the in-service month in full however late service began', () => {
    const lines = buildSchedule({ ...midMonth, proration: 'FULL_MONTH' });
    expect(lines).toHaveLength(36);
    expect(lines[0]?.period).toBe('2027-03-01');
    expect(lines[0]?.amount.toString()).toBe('333.33000000');
    expect(lines[35]?.period).toBe('2030-02-01');
  });

  it('HALF_MONTH takes half a charge first, and the other half a month past the life', () => {
    const lines = buildSchedule({ ...midMonth, proration: 'HALF_MONTH' });
    // 36 months of charge spread over 37 calendar months.
    expect(lines).toHaveLength(37);
    expect(lines[0]?.period).toBe('2027-03-01');
    expect(lines[0]?.amount.toString()).toBe('166.67000000');
    expect(lines[1]?.amount.toString()).toBe('333.33000000');
    // Final half-month also absorbs the residue: 12,000 − 166.67 − 35 × 333.33.
    expect(lines[36]?.period).toBe('2030-03-01');
    expect(lines[36]?.amount.toString()).toBe('166.78000000');
    expect(total(lines).toString()).toBe('12000.00000000');
  });

  it('EXACT_DAYS prorates over the life in real days, not twelfths of a year', () => {
    // In service 2027-03-15, 36-month life: 17 of March's days, and the life is
    // 1096 days because 2028 is a leap year. 12,000 × 17/1096 = 186.13 — not
    // 12,000/36 × 17/31 = 182.80, and not a flat 333.33.
    const lines = buildSchedule({ ...midMonth, proration: 'EXACT_DAYS' });
    expect(lines).toHaveLength(37);
    expect(lines[0]?.period).toBe('2027-03-01');
    expect(lines[0]?.amount.toString()).toBe('186.13000000');
    // Full months earn their real day counts: April's 30 vs May's 31.
    expect(lines[1]?.amount.toString()).toBe('328.47000000');
    expect(lines[2]?.amount.toString()).toBe('339.42000000');
    // Leap February 2028 (29 days) earns more than February 2029 (28) — the
    // difference is only visible if the denominator really is 1096 days.
    expect(lines[11]?.period).toBe('2028-02-01');
    expect(lines[11]?.amount.toString()).toBe('317.52000000');
    expect(lines[23]?.period).toBe('2029-02-01');
    expect(lines[23]?.amount.toString()).toBe('306.57000000');
    // The 14-day tail period still lands the total exactly.
    expect(lines[36]?.period).toBe('2030-03-01');
    expect(total(lines).toString()).toBe('12000.00000000');
    expect(lines[36]?.closingCarryingAmount.toString()).toBe('0.00000000');
  });

  it('NONE accepts a month-start date and yields plain whole months', () => {
    const lines = buildSchedule({
      ...base,
      proration: 'NONE',
      inServiceDate: d('2027-04-01'),
      usefulLifeMonths: 12,
    });
    expect(lines).toHaveLength(12);
    expect(lines[0]?.period).toBe('2027-04-01');
    expect(lines[0]?.amount.toString()).toBe('1000.00000000');
  });

  it('NONE refuses a mid-month start instead of inventing a convention', () => {
    expect(() => buildSchedule({ ...midMonth, proration: 'NONE' })).toThrow(
      /PRORATION_NONE_MIDPERIOD/,
    );
  });
});

describe('buildSchedule — declining balance', () => {
  const declining: DepreciationScheduleInput = {
    ...base,
    method: 'DECLINING_BALANCE',
    costBasis: D('10000.00'),
    usefulLifeMonths: 24,
    decliningBalanceRate: D('0.24'), // 2% a month of the opening carrying amount
  };

  it('charges the rate against the opening carrying amount each period', () => {
    const lines = buildSchedule(declining);
    expect(lines[0]?.amount.toString()).toBe('200.00000000');
    expect(lines[1]?.amount.toString()).toBe('196.00000000');
    expect(lines[2]?.amount.toString()).toBe('192.08000000');
  });

  it('absorbs the geometric tail in the final period so life-end still reconciles', () => {
    // 2% a month for 24 months leaves ~61.6% of cost on the books; a schedule
    // that just stopped would fail the life-end reconciliation exactly the way
    // an unabsorbed rounding residue does, only ~6,000 times larger.
    const lines = buildSchedule(declining);
    expect(lines).toHaveLength(24);
    expect(total(lines).toString()).toBe('10000.00000000');
    expect(lines[23]?.closingCarryingAmount.toString()).toBe('0.00000000');
  });

  it('stops at the residual, not at the month count', () => {
    // 5% a month against a 10,000 asset reaches the 8,000 residual in five
    // periods of a 36-month life: 500.00, 475.00, 451.25, 428.69, then a capped
    // 145.06 instead of the raw 407.25 the rate asks for.
    const lines = buildSchedule({
      ...declining,
      usefulLifeMonths: 36,
      residualValue: D('8000.00'),
      decliningBalanceRate: D('0.60'),
    });
    expect(lines).toHaveLength(5);
    expect(lines.map((l) => l.amount.toString())).toEqual([
      '500.00000000',
      '475.00000000',
      '451.25000000',
      '428.69000000',
      '145.06000000',
    ]);
    expect(lines[4]?.closingCarryingAmount.toString()).toBe('8000.00000000');
    // Landing exactly on residual, never below it.
    expect(lines.every((l) => l.closingCarryingAmount.gte(D('8000.00')))).toBe(true);
    expect(total(lines).toString()).toBe('2000.00000000');
  });

  it('prorates a stub first period by its month fraction', () => {
    // HALF_MONTH: half of one month's 1% charge on a 12,000 opening balance.
    const lines = buildSchedule({
      ...declining,
      proration: 'HALF_MONTH',
      costBasis: D('12000.00'),
      inServiceDate: d('2027-03-15'),
      decliningBalanceRate: D('0.12'),
    });
    expect(lines[0]?.period).toBe('2027-03-01');
    expect(lines[0]?.amount.toString()).toBe('60.00000000');
  });

  it('refuses to run without a positive rate', () => {
    expect(() => buildSchedule({ ...declining, decliningBalanceRate: undefined })).toThrow(
      /DECLINING_BALANCE_RATE_REQUIRED/,
    );
    expect(() => buildSchedule({ ...declining, decliningBalanceRate: D('0') })).toThrow(
      /DECLINING_BALANCE_RATE_REQUIRED/,
    );
  });
});

describe('buildSchedule — refusals', () => {
  it('refuses a residual above cost', () => {
    expect(() => buildSchedule({ ...base, residualValue: D('12000.01') })).toThrow(
      /RESIDUAL_EXCEEDS_COST/,
    );
  });

  it('refuses a non-positive or fractional useful life', () => {
    expect(() => buildSchedule({ ...base, usefulLifeMonths: 0 })).toThrow(
      /USEFUL_LIFE_NOT_POSITIVE/,
    );
    expect(() => buildSchedule({ ...base, usefulLifeMonths: 12.5 })).toThrow(
      /USEFUL_LIFE_NOT_POSITIVE/,
    );
  });

  it('names deferred methods NOT_IMPLEMENTED rather than guessing a schedule', () => {
    try {
      buildSchedule({ ...base, method: 'UNITS_OF_PRODUCTION' });
      expect.unreachable('UNITS_OF_PRODUCTION must not produce a schedule');
    } catch (e) {
      expect(AppError.isAppError(e)).toBe(true);
      expect((e as AppError).code).toBe('NOT_IMPLEMENTED');
    }
    expect(() => buildSchedule({ ...base, method: 'CUSTOM' })).toThrow(
      /DEPRECIATION_METHOD_NOT_IMPLEMENTED/,
    );
  });
});

describe('disposalResult', () => {
  it('computes a gain as proceeds − carrying, the expression dr_gain_loss_derived checks', () => {
    const r = disposalResult({
      costBasis: D('10000.00'),
      accumulatedDepreciation: D('6000.00'),
      proceeds: D('5000.00'),
    });
    expect(r.carryingAmount.toString()).toBe('4000.00000000');
    expect(r.gainLoss.toString()).toBe('1000.00000000');
    // Verbatim agreement with the database CHECK; disagree and every disposal
    // is rejected at COMMIT.
    expect(r.gainLoss.equals(r.proceeds.sub(r.carryingAmount))).toBe(true);
  });

  it('computes a loss with the same expression, sign carrying the meaning', () => {
    const r = disposalResult({
      costBasis: D('10000.00'),
      accumulatedDepreciation: D('6000.00'),
      proceeds: D('3000.00'),
    });
    expect(r.gainLoss.toString()).toBe('-1000.00000000');
  });

  it('treats a scrap (zero proceeds) as a loss of the whole carrying amount', () => {
    const r = disposalResult({
      costBasis: D('10000.00'),
      accumulatedDepreciation: D('6000.00'),
      proceeds: D('0'),
    });
    expect(r.gainLoss.toString()).toBe('-4000.00000000');
  });

  it('turns any proceeds on a fully depreciated asset into pure gain', () => {
    const r = disposalResult({
      costBasis: D('10000.00'),
      accumulatedDepreciation: D('10000.00'),
      proceeds: D('250.00'),
    });
    expect(r.carryingAmount.toString()).toBe('0.00000000');
    expect(r.gainLoss.toString()).toBe('250.00000000');
  });

  it('produces pieces that balance as the doc 09 disposal journal', () => {
    // Dr proceeds + Dr accumulated (+ Dr loss) = Cr cost (+ Cr gain), i.e.
    // proceeds + accumulated removed = cost removed + gain/loss. A result that
    // fails this cannot post through DocumentPostingService as a balanced entry.
    const r = disposalResult({
      costBasis: D('9876.54'),
      accumulatedDepreciation: D('4321.09'),
      proceeds: D('5000.00'),
    });
    expect(
      r.proceeds.add(r.accumulatedDepreciationRemoved).equals(r.costRemoved.add(r.gainLoss)),
    ).toBe(true);
  });

  it('refuses accumulated depreciation outside [0, cost]', () => {
    expect(() =>
      disposalResult({
        costBasis: D('10000.00'),
        accumulatedDepreciation: D('10000.01'),
        proceeds: D('0'),
      }),
    ).toThrow(/ACCUMULATED_OUTSIDE_COST/);
    expect(() =>
      disposalResult({
        costBasis: D('10000.00'),
        accumulatedDepreciation: D('-1.00'),
        proceeds: D('0'),
      }),
    ).toThrow(/ACCUMULATED_OUTSIDE_COST/);
  });

  it('lands a full-life schedule on a residual-value carrying amount at disposal', () => {
    // The end-to-end shape of exit criterion 4: depreciate to the end of life,
    // dispose, and the carrying amount is exactly the residual — no residue.
    const lines = buildSchedule({ ...base, residualValue: D('1200.00') });
    const r = disposalResult({
      costBasis: D('12000.00'),
      accumulatedDepreciation: total(lines),
      proceeds: D('900.00'),
    });
    expect(r.carryingAmount.toString()).toBe('1200.00000000');
    expect(r.gainLoss.toString()).toBe('-300.00000000');
  });
});
