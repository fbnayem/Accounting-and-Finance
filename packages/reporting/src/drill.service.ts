/**
 * `drillDownToJournalLines` — Phase 6 exit criterion 2: "every financial report
 * amount can drill to ledger lines".
 *
 * doc 12 spells the chain out: statement total -> report row -> account/dimension
 * breakdown -> journal lines -> source document. The last hop had no route of its
 * own, so callers reached it through `/reports/general-ledger`, which caps at
 * 5000 rows, takes no cursor and returns no marker — a drill on a control account
 * with more lines than that answered with a prefix of the evidence, and nothing
 * said so. A truncated explanation of a total is worse than a refused one,
 * because it looks like an answer and the total it explains still balances.
 *
 * Three things this route does about that, all of them checkable from one
 * response:
 *
 *   1. It is CURSOR-PAGED, and `meta.has_more` / `meta.next_cursor` are always
 *      present. A page is never trimmed to fit a cap with neither marker set.
 *   2. It states the limit it applied and where the limit came from, so a caller
 *      who asked for 50 and a caller who asked for nothing can tell their
 *      responses apart.
 *   3. It returns `totals` over the WHOLE selection — every line, not the page —
 *      so the drill can be checked against the report figure it is explaining
 *      without paging through it. That is what makes the criterion provable
 *      rather than merely offered: `totals.net` either equals the amount on the
 *      statement or it does not.
 *
 * doc 12 also requires the permission on the destination to be rechecked: "a user
 * may see an aggregate but not restricted source detail if policy requires". The
 * route carries `report.drill_down` rather than `report.view` for exactly that
 * reason, and it is asserted against the book's legal entity here.
 */

import type { Pool, PoolClient } from 'pg';
import {
  AppError,
  D,
  Decimal,
  MONEY_SCALE,
  assertEntityPermission,
  buildPage,
  decodeCursor,
  encodeCursor,
  notFound,
  resolvePage,
  DEFAULT_PAGE_LIMIT,
  type TenantPrincipal,
} from '@acct/domain';
import { readInTenant } from '@acct/database';
import { codeInRange } from './semantic-model';
import { loadBookScope, resolveWindow } from './trial-balance.loader';

export interface DrillQuery {
  readonly accountingBookId?: string | undefined;
  readonly periodFrom?: string | undefined;
  readonly periodTo?: string | undefined;
  readonly accountId?: string | undefined;
  readonly accountIds?: readonly string[] | undefined;
  readonly reportDefinitionId?: string | undefined;
  readonly rowNo?: number | undefined;
  readonly dimensionValueId?: string | undefined;
  readonly financialSnapshotId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

interface DrillCursor {
  readonly postingDate: string;
  readonly journalEntryId: string;
  readonly lineNo: number;
}

const CURSOR_DIRECTION = 'asc' as const;

/**
 * The cursor is (posting_date, journal_entry_id, line_no), which is a TOTAL order
 * because `journal_lines` is unique on (journal_entry_id, line_no).
 *
 * A partial order would be worse than no cursor at all: two lines that compare
 * equal are either both returned twice or both skipped, depending on which side
 * of the page boundary they land, and the drill would silently over- or
 * under-explain the total it exists to justify.
 */
function encodeDrillCursor(row: {
  posting_date: string;
  journal_entry_id: string;
  line_no: number;
}) {
  return {
    k: `${row.posting_date}|${row.journal_entry_id}|${row.line_no}`,
    id: row.journal_entry_id,
  };
}

function decodeDrillCursor(cursor: string): DrillCursor {
  const payload = decodeCursor(cursor);
  const parts = payload.k.split('|');
  const [postingDate, journalEntryId, lineNo] = parts;
  if (
    parts.length !== 3 ||
    postingDate === undefined ||
    journalEntryId === undefined ||
    lineNo === undefined ||
    !/^\d{4}-\d{2}-\d{2}$/.test(postingDate) ||
    !/^[0-9a-fA-F-]{36}$/.test(journalEntryId) ||
    !/^\d+$/.test(lineNo)
  ) {
    throw new AppError('MALFORMED_CURSOR', 'The cursor is not valid. Start from the first page.');
  }
  return { postingDate, journalEntryId, lineNo: Number(lineNo) };
}

export interface DrillLine extends Record<string, unknown> {
  id: string;
  journal_entry_id: string;
  entry_number: string | null;
  posting_date: string;
  account_id: string;
  account_code: string;
  account_name: string;
  line_description: string | null;
  debit: string;
  credit: string;
  transaction_currency: string;
  transaction_debit: string;
  transaction_credit: string;
  entry_status: string;
  source_type: string | null;
  source_id: string | null;
  dimensions: unknown;
  line_no: number;
}

export class ReportDrillService {
  constructor(private readonly pool: Pool) {}

  async drillDown(principal: TenantPrincipal, query: DrillQuery) {
    const page = resolvePage({ cursor: query.cursor, limit: query.limit });
    const after = query.cursor ? decodeDrillCursor(query.cursor) : null;

    return readInTenant(this.pool, principal, async ({ client }) => {
      const snapshot = query.financialSnapshotId
        ? await this.loadSnapshot(client, principal.tenantId, query.financialSnapshotId)
        : null;

      const bookId = snapshot?.accounting_book_id ?? query.accountingBookId;
      if (!bookId) {
        throw new AppError(
          'VALIDATION_FAILED',
          'A drill needs the accounting book the report amount came from. Pass book_id, or ' +
            'financial_snapshot_id for a snapshot that records its own book.',
        );
      }
      if (
        snapshot?.accounting_book_id &&
        query.accountingBookId &&
        snapshot.accounting_book_id !== query.accountingBookId
      ) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Financial snapshot ${snapshot.id} was taken on accounting book ` +
            `${snapshot.accounting_book_id} and the request names ${query.accountingBookId}. ` +
            "Drilling one statement with another statement's book would explain the wrong " +
            'number.',
        );
      }

      const book = await loadBookScope(client, principal.tenantId, bookId);
      // doc 12: the permission on the DESTINATION record is rechecked. Seeing a
      // total is not seeing the lines behind it.
      assertEntityPermission(principal, 'report.drill_down', book.legalEntityId);

      const window = await resolveWindow(
        client,
        book.legalEntityId,
        query.periodFrom ?? null,
        query.periodTo ?? null,
      );

      const selection = await this.resolveAccounts(
        client,
        principal.tenantId,
        query,
        book.legalEntityId,
      );

      // Every filter is a bound parameter. Nothing a caller supplies is ever
      // concatenated into SQL — the account ids below arrive as a uuid[] and the
      // report row is resolved to ids before this point.
      const params: unknown[] = [book.bookId, window.periodIds];
      const where = [
        'l.accounting_book_id = $1',
        'l.accounting_period_id = ANY($2::uuid[])',
        "e.status IN ('POSTED','REVERSED')",
      ];

      if (selection.accountIds !== null) {
        params.push(selection.accountIds);
        where.push(`l.account_id = ANY($${params.length}::uuid[])`);
      }
      if (query.dimensionValueId) {
        params.push(query.dimensionValueId);
        where.push(
          `EXISTS (SELECT 1 FROM journal_line_dimensions d
                    WHERE d.journal_line_id = l.id AND d.dimension_value_id = $${params.length})`,
        );
      }
      if (snapshot !== null) {
        // Drilling an ISSUED statement means drilling the ledger as it stood when
        // the statement was taken. Without the cutoff, an entry posted after the
        // snapshot appears in the explanation of a total it was never part of,
        // and the drill contradicts the very document it is supposed to support.
        params.push(snapshot.ledger_cutoff_at);
        where.push(`e.posted_at IS NOT NULL AND e.posted_at <= $${params.length}::timestamptz`);
      }

      const totals = await this.totals(client, where, params);

      const pageParams = [...params];
      if (after !== null) {
        pageParams.push(after.postingDate, after.journalEntryId, after.lineNo);
        where.push(
          `(l.posting_date, l.journal_entry_id, l.line_no) > ` +
            `($${pageParams.length - 2}::date, $${pageParams.length - 1}::uuid, ` +
            `$${pageParams.length}::int)`,
        );
      }
      pageParams.push(page.limit + 1);

      const { rows } = await client.query<DrillLine>(
        `SELECT l.id, l.journal_entry_id, e.entry_number,
                l.posting_date::text AS posting_date, l.line_no,
                l.account_id, a.code AS account_code, a.name AS account_name,
                l.description AS line_description,
                l.base_debit::text AS debit, l.base_credit::text AS credit,
                l.transaction_currency,
                l.transaction_debit::text AS transaction_debit,
                l.transaction_credit::text AS transaction_credit,
                e.status::text AS entry_status, e.source_type, e.source_id,
                (SELECT coalesce(jsonb_agg(jsonb_build_object(
                          'dimension_id', d.dimension_id,
                          'dimension_value_id', d.dimension_value_id)), '[]'::jsonb)
                   FROM journal_line_dimensions d
                  WHERE d.journal_line_id = l.id) AS dimensions
           FROM journal_lines l
           JOIN journal_entries e ON e.id = l.journal_entry_id
           JOIN accounts a ON a.id = l.account_id
          WHERE ${where.join(' AND ')}
          ORDER BY l.posting_date, l.journal_entry_id, l.line_no
          LIMIT $${pageParams.length}`,
        pageParams,
      );

      const built = buildPage(rows, page.limit, CURSOR_DIRECTION, encodeDrillCursor);

      // The last row of the page, re-encoded from its own key rather than from
      // `buildPage`'s tiebreaker: `encodeDrillCursor` already packs the whole
      // sort key into `k`, and the id is the entry, so the two agree.
      const last = built.data[built.data.length - 1];
      const nextCursor =
        built.meta.has_more && last
          ? encodeCursor({ ...encodeDrillCursor(last), d: CURSOR_DIRECTION })
          : null;

      const pageDebit = built.data.reduce<Decimal>(
        (acc, row) => acc.add(D(row.debit, MONEY_SCALE)),
        Decimal.zero(MONEY_SCALE),
      );
      const pageCredit = built.data.reduce<Decimal>(
        (acc, row) => acc.add(D(row.credit, MONEY_SCALE)),
        Decimal.zero(MONEY_SCALE),
      );

      return {
        data: built.data,
        meta: {
          has_more: built.meta.has_more,
          next_cursor: nextCursor,
          // "If a limit is applied, say so." Both halves: the number, and where
          // it came from — a caller who passed nothing and a caller who passed 50
          // must be able to tell their responses apart.
          limit: page.limit,
          limit_source: query.limit === undefined ? 'DEFAULT' : 'REQUEST',
          default_limit: DEFAULT_PAGE_LIMIT,
          returned: built.data.length,
          // The count over the whole selection, not the page. `has_more` says
          // there is more; this says how much more, which is what turns "the
          // drill is complete" from a claim into a subtraction.
          total_lines: totals.lineCount,
          lines_not_on_this_page: Math.max(totals.lineCount - built.data.length, 0),
          complete: !built.meta.has_more && built.data.length === totals.lineCount,
        },
        // What is being explained, echoed back. A drill whose parameters cannot be
        // read off its own response cannot be shown to explain the figure it was
        // launched from.
        explains: {
          accounting_book_id: book.bookId,
          legal_entity_id: book.legalEntityId,
          period_from: window.from,
          period_to: window.to,
          account_ids: selection.accountIds,
          account_selection: selection.describedBy,
          report_definition_id: query.reportDefinitionId ?? null,
          row_no: query.rowNo ?? null,
          dimension_value_id: query.dimensionValueId ?? null,
          financial_snapshot_id: snapshot?.id ?? null,
          ledger_cutoff_at: snapshot?.ledger_cutoff_at ?? null,
        },
        // The sum of every line the selection matches, whether or not it is on
        // this page. This is the number that must equal the report amount.
        totals: {
          debit: totals.debit,
          credit: totals.credit,
          net: totals.net,
          line_count: totals.lineCount,
        },
        page_totals: {
          debit: pageDebit.toString(),
          credit: pageCredit.toString(),
          net: pageDebit.sub(pageCredit).toString(),
        },
      };
    });
  }

  // -------------------------------------------------------------------------

  private async totals(
    client: PoolClient,
    where: readonly string[],
    params: readonly unknown[],
  ): Promise<{ debit: string; credit: string; net: string; lineCount: number }> {
    const { rows } = await client.query<{
      debit: string;
      credit: string;
      line_count: number;
    }>(
      `SELECT coalesce(sum(l.base_debit), 0)::text  AS debit,
              coalesce(sum(l.base_credit), 0)::text AS credit,
              count(*)::int AS line_count
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id
        WHERE ${where.join(' AND ')}`,
      [...params],
    );
    const row = rows[0]!;
    const debit = D(row.debit, MONEY_SCALE);
    const credit = D(row.credit, MONEY_SCALE);
    return {
      debit: debit.toString(),
      credit: credit.toString(),
      net: debit.sub(credit).toString(),
      lineCount: row.line_count,
    };
  }

  private async loadSnapshot(
    client: PoolClient,
    tenantId: string,
    id: string,
  ): Promise<{
    id: string;
    accounting_book_id: string | null;
    ledger_cutoff_at: string;
  }> {
    const { rows } = await client.query<{
      id: string;
      accounting_book_id: string | null;
      ledger_cutoff_at: string;
    }>(
      `SELECT id, accounting_book_id, ledger_cutoff_at::text AS ledger_cutoff_at
         FROM financial_snapshots WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    );
    const snapshot = rows[0];
    if (!snapshot) throw notFound('Financial statement snapshot', id);
    if (!snapshot.accounting_book_id) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Financial snapshot ${id} records no accounting book — it is a consolidated snapshot — ` +
          'so its figures have no single ledger to drill into. Drill the contributing entities ' +
          'individually.',
      );
    }
    return snapshot;
  }

  /**
   * Which accounts this drill is about.
   *
   * `null` means "every account in the window", which is what a drill on a
   * statement TOTAL asks for and is a legitimate question. It is still paged and
   * still totalled, so an unbounded drill is slow rather than misleading.
   */
  private async resolveAccounts(
    client: PoolClient,
    tenantId: string,
    query: DrillQuery,
    legalEntityId: string,
  ): Promise<{ accountIds: string[] | null; describedBy: string }> {
    const explicit = [...(query.accountId ? [query.accountId] : []), ...(query.accountIds ?? [])];
    if (explicit.length > 0 && query.reportDefinitionId) {
      throw new AppError(
        'VALIDATION_FAILED',
        'A drill names either the accounts or the report row whose accounts it should use, not ' +
          'both. Two answers to "which accounts" is two different totals.',
      );
    }
    if (explicit.length > 0) {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM accounts WHERE id = ANY($1::uuid[]) AND legal_entity_id = $2`,
        [explicit, legalEntityId],
      );
      if (rows.length !== new Set(explicit).size) {
        const found = new Set(rows.map((r) => r.id));
        const missing = [...new Set(explicit)].filter((id) => !found.has(id));
        throw notFound('Account', missing.join(', '));
      }
      return { accountIds: rows.map((r) => r.id), describedBy: 'ACCOUNT_ID' };
    }

    if (query.reportDefinitionId) {
      if (query.rowNo === undefined) {
        throw new AppError(
          'VALIDATION_FAILED',
          'Drilling a report definition needs row_no as well: a definition has many rows and ' +
            'each explains a different amount.',
        );
      }
      const ids = await this.accountsForRow(
        client,
        tenantId,
        query.reportDefinitionId,
        query.rowNo,
        legalEntityId,
      );
      return { accountIds: ids, describedBy: 'REPORT_DEFINITION_ROW' };
    }

    return { accountIds: null, describedBy: 'ALL_ACCOUNTS_IN_WINDOW' };
  }

  /**
   * The accounts behind one row of a report definition.
   *
   * Mappings first (0053's `statement_account_mappings`), because a mapping is an
   * explicit decision and the code range is a guess about one. When the
   * definition carries no mappings at all, the row's own range or group is
   * resolved — in TypeScript, with `codeInRange`, so a drill selects exactly the
   * accounts the STATEMENT put on the row. Resolving the range with SQL `BETWEEN`
   * would compare codes lexicographically and quietly drill a different set.
   */
  private async accountsForRow(
    client: PoolClient,
    tenantId: string,
    definitionId: string,
    rowNo: number,
    legalEntityId: string,
  ): Promise<string[]> {
    const { rows: rowRecords } = await client.query<{
      id: string;
      row_type: string;
      account_from: string | null;
      account_to: string | null;
      account_group_id: string | null;
    }>(
      `SELECT r.id, r.row_type, r.account_from, r.account_to, r.account_group_id
         FROM report_rows r
         JOIN report_definitions d ON d.id = r.report_definition_id
        WHERE r.report_definition_id = $1 AND r.row_no = $2 AND d.tenant_id = $3`,
      [definitionId, rowNo, tenantId],
    );
    const row = rowRecords[0];
    if (!row) throw notFound('Report definition row', `${definitionId} row ${rowNo}`);

    const { rows: mapped } = await client.query<{ account_id: string }>(
      `SELECT account_id
         FROM statement_account_mappings
        WHERE report_definition_id = $1 AND report_row_id = $2 AND legal_entity_id = $3`,
      [definitionId, row.id, legalEntityId],
    );
    if (mapped.length > 0) return mapped.map((m) => m.account_id);

    const { rows: anyMapping } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM statement_account_mappings WHERE report_definition_id = $1`,
      [definitionId],
    );
    if (anyMapping[0] && anyMapping[0].n !== '0') {
      // The definition maps its accounts and maps none to this row. That is an
      // answer, not a fallback: the row genuinely holds nothing.
      return [];
    }

    const { rows: accounts } = await client.query<{
      id: string;
      code: string;
      group_id: string | null;
    }>(`SELECT id, code, group_id FROM accounts WHERE legal_entity_id = $1`, [legalEntityId]);
    if (row.row_type === 'ACCOUNT_GROUP') {
      return accounts.filter((a) => a.group_id === row.account_group_id).map((a) => a.id);
    }
    if (row.row_type === 'ACCOUNT_RANGE') {
      return accounts
        .filter((a) => codeInRange(a.code, row.account_from, row.account_to))
        .map((a) => a.id);
    }
    throw new AppError(
      'VALIDATION_FAILED',
      `Row ${rowNo} is a ${row.row_type} row. Its amount is computed from other rows or is ` +
        'presentation only, so there are no journal lines behind it — drill the rows its ' +
        'formula names instead.',
      { details: { row_no: rowNo, row_type: row.row_type } },
    );
  }
}
