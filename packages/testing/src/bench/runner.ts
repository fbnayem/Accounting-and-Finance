import { Pool } from 'pg';
import {
  WORKLOADS,
  REGRESSION_TOLERANCE,
  REGRESSION_FLOOR_MS,
  type BenchScope,
  type Workload,
} from './workloads';

/**
 * The benchmark harness.
 *
 * ADR-0009 consequences: "Phase 0 must ship the three seed profiles and a
 * benchmark harness before Gate H can be assessed at any phase." This is that
 * harness. The numbers it produces are only meaningful against a stated dataset,
 * which is why every result records the profile it ran against.
 */

export type ResultStatus = 'pass' | 'fail-target' | 'fail-regression' | 'skipped';

export interface WorkloadResult {
  readonly name: string;
  readonly status: ResultStatus;
  readonly targetMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  readonly iterations: number;
  readonly baselineP95Ms?: number;
  readonly regression?: number;
  readonly reason?: string;
}

export interface BenchReport {
  readonly profile: string;
  readonly phase: number;
  readonly ranAt: string;
  readonly results: readonly WorkloadResult[];
  readonly passed: boolean;
}

export interface Baseline {
  readonly profile: string;
  readonly recordedAt: string;
  readonly p95: Record<string, number>;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] as number;
}

async function measure(pool: Pool, workload: Workload, scope: BenchScope): Promise<number[]> {
  // One untimed pass: the first execution pays for plan compilation and a cold
  // buffer cache, and including it would make every p95 a measurement of startup.
  await workload.run(pool, scope);

  const samples: number[] = [];
  for (let i = 0; i < workload.iterations; i++) {
    const started = process.hrtime.bigint();
    await workload.run(pool, scope);
    samples.push(Number(process.hrtime.bigint() - started) / 1_000_000);
  }
  return samples;
}

export async function runBenchmarks(
  pool: Pool,
  scope: BenchScope,
  options: {
    readonly profile: string;
    readonly phase: number;
    readonly baseline?: Baseline | undefined;
    readonly only?: string | undefined;
    readonly onResult?: (r: WorkloadResult) => void;
  },
): Promise<BenchReport> {
  const results: WorkloadResult[] = [];

  for (const workload of WORKLOADS) {
    if (options.only && workload.name !== options.only) continue;

    if (workload.iterations === 0 || workload.availableFromPhase > options.phase) {
      const result: WorkloadResult = {
        name: workload.name,
        status: 'skipped',
        targetMs: workload.targetMs,
        p50Ms: 0,
        p95Ms: 0,
        maxMs: 0,
        iterations: 0,
        reason:
          workload.availableFromPhase > options.phase
            ? `subject arrives in phase ${workload.availableFromPhase}`
            : 'not yet implemented',
      };
      results.push(result);
      options.onResult?.(result);
      continue;
    }

    const samples = (await measure(pool, workload, scope)).sort((a, b) => a - b);
    const p95 = percentile(samples, 95);
    const baselineP95 = options.baseline?.p95[workload.name];
    const regression = baselineP95 && baselineP95 > 0 ? p95 / baselineP95 - 1 : undefined;

    let status: ResultStatus = 'pass';
    let reason: string | undefined;
    if (p95 > workload.targetMs) {
      status = 'fail-target';
      reason = `p95 ${p95.toFixed(1)}ms exceeds the ${workload.targetMs}ms target`;
    } else if (
      regression !== undefined &&
      regression > REGRESSION_TOLERANCE &&
      // A percentage regression on a single-digit-millisecond query is noise, and a
      // gate that fails on noise gets re-run until it is green — which costs the
      // gate its authority on the day it is right. Below the floor the number is
      // still reported; it just does not fail the build on its own.
      p95 >= REGRESSION_FLOOR_MS
    ) {
      status = 'fail-regression';
      reason = `p95 regressed ${(regression * 100).toFixed(1)}% against the stored baseline`;
    } else if (regression !== undefined && regression > REGRESSION_TOLERANCE) {
      reason =
        `p95 regressed ${(regression * 100).toFixed(1)}%, but at ${p95.toFixed(1)}ms that is ` +
        `below the ${REGRESSION_FLOOR_MS}ms floor where a percentage means anything`;
    }

    const result: WorkloadResult = {
      name: workload.name,
      status,
      targetMs: workload.targetMs,
      p50Ms: percentile(samples, 50),
      p95Ms: p95,
      maxMs: samples[samples.length - 1] ?? 0,
      iterations: samples.length,
      ...(baselineP95 !== undefined ? { baselineP95Ms: baselineP95 } : {}),
      ...(regression !== undefined ? { regression } : {}),
      ...(reason ? { reason } : {}),
    };
    results.push(result);
    options.onResult?.(result);
  }

  return {
    profile: options.profile,
    phase: options.phase,
    ranAt: new Date().toISOString(),
    results,
    passed: results.every((r) => r.status === 'pass' || r.status === 'skipped'),
  };
}

export function toBaseline(report: BenchReport): Baseline {
  return {
    profile: report.profile,
    recordedAt: report.ranAt,
    p95: Object.fromEntries(
      report.results
        .filter((r) => r.status !== 'skipped')
        .map((r) => [r.name, Number(r.p95Ms.toFixed(2))]),
    ),
  };
}

/**
 * Finds a scope to benchmark against — the entity with the most journal lines,
 * and one of its middle periods.
 *
 * The middle period matters: the first period of a seeded dataset has no history
 * behind it, so a balance-sheet query over it touches a fraction of the table and
 * reports a number that has nothing to do with production.
 */
export async function resolveBenchScope(pool: Pool): Promise<BenchScope | null> {
  const { rows } = await pool.query<BenchScope & { line_count: string }>(
    `WITH busiest AS (
       SELECT legal_entity_id, accounting_book_id, count(*) AS line_count
         FROM journal_lines
        GROUP BY legal_entity_id, accounting_book_id
        ORDER BY count(*) DESC
        LIMIT 1
     ),
     middle AS (
       SELECT p.id, p.start_date, p.end_date, p.fiscal_year_id,
              row_number() OVER (ORDER BY p.start_date) AS rn,
              count(*)     OVER ()                      AS total
         FROM accounting_periods p
         JOIN busiest b ON b.legal_entity_id = p.legal_entity_id
        WHERE p.is_adjustment = false
     )
     SELECT le.tenant_id                       AS "tenantId",
            b.legal_entity_id                  AS "legalEntityId",
            b.accounting_book_id               AS "accountingBookId",
            m.id                               AS "periodId",
            m.start_date::text                 AS "periodFrom",
            m.end_date::text                   AS "periodTo",
            fy.start_date::text                AS "fiscalYearFrom",
            fy.end_date::text                  AS "fiscalYearTo",
            b.line_count::text                 AS line_count
       FROM busiest b
       JOIN legal_entities le ON le.id = b.legal_entity_id
       JOIN middle m ON m.rn = greatest(1, m.total / 2)
       JOIN fiscal_years fy ON fy.id = m.fiscal_year_id
      LIMIT 1`,
  );
  return rows[0] ?? null;
}
