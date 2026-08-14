import { describe, it, expect } from 'vitest';
import { computeVariance, type VarianceSourceRow } from './variance';

const row = (over: Partial<VarianceSourceRow>): VarianceSourceRow => ({
  account_id: 'acct-1',
  account_code: '6000',
  account_name: 'Travel',
  accounting_period_id: 'p1',
  period_name: 'Jul 2026',
  period_no: 7,
  budget_amount: '100',
  actual_amount: '0',
  ...over,
});

describe('computeVariance', () => {
  it('signs variance as budget minus actual: overspend is negative', () => {
    const r = computeVariance([row({ budget_amount: '100', actual_amount: '120' })]);
    expect(r.data[0]!.variance).toBe('-20.00000000');
    expect(r.data[0]!.consumed_pct).toBe('120.00');
  });

  it('reports consumption of a zero budget as null, not a fabricated percentage', () => {
    const r = computeVariance([row({ budget_amount: '0', actual_amount: '50' })]);
    expect(r.data[0]!.consumed_pct).toBeNull();
    expect(r.data[0]!.variance).toBe('-50.00000000');
  });

  it('totals exactly across rows that would drift under floating point', () => {
    const r = computeVariance([
      row({ budget_amount: '0.1', actual_amount: '0.1' }),
      row({ account_id: 'acct-2', budget_amount: '0.2', actual_amount: '0.2' }),
    ]);
    expect(r.totals.budget_amount).toBe('0.30000000');
    expect(r.totals.variance).toBe('0.00000000');
  });

  it('rolls two accounts in one period into one period row', () => {
    const r = computeVariance([
      row({ budget_amount: '100', actual_amount: '40' }),
      row({ account_id: 'acct-2', account_code: '6100', budget_amount: '50', actual_amount: '20' }),
      row({
        accounting_period_id: 'p2',
        period_name: 'Aug 2026',
        period_no: 8,
        budget_amount: '10',
        actual_amount: '0',
      }),
    ]);
    expect(r.by_period).toHaveLength(2);
    expect(r.by_period[0]!.budget_amount).toBe('150.00000000');
    expect(r.by_period[0]!.variance).toBe('90.00000000');
    expect(r.by_period[1]!.period_no).toBe(8);
  });

  it('carries commitments through when present and zero when absent', () => {
    const r = computeVariance([row({ open_commitments: '25' }), row({ account_id: 'acct-2' })]);
    expect(r.totals.open_commitments).toBe('25.00000000');
    expect(r.data[1]!.open_commitments).toBe('0.00000000');
  });
});
