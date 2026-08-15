import { describe, expect, it } from 'vitest';
import { consumeWeightedAverage, D, Decimal, MONEY_SCALE, sumExact } from '@acct/domain';
import { movementValue, weightedAveragePoolValue, type PoolLayerFact } from './stock';

/**
 * The doc 08 weighted-average golden run, end to end, through the same pure
 * pipeline `consumeStock` executes: receipts valued by `movementValue`, the
 * pool re-derived before every issue by `weightedAveragePoolValue` (received
 * minus issued plus restored, over ALL layers ever created), and each issue
 * costed by `consumeWeightedAverage` with its per-layer rows applied back to
 * the layers.
 *
 * The invariant asserted after EVERY movement — not only at the end — is
 *
 *   Σ receipt values  −  Σ COGS  +  Σ reversed COGS  ===  derived pool value
 *
 * because a defect that cancels out by the final issue is still wrong at every
 * intermediate balance sheet. The left side is what the GL inventory control
 * holds (each receipt debits its movementValue, each issue credits its COGS,
 * each reversal debits that COGS back); the right side is what the valuation
 * report now computes from the stored layer, consumption and restoration facts.
 * Phase 5 exit criterion 1 is that these agree.
 */

const CURRENCY = 'USD';

const money = (value: string): string => D(value).rescale(MONEY_SCALE).toString();

interface SimLayer {
  readonly id: string;
  readonly originalQuantity: Decimal;
  remainingQuantity: Decimal;
  readonly unitCost: Decimal;
}

/**
 * One `inventory_cost_consumptions` row, and the one `inventory_cost_
 * restorations` fact that can attach to it.
 *
 * Modelled as rows rather than as a per-layer running total because that is
 * what the tables are, and because F-923 is entirely about a fact that has no
 * home when the consumption is only a number: `restored` is the row 0048 adds,
 * and `cost` stays exactly where it was — the issue really did post it.
 */
interface SimConsumption {
  readonly layerId: string;
  readonly issueId: string;
  readonly quantity: Decimal;
  readonly cost: Decimal;
  restored: boolean;
}

/** The stored facts of one item in one warehouse, as the tables would hold them. */
class SimStock {
  readonly layers: SimLayer[] = [];
  readonly consumptions: SimConsumption[] = [];
  /** Σ of what each receipt posted Dr Inventory — the GL debit side. */
  received = Decimal.zero(MONEY_SCALE);
  /** Σ of what each issue posted Cr Inventory — the GL credit side. */
  issued = Decimal.zero(MONEY_SCALE);
  /** Σ of what each reversal posted Dr Inventory back. */
  restored = Decimal.zero(MONEY_SCALE);

  receive(quantity: string, unitCost: string): void {
    this.layers.push({
      id: `layer-${this.layers.length + 1}`,
      originalQuantity: D(quantity),
      remainingQuantity: D(quantity),
      unitCost: D(unitCost),
    });
    this.received = this.received.add(movementValue(D(quantity), D(unitCost), CURRENCY));
  }

  quantity(): Decimal {
    return sumExact(this.layers.map((l) => l.remainingQuantity));
  }

  /** The valuation, derived only from stored immutable facts — never carried. */
  value(): Decimal {
    return weightedAveragePoolValue(
      this.layers.map((l): PoolLayerFact => {
        const rows = this.consumptions.filter((c) => c.layerId === l.id);
        return {
          originalQuantity: l.originalQuantity,
          unitCost: l.unitCost,
          consumedValue: sumExact(rows.map((c) => c.cost)),
          restoredValue: sumExact(rows.filter((c) => c.restored).map((c) => c.cost)),
        };
      }),
      CURRENCY,
    );
  }

  /** The defective expression, kept only to assert what the pool is NOT. */
  receiptCostValuation(): Decimal {
    return sumExact(
      this.layers.map((l) => movementValue(l.remainingQuantity, l.unitCost, CURRENCY)),
    );
  }

  issue(quantity: string, issueId = `issue-${this.consumptions.length + 1}`): Decimal {
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
      this.consumptions.push({
        layerId: consumption.layerId,
        issueId,
        quantity: consumption.quantity,
        cost: consumption.cost,
        restored: false,
      });
    }
    this.issued = this.issued.add(result.cogs);
    return result.cogs;
  }

  /**
   * `restoreConsumedLayers`: quantity back to the layer, and the restoration
   * fact against the consumption row — which is NOT edited, because the issue
   * did post that COGS and its journal still stands.
   */
  reverseIssue(issueId: string): Decimal {
    const rows = this.consumptions.filter((c) => c.issueId === issueId && !c.restored);
    expect(rows.length, `issue ${issueId} has consumption rows to give back`).toBeGreaterThan(0);
    for (const row of rows) {
      const layer = this.layers.find((l) => l.id === row.layerId)!;
      layer.remainingQuantity = layer.remainingQuantity.add(row.quantity);
      row.restored = true;
    }
    const reversed = sumExact(rows.map((r) => r.cost));
    this.restored = this.restored.add(reversed);
    return reversed;
  }
}

/** received − Σ COGS + Σ reversed COGS === derived value, the criterion-1 identity. */
function expectBooksAgree(stock: SimStock): void {
  expect(stock.value().toString()).toBe(
    stock.received.sub(stock.issued).add(stock.restored).toString(),
  );
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

describe('reversing a weighted-average issue — F-923', () => {
  it('puts the value back, not only the quantity', () => {
    const stock = new SimStock();
    stock.receive('100', '2.00');
    stock.receive('150', '2.20');
    expect(stock.issue('120', 'iss-1').toString()).toBe(money('254.40'));
    expect(stock.value().toString()).toBe(money('275.60'));

    expect(stock.reverseIssue('iss-1').toString()).toBe(money('254.40'));

    // The whole of F-923. Before the restoration fact existed the quantity came
    // back to 250 and the value stayed at 275.60, while the reversal journal had
    // already debited 254.40 into the control account — a 254.40 gap between the
    // valuation and its GL control that no reconciling item could name.
    expect(stock.quantity().equals(D('250'))).toBe(true);
    expect(stock.value().toString()).toBe(money('530.00'));
    expectBooksAgree(stock);
  });

  it('leaves the reversed issue reproducible from its own consumption rows', () => {
    // Exit criterion 3 is about the issue that happened, and it did charge
    // 254.40. The restoration is a separate fact about a separate journal; a
    // correction that edited the consumption rows would erase the evidence
    // instead of reversing it.
    const stock = new SimStock();
    stock.receive('100', '2.00');
    stock.receive('150', '2.20');
    stock.issue('120', 'iss-1');
    stock.reverseIssue('iss-1');

    const rows = stock.consumptions.filter((c) => c.issueId === 'iss-1');
    expect(rows).toHaveLength(2);
    expect(sumExact(rows.map((r) => r.cost)).toString()).toBe(money('254.40'));
    expect(rows.every((r) => r.restored)).toBe(true);
  });

  it('prices the next issue off the restored pool, not the pre-reversal one', () => {
    // The half a fix can quietly fail. Parking the reversed value somewhere the
    // valuation can see it, without returning it to the pool, satisfies the
    // reconciliation above and then costs the next issue of 120 at 132.29 —
    // 275.60 × 120 / 250 — which is what the defective build actually did.
    const stock = new SimStock();
    stock.receive('100', '2.00');
    stock.receive('150', '2.20');
    stock.issue('120', 'iss-1');
    stock.reverseIssue('iss-1');

    expect(stock.issue('120', 'iss-2').toString()).toBe(money('254.40'));
    expect(stock.value().toString()).toBe(money('275.60'));
    expect(stock.quantity().equals(D('130'))).toBe(true);
    expectBooksAgree(stock);
  });

  it('holds when an issue is reversed after a later issue has already priced off it', () => {
    // Reversal is not undo: the second issue was correctly priced at the average
    // that stood when it happened, and reversing the first does not re-price it.
    // What must remain true is that both sides move together — the reversal
    // debits the control by exactly what the first issue credited it.
    const stock = new SimStock();
    stock.receive('100', '2.00');
    stock.receive('150', '2.20');
    expect(stock.issue('120', 'iss-1').toString()).toBe(money('254.40'));
    // 275.60 over 130 units, 50 issued → 106.00 exactly.
    expect(stock.issue('50', 'iss-2').toString()).toBe(money('106.00'));
    expectBooksAgree(stock);

    expect(stock.reverseIssue('iss-1').toString()).toBe(money('254.40'));
    expect(stock.quantity().equals(D('200'))).toBe(true);
    expect(stock.value().toString()).toBe(money('424.00'));
    expectBooksAgree(stock);
  });
});

describe('weightedAveragePoolValue', () => {
  it('nets fully consumed layers instead of dropping them', () => {
    // After the golden run's first issue, layer 1 is fully consumed having
    // charged 212.00 against its 200.00 receipt: its −12.00 stays in the pool
    // forever. Deriving only from open layers is exactly how the drift arose.
    const facts: PoolLayerFact[] = [
      {
        originalQuantity: D('100'),
        unitCost: D('2.00'),
        consumedValue: D('212.00'),
        restoredValue: Decimal.zero(2),
      },
      {
        originalQuantity: D('150'),
        unitCost: D('2.20'),
        consumedValue: D('42.40'),
        restoredValue: Decimal.zero(2),
      },
    ];
    expect(weightedAveragePoolValue(facts, CURRENCY).toString()).toBe(money('275.60'));
  });

  it('adds back exactly what a reversal restored', () => {
    // The same two layers with both consumptions given back: the pool is the
    // 530.00 that was received, because the reversal journal put that 254.40
    // back into the control account.
    const facts: PoolLayerFact[] = [
      {
        originalQuantity: D('100'),
        unitCost: D('2.00'),
        consumedValue: D('212.00'),
        restoredValue: D('212.00'),
      },
      {
        originalQuantity: D('150'),
        unitCost: D('2.20'),
        consumedValue: D('42.40'),
        restoredValue: D('42.40'),
      },
    ];
    expect(weightedAveragePoolValue(facts, CURRENCY).toString()).toBe(money('530.00'));
  });

  it('restores only the rows a reversal named, not the whole layer', () => {
    // A layer drawn by two issues, one of them reversed: 212.00 charged out,
    // 100.00 given back, so 112.00 of the layer's 200.00 receipt is still gone.
    const facts: PoolLayerFact[] = [
      {
        originalQuantity: D('100'),
        unitCost: D('2.00'),
        consumedValue: D('212.00'),
        restoredValue: D('100.00'),
      },
    ];
    expect(weightedAveragePoolValue(facts, CURRENCY).toString()).toBe(money('88.00'));
  });

  it('values the received side once per layer at the minor unit, like the receipt journal', () => {
    // 3 × 3.333333 = 9.999999, but the receipt posted 10.00 — the pool must
    // hold the number the GL holds, not the unrounded product.
    const facts: PoolLayerFact[] = [
      {
        originalQuantity: D('3'),
        unitCost: D('3.333333'),
        consumedValue: Decimal.zero(2),
        restoredValue: Decimal.zero(2),
      },
    ];
    expect(weightedAveragePoolValue(facts, CURRENCY).toString()).toBe(money('10.00'));
  });

  it('an empty pool is worth exactly zero', () => {
    expect(weightedAveragePoolValue([], CURRENCY).isZero()).toBe(true);
  });
});
