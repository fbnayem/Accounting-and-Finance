import { Pool } from 'pg';
import { DeterministicRandom } from '../random';
import { SeedProfile } from '../profiles';
import { Foundation, SeededEntity } from './foundation';
import { POSTABLE_PAIRS } from './chart-of-accounts';

/**
 * Bulk-seeds posted journal entries and lines.
 *
 * Every entry is balanced, because the deferred `journal_entries_balanced`
 * constraint trigger fires at COMMIT and would reject it otherwise. That is worth
 * stating: the seeder cannot produce a corrupt ledger even by accident, so a
 * benchmark dataset is also a correctness assertion.
 *
 * Written as multi-row INSERTs in bounded transactions rather than one giant
 * transaction: 5 M lines in a single transaction would hold every deferred trigger
 * until the end and exhaust memory long before it committed.
 */

const LINES_PER_ENTRY = 4;
const ENTRIES_PER_TRANSACTION = 500;

export interface LedgerSeedResult {
  readonly entries: number;
  readonly lines: number;
  readonly elapsedMs: number;
}

export async function seedLedger(
  pool: Pool,
  profile: SeedProfile,
  foundation: Foundation,
  rng: DeterministicRandom,
  onProgress?: (done: number, total: number) => void,
): Promise<LedgerSeedResult> {
  const started = Date.now();
  const targetLines = profile.journalLines;
  const targetEntries = Math.ceil(targetLines / LINES_PER_ENTRY);
  const perEntity = Math.ceil(targetEntries / foundation.entities.length);

  let entriesWritten = 0;
  let linesWritten = 0;

  for (const entity of foundation.entities) {
    let remaining = Math.min(perEntity, targetEntries - entriesWritten);
    let sequence = 1;

    while (remaining > 0) {
      const batch = Math.min(ENTRIES_PER_TRANSACTION, remaining);
      const written = await writeBatch(pool, foundation, entity, rng, batch, sequence);
      entriesWritten += written.entries;
      linesWritten += written.lines;
      sequence += batch;
      remaining -= batch;
      onProgress?.(linesWritten, targetLines);
    }
  }

  return { entries: entriesWritten, lines: linesWritten, elapsedMs: Date.now() - started };
}

async function writeBatch(
  pool: Pool,
  foundation: Foundation,
  entity: SeededEntity,
  rng: DeterministicRandom,
  count: number,
  startSequence: number,
): Promise<{ entries: number; lines: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const entryValues: unknown[] = [];
    const entryRows: string[] = [];
    const lineValues: unknown[] = [];
    const lineRows: string[] = [];

    for (let i = 0; i < count; i++) {
      const period = rng.pick(entity.periods);
      // A posting date inside the period, so period resolution is unambiguous.
      const dayOffset = rng.int(0, 27);
      const postingDate = shiftDate(period.from, dayOffset, period.to);
      const entryId = rng.uuidv7(Date.parse(`${postingDate}T00:00:00Z`) + i);

      const base = entryValues.length;
      const p = (n: number) => `$${base + n}`;
      entryRows.push(
        `(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},${p(9)},${p(10)},` +
          `${p(11)},${p(12)},${p(13)},'POSTED','NOT_REQUIRED',now(),${p(14)},${p(15)})`,
      );
      entryValues.push(
        entryId,
        foundation.tenantId,
        entity.id,
        entity.bookId,
        entity.generalJournalId,
        period.id,
        entity.branchId,
        `${entity.code}-GJ-${String(startSequence + i).padStart(8, '0')}`,
        postingDate,
        postingDate,
        `Seeded entry ${startSequence + i}`,
        'SEED',
        // F-006: the entry's base currency is the book's, snapshotted at posting.
        entity.baseCurrency,
        foundation.userId, // posted_by
        foundation.userId, // created_by
      );

      // Two balanced debit/credit pairs per entry: four lines, two amounts.
      for (let pair = 0; pair < LINES_PER_ENTRY / 2; pair++) {
        const [debitCode, creditCode] = rng.pick(POSTABLE_PAIRS);
        const amount = rng.amount(1, 25_000);
        const debitAccount = entity.accounts.get(debitCode)!;
        const creditAccount = entity.accounts.get(creditCode)!;

        for (const [lineOffset, accountId, debit, credit] of [
          [pair * 2 + 1, debitAccount, amount, '0'],
          [pair * 2 + 2, creditAccount, '0', amount],
        ] as const) {
          const b = lineValues.length;
          lineRows.push(
            `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},` +
              `$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13},$${b + 14},$${b + 15})`,
          );
          lineValues.push(
            foundation.tenantId,
            entryId,
            entity.id,
            entity.bookId,
            period.id,
            postingDate,
            entity.branchId,
            lineOffset,
            accountId,
            entity.baseCurrency,
            debit,
            credit,
            entity.baseCurrency,
            // Transaction and base currency are the same here, so no conversion
            // and no rounding boundary is crossed — ADR-0006 step 5 is a no-op.
            debit,
            credit,
          );
        }
      }
    }

    await client.query(
      `INSERT INTO journal_entries
         (id, tenant_id, legal_entity_id, accounting_book_id, journal_id, accounting_period_id,
          branch_id, entry_number, posting_date, document_date, description, source_type,
          base_currency, status, approval_state, posted_at, posted_by, created_by)
       VALUES ${entryRows.join(',')}`,
      entryValues,
    );

    // Written complete in one INSERT. An UPDATE pass to fix up the base amounts
    // would be rejected outright: the entries are POSTED, and
    // reject_mutation_of_posted() does not care that the mutation came from a
    // seeder. Getting the values right the first time is the only option — which
    // is exactly the constraint real posting code operates under.
    await client.query(
      `INSERT INTO journal_lines
         (tenant_id, journal_entry_id, legal_entity_id, accounting_book_id, accounting_period_id,
          posting_date, branch_id, line_no, account_id, transaction_currency,
          transaction_debit, transaction_credit, base_currency, base_debit, base_credit)
       VALUES ${lineRows.join(',')}`,
      lineValues,
    );

    // COMMIT is where journal_entries_balanced fires for every entry in the batch.
    await client.query('COMMIT');
    return { entries: count, lines: count * LINES_PER_ENTRY };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Adds days without leaving the period — the FK to the parent entry pins both. */
function shiftDate(from: string, days: number, to: string): string {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  const candidate = d.toISOString().slice(0, 10);
  return candidate > to ? to : candidate;
}
