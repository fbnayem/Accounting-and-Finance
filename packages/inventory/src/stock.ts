import {
  Decimal,
  D,
  MONEY_SCALE,
  Money,
  roundToMinorUnit,
  allocateProportionally,
  currencyPrecision,
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
 * Splits a weighted-average issue's COGS across the layer quantities it drew
 * down, so `inventory_cost_consumptions` gets one row per layer touched (Phase
 * 5 exit criterion 3) whose totals sum EXACTLY to the posted COGS.
 *
 * Rounding each row independently at the average unit cost does not have that
 * property — three rows of a 100.01 issue would each round to 33.34 and claim
 * 100.02 — so the reproduction "sum the stored rows" would differ from the
 * journal by a cent that no one can explain. `allocateProportionally` (largest
 * remainder) distributes the exact total instead.
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
