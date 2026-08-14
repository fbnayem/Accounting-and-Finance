import { Pool, PoolClient } from 'pg';
import {
  AppError,
  notFound,
  uuidv7,
  D,
  assertEntityPermission,
  type TenantPrincipal,
} from '@acct/domain';
import { writeInTenant, readInTenant, recordAudit, publish } from '@acct/database';
import { loadWarehouse } from './warehouses.service';

/**
 * Stock counts — doc 08 "Stock count": create scope/snapshot, assign counters,
 * enter counts, recount exceptions, approve variance and post adjustment.
 *
 * The lifecycle is why there are three routes (F-909): a single create could
 * only record the count's first step. Approval is a separate permission
 * (`inventory.count_approve`) because the person who counted must not be the
 * person who accepts the variance — and that is enforced here, not just
 * implied by the permission split.
 */

export class StockCountsService {
  constructor(private readonly pool: Pool) {}

  /**
   * Creates the count with its expected-quantity snapshot. Expected quantities
   * are computed from posted movements AT CREATION and stored on the lines —
   * doc 08: "keep expected and counted values with evidence". A count whose
   * expectation floats with later postings cannot say what its variance means.
   */
  async createCount(
    principal: TenantPrincipal,
    input: {
      warehouseId: string;
      countDate: string;
      itemIds?: readonly string[] | undefined;
      locationIds?: readonly string[] | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const warehouse = await loadWarehouse(client, input.warehouseId);
      assertEntityPermission(principal, 'inventory.count', warehouse.legal_entity_id);

      const id = uuidv7();
      const scope = {
        ...(input.itemIds?.length ? { item_ids: input.itemIds } : {}),
        ...(input.locationIds?.length ? { location_ids: input.locationIds } : {}),
      };
      const { rows } = await client.query<Record<string, unknown>>(
        `INSERT INTO stock_counts
           (id, tenant_id, legal_entity_id, warehouse_id, count_date, scope, status)
         VALUES ($1,$2,$3,$4,$5::date,$6::jsonb,'PLANNED')
         RETURNING id, legal_entity_id, warehouse_id, count_date::text AS count_date, scope,
                   status, created_at`,
        [
          id,
          principal.tenantId,
          warehouse.legal_entity_id,
          input.warehouseId,
          input.countDate,
          JSON.stringify(scope),
        ],
      );

      // On-hand per item and location from posted movements. Each movement
      // touches exactly one location (an inbound has to_location, an outbound
      // from_location), so the signed quantity groups cleanly.
      const { rows: expected } = await client.query<{
        item_id: string;
        location_id: string;
        quantity: string;
      }>(
        `SELECT m.item_id,
                CASE WHEN m.quantity > 0 THEN m.to_location_id ELSE m.from_location_id END
                  AS location_id,
                sum(m.quantity)::text AS quantity
           FROM inventory_movements m
           JOIN inventory_documents d ON d.id = m.inventory_document_id
           JOIN warehouse_locations wl
             ON wl.id = CASE WHEN m.quantity > 0 THEN m.to_location_id ELSE m.from_location_id END
          WHERE d.status IN ('POSTED','CLOSED')
            AND wl.warehouse_id = $1
            AND m.movement_date <= $2::date
            AND ($3::uuid[] IS NULL OR m.item_id = ANY($3::uuid[]))
            AND ($4::uuid[] IS NULL OR wl.id = ANY($4::uuid[]))
          GROUP BY m.item_id, 2
         HAVING sum(m.quantity) <> 0`,
        [
          input.warehouseId,
          input.countDate,
          input.itemIds?.length ? input.itemIds : null,
          input.locationIds?.length ? input.locationIds : null,
        ],
      );

      const lines = [];
      for (const row of expected) {
        const { rows: created } = await client.query<Record<string, unknown>>(
          `INSERT INTO stock_count_lines
             (id, stock_count_id, tenant_id, legal_entity_id, item_id, location_id,
              expected_quantity)
           VALUES ($1,$2,$3,$4,$5,$6,$7::numeric)
           RETURNING id, item_id, location_id, expected_quantity::text AS expected_quantity,
                     counted_quantity, variance_quantity, recount_required`,
          [
            uuidv7(),
            id,
            principal.tenantId,
            warehouse.legal_entity_id,
            row.item_id,
            row.location_id,
            row.quantity,
          ],
        );
        lines.push(created[0]);
      }

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: warehouse.legal_entity_id,
        action: 'stock_count.created',
        resourceType: 'stock_count',
        resourceId: id,
        after: { ...(rows[0] as Record<string, unknown>), line_count: lines.length },
      });

      return { ...rows[0], lines };
    });
  }

  /**
   * F-909: entering and recounting quantities. Counted values may be revised
   * while the count is open — that is what a recount IS — but never after
   * approval, because from then on the variance is the evidence behind an
   * accounting adjustment.
   */
  async updateCount(
    principal: TenantPrincipal,
    id: string,
    input: {
      status?: string | undefined;
      lines?:
        | readonly {
            id: string;
            countedQuantity: string;
            recountRequired?: boolean | undefined;
          }[]
        | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const count = await lockCount(client, id);
      assertEntityPermission(principal, 'inventory.count', count.legal_entity_id);

      if (!['PLANNED', 'COUNTING', 'RECOUNT', 'REVIEW'].includes(count.status)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Count ${id} is ${count.status}; its quantities are now the evidence behind an ` +
            'adjustment and can no longer change (doc 08).',
        );
      }
      if (
        input.status !== undefined &&
        !['COUNTING', 'RECOUNT', 'REVIEW', 'CANCELLED'].includes(input.status)
      ) {
        throw new AppError(
          'VALIDATION_FAILED',
          'Status moves to COUNTING, RECOUNT, REVIEW or CANCELLED here; APPROVED has its own ' +
            'route and permission.',
        );
      }

      const lines = [];
      for (const line of input.lines ?? []) {
        const { rows } = await client.query<Record<string, unknown>>(
          `UPDATE stock_count_lines
              SET counted_quantity = $2::numeric,
                  variance_quantity = $2::numeric - expected_quantity,
                  recount_required = coalesce($3, recount_required),
                  counted_by = $4
            WHERE id = $1 AND stock_count_id = $5
          RETURNING id, item_id, location_id, expected_quantity::text AS expected_quantity,
                    counted_quantity::text AS counted_quantity,
                    variance_quantity::text AS variance_quantity, recount_required, counted_by`,
          [line.id, line.countedQuantity, line.recountRequired ?? null, principal.userId, id],
        );
        if (!rows[0]) throw notFound('stock_count_line', line.id);
        lines.push(rows[0]);
      }

      const { rows: updated } = await client.query<Record<string, unknown>>(
        `UPDATE stock_counts SET status = coalesce($2, status)
          WHERE id = $1
        RETURNING id, legal_entity_id, warehouse_id, count_date::text AS count_date, status`,
        [id, input.status ?? null],
      );

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: count.legal_entity_id,
        action: 'stock_count.updated',
        resourceType: 'stock_count',
        resourceId: id,
        after: { ...(updated[0] as Record<string, unknown>), lines_updated: lines.length },
      });

      return { ...updated[0], lines };
    });
  }

  /**
   * doc 08: "Large variances require approval." Approval freezes the count and
   * creates the DRAFT variance document; posting it — with the separate
   * `inventory.post` permission — is what touches stock and the ledger. The
   * split mirrors F-902's create/post separation everywhere else.
   */
  async approveCount(
    principal: TenantPrincipal,
    id: string,
    input: { accountingBookId: string; postingDate?: string | undefined },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const count = await lockCount(client, id);
      assertEntityPermission(principal, 'inventory.count_approve', count.legal_entity_id);

      if (count.status === 'APPROVED' || count.status === 'POSTED') {
        // Idempotent: the second approval returns the first.
        return readBackApproved(client, id);
      }
      if (!['COUNTING', 'RECOUNT', 'REVIEW'].includes(count.status)) {
        throw new AppError('VALIDATION_FAILED', `Count ${id} is ${count.status}.`);
      }

      const { rows: lines } = await client.query<{
        id: string;
        item_id: string;
        location_id: string | null;
        counted_quantity: string | null;
        variance_quantity: string | null;
        counted_by: string | null;
      }>(
        `SELECT id, item_id, location_id, counted_quantity::text AS counted_quantity,
                variance_quantity::text AS variance_quantity, counted_by
           FROM stock_count_lines WHERE stock_count_id = $1`,
        [id],
      );

      const uncounted = lines.filter((l) => l.counted_quantity === null);
      if (uncounted.length > 0) {
        throw new AppError(
          'VALIDATION_FAILED',
          `${uncounted.length} line(s) have no counted quantity. Approving an incomplete count ` +
            'would book a variance for stock nobody looked at.',
        );
      }
      if (lines.some((l) => l.counted_by === principal.userId)) {
        // The reason count_approve is a separate permission, made effective:
        // holding both permissions must not collapse the two roles into one
        // person on the same count.
        throw new AppError(
          'SEGREGATION_OF_DUTIES',
          'You entered counted quantities on this count, so you cannot also accept its variance ' +
            '(doc 08: large variances require approval — by someone else).',
        );
      }

      // The variance document. DRAFT, movements signed by the variance; the
      // ADJUSTMENT posting path values losses by layer consumption and gains
      // at current average. Created only when something varied.
      const variances = lines.filter(
        (l) => l.variance_quantity !== null && !D(l.variance_quantity).isZero(),
      );
      let documentId: string | null = null;
      if (variances.length > 0) {
        documentId = uuidv7();
        const postingDate = input.postingDate ?? count.count_date;
        await client.query(
          `INSERT INTO inventory_documents
             (id, tenant_id, legal_entity_id, accounting_book_id, document_type, document_date,
              posting_date, warehouse_id, source_type, source_id, metadata)
           VALUES ($1,$2,$3,$4,'COUNT',$5::date,$6::date,$7,'stock_count',$8,$9::jsonb)`,
          [
            documentId,
            principal.tenantId,
            count.legal_entity_id,
            input.accountingBookId,
            count.count_date,
            postingDate,
            count.warehouse_id,
            id,
            JSON.stringify({ stock_count_id: id }),
          ],
        );
        for (const [i, line] of variances.entries()) {
          const variance = D(line.variance_quantity as string);
          const { rows: itemRows } = await client.query<{ base_uom: string }>(
            `SELECT base_uom FROM items WHERE id = $1`,
            [line.item_id],
          );
          if (!itemRows[0]) throw notFound('item', line.item_id);
          await client.query(
            `INSERT INTO inventory_movements
               (id, tenant_id, legal_entity_id, inventory_document_id, line_no, item_id,
                from_location_id, to_location_id, movement_date, quantity, uom, stock_lot_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10::numeric,$11,$12)`,
            [
              uuidv7(),
              principal.tenantId,
              count.legal_entity_id,
              documentId,
              i + 1,
              line.item_id,
              variance.isNegative() ? line.location_id : null,
              variance.isPositive() ? line.location_id : null,
              postingDate,
              variance.toString(),
              itemRows[0].base_uom,
              null,
            ],
          );
        }
      }

      const { rows: approved } = await client.query<Record<string, unknown>>(
        `UPDATE stock_counts
            SET status = 'APPROVED', approved_by = $2, inventory_document_id = $3
          WHERE id = $1
        RETURNING id, legal_entity_id, warehouse_id, count_date::text AS count_date, status,
                  approved_by, inventory_document_id`,
        [id, principal.userId, documentId],
      );

      await publish(client, context, {
        eventType: 'inventory.count_completed',
        aggregateType: 'stock_count',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: count.legal_entity_id,
        accountingBookId: input.accountingBookId,
        payload: { variance_lines: variances.length, inventory_document_id: documentId },
      });

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: count.legal_entity_id,
        action: 'stock_count.approved',
        resourceType: 'stock_count',
        resourceId: id,
        after: approved[0] as Record<string, unknown>,
      });

      return approved[0];
    });
  }

  async getCount(principal: TenantPrincipal, id: string) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `SELECT id, legal_entity_id, warehouse_id, inventory_document_id,
                count_date::text AS count_date, scope, status, approved_by, created_at
           FROM stock_counts WHERE id = $1`,
        [id],
      );
      const count = rows[0];
      if (!count) throw notFound('stock_count', id);
      const { rows: lines } = await client.query(
        `SELECT id, item_id, location_id, stock_lot_id,
                expected_quantity::text AS expected_quantity,
                counted_quantity::text AS counted_quantity,
                variance_quantity::text AS variance_quantity, recount_required, counted_by
           FROM stock_count_lines WHERE stock_count_id = $1
          ORDER BY item_id, location_id`,
        [id],
      );
      return { ...count, lines };
    });
  }
}

interface CountRow {
  id: string;
  legal_entity_id: string;
  warehouse_id: string;
  count_date: string;
  status: string;
}

async function lockCount(client: PoolClient, id: string): Promise<CountRow> {
  const { rows } = await client.query<CountRow>(
    `SELECT id, legal_entity_id, warehouse_id, count_date::text AS count_date,
            status
       FROM stock_counts WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const count = rows[0];
  if (!count) throw notFound('stock_count', id);
  return count;
}

async function readBackApproved(client: PoolClient, id: string): Promise<Record<string, unknown>> {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT id, legal_entity_id, warehouse_id, count_date::text AS count_date, status,
            approved_by, inventory_document_id
       FROM stock_counts WHERE id = $1`,
    [id],
  );
  return rows[0] as Record<string, unknown>;
}
