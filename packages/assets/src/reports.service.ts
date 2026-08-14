import { Pool } from 'pg';
import { D, sumExact, assertEntityPermission, type TenantPrincipal } from '@acct/domain';
import { readInTenant } from '@acct/database';

/**
 * Asset reports — doc 09's Asset Register and Asset-to-GL Reconciliation.
 *
 * The reconciliation is the evidence for exit criterion 4 ("Asset register
 * equals fixed-asset and accumulated-depreciation GL controls"), and like the
 * AR/AP one it computes BOTH sides from their own sources: the subledger side
 * from asset books and their transactions, the GL side from posted journal
 * lines on the accounts the category maps to. A report that computed one from
 * the other would always agree and prove nothing.
 */

export class AssetReportsService {
  constructor(private readonly pool: Pool) {}

  /**
   * doc 09 "Asset Register": one row per asset and book, with the carrying
   * amount derived the only way this package ever derives it — cost basis plus
   * posted revaluations, less accumulated depreciation and impairment.
   */
  async getFixedAssetReport(
    principal: TenantPrincipal,
    query: {
      legalEntityId: string;
      accountingBookId?: string | undefined;
      assetCategoryId?: string | undefined;
      status?: string | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      assertEntityPermission(principal, 'report.view', query.legalEntityId);

      const { rows } = await client.query<{
        category_id: string;
        category_code: string;
        cost: string;
        accumulated_depreciation: string;
        accumulated_impairment: string;
        carrying_amount: string;
        [key: string]: unknown;
      }>(
        `SELECT a.id AS fixed_asset_id, a.asset_number, a.name, a.status::text AS status,
                a.currency, a.acquisition_date::text AS acquisition_date,
                a.in_service_date::text AS in_service_date,
                c.id AS category_id, c.code AS category_code, c.name AS category_name,
                b.id AS asset_book_id, b.accounting_book_id, b.method::text AS method,
                b.useful_life_months, b.status::text AS book_status,
                (b.cost_basis + rv.total)::text AS cost,
                b.accumulated_depreciation::text AS accumulated_depreciation,
                b.accumulated_impairment::text AS accumulated_impairment,
                b.revaluation_surplus::text AS revaluation_surplus,
                b.residual_value::text AS residual_value,
                (b.cost_basis + rv.total - b.accumulated_depreciation - b.accumulated_impairment)::text
                  AS carrying_amount
           FROM fixed_assets a
           JOIN asset_categories c ON c.id = a.asset_category_id
           JOIN asset_books b ON b.fixed_asset_id = a.id
          CROSS JOIN LATERAL (
            SELECT coalesce(sum(t.amount), 0) AS total
              FROM asset_transactions t
             WHERE t.asset_book_id = b.id AND t.kind = 'REVALUATION'
          ) rv
          WHERE a.legal_entity_id = $1
            AND ($2::uuid IS NULL OR b.accounting_book_id = $2)
            AND ($3::uuid IS NULL OR a.asset_category_id = $3)
            AND ($4::text IS NULL OR a.status::text = $4)
          ORDER BY c.code, a.asset_number, b.accounting_book_id`,
        [
          query.legalEntityId,
          query.accountingBookId ?? null,
          query.assetCategoryId ?? null,
          query.status ?? null,
        ],
      );

      // Category subtotals, summed as decimals — the register's totals row is
      // what gets compared against the GL controls, so it must not be assembled
      // by the client from floats.
      const byCategory = new Map<string, typeof rows>();
      for (const row of rows) {
        const bucket = byCategory.get(row.category_id) ?? [];
        bucket.push(row);
        byCategory.set(row.category_id, bucket);
      }
      const totals = [...byCategory.entries()].map(([categoryId, bucket]) => ({
        category_id: categoryId,
        category_code: bucket[0]!.category_code,
        cost: sumExact(bucket.map((r) => D(r.cost))).toString(),
        accumulated_depreciation: sumExact(
          bucket.map((r) => D(r.accumulated_depreciation)),
        ).toString(),
        accumulated_impairment: sumExact(bucket.map((r) => D(r.accumulated_impairment))).toString(),
        carrying_amount: sumExact(bucket.map((r) => D(r.carrying_amount))).toString(),
      }));

      return { data: rows, totals_by_category: totals };
    });
  }

  /**
   * F-911 — doc 09's "Asset-to-GL Reconciliation", per category:
   *
   *   - subledger cost (active books' cost basis + revaluations) against the
   *     balance of the category's asset cost account;
   *   - subledger accumulated depreciation against the balance of the
   *     accumulated depreciation account;
   *   - the period's additions, depreciation, impairments, revaluations and
   *     disposals, which are what any movement between two reconciliations
   *     must decompose into.
   *
   * Balances are CURRENT on both sides deliberately: the subledger side reads
   * the books' running accumulators, which have no as-of history, and a
   * reconciliation whose two sides are drawn at different dates reports a
   * difference that is only a timestamp.
   */
  async getAssetReconciliation(
    principal: TenantPrincipal,
    query: {
      legalEntityId: string;
      accountingBookId: string;
      from?: string | undefined;
      to?: string | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      assertEntityPermission(principal, 'report.view', query.legalEntityId);

      interface SubledgerRow {
        category_id: string;
        cost: string;
        accumulated_depreciation: string;
        accumulated_impairment: string;
      }
      const { rows: subledger } = await client.query<SubledgerRow>(
        `SELECT c.id AS category_id,
                coalesce(sum(b.cost_basis + rv.total), 0)::text AS cost,
                coalesce(sum(b.accumulated_depreciation), 0)::text AS accumulated_depreciation,
                coalesce(sum(b.accumulated_impairment), 0)::text AS accumulated_impairment
           FROM asset_categories c
           JOIN fixed_assets a ON a.asset_category_id = c.id
           JOIN asset_books b ON b.fixed_asset_id = a.id
            AND b.accounting_book_id = $2
            AND b.status <> 'DISPOSED'
          CROSS JOIN LATERAL (
            SELECT coalesce(sum(t.amount), 0) AS total
              FROM asset_transactions t
             WHERE t.asset_book_id = b.id AND t.kind = 'REVALUATION'
          ) rv
          WHERE c.legal_entity_id = $1
          GROUP BY c.id`,
        [query.legalEntityId, query.accountingBookId],
      );
      const subledgerByCategory = new Map(subledger.map((r) => [r.category_id, r]));

      interface GlRow {
        category_id: string;
        gl_cost: string;
        gl_accumulated_depreciation: string;
        gl_accumulated_impairment: string | null;
      }
      const { rows: gl } = await client.query<GlRow>(
        `SELECT c.id AS category_id,
                cost.balance::text AS gl_cost,
                accdep.balance::text AS gl_accumulated_depreciation,
                accimp.balance::text AS gl_accumulated_impairment
           FROM asset_categories c
          CROSS JOIN LATERAL (
            SELECT coalesce(sum(l.base_debit - l.base_credit), 0) AS balance
              FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
             WHERE l.account_id = c.asset_account_id
               AND e.accounting_book_id = $2 AND e.status = 'POSTED'
          ) cost
          CROSS JOIN LATERAL (
            SELECT coalesce(sum(l.base_credit - l.base_debit), 0) AS balance
              FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
             WHERE l.account_id = c.accumulated_depreciation_account_id
               AND e.accounting_book_id = $2 AND e.status = 'POSTED'
          ) accdep
          CROSS JOIN LATERAL (
            SELECT CASE WHEN c.accumulated_impairment_account_id IS NULL THEN NULL
                        ELSE coalesce(sum(l.base_credit - l.base_debit), 0) END AS balance
              FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
             WHERE l.account_id = c.accumulated_impairment_account_id
               AND e.accounting_book_id = $2 AND e.status = 'POSTED'
          ) accimp
          WHERE c.legal_entity_id = $1
          ORDER BY c.code`,
        [query.legalEntityId, query.accountingBookId],
      );

      interface MovementRow {
        category_id: string;
        additions: string;
        depreciation: string;
        impairments: string;
        impairment_reversals: string;
        revaluations: string;
      }
      const { rows: movements } = await client.query<MovementRow>(
        `SELECT c.id AS category_id,
                coalesce(sum(t.amount) FILTER (WHERE t.kind = 'CAPITALIZATION'), 0)::text AS additions,
                coalesce(sum(t.amount) FILTER (WHERE t.kind = 'DEPRECIATION'), 0)::text AS depreciation,
                coalesce(sum(t.amount) FILTER (WHERE t.kind = 'IMPAIRMENT'), 0)::text AS impairments,
                coalesce(sum(t.amount) FILTER (WHERE t.kind = 'IMPAIRMENT_REVERSAL'), 0)::text
                  AS impairment_reversals,
                coalesce(sum(t.amount) FILTER (WHERE t.kind = 'REVALUATION'), 0)::text AS revaluations
           FROM asset_categories c
           JOIN fixed_assets a ON a.asset_category_id = c.id
           JOIN asset_transactions t ON t.fixed_asset_id = a.id
           JOIN asset_books b ON b.id = t.asset_book_id AND b.accounting_book_id = $2
          WHERE c.legal_entity_id = $1
            AND ($3::date IS NULL OR t.posting_date >= $3)
            AND ($4::date IS NULL OR t.posting_date <= $4)
          GROUP BY c.id`,
        [query.legalEntityId, query.accountingBookId, query.from ?? null, query.to ?? null],
      );
      const movementsByCategory = new Map(
        movements.map(({ category_id, ...rest }) => [category_id, rest]),
      );

      interface DisposalRow {
        category_id: string;
        disposal_count: string;
        cost_removed: string;
        contra_removed: string;
        proceeds: string;
        gain_loss: string;
      }
      const { rows: disposals } = await client.query<DisposalRow>(
        `SELECT c.id AS category_id, count(*)::text AS disposal_count,
                coalesce(sum(d.carrying_amount + d.accumulated_depreciation_removed), 0)::text
                  AS cost_removed,
                coalesce(sum(d.accumulated_depreciation_removed), 0)::text AS contra_removed,
                coalesce(sum(d.proceeds_amount), 0)::text AS proceeds,
                coalesce(sum(d.gain_loss_amount), 0)::text AS gain_loss
           FROM asset_categories c
           JOIN disposal_records d ON d.fixed_asset_id IN
                (SELECT id FROM fixed_assets WHERE asset_category_id = c.id)
           JOIN asset_books b ON b.id = d.asset_book_id AND b.accounting_book_id = $2
          WHERE c.legal_entity_id = $1
            AND ($3::date IS NULL OR d.disposal_date >= $3)
            AND ($4::date IS NULL OR d.disposal_date <= $4)
          GROUP BY c.id`,
        [query.legalEntityId, query.accountingBookId, query.from ?? null, query.to ?? null],
      );
      const disposalsByCategory = new Map(
        disposals.map(({ category_id, ...rest }) => [category_id, rest]),
      );

      const zeroMovements = {
        additions: '0',
        depreciation: '0',
        impairments: '0',
        impairment_reversals: '0',
        revaluations: '0',
      };
      const zeroDisposals = {
        disposal_count: '0',
        cost_removed: '0',
        contra_removed: '0',
        proceeds: '0',
        gain_loss: '0',
      };

      const data = gl.map((row) => {
        const sub = subledgerByCategory.get(row.category_id) ?? {
          category_id: row.category_id,
          cost: '0',
          accumulated_depreciation: '0',
          accumulated_impairment: '0',
        };
        const movement = movementsByCategory.get(row.category_id) ?? zeroMovements;
        const disposal = disposalsByCategory.get(row.category_id) ?? zeroDisposals;
        return {
          category_id: row.category_id,
          cost: {
            subledger: sub.cost,
            gl: row.gl_cost,
            // GL minus subledger, so a positive difference reads as "the GL
            // claims more than the register can account for".
            difference: D(row.gl_cost).sub(D(sub.cost)).toString(),
          },
          accumulated_depreciation: {
            subledger: sub.accumulated_depreciation,
            gl: row.gl_accumulated_depreciation,
            difference: D(row.gl_accumulated_depreciation)
              .sub(D(sub.accumulated_depreciation))
              .toString(),
          },
          accumulated_impairment: {
            subledger: sub.accumulated_impairment,
            gl: row.gl_accumulated_impairment,
            difference:
              row.gl_accumulated_impairment === null
                ? null
                : D(row.gl_accumulated_impairment).sub(D(sub.accumulated_impairment)).toString(),
          },
          movements: movement,
          disposals: disposal,
        };
      });

      return {
        accounting_book_id: query.accountingBookId,
        from: query.from ?? null,
        to: query.to ?? null,
        data,
        in_balance: data.every(
          (row) =>
            D(row.cost.difference).isZero() && D(row.accumulated_depreciation.difference).isZero(),
        ),
      };
    });
  }
}
