import { Pool, PoolClient } from 'pg';
import {
  AppError,
  notFound,
  uuidv7,
  D,
  Decimal,
  assertEntityPermission,
  sumExact,
  type TenantPrincipal,
  type RequestContext,
} from '@acct/domain';
import { writeInTenant, readInTenant, recordAudit } from '@acct/database';
import { PostingService, type BookContext } from '@acct/ledger';
import { loadItemContexts, loadLocations, type ItemContext } from './lookup';

/**
 * Inventory documents — doc 08 "Stock movements", ADR-0007's uniform shape:
 * one header table, movements as lines, an optional accounting entry.
 *
 * Creation and posting are separate on purpose (F-902): a receipt is a physical
 * fact recorded when it happens, and its accounting date is a policy decision.
 * Everything here writes DRAFT documents; `InventoryPostingService` is the only
 * thing that makes one POSTED, and the 0043 guards freeze it from then on.
 */

interface MovementDraft {
  readonly itemId: string;
  readonly fromLocationId: string | null;
  readonly toLocationId: string | null;
  readonly quantity: Decimal;
  readonly uom: string;
  readonly stockLotId: string | null;
  readonly serialUnitId: string | null;
  readonly unitCost: Decimal | null;
  readonly purchaseOrderLineId: string | null;
}

interface HeaderInput {
  accountingBookId: string;
  documentDate: string;
  postingDate: string;
  branchId?: string | null | undefined;
  documentNumber?: string | null | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export class InventoryDocumentsService {
  constructor(
    private readonly pool: Pool,
    private readonly posting: PostingService,
  ) {}

  // -------------------------------------------------------------------------
  // Receipt — doc 08 "Receipt accounting"
  // -------------------------------------------------------------------------

  /**
   * Two kinds of receipt, and the difference decides Phase 5's first exit
   * criterion. A receipt AGAINST A GOODS RECEIPT is the stock consequence of a
   * procurement fact Phase 3 already accounted for — `postGoodsReceipt` posted
   * Dr destination / Cr GRNI for the delivery, and that journal IS doc 08's
   * INVENTORY_RECEIPT_AGAINST_PO. This document records the movement and the
   * cost layers and must NOT accrue again. A MANUAL receipt has no goods
   * receipt behind it, so it posts its own accrual at posting time. The link is
   * `source_type = 'goods_receipt'` / `source_id`, and the posting service
   * branches on exactly that.
   */
  async createReceipt(
    principal: TenantPrincipal,
    input: HeaderInput & {
      warehouseId: string;
      goodsReceiptId?: string | null | undefined;
      purchaseOrderId?: string | null | undefined;
      lines: readonly {
        itemId: string;
        toLocationId: string;
        quantity: string;
        unitCost?: string | undefined;
        uom?: string | undefined;
        stockLotId?: string | null | undefined;
        goodsReceiptLineId?: string | null | undefined;
      }[];
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const book = await this.posting.loadBookContext(
        client,
        principal,
        input.accountingBookId,
        input.postingDate,
      );
      assertEntityPermission(principal, 'inventory.receive', book.legalEntityId);
      requireLines(input.lines);

      let purchaseOrderId = input.purchaseOrderId ?? null;
      let grLines = new Map<string, GoodsReceiptLine>();
      if (input.goodsReceiptId) {
        const gr = await loadGoodsReceipt(client, input.goodsReceiptId, book);
        purchaseOrderId = purchaseOrderId ?? gr.purchase_order_id;
        grLines = await loadGoodsReceiptLines(client, input.goodsReceiptId);
      }

      const items = await loadItemContexts(
        client,
        input.lines.map((l) => l.itemId),
        book.legalEntityId,
      );
      const locations = await loadLocations(
        client,
        input.lines.map((l) => l.toLocationId),
      );

      const movements: MovementDraft[] = input.lines.map((line, i) => {
        const item = requireStockItem(items, line.itemId);
        const location = locations.get(line.toLocationId)!;
        requireLocationIn(location, book, input.warehouseId, i);
        const quantity = requirePositiveQuantity(line.quantity, i);

        let unitCost = line.unitCost !== undefined ? D(line.unitCost) : null;
        if (line.goodsReceiptLineId) {
          const grLine = grLines.get(line.goodsReceiptLineId);
          if (!grLine) {
            throw new AppError(
              'VALIDATION_FAILED',
              `Line ${i + 1} names goods receipt line ${line.goodsReceiptLineId}, which is not ` +
                'on the named goods receipt.',
            );
          }
          if (grLine.item_id && grLine.item_id !== line.itemId) {
            throw new AppError(
              'VALIDATION_FAILED',
              `Line ${i + 1}: the goods receipt line is for a different item.`,
            );
          }
          // Bounded by what was accepted on THAT line. This does not sum
          // earlier stock receipts against the same line — a duplicated stock
          // receipt shows up on the inventory-to-GL reconciliation instead of
          // being silently blocked here.
          if (quantity.gt(D(grLine.quantity_accepted))) {
            throw new AppError(
              'VALIDATION_FAILED',
              `Line ${i + 1} moves ${quantity.toString()} but the goods receipt accepted ` +
                `${grLine.quantity_accepted}.`,
            );
          }
          unitCost = unitCost ?? D(grLine.unit_price);
        }
        if (unitCost === null || unitCost.isNegative()) {
          throw new AppError(
            'VALIDATION_FAILED',
            `Line ${i + 1} has no unit cost. A receipt without a cost cannot create the cost ` +
              'layer every later issue is valued from (doc 08).',
          );
        }
        return {
          itemId: line.itemId,
          fromLocationId: null,
          toLocationId: line.toLocationId,
          quantity,
          uom: line.uom ?? item.baseUom,
          stockLotId: line.stockLotId ?? null,
          serialUnitId: null,
          unitCost,
          purchaseOrderLineId: line.goodsReceiptLineId
            ? (grLines.get(line.goodsReceiptLineId)?.purchase_order_line_id ?? null)
            : null,
        };
      });

      return this.insertDocument(client, context, principal, book, {
        documentType: 'RECEIPT',
        header: input,
        warehouseId: input.warehouseId,
        purchaseOrderId,
        // `invdoc_receipt_needs_source` (0012): a receipt must say where it came
        // from. 'MANUAL' is the honest answer when there is no goods receipt.
        sourceType: input.goodsReceiptId ? 'goods_receipt' : 'MANUAL',
        sourceId: input.goodsReceiptId ?? null,
        movements,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Issue — doc 08 "Sales fulfillment and COGS"
  // -------------------------------------------------------------------------

  async createIssue(
    principal: TenantPrincipal,
    input: HeaderInput & {
      warehouseId?: string | null | undefined;
      salesOrderId?: string | null | undefined;
      invoiceId?: string | null | undefined;
      lines: readonly {
        itemId: string;
        fromLocationId: string;
        quantity: string;
        uom?: string | undefined;
        stockLotId?: string | null | undefined;
        serialUnitId?: string | null | undefined;
      }[];
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const book = await this.posting.loadBookContext(
        client,
        principal,
        input.accountingBookId,
        input.postingDate,
      );
      assertEntityPermission(principal, 'inventory.issue', book.legalEntityId);
      requireLines(input.lines);

      const items = await loadItemContexts(
        client,
        input.lines.map((l) => l.itemId),
        book.legalEntityId,
      );
      const locations = await loadLocations(
        client,
        input.lines.map((l) => l.fromLocationId),
      );

      const movements: MovementDraft[] = input.lines.map((line, i) => {
        const item = requireStockItem(items, line.itemId);
        const location = locations.get(line.fromLocationId)!;
        requireLocationIn(location, book, input.warehouseId ?? null, i);
        const quantity = requirePositiveQuantity(line.quantity, i);
        return {
          itemId: line.itemId,
          fromLocationId: line.fromLocationId,
          toLocationId: null,
          quantity: Decimal.zero(quantity.scale).sub(quantity),
          uom: line.uom ?? item.baseUom,
          stockLotId: line.stockLotId ?? null,
          serialUnitId: line.serialUnitId ?? null,
          // Cost comes from layer consumption at posting time, never from input:
          // an issue priced by its caller is an issue the valuation engine
          // cannot reproduce.
          unitCost: null,
          purchaseOrderLineId: null,
        };
      });

      return this.insertDocument(client, context, principal, book, {
        documentType: 'ISSUE',
        header: input,
        warehouseId: input.warehouseId ?? null,
        salesOrderId: input.salesOrderId ?? null,
        invoiceId: input.invoiceId ?? null,
        movements,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Transfer — doc 08 "Warehouses and locations", F-918
  // -------------------------------------------------------------------------

  /**
   * Each line becomes an out movement and an in movement of the same item and
   * quantity, so the document nets to zero per item BY CONSTRUCTION — the shape
   * `assert_transfer_balanced` (0043) verifies at posting. The pairing (out at
   * odd line_no, in at the following even one) is what the posting service uses
   * to carry each consumed cost chunk to the destination warehouse.
   */
  async createTransfer(
    principal: TenantPrincipal,
    input: HeaderInput & {
      lines: readonly {
        itemId: string;
        fromLocationId: string;
        toLocationId: string;
        quantity: string;
        uom?: string | undefined;
        stockLotId?: string | null | undefined;
      }[];
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const book = await this.posting.loadBookContext(
        client,
        principal,
        input.accountingBookId,
        input.postingDate,
      );
      assertEntityPermission(principal, 'inventory.transfer', book.legalEntityId);
      requireLines(input.lines);

      const items = await loadItemContexts(
        client,
        input.lines.map((l) => l.itemId),
        book.legalEntityId,
      );
      const locations = await loadLocations(client, [
        ...input.lines.map((l) => l.fromLocationId),
        ...input.lines.map((l) => l.toLocationId),
      ]);

      const movements: MovementDraft[] = [];
      input.lines.forEach((line, i) => {
        const item = requireStockItem(items, line.itemId);
        const from = locations.get(line.fromLocationId)!;
        const to = locations.get(line.toLocationId)!;
        requireLocationIn(from, book, null, i);
        requireLocationIn(to, book, null, i);
        if (line.fromLocationId === line.toLocationId) {
          throw new AppError(
            'VALIDATION_FAILED',
            `Line ${i + 1} transfers from a location to itself, which moves nothing.`,
          );
        }
        const quantity = requirePositiveQuantity(line.quantity, i);
        const uom = line.uom ?? item.baseUom;
        movements.push({
          itemId: line.itemId,
          fromLocationId: line.fromLocationId,
          toLocationId: null,
          quantity: Decimal.zero(quantity.scale).sub(quantity),
          uom,
          stockLotId: line.stockLotId ?? null,
          serialUnitId: null,
          unitCost: null,
          purchaseOrderLineId: null,
        });
        movements.push({
          itemId: line.itemId,
          fromLocationId: null,
          toLocationId: line.toLocationId,
          quantity,
          uom,
          stockLotId: line.stockLotId ?? null,
          serialUnitId: null,
          unitCost: null,
          purchaseOrderLineId: null,
        });
      });

      return this.insertDocument(client, context, principal, book, {
        documentType: 'TRANSFER',
        header: input,
        warehouseId: null,
        movements,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Adjustment — doc 08 "Stock movements": gain, write-down, count variance
  // -------------------------------------------------------------------------

  async createAdjustment(
    principal: TenantPrincipal,
    input: HeaderInput & {
      warehouseId?: string | null | undefined;
      reason?: string | undefined;
      lines: readonly {
        itemId: string;
        locationId: string;
        /** Signed: positive is a gain into the location, negative a write-down out of it. */
        quantity: string;
        unitCost?: string | undefined;
        uom?: string | undefined;
        stockLotId?: string | null | undefined;
      }[];
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const book = await this.posting.loadBookContext(
        client,
        principal,
        input.accountingBookId,
        input.postingDate,
      );
      assertEntityPermission(principal, 'inventory.adjust', book.legalEntityId);
      requireLines(input.lines);

      const items = await loadItemContexts(
        client,
        input.lines.map((l) => l.itemId),
        book.legalEntityId,
      );
      const locations = await loadLocations(
        client,
        input.lines.map((l) => l.locationId),
      );

      const movements: MovementDraft[] = input.lines.map((line, i) => {
        const item = requireStockItem(items, line.itemId);
        const location = locations.get(line.locationId)!;
        requireLocationIn(location, book, input.warehouseId ?? null, i);
        const quantity = D(line.quantity);
        if (quantity.isZero()) {
          throw new AppError('VALIDATION_FAILED', `Line ${i + 1} adjusts by zero.`);
        }
        return {
          itemId: line.itemId,
          fromLocationId: quantity.isNegative() ? line.locationId : null,
          toLocationId: quantity.isPositive() ? line.locationId : null,
          quantity,
          uom: line.uom ?? item.baseUom,
          stockLotId: line.stockLotId ?? null,
          serialUnitId: null,
          unitCost: line.unitCost !== undefined ? D(line.unitCost) : null,
          purchaseOrderLineId: null,
        };
      });

      return this.insertDocument(client, context, principal, book, {
        documentType: 'ADJUSTMENT',
        header: {
          ...input,
          metadata: {
            ...(input.metadata ?? {}),
            ...(input.reason ? { reason: input.reason } : {}),
          },
        },
        warehouseId: input.warehouseId ?? null,
        movements,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Returns — F-907: two distinct movement types with distinct accounting
  // -------------------------------------------------------------------------

  async createReturn(
    principal: TenantPrincipal,
    input: HeaderInput & {
      kind: 'CUSTOMER_RETURN' | 'VENDOR_RETURN';
      invoiceId?: string | null | undefined;
      vendorBillId?: string | null | undefined;
      purchaseOrderId?: string | null | undefined;
      lines: readonly {
        itemId: string;
        /** CUSTOMER_RETURN: where the stock comes back to. */
        toLocationId?: string | undefined;
        /** VENDOR_RETURN: where the stock leaves from. */
        fromLocationId?: string | undefined;
        quantity: string;
        /** CUSTOMER_RETURN: the issue movement whose cost is being restored. */
        originalMovementId?: string | null | undefined;
        unitCost?: string | undefined;
        uom?: string | undefined;
        stockLotId?: string | null | undefined;
      }[];
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const book = await this.posting.loadBookContext(
        client,
        principal,
        input.accountingBookId,
        input.postingDate,
      );
      assertEntityPermission(principal, 'inventory.receive', book.legalEntityId);
      requireLines(input.lines);
      if (input.kind !== 'CUSTOMER_RETURN' && input.kind !== 'VENDOR_RETURN') {
        throw new AppError(
          'VALIDATION_FAILED',
          'kind is CUSTOMER_RETURN or VENDOR_RETURN — doc 08 names them as distinct movement ' +
            'types with distinct accounting, and posting them as one loses the link to the ' +
            'issue whose cost is being restored.',
        );
      }

      const items = await loadItemContexts(
        client,
        input.lines.map((l) => l.itemId),
        book.legalEntityId,
      );
      const locationIds = input.lines.map((l, i) => {
        const id = input.kind === 'CUSTOMER_RETURN' ? l.toLocationId : l.fromLocationId;
        if (!id) {
          throw new AppError(
            'VALIDATION_FAILED',
            `Line ${i + 1} needs ${input.kind === 'CUSTOMER_RETURN' ? 'toLocationId' : 'fromLocationId'}.`,
          );
        }
        return id;
      });
      const locations = await loadLocations(client, locationIds);

      const movements: MovementDraft[] = [];
      for (const [i, line] of input.lines.entries()) {
        const item = requireStockItem(items, line.itemId);
        const location = locations.get(locationIds[i] as string)!;
        requireLocationIn(location, book, null, i);
        const quantity = requirePositiveQuantity(line.quantity, i);

        if (input.kind === 'CUSTOMER_RETURN') {
          // doc 08: "customer return restores stock using linked original issue
          // cost where possible" — so the linked movement's own stored
          // consumptions are the first choice, an explicit cost the fallback.
          let unitCost = line.unitCost !== undefined ? D(line.unitCost) : null;
          if (line.originalMovementId) {
            unitCost = await originalIssueUnitCost(
              client,
              line.originalMovementId,
              line.itemId,
              book,
              i,
            );
          }
          if (unitCost === null) {
            throw new AppError(
              'VALIDATION_FAILED',
              `Line ${i + 1} has neither an original movement nor a unit cost, so there is no ` +
                'supported return cost to restore the stock at (doc 08 "Returns").',
            );
          }
          movements.push({
            itemId: line.itemId,
            fromLocationId: null,
            toLocationId: location.id,
            quantity,
            uom: line.uom ?? item.baseUom,
            stockLotId: line.stockLotId ?? null,
            serialUnitId: null,
            unitCost,
            purchaseOrderLineId: null,
          });
        } else {
          movements.push({
            itemId: line.itemId,
            fromLocationId: location.id,
            toLocationId: null,
            quantity: Decimal.zero(quantity.scale).sub(quantity),
            uom: line.uom ?? item.baseUom,
            stockLotId: line.stockLotId ?? null,
            serialUnitId: null,
            // Valued by layer consumption at posting, like any outbound stock.
            unitCost: null,
            purchaseOrderLineId: null,
          });
        }
      }

      return this.insertDocument(client, context, principal, book, {
        documentType: input.kind,
        header: input,
        warehouseId: null,
        invoiceId: input.invoiceId ?? null,
        vendorBillId: input.vendorBillId ?? null,
        purchaseOrderId: input.purchaseOrderId ?? null,
        movements,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Reads — F-902
  // -------------------------------------------------------------------------

  async listDocuments(
    principal: TenantPrincipal,
    query: {
      legalEntityId?: string | undefined;
      documentType?: string | undefined;
      status?: string | undefined;
      warehouseId?: string | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT d.id, d.legal_entity_id, d.accounting_book_id, d.branch_id,
                d.document_type::text AS document_type, d.document_number,
                d.document_date::text AS document_date, d.posting_date::text AS posting_date,
                d.status::text AS status, d.warehouse_id, d.purchase_order_id, d.sales_order_id,
                d.vendor_bill_id, d.invoice_id, d.source_type, d.source_id,
                d.accounting_entry_id, d.created_at,
                (SELECT count(*) FROM inventory_movements m
                  WHERE m.inventory_document_id = d.id)::text AS movement_count
           FROM inventory_documents d
          WHERE ($1::uuid IS NULL OR d.legal_entity_id = $1)
            AND ($2::inventory_doc_type IS NULL OR d.document_type = $2::inventory_doc_type)
            AND ($3::document_status IS NULL OR d.status = $3::document_status)
            AND ($4::uuid IS NULL OR d.warehouse_id = $4)
          ORDER BY d.created_at DESC`,
        [
          query.legalEntityId ?? null,
          query.documentType ?? null,
          query.status ?? null,
          query.warehouseId ?? null,
        ],
      );
      return { data: rows };
    });
  }

  /**
   * The document, its movements and the journal it produced — the drill Gate
   * D's reconciliation needs when a difference has to be explained rather than
   * merely reported (contract description, verbatim).
   */
  async getDocument(principal: TenantPrincipal, id: string) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `SELECT d.id, d.legal_entity_id, d.accounting_book_id, d.branch_id,
                d.document_type::text AS document_type, d.document_number,
                d.document_date::text AS document_date, d.posting_date::text AS posting_date,
                d.status::text AS status, d.warehouse_id, d.purchase_order_id, d.sales_order_id,
                d.vendor_bill_id, d.invoice_id, d.source_type, d.source_id,
                d.accounting_entry_id, d.metadata, d.created_at
           FROM inventory_documents d WHERE d.id = $1`,
        [id],
      );
      const document = rows[0];
      if (!document) throw notFound('inventory_document', id);

      const { rows: movements } = await client.query(
        `SELECT m.id, m.line_no, m.item_id, i.sku, m.from_location_id, m.to_location_id,
                m.movement_date::text AS movement_date, m.quantity::text AS quantity, m.uom,
                m.stock_lot_id, m.serial_unit_id, m.unit_cost::text AS unit_cost,
                m.total_cost::text AS total_cost, m.currency, m.cost_method::text AS cost_method,
                m.purchase_order_line_id
           FROM inventory_movements m
           JOIN items i ON i.id = m.item_id
          WHERE m.inventory_document_id = $1
          ORDER BY m.line_no`,
        [id],
      );

      let journal: unknown = null;
      if (document.accounting_entry_id) {
        const { rows: entries } = await client.query(
          `SELECT id, entry_number, posting_date::text AS posting_date, description,
                  status::text AS status, source_type, source_id, reversal_of_id
             FROM journal_entries WHERE id = $1`,
          [document.accounting_entry_id],
        );
        journal = entries[0] ?? null;
      }

      return { ...document, movements, journal };
    });
  }

  // -------------------------------------------------------------------------
  // Shared insertion
  // -------------------------------------------------------------------------

  private async insertDocument(
    client: PoolClient,
    context: RequestContext,
    principal: TenantPrincipal,
    book: BookContext,
    doc: {
      documentType: string;
      header: HeaderInput;
      warehouseId: string | null;
      purchaseOrderId?: string | null;
      salesOrderId?: string | null;
      vendorBillId?: string | null;
      invoiceId?: string | null;
      sourceType?: string | null;
      sourceId?: string | null;
      movements: readonly MovementDraft[];
    },
  ) {
    // A quantity imbalance in a transfer should be impossible by construction
    // above; asserted anyway so a future edit to the pairing loop fails here
    // with a named error rather than at the deferred trigger as a bare 500.
    if (doc.documentType === 'TRANSFER') {
      const byItem = new Map<string, Decimal[]>();
      for (const m of doc.movements) {
        byItem.set(m.itemId, [...(byItem.get(m.itemId) ?? []), m.quantity]);
      }
      for (const [itemId, quantities] of byItem) {
        if (!sumExact(quantities).isZero()) {
          throw new AppError(
            'VALIDATION_FAILED',
            `Transfer does not net to zero for item ${itemId}; a transfer relocates stock, it ` +
              'does not create or destroy it (doc 08).',
          );
        }
      }
    }

    const id = uuidv7();
    const { rows } = await client.query<Record<string, unknown>>(
      `INSERT INTO inventory_documents
         (id, tenant_id, legal_entity_id, accounting_book_id, branch_id, document_type,
          document_number, document_date, posting_date, warehouse_id, purchase_order_id,
          sales_order_id, vendor_bill_id, invoice_id, source_type, source_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6::inventory_doc_type,$7,$8::date,$9::date,$10,$11,$12,$13,$14,
               $15,$16,$17::jsonb)
       RETURNING id, legal_entity_id, accounting_book_id, document_type::text AS document_type,
                 document_number, document_date::text AS document_date,
                 posting_date::text AS posting_date, status::text AS status, warehouse_id,
                 purchase_order_id, sales_order_id, vendor_bill_id, invoice_id, source_type,
                 source_id, metadata, created_at`,
      [
        id,
        principal.tenantId,
        book.legalEntityId,
        book.bookId,
        doc.header.branchId ?? null,
        doc.documentType,
        doc.header.documentNumber ?? null,
        doc.header.documentDate,
        doc.header.postingDate,
        doc.warehouseId,
        doc.purchaseOrderId ?? null,
        doc.salesOrderId ?? null,
        doc.vendorBillId ?? null,
        doc.invoiceId ?? null,
        doc.sourceType ?? null,
        doc.sourceId ?? null,
        JSON.stringify(doc.header.metadata ?? {}),
      ],
    );

    const movements = [];
    for (const [i, movement] of doc.movements.entries()) {
      const { rows: created } = await client.query<Record<string, unknown>>(
        `INSERT INTO inventory_movements
           (id, tenant_id, legal_entity_id, inventory_document_id, line_no, item_id,
            from_location_id, to_location_id, movement_date, quantity, uom, stock_lot_id,
            serial_unit_id, unit_cost, currency, purchase_order_line_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10::numeric,$11,$12,$13,$14::numeric,$15,$16)
         RETURNING id, line_no, item_id, from_location_id, to_location_id,
                   quantity::text AS quantity, uom, stock_lot_id, serial_unit_id,
                   unit_cost::text AS unit_cost`,
        [
          uuidv7(),
          principal.tenantId,
          book.legalEntityId,
          id,
          i + 1,
          movement.itemId,
          movement.fromLocationId,
          movement.toLocationId,
          doc.header.postingDate,
          movement.quantity.toString(),
          movement.uom,
          movement.stockLotId,
          movement.serialUnitId,
          movement.unitCost === null ? null : movement.unitCost.toString(),
          movement.unitCost === null ? null : book.baseCurrency,
          movement.purchaseOrderLineId,
        ],
      );
      movements.push(created[0]);
    }

    await recordAudit(client, context, {
      tenantId: principal.tenantId,
      legalEntityId: book.legalEntityId,
      action: 'inventory_document.created',
      resourceType: 'inventory_document',
      resourceId: id,
      after: { ...(rows[0] as Record<string, unknown>), movement_count: movements.length },
    });

    return { ...rows[0], movements };
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function requireLines(lines: readonly unknown[]): void {
  if (lines.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'A stock document with no lines moves nothing.');
  }
}

function requireStockItem(items: Map<string, ItemContext>, itemId: string): ItemContext {
  const item = items.get(itemId)!;
  if (item.kind !== 'INVENTORY') {
    throw new AppError(
      'VALIDATION_FAILED',
      `Item ${item.sku} is ${item.kind}; only INVENTORY items hold stock (doc 08 item types).`,
      { details: { item_id: itemId, kind: item.kind } },
    );
  }
  return item;
}

function requireLocationIn(
  location: { id: string; warehouseId: string; legalEntityId: string; code: string },
  book: BookContext,
  warehouseId: string | null,
  lineIndex: number,
): void {
  if (location.legalEntityId !== book.legalEntityId) {
    throw new AppError(
      'CROSS_ENTITY_REFERENCE',
      `Line ${lineIndex + 1}: location ${location.code} belongs to another legal entity. A stock ` +
        'move between entities is an intercompany transaction, not a movement (doc 08).',
    );
  }
  if (warehouseId && location.warehouseId !== warehouseId) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Line ${lineIndex + 1}: location ${location.code} is not in the document's warehouse.`,
    );
  }
}

function requirePositiveQuantity(raw: string, lineIndex: number): Decimal {
  const quantity = D(raw);
  if (!quantity.isPositive()) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Line ${lineIndex + 1} quantity must be greater than zero; direction comes from the ` +
        'document type, not the sign.',
    );
  }
  return quantity;
}

// ---------------------------------------------------------------------------
// Goods receipt linkage — the Phase 3 boundary
// ---------------------------------------------------------------------------

interface GoodsReceiptLine {
  id: string;
  item_id: string | null;
  purchase_order_line_id: string | null;
  quantity_accepted: string;
  unit_price: string;
}

async function loadGoodsReceipt(
  client: PoolClient,
  id: string,
  book: BookContext,
): Promise<{ id: string; purchase_order_id: string | null; accounting_entry_id: string | null }> {
  const { rows } = await client.query<{
    id: string;
    legal_entity_id: string;
    accounting_book_id: string;
    purchase_order_id: string | null;
    status: string;
    accounting_entry_id: string | null;
  }>(
    `SELECT id, legal_entity_id, accounting_book_id, purchase_order_id, status::text AS status,
            accounting_entry_id
       FROM goods_receipts WHERE id = $1`,
    [id],
  );
  const receipt = rows[0];
  if (!receipt) throw notFound('goods_receipt', id);
  if (
    receipt.legal_entity_id !== book.legalEntityId ||
    receipt.accounting_book_id !== book.bookId
  ) {
    throw new AppError(
      'CROSS_ENTITY_REFERENCE',
      'The goods receipt belongs to a different legal entity or book than this document.',
    );
  }
  if (receipt.status !== 'POSTED') {
    // The stock consequence rides on the accrual Phase 3 posted. Before that
    // journal exists there is nothing to link, and posting this document would
    // either accrue twice later or leave the movement journal-less forever.
    throw new AppError(
      'VALIDATION_FAILED',
      `Goods receipt ${id} is ${receipt.status}. Post it first — its GRNI accrual is the journal ` +
        'this stock movement links to (doc 08 INVENTORY_RECEIPT_AGAINST_PO).',
    );
  }
  return receipt;
}

async function loadGoodsReceiptLines(
  client: PoolClient,
  goodsReceiptId: string,
): Promise<Map<string, GoodsReceiptLine>> {
  const { rows } = await client.query<GoodsReceiptLine>(
    `SELECT id, item_id, purchase_order_line_id, quantity_accepted::text AS quantity_accepted,
            unit_price::text AS unit_price
       FROM goods_receipt_lines WHERE goods_receipt_id = $1`,
    [goodsReceiptId],
  );
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * The per-unit cost of the linked original issue, reproduced from its stored
 * consumption rows — the same rows `getMovementCostBreakdown` returns. Using
 * them, rather than the movement's cached `unit_cost`, means a return is priced
 * by the evidence, and an issue with no consumptions (zero-cost stock) returns
 * at zero rather than at a guess.
 */
async function originalIssueUnitCost(
  client: PoolClient,
  originalMovementId: string,
  itemId: string,
  book: BookContext,
  lineIndex: number,
): Promise<Decimal> {
  const { rows } = await client.query<{
    item_id: string;
    legal_entity_id: string;
    quantity: string;
    status: string;
    total_cost: string;
    reversed: boolean;
  }>(
    `SELECT m.item_id, m.legal_entity_id, m.quantity::text AS quantity, d.status::text AS status,
            coalesce((SELECT sum(c.total_cost) FROM inventory_cost_consumptions c
                       WHERE c.inventory_movement_id = m.id), 0)::text AS total_cost,
            EXISTS (SELECT 1
                      FROM inventory_cost_restorations r
                      JOIN inventory_cost_consumptions rc
                        ON rc.id = r.inventory_cost_consumption_id
                     WHERE rc.inventory_movement_id = m.id) AS reversed
       FROM inventory_movements m
       JOIN inventory_documents d ON d.id = m.inventory_document_id
      WHERE m.id = $1`,
    [originalMovementId],
  );
  const original = rows[0];
  if (!original) throw notFound('inventory_movement', originalMovementId);
  // F-923's other consequence. A reversal has already put this issue's stock
  // and its value back; returning against it too would restore the same units
  // twice — once as layers the reversal reopened, once as a new layer priced
  // off the COGS of an issue that no longer stands. The restoration rows are
  // what make that visible, so this is the first time it could be refused.
  if (original.reversed) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Line ${lineIndex + 1}: issue movement ${originalMovementId} has already been reversed, so ` +
        'its stock is back on the shelf. There is nothing to return against it.',
      { details: { inventory_movement_id: originalMovementId } },
    );
  }
  if (
    original.legal_entity_id !== book.legalEntityId ||
    original.item_id !== itemId ||
    !D(original.quantity).isNegative() ||
    original.status !== 'POSTED'
  ) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Line ${lineIndex + 1}: the original movement must be a posted issue of the same item in ` +
        'the same legal entity — otherwise its cost explains nothing about this return.',
    );
  }
  const issued = D(original.quantity).abs();
  return D(original.total_cost).div(issued, 8);
}
