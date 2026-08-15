import { Pool, PoolClient } from 'pg';
import {
  AppError,
  notFound,
  uuidv7,
  D,
  Decimal,
  MONEY_SCALE,
  sumExact,
  assertEntityPermission,
  consumeFifo,
  consumeWeightedAverage,
  averageUnitCost,
  type TenantPrincipal,
  type DraftLineInput,
  type LayerConsumption,
  type RoundingMode,
} from '@acct/domain';
import { writeInTenant, readInTenant, recordAudit, publish } from '@acct/database';
import { PostingService, type BookContext } from '@acct/ledger';
import { DocumentPostingService } from '@acct/subledger';
import {
  loadItemContexts,
  loadLocations,
  policyAccount,
  requireItemAccount,
  type ItemContext,
  type LocationContext,
} from './lookup';
import {
  mirrorMovement,
  movementValue,
  spreadCostAcrossTakes,
  weightedAveragePoolValue,
} from './stock';

/**
 * Posting and reversing inventory documents — F-902 and F-908, and the home of
 * the two behaviours Phase 5 is judged on:
 *
 *   - The issue path consumes cost layers under SELECT ... FOR UPDATE ordered
 *     by (received_date, id) — ADR-0004 §3 verbatim. Exit criterion 2 is about
 *     CONCURRENT issues, and the lock order is the entire mechanism: two issues
 *     racing for the last layer serialise on its row, and the loser re-reads a
 *     remaining quantity that is already spent, at which point the configured
 *     negative-stock policy — not luck — decides what happens.
 *
 *   - Every issue writes one `inventory_cost_consumptions` row per layer it
 *     touched. Exit criterion 3 reproduces COGS by summing those rows, and
 *     `getMovementCostBreakdown` returns them.
 *
 * The order inside a posting is fixed by 0043: movement costs are written while
 * the document is still DRAFT, because `guard_posted_document_lines` freezes
 * the movements the instant the header says POSTED.
 */

interface DocumentRow {
  id: string;
  legal_entity_id: string;
  accounting_book_id: string;
  branch_id: string | null;
  document_type: string;
  document_number: string | null;
  document_date: string;
  posting_date: string;
  status: string;
  warehouse_id: string | null;
  purchase_order_id: string | null;
  source_type: string | null;
  source_id: string | null;
  accounting_entry_id: string | null;
}

interface MovementRow {
  id: string;
  line_no: number;
  item_id: string;
  from_location_id: string | null;
  to_location_id: string | null;
  quantity: string;
  uom: string;
  stock_lot_id: string | null;
  serial_unit_id: string | null;
  unit_cost: string | null;
  total_cost: string | null;
}

interface ConsumedChunk {
  readonly layerId: string;
  readonly quantity: Decimal;
  readonly unitCost: Decimal;
  readonly cost: Decimal;
  readonly receivedDate: string;
  readonly isProvisional: boolean;
}

interface MovementCost {
  readonly movementId: string;
  readonly unitCost: Decimal;
  readonly totalCost: Decimal;
  readonly method: string;
}

const EVENT_BY_TYPE: Record<string, string> = {
  RECEIPT: 'inventory.received',
  ISSUE: 'inventory.issued',
  TRANSFER: 'inventory.transferred',
  ADJUSTMENT: 'inventory.adjusted',
  COUNT: 'inventory.adjusted',
  CUSTOMER_RETURN: 'inventory.returned',
  VENDOR_RETURN: 'inventory.returned',
};

export class InventoryPostingService {
  constructor(
    private readonly pool: Pool,
    private readonly posting: PostingService,
    private readonly documents: DocumentPostingService,
  ) {}

  // =========================================================================
  // Post — F-902
  // =========================================================================

  async postDocument(principal: TenantPrincipal, id: string) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const doc = await lockDocument(client, id);
      assertEntityPermission(principal, 'inventory.post', doc.legal_entity_id);

      // Idempotent, like postGoodsReceipt: the second attempt returns the
      // first outcome instead of failing or posting twice.
      if (doc.status === 'POSTED' || doc.status === 'CLOSED') return doc;
      if (doc.status !== 'DRAFT' && doc.status !== 'APPROVED') {
        throw new AppError(
          'VALIDATION_FAILED',
          `Document ${id} is ${doc.status} and cannot be posted.`,
        );
      }

      const book = await this.posting.loadBookContext(
        client,
        principal,
        doc.accounting_book_id,
        doc.posting_date,
      );
      const movements = await loadMovements(client, id);
      if (movements.length === 0) {
        throw new AppError(
          'VALIDATION_FAILED',
          'This document has no movements; posting it would record that nothing happened.',
        );
      }

      const items = await loadItemContexts(
        client,
        movements.map((m) => m.item_id),
        book.legalEntityId,
      );
      const locations = await loadLocations(
        client,
        movements.flatMap((m) =>
          [m.from_location_id, m.to_location_id].filter((v): v is string => v !== null),
        ),
      );

      const outcome = await this.applyStock(
        client,
        principal,
        book,
        doc,
        movements,
        items,
        locations,
      );

      // Movement costs BEFORE the status flip: guard_posted_document_lines
      // (0043) freezes movements the moment the header is POSTED, exactly as
      // invoice posting has worked since 0036.
      for (const cost of outcome.costs) {
        await client.query(
          `UPDATE inventory_movements
              SET unit_cost = $2::numeric, total_cost = $3::numeric, currency = $4,
                  cost_method = $5::valuation_method
            WHERE id = $1`,
          [
            cost.movementId,
            cost.unitCost.toString(),
            cost.totalCost.toString(),
            book.baseCurrency,
            cost.method,
          ],
        );
      }

      let entryId: string | null = null;
      if (doc.document_type === 'RECEIPT' && doc.source_type === 'goods_receipt') {
        // DO NOT POST. Phase 3's postGoodsReceipt already posted Dr destination
        // / Cr GRNI for this delivery, and doc 08's INVENTORY_RECEIPT_AGAINST_PO
        // is that same posting — Phase 3's own record says "a goods receipt is
        // a procurement fact, not a stock move; the inventory movement is one of
        // its consequences and arrives in Phase 5". This posting adds the STOCK
        // consequence — the movements and the cost layers written above — and a
        // second accrual here would debit the inventory control twice, failing
        // exit criterion 1 by construction. The document links to the accrual
        // the goods receipt already posted, so the drill from stock to journal
        // still lands somewhere true.
        entryId = await goodsReceiptEntryId(client, doc);
      } else if (outcome.lines.length > 0) {
        const result = await this.documents.post(client, context, principal, book, {
          ruleCode: outcome.ruleCode,
          sourceType: 'inventory_document',
          sourceId: id,
          sourceEventId: `inventory_document.posted:${id}`,
          journalCode: outcome.journalCode,
          postingDate: doc.posting_date,
          documentDate: doc.document_date,
          description:
            `${doc.document_type.replace(/_/g, ' ').toLowerCase()} ` +
            `${doc.document_number ?? id}`.trim(),
          branchId: doc.branch_id,
          contactId: null,
          lines: outcome.lines,
        });
        entryId = result.entry.id;
      }
      // A TRANSFER (and a genuinely zero-cost movement) posts no journal at
      // all: doc 08 — no revenue/expense unless entities differ, and both
      // sides of a same-entity transfer sit in the same inventory control.

      const { rows: posted } = await client.query<Record<string, unknown>>(
        `UPDATE inventory_documents SET status = 'POSTED', accounting_entry_id = $2
          WHERE id = $1
        RETURNING id, legal_entity_id, accounting_book_id,
                  document_type::text AS document_type, document_number,
                  posting_date::text AS posting_date, status::text AS status,
                  warehouse_id, source_type, source_id, accounting_entry_id`,
        [id, entryId],
      );

      await publish(client, context, {
        eventType: EVENT_BY_TYPE[doc.document_type] ?? 'inventory.adjusted',
        aggregateType: 'inventory_document',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: doc.legal_entity_id,
        accountingBookId: doc.accounting_book_id,
        payload: {
          document_type: doc.document_type,
          document_number: doc.document_number,
          journal_entry_id: entryId,
        },
      });

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: doc.legal_entity_id,
        action: 'inventory_document.posted',
        resourceType: 'inventory_document',
        resourceId: id,
        after: posted[0] as Record<string, unknown>,
      });

      return posted[0];
    });
  }

  // =========================================================================
  // Reverse — F-908: the correction half of "posted movement is immutable"
  // =========================================================================

  async reverseDocument(
    principal: TenantPrincipal,
    id: string,
    input: { postingDate?: string | undefined; reason?: string | undefined } = {},
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const original = await lockDocument(client, id);
      assertEntityPermission(principal, 'inventory.post', original.legal_entity_id);

      if (original.status !== 'POSTED') {
        throw new AppError(
          'VALIDATION_FAILED',
          `Document ${id} is ${original.status}; only a posted document has anything to reverse. ` +
            'A draft is simply edited.',
        );
      }

      // A reversal is not itself reversible, and this is a refusal rather than
      // a gap. Mirroring a reversal mirrors its JOURNAL correctly and does
      // nothing at all to the stock: the layers a reversal restored were not
      // created by it, so `unwindCreatedLayers` finds none to take back, and
      // the consumptions it gave back are already given back. The result was a
      // journal that moved the control account with no cost fact behind it —
      // the same class of defect as F-923 one step along. Re-doing what the
      // original document did is a new document, which is also the honest
      // record: the goods moved twice.
      if (original.source_type === 'reversal') {
        throw new AppError(
          'VALIDATION_FAILED',
          `Document ${id} is itself the reversal of ${original.source_id ?? 'another document'}. ` +
            'A correction of a correction is a new document, not a reversal of a reversal — post ' +
            'the movement again if it should stand (doc 08: correction creates reverse movement).',
          { details: { document_id: id, reverses: original.source_id } },
        );
      }

      // Idempotent: a reversal of a reversal-of-X returns the existing one.
      const { rows: priorReversals } = await client.query<Record<string, unknown>>(
        `SELECT id, document_type::text AS document_type, status::text AS status,
                accounting_entry_id
           FROM inventory_documents
          WHERE source_type = 'reversal' AND source_id = $1 AND status = 'POSTED'`,
        [id],
      );
      if (priorReversals[0]) return priorReversals[0];

      const movements = await loadMovements(client, id);

      // The original period may have closed since; the same fallback vendor
      // payment reversal uses — reverse into today when the original period no
      // longer accepts entries, unless the caller chose a date.
      let reversalDate = input.postingDate ?? original.posting_date;
      if (!input.postingDate) {
        const period = await this.posting.resolvePeriod(client, principal, {
          legalEntityId: original.legal_entity_id,
          postingDate: original.posting_date,
        });
        if (period.status !== 'OPEN') reversalDate = todayIso();
      }

      const book = await this.posting.loadBookContext(
        client,
        principal,
        original.accounting_book_id,
        reversalDate,
      );

      // The reversal is itself a document of the same type, so the movement
      // history reads as two physical events — doc 08's "correction creates
      // reverse movement", not an erasure.
      const reversalId = uuidv7();
      await client.query(
        `INSERT INTO inventory_documents
           (id, tenant_id, legal_entity_id, accounting_book_id, branch_id, document_type,
            document_date, posting_date, warehouse_id, source_type, source_id, metadata)
         VALUES ($1,$2,$3,$4,$5,$6::inventory_doc_type,$7::date,$8::date,$9,'reversal',$10,
                 $11::jsonb)`,
        [
          reversalId,
          principal.tenantId,
          original.legal_entity_id,
          original.accounting_book_id,
          original.branch_id,
          original.document_type,
          reversalDate,
          reversalDate,
          original.warehouse_id,
          id,
          JSON.stringify({ reverses: id, ...(input.reason ? { reason: input.reason } : {}) }),
        ],
      );

      const costs: MovementCost[] = [];
      for (const movement of movements) {
        const mirrored = mirrorMovement(movement);
        const mirroredId = uuidv7();
        await client.query(
          `INSERT INTO inventory_movements
             (id, tenant_id, legal_entity_id, inventory_document_id, line_no, item_id,
              from_location_id, to_location_id, movement_date, quantity, uom, stock_lot_id,
              serial_unit_id, unit_cost, currency)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10::numeric,$11,$12,$13,$14::numeric,$15)`,
          [
            mirroredId,
            principal.tenantId,
            original.legal_entity_id,
            reversalId,
            movement.line_no,
            mirrored.itemId,
            mirrored.fromLocationId,
            mirrored.toLocationId,
            reversalDate,
            mirrored.quantity.toString(),
            mirrored.uom,
            mirrored.stockLotId,
            mirrored.serialUnitId,
            movement.unit_cost,
            movement.unit_cost === null ? null : book.baseCurrency,
          ],
        );

        const quantity = D(movement.quantity);
        if (quantity.isPositive()) {
          // The original brought stock in and created layers; the reversal
          // takes exactly those layers back out. If any of them has since been
          // consumed, the stock is not there to un-receive — the correction for
          // that state is an adjustment, not a reversal that would drive the
          // layer negative.
          await this.unwindCreatedLayers(client, principal, book, movement, mirroredId);
        } else {
          // The original consumed layers; the reversal restores each one it
          // drew from, at the same quantity AND the same value — which is what
          // "reverse movement restores quantity/value correctly" (doc 08
          // acceptance) means at the layer grain. The value half is F-923.
          await restoreConsumedLayers(client, principal, book, movement.id, mirroredId);
        }
        costs.push({
          movementId: mirroredId,
          unitCost: movement.unit_cost === null ? Decimal.zero(MONEY_SCALE) : D(movement.unit_cost),
          totalCost:
            movement.total_cost === null ? Decimal.zero(MONEY_SCALE) : D(movement.total_cost),
          method: 'FIFO',
        });
      }

      for (const cost of costs) {
        await client.query(
          `UPDATE inventory_movements
              SET total_cost = $2::numeric, currency = $3 WHERE id = $1`,
          [cost.movementId, cost.totalCost.toString(), book.baseCurrency],
        );
      }

      let entryId: string | null = null;
      if (original.accounting_entry_id) {
        // Mirror the exact journal the original produced, whatever produced
        // it. For a manual receipt or an issue that is this package's own
        // entry; for a goods-receipt-backed receipt it is the GRNI accrual
        // Phase 3 posted — and reversing it here is correct, because the stock
        // going back means the delivery's accrual must not stand either.
        // `reversal_of_id` is filled so the ledger's own drill chain pairs the
        // two entries (doc 01 rule 4).
        const originalLines = await this.posting.readLines(client, original.accounting_entry_id);
        const mirroredLines: DraftLineInput[] = originalLines.map((line) => ({
          ...line,
          debit: line.credit,
          credit: line.debit,
        }));
        const result = await this.documents.post(client, context, principal, book, {
          ruleCode: 'INVENTORY_MOVEMENT_REVERSED',
          sourceType: 'inventory_document',
          sourceId: reversalId,
          sourceEventId: `inventory_document.reversed:${id}`,
          journalCode: 'GEN',
          postingDate: reversalDate,
          documentDate: reversalDate,
          description: `Reversal of ${original.document_type.toLowerCase()} ${
            original.document_number ?? id
          }`,
          branchId: original.branch_id,
          contactId: null,
          reversalOfId: original.accounting_entry_id,
          lines: mirroredLines,
        });
        entryId = result.entry.id;
      }

      const { rows: posted } = await client.query<Record<string, unknown>>(
        `UPDATE inventory_documents SET status = 'POSTED', accounting_entry_id = $2
          WHERE id = $1
        RETURNING id, legal_entity_id, accounting_book_id,
                  document_type::text AS document_type, document_number,
                  posting_date::text AS posting_date, status::text AS status, source_type,
                  source_id, accounting_entry_id`,
        [reversalId, entryId],
      );

      // The original stays POSTED — it happened — but its metadata records who
      // cancelled it, so a reader starting from the original finds the pair.
      await client.query(
        `UPDATE inventory_documents
            SET metadata = metadata || jsonb_build_object('reversed_by', $2::text)
          WHERE id = $1`,
        [id, reversalId],
      );

      await publish(client, context, {
        eventType: 'inventory.adjusted',
        aggregateType: 'inventory_document',
        aggregateId: reversalId,
        tenantId: principal.tenantId,
        legalEntityId: original.legal_entity_id,
        accountingBookId: original.accounting_book_id,
        payload: { reverses: id, journal_entry_id: entryId },
      });

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: original.legal_entity_id,
        action: 'inventory_document.reversed',
        resourceType: 'inventory_document',
        resourceId: id,
        reason: input.reason ?? null,
        after: posted[0] as Record<string, unknown>,
      });

      return posted[0];
    });
  }

  // =========================================================================
  // Cost breakdown — F-903: exit criterion 3's door
  // =========================================================================

  async movementCostBreakdown(principal: TenantPrincipal, movementId: string) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `SELECT m.id, m.inventory_document_id, m.line_no, m.item_id, m.quantity::text AS quantity,
                m.uom, m.unit_cost::text AS unit_cost, m.total_cost::text AS total_cost,
                m.currency, m.cost_method::text AS cost_method,
                d.document_type::text AS document_type, d.status::text AS status
           FROM inventory_movements m
           JOIN inventory_documents d ON d.id = m.inventory_document_id
          WHERE m.id = $1`,
        [movementId],
      );
      const movement = rows[0];
      if (!movement) throw notFound('inventory_movement', movementId);

      const { rows: consumptions } = await client.query<{
        cost_layer_id: string;
        quantity: string;
        unit_cost: string;
        total_cost: string;
        received_date: string;
        source_movement_id: string;
        is_provisional: boolean;
        layer_unit_cost: string;
      }>(
        `SELECT c.cost_layer_id, c.quantity::text AS quantity, c.unit_cost::text AS unit_cost,
                c.total_cost::text AS total_cost, l.received_date::text AS received_date,
                l.source_movement_id, l.is_provisional, l.unit_cost::text AS layer_unit_cost
           FROM inventory_cost_consumptions c
           JOIN inventory_cost_layers l ON l.id = c.cost_layer_id
          WHERE c.inventory_movement_id = $1
          ORDER BY l.received_date, l.id`,
        [movementId],
      );

      // The other direction a movement can move value: the consumptions a
      // reversal gave back (F-923). A movement never has both — it either drew
      // layers down or gave drawn ones back — and each row here names the
      // consumption it reverses, so the restored amount is the consumed amount
      // rather than a second copy of it that could disagree.
      const { rows: restorations } = await client.query<{
        cost_layer_id: string;
        quantity: string;
        unit_cost: string;
        total_cost: string;
        received_date: string;
        restored_consumption_id: string;
        restored_movement_id: string;
      }>(
        `SELECT c.cost_layer_id, c.quantity::text AS quantity, c.unit_cost::text AS unit_cost,
                c.total_cost::text AS total_cost, l.received_date::text AS received_date,
                c.id AS restored_consumption_id,
                c.inventory_movement_id AS restored_movement_id
           FROM inventory_cost_restorations r
           JOIN inventory_cost_consumptions c ON c.id = r.inventory_cost_consumption_id
           JOIN inventory_cost_layers l ON l.id = c.cost_layer_id
          WHERE r.inventory_movement_id = $1
          ORDER BY l.received_date, l.id`,
        [movementId],
      );

      // Recomputed here rather than echoed, so the response demonstrates the
      // reproduction instead of asserting it: the sum of the stored rows IS
      // the value the movement moved, and `reproduces_movement_total` says
      // whether it still equals what the movement posted. Both kinds of row
      // are magnitudes, as `inventory_movements.total_cost` is — the direction
      // lives in the movement's signed quantity — so the reversal of an issue
      // reproduces its own total from the rows it restored, exactly as an issue
      // does from the rows it consumed.
      const total = sumExact([
        ...consumptions.map((c) => D(c.total_cost)),
        ...restorations.map((r) => D(r.total_cost)),
      ]);
      return {
        movement,
        consumptions,
        restorations,
        total_cost: total.toString(),
        reproduces_movement_total:
          movement.total_cost === null ? null : total.equals(D(movement.total_cost as string)),
      };
    });
  }

  // =========================================================================
  // Stock application per document type
  // =========================================================================

  private async applyStock(
    client: PoolClient,
    principal: TenantPrincipal,
    book: BookContext,
    doc: DocumentRow,
    movements: readonly MovementRow[],
    items: Map<string, ItemContext>,
    locations: Map<string, LocationContext>,
  ): Promise<{
    lines: DraftLineInput[];
    ruleCode: string;
    journalCode: string;
    costs: MovementCost[];
  }> {
    switch (doc.document_type) {
      case 'RECEIPT':
        return this.applyInbound(client, principal, book, doc, movements, items, locations, {
          creditSide: 'GRNI',
          ruleCode: 'GOODS_RECEIPT_ACCRUAL',
          journalCode: 'PUR',
        });
      case 'CUSTOMER_RETURN':
        return this.applyInbound(client, principal, book, doc, movements, items, locations, {
          creditSide: 'COGS',
          ruleCode: 'INVENTORY_CUSTOMER_RETURN',
          journalCode: 'GEN',
        });
      case 'ISSUE':
        return this.applyOutbound(client, principal, book, doc, movements, items, locations, {
          debitSide: 'COGS',
          ruleCode: 'INVENTORY_ISSUE_FOR_SALE',
        });
      case 'VENDOR_RETURN':
        return this.applyOutbound(client, principal, book, doc, movements, items, locations, {
          debitSide: 'GRNI',
          ruleCode: 'INVENTORY_VENDOR_RETURN',
        });
      case 'TRANSFER':
        return this.applyTransfer(client, principal, book, doc, movements, items, locations);
      case 'ADJUSTMENT':
      case 'COUNT':
      case 'WRITE_OFF':
        return this.applyAdjustment(client, principal, book, doc, movements, items, locations);
      default:
        throw new AppError(
          'NOT_IMPLEMENTED',
          `Posting for document type ${doc.document_type} is not implemented.`,
        );
    }
  }

  /** RECEIPT and CUSTOMER_RETURN: stock in, one new cost layer per movement. */
  private async applyInbound(
    client: PoolClient,
    principal: TenantPrincipal,
    book: BookContext,
    doc: DocumentRow,
    movements: readonly MovementRow[],
    items: Map<string, ItemContext>,
    locations: Map<string, LocationContext>,
    accounting: { creditSide: 'GRNI' | 'COGS'; ruleCode: string; journalCode: string },
  ) {
    const lines: DraftLineInput[] = [];
    const costs: MovementCost[] = [];
    const credits: { accountId: string; amount: Decimal; description: string }[] = [];

    for (const movement of movements) {
      const item = items.get(movement.item_id)!;
      const quantity = D(movement.quantity);
      if (!quantity.isPositive() || movement.to_location_id === null) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Movement ${movement.line_no} of a ${doc.document_type} must bring stock in.`,
        );
      }
      if (movement.unit_cost === null) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Movement ${movement.line_no} has no unit cost to build a layer from.`,
        );
      }
      const unitCost = D(movement.unit_cost);
      const value = movementValue(quantity, unitCost, book.baseCurrency, book.roundingMode);
      const warehouseId = locations.get(movement.to_location_id)!.warehouseId;

      await this.createLayer(client, principal, book, {
        itemId: item.id,
        warehouseId,
        sourceMovementId: movement.id,
        receivedDate: doc.posting_date,
        quantity,
        unitCost,
        provisional: false,
      });
      costs.push({ movementId: movement.id, unitCost, totalCost: value, method: item.valuation });

      if (value.isZero()) continue;
      lines.push({
        accountId: requireItemAccount(item, 'inventoryAccountId'),
        description: `${item.sku} × ${quantity.toString()}`,
        debit: value.toString(),
      });
      credits.push({
        accountId:
          accounting.creditSide === 'GRNI'
            ? await this.grniAccount(client, book, doc.posting_date)
            : requireItemAccount(item, 'cogsAccountId'),
        amount: value,
        description:
          accounting.creditSide === 'GRNI'
            ? 'Goods received not invoiced'
            : `${item.sku} return at original issue cost`,
      });
    }

    // GRNI credits collapse to one line — it is one accrual account and doc
    // 08's pattern is one credit. COGS credits stay per item: each item's own
    // COGS account must receive its own restoration.
    if (accounting.creditSide === 'GRNI') {
      const total = sumExact(credits.map((c) => c.amount));
      if (!total.isZero()) {
        lines.push({
          accountId: (credits[0] as { accountId: string }).accountId,
          description: 'Goods received not invoiced',
          credit: total.toString(),
        });
      }
    } else {
      for (const credit of credits) {
        lines.push({
          accountId: credit.accountId,
          description: credit.description,
          credit: credit.amount.toString(),
        });
      }
    }

    return { lines, ruleCode: accounting.ruleCode, journalCode: accounting.journalCode, costs };
  }

  /** ISSUE and VENDOR_RETURN: stock out through layer consumption. */
  private async applyOutbound(
    client: PoolClient,
    principal: TenantPrincipal,
    book: BookContext,
    doc: DocumentRow,
    movements: readonly MovementRow[],
    items: Map<string, ItemContext>,
    locations: Map<string, LocationContext>,
    accounting: { debitSide: 'COGS' | 'GRNI'; ruleCode: string },
  ) {
    const lines: DraftLineInput[] = [];
    const costs: MovementCost[] = [];

    for (const movement of movements) {
      const item = items.get(movement.item_id)!;
      const quantity = D(movement.quantity);
      if (!quantity.isNegative() || movement.from_location_id === null) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Movement ${movement.line_no} of a ${doc.document_type} must take stock out.`,
        );
      }
      const warehouseId = locations.get(movement.from_location_id)!.warehouseId;
      const consumed = await this.consumeStock(
        client,
        principal,
        book,
        doc,
        movement,
        item,
        warehouseId,
      );

      const totalCost = sumExact(consumed.map((c) => c.cost));
      const qty = quantity.abs();
      costs.push({
        movementId: movement.id,
        unitCost: totalCost.div(qty, MONEY_SCALE, book.roundingMode),
        totalCost,
        method: item.valuation,
      });

      if (totalCost.isZero()) continue;
      lines.push({
        accountId:
          accounting.debitSide === 'COGS'
            ? requireItemAccount(item, 'cogsAccountId')
            : await this.grniAccount(client, book, doc.posting_date),
        description:
          accounting.debitSide === 'COGS'
            ? `COGS ${item.sku} × ${qty.toString()}`
            : `Vendor return ${item.sku} × ${qty.toString()}`,
        debit: totalCost.toString(),
      });
      lines.push({
        accountId: requireItemAccount(item, 'inventoryAccountId'),
        description: `${item.sku} × ${qty.toString()}`,
        credit: totalCost.toString(),
      });
    }

    return { lines, ruleCode: accounting.ruleCode, journalCode: 'GEN', costs };
  }

  /**
   * TRANSFER: consume at the source warehouse, recreate the same cost chunks
   * at the destination. No journal — doc 08: "no revenue/expense unless
   * entities differ", and a document is single-entity by schema. The received
   * dates travel with the chunks so a transferred layer keeps its FIFO age; a
   * transfer that reset the clock would let old stock jump the queue by
   * commuting between warehouses.
   */
  private async applyTransfer(
    client: PoolClient,
    principal: TenantPrincipal,
    book: BookContext,
    doc: DocumentRow,
    movements: readonly MovementRow[],
    items: Map<string, ItemContext>,
    locations: Map<string, LocationContext>,
  ) {
    const costs: MovementCost[] = [];

    for (let i = 0; i < movements.length; i += 2) {
      const out = movements[i];
      const into = movements[i + 1];
      if (
        !out ||
        !into ||
        !D(out.quantity).isNegative() ||
        !D(into.quantity).isPositive() ||
        out.item_id !== into.item_id ||
        !D(out.quantity).add(D(into.quantity)).isZero()
      ) {
        throw new AppError(
          'VALIDATION_FAILED',
          'Transfer movements must arrive as out/in pairs of the same item and quantity — the ' +
            'shape createTransfer writes. This document was not built by it.',
        );
      }
      const item = items.get(out.item_id)!;
      const sourceWarehouse = locations.get(out.from_location_id as string)!.warehouseId;
      const targetWarehouse = locations.get(into.to_location_id as string)!.warehouseId;

      const consumed = await this.consumeStock(
        client,
        principal,
        book,
        doc,
        out,
        item,
        sourceWarehouse,
      );

      for (const chunk of consumed) {
        await this.createLayer(client, principal, book, {
          itemId: item.id,
          warehouseId: targetWarehouse,
          sourceMovementId: into.id,
          receivedDate: chunk.receivedDate,
          quantity: chunk.quantity,
          unitCost: chunk.unitCost,
          // A provisional chunk stays provisional across the move, so the
          // negative-stock exception remains visible wherever the stock sits.
          provisional: chunk.isProvisional,
        });
      }

      const totalCost = sumExact(consumed.map((c) => c.cost));
      const qty = D(out.quantity).abs();
      const unitCost = qty.isZero()
        ? Decimal.zero(MONEY_SCALE)
        : totalCost.div(qty, MONEY_SCALE, book.roundingMode);
      costs.push({ movementId: out.id, unitCost, totalCost, method: item.valuation });
      costs.push({ movementId: into.id, unitCost, totalCost, method: item.valuation });
    }

    return { lines: [], ruleCode: 'INVENTORY_TRANSFER', journalCode: 'GEN', costs };
  }

  /** ADJUSTMENT and COUNT variance: gains build layers, losses consume them. */
  private async applyAdjustment(
    client: PoolClient,
    principal: TenantPrincipal,
    book: BookContext,
    doc: DocumentRow,
    movements: readonly MovementRow[],
    items: Map<string, ItemContext>,
    locations: Map<string, LocationContext>,
  ) {
    const lines: DraftLineInput[] = [];
    const costs: MovementCost[] = [];
    let gains = Decimal.zero(MONEY_SCALE);
    let losses = Decimal.zero(MONEY_SCALE);

    for (const movement of movements) {
      const item = items.get(movement.item_id)!;
      const quantity = D(movement.quantity);

      if (quantity.isPositive()) {
        const warehouseId = locations.get(movement.to_location_id as string)!.warehouseId;
        // A gain has no purchase behind it, so its cost is the explicit one on
        // the line or, failing that, the current average of what is already on
        // hand — the least-surprising value for stock that was evidently
        // received and never recorded.
        let unitCost = movement.unit_cost === null ? null : D(movement.unit_cost);
        if (unitCost === null) {
          unitCost = await this.currentAverageCost(client, book, item.id, warehouseId);
        }
        if (unitCost === null) {
          throw new AppError(
            'VALIDATION_FAILED',
            `Movement ${movement.line_no}: a gain of ${item.sku} needs a unit cost — there are ` +
              'no existing layers to average from.',
          );
        }
        const value = movementValue(quantity, unitCost, book.baseCurrency, book.roundingMode);
        await this.createLayer(client, principal, book, {
          itemId: item.id,
          warehouseId,
          sourceMovementId: movement.id,
          receivedDate: doc.posting_date,
          quantity,
          unitCost,
          provisional: false,
        });
        costs.push({ movementId: movement.id, unitCost, totalCost: value, method: item.valuation });
        gains = gains.add(value);
        if (value.isZero()) continue;
        lines.push({
          accountId: requireItemAccount(item, 'inventoryAccountId'),
          description: `Gain ${item.sku} × ${quantity.toString()}`,
          debit: value.toString(),
        });
        lines.push({
          accountId: requireItemAccount(item, 'varianceAccountId'),
          description: `Inventory gain ${item.sku}`,
          credit: value.toString(),
        });
      } else {
        const warehouseId = locations.get(movement.from_location_id as string)!.warehouseId;
        const consumed = await this.consumeStock(
          client,
          principal,
          book,
          doc,
          movement,
          item,
          warehouseId,
        );
        const totalCost = sumExact(consumed.map((c) => c.cost));
        const qty = quantity.abs();
        costs.push({
          movementId: movement.id,
          unitCost: totalCost.div(qty, MONEY_SCALE, book.roundingMode),
          totalCost,
          method: item.valuation,
        });
        losses = losses.add(totalCost);
        if (totalCost.isZero()) continue;
        lines.push({
          accountId: requireItemAccount(item, 'varianceAccountId'),
          description: `Shrinkage ${item.sku} × ${qty.toString()}`,
          debit: totalCost.toString(),
        });
        lines.push({
          accountId: requireItemAccount(item, 'inventoryAccountId'),
          description: `${item.sku} × ${qty.toString()}`,
          credit: totalCost.toString(),
        });
      }
    }

    return {
      lines,
      // The catalog names the two directions separately; a mixed document is
      // recorded under the direction that dominates its value.
      ruleCode: gains.gte(losses) ? 'INVENTORY_GAIN' : 'INVENTORY_WRITE_OFF',
      journalCode: 'GEN',
      costs,
    };
  }

  // =========================================================================
  // The consumption core — ADR-0004 §3
  // =========================================================================

  private async consumeStock(
    client: PoolClient,
    principal: TenantPrincipal,
    book: BookContext,
    doc: DocumentRow,
    movement: MovementRow,
    item: ItemContext,
    warehouseId: string,
  ): Promise<ConsumedChunk[]> {
    const quantity = D(movement.quantity).abs();
    const currency = book.baseCurrency;
    const mode: RoundingMode = book.roundingMode;

    // ADR-0004 §3: SELECT ... FOR UPDATE over the item's open layers ordered by
    // (received_date, id). The ORDER BY is part of the costing protocol, not
    // styling — consumeFifo costs the layers in the order it is handed them —
    // and FOR UPDATE is the concurrency mechanism exit criterion 2 tests: two
    // issues racing for the last layer serialise here, and the second sees the
    // remaining quantity the first left behind.
    const { rows: layerRows } = await client.query<{
      id: string;
      remaining_quantity: string;
      unit_cost: string;
      received_date: string;
      is_provisional: boolean;
    }>(
      `SELECT id, remaining_quantity::text AS remaining_quantity, unit_cost::text AS unit_cost,
              received_date::text AS received_date, is_provisional
         FROM inventory_cost_layers
        WHERE item_id = $1 AND warehouse_id = $2 AND accounting_book_id = $3
          AND remaining_quantity > 0
        ORDER BY received_date, id
        FOR UPDATE`,
      [item.id, warehouseId, book.bookId],
    );

    const layers = layerRows.map((row) => ({
      id: row.id,
      remainingQuantity: D(row.remaining_quantity),
      unitCost: D(row.unit_cost),
      receivedDate: row.received_date,
      isProvisional: row.is_provisional,
    }));

    const available = sumExact(layers.map((l) => l.remainingQuantity));
    if (available.lt(quantity)) {
      const shortfall = quantity.sub(available);
      if (item.negativeStockPolicy !== 'ALLOW_PROVISIONAL') {
        // The BLOCK half of doc 08's negative-stock policy, applied after the
        // lock — under concurrency this is the loser of the race being told the
        // truth about what the winner left.
        throw new AppError(
          'NEGATIVE_STOCK_NOT_PERMITTED',
          `Issuing ${quantity.toString()} of ${item.sku} exceeds the ${available.toString()} on ` +
            `hand, and the item's negative stock policy is BLOCK (doc 08: default block).`,
          {
            details: {
              item_id: item.id,
              warehouse_id: warehouseId,
              requested: quantity.toString(),
              available: available.toString(),
            },
          },
        );
      }

      // ALLOW_PROVISIONAL: the shortfall is costed from an explicit provisional
      // layer — doc 08 requires the exception be "deterministic and visible",
      // and `is_provisional = true` is what the valuation report surfaces. The
      // provisional cost is the last real receipt cost; guessing anything else
      // would make settlement's correction larger for no reason.
      const provisionalCost =
        (movement.unit_cost === null ? null : D(movement.unit_cost)) ??
        (await this.lastKnownUnitCost(client, book, item.id, warehouseId));
      if (provisionalCost === null) {
        throw new AppError(
          'VALIDATION_FAILED',
          `${item.sku} has never been received in this warehouse, so there is no cost to issue ` +
            'the shortfall at, even provisionally.',
        );
      }
      const provisionalId = await this.createLayer(client, principal, book, {
        itemId: item.id,
        warehouseId,
        sourceMovementId: movement.id,
        receivedDate: doc.posting_date,
        quantity: shortfall,
        unitCost: provisionalCost,
        provisional: true,
      });
      layers.push({
        id: provisionalId,
        remainingQuantity: shortfall,
        unitCost: provisionalCost,
        receivedDate: doc.posting_date,
        isProvisional: true,
      });
    }

    const byId = new Map(layers.map((l) => [l.id, l]));
    let consumptions: readonly LayerConsumption[];

    if (item.valuation === 'FIFO') {
      consumptions = consumeFifo(layers, quantity, currency, mode).consumptions;
    } else if (item.valuation === 'WEIGHTED_AVERAGE') {
      // One pool, never a stored average — see weightedAverageIssue for why an
      // average is never stored. Its QUANTITY is what the locked layers still
      // hold; its VALUE is received minus issued plus restored
      // (`weightedAveragePoolValue`):
      //
      //   Σ round(original_quantity × unit_cost)
      //     − Σ consumption total_cost
      //     + Σ consumption total_cost given back by a reversal   (F-923)
      //
      // over EVERY layer the item has ever had here, consumed ones included.
      // Doc 08 carries value as the source of truth: an issue credits Inventory
      // at the average while the layers record receipts, so re-deriving the
      // pool from Σ(remaining × receipt cost) diverges from the GL control at
      // the first issue and never reconverges — the −10.40 exit criterion 1
      // caught. Received minus issued is the control balance by construction —
      // the received side is the once-rounded value each receipt posted Dr
      // Inventory, the issued side the stored rows whose sum is each issue's
      // Cr Inventory, and the restored side the rows a posted reversal gave
      // back, which is its own Dr Inventory — and all three are immutable
      // stored facts (0043 freezes layers and consumption rows, 0048 the
      // restorations), the same rows exit criterion 3 reproduces COGS from, so
      // the pool cannot drift from any of them.
      //
      // The facts are read AFTER the provisional-shortfall handling above: a
      // provisional layer created for this issue has no consumptions yet, so
      // its value joins the pool exactly as its quantity already has.
      //
      // The layers are drawn down in FIFO order for QUANTITY, because remaining
      // quantities must live somewhere and (received_date, id) is the one order
      // every reader agrees on; the COST of the issue is the once-rounded pool
      // calculation spread across those rows by consumeWeightedAverage, so
      // exit criterion 3's sum reproduces it exactly.
      const poolQuantity = sumExact(layers.map((l) => l.remainingQuantity));
      const { rows: factRows } = await client.query<{
        original_quantity: string;
        unit_cost: string;
        consumed_value: string;
        restored_value: string;
      }>(
        `SELECT l.original_quantity::text AS original_quantity,
                l.unit_cost::text AS unit_cost,
                coalesce((SELECT sum(c.total_cost)
                            FROM inventory_cost_consumptions c
                           WHERE c.cost_layer_id = l.id), 0)::text AS consumed_value,
                coalesce((SELECT sum(c.total_cost)
                            FROM inventory_cost_consumptions c
                            JOIN inventory_cost_restorations r
                              ON r.inventory_cost_consumption_id = c.id
                           WHERE c.cost_layer_id = l.id), 0)::text AS restored_value
           FROM inventory_cost_layers l
          WHERE l.item_id = $1 AND l.warehouse_id = $2 AND l.accounting_book_id = $3`,
        [item.id, warehouseId, book.bookId],
      );
      const poolValue = weightedAveragePoolValue(
        factRows.map((row) => ({
          originalQuantity: D(row.original_quantity),
          unitCost: D(row.unit_cost),
          consumedValue: D(row.consumed_value),
          restoredValue: D(row.restored_value),
        })),
        currency,
        mode,
      );
      consumptions = consumeWeightedAverage(
        { quantity: poolQuantity, value: poolValue },
        layers,
        quantity,
        currency,
        mode,
      ).consumptions;
    } else {
      throw new AppError(
        'NOT_IMPLEMENTED',
        `Valuation method ${item.valuation} is not implemented. The item must not fall back to a ` +
          'method it was not configured for.',
      );
    }

    // The layer detail both methods need to write their rows and move their
    // remainders; the costing above is the only thing that differed.
    const chunks: ConsumedChunk[] = consumptions.map((c) => {
      const layer = byId.get(c.layerId)!;
      return {
        layerId: c.layerId,
        quantity: c.quantity,
        unitCost: c.unitCost,
        cost: c.cost,
        receivedDate: layer.receivedDate,
        isProvisional: layer.isProvisional,
      };
    });

    for (const chunk of chunks) {
      const layer = byId.get(chunk.layerId)!;
      const remaining = layer.remainingQuantity.sub(chunk.quantity);
      await client.query(
        `UPDATE inventory_cost_layers
            SET remaining_quantity = $2::numeric,
                status = CASE
                  WHEN is_provisional THEN status
                  WHEN $2::numeric = 0 THEN 'CONSUMED'::cost_layer_status
                  ELSE 'OPEN'::cost_layer_status
                END
          WHERE id = $1`,
        [chunk.layerId, remaining.toString()],
      );
      layer.remainingQuantity = remaining;

      // The reproduction row — one per layer touched, doc 08's "every issue has
      // a reproducible valuation breakdown" made into storage.
      await client.query(
        `INSERT INTO inventory_cost_consumptions
           (id, tenant_id, legal_entity_id, cost_layer_id, inventory_movement_id, quantity,
            unit_cost, total_cost)
         VALUES ($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8::numeric)`,
        [
          uuidv7(),
          principal.tenantId,
          book.legalEntityId,
          chunk.layerId,
          movement.id,
          chunk.quantity.toString(),
          chunk.unitCost.toString(),
          chunk.cost.toString(),
        ],
      );
    }

    return chunks;
  }

  // =========================================================================
  // Layer plumbing
  // =========================================================================

  private async createLayer(
    client: PoolClient,
    principal: TenantPrincipal,
    book: BookContext,
    layer: {
      itemId: string;
      warehouseId: string;
      sourceMovementId: string;
      receivedDate: string;
      quantity: Decimal;
      unitCost: Decimal;
      provisional: boolean;
    },
  ): Promise<string> {
    const id = uuidv7();
    await client.query(
      `INSERT INTO inventory_cost_layers
         (id, tenant_id, legal_entity_id, accounting_book_id, item_id, warehouse_id,
          source_movement_id, received_date, original_quantity, remaining_quantity, unit_cost,
          currency, status, is_provisional)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9::numeric,$9::numeric,$10::numeric,$11,
               $12::cost_layer_status,$13)`,
      [
        id,
        principal.tenantId,
        book.legalEntityId,
        book.bookId,
        layer.itemId,
        layer.warehouseId,
        layer.sourceMovementId,
        layer.receivedDate,
        layer.quantity.toString(),
        layer.unitCost.toString(),
        book.baseCurrency,
        layer.provisional ? 'PROVISIONAL' : 'OPEN',
        layer.provisional,
      ],
    );
    return id;
  }

  /**
   * Reversal of an inbound movement: the layers it created must still be whole.
   * Consumed-from layers cannot be un-received — the stock has left — so the
   * reversal refuses rather than driving `remaining_quantity` toward the F-032
   * CHECK.
   */
  private async unwindCreatedLayers(
    client: PoolClient,
    principal: TenantPrincipal,
    book: BookContext,
    movement: MovementRow,
    reversalMovementId: string,
  ): Promise<void> {
    const { rows: layers } = await client.query<{
      id: string;
      original_quantity: string;
      remaining_quantity: string;
      unit_cost: string;
      is_provisional: boolean;
    }>(
      `SELECT id, original_quantity::text AS original_quantity,
              remaining_quantity::text AS remaining_quantity, unit_cost::text AS unit_cost,
              is_provisional
         FROM inventory_cost_layers
        WHERE source_movement_id = $1
        ORDER BY received_date, id
        FOR UPDATE`,
      [movement.id],
    );

    for (const layer of layers) {
      if (!D(layer.remaining_quantity).equals(D(layer.original_quantity))) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Layer ${layer.id} from this receipt has already been partly issued; the stock is not ` +
            'there to un-receive. Correct the remainder with an adjustment instead.',
          { details: { layer_id: layer.id, remaining: layer.remaining_quantity } },
        );
      }
    }

    // Spread the movement's posted value over its layers so the reversal's
    // consumption rows sum to exactly what the original movement capitalised —
    // the same exactness rule as every other breakdown.
    const takes = layers.map((layer) => ({
      layerId: layer.id,
      quantity: D(layer.original_quantity),
    }));
    const totalCost =
      movement.total_cost === null ? Decimal.zero(MONEY_SCALE) : D(movement.total_cost);
    const spread = spreadCostAcrossTakes(takes, totalCost, book.baseCurrency);

    for (const [i, layer] of layers.entries()) {
      await client.query(
        `UPDATE inventory_cost_layers
            SET remaining_quantity = 0,
                status = CASE WHEN is_provisional THEN status
                              ELSE 'CONSUMED'::cost_layer_status END
          WHERE id = $1`,
        [layer.id],
      );
      await client.query(
        `INSERT INTO inventory_cost_consumptions
           (id, tenant_id, legal_entity_id, cost_layer_id, inventory_movement_id, quantity,
            unit_cost, total_cost)
         VALUES ($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8::numeric)`,
        [
          uuidv7(),
          principal.tenantId,
          book.legalEntityId,
          layer.id,
          reversalMovementId,
          layer.original_quantity,
          layer.unit_cost,
          (spread[i] as { cost: Decimal }).cost.toString(),
        ],
      );
    }
  }

  private async lastKnownUnitCost(
    client: PoolClient,
    book: BookContext,
    itemId: string,
    warehouseId: string,
  ): Promise<Decimal | null> {
    const { rows } = await client.query<{ unit_cost: string }>(
      `SELECT unit_cost::text AS unit_cost
         FROM inventory_cost_layers
        WHERE item_id = $1 AND warehouse_id = $2 AND accounting_book_id = $3
          AND NOT is_provisional
        ORDER BY received_date DESC, id DESC
        LIMIT 1`,
      [itemId, warehouseId, book.bookId],
    );
    return rows[0] ? D(rows[0].unit_cost) : null;
  }

  private async currentAverageCost(
    client: PoolClient,
    book: BookContext,
    itemId: string,
    warehouseId: string,
  ): Promise<Decimal | null> {
    const { rows } = await client.query<{ quantity: string | null; value: string | null }>(
      `SELECT sum(remaining_quantity)::text AS quantity,
              sum(remaining_quantity * unit_cost)::text AS value
         FROM inventory_cost_layers
        WHERE item_id = $1 AND warehouse_id = $2 AND accounting_book_id = $3
          AND remaining_quantity > 0`,
      [itemId, warehouseId, book.bookId],
    );
    const row = rows[0];
    if (!row?.quantity || D(row.quantity).isZero()) return null;
    return averageUnitCost({ quantity: D(row.quantity), value: D(row.value ?? '0') });
  }

  private async grniAccount(client: PoolClient, book: BookContext, on: string): Promise<string> {
    const accountId = await policyAccount(client, book.legalEntityId, 'grni_account_id', on);
    if (!accountId) {
      throw new AppError(
        'VALIDATION_FAILED',
        'No Goods Received Not Invoiced account is configured, so this movement has nothing to ' +
          'accrue against. Set grni_account_id on the accounting policy.',
      );
    }
    return accountId;
  }
}

// ---------------------------------------------------------------------------
// Row loaders
// ---------------------------------------------------------------------------

async function lockDocument(client: PoolClient, id: string): Promise<DocumentRow> {
  const { rows } = await client.query<DocumentRow>(
    `SELECT id, legal_entity_id, accounting_book_id, branch_id,
            document_type::text AS document_type, document_number,
            document_date::text AS document_date, posting_date::text AS posting_date,
            status::text AS status, warehouse_id, purchase_order_id, source_type, source_id,
            accounting_entry_id
       FROM inventory_documents WHERE id = $1 FOR UPDATE`,
    [id],
  );
  const doc = rows[0];
  if (!doc) throw notFound('inventory_document', id);
  return doc;
}

async function loadMovements(client: PoolClient, documentId: string): Promise<MovementRow[]> {
  const { rows } = await client.query<MovementRow>(
    `SELECT id, line_no, item_id, from_location_id, to_location_id, quantity::text AS quantity,
            uom, stock_lot_id, serial_unit_id, unit_cost::text AS unit_cost,
            total_cost::text AS total_cost
       FROM inventory_movements
      WHERE inventory_document_id = $1
      ORDER BY line_no`,
    [documentId],
  );
  return rows;
}

/**
 * The journal a goods-receipt-backed receipt links to instead of posting one.
 * Loaded at posting time, not trusted from creation time: the receipt could
 * have been drafted before the goods receipt reached POSTED.
 */
async function goodsReceiptEntryId(client: PoolClient, doc: DocumentRow): Promise<string> {
  const { rows } = await client.query<{ status: string; accounting_entry_id: string | null }>(
    `SELECT status::text AS status, accounting_entry_id FROM goods_receipts WHERE id = $1`,
    [doc.source_id],
  );
  const receipt = rows[0];
  if (!receipt || receipt.status !== 'POSTED' || !receipt.accounting_entry_id) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Goods receipt ${doc.source_id} has no posted GRNI accrual to link this stock movement ` +
        'to. Post the goods receipt first (Phase 3 postGoodsReceipt owns that journal).',
    );
  }
  return receipt.accounting_entry_id;
}

/**
 * Restores every layer a movement consumed — both halves of what it took.
 *
 * The QUANTITY goes back to the layer, by exactly what the stored consumption
 * rows say was drawn. The bound cannot overflow: each restored quantity was
 * subtracted from that same layer, no other writer ever raises
 * `remaining_quantity`, and `inventory_cost_restorations`' UNIQUE on the
 * consumption makes a second restoration of the same row impossible even if a
 * caller tried — so remaining + restored ≤ original holds under the same row
 * locks consumption takes.
 *
 * The VALUE goes back as one `inventory_cost_restorations` row per consumption
 * — F-923. Without it the layers came back and the pool did not: a
 * weighted-average valuation is received minus issued (F-922) and the
 * consumption rows are still standing, so it stayed short by exactly the COGS
 * the reversal journal had just debited back into the control account. On the
 * doc 08 worked example the reconciliation reported `difference` 254.40 and
 * `unexplained` 254.40, and the next issue of that item priced off the stale
 * pool at 132.29 instead of 254.40.
 *
 * The restoration carries no amount of its own: the value restored IS the
 * consumption's `total_cost`, read by join wherever the pool is derived. The
 * consumption row itself is untouched, because the issue really did post that
 * COGS and exit criterion 3 reproduces the journal from it; the reversal is a
 * separate event with a journal of its own.
 */
async function restoreConsumedLayers(
  client: PoolClient,
  principal: TenantPrincipal,
  book: BookContext,
  originalMovementId: string,
  reversalMovementId: string,
): Promise<void> {
  const { rows: consumptions } = await client.query<{
    id: string;
    cost_layer_id: string;
    quantity: string;
  }>(
    `SELECT c.id, c.cost_layer_id, c.quantity::text AS quantity
       FROM inventory_cost_consumptions c
       JOIN inventory_cost_layers l ON l.id = c.cost_layer_id
      WHERE c.inventory_movement_id = $1
      ORDER BY l.received_date, l.id
      FOR UPDATE OF l`,
    [originalMovementId],
  );

  for (const consumption of consumptions) {
    await client.query(
      `UPDATE inventory_cost_layers
          SET remaining_quantity = remaining_quantity + $2::numeric,
              status = CASE WHEN is_provisional THEN status ELSE 'OPEN'::cost_layer_status END
        WHERE id = $1`,
      [consumption.cost_layer_id, consumption.quantity],
    );
    await client.query(
      `INSERT INTO inventory_cost_restorations
         (id, tenant_id, legal_entity_id, inventory_cost_consumption_id, inventory_movement_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [uuidv7(), principal.tenantId, book.legalEntityId, consumption.id, reversalMovementId],
    );
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
