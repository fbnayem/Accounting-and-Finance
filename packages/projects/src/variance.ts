import { D, MONEY_SCALE, sumExact } from '@acct/domain';

/**
 * Budget-versus-actual arithmetic, computed pure.
 *
 * The actual figures are SQL sums over posted `journal_lines` (Phase 5 exit
 * criterion 6: "Budget actuals derive from posted ledger, not duplicated
 * transaction totals") and arrive here as decimal strings. What this module
 * adds is the comparison — exact, and in one place, so `getBudgetVariance` and
 * `getBudgetVsActual` cannot disagree about what a variance is.
 */

export interface VarianceSourceRow {
  readonly account_id: string;
  readonly account_code: string;
  readonly account_name: string;
  readonly accounting_period_id: string;
  readonly period_name: string;
  readonly period_no: number;
  readonly budget_amount: string;
  readonly actual_amount: string;
  /** Present only when the caller asked for the commitment column. */
  readonly open_commitments?: string | undefined;
}

export interface VarianceRow extends VarianceSourceRow {
  /** budget − actual: positive means under budget, negative means over. */
  readonly variance: string;
  /**
   * actual ÷ budget × 100, or null when the budget is zero — spend against a
   * zero budget is infinite consumption, and a made-up percentage would sort
   * and threshold as if it were finite.
   */
  readonly consumed_pct: string | null;
}

export interface VarianceTotals {
  readonly budget_amount: string;
  readonly actual_amount: string;
  readonly variance: string;
  readonly open_commitments: string;
}

export interface PeriodRollup {
  readonly accounting_period_id: string;
  readonly period_name: string;
  readonly period_no: number;
  readonly budget_amount: string;
  readonly actual_amount: string;
  readonly variance: string;
  readonly open_commitments: string;
}

export interface VarianceReport {
  readonly data: readonly VarianceRow[];
  readonly by_period: readonly PeriodRollup[];
  readonly totals: VarianceTotals;
}

export function computeVariance(rows: readonly VarianceSourceRow[]): VarianceReport {
  const data: VarianceRow[] = rows.map((row) => {
    const budget = D(row.budget_amount, MONEY_SCALE);
    const actual = D(row.actual_amount, MONEY_SCALE);
    return {
      ...row,
      budget_amount: budget.toFixed(MONEY_SCALE),
      actual_amount: actual.toFixed(MONEY_SCALE),
      open_commitments: D(row.open_commitments ?? '0', MONEY_SCALE).toFixed(MONEY_SCALE),
      variance: budget.sub(actual).toFixed(MONEY_SCALE),
      consumed_pct: budget.isZero() ? null : actual.div(budget, 6).mul(D('100')).toFixed(2),
    };
  });

  // Grouped in encounter order, which the SQL already sorted by period_no —
  // re-sorting here would silently override the query's ordering contract.
  const byPeriod = new Map<
    string,
    { name: string; no: number; budget: string[]; actual: string[]; commitments: string[] }
  >();
  for (const row of data) {
    const bucket = byPeriod.get(row.accounting_period_id) ?? {
      name: row.period_name,
      no: row.period_no,
      budget: [],
      actual: [],
      commitments: [],
    };
    bucket.budget.push(row.budget_amount);
    bucket.actual.push(row.actual_amount);
    bucket.commitments.push(row.open_commitments ?? '0');
    byPeriod.set(row.accounting_period_id, bucket);
  }

  const sum = (values: readonly string[]) =>
    sumExact(values.map((v) => D(v, MONEY_SCALE))).toFixed(MONEY_SCALE);

  const by_period: PeriodRollup[] = [...byPeriod.entries()].map(([id, bucket]) => {
    const budget = sum(bucket.budget);
    const actual = sum(bucket.actual);
    return {
      accounting_period_id: id,
      period_name: bucket.name,
      period_no: bucket.no,
      budget_amount: budget,
      actual_amount: actual,
      variance: D(budget).sub(D(actual)).toFixed(MONEY_SCALE),
      open_commitments: sum(bucket.commitments),
    };
  });

  const totalBudget = sum(data.map((r) => r.budget_amount));
  const totalActual = sum(data.map((r) => r.actual_amount));
  return {
    data,
    by_period,
    totals: {
      budget_amount: totalBudget,
      actual_amount: totalActual,
      variance: D(totalBudget).sub(D(totalActual)).toFixed(MONEY_SCALE),
      open_commitments: sum(data.map((r) => r.open_commitments ?? '0')),
    },
  };
}
