import { describe, it, expect } from 'vitest';
import { D, Decimal } from './decimal';
import { Money } from './money';
import { currencyPrecision } from './currency';
import {
  roundLineNet,
  roundTaxComponent,
  sumRounded,
  convertToBase,
  assertJournalLineRounded,
  deriveInclusive,
  applyCashRounding,
  residualRoundingAdjustment,
  allocateProportionally,
  RoundingError,
} from './rounding';

const usd = (v: string) => Money.of(v, 'USD');
const jpy = (v: string) => Money.of(v, 'JPY');
const kwd = (v: string) => Money.of(v, 'KWD');

/**
 * ADR-0006 §3 is normative, so these are specification tests, not implementation
 * tests. Each one names the step it pins.
 */
describe('ADR-0006 §3 — the rounding boundary chain', () => {
  it('step 1: line net rounds to the currency minor unit', () => {
    expect(roundLineNet(usd('10.005')).toString()).toBe('10.01000000');
    expect(roundLineNet(usd('10.004')).toString()).toBe('10.00000000');
  });

  it('step 1: minor unit is not always 2', () => {
    expect(roundLineNet(jpy('1234.56')).toString()).toBe('1235.00000000');
    expect(roundLineNet(kwd('1.23456')).toString()).toBe('1.23500000');
  });

  it('steps 3 and 4: a sum of rounded parts is never re-rounded', () => {
    // Three lines that each round up by a hair. Re-rounding the total is the
    // defect the ADR names; the total must equal the sum of what the customer
    // sees on the lines.
    const lines = [usd('10.005'), usd('10.005'), usd('10.005')].map((m) => roundLineNet(m));
    expect(lines.map((l) => l.toString())).toEqual(['10.01000000', '10.01000000', '10.01000000']);
    expect(sumRounded(lines, 'USD').toString()).toBe('30.03000000');
    // Not 30.02 (round(30.015)) and not 30.015 (unrounded).
  });

  it('step 2: tax components round individually, then sum', () => {
    // 7.25% state + 1.5% county on 33.33 — each component rounds separately.
    const net = roundLineNet(usd('33.33'));
    const state = roundTaxComponent(Money.of(net.amount.mul(D('0.0725')), 'USD'));
    const county = roundTaxComponent(Money.of(net.amount.mul(D('0.015')), 'USD'));
    expect(state.toString()).toBe('2.42000000'); // 2.416425 -> 2.42
    expect(county.toString()).toBe('0.50000000'); // 0.49995   -> 0.50
    expect(sumRounded([state, county], 'USD').toString()).toBe('2.92000000');
    // Rounding the combined 8.75% instead would give 2.92 here but not always;
    // the point is that the component amounts are what the tax return reports.
  });

  it('step 5: base conversion rounds once, after the multiplication', () => {
    const line = roundLineNet(usd('100.00'));
    const base = convertToBase(line, D('0.923456789012', 12), currencyPrecision('EUR'));
    expect(base.toString()).toBe('92.35000000');
    expect(base.currency).toBe('EUR');
  });

  it('step 6: a journal line with excess precision is a failure, not a rounding', () => {
    expect(() => assertJournalLineRounded(usd('10.005'))).toThrow(RoundingError);
    expect(assertJournalLineRounded(usd('10.01')).toString()).toBe('10.01000000');
  });
});

describe('ADR-0006 §6 — inclusive tax', () => {
  it('components always re-sum to the stated gross', () => {
    const { net, tax } = deriveInclusive(usd('119.99'), D('0.20'));
    expect(net.toString()).toBe('99.99000000');
    expect(tax.toString()).toBe('20.00000000');
    expect(sumRounded([net, tax], 'USD').toString()).toBe('119.99000000');
  });

  it('holds for an awkward rate where independent rounding would drift', () => {
    for (const gross of ['100.00', '0.01', '33.33', '9999.99', '1.05']) {
      const { net, tax } = deriveInclusive(usd(gross), D('0.175'));
      expect(sumRounded([net, tax], 'USD').toString()).toBe(roundLineNet(usd(gross)).toString());
    }
  });

  it('refuses a -100% rate rather than dividing by zero', () => {
    expect(() => deriveInclusive(usd('100'), D('-1'))).toThrow(RoundingError);
  });
});

describe('ADR-0006 §2 — cash rounding', () => {
  it('rounds CHF to the 0.05 increment and reports the adjustment', () => {
    const r = applyCashRounding(roundLineNet(Money.of('10.13', 'CHF')));
    expect(r.settled.toString()).toBe('10.15000000');
    expect(r.adjustment.toString()).toBe('0.02000000');
  });

  it('is a no-op for a currency without an increment', () => {
    const r = applyCashRounding(roundLineNet(usd('10.13')));
    expect(r.settled.toString()).toBe('10.13000000');
    expect(r.adjustment.isZero()).toBe(true);
  });
});

describe('ADR-0006 §5 — residual adjustments', () => {
  it('accepts a residual attributable to per-line rounding', () => {
    const delta = residualRoundingAdjustment(
      roundLineNet(usd('100.02')),
      roundLineNet(usd('100.00')),
      3,
    );
    expect(delta.toString()).toBe('0.02000000');
  });

  it('refuses to launder an imbalance larger than rounding can explain', () => {
    expect(() =>
      residualRoundingAdjustment(roundLineNet(usd('100.50')), roundLineNet(usd('100.00')), 3),
    ).toThrow(/posting failure, not a rounding adjustment/);
  });
});

describe('proportional allocation', () => {
  it('parts sum exactly to the whole', () => {
    const parts = allocateProportionally(roundLineNet(usd('100.00')), [D('1'), D('1'), D('1')]);
    expect(parts.map((p) => p.toString())).toEqual(['33.34000000', '33.33000000', '33.33000000']);
    expect(sumRounded(parts, 'USD').toString()).toBe('100.00000000');
  });

  it('holds across uneven weights and a zero-decimal currency', () => {
    const parts = allocateProportionally(roundLineNet(jpy('1000')), [D('7'), D('11'), D('13')]);
    expect(sumRounded(parts, 'JPY').toString()).toBe('1000.00000000');
    expect(parts.every((p) => p.amount.rescale(0, 'DOWN').rescale(8).equals(p.amount))).toBe(true);
  });

  it('holds for a large fan-out', () => {
    const weights = Array.from({ length: 97 }, (_, i) => D(String(i + 1)));
    const parts = allocateProportionally(roundLineNet(usd('1234.56')), weights);
    expect(sumRounded(parts, 'USD').toString()).toBe('1234.56000000');
  });
});

describe('rounding modes', () => {
  it('HALF_UP goes away from zero on a tie, in both directions', () => {
    expect(D('2.5').rescale(0, 'HALF_UP').toString()).toBe('3');
    expect(D('-2.5').rescale(0, 'HALF_UP').toString()).toBe('-3');
  });

  it('HALF_EVEN goes to the even neighbour on a tie', () => {
    expect(D('2.5').rescale(0, 'HALF_EVEN').toString()).toBe('2');
    expect(D('3.5').rescale(0, 'HALF_EVEN').toString()).toBe('4');
    expect(D('-2.5').rescale(0, 'HALF_EVEN').toString()).toBe('-2');
  });

  it('FLOOR and CEILING respect sign, DOWN truncates toward zero', () => {
    expect(D('-2.1').rescale(0, 'FLOOR').toString()).toBe('-3');
    expect(D('-2.1').rescale(0, 'CEILING').toString()).toBe('-2');
    expect(D('-2.9').rescale(0, 'DOWN').toString()).toBe('-2');
  });
});

describe('no binary floating point (ADR-0006 §1)', () => {
  it('refuses to build a Decimal from a fractional number', () => {
    expect(() => D(0.1 + 0.2)).toThrow(/refusing to build a Decimal/);
  });

  it('adds the classic float trap exactly', () => {
    expect(D('0.1').add(D('0.2')).toString()).toBe('0.3');
  });

  it('survives amounts far beyond double precision', () => {
    const big = Decimal.parse('99999999999999.99999999');
    expect(big.add(D('0.00000001')).toString()).toBe('100000000000000.00000000');
  });
});
