#!/usr/bin/env node
/**
 *   pnpm bench                          measure and compare against the stored baseline
 *   pnpm bench -- --record              overwrite the baseline (deliberate act)
 *   pnpm bench -- --phase 3             override the phase (defaults to the highest delivered)
 *
 * ADR-0009 §2: p95 against the `reference` profile. A regression beyond 20% fails
 * the build; a regression beyond the absolute target blocks release.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { loadDotenv } from '@acct/config';
import { createPool, repositoryRoot } from '@acct/database';
import { runBenchmarks, resolveBenchScope, toBaseline, type Baseline } from '../bench/runner';

loadDotenv();

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  bold: '\x1b[1m',
};

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

/**
 * The highest delivered phase, read from the one list rather than kept as a copy.
 *
 * A hardcoded default here is the F-729 shape: the gate silently stops measuring
 * the phase that just shipped, and reports "subject arrives in phase N" about a
 * subject that has arrived. `dod:check` reads the same declaration the same way.
 */
function deliveredPhase(root: string): number {
  const source = readFileSync(join(root, 'apps/api/src/common/operation.ts'), 'utf8');
  const match = /export const DELIVERED_PHASES = \[([\d, ]+)\]/.exec(source);
  if (!match) throw new Error('DELIVERED_PHASES not found in apps/api/src/common/operation.ts');
  return Math.max(...match[1]!.split(',').map((n) => Number(n.trim())));
}

async function main(): Promise<number> {
  const profile = arg('profile', 'small')!;
  const root = repositoryRoot();
  const phase = Number(arg('phase', String(deliveredPhase(root))));
  const baselinePath = resolve(join(root, 'bench', 'baselines', `${profile}.json`));

  // DATABASE_URL is the owner (see .env.example). Gate H measures the ledger
  // across every seeded tenant, one of the cross-tenant paths ADR-0002 exempts.
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Run `pnpm stack:up` first.');
    return 78;
  }

  const pool = createPool({
    connectionString: url,
    max: 4,
    applicationName: 'acct-bench',
    statementTimeoutMs: 600_000,
  });

  try {
    const scope = await resolveBenchScope(pool);
    if (!scope) {
      console.error(
        `No seeded ledger found. Run \`pnpm db:seed -- --profile ${profile}\` first — ` +
          `a benchmark against an empty database measures nothing (ADR-0009 §1).`,
      );
      return 1;
    }

    const baseline: Baseline | undefined = existsSync(baselinePath)
      ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline)
      : undefined;

    if (!baseline && !flag('record')) {
      console.log(
        `${c.yellow}no baseline for profile "${profile}"${c.reset} — measuring against absolute ` +
          `targets only. Record one with \`pnpm bench -- --record\`.\n`,
      );
    }

    console.log(
      `${c.bold}Gate H benchmark${c.reset} ${c.dim}profile=${profile} phase=${phase}${c.reset}\n`,
    );
    console.log(
      `  ${'workload'.padEnd(38)} ${'p50'.padStart(9)} ${'p95'.padStart(9)} ${'target'.padStart(9)}  status`,
    );
    console.log(`  ${'-'.repeat(38)} ${'-'.repeat(9)} ${'-'.repeat(9)} ${'-'.repeat(9)}  ------`);

    const report = await runBenchmarks(pool, scope, {
      profile,
      phase,
      baseline,
      only: arg('only'),
      onResult: (r) => {
        const badge =
          r.status === 'pass'
            ? `${c.green}pass${c.reset}`
            : r.status === 'skipped'
              ? `${c.dim}skip${c.reset}`
              : `${c.red}FAIL${c.reset}`;
        const p50 = r.status === 'skipped' ? '-' : `${r.p50Ms.toFixed(1)}ms`;
        const p95 = r.status === 'skipped' ? '-' : `${r.p95Ms.toFixed(1)}ms`;
        console.log(
          `  ${r.name.padEnd(38)} ${p50.padStart(9)} ${p95.padStart(9)} ` +
            `${(r.targetMs + 'ms').padStart(9)}  ${badge}` +
            (r.reason ? ` ${c.dim}${r.reason}${c.reset}` : ''),
        );
      },
    });

    if (flag('record')) {
      mkdirSync(dirname(baselinePath), { recursive: true });
      writeFileSync(baselinePath, `${JSON.stringify(toBaseline(report), null, 2)}\n`, 'utf8');
      console.log(`\nbaseline written: ${baselinePath}`);
      return 0;
    }

    const measured = report.results.filter((r) => r.status !== 'skipped').length;
    const skipped = report.results.length - measured;
    console.log(
      `\n${measured} workload(s) measured, ${skipped} not yet available` +
        `${baseline ? `, compared against a baseline from ${baseline.recordedAt.slice(0, 10)}` : ''}`,
    );

    if (!report.passed) {
      console.error(`\n${c.red}${c.bold}Gate H: FAILED${c.reset}`);
      return 1;
    }
    console.log(`\n${c.green}${c.bold}Gate H: passed${c.reset}`);
    return 0;
  } finally {
    await pool.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
