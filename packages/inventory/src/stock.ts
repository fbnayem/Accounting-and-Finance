import {
  Decimal,
  D,
  MONEY_SCALE,
  Money,
  roundToMinorUnit,
  allocateProportionally,
  currencyPrecision,
  sumExact,
  DEFAULT_ROUNDING,
  type RoundingMode,
} from '@acct/domain';

/**
 * Pure stock arithmetic and shapes shared by the inventory services.
 *
 * The costing arithmetic itself lives in @acct/domain (`consumeFifo`,
 * `weightedAverageIssue`, `allocateLandedCost`); what belongs here is the glue
 * that is still pure but specific to how this package stores things — how a
 * weighted-average COGS total is spread over the layer rows it drew down, and
 * how a posted document's movements mirror into a reversal.
 */

// ---------------------------------------------------------------------------
// Negative stock policy — F-919
// ---------------------------------------------------------------------------

export type NegativeStockPolicy = 'BLOCK' | 'ALLOW_PROVISIONAL';

/**
 * Resolution order from 0043 §5: the per-entity override on
 * `item_accounting_settings`, then the item's own policy. The item column is
 * NOT NULL DEFAULT 'BLOCK', so the entity-wide `allow_negative_stock` switch
 * (0003) is never the deciding vote here — the most specific configured value
 * wins, and there is always at least the item's.
 */
export function resolveNegativeStockPolicy(
  itemPolicy: NegativeStockPolicy,
  entityOverride: NegativeStockPolicy | null | undefined,
): NegativeStockPolicy {
  return entityOverride ?? itemPolicy;
}

// ---------------------------------------------------------------------------
// Spreading a weighted-average COGS over the layers it consumed
// ---------------------------------------------------------------------------

export interface LayerTake {
  readonly layerId: string;
  readonly quantity: Decimal;
}

export interface SpreadRow {
  readonly layerId: string;
  readonly quantity: Decimal;
  readonly cost: Decimal;
}

/**
 * Splits an already-posted total across the layer quantities a movement
 * touched, so `inventory_cost_consumptions` gets one row per layer (Phase 5
 * exit criterion 3) whose totals sum EXACTLY to that posted amount.
 *
 * Rounding each row independently does not have that property — three rows of a
 * 100.01 total would each round to 33.34 and claim 100.02 — so the reproduction
 * "sum the stored rows" would differ from the journal by a cent that no one can
 * explain. `allocateProportionally` (largest remainder) distributes the exact
 * total instead.
 *
 * The issue side no longer comes through here: a weighted-average issue is
 * `consumeWeightedAverage` in @acct/domain, which does this same distribution
 * over the engine's once-rounded COGS and derives each row's unit cost from its
 * own share. What is left is the reversal of an inbound movement, where the
 * amount to spread is the value the original movement capitalised.
 */
export function spreadCostAcrossTakes(
  takes: readonly LayerTake[],
  totalCost: Decimal,
  currency: string,
): SpreadRow[] {
  if (takes.length === 0) return [];
  const precision = currencyPrecision(currency);
  if (totalCost.isZero()) {
    return takes.map((take) => ({
      layerId: take.layerId,
      quantity: take.quantity,
      cost: Decimal.zero(MONEY_SCALE),
    }));
  }
  const parts = allocateProportionally(
    roundToMinorUnit(Money.of(totalCost, precision.code), precision),
    takes.map((take) => take.quantity),
    precision,
  );
  return takes.map((take, i) => ({
    layerId: take.layerId,
    quantity: take.quantity,
    cost: (parts[i] as Money).amount,
  }));
}

// ---------------------------------------------------------------------------
// Receipt-side value
// ---------------------------------------------------------------------------

/**
 * quantity × unit cost, rounded ONCE at the currency minor unit — the same
 * decision `weightedAverageCost` makes for the receipt side, applied here to
 * the movement's `total_cost` and the layer's implied value so the number that
 * posts Dr Inventory and the number valuation later sums are one number.
 */
export function movementValue(
  quantity: Decimal,
  unitCost: Decimal,
  currency: string,
  mode: RoundingMode = DEFAULT_ROUNDING,
): Decimal {
  const precision = currencyPrecision(currency);
  return quantity.mul(unitCost).rescale(precision.minorUnit, mode).rescale(MONEY_SCALE);
}

// ---------------------------------------------------------------------------
// Weighted-average pool value — received minus issued
// ---------------------------------------------------------------------------

/** The immutable facts one cost layer contributes to a weighted-average pool. */
export interface PoolLayerFact {
  /** `inventory_cost_layers.original_quantity` — written once at receipt. */
  readonly originalQuantity: Decimal;
  /** `inventory_cost_layers.unit_cost` — 0043's guard keeps it immutable. */
  readonly unitCost: Decimal;
  /** Σ `total_cost` over the layer's `inventory_cost_consumptions` rows. */
  readonly consumedValue: Decimal;
}

/**
 * The value of a weighted-average pool: received minus issued.
 *
 *   Σ round(original_quantity × unit_cost, minor unit)  −  Σ consumption total_cost
 *
 * Doc 08 carries VALUE as the source of truth for weighted average. An issue
 * credits Inventory by the average-based COGS while the layers lose QUANTITY
 * that was priced at receipt cost, so Σ(remaining_quantity × unit_cost) stops
 * being the pool value at the first issue and never reconverges — on the doc 08
 * golden run it reads 286.00 where the GL control holds 275.60. Received minus
 * issued IS the control balance by construction: the received side is per-layer
 * `movementValue`, the same once-rounded number the receipt posted Dr
 * Inventory, and the issued side is the stored consumption rows, whose sum is
 * exactly the COGS each issue posted Cr Inventory.
 *
 * The facts must span EVERY layer the item has ever had in scope, including
 * fully consumed ones: a consumed layer whose issues charged more (or less)
 * than its receipt value keeps that difference in the pool — on the golden run
 * the first layer contributes 200.00 − 212.00 = −12.00 forever. Dropping
 * consumed layers is precisely how the drift happened.
 *
 * Both operands arrive at the minor unit after their own single rounding, so
 * the difference is too — no rounding decision is taken here.
 */
export function weightedAveragePoolValue(
  facts: readonly PoolLayerFact[],
  currency: string,
  mode: RoundingMode = DEFAULT_ROUNDING,
): Decimal {
  const received = sumExact(
    facts.map((fact) => movementValue(fact.originalQuantity, fact.unitCost, currency, mode)),
  );
  const issued = sumExact(facts.map((fact) => fact.consumedValue));
  return received.sub(issued).rescale(MONEY_SCALE);
}

// ---------------------------------------------------------------------------
// Mirroring movements for a reversal document — F-908
// ---------------------------------------------------------------------------

export interface MovementShape {
  readonly item_id: string;
  readonly from_location_id: string | null;
  readonly to_location_id: string | null;
  readonly quantity: string;
  readonly uom: string;
  readonly stock_lot_id: string | null;
  readonly serial_unit_id: string | null;
}

export interface MirroredMovement {
  readonly itemId: string;
  readonly fromLocationId: string | null;
  readonly toLocationId: string | null;
  readonly quantity: Decimal;
  readonly uom: string;
  readonly stockLotId: string | null;
  readonly serialUnitId: string | null;
}

/**
 * The reverse movement doc 08 requires: quantity negated and the locations
 * swapped, so an inbound line becomes an outbound line FROM the location it
 * went to. The swap is what keeps `movement_direction_has_location` (0012)
 * satisfied on the mirrored row — a negated inbound still has its location,
 * now on the outbound side.
 */
export function mirrorMovement(movement: MovementShape): MirroredMovement {
  const quantity = D(movement.quantity);
  return {
    itemId: movement.item_id,
    fromLocationId: movement.to_location_id,
    toLocationId: movement.from_location_id,
    quantity: Decimal.zero(quantity.scale).sub(quantity),
    uom: movement.uom,
    stockLotId: movement.stock_lot_id,
    serialUnitId: movement.serial_unit_id,
  };
}
