import { Pool } from 'pg';
import { D, accountingDate, fingerprintTransaction, type AccountingDate } from '@acct/domain';
import { DeterministicRandom } from '../random';
import { SeedProfile } from '../profiles';
import { Foundation, SeededEntity } from './foundation';

/**
 * Bulk-seeds bank accounts, statements and transactions — the subject of the
 * `bank-match-candidates-one-txn` workload ADR-0009 declared and Phases 0–3 could
 * not measure.
 *
 * `profiles.ts` has declared 5,000 bank transactions for `small` and 100,000 for
 * `reference` since Phase 0, with a comment saying they would be seeded "once the
 * phase that owns those tables exists". It does now, and the workload behind them
 * was still `iterations: 0` — reporting "subject arrives in phase 4" against a
 * phase that had arrived. That is F-730's shape in a new place, which is why the
 * seed and the workload land together rather than the workload first.
 *
 * Three properties matter more than the row count:
 *
 * 1. **Roughly a tenth of the lines are genuinely matchable.** Their amount,
 *    counterparty and reference are copied from an open invoice or bill, so the
 *    candidate query's `ORDER BY abs(amount_due - $2)` has a real winner to find
 *    and `scoreCandidate` has something to score above the floor. Seeded noise
 *    alone would measure the query and none of the ranking.
 * 2. **The reconciliation states are mixed.** The unreconciled report and the
 *    match index both filter on `reconciliation_state`; if every row were
 *    UNMATCHED the filter would be a formality and the index unexercised.
 * 3. **The signs are mixed.** Incoming lines look for invoices and outgoing ones
 *    for bills — two different queries in `BankMatchingService.candidates`. A
 *    dataset of only receipts would leave half of it unmeasured.
 *
 * Written straight to the tables rather than through `BankImportService`: the
 * importer parses a file per statement and dedupes per row, which is the right
 * cost to pay for correctness and the wrong one to pay 100,000 times for a
 * dataset shaped for *read* measurement. The importer's own behaviour is proved
 * by the exit-criteria suite, which drives it over HTTP.
 */

const ROWS_PER_TRANSACTION = 1_000;

/** How many open documents to draw matchable lines from, per entity and side. */
const MATCH_POOL = 500;

/** Share of seeded lines that mirror a real open document. */
const MATCHABLE_SHARE = 0.1;

/** doc 06's states, weighted so the filters and the match index discriminate. */
const STATES: readonly (readonly [string, number])[] = [
  ['UNMATCHED', 0.7],
  ['MATCHED', 0.15],
  ['RECONCILED', 0.1],
  ['IGNORED', 0.05],
];

/** Counterparties for the lines that are not mirroring a document. */
const NOISE = [
  'CARD ACQUIRER FEES',
  'PAYROLL BUREAU',
  'UTILITIES DIRECT DEBIT',
  'OFFICE RENT',
  'BANK CHARGES',
  'FX SETTLEMENT',
  'INTEREST RECEIVED',
  'INSURANCE PREMIUM',
] as const;

export interface BankingSeedResult {
  readonly bankAccounts: number;
  readonly statements: number;
  readonly transactions: number;
  /** Lines whose amount mirrors an open document — what the matcher can win on. */
  readonly matchable: number;
  /** Lines the candidate workload can pick a subject from. */
  readonly unmatchedIncoming: number;
  readonly elapsedMs: number;
}

interface OpenDocument {
  readonly reference: string | null;
  readonly amount: string;
  readonly counterparty: string;
}

export async function seedBanking(
  pool: Pool,
  profile: SeedProfile,
  foundation: Foundation,
  rng: DeterministicRandom,
  onProgress?: (done: number, total: number) => void,
): Promise<BankingSeedResult> {
  const started = Date.now();
  const perEntity = Math.ceil(profile.bankTransactions / foundation.entities.length);

  let bankAccounts = 0;
  let statements = 0;
  let transactions = 0;
  let matchable = 0;
  let done = 0;

  for (const entity of foundation.entities) {
    const account = await seedBankAccount(pool, foundation, entity, rng);
    bankAccounts += 1;
    const statementId = await seedStatement(pool, foundation, entity, account, rng);
    statements += 1;

    const receivables = await openDocuments(pool, entity, 'AR');
    const payables = await openDocuments(pool, entity, 'AP');

    let remaining = perEntity;
    let sequence = 1;
    while (remaining > 0) {
      const batch = Math.min(ROWS_PER_TRANSACTION, remaining);
      matchable += await writeTransactions(
        pool,
        foundation,
        entity,
        account,
        statementId,
        rng,
        receivables,
        payables,
        batch,
        sequence,
      );
      transactions += batch;
      sequence += batch;
      remaining -= batch;
      done += batch;
      onProgress?.(done, profile.bankTransactions);
    }
  }

  // What the workload will actually read, counted rather than assumed — the same
  // reason `seedSubledger` reports its open items. A stage that wrote 100,000
  // rows and left none of them selectable would report success above and leave
  // Gate H measuring nothing.
  const { rows } = await pool.query<{ unmatched: string }>(
    `SELECT count(*)::text AS unmatched FROM bank_transactions
      WHERE reconciliation_state = 'UNMATCHED' AND amount > 0`,
  );

  return {
    bankAccounts,
    statements,
    transactions,
    matchable,
    unmatchedIncoming: Number(rows[0]?.unmatched ?? 0),
    elapsedMs: Date.now() - started,
  };
}

interface SeededBankAccount {
  readonly id: string;
  readonly currency: string;
}

async function seedBankAccount(
  pool: Pool,
  foundation: Foundation,
  entity: SeededEntity,
  rng: DeterministicRandom,
): Promise<SeededBankAccount> {
  // By code rather than from `entity.accounts`: `--only banking` loads the
  // foundation back from the database, and `loadFoundation` returns an empty
  // account map because only the ledger stage needs it.
  const { rows: glRows } = await pool.query<{ id: string }>(
    `SELECT id FROM accounts WHERE legal_entity_id = $1 AND code = '1010'`,
    [entity.id],
  );
  const glAccountId = glRows[0]?.id;
  if (!glAccountId) {
    throw new Error(
      `entity ${entity.code} has no account 1010 (Bank current account) — ` +
        `the chart of accounts is not the one this seeder expects`,
    );
  }

  const id = rng.uuidv7(Date.parse(`${entity.periods[0]!.from}T00:00:00Z`));
  await pool.query(
    `INSERT INTO bank_accounts
       (id, tenant_id, legal_entity_id, account_id, branch_id, kind, name, bank_name,
        masked_account_number, currency, status)
     VALUES ($1,$2,$3,$4,$5,'BANK',$6,'Seed Bank',$7,$8,'ACTIVE')`,
    [
      id,
      foundation.tenantId,
      entity.id,
      glAccountId,
      entity.branchId,
      `${entity.code} current account`,
      `****${String(rng.int(1000, 9999))}`,
      entity.baseCurrency,
    ],
  );
  return { id, currency: entity.baseCurrency };
}

async function seedStatement(
  pool: Pool,
  foundation: Foundation,
  entity: SeededEntity,
  account: SeededBankAccount,
  rng: DeterministicRandom,
): Promise<string> {
  const first = entity.periods[0]!;
  const last = entity.periods[entity.periods.length - 1]!;
  const id = rng.uuidv7(Date.parse(`${first.from}T00:00:00Z`) + 1);
  await pool.query(
    `INSERT INTO bank_statements
       (id, tenant_id, legal_entity_id, bank_account_id, statement_ref, format,
        period_start, period_end, opening_balance, closing_balance, file_hash)
     VALUES ($1,$2,$3,$4,$5,'CSV',$6,$7,'0','0',$8)`,
    [
      id,
      foundation.tenantId,
      entity.id,
      account.id,
      `${entity.code}-SEED-001`,
      first.from,
      last.to,
      // The idempotency key doc 06 requires of a re-import. Deterministic, so a
      // seeded statement collides with itself exactly as a re-imported file does.
      `seed:${entity.code}:${first.from}:${last.to}`,
    ],
  );
  return id;
}

/**
 * The open documents a bank line can plausibly settle.
 *
 * Capped: a matchable line only needs an amount, a name and a reference to copy,
 * and reading 50,000 of them to pick 500 would make the seed slower without
 * making the dataset more realistic.
 */
async function openDocuments(pool: Pool, entity: SeededEntity, side: 'AR' | 'AP') {
  const { rows } =
    side === 'AR'
      ? await pool.query<OpenDocument>(
          `SELECT i.invoice_number AS reference, i.amount_due::text AS amount,
                  c.legal_name AS counterparty
             FROM invoices i JOIN contacts c ON c.id = i.customer_id
            WHERE i.legal_entity_id = $1 AND i.amount_due > 0
              AND i.status IN ('POSTED','PARTIALLY_PAID')
            ORDER BY i.id LIMIT ${MATCH_POOL}`,
          [entity.id],
        )
      : await pool.query<OpenDocument>(
          `SELECT b.vendor_invoice_number AS reference, b.amount_due::text AS amount,
                  c.legal_name AS counterparty
             FROM vendor_bills b JOIN contacts c ON c.id = b.vendor_id
            WHERE b.legal_entity_id = $1 AND b.amount_due > 0
              AND b.status IN ('POSTED','PARTIALLY_PAID')
            ORDER BY b.id LIMIT ${MATCH_POOL}`,
          [entity.id],
        );
  return rows;
}

async function writeTransactions(
  pool: Pool,
  foundation: Foundation,
  entity: SeededEntity,
  account: SeededBankAccount,
  statementId: string,
  rng: DeterministicRandom,
  receivables: readonly OpenDocument[],
  payables: readonly OpenDocument[],
  count: number,
  startSequence: number,
): Promise<number> {
  const client = await pool.connect();
  let matchable = 0;
  try {
    await client.query('BEGIN');

    const values: unknown[] = [];
    const rows: string[] = [];

    for (let i = 0; i < count; i++) {
      const n = startSequence + i;
      const period = rng.pick(entity.periods);
      const transactionDate = shiftDate(period.from, rng.int(0, 27), period.to);
      const incoming = rng.bool(0.55);
      const source = incoming ? receivables : payables;
      const mirrored = source.length > 0 && rng.bool(MATCHABLE_SHARE) ? rng.pick(source) : null;
      if (mirrored) matchable += 1;

      const magnitude = mirrored ? mirrored.amount : rng.amount(20, 9_500);
      const amount = incoming ? magnitude : `-${magnitude}`;
      const counterparty = mirrored ? mirrored.counterparty : rng.pick(NOISE);
      const reference = mirrored ? mirrored.reference : `REF${String(n).padStart(9, '0')}`;
      const description = mirrored
        ? `${incoming ? 'CREDIT TRANSFER' : 'PAYMENT'} ${mirrored.reference ?? ''}`.trim()
        : `${counterparty} ${transactionDate}`;

      // The real fingerprint, not a stand-in. doc 06's fallback dedupe key is a
      // property of the row, and seeding a different one would mean the dataset
      // could not be re-imported over — which is exactly what a re-import test
      // against a seeded database needs to do.
      const fingerprint = fingerprintTransaction({
        bankAccountId: account.id,
        transactionDate,
        amount: D(amount),
        reference,
        description,
        sourceContext: `seed:${entity.code}`,
      });

      const state = pickState(rng);
      const id = rng.uuidv7(Date.parse(`${transactionDate}T00:00:00Z`) + i);

      const b = values.length;
      const p = (k: number) => `$${b + k}`;
      rows.push(
        `(${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(p).join(',')},` +
          `${p(14)}::bank_recon_txn_status,${p(15)})`,
      );
      values.push(
        id,
        foundation.tenantId,
        entity.id,
        account.id,
        statementId,
        // The primary dedupe key (F-028). Unique per account, so the seed
        // exercises `bank_transactions_provider_uq` rather than leaving it idle.
        `SEED-${entity.code}-${String(n).padStart(9, '0')}`,
        transactionDate,
        transactionDate,
        account.currency,
        amount,
        description,
        counterparty,
        reference,
        state,
        fingerprint,
      );
    }

    await client.query(
      `INSERT INTO bank_transactions
         (id, tenant_id, legal_entity_id, bank_account_id, bank_statement_id,
          provider_transaction_id, transaction_date, value_date, currency, amount,
          description, counterparty_name, reference, reconciliation_state, fingerprint)
       VALUES ${rows.join(',')}`,
      values,
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return matchable;
}

function pickState(rng: DeterministicRandom): string {
  const roll = rng.next();
  let cumulative = 0;
  for (const [state, weight] of STATES) {
    cumulative += weight;
    if (roll < cumulative) return state;
  }
  return 'UNMATCHED';
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Adds days without leaving the period, so every line sits in a seeded window. */
function shiftDate(from: string, days: number, to: string): AccountingDate {
  const candidate = addDays(from, days);
  return accountingDate(candidate > to ? to : candidate);
}
