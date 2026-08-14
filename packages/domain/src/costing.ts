/**
 * Inventory costing — FIFO consumption, weighted-average valuation and
 * landed-cost allocation.
 *
 * Pure, like everything else here: no database, no clock. doc 08 requires that
 * "every issue has a reproducible valuation breakdown", and a breakdown is only
 * reproducible if the arithmetic that produced it can be re-run from the stored
 * rows alone — which is exactly what a function of (layers, quantity) and
 * nothing else guarantees. The persistence layer (locking, layer selection
 * order, negative-stock policy) lives with the service; the numbers live here.
 *
 * LIFO is deliberately absent. ADR-0001: prohibited under IFRS (IAS 2), and the
 * database enum `valuation_method` has no LIFO member either.
 */

import { Decimal, MONEY_SCALE, type RoundingMode, DEFAULT_ROUNDING, sumExact } from './decimal';
import { type CurrencyPrecision, currencyPrecision } from './currency';
import { Money } from './money';
import { roundToMinorUnit, allocateProportionally } from './rounding';
import { AppError, validationFailed } from './errors';

// ---------------------------------------------------------------------------
// Valuation methods (doc 08 "Valuation")
// ---------------------------------------------------------------------------

/**
 * Mirrors the database enum `valuation_method` in 0000_extensions_and_types.sql.
 * STANDARD and SPECIFIC are named now, unimplemented, so that adding them later
 * is an engine change rather than a contract change — doc 08 requires the
 * architecture to allow both.
 */
export const VALUATION_METHODS = ['FIFO', 'WEIGHTED_AVERAGE', 'STANDARD', 'SPECIFIC'] as const;
export type ValuationMethod = (typeof VALUATION_METHODS)[number];

/**
 * What this engine computes today. A service asked to cost an item configured
 * with anything else must refuse with NOT_IMPLEMENTED rather than fall back to
 * a method the item was not configured for.
 */
export const IMPLEMENTED_VALUATION_METHODS: readonly ValuationMethod[] = [
  'FIFO',
  'WEIGHTED_AVERAGE',
];

// ---------------------------------------------------------------------------
// Shared arithmetic
// ---------------------------------------------------------------------------

const resolve = (currency: string | CurrencyPrecision): CurrencyPrecision =>
  typeof currency === 'string' ? currencyPrecision(currency) : currency;

/**
 * One rounding decision, applied to the exact product or quotient.
 *
 * Deliberately not `roundToMinorUnit`: that takes a `Money`, and `Money.of`
 * rescales its input to MONEY_SCALE first — a second rounding decision upstream
 * of the one that matters, on products that can carry sixteen decimals.
 */
function roundCost(exact: Decimal, precision: CurrencyPrecision, mode: RoundingMode): Decimal {
  return exact.rescale(precision.minorUnit, mode).rescale(MONEY_SCALE);
}

/** True when the value carries nothing below the currency's minor unit. */
function atMinorUnit(value: Decimal, precision: CurrencyPrecision): boolean {
  return roundCost(value, precision, 'DOWN').equals(value);
}

function requirePositive(value: Decimal, field: string): void {
  if (!value.isPositive()) {
    throw validationFailed(
      [
        {
          field,
          code: 'POSITIVE_REQUIRED',
          message: `${field} must be greater than zero, got ${value.toString()}.`,
        },
      ],
      `${field} must be greater than zero.`,
    );
  }
}

// ---------------------------------------------------------------------------
// FIFO (doc 08 "Valuation"; ADR-0004 §3 fixes the consumption order)
// ---------------------------------------------------------------------------

/** One open row of `inventory_cost_layers`, as the consumption walk sees it. */
export interface CostLayer {
  /** `inventory_cost_layers.id` — the audit trail keys each consumption to it. */
  readonly id: string;
  readonly remainingQuantity: Decimal;
  readonly unitCost: Decimal;
}

/** One row destined for `inventory_cost_consumptions`. */
export interface LayerConsumption {
  readonly layerId: string;
  readonly quantity: Decimal;
  /** The layer's unit cost, echoed so the stored row re-derives without a join. */
  readonly unitCost: Decimal;
  /** quantity × unitCost, rounded once at the currency minor unit. */
  readonly cost: Decimal;
}

export interface FifoConsumption {
  readonly consumptions: readonly LayerConsumption[];
  /**
   * Exact sum of the per-consumption costs, never re-rounded (ADR-0006 steps
   * 3/4). This is the amount that posts Dr COGS, and Phase 5 exit criterion 3
   * reproduces COGS by re-summing the stored consumption rows — so this total
   * and that sum are the same number by construction, not by luck.
   */
  readonly totalCost: Decimal;
}

/**
 * Consumes `quantity` from the given layers, first layer first, and returns
 * which layer supplied how much at what cost.
 *
 * The layers must arrive already in FIFO order: ADR-0004 §3 fixes consumption
 * order as (received_date, id), and the service's SELECT ... FOR UPDATE with
 * that ORDER BY is what establishes it. This function cannot verify an ordering
 * over dates it is not given — handed layers in another order it computes some
 * other method, which is why the caller's ORDER BY is part of the costing
 * protocol and not a styling choice.
 *
 * Over-consumption is refused outright rather than answered short. Whether
 * negative stock is permitted is per-item policy that the persistence layer
 * resolves with explicit provisional layers (doc 08); a pure function cannot
 * know that policy, and a short breakdown would be silent under-costing instead
 * of an error the caller can act on.
 */
export function consumeFifo(
  layers: readonly CostLayer[],
  quantity: Decimal,
  currency: string | CurrencyPrecision,
  mode: RoundingMode = DEFAULT_ROUNDING,
): FifoConsumption {
  const precision = resolve(currency);
  requirePositive(quantity, 'quantity');

  const consumptions: LayerConsumption[] = [];
  let needed = quantity;
  let totalCost = Decimal.zero(MONEY_SCALE);

  for (const layer of layers) {
    if (needed.isZero()) break;
    // A zero remainder is normal history (a CONSUMED layer); skipping it emits
    // no zero-quantity consumption row. Negative remainders cannot exist under
    // the F-032 CHECK, so nothing real is being skipped here.
    if (!layer.remainingQuantity.isPositive()) continue;

    const take = layer.remainingQuantity.lt(needed) ? layer.remainingQuantity : needed;
    // Rounded per consumption, because each consumption is a stored audit row:
    // a total rounded once over the whole issue could differ from the sum of
    // its own rows by a minor unit, and then the reproduction fails by design.
    const cost = roundCost(take.mul(layer.unitCost), precision, mode);
    consumptions.push({ layerId: layer.id, quantity: take, unitCost: layer.unitCost, cost });
    totalCost = totalCost.add(cost);
    needed = needed.sub(take);
  }

  if (needed.isPositive()) {
    // Every layer has been walked, so what was consumed is all there was.
    const available = quantity.sub(needed);
    throw new AppError(
      'INSUFFICIENT_STOCK',
      `FIFO issue of ${quantity.toString()} exceeds the ${available.toString()} remaining across ` +
        `${layers.length} layer(s). If policy permits negative stock, the caller creates a ` +
        `provisional layer first (doc 08); this engine never costs stock it was not given.`,
      { details: { requested: quantity.toString(), available: available.toString() } },
    );
  }

  return { consumptions, totalCost };
}

// ---------------------------------------------------------------------------
// Weighted average (doc 08 "Valuation")
// ---------------------------------------------------------------------------

export interface WeightedAverageState {
  readonly quantity: Decimal;
  /**
   * Total value at cost — the source of truth. The average is derived from
   * quantity and value on demand and never stored: 400.60 over 180 units is
   * 2.2255 recurring, which no scale stores exactly, and a rounded average
   * re-multiplied drifts the ending value away from receipts-minus-issues by
   * cents that compound (see `weightedAverageIssue`).
   */
  readonly value: Decimal;
}

/**
 * Receipt side. The receipt's value is quantity × unit cost, rounded once at
 * the minor unit — the same number the receipt posts Dr Inventory — so the
 * running value stays equal to the GL inventory control account it must
 * reconcile to (doc 08 acceptance: "Inventory valuation equals GL inventory
 * controls").
 */
export function weightedAverageCost(
  currentQuantity: Decimal,
  currentValue: Decimal,
  receiptQuantity: Decimal,
  receiptUnitCost: Decimal,
  currency: string | CurrencyPrecision,
  mode: RoundingMode = DEFAULT_ROUNDING,
): WeightedAverageState {
  const precision = resolve(currency);
  requirePositive(receiptQuantity, 'receiptQuantity');

  const receiptValue = roundCost(receiptQuantity.mul(receiptUnitCost), precision, mode);
  return {
    quantity: currentQuantity.add(receiptQuantity),
    value: currentValue.add(receiptValue).rescale(MONEY_SCALE),
  };
}

/**
 * The derived average, for display and for a movement's `unit_cost` column.
 * Recomputed from the state at whatever scale the caller needs; nothing
 * downstream may multiply it back into a value — that is the drift
 * `weightedAverageIssue` exists to prevent.
 */
export function averageUnitCost(
  state: WeightedAverageState,
  scale: number = MONEY_SCALE,
  mode: RoundingMode = DEFAULT_ROUNDING,
): Decimal {
  if (!state.quantity.isPositive()) {
    throw validationFailed(
      [
        {
          field: 'quantity',
          code: 'POSITIVE_REQUIRED',
          message: `An average unit cost over ${state.quantity.toString()} units is undefined.`,
        },
      ],
      'Average unit cost requires a positive on-hand quantity.',
    );
  }
  return state.value.div(state.quantity, scale, mode);
}

export interface WeightedAverageIssue {
  /** The Dr COGS / Cr Inventory amount, rounded once at the minor unit. */
  readonly cogs: Decimal;
  readonly remaining: WeightedAverageState;
}

/**
 * Issue side — the one decision in this module that matters.
 *
 * COGS is value × issueQuantity / quantity, rounded ONCE at the minor unit, and
 * the remaining value is current value minus that COGS, exactly. The tempting
 * alternative — store a rounded average and multiply it back — leaves an ending
 * value that is not (what came in) − (what was issued): after receipts of
 * 200.00 + 330.00 + 125.00 and issues of 254.40 + 356.09 the book must hold
 * 44.51, but 20 units × a re-rounded 2.23 average is 44.60. The difference
 * never reconciles to the inventory GL control (Phase 5 exit criterion 1) and
 * compounds with every turn of the stock.
 */
export function weightedAverageIssue(
  currentQuantity: Decimal,
  currentValue: Decimal,
  issueQuantity: Decimal,
  currency: string | CurrencyPrecision,
  mode: RoundingMode = DEFAULT_ROUNDING,
): WeightedAverageIssue {
  const precision = resolve(currency);
  requirePositive(issueQuantity, 'issueQuantity');

  if (issueQuantity.gt(currentQuantity)) {
    throw new AppError(
      'INSUFFICIENT_STOCK',
      `Weighted-average issue of ${issueQuantity.toString()} exceeds the ` +
        `${currentQuantity.toString()} on hand. If policy permits negative stock, the caller ` +
        `costs the shortfall provisionally (doc 08); this engine refuses rather than guessing.`,
      {
        details: {
          requested: issueQuantity.toString(),
          available: currentQuantity.toString(),
        },
      },
    );
  }

  if (issueQuantity.equals(currentQuantity)) {
    // A full issue takes the whole value, not quantity × average: 10.00 over 3
    // units has no exact per-unit cost, and 3 × 3.33 would strand a cent of
    // value on zero quantity — stock that does not exist but is on the books.
    // The running value is built from minor-unit amounts on both sides here, so
    // returning it whole is postable as-is.
    return {
      cogs: currentValue.rescale(MONEY_SCALE),
      remaining: {
        quantity: currentQuantity.sub(issueQuantity),
        value: Decimal.zero(MONEY_SCALE),
      },
    };
  }

  const cogs = currentValue
    .mul(issueQuantity)
    .div(currentQuantity, precision.minorUnit, mode)
    .rescale(MONEY_SCALE);
  return {
    cogs,
    remaining: {
      quantity: currentQuantity.sub(issueQuantity),
      // Exact subtraction — this is what "value is the source of truth" means in
      // code. The next issue divides whatever is genuinely left, so no rounding
      // residue accumulates anywhere a count would not find it.
      value: currentValue.sub(cogs).rescale(MONEY_SCALE),
    },
  };
}

// ---------------------------------------------------------------------------
// Landed cost (doc 08 "Landed cost")
// ---------------------------------------------------------------------------

/** Matches the `landed_costs.allocation_basis` CHECK in 0012_inventory.sql. */
export type LandedCostBasis = 'VALUE' | 'QUANTITY' | 'WEIGHT' | 'VOLUME' | 'MANUAL';

/** One receipt line / cost layer the charge capitalises into. */
export interface LandedCostTarget {
  readonly id: string;
  readonly value?: Decimal;
  readonly quantity?: Decimal;
  readonly weight?: Decimal;
  readonly volume?: Decimal;
  /** MANUAL only: the caller's own split, which must still sum exactly. */
  readonly manualAmount?: Decimal;
}

export interface LandedCostAllocation {
  readonly targetId: string;
  readonly amount: Decimal;
}

const BASIS_MEASURE: Record<
  Exclude<LandedCostBasis, 'MANUAL'>,
  'value' | 'quantity' | 'weight' | 'volume'
> = {
  VALUE: 'value',
  QUANTITY: 'quantity',
  WEIGHT: 'weight',
  VOLUME: 'volume',
};

/**
 * Splits a landed-cost document across its targets so the parts sum EXACTLY to
 * the document amount — doc 08's acceptance criterion verbatim, and the trigger
 * `assert_landed_cost_fully_allocated` refuses anything else at posting time.
 *
 * The proportional bases get their exactness from `allocateProportionally`
 * (largest remainder, one minor unit at a time); MANUAL gets it by refusing a
 * split that does not add up. Missing measures are refused rather than treated
 * as zero, because a target silently allocated nothing is a valuation error
 * that no report ever surfaces.
 */
export function allocateLandedCost(
  basis: LandedCostBasis,
  targets: readonly LandedCostTarget[],
  amount: Decimal,
  currency: string | CurrencyPrecision,
): readonly LandedCostAllocation[] {
  const precision = resolve(currency);
  if (targets.length === 0) {
    throw validationFailed(
      [
        {
          field: 'targets',
          code: 'REQUIRED',
          message: 'At least one allocation target is required.',
        },
      ],
      'A landed cost with no targets cannot be allocated.',
    );
  }
  // Schema: landed_costs CHECK (amount > 0).
  requirePositive(amount, 'amount');
  if (!atMinorUnit(amount, precision)) {
    // allocateProportionally distributes whole minor units of the truncated
    // amount, so a sub-minor-unit document amount would allocate to a total
    // other than itself — precisely the failure the acceptance criterion names.
    // A posted charge cannot carry that precision anyway (ADR-0006 step 6).
    throw validationFailed(
      [
        {
          field: 'amount',
          code: 'MINOR_UNIT',
          message:
            `Landed cost amount ${amount.toString()} has more precision than ` +
            `${precision.code}'s ${precision.minorUnit} minor unit(s).`,
        },
      ],
      'Landed cost amount must be at the currency minor unit.',
    );
  }

  if (basis === 'MANUAL') {
    const amounts = targets.map((target, i) => {
      if (target.manualAmount === undefined) {
        throw validationFailed(
          [
            {
              field: `targets[${i}].manualAmount`,
              code: 'REQUIRED',
              message: 'MANUAL allocation requires an amount on every target.',
            },
          ],
          'MANUAL allocation requires an amount on every target.',
        );
      }
      if (!atMinorUnit(target.manualAmount, precision)) {
        // Each allocation capitalises into a layer and posts; step 6 of the
        // rounding chain asserts rather than rounds, so refuse it here where
        // the caller can still fix the split.
        throw validationFailed(
          [
            {
              field: `targets[${i}].manualAmount`,
              code: 'MINOR_UNIT',
              message:
                `${target.manualAmount.toString()} has more precision than ` +
                `${precision.code}'s ${precision.minorUnit} minor unit(s).`,
            },
          ],
          'Manual allocations must be at the currency minor unit.',
        );
      }
      return target.manualAmount.rescale(MONEY_SCALE);
    });

    const allocated = sumExact(amounts);
    if (!allocated.equals(amount)) {
      throw new AppError(
        'VALIDATION_FAILED',
        `MANUAL_ALLOCATION_DOES_NOT_SUM: allocations total ${allocated.toString()} but the ` +
          `landed cost document is ${amount.rescale(MONEY_SCALE).toString()}.`,
        {
          details: {
            allocated: allocated.toString(),
            amount: amount.rescale(MONEY_SCALE).toString(),
          },
        },
      );
    }
    return targets.map((target, i) => ({ targetId: target.id, amount: amounts[i] as Decimal }));
  }

  const field = BASIS_MEASURE[basis];
  const weights = targets.map((target, i) => {
    const measure = target[field];
    if (measure === undefined || measure.isNegative()) {
      throw validationFailed(
        [
          {
            field: `targets[${i}].${field}`,
            code: measure === undefined ? 'REQUIRED' : 'NEGATIVE',
            message: `Basis ${basis} needs a non-negative ${field} on every target.`,
          },
        ],
        `Basis ${basis} needs a non-negative ${field} on every target.`,
      );
    }
    return measure;
  });

  if (weights.every((w) => w.isZero())) {
    throw validationFailed(
      [
        {
          field: 'targets',
          code: 'ZERO_WEIGHT',
          message: `Every target has a zero ${field}; there is no proportion to allocate by.`,
        },
      ],
      `Cannot allocate by ${basis} when every target's ${field} is zero.`,
    );
  }

  // `amount` is already at the minor unit (checked above), so roundToMinorUnit
  // changes nothing — it exists to mint the RoundedMoney brand the allocator
  // requires as proof a rounding boundary was crossed.
  const total = roundToMinorUnit(Money.of(amount, precision.code), precision);
  const parts = allocateProportionally(total, weights, precision);
  return parts.map((part, i) => ({
    targetId: (targets[i] as LandedCostTarget).id,
    amount: part.amount,
  }));
}
