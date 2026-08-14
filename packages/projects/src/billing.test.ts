import { describe, it, expect } from 'vitest';
import { gatherBillableTime, type BillableTimeRow } from './billing';

const entry = (over: Partial<BillableTimeRow> & { id: string }): BillableTimeRow => ({
  hours: '1',
  billing_rate: '100',
  currency: 'USD',
  entry_date: '2026-07-01',
  ...over,
});

describe('gatherBillableTime', () => {
  it('groups by rate and prices each group exactly', () => {
    const g = gatherBillableTime(
      [
        entry({ id: 'a', hours: '1.5', billing_rate: '100' }),
        entry({ id: 'b', hours: '2', billing_rate: '100' }),
        entry({ id: 'c', hours: '1', billing_rate: '80' }),
      ],
      null,
    );
    expect(g.lines).toHaveLength(2);
    const at100 = g.lines.find((l) => l.entryIds.includes('a'))!;
    expect(at100.entryIds).toEqual(['a', 'b']);
    expect(at100.hours).toBe('3.50000000');
    expect(at100.amount).toBe('350.00000000');
    expect(g.totalAmount).toBe('430.00000000');
  });

  it("treats '100' and '100.00' as the same rate, not two lines", () => {
    const g = gatherBillableTime(
      [entry({ id: 'a', billing_rate: '100' }), entry({ id: 'b', billing_rate: '100.00' })],
      null,
    );
    expect(g.lines).toHaveLength(1);
  });

  it('sums hours exactly where binary floating point would not', () => {
    // 0.1 + 0.2 hours at rate 3: parseFloat arithmetic gives 0.9000000000000001.
    const g = gatherBillableTime(
      [
        entry({ id: 'a', hours: '0.1', billing_rate: '3' }),
        entry({ id: 'b', hours: '0.2', billing_rate: '3' }),
      ],
      null,
    );
    expect(g.totalAmount).toBe('0.90000000');
  });

  it('refuses an unpriced entry by name instead of silently under-billing', () => {
    expect(() =>
      gatherBillableTime([entry({ id: 'a' }), entry({ id: 'b', billing_rate: null })], null),
    ).toThrow(/no billing rate/);
  });

  it('refuses mixed currencies rather than inventing a conversion', () => {
    expect(() =>
      gatherBillableTime([entry({ id: 'a' }), entry({ id: 'b', currency: 'EUR' })], null),
    ).toThrow(/one AR invoice carries one currency/);
  });

  it('inherits the project currency, and refuses when there is none to inherit', () => {
    const g = gatherBillableTime([entry({ id: 'a', currency: null })], 'BDT');
    expect(g.currency).toBe('BDT');
    expect(() => gatherBillableTime([entry({ id: 'a', currency: null })], null)).toThrow(
      /not money/,
    );
  });

  it('refuses an empty gather — a proposal for nothing is a caller mistake', () => {
    expect(() => gatherBillableTime([], 'USD')).toThrow(/no approved, billable, unbilled time/);
  });
});
