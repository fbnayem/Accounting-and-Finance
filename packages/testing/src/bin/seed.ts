#!/usr/bin/env node
/**
 *   pnpm db:seed -- --profile small          seed the development database
 *   pnpm db:seed -- --profile reference      the Gate H measurement dataset
 *   pnpm db:seed -- --only banking           add one stage to an existing seed
 *   pnpm db:seed -- --only subledger,banking or several
 *
 * ADR-0009 §1. Deterministic: the same profile always produces the same data, so
 * a baseline recorded on one machine is comparable with a run on another.
 *
 * `--only` exists because a full seed is not re-runnable: the foundation and the
 * ledger mint fixed ids from a fixed stream and collide with themselves on a
 * second run. Without it, adding a stage means destroying the volumes, which is
 * how F-730 stayed invisible — the aging workloads needed 4,000 rows and the only
 * way to get them was to regenerate 20,000 journal lines first.
 *
 * One caveat on determinism: a resumed stage draws from the start of the random
 * stream rather than from wherever a full run would have left it, so `--only`
 * produces the same *shape* as a full seed but not the same values. Row counts and
 * distributions are what a baseline compares against, so this is safe for Gate H;
 * it is not safe to assume an id minted by `--only` matches one from a full run.
 */
import { loadDotenv } from '@acct/config';
import { createPool } from '@acct/database';
import { resolveProfile } from '../profiles';
import { DeterministicRandom } from '../random';
import { seedFoundation, loadFoundation } from '../seed/foundation';
import { seedLedger } from '../seed/ledger';
import { seedSubledger } from '../seed/subledger';
import { seedBanking } from '../seed/banking';
import { seedInventory } from '../seed/inventory';

loadDotenv();

const c = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', bold: '\x1b[1m', red: '\x1b[31m' };

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main(): Promise<number> {
  const profile = resolveProfile(arg('profile', 'small')!);
  // DATABASE_URL is the owner (see .env.example). The seeder writes several
  // tenants in one run, and writes tables the runtime role cannot touch.
  const url = arg('database-url') ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Run `pnpm stack:up` first.');
    return 78;
  }

  const pool = createPool({
    connectionString: url,
    max: 8,
    applicationName: 'acct-seed',
    statementTimeoutMs: 600_000,
    lockTimeoutMs: 30_000,
  });

  const RESUMABLE = ['subledger', 'banking', 'inventory'] as const;
  const only = arg('only');
  const stages = new Set<string>(only ? only.split(',').map((s) => s.trim()) : RESUMABLE);
  for (const stage of stages) {
    if (!RESUMABLE.includes(stage as (typeof RESUMABLE)[number])) {
      console.error(
        `--only takes ${RESUMABLE.map((s) => `"${s}"`).join(' or ')}, comma-separated. ` +
          `The foundation and ledger stages cannot be resumed.`,
      );
      return 64;
    }
  }

  const rng = new DeterministicRandom(profile.seed);
  const started = Date.now();

  try {
    console.log(
      `${c.bold}Seeding profile "${profile.name}"${c.reset} ${c.dim}` +
        (only
          ? `(${only} only, onto the existing foundation)`
          : `(${profile.legalEntities} entit${profile.legalEntities === 1 ? 'y' : 'ies'}, ` +
            `${profile.fiscalYears} fiscal year(s), ${profile.journalLines.toLocaleString()} journal lines)`) +
        c.reset,
    );

    const client = await pool.connect();
    let foundation;
    try {
      await client.query('BEGIN');
      foundation = only ? await loadFoundation(client) : await seedFoundation(client, profile, rng);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    console.log(
      `  ${c.green}ok${c.reset}   foundation: tenant ${foundation.tenantId.slice(0, 8)}, ` +
        `${foundation.entities.length} entit${foundation.entities.length === 1 ? 'y' : 'ies'}, ` +
        // On a resumed run the account map is deliberately empty, so printing its
        // size said "0 accounts" about a healthy tenant and would have said the
        // same about an empty one (F-812). The ledger size is the number that
        // distinguishes them, and it is the number the benchmark ranks by.
        (foundation.ledgerLines === undefined
          ? `${foundation.entities[0]?.accounts.size ?? 0} accounts, `
          : `${foundation.ledgerLines.toLocaleString()} existing journal lines, `) +
        `${foundation.entities[0]?.periods.length ?? 0} periods`,
    );

    let lastReport = 0;
    const ledger = only
      ? { entries: 0, lines: 0, elapsedMs: 0 }
      : await seedLedger(pool, profile, foundation, rng, (done, total) => {
          const pct = Math.floor((done / total) * 100);
          if (pct >= lastReport + 10) {
            lastReport = pct;
            process.stdout.write(
              `\r       ledger: ${pct}% (${done.toLocaleString()} / ${total.toLocaleString()} lines)`,
            );
          }
        });
    process.stdout.write('\r' + ' '.repeat(70) + '\r');
    if (!only) {
      console.log(
        `  ${c.green}ok${c.reset}   ledger: ${ledger.entries.toLocaleString()} entries, ` +
          `${ledger.lines.toLocaleString()} lines in ${(ledger.elapsedMs / 1000).toFixed(1)}s ` +
          `${c.dim}(${Math.round(ledger.lines / (ledger.elapsedMs / 1000)).toLocaleString()} lines/s)${c.reset}`,
      );
    }

    if (stages.has('subledger')) {
      lastReport = 0;
      const subledger = await seedSubledger(pool, profile, foundation, rng, (done, total) => {
        const pct = Math.floor((done / total) * 100);
        if (pct >= lastReport + 20) {
          lastReport = pct;
          process.stdout.write(
            `\r       subledger: ${pct}% (${done.toLocaleString()} / ${total.toLocaleString()} documents)`,
          );
        }
      });
      process.stdout.write('\r' + ' '.repeat(70) + '\r');
      console.log(
        `  ${c.green}ok${c.reset}   subledger: ${subledger.invoices.toLocaleString()} invoices, ` +
          `${subledger.bills.toLocaleString()} bills across ` +
          `${(subledger.customers + subledger.vendors).toLocaleString()} contacts ` +
          `in ${(subledger.elapsedMs / 1000).toFixed(1)}s`,
      );
    }

    if (stages.has('banking')) {
      lastReport = 0;
      const banking = await seedBanking(pool, profile, foundation, rng, (done, total) => {
        const pct = Math.floor((done / total) * 100);
        if (pct >= lastReport + 20) {
          lastReport = pct;
          process.stdout.write(
            `\r       banking: ${pct}% (${done.toLocaleString()} / ${total.toLocaleString()} transactions)`,
          );
        }
      });
      process.stdout.write('\r' + ' '.repeat(70) + '\r');
      console.log(
        `  ${c.green}ok${c.reset}   banking: ${banking.transactions.toLocaleString()} transactions ` +
          `across ${banking.bankAccounts} account(s) and ${banking.statements} statement(s) ` +
          `in ${(banking.elapsedMs / 1000).toFixed(1)}s`,
      );

      // The candidate workload picks an unmatched incoming line and ranks open
      // invoices against it. Both halves are asserted: a dataset with no subject
      // measures nothing, and one where no candidate can win measures the query
      // without measuring the ranking.
      if (banking.unmatchedIncoming === 0) {
        console.error(
          `  ${c.red}FAIL${c.reset} no unmatched incoming bank lines — ` +
            `bank-match-candidates-one-txn would have no subject`,
        );
        return 1;
      }
      if (banking.matchable === 0) {
        console.error(
          `  ${c.red}FAIL${c.reset} no bank line mirrors an open document — ` +
            `every candidate would score below the floor and the ranking would be untested`,
        );
        return 1;
      }
      console.log(
        `  ${c.green}ok${c.reset}   ${banking.unmatchedIncoming.toLocaleString()} unmatched incoming lines, ` +
          `${banking.matchable.toLocaleString()} of them mirroring an open document`,
      );
    }

    if (stages.has('inventory')) {
      lastReport = 0;
      const inventory = await seedInventory(pool, profile, foundation, rng, (done, total) => {
        const pct = Math.floor((done / total) * 100);
        if (pct >= lastReport + 20) {
          lastReport = pct;
          process.stdout.write(
            `\r       inventory: ${pct}% (${done.toLocaleString()} / ${total.toLocaleString()} items)`,
          );
        }
      });
      process.stdout.write('\r' + ' '.repeat(70) + '\r');
      console.log(
        `  ${c.green}ok${c.reset}   inventory: ${inventory.items.toLocaleString()} items, ` +
          `${inventory.documents.toLocaleString()} documents, ` +
          `${inventory.movements.toLocaleString()} movements, ` +
          `${inventory.costLayers.toLocaleString()} cost layers, ` +
          `${inventory.consumptions.toLocaleString()} consumptions ` +
          `in ${(inventory.elapsedMs / 1000).toFixed(1)}s`,
      );

      // Both Gate H inventory subjects, asserted the way banking asserts its
      // two: a dataset with no stocked position measures no valuation, and one
      // with no consumed FIFO issue measures the join and none of the
      // reproduction the exit criterion is about.
      if (inventory.stockedWithLayers === 0) {
        console.error(
          `  ${c.red}FAIL${c.reset} no stocked on-hand position with open cost layers — ` +
            `inventory-valuation-10k-items would have no subject`,
        );
        return 1;
      }
      if (inventory.reproducibleIssues === 0) {
        console.error(
          `  ${c.red}FAIL${c.reset} no FIFO issue carries consumption rows — ` +
            `inventory-fifo-cogs-reproduction would have no subject`,
        );
        return 1;
      }
      console.log(
        `  ${c.green}ok${c.reset}   ${inventory.stockedWithLayers.toLocaleString()} stocked positions ` +
          `with open layers, ${inventory.reproducibleIssues.toLocaleString()} reproducible FIFO issues`,
      );
    }

    // F-730: the number the aging workloads actually read. A seed that wrote
    // every row and left none of them open would report success above and leave
    // Gate H measuring an empty result, which is how the workloads passed at
    // 1.2ms against a 2,000ms target for the whole of Phase 3. Asked of the
    // database rather than of the stage that just ran, so `--only banking` on a
    // subledger-less seed fails here too.
    const { rows: open } = await pool.query<{ open: string }>(
      `SELECT (
         (SELECT count(*) FROM invoices
           WHERE status IN ('POSTED','PARTIALLY_PAID') AND amount_due > 0) +
         (SELECT count(*) FROM vendor_bills
           WHERE status IN ('POSTED','PARTIALLY_PAID') AND amount_due > 0)
       )::text AS open`,
    );
    const openItems = Number(open[0]?.open ?? 0);
    if (openItems === 0) {
      console.error(
        `  ${c.red}FAIL${c.reset} no open AR or AP items — the aging workloads would measure nothing`,
      );
      return 1;
    }
    console.log(
      `  ${c.green}ok${c.reset}   ${openItems.toLocaleString()} open items for the aging workloads`,
    );

    // Every entry passed the deferred balance trigger at COMMIT, but say so
    // explicitly — a seeded dataset that silently drifted would poison every
    // fixture built on it.
    const { rows } = await pool.query<{ unbalanced: string }>(
      `SELECT count(*)::text AS unbalanced FROM (
         SELECT journal_entry_id
           FROM journal_lines
          GROUP BY journal_entry_id
         HAVING sum(base_debit) <> sum(base_credit)
       ) x`,
    );
    const unbalanced = Number(rows[0]?.unbalanced ?? 0);
    if (unbalanced > 0) {
      console.error(
        `  ${c.red}FAIL${c.reset} ${unbalanced} unbalanced entries in the seeded ledger`,
      );
      return 1;
    }
    console.log(`  ${c.green}ok${c.reset}   every seeded entry balances in base currency`);

    // F-731. ADR-0009 §1 promises "a baseline recorded on one run is comparable
    // with the next", and a bulk-loaded table has no planner statistics until
    // autovacuum happens to reach it. Measured: `trial-balance-one-period` runs
    // 22.4ms against a freshly seeded database and 3.8ms against the identical
    // rows once analysed. Every Gate H number recorded before this line existed
    // was therefore measured against whatever statistics that machine had, which
    // is the one thing a fixed seed was supposed to rule out.
    const analyzeStarted = Date.now();
    await pool.query('ANALYZE');
    console.log(
      `  ${c.green}ok${c.reset}   statistics analysed in ${((Date.now() - analyzeStarted) / 1000).toFixed(1)}s ` +
        `${c.dim}(ADR-0009 §1: the plan must not depend on autovacuum timing)${c.reset}`,
    );

    console.log(
      `\n${c.green}${c.bold}Seed complete${c.reset} in ${((Date.now() - started) / 1000).toFixed(1)}s\n`,
    );
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
