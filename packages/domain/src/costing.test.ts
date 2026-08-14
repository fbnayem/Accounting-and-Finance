import { describe, it, expect } from 'vitest';
import { D, Decimal, sumExact } from './decimal';
import { AppError } from './errors';
import {
  VALUATION_METHODS,
  IMPLEMENTED_VALUATION_METHODS,
  consumeFifo,
  type CostLayer,
  type LayerConsumption,
  weightedAverageCost,
  weightedAverageIssue,
  averageUnitCost,
  allocateLandedCost,
} from './costing';

/** Asserts the throw is an AppError so its code and details can be inspected. */
function appError(fn: () => unknown): AppError {
  try {
    fn();
  } catch (e) {
    if (AppError.isAppError(e)) return e;
    throw e;
  }
  throw new Error('expected an AppError, got a return value');
}

/** What the service does after a consumption: decrement the layers it names. */
function applyConsumptions(
  layers: readonly CostLayer[],
  consumptions: readonly LayerConsumption[],
): CostLayer[] {
  return layers.map((layer) => {
    const used = consumptions
      .filter((c) => c.layerId === layer.id)
      .reduce((acc, c) => acc.add(c.quantity), D('0'));
    return { ...layer, remainingQuantity: layer.remainingQuantity.sub(used) };
  });
}

const rows = (r: { consumptions: readonly LayerConsumption[] }) =>
  r.consumptions.map((c) => [c.layerId, c.quantity.toString(), c.cost.toString()]);

describe('valuation methods', () => {
  it('offers no LIFO, in agreement with the database enum', () => {
    // ADR-0001: LIFO is prohibited under IFRS (IAS 2), and the schema's
    // valuation_method enum has no LIFO member. If either side ever grows one,
    // this is the test that notices the disagreement.
    expect(VALUATION_METHODS).not.toContain('LIFO');
    expect(IMPLEMENTED_VALUATION_METHODS).toEqual(['FIFO', 'WEIGHTED_AVERAGE']);
  });
});

describe('consumeFifo', () => {
  // The doc 08 golden receipts: 100 @ 2.00, 150 @ 2.20, 50 @ 2.50 = 655.00 in.
  const golden: readonly CostLayer[] = [
    { id: 'L1', remainingQuantity: D('100'), unitCost: D('2.00') },
    { id: 'L2', remainingQuantity: D('150'), unitCost: D('2.20') },
    { id: 'L3', remainingQuantity: D('50'), unitCost: D('2.50') },
  ];

  it('golden: issue 120 costs 244.00 (100 @ 2.00 + 20 @ 2.20)', () => {
    // 100 × 2.00 = 200.00 exhausts L1; the remaining 20 × 2.20 = 44.00 comes
    // from L2. COGS 244.00.
    const r = consumeFifo(golden, D('120'), 'USD');
    expect(rows(r)).toEqual([
      ['L1', '100', '200.00000000'],
      ['L2', '20', '44.00000000'],
    ]);
    expect(r.totalCost.toString()).toBe('244.00000000');
  });

  it('golden: the second issue of 160 costs 361.00 and leaves 20 @ 2.50 = 50.00', () => {
    const first = consumeFifo(golden, D('120'), 'USD');
    const after = applyConsumptions(golden, first.consumptions);

    // L2 has 130 left: 130 × 2.20 = 286.00, then 30 × 2.50 = 75.00 from L3.
    const second = consumeFifo(after, D('160'), 'USD');
    expect(rows(second)).toEqual([
      ['L2', '130', '286.00000000'],
      ['L3', '30', '75.00000000'],
    ]);
    expect(second.totalCost.toString()).toBe('361.00000000');

    // Ending inventory is 20 @ 2.50 = 50.00, and the reconciliation identity
    // holds to the cent: 655.00 received − 244.00 − 361.00 = 50.00. This is the
    // inventory-to-GL reconciliation (doc 08 acceptance) in miniature.
    const ending = applyConsumptions(after, second.consumptions);
    const endingValue = ending.reduce(
      (acc, l) => acc.add(l.remainingQuantity.mul(l.unitCost)),
      D('0'),
    );
    expect(endingValue.equals(D('50.00'))).toBe(true);
    expect(D('655.00').sub(first.totalCost).sub(second.totalCost).toString()).toBe('50.00000000');
  });

  it('emits no row for an exhausted layer', () => {
    // A CONSUMED layer is normal history. A zero-quantity consumption row would
    // be noise in the audit trail and a zero-cost journal line downstream.
    const layers: readonly CostLayer[] = [
      { id: 'spent', remainingQuantity: D('0'), unitCost: D('9.99') },
      { id: 'open', remainingQuantity: D('10'), unitCost: D('3.00') },
    ];
    const r = consumeFifo(layers, D('4'), 'USD');
    expect(rows(r)).toEqual([['open', '4', '12.00000000']]);
  });

  it('stops exactly at a layer boundary', () => {
    // Consuming exactly L1 must not touch L2 — off-by-one here would post cost
    // from a layer the goods never came from.
    const r = consumeFifo(golden, D('100'), 'USD');
    expect(rows(r)).toEqual([['L1', '100', '200.00000000']]);
  });

  it('rounds per consumption and sums the rounded parts, never the reverse', () => {
    // Two layers of 0.5 @ 1.01: each consumption is 0.505, rounded HALF_UP to
    // 0.51 — the amount its stored inventory_cost_consumptions row will carry.
    // Rounding once over the whole issue would give 1.01, and then COGS would
    // disagree with the sum of its own audit rows by a cent, which is exactly
    // the failure exit criterion 3 ("COGS is reproducible from stored cost
    // layers/calculations") exists to rule out.
    const layers: readonly CostLayer[] = [
      { id: 'A', remainingQuantity: D('0.5'), unitCost: D('1.01') },
      { id: 'B', remainingQuantity: D('0.5'), unitCost: D('1.01') },
    ];
    const r = consumeFifo(layers, D('1'), 'USD');
    expect(rows(r)).toEqual([
      ['A', '0.5', '0.51000000'],
      ['B', '0.5', '0.51000000'],
    ]);
    expect(r.totalCost.toString()).toBe('1.02000000');
    expect(r.totalCost.equals(sumExact(r.consumptions.map((c) => c.cost)))).toBe(true);
  });

  it('refuses over-consumption instead of returning a short answer', () => {
    // 350 requested against 300 on hand. A partial breakdown would be silent
    // under-costing; the named error is what lets the service apply the
    // negative-stock policy deliberately.
    const err = appError(() => consumeFifo(golden, D('350'), 'USD'));
    expect(err.code).toBe('INSUFFICIENT_STOCK');
    expect(err.details).toEqual({ requested: '350', available: '300' });
  });

  it('refuses a zero or negative issue quantity', () => {
    expect(appError(() => consumeFifo(golden, D('0'), 'USD')).code).toBe('VALIDATION_FAILED');
    expect(appError(() => consumeFifo(golden, D('-5'), 'USD')).code).toBe('VALIDATION_FAILED');
  });
});

describe('weighted average', () => {
  it('golden: carries value as the source of truth through the worked example', () => {
    // Receipts 100 @ 2.00 and 150 @ 2.20: qty 250, value 530.00.
    let s = weightedAverageCost(D('0'), D('0'), D('100'), D('2.00'), 'USD');
    s = weightedAverageCost(s.quantity, s.value, D('150'), D('2.20'), 'USD');
    expect(s.quantity.toString()).toBe('250');
    expect(s.value.toString()).toBe('530.00000000');
    // 530.00 / 250 = 2.12 exactly — for once the derived average is clean.
    expect(averageUnitCost(s, 2).toString()).toBe('2.12');

    // Issue A: 530.00 × 120 / 250 = 254.40, also exact.
    const a = weightedAverageIssue(s.quantity, s.value, D('120'), 'USD');
    expect(a.cogs.toString()).toBe('254.40000000');
    expect(a.remaining.quantity.toString()).toBe('130');
    expect(a.remaining.value.toString()).toBe('275.60000000');

    // Receipt 50 @ 2.50: qty 180, value 275.60 + 125.00 = 400.60. From here the
    // average is 2.2255 recurring — NOT exact at any scale, which is why it is
    // derived on demand and never stored.
    s = weightedAverageCost(a.remaining.quantity, a.remaining.value, D('50'), D('2.50'), 'USD');
    expect(s.value.toString()).toBe('400.60000000');
    expect(averageUnitCost(s, 8).toString()).toBe('2.22555556');

    // Issue B: 400.60 × 160 / 180 = 356.0888... → 356.09, rounded once. The
    // ending value is 400.60 − 356.09 = 44.51. The wrong implementation —
    // store the 2dp average, re-multiply — books 20 × 2.23 = 44.60: nine cents
    // of inventory that was never received, which the GL control account will
    // never reconcile to (exit criterion 1).
    const b = weightedAverageIssue(s.quantity, s.value, D('160'), 'USD');
    expect(b.cogs.toString()).toBe('356.09000000');
    expect(b.remaining.quantity.toString()).toBe('20');
    expect(b.remaining.value.toString()).toBe('44.51000000');
    expect(b.remaining.value.equals(s.value.sub(b.cogs))).toBe(true);

    // Counting out the last 20 units books exactly the 44.51 the account holds
    // and leaves zero value on zero stock. Nothing is stranded, nothing drifts.
    const c = weightedAverageIssue(b.remaining.quantity, b.remaining.value, D('20'), 'USD');
    expect(c.cogs.toString()).toBe('44.51000000');
    expect(c.remaining.value.toString()).toBe('0.00000000');

    // The whole run reconciles: 200.00 + 330.00 + 125.00 in,
    // 254.40 + 356.09 + 44.51 out, 0.00 held.
    expect(D('655.00').sub(a.cogs).sub(b.cogs).sub(c.cogs).toString()).toBe('0.00000000');
  });

  it('drains a full issue to exactly zero value', () => {
    // 10.00 over 3 units has no exact per-unit cost. quantity × average would
    // book 3 × 3.33 = 9.99 and strand a cent of value on zero quantity — stock
    // that does not exist but is still on the books.
    const r = weightedAverageIssue(D('3'), D('10.00'), D('3'), 'USD');
    expect(r.cogs.toString()).toBe('10.00000000');
    expect(r.remaining.quantity.toString()).toBe('0');
    expect(r.remaining.value.toString()).toBe('0.00000000');
  });

  it('rounds a receipt value once, at the minor unit', () => {
    // 3 × 0.333333 = 0.999999 → 1.00, the same number that posts Dr Inventory.
    // Adding the unrounded product instead would let the running value diverge
    // from the GL control by fractions of a cent per receipt.
    const s = weightedAverageCost(D('0'), D('0'), D('3'), D('0.333333'), 'USD');
    expect(s.value.toString()).toBe('1.00000000');
  });

  it('respects the currency minor unit, which is not always 2', () => {
    // JPY has no minor unit at all: a third of 1000 yen is 333, not 333.33.
    const r = weightedAverageIssue(D('3'), D('1000'), D('1'), 'JPY');
    expect(r.cogs.toString()).toBe('333.00000000');
    expect(r.remaining.value.toString()).toBe('667.00000000');
  });

  it('refuses an issue beyond the quantity on hand', () => {
    const err = appError(() => weightedAverageIssue(D('10'), D('25.00'), D('10.5'), 'USD'));
    expect(err.code).toBe('INSUFFICIENT_STOCK');
    expect(err.details).toEqual({ requested: '10.5', available: '10' });
  });

  it('refuses non-positive receipt and issue quantities', () => {
    expect(
      appError(() => weightedAverageCost(D('1'), D('2.00'), D('0'), D('1.00'), 'USD')).code,
    ).toBe('VALIDATION_FAILED');
    expect(appError(() => weightedAverageIssue(D('1'), D('2.00'), D('-1'), 'USD')).code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('has no average to offer over zero quantity', () => {
    // 0 value over 0 units is not "0.00 per unit" — a movement priced off that
    // fiction would post real money.
    expect(appError(() => averageUnitCost({ quantity: D('0'), value: D('0') })).code).toBe(
      'VALIDATION_FAILED',
    );
  });
});

describe('allocateLandedCost', () => {
  const amounts = (r: readonly { targetId: string; amount: Decimal }[]) =>
    r.map((a) => [a.targetId, a.amount.toString()]);
  const total = (r: readonly { targetId: string; amount: Decimal }[]) =>
    sumExact(r.map((a) => a.amount));

  it('allocates by VALUE and sums exactly to the document amount', () => {
    // 60.00 freight over the golden receipts' values 200 / 330 / 125 (sum 655):
    // exact shares are 18.3206…, 30.2290…, 11.4503…. Rounding each down and
    // handing the leftover cent to the largest fractional part gives
    // 18.32 + 30.23 + 11.45 = 60.00 — doc 08 acceptance: "Landed cost
    // allocation totals exactly equal landed-cost document amount".
    const r = allocateLandedCost(
      'VALUE',
      [
        { id: 'R1', value: D('200.00') },
        { id: 'R2', value: D('330.00') },
        { id: 'R3', value: D('125.00') },
      ],
      D('60.00'),
      'USD',
    );
    expect(amounts(r)).toEqual([
      ['R1', '18.32000000'],
      ['R2', '30.23000000'],
      ['R3', '11.45000000'],
    ]);
    expect(total(r).toString()).toBe('60.00000000');
  });

  it('allocates by QUANTITY without losing the cent that thirds create', () => {
    // 100.00 over quantities 100 / 150 / 50: naive independent rounding books
    // 33.33 + 50.00 + 16.67 only if someone owns the remainder. The database
    // trigger assert_landed_cost_fully_allocated refuses 99.99.
    const r = allocateLandedCost(
      'QUANTITY',
      [
        { id: 'a', quantity: D('100') },
        { id: 'b', quantity: D('150') },
        { id: 'c', quantity: D('50') },
      ],
      D('100.00'),
      'USD',
    );
    expect(amounts(r)).toEqual([
      ['a', '33.33000000'],
      ['b', '50.00000000'],
      ['c', '16.67000000'],
    ]);
  });

  it('allocates by WEIGHT and VOLUME through the same proportional path', () => {
    const byWeight = allocateLandedCost(
      'WEIGHT',
      [
        { id: 'w1', weight: D('2.5') },
        { id: 'w2', weight: D('7.5') },
      ],
      D('10.00'),
      'USD',
    );
    expect(amounts(byWeight)).toEqual([
      ['w1', '2.50000000'],
      ['w2', '7.50000000'],
    ]);

    const byVolume = allocateLandedCost(
      'VOLUME',
      [
        { id: 'v1', volume: D('7') },
        { id: 'v2', volume: D('11') },
        { id: 'v3', volume: D('13') },
      ],
      D('10.00'),
      'USD',
    );
    expect(total(byVolume).toString()).toBe('10.00000000');
  });

  it('never allocates a fraction of a minor unit, even when the unit is whole', () => {
    // JPY: 1000 over three equal weights is 333.33… each, but a third of a yen
    // does not exist. Largest remainder at the minor unit gives 334/333/333;
    // ties go to the earliest target, deterministically.
    const r = allocateLandedCost(
      'QUANTITY',
      [
        { id: 'a', quantity: D('1') },
        { id: 'b', quantity: D('1') },
        { id: 'c', quantity: D('1') },
      ],
      D('1000'),
      'JPY',
    );
    expect(amounts(r)).toEqual([
      ['a', '334.00000000'],
      ['b', '333.00000000'],
      ['c', '333.00000000'],
    ]);
  });

  it('accepts a MANUAL split that sums exactly, verbatim', () => {
    const r = allocateLandedCost(
      'MANUAL',
      [
        { id: 'a', manualAmount: D('40.00') },
        { id: 'b', manualAmount: D('35.00') },
        { id: 'c', manualAmount: D('25.00') },
      ],
      D('100.00'),
      'USD',
    );
    expect(total(r).toString()).toBe('100.00000000');
    expect(amounts(r)).toEqual([
      ['a', '40.00000000'],
      ['b', '35.00000000'],
      ['c', '25.00000000'],
    ]);
  });

  it('refuses a MANUAL split that does not sum to the document amount', () => {
    // 99.00 allocated of a 100.00 charge leaves a dollar of freight nowhere.
    // The database trigger would refuse it at posting; this names the numbers.
    const err = appError(() =>
      allocateLandedCost(
        'MANUAL',
        [
          { id: 'a', manualAmount: D('40.00') },
          { id: 'b', manualAmount: D('59.00') },
        ],
        D('100.00'),
        'USD',
      ),
    );
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.message).toMatch(/MANUAL_ALLOCATION_DOES_NOT_SUM/);
    expect(err.details).toEqual({ allocated: '99.00000000', amount: '100.00000000' });
  });

  it('refuses a MANUAL target with no amount rather than treating it as zero', () => {
    const err = appError(() =>
      allocateLandedCost(
        'MANUAL',
        [{ id: 'a', manualAmount: D('100.00') }, { id: 'b' }],
        D('100.00'),
        'USD',
      ),
    );
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.fieldErrors.map((f) => f.field)).toEqual(['targets[1].manualAmount']);
  });

  it('refuses a missing measure rather than allocating a target nothing', () => {
    // A target silently weighted zero is a valuation error no report surfaces:
    // its layer simply carries less cost than it should, forever.
    const err = appError(() =>
      allocateLandedCost('WEIGHT', [{ id: 'a', weight: D('1') }, { id: 'b' }], D('10.00'), 'USD'),
    );
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.fieldErrors.map((f) => f.field)).toEqual(['targets[1].weight']);
  });

  it('refuses an all-zero basis, where no proportion exists', () => {
    const err = appError(() =>
      allocateLandedCost(
        'VOLUME',
        [
          { id: 'a', volume: D('0') },
          { id: 'b', volume: D('0') },
        ],
        D('10.00'),
        'USD',
      ),
    );
    expect(err.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a document amount below the minor unit', () => {
    // The allocator hands out whole minor units, so 10.005 could only ever
    // allocate to 10.00 — a total "exactly equal" to nothing on the document.
    const err = appError(() =>
      allocateLandedCost('QUANTITY', [{ id: 'a', quantity: D('1') }], D('10.005'), 'USD'),
    );
    expect(err.code).toBe('VALIDATION_FAILED');
  });

  it('refuses an empty target list and a non-positive amount', () => {
    // Schema: landed_costs CHECK (amount > 0), and the fully-allocated trigger
    // makes a target-less allocation unpostable. Fail here, with names.
    expect(appError(() => allocateLandedCost('VALUE', [], D('10.00'), 'USD')).code).toBe(
      'VALIDATION_FAILED',
    );
    expect(
      appError(() => allocateLandedCost('VALUE', [{ id: 'a', value: D('1') }], D('0'), 'USD')).code,
    ).toBe('VALIDATION_FAILED');
  });
});
