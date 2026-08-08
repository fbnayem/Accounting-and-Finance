import { Decimal, D, RoundingMode, DEFAULT_ROUNDING, MONEY_SCALE } from './decimal';
import { CurrencyPrecision, currencyPrecision, CurrencyMismatchError } from './currency';
import { Money, RoundedMoney, brandRounded } from './money';

/**
 * ADR-0006 §3 — the rounding boundary chain, normative.
 *
 *   1. line net           -> round to currency minor_unit
 *   2. line tax           -> round per tax component, then sum the rounded components
 *   3. document tax total -> sum of rounded component amounts        (never re-round)
 *   4. document total     -> sum of rounded line grosses             (never re-round)
 *   5. base conversion    -> round after (transaction amount x rate), per line
 *   6. journal line       -> already rounded at step 1/2/5; no further rounding
 *
 * Doc 01 required "rounding occurs at defined calculation boundaries" and never
 * defined them; F-051 recorded that every golden fixture would otherwise define
 * the behaviour by accident. This module is that definition, in executable form.
 *
 * Steps 3 and 4 are enforced by the type system: `sumRounded` takes `RoundedMoney`
 * and returns `RoundedMoney` without touching the value.
 */

export class RoundingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoundingError';
  }
}

function resolve(currency: string | CurrencyPrecision): CurrencyPrecision {
  return typeof currency === 'string' ? currencyPrecision(currency) : currency;
}

/** The single rounding primitive. Everything below is a named use of it. */
export function roundToMinorUnit(
  value: Money,
  currency?: string | CurrencyPrecision,
  mode: RoundingMode = DEFAULT_ROUNDING,
): RoundedMoney {
  const precision = resolve(currency ?? value.currency);
  if (precision.code !== value.currency) {
    throw new CurrencyMismatchError(value.currency, precision.code);
  }
  const rounded = value.amount.rescale(precision.minorUnit, mode).rescale(MONEY_SCALE);
  return brandRounded(Money.of(rounded, value.currency));
}

/** Step 1 — line net. */
export const roundLineNet = roundToMinorUnit;

/** Step 2a — one tax component. Mode is per component: ADR-0006 §4 allows an override. */
export function roundTaxComponent(
  value: Money,
  currency?: string | CurrencyPrecision,
  mode: RoundingMode = DEFAULT_ROUNDING,
): RoundedMoney {
  return roundToMinorUnit(value, currency, mode);
}

/**
 * Steps 2b, 3 and 4 — sum values that are already rounded, and do not round again.
 *
 * There is deliberately no `mode` parameter. Re-rounding here is the defect the
 * ADR names: it produces a document total that disagrees with its own lines by a
 * minor unit, which is what a customer notices on an invoice.
 */
export function sumRounded(values: readonly RoundedMoney[], currency: string): RoundedMoney {
  if (values.length === 0) return brandRounded(Money.zero(currency));
  const mismatch = values.find((v) => v.currency !== currency);
  if (mismatch) throw new CurrencyMismatchError(currency, mismatch.currency);
  return brandRounded(Money.sum(values, currency));
}

/** Step 5 — base-currency conversion, rounded once, per line. */
export function convertToBase(
  transactionAmount: Money,
  rate: Decimal | string,
  baseCurrency: string | CurrencyPrecision,
  mode: RoundingMode = DEFAULT_ROUNDING,
): RoundedMoney {
  const precision = resolve(baseCurrency);
  const converted = transactionAmount.amount.mul(D(rate));
  const base = Money.of(converted.rescale(MONEY_SCALE, 'DOWN'), precision.code);
  return roundToMinorUnit(base, precision, mode);
}

/**
 * Step 6 — journal line. Asserts rather than rounds: reaching a journal line with
 * an unrounded value means an earlier boundary was skipped, and silently rounding
 * here would hide it.
 */
export function assertJournalLineRounded(
  value: Money,
  currency?: string | CurrencyPrecision,
): RoundedMoney {
  const precision = resolve(currency ?? value.currency);
  const reduced = value.amount.rescale(precision.minorUnit, 'DOWN');
  if (!reduced.rescale(MONEY_SCALE).equals(value.amount)) {
    throw new RoundingError(
      `Journal line amount ${value.toString()} ${value.currency} has more precision than the ` +
        `currency's ${precision.minorUnit} minor units. ADR-0006 step 6 rounds nothing — a value ` +
        `arriving here unrounded means step 1, 2 or 5 was skipped.`,
    );
  }
  return brandRounded(value);
}

/**
 * ADR-0006 §6 — tax-inclusive documents.
 *
 *   net = round(gross / (1 + rate));  tax = gross - net
 *
 * Deriving tax as `gross - net` rather than rounding it independently is what
 * guarantees the components re-sum to the stated gross. Rounding both separately
 * produces documents that are off by a minor unit against the price the customer
 * was quoted.
 */
export function deriveInclusive(
  gross: Money,
  taxRate: Decimal | string,
  currency?: string | CurrencyPrecision,
  mode: RoundingMode = DEFAULT_ROUNDING,
): { net: RoundedMoney; tax: RoundedMoney } {
  const precision = resolve(currency ?? gross.currency);
  const rate = D(taxRate);
  const divisor = D('1').add(rate);
  if (divisor.isZero()) throw new RoundingError('tax rate of -100% has no inclusive decomposition');

  const roundedGross = roundToMinorUnit(gross, precision, mode);
  const netRaw = Money.of(
    roundedGross.amount.div(divisor, MONEY_SCALE, 'DOWN'),
    roundedGross.currency,
  );
  const net = roundToMinorUnit(netRaw, precision, mode);
  const tax = brandRounded(roundedGross.sub(net));
  return { net, tax };
}

/**
 * ADR-0006 §2 — cash rounding. Applies to a physical cash settlement only; the
 * receivable keeps its exact amount and the difference posts as a rounding
 * adjustment (§5).
 */
export function applyCashRounding(
  value: RoundedMoney,
  currency?: string | CurrencyPrecision,
  mode: RoundingMode = DEFAULT_ROUNDING,
): { settled: RoundedMoney; adjustment: RoundedMoney } {
  const precision = resolve(currency ?? value.currency);
  const increment = precision.cashRoundingIncrement;
  if (!increment || increment.isZero()) {
    return { settled: value, adjustment: brandRounded(Money.zero(value.currency)) };
  }
  const steps = value.amount.div(increment, 0, mode);
  const settled = brandRounded(Money.of(steps.mul(increment).rescale(MONEY_SCALE), value.currency));
  return { settled, adjustment: brandRounded(settled.sub(value)) };
}

/**
 * ADR-0006 §5 — the residual after the chain.
 *
 * Returns the delta only when it is attributable to rounding: at most one minor
 * unit per contributing line. Anything larger is a posting failure, and this
 * refuses to launder it — "Rounding is never used to absorb an unexplained
 * imbalance."
 */
export function residualRoundingAdjustment(
  expected: RoundedMoney,
  actual: RoundedMoney,
  contributingLines: number,
  currency?: string | CurrencyPrecision,
): RoundedMoney {
  const precision = resolve(currency ?? expected.currency);
  const delta = expected.sub(actual);
  if (delta.isZero()) return brandRounded(delta);

  const oneMinorUnit = Decimal.fromUnits(1n, precision.minorUnit).rescale(MONEY_SCALE);
  const tolerance = oneMinorUnit.mul(D(Math.max(contributingLines, 1))).rescale(MONEY_SCALE);

  if (delta.abs().amount.gt(tolerance)) {
    throw new RoundingError(
      `Imbalance of ${delta.toString()} ${delta.currency} across ${contributingLines} line(s) ` +
        `exceeds the ${tolerance.toString()} attributable to rounding. ADR-0006 §5: this is a ` +
        `posting failure, not a rounding adjustment.`,
    );
  }
  return brandRounded(delta);
}

/**
 * Distributes an amount across weights so the parts sum exactly to the whole.
 *
 * Used by tax apportionment, landed-cost allocation and payment allocation. The
 * naive form — round each share independently — loses or gains a minor unit;
 * the remainder is handed out one unit at a time, largest fractional part first.
 */
export function allocateProportionally(
  total: RoundedMoney,
  weights: readonly Decimal[],
  currency?: string | CurrencyPrecision,
): RoundedMoney[] {
  const precision = resolve(currency ?? total.currency);
  if (weights.length === 0) return [];

  const weightSum = weights.reduce((a, w) => a.add(w), Decimal.zero(MONEY_SCALE));
  if (weightSum.isZero()) {
    throw new RoundingError('cannot allocate across zero total weight');
  }

  const unitScale = precision.minorUnit;
  const totalUnits = total.amount.rescale(unitScale, 'DOWN');

  const exact = weights.map((w) => totalUnits.mul(w).div(weightSum, unitScale + 6, 'DOWN'));
  const floors = exact.map((e) => e.rescale(unitScale, 'FLOOR'));
  const allocated = floors.reduce((a, f) => a.add(f), Decimal.zero(unitScale));
  let remainder = totalUnits.sub(allocated).rescale(unitScale, 'DOWN');

  const order = exact
    .map((e, i) => ({ i, frac: e.sub(floors[i] as Decimal) }))
    .sort((a, b) => b.frac.compare(a.frac) || a.i - b.i);

  const one = Decimal.fromUnits(1n, unitScale);
  const result = [...floors];
  let cursor = 0;
  while (remainder.isPositive() && cursor < order.length) {
    const target = order[cursor] as { i: number };
    result[target.i] = (result[target.i] as Decimal).add(one);
    remainder = remainder.sub(one);
    cursor += 1;
  }
  while (remainder.isNegative() && cursor < order.length) {
    const target = order[order.length - 1 - (cursor % order.length)] as { i: number };
    result[target.i] = (result[target.i] as Decimal).sub(one);
    remainder = remainder.add(one);
    cursor += 1;
  }

  return result.map((d) => brandRounded(Money.of(d.rescale(MONEY_SCALE), total.currency)));
}
