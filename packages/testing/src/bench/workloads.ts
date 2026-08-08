import { Pool } from 'pg';

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
    run: (pool, s) => agingQuery(pool, s, 'AR'),
  },
  {
    name: 'ap-aging-50k-open-items',
    targetMs: 2_000,
    availableFromPhase: 3,
    iterations: 10,
    run: (pool, s) => agingQuery(pool, s, 'AP'),
  },

  // --- declared, not yet measurable ---------------------------------------
  {
    name: 'bank-match-candidates-one-txn',
    targetMs: 500,
    availableFromPhase: 4,
    iterations: 0,
    run: async () => undefined,
  },
  {
    name: 'inventory-valuation-10k-items',
    targetMs: 5_000,
    availableFromPhase: 5,
    iterations: 0,
    run: async () => undefined,
  },
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
