/**
 * `ledger_account_balances` — the rebuildable projection.
 *
 * Blueprint note 7: "treat all *_balance read models as rebuildable projections,
 * never source of truth." doc 21's Phase 2 exit criterion turns that into a test:
 * "Full ledger read model can be destroyed and rebuilt from posted journal lines
 * with identical balances."
 *
 * The way that criterion is usually failed is not by a wrong rebuild — it is by an
 * incremental update path that computes balances slightly differently from the
 * rebuild, so the two agree until the day they do not. Here there is one
 * computation, `RECOMPUTE`, and both paths run it. The incremental path restricts
 * it to the accounts a posting touched; the rebuild does not restrict it at all.
 * "Identical" is then true by construction, which is exactly why the test that
 * asserts it is still worth having: it proves no second path has appeared.
 */
import { PoolClient } from 'pg';

/**
 * Opening, movement and closing per (book, period, account), from journal lines.
 *
 * Two things in here are easy to get wrong and expensive to discover later:
 *
 *   - REVERSED entries are included. 0006 permits POSTED -> REVERSED on the
 *     original entry, and its lines are never deleted; the reversal is a separate
 *     entry carrying the opposite amounts. Excluding REVERSED would remove one half
 *     of a matched pair and leave every reversed transaction counted once, backwards.
 *   - Periods are ordered by fiscal-year start and then period number, not by date.
 *     Adjustment periods share period 12's end date by design (F-011), so ordering
 *     by date would interleave them arbitrarily with the period they adjust and the
 *     opening balance of period 13 would depend on row order.
 */
const RECOMPUTE = `
  WITH periods AS (
    SELECT p.id, p.period_no, fy.start_date AS fy_start
      FROM accounting_periods p
      JOIN fiscal_years fy ON fy.id = p.fiscal_year_id
     WHERE p.legal_entity_id = $2
  ),
  movements AS (
    SELECT l.accounting_period_id AS period_id, l.account_id,
           sum(l.base_debit)  AS period_debit,
           sum(l.base_credit) AS period_credit
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.journal_entry_id
     WHERE l.accounting_book_id = $3
       AND e.status IN ('POSTED', 'REVERSED')
       AND ($4::uuid[] IS NULL OR l.account_id = ANY($4::uuid[]))
     GROUP BY 1, 2
  ),
  grid AS (
    SELECT a.account_id, p.id AS period_id, p.fy_start, p.period_no
      FROM (SELECT DISTINCT account_id FROM movements) a
      CROSS JOIN periods p
  ),
  rolled AS (
    SELECT g.account_id, g.period_id,
           sum(coalesce(m.period_debit, 0))  OVER w - coalesce(m.period_debit, 0)  AS opening_debit,
           sum(coalesce(m.period_credit, 0)) OVER w - coalesce(m.period_credit, 0) AS opening_credit,
           coalesce(m.period_debit, 0)  AS period_debit,
           coalesce(m.period_credit, 0) AS period_credit,
           sum(coalesce(m.period_debit, 0))  OVER w AS closing_debit,
           sum(coalesce(m.period_credit, 0)) OVER w AS closing_credit
      FROM grid g
      LEFT JOIN movements m ON m.account_id = g.account_id AND m.period_id = g.period_id
    WINDOW w AS (
      PARTITION BY g.account_id ORDER BY g.fy_start, g.period_no ROWS UNBOUNDED PRECEDING
    )
  )
  SELECT $1::uuid AS tenant_id, $3::uuid AS accounting_book_id, r.period_id AS accounting_period_id,
         r.account_id, $2::uuid AS legal_entity_id, $5::char(3) AS base_currency,
         r.opening_debit, r.opening_credit, r.period_debit, r.period_credit,
         r.closing_debit, r.closing_credit
    FROM rolled r
   WHERE r.opening_debit <> 0 OR r.opening_credit <> 0
      OR r.period_debit  <> 0 OR r.period_credit  <> 0
      OR r.closing_debit <> 0 OR r.closing_credit <> 0
`;

const COLUMNS =
  'tenant_id, accounting_book_id, accounting_period_id, account_id, legal_entity_id, ' +
  'base_currency, opening_debit, opening_credit, period_debit, period_credit, ' +
  'closing_debit, closing_credit';

export interface RebuildDifference {
  readonly account_code: string;
  readonly period_name: string;
  readonly column: string;
  readonly before: string;
  readonly after: string;
}

export interface RebuildResult {
  readonly accounting_book_id: string;
  readonly rows_before: number;
  readonly rows_after: number;
  readonly differences: readonly RebuildDifference[];
  readonly identical: boolean;
  readonly duration_ms: number;
}

export class LedgerProjectionService {
  /**
   * Recomputes the projection for the accounts a posting touched.
   *
   * Scoped by account rather than by period, because a posting into an earlier
   * period changes the OPENING balance of every later period for the same account.
   * Refreshing only the posted period would leave the rest of the year silently
   * stale — and stale in a direction that still balances, so nothing would notice.
   */
  async refresh(
    client: PoolClient,
    scope: {
      tenantId: string;
      legalEntityId: string;
      bookId: string;
      accountIds: readonly string[];
    },
  ): Promise<void> {
    if (scope.accountIds.length === 0) return;
    const accountIds = [...new Set(scope.accountIds)];
    const baseCurrency = await this.baseCurrency(client, scope.bookId);

    await client.query(
      `DELETE FROM ledger_account_balances
        WHERE accounting_book_id = $1 AND account_id = ANY($2::uuid[])`,
      [scope.bookId, accountIds],
    );
    await client.query(`INSERT INTO ledger_account_balances (${COLUMNS}) ${RECOMPUTE}`, [
      scope.tenantId,
      scope.legalEntityId,
      scope.bookId,
      accountIds,
      baseCurrency,
    ]);
  }

  /**
   * F-614 — destroy and rebuild, and say whether the result differs.
   *
   * The comparison is the deliverable. A rebuild that silently replaces the table
   * satisfies "can be rebuilt" and proves nothing about "with identical balances";
   * this returns the differences, so an operator running it in production learns
   * whether the projection had drifted rather than erasing the evidence that it had.
   */
  async rebuild(
    client: PoolClient,
    scope: { tenantId: string; legalEntityId: string; bookId: string },
  ): Promise<RebuildResult> {
    const startedAt = process.hrtime.bigint();
    const baseCurrency = await this.baseCurrency(client, scope.bookId);

    await client.query(`
      CREATE TEMP TABLE projection_before ON COMMIT DROP AS
        SELECT * FROM ledger_account_balances WHERE false
    `);
    const { rowCount: before } = await client.query(
      `INSERT INTO projection_before SELECT * FROM ledger_account_balances
        WHERE accounting_book_id = $1`,
      [scope.bookId],
    );

    await client.query(`DELETE FROM ledger_account_balances WHERE accounting_book_id = $1`, [
      scope.bookId,
    ]);
    const { rowCount: after } = await client.query(
      `INSERT INTO ledger_account_balances (${COLUMNS}) ${RECOMPUTE}`,
      [scope.tenantId, scope.legalEntityId, scope.bookId, null, baseCurrency],
    );

    // FULL OUTER JOIN so a row that appeared and a row that vanished are both
    // reported. Comparing only the rows present in both would hide exactly the
    // drift that matters most.
    const { rows: differences } = await client.query<RebuildDifference>(
      `SELECT coalesce(a.code, a2.code) AS account_code,
              coalesce(p.name, p2.name) AS period_name,
              d.metric AS column, d.before_value AS before, d.after_value AS after
         FROM projection_before b
         FULL OUTER JOIN ledger_account_balances n
           ON n.accounting_book_id = b.accounting_book_id
          AND n.accounting_period_id = b.accounting_period_id
          AND n.account_id = b.account_id
         LEFT JOIN accounts a  ON a.id = b.account_id
         LEFT JOIN accounts a2 ON a2.id = n.account_id
         LEFT JOIN accounting_periods p  ON p.id = b.accounting_period_id
         LEFT JOIN accounting_periods p2 ON p2.id = n.accounting_period_id
         CROSS JOIN LATERAL (VALUES
           ('opening_debit',  b.opening_debit::text,  n.opening_debit::text),
           ('opening_credit', b.opening_credit::text, n.opening_credit::text),
           ('period_debit',   b.period_debit::text,   n.period_debit::text),
           ('period_credit',  b.period_credit::text,  n.period_credit::text),
           ('closing_debit',  b.closing_debit::text,  n.closing_debit::text),
           ('closing_credit', b.closing_credit::text, n.closing_credit::text)
         ) AS d(metric, before_value, after_value)
        WHERE (n.accounting_book_id IS NULL OR b.accounting_book_id IS NULL)
           OR d.before_value IS DISTINCT FROM d.after_value
        ORDER BY 1, 2, 3
        LIMIT 200`,
      [],
    );

    return {
      accounting_book_id: scope.bookId,
      rows_before: before ?? 0,
      rows_after: after ?? 0,
      differences,
      identical: differences.length === 0,
      duration_ms: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
    };
  }

  private async baseCurrency(client: PoolClient, bookId: string): Promise<string> {
    const { rows } = await client.query<{ base_currency: string }>(
      `SELECT base_currency FROM accounting_books WHERE id = $1`,
      [bookId],
    );
    const currency = rows[0]?.base_currency;
    if (!currency) throw new Error(`no accounting book ${bookId}`);
    return currency;
  }
}
