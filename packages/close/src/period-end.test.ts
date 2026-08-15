import { describe, expect, it } from 'vitest';
import { recognitionPortion, remainingBalance } from './period-end.service';

/**
 * The schedule arithmetic, exact decimal (ADR-0006 §1).
 *
 * The property that matters: however the per-period portions round, the
 * releases SUM TO THE TOTAL EXACTLY, because the final tranche takes the
 * remainder rather than a thirteenth rounding of the quotient. A prepaid whose
 * twelve amortizations sum to 1199.96 leaves 0.04 on the balance sheet forever,
 * and nothing downstream complains about it — which is why it is proved here
 * rather than discovered in an audit.
 */
describe('recognitionPortion', () => {
  it('splits an even total into equal portions', () => {
    expect(
      recognitionPortion({
        totalAmount: '1200.00',
        recognitionPeriods: 12,
        recognizedTotal: '0',
        recognizedCount: 0,
        minorUnit: 2,
      }),
    ).toBe('100.00');
  });

  it('gives the rounding remainder to the final tranche: 100.00 over 3 is 33.33, 33.33, 33.34', () => {
    const first = recognitionPortion({
      totalAmount: '100.00',
      recognitionPeriods: 3,
      recognizedTotal: '0',
      recognizedCount: 0,
      minorUnit: 2,
    });
    expect(first).toBe('33.33');
    const second = recognitionPortion({
      totalAmount: '100.00',
      recognitionPeriods: 3,
      recognizedTotal: first,
      recognizedCount: 1,
      minorUnit: 2,
    });
    expect(second).toBe('33.33');
    const third = recognitionPortion({
      totalAmount: '100.00',
      recognitionPeriods: 3,
      recognizedTotal: '66.66',
      recognizedCount: 2,
      minorUnit: 2,
    });
    expect(third).toBe('33.34');
  });

  it('sums to the total exactly across every schedule length and awkward total', () => {
    for (const [total, periods] of [
      ['1200.00', 12],
      ['100.00', 3],
      ['0.05', 4],
      ['999.99', 7],
      ['1.00', 12],
    ] as const) {
      let recognizedTotal = '0';
      for (let count = 0; count < periods; count++) {
        const portion = recognitionPortion({
          totalAmount: total,
          recognitionPeriods: periods,
          recognizedTotal,
          recognizedCount: count,
          minorUnit: 2,
        });
        recognizedTotal = addStrings(recognizedTotal, portion);
      }
      expect(remainingBalance(total, recognizedTotal)).toBe('0.00');
    }
  });

  it('respects a zero-decimal currency', () => {
    // 1000 over 3 in a minor-unit-0 currency: 333, 333, 334 — never 333.33.
    expect(
      recognitionPortion({
        totalAmount: '1000',
        recognitionPeriods: 3,
        recognizedTotal: '0',
        recognizedCount: 0,
        minorUnit: 0,
      }),
    ).toBe('333');
    expect(
      recognitionPortion({
        totalAmount: '1000',
        recognitionPeriods: 3,
        recognizedTotal: '666',
        recognizedCount: 2,
        minorUnit: 0,
      }),
    ).toBe('334');
  });

  it('never exceeds what remains, even after an explicit larger release', () => {
    // 11 months were released by hand at 150.00 — more than straight-line — so
    // the computed next portion is the remainder, not the quotient.
    expect(
      recognitionPortion({
        totalAmount: '1200.00',
        recognitionPeriods: 12,
        recognizedTotal: '1150.00',
        recognizedCount: 9,
        minorUnit: 2,
      }),
    ).toBe('50.00');
  });

  it('falls back to the remainder when the straight-line portion rounds to zero', () => {
    // 0.01 over 12 months rounds to 0.00 a month; a schedule of twelve nothings
    // would never finish, so the portion is the remainder instead.
    expect(
      recognitionPortion({
        totalAmount: '0.01',
        recognitionPeriods: 12,
        recognizedTotal: '0',
        recognizedCount: 0,
        minorUnit: 2,
      }),
    ).toBe('0.01');
  });
});

describe('remainingBalance', () => {
  it('is exact decimal subtraction', () => {
    expect(remainingBalance('1200.00', '100.00')).toBe('1100.00');
    expect(remainingBalance('0.30', '0.10')).toBe('0.20'); // 0.3 - 0.1 in floats is not 0.2
  });
});

/** Exact string addition through the same Decimal the production code uses. */
import { D } from '@acct/domain';
function addStrings(a: string, b: string): string {
  return D(a).add(D(b)).toString();
}
