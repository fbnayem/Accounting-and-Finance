import { Pool } from 'pg';
import { DeterministicRandom } from '../random';
import { SeedProfile } from '../profiles';
import { Foundation, SeededEntity } from './foundation';

/**
 * Bulk-seeds contacts, invoices and vendor bills — the subject of the two aging
 * workloads ADR-0009 declared and Phase 2 could not measure.
 *
 * This exists because of F-730. The aging workloads shipped with Phase 3 and
 * reported `pass` at 1.2ms against a 2,000ms target, which looked like a very
 * fast query and was in fact a query over two empty tables. `profiles.ts` had
 * declared 2,000 invoices for `small` and 50,000 for `reference` since Phase 0,
 * with a comment saying they would be seeded "once the phase that owns those
 * tables exists". It does now.
 *
 * Two properties matter more than the row count:
 *
 * 1. **The status mix is real.** The aging query filters
 *    `status IN ('POSTED','PARTIALLY_PAID') AND amount_due > 0`. If every seeded
 *    row matched, the plan would be a sequential scan over everything and the
 *    measurement would say nothing about the filter. Roughly a third of the rows
 *    are DRAFT, PAID or VOID and must be excluded.
 * 2. **The due dates span every bucket.** Aging is five `FILTER` aggregates over
 *    `days_overdue`. Dates clustered in one bucket would leave four of them
 *    summing nothing, and a benchmark that never exercises four-fifths of its
 *    query is measuring the fifth.
 *
 * Written straight to the tables rather than through `ArService`/`ApService`:
 * those post to the ledger, and 50,000 posted invoices would seed 50,000 journals
 * that the profile's `journalLines` count does not budget for. The trade is
 * stated rather than hidden — this dataset is shaped for *read* measurement, and
 * the correctness of the posting path is asserted by the exit-criteria suite,
 * which drives the real services over HTTP.
 */

const ROWS_PER_TRANSACTION = 1_000;

/** Documents per contact. Aging groups by contact, so this sets the result size. */
const DOCUMENTS_PER_CONTACT = 25;

export interface SubledgerSeedResult {
  readonly customers: number;
  readonly vendors: number;
  readonly invoices: number;
  readonly bills: number;
  readonly openItems: number;
  readonly elapsedMs: number;
}

/**
 * The five aging buckets, as day offsets back from the last period end.
 *
 * `current` is anything not yet due, which the query expresses as
 * `greatest(0, asOf - due_date) = 0` — so a future due date and today's both
 * land there. The rest map one-to-one onto the query's `FILTER` clauses.
 */
const BUCKET_OFFSETS: readonly (readonly [number, number])[] = [
  [-30, 0], // current — due today or later
  [1, 30],
  [31, 60],
  [61, 90],
  [91, 200],
];

export async function seedSubledger(
  pool: Pool,
  profile: SeedProfile,
  foundation: Foundation,
  rng: DeterministicRandom,
  onProgress?: (done: number, total: number) => void,
): Promise<SubledgerSeedResult> {
  const started = Date.now();
  const perEntity = Math.ceil(profile.invoices / foundation.entities.length);
  const contactsPerSide = Math.max(4, Math.ceil(perEntity / DOCUMENTS_PER_CONTACT));

  let customers = 0;
  let vendors = 0;
  let invoices = 0;
  let bills = 0;
  let done = 0;
  const total = profile.invoices * 2;

  for (const entity of foundation.entities) {
    const customerIds = await seedContacts(
      pool,
      foundation,
      entity,
      rng,
      contactsPerSide,
      'CUSTOMER',
    );
    const vendorIds = await seedContacts(pool, foundation, entity, rng, contactsPerSide, 'VENDOR');
    customers += customerIds.length;
    vendors += vendorIds.length;

    for (const [side, contactIds] of [
      ['AR', customerIds],
      ['AP', vendorIds],
    ] as const) {
      let remaining = perEntity;
      let sequence = 1;
      while (remaining > 0) {
        const batch = Math.min(ROWS_PER_TRANSACTION, remaining);
        await writeDocuments(pool, foundation, entity, rng, side, contactIds, batch, sequence);
        if (side === 'AR') invoices += batch;
        else bills += batch;
        sequence += batch;
        remaining -= batch;
        done += batch;
        onProgress?.(done, total);
      }
    }
  }

  // What the benchmark will actually read. Reported rather than assumed: a seed
  // that produced 50,000 rows and no open items would look successful and leave
  // the workload measuring nothing, which is the failure this file exists to fix.
  const { rows } = await pool.query<{ open: string }>(
    `SELECT (
       (SELECT count(*) FROM invoices
         WHERE status IN ('POSTED','PARTIALLY_PAID') AND amount_due > 0) +
       (SELECT count(*) FROM vendor_bills
         WHERE status IN ('POSTED','PARTIALLY_PAID') AND amount_due > 0)
     )::text AS open`,
  );

  return {
    customers,
    vendors,
    invoices,
    bills,
    openItems: Number(rows[0]?.open ?? 0),
    elapsedMs: Date.now() - started,
  };
}

async function seedContacts(
  pool: Pool,
  foundation: Foundation,
  entity: SeededEntity,
  rng: DeterministicRandom,
  count: number,
  kind: 'CUSTOMER' | 'VENDOR',
): Promise<string[]> {
  const prefix = kind === 'CUSTOMER' ? 'C' : 'V';
  const ids: string[] = [];
  const values: unknown[] = [];
  const rows: string[] = [];

  for (let i = 0; i < count; i++) {
    const id = rng.uuidv7(Date.parse(`${entity.periods[0]!.from}T00:00:00Z`) + i);
    ids.push(id);
    const b = values.length;
    rows.push(
      `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},` +
        `false,'ACTIVE','{}'::jsonb,1)`,
    );
    values.push(
      id,
      foundation.tenantId,
      foundation.organizationId,
      entity.id,
      kind,
      `${entity.code}-${prefix}${String(i + 1).padStart(6, '0')}`,
      `${kind === 'CUSTOMER' ? 'Customer' : 'Supplier'} ${String(i + 1).padStart(6, '0')}`,
    );
  }

  await pool.query(
    `INSERT INTO contacts
       (id, tenant_id, organization_id, legal_entity_id, kind, code, legal_name,
        portal_enabled, status, settings, version)
     VALUES ${rows.join(',')}`,
    values,
  );
  return ids;
}

async function writeDocuments(
  pool: Pool,
  foundation: Foundation,
  entity: SeededEntity,
  rng: DeterministicRandom,
  side: 'AR' | 'AP',
  contactIds: readonly string[],
  count: number,
  startSequence: number,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const values: unknown[] = [];
    const rows: string[] = [];
    const lastPeriodEnd = entity.periods[entity.periods.length - 1]!.to;

    for (let i = 0; i < count; i++) {
      const n = startSequence + i;
      const period = rng.pick(entity.periods);
      const postingDate = shiftDate(period.from, rng.int(0, 27), period.to);
      const [minAge, maxAge] = BUCKET_OFFSETS[n % BUCKET_OFFSETS.length]!;
      const dueDate = addDays(lastPeriodEnd, -rng.int(minAge, maxAge));
      const id = rng.uuidv7(Date.parse(`${postingDate}T00:00:00Z`) + i);

      // Every fifth document is settled or not yet a receivable, so the aging
      // filter discriminates. Without this the WHERE clause is a formality.
      const disposition = n % 5;
      const status =
        disposition === 0
          ? 'DRAFT'
          : disposition === 1
            ? 'PAID'
            : rng.bool(0.3)
              ? 'PARTIALLY_PAID'
              : 'POSTED';

      const subtotal = rng.amount(50, 9_000);
      const tax = twoPlaces(Number(subtotal) * 0.1);
      const total = add(subtotal, tax);
      const paid = status === 'PAID' ? total : status === 'PARTIALLY_PAID' ? half(total) : '0.00';
      const due = subtract(total, paid);

      // 18 parameters per row in the same order for both sides, so the two column
      // lists below are the only thing that differs between an invoice and a bill.
      const b = values.length;
      const p = (k: number) => `$${b + k}`;
      const bound = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(p).join(',');
      rows.push(
        side === 'AR'
          ? `(${bound},${p(11)},${p(12)}::document_status,'NOT_REQUIRED',` +
              `${p(13)},'0','0',${p(14)},${p(15)},${p(16)},${p(17)},${p(18)},'0','0',1,'{}'::jsonb)`
          : `(${bound},${p(11)},${p(12)}::document_status,'NOT_REQUIRED','UNMATCHED',` +
              `${p(13)},${p(14)},'0',${p(15)},${p(16)},${p(17)},${p(18)},'0',false,1)`,
      );
      values.push(
        id,
        foundation.tenantId,
        entity.id,
        entity.bookId,
        entity.branchId,
        rng.pick(contactIds),
        side === 'AR'
          ? status === 'DRAFT'
            ? null // invoices_posted_has_number: only a posted invoice carries one
            : `${entity.code}-INV-${String(n).padStart(8, '0')}`
          : `SUP-${String(n).padStart(8, '0')}`,
        postingDate,
        postingDate,
        dueDate,
        entity.baseCurrency,
        status,
        subtotal,
        tax,
        total,
        total, // base_total: transaction currency is the book's, so no conversion
        paid,
        due,
      );
    }

    await client.query(
      side === 'AR'
        ? `INSERT INTO invoices
             (id, tenant_id, legal_entity_id, accounting_book_id, branch_id, customer_id,
              invoice_number, document_date, posting_date, due_date, currency, status,
              approval_state, subtotal, discount_total, rounding_adjustment, tax_total,
              total, base_total, amount_paid, amount_due, amount_credited,
              amount_written_off, version, metadata)
           VALUES ${rows.join(',')}`
        : `INSERT INTO vendor_bills
             (id, tenant_id, legal_entity_id, accounting_book_id, branch_id, vendor_id,
              vendor_invoice_number, document_date, posting_date, due_date, currency, status,
              approval_state, match_state, subtotal, tax_total, rounding_adjustment,
              total, base_total, amount_paid, amount_due, amount_credited, on_hold, version)
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
}

/**
 * Exact decimal helpers on minor units.
 *
 * ADR-0006 §1 forbids binary floats for money, and it applies to seed data for a
 * reason that is easy to miss: `amount_due = total - amount_paid - ...` is a
 * database CHECK. A cent of float error does not produce a slightly wrong row,
 * it aborts the transaction.
 */
const units = (v: string): number => Math.round(Number(v) * 100);
const fromUnits = (u: number): string =>
  `${Math.floor(u / 100)}.${String(u % 100).padStart(2, '0')}`;
const twoPlaces = (v: number): string => fromUnits(Math.round(v * 100));
const add = (a: string, b: string): string => fromUnits(units(a) + units(b));
const subtract = (a: string, b: string): string => fromUnits(units(a) - units(b));
const half = (v: string): string => fromUnits(Math.floor(units(v) / 2));

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Adds days without leaving the period — the period FK pins both ends. */
function shiftDate(from: string, days: number, to: string): string {
  const candidate = addDays(from, days);
  return candidate > to ? to : candidate;
}
