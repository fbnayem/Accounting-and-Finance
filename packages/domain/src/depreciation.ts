/**
 * Depreciation — schedule generation and disposal arithmetic.
 *
 * Pure, like everything else here: no database, no clock beyond the dates passed
 * in. doc 09 specifies the proration conventions and the residual rule as
 * *rules*, and the places a depreciation rule goes wrong — leap years, rounding
 * residue, the final-period cap — are exactly the places a rule that can only be
 * exercised through a depreciation run against a database never gets tested.
 */

import { D, type Decimal, MONEY_SCALE } from './decimal';
import { AppError } from './errors';
import { type AccountingDate, addMonths, compareDates, daysBetween, startOfMonth } from './dates';

// ---------------------------------------------------------------------------
// Vocabulary (contracts/schema/0000_extensions_and_types.sql)
// ---------------------------------------------------------------------------

/**
 * Mirrors the `depreciation_method` enum exactly. doc 09 calls the second method
 * "reducing/declining balance"; the schema spells it DECLINING_BALANCE and this
 * union follows the schema, because a value that drifts from the enum fails at
 * the first INSERT rather than at review time.
 */
export type DepreciationMethod =
  'STRAIGHT_LINE' | 'DECLINING_BALANCE' | 'UNITS_OF_PRODUCTION' | 'CUSTOM';

/** Mirrors the `proration_convention` enum exactly. */
export type ProrationConvention = 'EXACT_DAYS' | 'FULL_MONTH' | 'HALF_MONTH' | 'MONTHLY' | 'NONE';

export interface DepreciationScheduleInput {
  readonly method: DepreciationMethod;
  readonly proration: ProrationConvention;
  /** `asset_books.cost_basis` — cost after capitalizations, in the book currency. */
  readonly costBasis: Decimal;
  readonly residualValue: Decimal;
  readonly usefulLifeMonths: number;
  /** `asset_books.depreciation_start_date` — doc 09's in-service date for the book. */
  readonly inServiceDate: AccountingDate;
  /**
   * Annual reducing-balance rate as a fraction (`D('0.40')` is 40% a year).
   * Required for DECLINING_BALANCE, ignored by every other method.
   */
  readonly decliningBalanceRate?: Decimal;
  /**
   * Minor unit of the book currency. Every period charge becomes a journal line
   * (Dr Depreciation Expense / Cr Accumulated Depreciation), and ADR-0006 step 6
   * asserts journal lines arrive already rounded — so rounding happens here, per
   * period, not somewhere downstream.
   */
  readonly minorUnit: number;
}

export interface DepreciationScheduleLine {
  /** First day of the calendar month the charge belongs to — the accounting-period key. */
  readonly period: AccountingDate;
  readonly amount: Decimal;
  /** Cost basis less accumulated depreciation once this line has posted. */
  readonly closingCarryingAmount: Decimal;
}

// ---------------------------------------------------------------------------
// Period slicing (doc 09 "Proration options")
// ---------------------------------------------------------------------------

interface Slice {
  readonly period: AccountingDate;
  /** Fraction of one month's charge this slice carries, as an exact rational. */
  readonly num: number;
  readonly den: number;
}

const isMonthStart = (d: AccountingDate): boolean => d === startOfMonth(d);

function buildSlices(
  proration: ProrationConvention,
  inService: AccountingDate,
  months: number,
): { slices: Slice[]; totalDays: number } {
  const slices: Slice[] = [];

  if (proration === 'EXACT_DAYS') {
    // The life is the half-open day range [inService, inService + months).
    // Counting real days is the whole convention: from 2027-03-15 a 36-month
    // life is 1096 days because 2028 is a leap year, not 3 × 365.
    const end = addMonths(inService, months);
    const totalDays = daysBetween(inService, end);
    let cursor = inService;
    while (compareDates(cursor, end) < 0) {
      const monthStart = startOfMonth(cursor);
      const nextMonth = addMonths(monthStart, 1);
      const sliceEnd = compareDates(nextMonth, end) < 0 ? nextMonth : end;
      slices.push({
        period: monthStart,
        num: daysBetween(cursor, sliceEnd),
        den: daysBetween(monthStart, nextMonth),
      });
      cursor = sliceEnd;
    }
    return { slices, totalDays };
  }

  if (proration === 'HALF_MONTH') {
    // Half a month's charge in the in-service month whatever the day, so the
    // other half falls due one month after the life would otherwise end: a
    // 36-month life touches 37 calendar months.
    const first = startOfMonth(inService);
    slices.push({ period: first, num: 1, den: 2 });
    for (let i = 1; i < months; i++) slices.push({ period: addMonths(first, i), num: 1, den: 1 });
    slices.push({ period: addMonths(first, months), num: 1, den: 2 });
    return { slices, totalDays: 0 };
  }

  if (proration === 'NONE' && !isMonthStart(inService)) {
    // NONE names no rule for a partial period. Inventing one on the spot would
    // silently turn NONE into whichever convention the implementer preferred.
    throw new AppError(
      'VALIDATION_FAILED',
      `PRORATION_NONE_MIDPERIOD: in-service date ${inService} is not the first of a month, and ` +
        `the NONE convention has no rule for a partial period. Configure a proration convention ` +
        `or start the book on a month boundary.`,
      { details: { in_service_date: inService } },
    );
  }

  // MONTHLY counts whole months only, so a mid-month start begins the following
  // month. FULL_MONTH charges the in-service month in full however late in it
  // service began. NONE reaches here only with a date the question cannot arise on.
  const first =
    proration === 'MONTHLY' && !isMonthStart(inService)
      ? startOfMonth(addMonths(inService, 1))
      : startOfMonth(inService);
  for (let i = 0; i < months; i++) slices.push({ period: addMonths(first, i), num: 1, den: 1 });
  return { slices, totalDays: 0 };
}

// ---------------------------------------------------------------------------
// Schedule generation (doc 09 "Depreciation schedule")
// ---------------------------------------------------------------------------

function validate(input: DepreciationScheduleInput): {
  cost: Decimal;
  residual: Decimal;
  base: Decimal;
} {
  if (!Number.isInteger(input.usefulLifeMonths) || input.usefulLifeMonths <= 0) {
    // The asset_books CHECK (useful_life_months > 0) refuses this at INSERT;
    // refusing here names the field instead of surfacing a constraint violation.
    throw new AppError(
      'VALIDATION_FAILED',
      `USEFUL_LIFE_NOT_POSITIVE: a useful life of ${input.usefulLifeMonths} months has no schedule.`,
      { details: { useful_life_months: input.usefulLifeMonths } },
    );
  }
  if (!Number.isInteger(input.minorUnit) || input.minorUnit < 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      `MINOR_UNIT_INVALID: ${input.minorUnit} is not a currency minor unit.`,
      { details: { minor_unit: input.minorUnit } },
    );
  }
  const cost = input.costBasis.rescale(MONEY_SCALE);
  const residual = input.residualValue.rescale(MONEY_SCALE);
  if (cost.isNegative() || residual.isNegative()) {
    throw new AppError(
      'VALIDATION_FAILED',
      `NEGATIVE_ASSET_VALUE: cost ${cost.toString()} and residual ${residual.toString()} must both be >= 0.`,
      { details: { cost_basis: cost.toString(), residual_value: residual.toString() } },
    );
  }
  if (residual.gt(cost)) {
    throw new AppError(
      'VALIDATION_FAILED',
      `RESIDUAL_EXCEEDS_COST: residual ${residual.toString()} exceeds cost ${cost.toString()}; ` +
        `depreciation cannot raise a carrying amount.`,
      { details: { cost_basis: cost.toString(), residual_value: residual.toString() } },
    );
  }
  return { cost, residual, base: cost.sub(residual) };
}

function straightLineSchedule(
  input: DepreciationScheduleInput,
  base: Decimal,
  residual: Decimal,
): DepreciationScheduleLine[] {
  const { slices, totalDays } = buildSlices(
    input.proration,
    input.inServiceDate,
    input.usefulLifeMonths,
  );
  const lines: DepreciationScheduleLine[] = [];
  let remaining = base;
  for (const [i, slice] of slices.entries()) {
    let charge: Decimal;
    if (i === slices.length - 1) {
      // The residue rule. 12,000.00 over 36 months is 333.33 a month rounded,
      // and 36 × 333.33 is 11,999.88 — 0.12 short. The final period takes
      // whatever remains (333.45 here) so the schedule sums to cost − residual
      // *exactly*. Without this, accumulated depreciation never equals cost at
      // end of life and the asset-to-GL reconciliation in doc 09's acceptance
      // fails for every asset that finishes depreciating.
      charge = remaining;
    } else {
      // EXACT_DAYS apportions over the life measured in real days, NOT twelfths
      // of a year: March's 17 in-service days out of a 1096-day life earn
      // 12,000 × 17/1096 = 186.13, not 12,000/36 × 17/31. The other conventions
      // charge `num/den` of the equal monthly amount.
      const raw =
        input.proration === 'EXACT_DAYS'
          ? base.mul(D(slice.num)).div(D(totalDays), input.minorUnit)
          : base.mul(D(slice.num)).div(D(slice.den * input.usefulLifeMonths), input.minorUnit);
      const rounded = raw.rescale(MONEY_SCALE);
      // HALF_UP drifts upward as easily as down, so the cap keeps accumulated
      // depreciation from overshooting: a 1.00 asset over 36 months at 0.03 a
      // month is exhausted in month 34, and the schedule simply ends there.
      charge = rounded.lt(remaining) ? rounded : remaining;
    }
    if (charge.isZero()) {
      if (remaining.isZero()) break;
      continue; // a stub too small to round to a minor unit; later periods still charge
    }
    remaining = remaining.sub(charge);
    lines.push({
      period: slice.period,
      amount: charge,
      closingCarryingAmount: residual.add(remaining),
    });
  }
  return lines;
}

function decliningBalanceSchedule(
  input: DepreciationScheduleInput,
  cost: Decimal,
  residual: Decimal,
): DepreciationScheduleLine[] {
  const rate = input.decliningBalanceRate;
  if (rate === undefined || !rate.isPositive()) {
    throw new AppError(
      'VALIDATION_FAILED',
      'DECLINING_BALANCE_RATE_REQUIRED: DECLINING_BALANCE charges a fraction of the opening ' +
        'carrying amount each period; without a positive annual rate there is no fraction.',
      { details: { declining_balance_rate: rate?.toString() ?? null } },
    );
  }
  const { slices } = buildSlices(input.proration, input.inServiceDate, input.usefulLifeMonths);
  const lines: DepreciationScheduleLine[] = [];
  let carrying = cost;
  for (const [i, slice] of slices.entries()) {
    const room = carrying.sub(residual);
    // The schedule stops at residual, not at the month count: once the carrying
    // amount lands on residual there is nothing left to depreciate, however many
    // periods of useful life remain on paper.
    if (!room.isPositive()) break;
    let charge: Decimal;
    if (i === slices.length - 1) {
      // Reducing balance decays geometrically: with a positive residual the raw
      // charge overshoots it (the cap below catches that); with residual zero it
      // never arrives at all. If the life ends first, the final period absorbs
      // the tail so accumulated depreciation still equals cost − residual at end
      // of life. A declining-balance-to-straight-line crossover that smooths
      // this tail is one of the method variations doc 09 defers.
      charge = room;
    } else {
      // The annual rate applied monthly, at rate/12 of the *opening* carrying
      // amount. A stub period charges its fraction of that month — for a charge
      // driven by the balance at the period's start, a whole-life day
      // denominator has no meaning, so EXACT_DAYS here means days/days-in-month.
      const raw = carrying
        .mul(rate)
        .mul(D(slice.num))
        .div(D(12 * slice.den), input.minorUnit)
        .rescale(MONEY_SCALE);
      // The cap: the carrying amount lands exactly on residual and never below it.
      charge = raw.lt(room) ? raw : room;
      if (charge.isZero()) continue; // a stub too small to round to a minor unit
    }
    carrying = carrying.sub(charge);
    lines.push({ period: slice.period, amount: charge, closingCarryingAmount: carrying });
  }
  return lines;
}

/**
 * doc 09: "Generate schedule from in-service date through useful life,
 * respecting residual value." Returns the full period-by-period schedule; the
 * depreciation run service persists these as `depreciation_schedule_lines` and
 * posts them period by period.
 *
 * Invariants the tests hold this to:
 *   - the schedule sums to cost − residual exactly (the final period absorbs
 *     rounding residue);
 *   - no line drives the carrying amount below the residual value;
 *   - every line is rounded to the currency minor unit, ready to be a journal line.
 */
export function buildSchedule(
  input: DepreciationScheduleInput,
): readonly DepreciationScheduleLine[] {
  const { cost, residual, base } = validate(input);
  // Cost entirely residual is a valid configuration, not an error: there is
  // simply nothing to depreciate.
  if (base.isZero()) return [];
  switch (input.method) {
    case 'STRAIGHT_LINE':
      return straightLineSchedule(input, base, residual);
    case 'DECLINING_BALANCE':
      return decliningBalanceSchedule(input, cost, residual);
    case 'UNITS_OF_PRODUCTION':
    case 'CUSTOM':
      // doc 09 defers these ("Design method interface for ... units-of-production
      // and custom schedules later"); the enum values exist now so the schema does
      // not have to change when they arrive.
      throw new AppError(
        'NOT_IMPLEMENTED',
        `DEPRECIATION_METHOD_NOT_IMPLEMENTED: ${input.method} is deferred by doc 09.`,
        { details: { method: input.method } },
      );
  }
}

// ---------------------------------------------------------------------------
// Disposal (doc 09 "Disposal")
// ---------------------------------------------------------------------------

export interface DisposalInput {
  readonly costBasis: Decimal;
  /** Accumulated depreciation posted through the disposal date. */
  readonly accumulatedDepreciation: Decimal;
  readonly proceeds: Decimal;
}

export interface DisposalResult {
  /** Cr Asset Cost. */
  readonly costRemoved: Decimal;
  /** Dr Accumulated Depreciation. */
  readonly accumulatedDepreciationRemoved: Decimal;
  readonly carryingAmount: Decimal;
  /** Dr Bank/AR. */
  readonly proceeds: Decimal;
  /** Positive is a gain (Cr Gain), negative a loss (Dr Loss). */
  readonly gainLoss: Decimal;
}

/**
 * doc 09's disposal arithmetic: carrying amount on the disposal date, proceeds,
 * cost removal, accumulated depreciation removal and gain/loss.
 *
 * `gainLoss` is `proceeds − carrying` — the exact expression the database CHECK
 * `dr_gain_loss_derived` re-derives, so a disposal this accepts is one the
 * database accepts at COMMIT. The pieces also balance as a journal:
 * proceeds + accumulated removed = cost removed + gain/loss, which is doc 09's
 * generic disposal entry with the gain/loss leg on whichever side its sign puts it.
 */
export function disposalResult(input: DisposalInput): DisposalResult {
  const cost = input.costBasis.rescale(MONEY_SCALE);
  const accumulated = input.accumulatedDepreciation.rescale(MONEY_SCALE);
  const proceeds = input.proceeds.rescale(MONEY_SCALE);
  if (cost.isNegative() || accumulated.isNegative() || accumulated.gt(cost)) {
    // Accumulated depreciation beyond cost means the schedule that produced it
    // already violated the residual rule; deriving a negative carrying amount
    // from it would launder that defect into a "gain".
    throw new AppError(
      'VALIDATION_FAILED',
      `ACCUMULATED_OUTSIDE_COST: accumulated depreciation ${accumulated.toString()} must lie ` +
        `between zero and cost ${cost.toString()}.`,
      {
        details: {
          cost_basis: cost.toString(),
          accumulated_depreciation: accumulated.toString(),
        },
      },
    );
  }
  const carrying = cost.sub(accumulated);
  return {
    costRemoved: cost,
    accumulatedDepreciationRemoved: accumulated,
    carryingAmount: carrying,
    proceeds,
    gainLoss: proceeds.sub(carrying),
  };
}
