/**
 * Reconciling items — the "explicit, explainable reconciliation item" Gate D's
 * criterion is written around (F-1001).
 *
 * `reconciling_items` has held the explanation since 0016 and no route could
 * read or write one, so the gate was provable only in its trivial direction: the
 * deferred trigger compares the difference against the SUM of the items, so with
 * no items a zero difference certified while stating nothing and a non-zero
 * difference could never be certified at all. This is both halves of the
 * artifact — the write that makes a non-zero difference certifiable, and the
 * read an auditor and the close dashboard drill into.
 *
 * The certified-parent decision, stated because the audit found the hole by
 * name ("a CERTIFIED/APPROVED reconciliation can be made unexplained from the
 * child side" — the 0016 trigger fires on writes to account_reconciliations,
 * never on writes to reconciling_items):
 *
 *   - **Creating an item under a CERTIFIED or APPROVED parent is REFUSED.**
 *     The certification asserted "this difference is explained by exactly these
 *     items"; a new item changes the sum the certifier signed against without
 *     any control noticing, so the lawful path is the formal reopen
 *     (POST /account-reconciliations/{id}/reopen) — the same rule doc 12 states
 *     for the parent itself.
 *   - **Resolving an item under a CERTIFIED parent is ALLOWED.** Resolution
 *     changes no amount, no type and no description — it records that a timing
 *     difference cleared, which ordinarily happens AFTER certification. Gate D's
 *     exception list is precisely the items past their expected_clear_date and
 *     still unresolved; demanding a high-risk reopen to record a clearance would
 *     guarantee that list is never maintained.
 */
import { Pool } from 'pg';
import {
  AppError,
  D,
  assertEntityPermission,
  notFound,
  uuidv7,
  type TenantPrincipal,
} from '@acct/domain';
import { readInTenant, recordAudit, writeInTenant } from '@acct/database';
import { reconcilingItemsTotal } from './reconciliation.service';

export const RECONCILING_ITEM_TYPES = [
  'TIMING',
  'ERROR',
  'UNRECORDED',
  'IN_TRANSIT',
  'DISPUTED',
  'OTHER',
] as const;
export type ReconcilingItemType = (typeof RECONCILING_ITEM_TYPES)[number];

export interface CreateReconcilingItemInput {
  readonly itemType: ReconcilingItemType;
  readonly description: string;
  /** Signed exact decimal: the items sum to the difference, which can be negative. */
  readonly amount: string;
  readonly expectedClearDate?: string | undefined;
  readonly sourceType?: string | undefined;
  readonly sourceId?: string | undefined;
  readonly evidenceFileId?: string | undefined;
}

interface ReconRow {
  id: string;
  tenant_id: string;
  legal_entity_id: string;
  accounting_book_id: string;
  accounting_period_id: string;
  status: string;
  difference: string;
}

export class ReconcilingItemService {
  constructor(private readonly pool: Pool) {}

  /** `createReconcilingItem` — POST /account-reconciliations/{id}/reconciling-items. */
  async create(
    principal: TenantPrincipal,
    reconciliationId: string,
    input: CreateReconcilingItemInput,
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      // FOR UPDATE: certification reads the items total under this same lock, so
      // an item cannot slide in between the certifier's check and the commit.
      const recon = await loadReconciliation(client, reconciliationId, 'FOR UPDATE');
      assertEntityPermission(principal, 'reconciliation.manage', recon.legal_entity_id);

      if (recon.status === 'CERTIFIED' || recon.status === 'APPROVED') {
        throw new AppError(
          'POSTED_IMMUTABLE',
          `Reconciliation ${reconciliationId} is ${recon.status}. Its certification asserted that ` +
            `the difference is explained by exactly the items it carries; adding one now would ` +
            `change what was certified without anybody re-certifying it. Reopen it first ` +
            `(POST /account-reconciliations/{id}/reopen, with a reason), then add the item and ` +
            `certify again.`,
          { details: { account_reconciliation_id: reconciliationId, status: recon.status } },
        );
      }

      const amount = D(input.amount);
      if (amount.isZero()) {
        throw new AppError(
          'VALIDATION_FAILED',
          'A reconciling item that explains 0 explains nothing. Record narrative evidence on the ' +
            'reconciliation or the close task instead.',
          { fieldErrors: [{ field: 'amount', code: 'ZERO', message: 'must be non-zero' }] },
        );
      }

      const id = uuidv7();
      const { rows } = await client.query<{
        id: string;
        item_type: string;
        description: string;
        amount: string;
        expected_clear_date: string | null;
        source_type: string | null;
        source_id: string | null;
        evidence_file_id: string | null;
        resolved_at: string | null;
        created_at: string;
      }>(
        `INSERT INTO reconciling_items
           (id, tenant_id, account_reconciliation_id, item_type, description, amount,
            expected_clear_date, source_type, source_id, evidence_file_id)
         VALUES ($1,$2,$3,$4,$5,$6::numeric,$7::date,$8,$9,$10)
         RETURNING id, item_type, description, amount::text AS amount,
                   expected_clear_date::text AS expected_clear_date, source_type, source_id,
                   evidence_file_id, resolved_at, created_at`,
        [
          id,
          principal.tenantId,
          recon.id,
          input.itemType,
          input.description,
          amount.toString(),
          input.expectedClearDate ?? null,
          input.sourceType ?? null,
          input.sourceId ?? null,
          input.evidenceFileId ?? null,
        ],
      );

      const items = await reconcilingItemsTotal(client, recon.id);
      const explained = D(items.total).equals(D(recon.difference));

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: recon.legal_entity_id,
        action: 'reconciling_item.created',
        resourceType: 'reconciling_item',
        resourceId: id,
        after: {
          account_reconciliation_id: recon.id,
          item_type: input.itemType,
          amount: amount.toString(),
          expected_clear_date: input.expectedClearDate ?? null,
          items_total: items.total,
          difference: recon.difference,
          explained,
        },
      });

      return {
        ...rows[0]!,
        account_reconciliation_id: recon.id,
        reconciliation_status: recon.status,
        difference: recon.difference,
        reconciling_items_total: items.total,
        reconciling_items_count: items.count,
        explained,
      };
    });
  }

  /** `listReconcilingItems` — GET /account-reconciliations/{id}/reconciling-items. */
  async list(
    principal: TenantPrincipal,
    reconciliationId: string,
    query: { cursor?: string | undefined; limit?: number | undefined } = {},
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const recon = await loadReconciliation(client, reconciliationId);
      assertEntityPermission(principal, 'reconciliation.view', recon.legal_entity_id);

      const params: unknown[] = [recon.id];
      let cursorClause = '';
      if (query.cursor) {
        params.push(query.cursor);
        cursorClause = `AND i.id > $${params.length}::uuid`;
      }
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      params.push(limit + 1);

      const { rows } = await client.query(
        `SELECT i.id, i.item_type, i.description, i.amount::text AS amount,
                i.expected_clear_date::text AS expected_clear_date,
                i.source_type, i.source_id, i.evidence_file_id,
                i.resolved_at, i.created_at,
                -- Gate D's exception: expected to have cleared, and has not.
                (i.resolved_at IS NULL AND i.expected_clear_date IS NOT NULL
                 AND i.expected_clear_date < CURRENT_DATE) AS overdue
           FROM reconciling_items i
          WHERE i.account_reconciliation_id = $1 ${cursorClause}
          ORDER BY i.id
          LIMIT $${params.length}`,
        params,
      );

      const page = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      const items = await reconcilingItemsTotal(client, recon.id);
      const { rows: unresolvedRows } = await client.query<{ unresolved: string }>(
        `SELECT count(*)::text AS unresolved FROM reconciling_items
          WHERE account_reconciliation_id = $1 AND resolved_at IS NULL`,
        [recon.id],
      );

      return {
        data: page,
        summary: {
          account_reconciliation_id: recon.id,
          status: recon.status,
          difference: recon.difference,
          items_total: items.total,
          items_count: items.count,
          unresolved_count: Number(unresolvedRows[0]?.unresolved ?? '0'),
          explained: D(items.total).equals(D(recon.difference)),
        },
        meta: {
          has_more: hasMore,
          next_cursor: hasMore
            ? ((page[page.length - 1] as { id: string } | undefined)?.id ?? null)
            : null,
        },
      };
    });
  }

  /** `resolveReconcilingItem` — POST /reconciling-items/{id}/resolve. */
  async resolve(
    principal: TenantPrincipal,
    itemId: string,
    input: { note?: string | undefined } = {},
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows } = await client.query<{
        id: string;
        account_reconciliation_id: string;
        item_type: string;
        description: string;
        amount: string;
        expected_clear_date: string | null;
        resolved_at: string | null;
        legal_entity_id: string;
        recon_status: string;
      }>(
        `SELECT i.id, i.account_reconciliation_id, i.item_type, i.description,
                i.amount::text AS amount, i.expected_clear_date::text AS expected_clear_date,
                i.resolved_at, r.legal_entity_id, r.status::text AS recon_status
           FROM reconciling_items i
           JOIN account_reconciliations r ON r.id = i.account_reconciliation_id
          WHERE i.id = $1
            FOR UPDATE OF i`,
        [itemId],
      );
      const item = rows[0];
      if (!item) throw notFound('Reconciling item', itemId);
      assertEntityPermission(principal, 'reconciliation.manage', item.legal_entity_id);

      if (item.resolved_at !== null) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Reconciling item ${itemId} was already resolved at ${item.resolved_at}. When it ` +
            `cleared is a fact with one answer; a second resolution would overwrite the first.`,
          { details: { resolved_at: item.resolved_at } },
        );
      }

      // Deliberately NO refusal on a CERTIFIED parent: resolution changes no
      // amount — it records the clearance a TIMING item promised, which normally
      // happens after certification. See the file header for the full argument.
      const { rows: updated } = await client.query<{ resolved_at: string }>(
        `UPDATE reconciling_items SET resolved_at = now() WHERE id = $1 RETURNING resolved_at`,
        [itemId],
      );

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: item.legal_entity_id,
        action: 'reconciling_item.resolved',
        resourceType: 'reconciling_item',
        resourceId: itemId,
        reason: input.note ?? null,
        before: { resolved_at: null, reconciliation_status: item.recon_status },
        after: {
          resolved_at: updated[0]!.resolved_at,
          account_reconciliation_id: item.account_reconciliation_id,
          amount: item.amount,
          expected_clear_date: item.expected_clear_date,
        },
      });

      return {
        id: item.id,
        account_reconciliation_id: item.account_reconciliation_id,
        item_type: item.item_type,
        description: item.description,
        amount: item.amount,
        expected_clear_date: item.expected_clear_date,
        resolved_at: updated[0]!.resolved_at,
        reconciliation_status: item.recon_status,
      };
    });
  }
}

async function loadReconciliation(
  client: import('pg').PoolClient,
  id: string,
  lock: 'FOR UPDATE' | '' = '',
): Promise<ReconRow> {
  const { rows } = await client.query<ReconRow>(
    `SELECT id, tenant_id, legal_entity_id, accounting_book_id, accounting_period_id,
            status::text AS status, difference::text AS difference
       FROM account_reconciliations WHERE id = $1 ${lock}`,
    [id],
  );
  const recon = rows[0];
  if (!recon) throw notFound('Account reconciliation', id);
  return recon;
}
