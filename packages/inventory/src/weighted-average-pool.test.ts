import { describe, expect, it } from 'vitest';
import { consumeWeightedAverage, D, Decimal, MONEY_SCALE, sumExact } from '@acct/domain';
import { movementValue, weightedAveragePoolValue, type PoolLayerFact } from './stock';

/**
 * The doc 08 weighted-average golden run, end to end, through the same pure
 * pipeline `consumeStock` executes: receipts valued by `movementValue`, the
 * pool re-derived before every issue by `weightedAveragePoolValue` (received
 * minus issued, over ALL layers ever created), and each issue costed by
 * `consumeWeightedAverage` with its per-layer rows applied back to the layers.
 *
 * The invariant asserted after EVERY movement — not only at the end — is
 *
 *   Σ receipt values  −  Σ COGS  ===  derived pool value
 *
 * because a defect that cancels out by the final issue is still wrong at every
 * intermediate balance sheet. The left side is what the GL inventory control
 * holds (each receipt debits its movementValue, each issue credits its COGS);
 * the right side is what the valuation report now computes from the stored
 * layer and consumption facts. Phase 5 exit criterion 1 is that these agree.
 */

const CURRENCY = 'USD';

const money = (value: string): string => D(value).rescale(MONEY_SCALE).toString();

interface SimLayer {
  readonly id: string;
  readonly originalQuantity: Decimal;
  remainingQuantity: Decimal;
  readonly unitCost: Decimal;
  /** `inventory_cost_consumptions.total_cost`, one entry per issue that drew. */
  readonly consumed: Decimal[];
}

/** The stored facts of one item in one warehouse, as the tables would hold them. */
class SimStock {
  readonly layers: SimLayer[] = [];
  /** Σ of what each receipt posted Dr Inventory — the GL debit side. */
  received = Decimal.zero(MONEY_SCALE);
  /** Σ of what each issue posted Cr Inventory — the GL credit side. */
  issued = Decimal.zero(MONEY_SCALE);

  receive(quantity: string, unitCost: string): void {
    this.layers.push({
      id: `layer-${this.layers.length + 1}`,
      originalQuantity: D(quantity),
      remainingQuantity: D(quantity),
      unitCost: D(unitCost),
      consumed: [],
    });
    this.received = this.received.add(movementValue(D(quantity), D(unitCost), CURRENCY));
  }

  quantity(): Decimal {
    return sumExact(this.layers.map((l) => l.remainingQuantity));
  }

  /** The valuation, derived only from stored immutable facts — never carried. */
  value(): Decimal {
    return weightedAveragePoolValue(
      this.layers.map((l): PoolLayerFact => ({
        originalQuantity: l.originalQuantity,
        unitCost: l.unitCost,
        consumedValue: sumExact(l.consumed),
      })),
      CURRENCY,
    );
  }

  /** The defective expression, kept only to assert what the pool is NOT. */
  receiptCostValuation(): Decimal {
    return sumExact(
      this.layers.map((l) => movementValue(l.remainingQuantity, l.unitCost, CURRENCY)),
    );
  }

  issue(quantity: string): Decimal {
    const result = consumeWeightedAverage(
      { quantity: this.quantity(), value: this.value() },
      this.layers.map((l) => ({
        id: l.id,
        remainingQuantity: l.remainingQuantity,
        unitCost: l.unitCost,
      })),
      D(quantity),
      CURRENCY,
    );
    // The reproduction property (exit criterion 3): the stored rows re-sum to
    // exactly the once-rounded COGS the journal posts.
    expect(result.totalCost.toString()).toBe(result.cogs.toString());
    for (const consumption of result.consumptions) {
      const layer = this.layers.find((l) => l.id === consumption.layerId)!;
      layer.remainingQuantity = layer.remainingQuantity.sub(consumption.quantity);
      layer.consumed.push(consumption.cost);
    }
    this.issued = this.issued.add(result.cogs);
    return result.cogs;
  }
}

/** received − Σ COGS === derived value, the criterion-1 identity. */
function expectBooksAgree(stock: SimStock): void {
  expect(stock.value().toString()).toBe(stock.received.sub(stock.issued).toString());
}

describe('weighted-average pool value — the doc 08 golden run', () => {
  it('655.00 received; issues of 120 / 160 / 20 cost 254.40 / 356.09 / 44.51 and end at zero', () => {
    const stock = new SimStock();

    stock.receive('100', '2.00'); // 200.00
    expectBooksAgree(stock);
    stock.receive('150', '2.20'); // 330.00 → 530.00 over 250 units
    expectBooksAgree(stock);
    expect(stock.value().toString()).toBe(money('530.00'));

    // Average exactly 2.12; issue of 120 costs exactly 254.40.
    const cogs1 = stock.issue('120');
    expect(cogs1.toString()).toBe(money('254.40'));
    expectBooksAgree(stock);
    expect(stock.value().toString()).toBe(money('275.60'));
    // The measured defect, pinned in the direction it happened: the remaining
    // layers at RECEIPT cost read 286.00 here — the −10.40 gap against the GL
    // that failed exit criterion 1. The pool must not be that number.
    expect(stock.receiptCostValuation().toString()).toBe(money('286.00'));

    stock.receive('50', '2.50'); // 125.00 → 655.00 received in total
    expectBooksAgree(stock);
    expect(stock.value().toString()).toBe(money('400.60')); // over 180 units

    // 400.60 × 160 / 180 = 356.088… → rounded ONCE to 356.09.
    const cogs2 = stock.issue('160');
    expect(cogs2.toString()).toBe(money('356.09'));
    expectBooksAgree(stock);
    expect(stock.value().toString()).toBe(money('44.51'));

    // The final 20 units take the whole remaining value, not 20 × an average.
    const cogs3 = stock.issue('20');
    expect(cogs3.toString()).toBe(money('44.51'));
    expectBooksAgree(stock);
    expect(stock.quantity().isZero()).toBe(true);
    expect(stock.value().isZero()).toBe(true);

    // Everything received left as COGS: 254.40 + 356.09 + 44.51 = 655.00.
    expect(sumExact([cogs1, cogs2, cogs3]).toString()).toBe(money('655.00'));
  });

  it('the measured HTTP case: 530.00 received, issue 120, the pool holds the GL 275.60', () => {
    const stock = new SimStock();
    stock.receive('100', '2.00');
    stock.receive('150', '2.20');
    expect(stock.issue('120').toString()).toBe(money('254.40'));
    expectBooksAgree(stock);
    expect(stock.value().toString()).toBe(money('275.60'));
    expect(stock.quantity().equals(D('130'))).toBe(true);
  });
});

describe('weightedAveragePoolValue', () => {
  it('nets fully consumed layers instead of dropping them', () => {
    // After the golden run's first issue, layer 1 is fully consumed having
    // charged 212.00 against its 200.00 receipt: its −12.00 stays in the pool
    // forever. Deriving only from open layers is exactly how the drift arose.
    const facts: PoolLayerFact[] = [
      { originalQuantity: D('100'), unitCost: D('2.00'), consumedValue: D('212.00') },
      { originalQuantity: D('150'), unitCost: D('2.20'), consumedValue: D('42.40') },
    ];
    expect(weightedAveragePoolValue(facts, CURRENCY).toString()).toBe(money('275.60'));
  });

  it('values the received side once per layer at the minor unit, like the receipt journal', () => {
    // 3 × 3.333333 = 9.999999, but the receipt posted 10.00 — the pool must
    // hold the number the GL holds, not the unrounded product.
    const facts: PoolLayerFact[] = [
      { originalQuantity: D('3'), unitCost: D('3.333333'), consumedValue: Decimal.zero(2) },
    ];
    expect(weightedAveragePoolValue(facts, CURRENCY).toString()).toBe(money('10.00'));
  });

  it('an empty pool is worth exactly zero', () => {
    expect(weightedAveragePoolValue([], CURRENCY).isZero()).toBe(true);
  });
});
