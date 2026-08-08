import { describe, it, expect } from 'vitest';
import { Decimal, D, roundedDiv, MONEY_SCALE } from './decimal';

describe('roundedDiv', () => {
  const cases: Array<[bigint, bigint, Parameters<typeof roundedDiv>[2], bigint]> = [
    // exact halves — the cases that separate the modes
    [5n, 2n, 'HALF_UP', 3n],
    [5n, 2n, 'HALF_DOWN', 2n],
    [5n, 2n, 'HALF_EVEN', 2n],
    [7n, 2n, 'HALF_EVEN', 4n],
    [-5n, 2n, 'HALF_UP', -3n], // half away from zero, not toward +infinity
    [-5n, 2n, 'HALF_DOWN', -2n],
    [-5n, 2n, 'CEILING', -2n],
    [-5n, 2n, 'FLOOR', -3n],
    [5n, 2n, 'CEILING', 3n],
    [5n, 2n, 'FLOOR', 2n],
    [7n, 2n, 'DOWN', 3n],
    [7n, 2n, 'UP', 4n],
    [-7n, 2n, 'DOWN', -3n],
    [-7n, 2n, 'UP', -4n],
    [4n, 2n, 'HALF_UP', 2n], // exact division never increments
  ];
  it.each(cases)('%s / %s (%s) = %s', (n, d, mode, expected) => {
    expect(roundedDiv(n, d, mode)).toBe(expected);
  });

  it('refuses division by zero', () => {
    expect(() => roundedDiv(1n, 0n, 'HALF_UP')).toThrow(/division by zero/);
  });
});

describe('Decimal parsing and formatting', () => {
  it('round-trips a decimal string exactly', () => {
    expect(D('123.45678901', MONEY_SCALE).toString()).toBe('123.45678901');
  });

  it('preserves trailing zeros at the declared scale', () => {
    expect(D('10', MONEY_SCALE).toString()).toBe('10.00000000');
  });

  it('handles negative values below one', () => {
    expect(D('-0.5', 2).toString()).toBe('-0.50');
  });

  it('rejects exponent notation', () => {
    expect(() => D('1e-7')).toThrow(/not a decimal literal/);
  });

  it('rejects a non-integer JavaScript number', () => {
    // The single most common way binary rounding error enters an accounting system.
    expect(() => Decimal.from(0.1)).toThrow(/ADR-0006/);
  });

  it('accepts an integer JavaScript number', () => {
    expect(Decimal.from(42, 2).toString()).toBe('42.00');
  });

  it('does not lose the classic binary-float case', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE 754.
    expect(D('0.1', 8).add(D('0.2', 8)).toString()).toBe('0.30000000');
    expect(D('0.1', 8).add(D('0.2', 8)).equals(D('0.3', 8))).toBe(true);
  });
});

describe('Decimal arithmetic', () => {
  it('multiplies exactly, widening the scale', () => {
    const r = D('1.5', 1).mul(D('2.5', 1));
    expect(r.scale).toBe(2);
    expect(r.toString()).toBe('3.75');
  });

  it('divides to a requested scale', () => {
    expect(D('10', 2).div(D('3', 2), 8).toString()).toBe('3.33333333');
  });

  it('compares across differing scales', () => {
    expect(D('1.50', 2).equals(D('1.5000', 4))).toBe(true);
    expect(D('1.5', 1).lt(D('1.51', 2))).toBe(true);
  });

  it('survives amounts far beyond IEEE 754 integer safety', () => {
    // 9 quadrillion, well past Number.MAX_SAFE_INTEGER, at full money precision.
    const huge = D('9007199254740993.00000001', MONEY_SCALE);
    expect(huge.add(D('0.00000001', MONEY_SCALE)).toString()).toBe('9007199254740993.00000002');
  });
});
