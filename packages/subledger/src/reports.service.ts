import { Pool } from 'pg';
import {
  assertEntityPermission,
  D,
  DEFAULT_AGING_BUCKETS,
  MONEY_SCALE,
  sumExact,
  type TenantPrincipal,
} from '@acct/domain';
import { readInTenant } from '@acct/database';

/**
 * Subledger reports — doc 04's AR Aging and Customer Statement, doc 05's AP
 * Aging, and the reconciliation Gate D asks for.
 *
 * The reconciliation is the interesting one and it is not a report in the usual
 * sense. Phase 3's first exit criterion is "AR and AP aging totals reconcile to
 * their GL control accounts", which is a statement that two independently
 * maintained numbers agree. So `reconcile` computes both from their own sources
 * and reports the difference — a report that computed one from the other would
 * always agree and prove nothing.
 */

export interface AgingRow {
  readonly contact_id: string;
  readonly contact_name: string;
  readonly currency: string;
  readonly current: string;
  readonly bucket_1: string;
  readonly bucket_2: string;
  readonly bucket_3: string;
  readonly bucket_4: string;
  readonly total: string;
}

export class SubledgerReportsService {
  constructor(private readonly pool: Pool) {}

  /**
   * doc 04 / doc 05 aging. One query per side, bucketed in SQL.
   *
   * Bucketed by `due_date` against an explicit `asOf` rather than `now()`: an
   * aging report is a statement about a date, and one that silently uses the
   * server's clock cannot be reproduced tomorrow — which is the first thing an
   * auditor asks of it.
   */
  async aging(
    principal: TenantPrincipal,
    side: 'AR' | 'AP',
    filter: {
      legalEntityId: string;
      asOf: string;
      buckets?: readonly number[] | undefined;
      contactId?: string | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      assertEntityPermission(
        principal,
        side === 'AR' ? 'invoice.view' : 'vendor_bill.view',
        filter.legalEntityId,
      );
      const buckets = filter.buckets ?? DEFAULT_AGING_BUCKETS;
      const [b1, b2, b3] = [buckets[0] ?? 30, buckets[1] ?? 60, buckets[2] ?? 90];
      const table = side === 'AR' ? 'invoices' : 'vendor_bills';
      const contactColumn = side === 'AR' ? 'customer_id' : 'vendor_id';

      const { rows } = await client.query<AgingRow>(
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
              AND ($3::uuid IS NULL OR d.${contactColumn} = $3)
         )
         SELECT contact_id, contact_name, currency,
                sum(amount_due) FILTER (WHERE days_overdue = 0)::text                        AS current,
                coalesce(sum(amount_due) FILTER (WHERE days_overdue BETWEEN 1 AND $4), 0)::text AS bucket_1,
                coalesce(sum(amount_due) FILTER (WHERE days_overdue > $4 AND days_overdue <= $5), 0)::text AS bucket_2,
                coalesce(sum(amount_due) FILTER (WHERE days_overdue > $5 AND days_overdue <= $6), 0)::text AS bucket_3,
                coalesce(sum(amount_due) FILTER (WHERE days_overdue > $6), 0)::text          AS bucket_4,
                sum(amount_due)::text                                                        AS total
           FROM open_items
          GROUP BY contact_id, contact_name, currency
          ORDER BY sum(amount_due) DESC`,
        [filter.legalEntityId, filter.asOf, filter.contactId ?? null, b1, b2, b3],
      );

      // ADR-0006 §1: exact decimal arithmetic, never a double. A column total over
      // a few thousand aged invoices is exactly where binary floating point starts
      // disagreeing with the ledger by a cent, which is the one thing this report
      // exists to rule out.
      const sum = (key: keyof AgingRow) =>
        sumExact(rows.map((r) => D(r[key] ?? '0', MONEY_SCALE))).toFixed(MONEY_SCALE);

      return {
        data: rows.map((r) => ({ ...r, current: r.current ?? '0.00000000' })),
        as_of: filter.asOf,
        buckets: [`1-${b1}`, `${b1 + 1}-${b2}`, `${b2 + 1}-${b3}`, `${b3 + 1}+`],
        totals: {
          current: sum('current'),
          bucket_1: sum('bucket_1'),
          bucket_2: sum('bucket_2'),
          bucket_3: sum('bucket_3'),
          bucket_4: sum('bucket_4'),
          total: sum('total'),
        },
      };
    });
  }

  /**
   * Phase 3's first exit criterion, computed rather than asserted.
   *
   * The subledger side sums open documents; the ledger side sums posted journal
   * lines on the control account. They are maintained by different code through
   * different tables, which is the only reason comparing them means anything.
   *
   * The control account is read from the accounting policy rather than passed
   * in, because a caller that chooses the account it reconciles against can
   * always find one that agrees.
   */
  async reconcile(
    principal: TenantPrincipal,
    side: 'AR' | 'AP',
    filter: { legalEntityId: string; accountingBookId: string; asOf: string },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      assertEntityPermission(
        principal,
        side === 'AR' ? 'invoice.view' : 'vendor_bill.view',
        filter.legalEntityId,
      );
      const column = side === 'AR' ? 'ar_control_account_id' : 'ap_control_account_id';
      const table = side === 'AR' ? 'invoices' : 'vendor_bills';

      const { rows: policy } = await client.query<{ account_id: string | null }>(
        `SELECT ${column} AS account_id FROM accounting_policies
          WHERE legal_entity_id = $1 AND valid_from <= $2::date
          ORDER BY valid_from DESC LIMIT 1`,
        [filter.legalEntityId, filter.asOf],
      );
      const controlAccountId = policy[0]?.account_id ?? null;

      const { rows: subledger } = await client.query<{ total: string; documents: string }>(
        `SELECT coalesce(sum(base_total * (amount_due / nullif(total, 0))), 0)::text AS total,
                count(*)::text AS documents
           FROM ${table}
          WHERE legal_entity_id = $1 AND accounting_book_id = $2
            AND status IN ('POSTED','PARTIALLY_PAID')
            AND posting_date <= $3::date AND amount_due > 0`,
        [filter.legalEntityId, filter.accountingBookId, filter.asOf],
      );

      const { rows: ledger } = await client.query<{ balance: string; lines: string }>(
        `SELECT coalesce(sum(base_debit - base_credit), 0)::text AS balance,
                count(*)::text AS lines
           FROM journal_lines
          WHERE legal_entity_id = $1 AND accounting_book_id = $2
            AND account_id = $3 AND posting_date <= $4::date`,
        [filter.legalEntityId, filter.accountingBookId, controlAccountId, filter.asOf],
      );

      const subledgerTotal = D(subledger[0]?.total ?? '0', MONEY_SCALE);
      // AP is a credit balance, so the ledger side is negated to compare like
      // with like rather than asking the reader to remember the sign.
      const rawLedger = D(ledger[0]?.balance ?? '0', MONEY_SCALE);
      const ledgerBalance = side === 'AR' ? rawLedger : rawLedger.negate();
      const difference = subledgerTotal.sub(ledgerBalance);

      return {
        side,
        as_of: filter.asOf,
        control_account_id: controlAccountId,
        subledger_total: subledgerTotal.toFixed(MONEY_SCALE),
        ledger_balance: ledgerBalance.toFixed(MONEY_SCALE),
        difference: difference.toFixed(MONEY_SCALE),
        // Exactly zero, not "within epsilon". Both sides are exact decimals at the
        // same scale, so a tolerance here would only ever hide a real difference.
        reconciles: difference.isZero(),
        open_documents: Number(subledger[0]?.documents ?? 0),
        ledger_lines: Number(ledger[0]?.lines ?? 0),
        ...(controlAccountId
          ? {}
          : {
              note:
                `No ${column} is configured on the accounting policy, so there is no control ` +
                'account to reconcile against and the ledger side is zero by construction.',
            }),
      };
    });
  }

  /**
   * doc 04's customer statement: opening balance, the period's movements, closing
   * balance.
   *
   * Every movement carries its document reference, because a statement a
   * customer disputes is only useful if each line can be traced to the invoice
   * or receipt behind it.
   */
  async customerStatement(
    principal: TenantPrincipal,
    customerId: string,
    filter: { from: string; to: string; legalEntityId?: string | undefined },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows: customer } = await client.query<{
        id: string;
        legal_name: string;
        legal_entity_id: string | null;
      }>(`SELECT id, legal_name, legal_entity_id FROM contacts WHERE id = $1`, [customerId]);
      if (!customer[0]) {
        return { customer_id: customerId, lines: [], opening_balance: '0', closing_balance: '0' };
      }

      const { rows: opening } = await client.query<{ balance: string }>(
        `SELECT coalesce(sum(total - amount_paid - amount_credited - amount_written_off), 0)::text
                  AS balance
           FROM invoices
          WHERE customer_id = $1 AND status IN ('POSTED','PARTIALLY_PAID','PAID')
            AND posting_date < $2::date
            AND ($3::uuid IS NULL OR legal_entity_id = $3)`,
        [customerId, filter.from, filter.legalEntityId ?? null],
      );

      const { rows: movements } = await client.query(
        `SELECT 'INVOICE' AS kind, i.invoice_number AS reference,
                i.posting_date::text AS date, i.currency,
                i.total::text AS debit, '0'::text AS credit, i.id AS document_id,
                i.due_date::text AS due_date
           FROM invoices i
          WHERE i.customer_id = $1 AND i.status IN ('POSTED','PARTIALLY_PAID','PAID')
            AND i.posting_date BETWEEN $2::date AND $3::date
            AND ($4::uuid IS NULL OR i.legal_entity_id = $4)
          UNION ALL
         SELECT 'RECEIPT', r.receipt_number, r.posting_date::text, r.currency,
                '0'::text, r.amount::text, r.id, NULL
           FROM customer_receipts r
          WHERE r.customer_id = $1 AND r.status = 'POSTED'
            AND r.posting_date BETWEEN $2::date AND $3::date
            AND ($4::uuid IS NULL OR r.legal_entity_id = $4)
          UNION ALL
         SELECT 'CREDIT_NOTE', cn.credit_note_number, cn.posting_date::text, cn.currency,
                '0'::text, cn.total::text, cn.id, NULL
           FROM credit_notes cn
          WHERE cn.customer_id = $1 AND cn.status IN ('POSTED','PAID')
            AND cn.posting_date BETWEEN $2::date AND $3::date
            AND ($4::uuid IS NULL OR cn.legal_entity_id = $4)
          ORDER BY 3, 1`,
        [customerId, filter.from, filter.to, filter.legalEntityId ?? null],
      );

      const openingBalance = D(opening[0]?.balance ?? '0', MONEY_SCALE);
      const closing = movements.reduce(
        (running, m) =>
          running
            .add(D((m as { debit: string }).debit, MONEY_SCALE))
            .sub(D((m as { credit: string }).credit, MONEY_SCALE)),
        openingBalance,
      );

      return {
        customer_id: customerId,
        customer_name: customer[0].legal_name,
        period: { from: filter.from, to: filter.to },
        opening_balance: openingBalance.toFixed(MONEY_SCALE),
        lines: movements,
        closing_balance: closing.toFixed(MONEY_SCALE),
      };
    });
  }
}
