import { describe, it, expect } from 'vitest';
import { formatAmount, amountAccessibleLabel, formatDebitCredit } from './format';

const usd = { minorUnit: 2 };
const jpy = { minorUnit: 0 };
const kwd = { minorUnit: 3 };

describe('amount formatting', () => {
  it('respects the currency minor unit', () => {
    expect(formatAmount('1234.5', usd)).toBe('1,234.50');
    // JPY has no minor unit, so the fraction is dropped, not rounded to 1,235 —
    // a server that sent 1234.5 for a zero-decimal currency has a bug upstream,
    // and the display must not paper over it by inventing a different number.
    expect(formatAmount('1234.5', jpy)).toBe('1,234');
  });

  it('never rounds a value the server already rounded', () => {
    // Truncation, not rounding: the server applied the ADR-0006 boundary, and
    // rounding again here could move the last digit away from the posted amount.
    expect(formatAmount('1234.567', usd)).toBe('1,234.56');
    expect(formatAmount('1234.999', usd)).toBe('1,234.99');
  });

  it('handles zero-decimal and three-decimal currencies', () => {
    expect(formatAmount('1234', jpy)).toBe('1,234');
    expect(formatAmount('1.2345', kwd)).toBe('1.234');
  });

  it('signals negatives without relying on colour (ADR-0010 §3)', () => {
    expect(formatAmount('-1234.50', usd)).toBe('(1,234.50)');
    expect(formatAmount('-1234.50', { ...usd, negative: 'sign' })).toBe('-1,234.50');
  });

  it('gives a screen reader words rather than punctuation', () => {
    expect(amountAccessibleLabel('-1234.50', 'USD', usd)).toBe('negative 1,234.50 USD');
    expect(amountAccessibleLabel('1234.50', 'USD', usd)).toBe('1,234.50 USD');
  });

  it('survives very large amounts without losing precision', () => {
    expect(formatAmount('99999999999999.99', usd)).toBe('99,999,999,999,999.99');
  });
});

describe('debit/credit columns', () => {
  it('leaves the unused side blank rather than showing zero', () => {
    // F-001 made zero-value lines legal; a grid where every cell reads 0.00 is
    // unreadable, and blank is the accounting convention regardless.
    expect(formatDebitCredit('100.00', '0', usd)).toEqual({ debit: '100.00', credit: '' });
    expect(formatDebitCredit('0.00', '250.00', usd)).toEqual({ debit: '', credit: '250.00' });
    expect(formatDebitCredit('0', '0', usd)).toEqual({ debit: '', credit: '' });
  });
});
