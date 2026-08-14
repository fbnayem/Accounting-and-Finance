import { describe, expect, it } from 'vitest';
import { D, sumExact } from '@acct/domain';
import {
  mirrorMovement,
  movementValue,
  resolveNegativeStockPolicy,
  spreadCostAcrossTakes,
} from './stock';

describe('spreadCostAcrossTakes', () => {
  it('rows sum exactly to the COGS total where per-row rounding would not', () => {
    // 100.01 over three equal takes: 33.336… each. Independent rounding gives
    // 33.34 × 3 = 100.02 — a stored breakdown that fails to reproduce the
    // journal by one cent. The allocator must not do that.
    const rows = spreadCostAcrossTakes(
      [
        { layerId: 'a', quantity: D('1') },
        { layerId: 'b', quantity: D('1') },
        { layerId: 'c', quantity: D('1') },
      ],
      D('100.01'),
      'USD',
    );
    const total = sumExact(rows.map((r) => r.cost));
    expect(total.toString()).toBe(D('100.01').rescale(8).toString());
    // And no row invented sub-cent precision.
    for (const row of rows) {
      expect(row.cost.rescale(2).rescale(8).equals(row.cost)).toBe(true);
    }
  });

  it('weights by quantity, not equally', () => {
    const rows = spreadCostAcrossTakes(
      [
        { layerId: 'big', quantity: D('9') },
        { layerId: 'small', quantity: D('1') },
      ],
      D('10.00'),
      'USD',
    );
    expect(rows[0]!.cost.toString()).toBe(D('9').rescale(8).toString());
    expect(rows[1]!.cost.toString()).toBe(D('1').rescale(8).toString());
  });

  it('a zero-cost issue still writes one zero row per layer touched', () => {
    // Stock genuinely received at zero cost consumes at zero; the breakdown
    // must still name the layers or exit criterion 3 has holes in it.
    const rows = spreadCostAcrossTakes([{ layerId: 'a', quantity: D('5') }], D('0'), 'USD');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cost.isZero()).toBe(true);
  });
});

describe('movementValue', () => {
  it('rounds once at the minor unit', () => {
    // 3 × 3.333333 = 9.999999 → 10.00, not 9.99 (truncation) and not 9.999999
    // (a value the GL cannot hold).
    expect(movementValue(D('3'), D('3.333333'), 'USD').toString()).toBe(
      D('10.00').rescale(8).toString(),
    );
  });
});

describe('mirrorMovement', () => {
  const inbound = {
    item_id: 'item-1',
    from_location_id: null,
    to_location_id: 'loc-1',
    quantity: '5',
    uom: 'EA',
    stock_lot_id: 'lot-1',
    serial_unit_id: null,
  };

  it('negates quantity and swaps locations so direction stays valid', () => {
    const mirrored = mirrorMovement(inbound);
    expect(mirrored.quantity.isNegative()).toBe(true);
    // The 0012 CHECK: an outbound movement must have a from_location. The
    // mirror of an inbound gets it from the original's destination.
    expect(mirrored.fromLocationId).toBe('loc-1');
    expect(mirrored.toLocationId).toBeNull();
  });

  it('nets to zero against the original', () => {
    const mirrored = mirrorMovement(inbound);
    expect(mirrored.quantity.add(D(inbound.quantity)).isZero()).toBe(true);
  });
});

describe('resolveNegativeStockPolicy', () => {
  it('the entity override wins over the item', () => {
    expect(resolveNegativeStockPolicy('BLOCK', 'ALLOW_PROVISIONAL')).toBe('ALLOW_PROVISIONAL');
  });
  it('an unset override falls back to the item, never to a permissive default', () => {
    expect(resolveNegativeStockPolicy('BLOCK', null)).toBe('BLOCK');
    expect(resolveNegativeStockPolicy('BLOCK', undefined)).toBe('BLOCK');
  });
});
