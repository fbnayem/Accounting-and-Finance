import { Pool } from 'pg';
import {
  D,
  accountingDate,
  scoreCandidate,
  AUTO_MATCH_THRESHOLD,
  CANDIDATE_FLOOR,
} from '@acct/domain';

/**
 * Gate H workloads and their p95 targets — ADR-0009 §2, verbatim.
 *
 * The audit's finding (F-302) was that Gate H "names eight workloads and defines
 * zero targets", and that a gate with no number cannot be failed. Each row below
 * is a number a build can fail against.
 *
 * A workload whose subject arrives in a later phase declares `availableFromPhase`
 * and reports `skipped` rather than silently passing. A benchmark that quietly
 * measures nothing is worse than one that is absent, because it reports green.
 */

export interface Workload {
  readonly name: string;
  /** p95 target in milliseconds, from ADR-0009 §2. */
  readonly targetMs: number;
  readonly availableFromPhase: number;
  readonly iterations: number;
  /**
   * What the workload needs to exist before its number means anything (F-811).
   *
   * F-730 was a benchmark that passed at 1.2ms against a 2,000ms target because
   * it was aggregating two empty tables, and the fix at the time was to make the
   * *seeder* fail when it produced no open items. That guards one route to an
   * empty subject and not the others: a partial seed, a stage that was never run
   * against this database, a `--only` invocation, a table someone truncated.
   * Declaring the subject here moves the check to the gate, which is the only
   * place that knows what it is about to measure.
   */
  readonly subject?: {
    /** Named in the failure, so "no subject" says which rows are missing. */
    readonly describe: string;
    readonly count: (pool: Pool, scope: BenchScope) => Promise<number>;
  };
  readonly run: (pool: Pool, scope: BenchScope) => Promise<unknown>;
}

export interface BenchScope {
  readonly tenantId: string;
  readonly legalEntityId: string;
  readonly accountingBookId: string;
  readonly periodId: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly fiscalYearFrom: string;
  readonly fiscalYearTo: string;
}

export const WORKLOADS: readonly Workload[] = [
  {
    name: 'trial-balance-one-period',
    targetMs: 1_500,
    availableFromPhase: 2,
    iterations: 20,
    run: (pool, s) =>
      pool.query(
        `SELECT a.code, a.name, a.account_type,
                sum(l.base_debit)  AS debit,
                sum(l.base_credit) AS credit
           FROM journal_lines l
           JOIN accounts a ON a.id = l.account_id AND a.legal_entity_id = l.legal_entity_id
           JOIN journal_entries e ON e.id = l.journal_entry_id
          WHERE l.legal_entity_id = $1
            AND l.accounting_book_id = $2
            AND l.accounting_period_id = $3
            AND e.status = 'POSTED'
          GROUP BY a.code, a.name, a.account_type
          ORDER BY a.code`,
        [s.legalEntityId, s.accountingBookId, s.periodId],
      ),
  },
  {
    name: 'profit-and-loss-with-comparatives',
    targetMs: 3_000,
    availableFromPhase: 2,
    iterations: 10,
    run: (pool, s) =>
      pool.query(
        `SELECT a.account_type, a.code,
                sum(l.base_credit - l.base_debit) FILTER (
                  WHERE l.posting_date BETWEEN $2 AND $3) AS current_period,
                sum(l.base_credit - l.base_debit) FILTER (
                  WHERE l.posting_date < $2) AS prior
           FROM journal_lines l
           JOIN accounts a ON a.id = l.account_id AND a.legal_entity_id = l.legal_entity_id
          WHERE l.legal_entity_id = $1
            AND a.account_type IN ('REVENUE','EXPENSE')
          GROUP BY a.account_type, a.code
          ORDER BY a.code`,
        [s.legalEntityId, s.fiscalYearFrom, s.fiscalYearTo],
      ),
  },
  {
    name: 'balance-sheet-one-period',
    targetMs: 1_500,
    availableFromPhase: 2,
    iterations: 10,
    run: (pool, s) =>
      pool.query(
        `SELECT a.account_type, a.code,
                sum(l.base_debit - l.base_credit) AS balance
           FROM journal_lines l
           JOIN accounts a ON a.id = l.account_id AND a.legal_entity_id = l.legal_entity_id
          WHERE l.legal_entity_id = $1
            AND a.account_type IN ('ASSET','LIABILITY','EQUITY')
            AND l.posting_date <= $2
          GROUP BY a.account_type, a.code
          ORDER BY a.code`,
        [s.legalEntityId, s.periodTo],
      ),
  },
  {
    name: 'general-ledger-account-drilldown',
    targetMs: 1_500,
    availableFromPhase: 2,
    iterations: 20,
    run: (pool, s) =>
      pool.query(
        `SELECT l.posting_date, l.line_no, l.description, l.base_debit, l.base_credit
           FROM journal_lines l
          WHERE l.legal_entity_id = $1
            AND l.accounting_book_id = $2
            AND l.posting_date BETWEEN $3 AND $4
          ORDER BY l.posting_date, l.journal_entry_id, l.line_no
          LIMIT 50`,
        [s.legalEntityId, s.accountingBookId, s.periodFrom, s.periodTo],
      ),
  },
  {
    name: 'api-list-cursor-page-50',
    targetMs: 300,
    availableFromPhase: 2,
    iterations: 50,
    run: (pool, s) =>
      pool.query(
        `SELECT id, entry_number, posting_date, description
           FROM journal_entries
          WHERE legal_entity_id = $1 AND accounting_book_id = $2
          ORDER BY posting_date DESC, id DESC
          LIMIT 51`,
        [s.legalEntityId, s.accountingBookId],
      ),
  },
  {
    name: 'period-resolution',
    targetMs: 50,
    availableFromPhase: 2,
    iterations: 100,
    run: (pool, s) =>
      pool.query(
        // F-403 / ADR-0003 §7: resolve to the NON-adjustment period containing
        // the posting date. On the hot path of every post.
        `SELECT id FROM accounting_periods
          WHERE legal_entity_id = $1 AND is_adjustment = false
            AND $2::date BETWEEN start_date AND end_date`,
        [s.legalEntityId, s.periodFrom],
      ),
  },

  /**
   * The write path. Phase 2 made it measurable.
   *
   * A real posting, not a proxy: one entry, ten lines, and the deferred balance
   * trigger. It writes and then rolls back, which is the only way to run it twenty
   * times against the same seed without either inflating the ledger or measuring a
   * different-sized ledger on each iteration. The rollback does not undo the work —
   * the trigger has fired and the index pages have been touched by the time it runs.
   */
  {
    name: 'single-journal-post-10-lines',
    targetMs: 150,
    availableFromPhase: 2,
    iterations: 20,
    subject: {
      describe: 'active posting accounts and a journal on the benchmark book',
      count: async (pool, s) => {
        const { rows } = await pool.query<{ n: string }>(
          `SELECT least(
                    (SELECT count(*) FROM accounts
                      WHERE legal_entity_id = $1 AND is_posting AND status = 'ACTIVE'),
                    (SELECT count(*) FROM journals WHERE accounting_book_id = $2)
                  )::text AS n`,
          [s.legalEntityId, s.accountingBookId],
        );
        return Number(rows[0]?.n ?? 0);
      },
    },
    run: async (pool, s) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: accounts } = await client.query<{ id: string }>(
          `SELECT id FROM accounts
            WHERE legal_entity_id = $1 AND is_posting AND status = 'ACTIVE' LIMIT 10`,
          [s.legalEntityId],
        );
        const { rows: journals } = await client.query<{ id: string }>(
          `SELECT id FROM journals WHERE accounting_book_id = $1 LIMIT 1`,
          [s.accountingBookId],
        );
        if (accounts.length === 0 || journals.length === 0) return undefined;

        const { rows: entry } = await client.query<{ id: string }>(
          `INSERT INTO journal_entries (tenant_id, legal_entity_id, accounting_book_id, journal_id,
                                        accounting_period_id, entry_number, posting_date,
                                        source_type, base_currency, status, posted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::date,'BENCH','USD','POSTED',now())
           RETURNING id`,
          [
            s.tenantId,
            s.legalEntityId,
            s.accountingBookId,
            journals[0]!.id,
            s.periodId,
            `BENCH-${s.periodFrom}`,
            s.periodFrom,
          ],
        );

        // Five debits and five credits of the same amount, so the deferred balance
        // assertion has something to succeed at rather than something to skip.
        for (let i = 0; i < 10; i++) {
          const debit = i < 5 ? '100.00' : '0';
          const credit = i < 5 ? '0' : '100.00';
          await client.query(
            `INSERT INTO journal_lines (tenant_id, journal_entry_id, legal_entity_id,
                                        accounting_book_id, accounting_period_id, posting_date,
                                        line_no, account_id, transaction_currency,
                                        transaction_debit, transaction_credit,
                                        base_currency, base_debit, base_credit)
             VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,'USD',$9,$10,'USD',$9,$10)`,
            [
              s.tenantId,
              entry[0]!.id,
              s.legalEntityId,
              s.accountingBookId,
              s.periodId,
              s.periodFrom,
              i + 1,
              accounts[i % accounts.length]!.id,
              debit,
              credit,
            ],
          );
        }
        // Forces the deferred balance trigger to run HERE rather than at a COMMIT
        // this benchmark never performs. Without it the measurement would exclude
        // the one check the posting path cannot skip.
        await client.query('SET CONSTRAINTS ALL IMMEDIATE');
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      return undefined;
    },
  },

  /**
   * The two aging workloads, measurable from Phase 3.
   *
   * Deliberately the same SQL `SubledgerReportsService.aging` runs, down to the
   * bucket arithmetic — a benchmark that measures a simplified version of the
   * query is measuring a query nobody executes. The one thing it does not share is
   * the permission check, which is not a database cost.
   *
   * `50k open items` is the workload name, not a promise about the seed. It runs
   * against whatever the profile produced, and every result records the profile it
   * ran against — for the same reason the rebuild workload does: a number measured
   * on a small seed is still a number, and an unmeasured target is not.
   */
  {
    name: 'ar-aging-50k-open-items',
    targetMs: 2_000,
    availableFromPhase: 3,
    iterations: 10,
    subject: {
      describe: 'open invoices in the benchmark entity',
      count: (pool, s) => countOpenItems(pool, s, 'AR'),
    },
    run: (pool, s) => agingQuery(pool, s, 'AR'),
  },
  {
    name: 'ap-aging-50k-open-items',
    targetMs: 2_000,
    availableFromPhase: 3,
    iterations: 10,
    subject: {
      describe: 'open vendor bills in the benchmark entity',
      count: (pool, s) => countOpenItems(pool, s, 'AP'),
    },
    run: (pool, s) => agingQuery(pool, s, 'AP'),
  },

  /**
   * doc 06's matching engine, measurable from Phase 4.
   *
   * What `BankMatchingService.candidates` does, in the order it does it: load the
   * transaction by primary key, query the open documents on the side its sign
   * implies, score every row with `@acct/domain`'s weighted model, drop everything
   * below the candidate floor and keep the best ten.
   *
   * The scoring is in the measurement deliberately. Fifty candidates through
   * `scoreCandidate` is real work on the request path — token similarity over two
   * text fields per row — and a benchmark that timed only the SQL would report a
   * number no caller experiences. The 500ms target in ADR-0009 §2 is for the
   * answer, not for the query.
   *
   * The subject is resolved in the harness's untimed warm-up pass and cached, so
   * the timed iterations pay the primary-key lookup the endpoint pays rather than
   * the scan that finds an interesting transaction to use.
   */
  {
    name: 'bank-match-candidates-one-txn',
    targetMs: 500,
    availableFromPhase: 4,
    iterations: 20,
    subject: {
      describe: 'an unmatched incoming bank line with an open invoice of the same amount',
      // Deliberately stricter than "a bank transaction exists". The first version
      // of this asked only for an unmatched incoming line, and the one it found
      // was seeded noise — the query ran, fifty rows were scored, and every one
      // of them fell below the candidate floor. That measures the SQL and none of
      // the ranking, which is the half of this endpoint that ADR-0009's 500ms is
      // mostly about.
      count: async (pool, s) => ((await matchSubjectId(pool, s)) ? 1 : 0),
    },
    run: async (pool, s) => {
      const id = await matchSubjectId(pool, s);
      if (!id) return undefined;

      const { rows: txns } = await pool.query<{
        legal_entity_id: string;
        amount: string;
        currency: string;
        transaction_date: string;
        counterparty_name: string | null;
        reference: string | null;
        description: string | null;
      }>(
        `SELECT legal_entity_id, amount::text AS amount, currency,
                transaction_date::text AS transaction_date,
                counterparty_name, reference, description
           FROM bank_transactions WHERE id = $1`,
        [id],
      );
      const txn = txns[0];
      if (!txn) return undefined;

      const amount = D(txn.amount);
      const incoming = amount.isPositive();
      const { rows: candidates } = incoming
        ? await pool.query(
            `SELECT i.id AS target_id, i.invoice_number AS reference,
                    i.amount_due::text AS amount, i.currency, i.due_date::text AS date,
                    c.legal_name AS counterparty
               FROM invoices i JOIN contacts c ON c.id = i.customer_id
              WHERE i.legal_entity_id = $1 AND i.amount_due > 0
                AND i.status IN ('POSTED','PARTIALLY_PAID')
              ORDER BY abs(i.amount_due - $2::numeric) LIMIT 50`,
            [txn.legal_entity_id, amount.abs().toString()],
          )
        : await pool.query(
            `SELECT b.id AS target_id, b.vendor_invoice_number AS reference,
                    b.amount_due::text AS amount, b.currency, b.due_date::text AS date,
                    c.legal_name AS counterparty
               FROM vendor_bills b JOIN contacts c ON c.id = b.vendor_id
              WHERE b.legal_entity_id = $1 AND b.amount_due > 0
                AND b.status IN ('POSTED','PARTIALLY_PAID')
              ORDER BY abs(b.amount_due - $2::numeric) LIMIT 50`,
            [txn.legal_entity_id, amount.abs().toString()],
          );

      const transaction = {
        amount,
        currency: txn.currency,
        date: accountingDate(txn.transaction_date),
        counterpartyName: txn.counterparty_name,
        reference: [txn.reference, txn.description].filter(Boolean).join(' ') || null,
      };

      return candidates
        .map((r) => {
          const score = scoreCandidate(transaction, {
            amount: D(r.amount as string),
            currency: r.currency as string,
            date: accountingDate(r.date as string),
            counterpartyName: (r.counterparty as string) ?? null,
            reference: (r.reference as string) ?? null,
          });
          return {
            target_id: r.target_id,
            score: score.score,
            auto_matchable: score.exact && score.score >= AUTO_MATCH_THRESHOLD,
          };
        })
        .filter((cand) => cand.score >= CANDIDATE_FLOOR)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
    },
  },

  /**
   * doc 08's acceptance query, measurable from Phase 5: value the on-hand stock
   * by each item's configured method and reconcile the total to the inventory
   * GL control account the items map to.
   *
   * Three real costs in one measurement, deliberately: the layer aggregation
   * (remaining_quantity × unit_cost over the FIFO index's table), the on-hand
   * join through `items` for the valuation method, and the GL side over
   * `journal_lines` restricted to the control accounts in
   * `item_accounting_settings`. The variance column is returned rather than
   * asserted — this workload measures the acceptance query's cost; whether the
   * ledger agrees is the exit-criteria suite's question.
   *
   * The subject is deliberately conjunctive (the bank-match lesson, F-811): an
   * on-hand row alone proves nothing about the layer scan, and open layers
   * alone prove nothing about the stock join. A position must have BOTH before
   * a nonzero count means the measured query has work to do.
   */
  {
    name: 'inventory-valuation-10k-items',
    targetMs: 5_000,
    availableFromPhase: 5,
    iterations: 10,
    subject: {
      describe: 'a stocked on-hand position with open cost layers behind it',
      count: async (pool, s) => {
        const { rows } = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n
             FROM inventory_on_hand h
            WHERE h.legal_entity_id = $1 AND h.quantity > 0
              AND EXISTS (
                SELECT 1 FROM inventory_cost_layers l
                 WHERE l.legal_entity_id = h.legal_entity_id
                   AND l.item_id = h.item_id
                   AND l.warehouse_id = h.warehouse_id
                   AND l.accounting_book_id = $2
                   AND l.remaining_quantity > 0)`,
          [s.legalEntityId, s.accountingBookId],
        );
        return Number(rows[0]?.n ?? 0);
      },
    },
    run: (pool, s) =>
      pool.query(
        `WITH layer_value AS (
           SELECT l.item_id, l.warehouse_id,
                  sum(l.remaining_quantity)               AS quantity,
                  sum(l.remaining_quantity * l.unit_cost) AS value
             FROM inventory_cost_layers l
            WHERE l.legal_entity_id = $1 AND l.accounting_book_id = $2
              AND l.remaining_quantity > 0
            GROUP BY 1, 2
         ),
         valued AS (
           SELECT i.valuation,
                  count(*)                  AS positions,
                  sum(h.quantity)           AS on_hand_quantity,
                  sum(h.value)              AS on_hand_value,
                  sum(coalesce(v.value, 0)) AS layer_value
             FROM inventory_on_hand h
             JOIN items i ON i.id = h.item_id
             LEFT JOIN layer_value v
                    ON v.item_id = h.item_id AND v.warehouse_id = h.warehouse_id
            WHERE h.legal_entity_id = $1 AND h.quantity > 0
            GROUP BY i.valuation
         ),
         gl AS (
           SELECT coalesce(sum(l.base_debit - l.base_credit), 0) AS control_balance
             FROM journal_lines l
            WHERE l.legal_entity_id = $1 AND l.accounting_book_id = $2
              AND l.account_id IN (
                SELECT DISTINCT s.inventory_account_id
                  FROM item_accounting_settings s
                 WHERE s.legal_entity_id = $1 AND s.inventory_account_id IS NOT NULL)
         )
         SELECT v.valuation, v.positions, v.on_hand_quantity, v.on_hand_value,
                v.layer_value, g.control_balance,
                sum(v.on_hand_value) OVER () - g.control_balance AS unreconciled
           FROM valued v CROSS JOIN gl g
          ORDER BY v.valuation`,
        [s.legalEntityId, s.accountingBookId],
      ),
  },

  /**
   * Phase 5 exit criterion 3, as a measured query: "COGS is reproducible from
   * stored cost layers/calculations." The reproduction is a re-sum of
   * `inventory_cost_consumptions` per FIFO issue movement, compared against the
   * `total_cost` the movement posted — the same number by construction when the
   * consumption rows came from `consumeFifo`, which is exactly what the seed
   * guarantees and what a costing-service regression would break.
   *
   * ADR-0009 §2 names no target for this workload (it predates the split of
   * valuation and reproduction into two shapes), so the target and iteration
   * count are the aging workloads' — the same aggregate-join-over-a-subledger
   * size class, measured the same way.
   */
  {
    name: 'inventory-fifo-cogs-reproduction',
    targetMs: 2_000,
    availableFromPhase: 5,
    iterations: 10,
    subject: {
      describe: 'a FIFO issue movement with stored consumption rows to reproduce its COGS from',
      count: async (pool, s) => {
        const { rows } = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n
             FROM inventory_movements m
            WHERE m.legal_entity_id = $1 AND m.quantity < 0 AND m.cost_method = 'FIFO'
              AND EXISTS (
                SELECT 1 FROM inventory_cost_consumptions c
                 WHERE c.inventory_movement_id = m.id)`,
          [s.legalEntityId],
        );
        return Number(rows[0]?.n ?? 0);
      },
    },
    run: (pool, s) =>
      pool.query(
        `WITH reproduced AS (
           SELECT m.id,
                  m.total_cost      AS posted_cost,
                  -m.quantity       AS issued_quantity,
                  sum(c.total_cost) AS layer_cost,
                  sum(c.quantity)   AS layer_quantity
             FROM inventory_movements m
             JOIN inventory_cost_consumptions c
               ON c.inventory_movement_id = m.id AND c.legal_entity_id = m.legal_entity_id
            WHERE m.legal_entity_id = $1 AND m.quantity < 0 AND m.cost_method = 'FIFO'
            GROUP BY m.id, m.total_cost, m.quantity
         )
         SELECT count(*)        AS issues,
                sum(posted_cost) AS total_cogs,
                count(*) FILTER (WHERE layer_cost IS DISTINCT FROM posted_cost
                                    OR layer_quantity <> issued_quantity) AS irreproducible
           FROM reproduced`,
        [s.legalEntityId],
      ),
  },

  // --- declared, not yet measurable ---------------------------------------
  {
    name: 'consolidation-run-5-entities',
    targetMs: 60_000,
    availableFromPhase: 7,
    iterations: 0,
    run: async () => undefined,
  },
  {
    name: 'bulk-import-10k-rows',
    targetMs: 300_000,
    availableFromPhase: 8,
    iterations: 0,
    run: async () => undefined,
  },
  /**
   * ADR-0009: "a full rebuild of 500k lines in under 10 minutes."
   *
   * The same computation `LedgerProjectionService.rebuild` runs, against whatever
   * the seed profile produced — 20k lines on `small`, 500k on `large`. Reported as
   * measured either way, with the profile printed beside it: a rebuild that is fast
   * on 20k and untested on 500k is still a number, and an unmeasured target is not.
   *
   * Rolled back, for the reason given on the posting workload: the benchmark must
   * not change what the next iteration measures.
   */
  {
    name: 'ledger-read-model-rebuild-500k',
    targetMs: 600_000,
    availableFromPhase: 2,
    iterations: 3,
    run: async (pool, s) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM ledger_account_balances WHERE accounting_book_id = $1`, [
          s.accountingBookId,
        ]);
        await client.query(
          `INSERT INTO ledger_account_balances (
             tenant_id, accounting_book_id, accounting_period_id, account_id, legal_entity_id,
             base_currency, opening_debit, opening_credit, period_debit, period_credit,
             closing_debit, closing_credit)
           WITH periods AS (
             SELECT p.id, p.period_no, fy.start_date AS fy_start
               FROM accounting_periods p
               JOIN fiscal_years fy ON fy.id = p.fiscal_year_id
              WHERE p.legal_entity_id = $2
           ),
           movements AS (
             SELECT l.accounting_period_id AS period_id, l.account_id,
                    sum(l.base_debit) AS period_debit, sum(l.base_credit) AS period_credit
               FROM journal_lines l
               JOIN journal_entries e ON e.id = l.journal_entry_id
              WHERE l.accounting_book_id = $3 AND e.status IN ('POSTED', 'REVERSED')
              GROUP BY 1, 2
           ),
           grid AS (
             SELECT a.account_id, p.id AS period_id, p.fy_start, p.period_no
               FROM (SELECT DISTINCT account_id FROM movements) a CROSS JOIN periods p
           ),
           rolled AS (
             SELECT g.account_id, g.period_id,
                    sum(coalesce(m.period_debit, 0))  OVER w - coalesce(m.period_debit, 0)  AS od,
                    sum(coalesce(m.period_credit, 0)) OVER w - coalesce(m.period_credit, 0) AS oc,
                    coalesce(m.period_debit, 0)  AS pd,
                    coalesce(m.period_credit, 0) AS pc,
                    sum(coalesce(m.period_debit, 0))  OVER w AS cd,
                    sum(coalesce(m.period_credit, 0)) OVER w AS cc
               FROM grid g
               LEFT JOIN movements m
                      ON m.account_id = g.account_id AND m.period_id = g.period_id
             WINDOW w AS (
               PARTITION BY g.account_id ORDER BY g.fy_start, g.period_no ROWS UNBOUNDED PRECEDING
             )
           )
           SELECT $1, $3, r.period_id, r.account_id, $2, 'USD',
                  r.od, r.oc, r.pd, r.pc, r.cd, r.cc
             FROM rolled r
            WHERE r.od <> 0 OR r.oc <> 0 OR r.pd <> 0 OR r.pc <> 0 OR r.cd <> 0 OR r.cc <> 0`,
          [s.tenantId, s.legalEntityId, s.accountingBookId],
        );
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      return undefined;
    },
  },
];

/**
 * doc 04's AR Aging and doc 05's AP Aging share a shape, so they share a query.
 *
 * The table and the contact column are interpolated rather than parameterised
 * because PostgreSQL cannot parameterise an identifier; both values come from
 * this module's own `side` union and never from a caller, which is the condition
 * under which that is safe.
 */
function countOpenItems(pool: Pool, scope: BenchScope, side: 'AR' | 'AP'): Promise<number> {
  const table = side === 'AR' ? 'invoices' : 'vendor_bills';
  return pool
    .query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table}
        WHERE legal_entity_id = $1 AND status IN ('POSTED','PARTIALLY_PAID')
          AND amount_due > 0 AND posting_date <= $2::date`,
      [scope.legalEntityId, scope.periodTo],
    )
    .then((r) => Number(r.rows[0]?.n ?? 0));
}

/**
 * The bank transaction the candidate workload ranks against, chosen once.
 *
 * Cached per entity because the choice is not the measurement: the endpoint is
 * given an id and looks it up by primary key, and folding the selection into
 * every iteration would measure the harness. The first call happens in the
 * subject check, before the untimed warm-up pass, so the cache is warm well
 * before the clock starts.
 *
 * Driven from the invoice side rather than with a correlated EXISTS per bank
 * row: this is one hash join over both tables, where the other shape degrades to
 * a scan of the invoices per transaction considered — 100,000 of them on the
 * `reference` profile. Untimed work is still work someone waits for.
 *
 * `ORDER BY b.id` rather than a sample, so two runs of the same profile rank the
 * same transaction against the same invoices — the whole point of a fixed seed.
 */
const matchSubjects = new Map<string, string | null>();

async function matchSubjectId(pool: Pool, scope: BenchScope): Promise<string | null> {
  const cached = matchSubjects.get(scope.legalEntityId);
  if (cached !== undefined) return cached;
  const { rows } = await pool.query<{ id: string }>(
    `SELECT b.id
       FROM invoices i
       JOIN bank_transactions b
         ON b.legal_entity_id = i.legal_entity_id AND b.amount = i.amount_due
      WHERE i.legal_entity_id = $1
        AND i.status IN ('POSTED','PARTIALLY_PAID') AND i.amount_due > 0
        AND b.reconciliation_state = 'UNMATCHED' AND b.amount > 0
      ORDER BY b.id LIMIT 1`,
    [scope.legalEntityId],
  );
  const id = rows[0]?.id ?? null;
  matchSubjects.set(scope.legalEntityId, id);
  return id;
}

function agingQuery(pool: Pool, scope: BenchScope, side: 'AR' | 'AP') {
  const table = side === 'AR' ? 'invoices' : 'vendor_bills';
  const contactColumn = side === 'AR' ? 'customer_id' : 'vendor_id';
  return pool.query(
    `WITH open_items AS (
       SELECT d.${contactColumn} AS contact_id, c.legal_name AS contact_name, d.currency,
              d.amount_due,
              greatest(0, $2::date - d.due_date) AS days_overdue
         FROM ${table} d
         JOIN contacts c ON c.id = d.${contactColumn}
        WHERE d.legal_entity_id = $1
          AND d.status IN ('POSTED','PARTIALLY_PAID')
          AND d.amount_due > 0
          AND d.posting_date <= $2::date
     )
     SELECT contact_id, contact_name, currency,
            sum(amount_due) FILTER (WHERE days_overdue = 0)                          AS current,
            coalesce(sum(amount_due) FILTER (WHERE days_overdue BETWEEN 1 AND 30), 0) AS bucket_1,
            coalesce(sum(amount_due) FILTER (WHERE days_overdue > 30
                                               AND days_overdue <= 60), 0)            AS bucket_2,
            coalesce(sum(amount_due) FILTER (WHERE days_overdue > 60
                                               AND days_overdue <= 90), 0)            AS bucket_3,
            coalesce(sum(amount_due) FILTER (WHERE days_overdue > 90), 0)             AS bucket_4,
            sum(amount_due)                                                           AS total
       FROM open_items
      GROUP BY contact_id, contact_name, currency
      ORDER BY sum(amount_due) DESC`,
    [scope.legalEntityId, scope.periodTo],
  );
}

/** ADR-0009 §2: "A regression beyond 20% fails the build." */
export const REGRESSION_TOLERANCE = 0.2;

/**
 * Below this, a percentage regression is measurement noise.
 *
 * Phase 2 is where this became necessary: several of the Phase 0 read workloads
 * measure 4-7ms against targets of 1500ms, and a 20% tolerance on a 5ms number
 * fires on scheduler jitter. The regression is still printed — it is a fact — but
 * it does not fail the build on its own, because a gate that cries wolf is a gate
 * people learn to re-run. The absolute target still fails at any magnitude.
 */
export const REGRESSION_FLOOR_MS = 25;
