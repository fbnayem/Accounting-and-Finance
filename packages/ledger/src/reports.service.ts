/**
 * Trial Balance, General Ledger, Journal Register and account activity.
 *
 * doc 03's acceptance criterion is "Rebuilding trial balance from raw journal lines
 * equals cached balance model", so the Trial Balance takes a `source` parameter and
 * will compute itself either way. That is not a debugging affordance: it is the
 * criterion, callable, and the integration test asserts the two agree rather than
 * asserting that a rebuild ran.
 */
import { Pool, PoolClient } from 'pg';
import { AppError, D, MONEY_SCALE, notFound, accountingEquation } from '@acct/domain';
import { recordAudit } from '@acct/database';
import { readInTenant, writeInTenant } from '@acct/database';
import { assertEntityPermission, type TenantPrincipal } from '@acct/domain';
import { LedgerProjectionService } from './projection.service';

export type BalanceSource = 'projection' | 'journal_lines';

export interface TrialBalanceRow extends Record<string, unknown> {
  account_id: string;
  account_code: string;
  account_name: string;
  account_type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
  normal_balance: 'DEBIT' | 'CREDIT';
  opening_debit: string;
  opening_credit: string;
  period_debit: string;
  period_credit: string;
  closing_debit: string;
  closing_credit: string;
}

export class LedgerReportsService {
  constructor(
    private readonly pool: Pool,
    private readonly projections: LedgerProjectionService,
  ) {}

  // -------------------------------------------------------------------------
  // Trial balance
  // -------------------------------------------------------------------------

  async trialBalance(
    principal: TenantPrincipal,
    input: {
      accountingBookId: string;
      periodFrom?: string | undefined;
      periodTo?: string | undefined;
      source?: BalanceSource | undefined;
      includeZero?: boolean | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const book = await this.book(client, principal, input.accountingBookId);
      assertEntityPermission(principal, 'report.view', book.legal_entity_id);

      const periods = await this.periodWindow(client, book.legal_entity_id, input);
      const source: BalanceSource = input.source ?? 'projection';
      const rows =
        source === 'projection'
          ? await this.trialBalanceFromProjection(client, book.id, periods)
          : await this.trialBalanceFromLines(client, book.id, periods);

      const visible = input.includeZero
        ? rows
        : rows.filter(
            (r) =>
              r.opening_debit !== '0' ||
              r.opening_credit !== '0' ||
              r.period_debit !== '0' ||
              r.period_credit !== '0' ||
              r.closing_debit !== '0' ||
              r.closing_credit !== '0',
          );

      const totals = this.totals(rows);
      const equation = accountingEquation(
        rows.map((r) => ({
          accountType: r.account_type,
          debit: r.closing_debit,
          credit: r.closing_credit,
        })),
      );

      return {
        accounting_book_id: book.id,
        base_currency: book.base_currency,
        source,
        period_from: periods.from,
        period_to: periods.to,
        data: visible,
        totals,
        // Gate E's first criterion, answered rather than implied.
        balances: totals.closing_debit === totals.closing_credit,
        equation,
      };
    });
  }

  private async trialBalanceFromProjection(
    client: PoolClient,
    bookId: string,
    periods: { ids: string[]; from: string | null; to: string | null; firstId: string | null },
  ): Promise<TrialBalanceRow[]> {
    const { rows } = await client.query<TrialBalanceRow>(
      // Opening comes from the FIRST period in the window and closing from the LAST,
      // which is what makes a multi-period trial balance mean what an accountant
      // expects: movement is the sum across the window, not each period's own.
      `SELECT a.id AS account_id, a.code AS account_code, a.name AS account_name,
              a.account_type, a.normal_balance,
              coalesce(sum(b.opening_debit)  FILTER (WHERE b.accounting_period_id = $2), 0)::text
                AS opening_debit,
              coalesce(sum(b.opening_credit) FILTER (WHERE b.accounting_period_id = $2), 0)::text
                AS opening_credit,
              coalesce(sum(b.period_debit), 0)::text  AS period_debit,
              coalesce(sum(b.period_credit), 0)::text AS period_credit,
              coalesce(sum(b.closing_debit)  FILTER (WHERE b.accounting_period_id = $3), 0)::text
                AS closing_debit,
              coalesce(sum(b.closing_credit) FILTER (WHERE b.accounting_period_id = $3), 0)::text
                AS closing_credit
         FROM ledger_account_balances b
         JOIN accounts a ON a.id = b.account_id
        WHERE b.accounting_book_id = $1 AND b.accounting_period_id = ANY($4::uuid[])
        GROUP BY a.id, a.code, a.name, a.account_type, a.normal_balance
        ORDER BY a.code`,
      [bookId, periods.firstId, periods.ids[periods.ids.length - 1] ?? null, periods.ids],
    );
    return rows;
  }

  private async trialBalanceFromLines(
    client: PoolClient,
    bookId: string,
    periods: { ids: string[]; firstOrdinal: number | null },
  ): Promise<TrialBalanceRow[]> {
    const { rows } = await client.query<TrialBalanceRow>(
      // The same figures, derived from journal_lines with no projection involved.
      // Opening is everything before the window; movement is inside it. REVERSED
      // entries count, for the reason in projection.service.ts.
      `WITH ordered AS (
         SELECT p.id, row_number() OVER (ORDER BY fy.start_date, p.period_no) AS ordinal
           FROM accounting_periods p
           JOIN fiscal_years fy ON fy.id = p.fiscal_year_id
          WHERE p.legal_entity_id = (SELECT legal_entity_id FROM accounting_books WHERE id = $1)
       ),
       lines AS (
         SELECT l.account_id, o.ordinal, l.base_debit, l.base_credit
           FROM journal_lines l
           JOIN journal_entries e ON e.id = l.journal_entry_id
           JOIN ordered o ON o.id = l.accounting_period_id
          WHERE l.accounting_book_id = $1 AND e.status IN ('POSTED', 'REVERSED')
       )
       SELECT a.id AS account_id, a.code AS account_code, a.name AS account_name,
              a.account_type, a.normal_balance,
              coalesce(sum(l.base_debit)  FILTER (WHERE l.ordinal < $2), 0)::text AS opening_debit,
              coalesce(sum(l.base_credit) FILTER (WHERE l.ordinal < $2), 0)::text AS opening_credit,
              coalesce(sum(l.base_debit)  FILTER (WHERE l.ordinal >= $2 AND l.ordinal <= $3), 0)::text
                AS period_debit,
              coalesce(sum(l.base_credit) FILTER (WHERE l.ordinal >= $2 AND l.ordinal <= $3), 0)::text
                AS period_credit,
              coalesce(sum(l.base_debit)  FILTER (WHERE l.ordinal <= $3), 0)::text AS closing_debit,
              coalesce(sum(l.base_credit) FILTER (WHERE l.ordinal <= $3), 0)::text AS closing_credit
         FROM lines l
         JOIN accounts a ON a.id = l.account_id
        GROUP BY a.id, a.code, a.name, a.account_type, a.normal_balance
        ORDER BY a.code`,
      [
        bookId,
        periods.firstOrdinal ?? 1,
        (periods.firstOrdinal ?? 1) + Math.max(periods.ids.length - 1, 0),
      ],
    );
    return rows;
  }

  private totals(rows: readonly TrialBalanceRow[]): Record<string, string> {
    const sum = (pick: (r: TrialBalanceRow) => string) =>
      rows
        .reduce((acc, r) => acc.add(D(pick(r), MONEY_SCALE)), D('0', MONEY_SCALE))
        .toFixed(MONEY_SCALE);
    return {
      opening_debit: sum((r) => r.opening_debit),
      opening_credit: sum((r) => r.opening_credit),
      period_debit: sum((r) => r.period_debit),
      period_credit: sum((r) => r.period_credit),
      closing_debit: sum((r) => r.closing_debit),
      closing_credit: sum((r) => r.closing_credit),
    };
  }

  // -------------------------------------------------------------------------
  // General ledger and account activity
  // -------------------------------------------------------------------------

  async generalLedger(
    principal: TenantPrincipal,
    input: {
      accountingBookId: string;
      accountId?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
      limit?: number | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const book = await this.book(client, principal, input.accountingBookId);
      assertEntityPermission(principal, 'report.view', book.legal_entity_id);

      const where = ['l.accounting_book_id = $1', "e.status IN ('POSTED', 'REVERSED')"];
      const params: unknown[] = [book.id];
      if (input.accountId) {
        params.push(input.accountId);
        where.push(`l.account_id = $${params.length}`);
      }
      if (input.from) {
        params.push(input.from);
        where.push(`l.posting_date >= $${params.length}::date`);
      }
      if (input.to) {
        params.push(input.to);
        where.push(`l.posting_date <= $${params.length}::date`);
      }
      params.push(Math.min(input.limit ?? 500, 5000));

      const { rows } = await client.query(
        // The running balance is computed in the database over the same ordering the
        // rows are returned in. Computing it in the client would be wrong the moment
        // the caller paginates.
        // F-728: `journal_entry_id` as well as `entry_number`. The number is what a
        // person reads; the id is what a link needs, and a general ledger row that
        // cannot be followed back to its entry breaks the drill chain at the last
        // hop — which is the hop an auditor actually takes.
        `SELECT l.id, e.id AS journal_entry_id,
                l.posting_date::text AS posting_date, e.entry_number, e.description,
                e.status::text AS entry_status, a.code AS account_code, a.name AS account_name,
                a.account_type, a.normal_balance,
                l.description AS line_description,
                l.base_debit::text AS debit, l.base_credit::text AS credit,
                l.transaction_currency, l.transaction_debit::text AS transaction_debit,
                l.transaction_credit::text AS transaction_credit,
                sum(CASE WHEN a.normal_balance = 'DEBIT'
                         THEN l.base_debit - l.base_credit
                         ELSE l.base_credit - l.base_debit END)
                  OVER (PARTITION BY l.account_id
                        ORDER BY l.posting_date, e.entry_number, l.line_no
                        ROWS UNBOUNDED PRECEDING)::text AS running_balance
           FROM journal_lines l
           JOIN journal_entries e ON e.id = l.journal_entry_id
           JOIN accounts a ON a.id = l.account_id
          WHERE ${where.join(' AND ')}
          ORDER BY a.code, l.posting_date, e.entry_number, l.line_no
          LIMIT $${params.length}`,
        params,
      );
      return { accounting_book_id: book.id, base_currency: book.base_currency, data: rows };
    });
  }

  async accountActivity(
    principal: TenantPrincipal,
    accountId: string,
    input: { periodFrom?: string | undefined; periodTo?: string | undefined },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows: accounts } = await client.query<{
        id: string;
        code: string;
        name: string;
        legal_entity_id: string;
        account_type: string;
        normal_balance: string;
      }>(
        `SELECT id, code, name, legal_entity_id, account_type, normal_balance
           FROM accounts WHERE id = $1 AND tenant_id = $2`,
        [accountId, principal.tenantId],
      );
      const account = accounts[0];
      if (!account) throw notFound('Account', accountId);
      assertEntityPermission(principal, 'ledger.view', account.legal_entity_id);

      const params: unknown[] = [accountId];
      const where = ['b.account_id = $1'];
      if (input.periodFrom) {
        params.push(input.periodFrom);
        where.push(`p.start_date >= $${params.length}::date`);
      }
      if (input.periodTo) {
        params.push(input.periodTo);
        where.push(`p.end_date <= $${params.length}::date`);
      }

      const { rows } = await client.query(
        `SELECT p.id AS accounting_period_id, p.name AS period_name,
                p.start_date::text AS start_date, p.end_date::text AS end_date,
                p.status::text AS period_status, b.accounting_book_id,
                b.opening_debit::text AS opening_debit, b.opening_credit::text AS opening_credit,
                b.period_debit::text AS period_debit, b.period_credit::text AS period_credit,
                b.closing_debit::text AS closing_debit, b.closing_credit::text AS closing_credit,
                (CASE WHEN $${params.length + 1} = 'DEBIT'
                      THEN b.closing_debit - b.closing_credit
                      ELSE b.closing_credit - b.closing_debit END)::text AS closing_balance
           FROM ledger_account_balances b
           JOIN accounting_periods p ON p.id = b.accounting_period_id
           JOIN fiscal_years fy ON fy.id = p.fiscal_year_id
          WHERE ${where.join(' AND ')}
          ORDER BY fy.start_date, p.period_no`,
        [...params, account.normal_balance],
      );
      return { account, data: rows };
    });
  }

  async journalRegister(
    principal: TenantPrincipal,
    input: {
      accountingBookId: string;
      from?: string | undefined;
      to?: string | undefined;
      journalId?: string | undefined;
      limit?: number | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const book = await this.book(client, principal, input.accountingBookId);
      assertEntityPermission(principal, 'report.view', book.legal_entity_id);

      const where = ['e.accounting_book_id = $1', "e.status IN ('POSTED', 'REVERSED')"];
      const params: unknown[] = [book.id];
      if (input.journalId) {
        params.push(input.journalId);
        where.push(`e.journal_id = $${params.length}`);
      }
      if (input.from) {
        params.push(input.from);
        where.push(`e.posting_date >= $${params.length}::date`);
      }
      if (input.to) {
        params.push(input.to);
        where.push(`e.posting_date <= $${params.length}::date`);
      }
      params.push(Math.min(input.limit ?? 200, 2000));

      const { rows } = await client.query(
        `SELECT e.id, e.entry_number, e.posting_date::text AS posting_date,
                e.document_date::text AS document_date, e.description, e.status::text AS status,
                e.source_type, e.source_id, e.reversal_of_id, e.posted_at,
                j.code AS journal_code, j.journal_type, p.name AS period_name,
                u.display_name AS posted_by_name,
                (SELECT coalesce(sum(l.base_debit), 0)::text FROM journal_lines l
                  WHERE l.journal_entry_id = e.id) AS total_debit,
                (SELECT count(*) FROM journal_lines l WHERE l.journal_entry_id = e.id)::int
                  AS line_count
           FROM journal_entries e
           JOIN journals j ON j.id = e.journal_id
           JOIN accounting_periods p ON p.id = e.accounting_period_id
           LEFT JOIN users u ON u.id = e.posted_by
          WHERE ${where.join(' AND ')}
          ORDER BY e.posting_date DESC, e.entry_number DESC
          LIMIT $${params.length}`,
        params,
      );
      return { accounting_book_id: book.id, base_currency: book.base_currency, data: rows };
    });
  }

  // -------------------------------------------------------------------------
  // Projection rebuild (F-614)
  // -------------------------------------------------------------------------

  async rebuildProjections(principal: TenantPrincipal, accountingBookId: string) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const book = await this.book(client, principal, accountingBookId);
      assertEntityPermission(principal, 'ledger.rebuild', book.legal_entity_id);

      const result = await this.projections.rebuild(client, {
        tenantId: principal.tenantId,
        legalEntityId: book.legal_entity_id,
        bookId: book.id,
      });

      await recordAudit(client, context, {
        action: 'ledger.projections_rebuilt',
        resourceType: 'accounting_book',
        resourceId: book.id,
        tenantId: principal.tenantId,
        legalEntityId: book.legal_entity_id,
        after: {
          rows_before: result.rows_before,
          rows_after: result.rows_after,
          identical: result.identical,
          differences: result.differences.length,
          duration_ms: result.duration_ms,
        },
      });
      return result;
    });
  }

  // -------------------------------------------------------------------------

  private async book(
    client: PoolClient,
    principal: TenantPrincipal,
    id: string,
  ): Promise<{ id: string; legal_entity_id: string; base_currency: string }> {
    const { rows } = await client.query<{
      id: string;
      legal_entity_id: string;
      base_currency: string;
    }>(
      `SELECT id, legal_entity_id, base_currency FROM accounting_books
        WHERE id = $1 AND tenant_id = $2`,
      [id, principal.tenantId],
    );
    if (!rows[0]) throw notFound('Accounting book', id);
    return rows[0];
  }

  /**
   * The periods a report covers, as ids and as an ordinal window.
   *
   * Both forms are needed: the projection is keyed by period id, and the
   * journal-line form has to know which periods are "before the window" to compute
   * an opening balance. Deriving them from one query keeps the two answers from
   * disagreeing about which periods are in scope, which would make the comparison
   * the whole `source` parameter exists for meaningless.
   */
  private async periodWindow(
    client: PoolClient,
    legalEntityId: string,
    input: { periodFrom?: string | undefined; periodTo?: string | undefined },
  ): Promise<{
    ids: string[];
    from: string | null;
    to: string | null;
    firstId: string | null;
    firstOrdinal: number | null;
  }> {
    const { rows } = await client.query<{
      id: string;
      name: string;
      ordinal: string;
      start_date: string;
      end_date: string;
    }>(
      `SELECT p.id, p.name,
              row_number() OVER (ORDER BY fy.start_date, p.period_no)::text AS ordinal,
              p.start_date::text AS start_date, p.end_date::text AS end_date
         FROM accounting_periods p
         JOIN fiscal_years fy ON fy.id = p.fiscal_year_id
        WHERE p.legal_entity_id = $1
        ORDER BY fy.start_date, p.period_no`,
      [legalEntityId],
    );
    if (rows.length === 0) {
      throw new AppError(
        'NO_PERIOD_FOR_DATE',
        'This entity has no accounting periods, so there is nothing to report on.',
      );
    }

    const from = input.periodFrom ?? rows[0]!.start_date;
    const to = input.periodTo ?? rows[rows.length - 1]!.end_date;
    const window = rows.filter((p) => p.end_date >= from && p.start_date <= to);
    if (window.length === 0) {
      throw new AppError(
        'NO_PERIOD_FOR_DATE',
        `No accounting period falls between ${from} and ${to}.`,
        { details: { from, to } },
      );
    }

    return {
      ids: window.map((p) => p.id),
      from,
      to,
      firstId: window[0]!.id,
      firstOrdinal: Number(window[0]!.ordinal),
    };
  }
}
