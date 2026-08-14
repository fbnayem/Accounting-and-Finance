import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { runBenchmarks, toBaseline } from './runner';
import type { BenchScope, Workload } from './workloads';

/**
 * The subject check is a control, so it is negative-tested (F-811).
 *
 * F-730 was a green benchmark over two empty tables, and the shape recurred in
 * Phase 4 before the phase had even finished. A gate that can only report success
 * about things it did not measure is worth less than no gate, so the case that
 * matters here is the failing one: a workload that runs perfectly well and has
 * nothing to run against must come back red, not fast.
 */

const SCOPE: BenchScope = {
  tenantId: 't',
  legalEntityId: 'e',
  accountingBookId: 'b',
  periodId: 'p',
  periodFrom: '2024-06-01',
  periodTo: '2024-06-30',
  fiscalYearFrom: '2024-01-01',
  fiscalYearTo: '2024-12-31',
};

// Never touched: every workload below is pure, which is the point — this suite
// tests the harness's decisions, not a database.
const POOL = null as unknown as Pool;

function workload(overrides: Partial<Workload> & Pick<Workload, 'name'>): Workload {
  return {
    targetMs: 1_000,
    availableFromPhase: 0,
    iterations: 2,
    run: async () => undefined,
    ...overrides,
  };
}

describe('Gate H harness', () => {
  it('fails a workload whose subject is absent instead of timing an empty result', async () => {
    const report = await runBenchmarks(POOL, SCOPE, {
      profile: 'small',
      phase: 4,
      workloads: [
        workload({
          name: 'empty',
          subject: { describe: 'open invoices', count: async () => 0 },
        }),
      ],
    });

    expect(report.results[0]?.status).toBe('no-subject');
    expect(report.results[0]?.reason).toContain('open invoices');
    expect(report.results[0]?.p95Ms).toBe(0);
    expect(report.passed).toBe(false);
  });

  it('measures a workload whose subject is present', async () => {
    let runs = 0;
    const report = await runBenchmarks(POOL, SCOPE, {
      profile: 'small',
      phase: 4,
      workloads: [
        workload({
          name: 'populated',
          iterations: 3,
          subject: { describe: 'open invoices', count: async () => 1_200 },
          run: async () => {
            runs++;
          },
        }),
      ],
    });

    expect(report.results[0]?.status).toBe('pass');
    expect(report.results[0]?.iterations).toBe(3);
    // Three timed iterations plus the untimed warm-up the harness always runs.
    expect(runs).toBe(4);
    expect(report.passed).toBe(true);
  });

  it('keeps an absent subject out of the baseline', async () => {
    // Storing a zero would make the workload's next run look like a 100%
    // improvement and every run after that immune to regression.
    const report = await runBenchmarks(POOL, SCOPE, {
      profile: 'small',
      phase: 4,
      workloads: [
        workload({ name: 'empty', subject: { describe: 'rows', count: async () => 0 } }),
        workload({ name: 'later', availableFromPhase: 9 }),
        workload({ name: 'measured' }),
      ],
    });

    expect(Object.keys(toBaseline(report).p95)).toEqual(['measured']);
  });

  it('still fails a workload that beats its subject check but misses its target', async () => {
    const report = await runBenchmarks(POOL, SCOPE, {
      profile: 'small',
      phase: 4,
      workloads: [
        workload({
          name: 'slow',
          targetMs: 0,
          iterations: 1,
          subject: { describe: 'rows', count: async () => 5 },
        }),
      ],
    });

    expect(report.results[0]?.status).toBe('fail-target');
    expect(report.passed).toBe(false);
  });
});
