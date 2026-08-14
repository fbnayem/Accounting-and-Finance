import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import {
  InventoryDocumentsService,
  InventoryPostingService,
  InventoryReportsService,
  ItemsService,
  LandedCostService,
  StockCountsService,
  WarehousesService,
} from '@acct/inventory';
import { Operation } from '../common/operation';
import { decimalString, isoDate, parse, uuid } from '../common/validation';
import type { AuthenticatedRequest } from '../common/auth.guard';
import { tenantPrincipal } from '../common/request';

/**
 * doc 08's twenty-five operations.
 *
 * One controller, because they share one subject — stock — and splitting them
 * by table would put the valuation report somewhere other than the movements it
 * values. The two /reports routes are answered here too: their numbers are
 * computed by @acct/inventory, and a second computation elsewhere would be the
 * rival that disagrees. Each handler declares only which contract operation it
 * is; the permission, the idempotency rule and the success status come from
 * `contracts/openapi.yaml` at request time.
 */

const Money = decimalString;
/** Quantities cross the wire as decimal strings for the same ADR-0006 reason money does. */
const Quantity = decimalString;

/**
 * The six header fields every stock document shares (ADR-0007's uniform shape).
 * One schema and one mapper, so a document type cannot silently drop or rename
 * a header field the others carry.
 */
const DocumentHeader = z.object({
  accounting_book_id: uuid,
  document_date: isoDate,
  posting_date: isoDate,
  branch_id: uuid.nullish(),
  document_number: z.string().nullish(),
  metadata: z.record(z.unknown()).optional(),
});

const headerInput = (b: z.infer<typeof DocumentHeader>) => ({
  accountingBookId: b.accounting_book_id,
  documentDate: b.document_date,
  postingDate: b.posting_date,
  branchId: b.branch_id,
  documentNumber: b.document_number,
  metadata: b.metadata,
});

/**
 * Per-entity account mappings — F-033's grain. Shared between create and
 * update, because the nine columns are the same nine columns and two copies of
 * this list is how one of them drifts.
 */
const ItemAccounting = z.object({
  legal_entity_id: uuid,
  inventory_account_id: uuid.nullish(),
  cogs_account_id: uuid.nullish(),
  revenue_account_id: uuid.nullish(),
  purchase_account_id: uuid.nullish(),
  variance_account_id: uuid.nullish(),
  sales_tax_code_id: uuid.nullish(),
  purchase_tax_code_id: uuid.nullish(),
  valuation_override: z.string().nullish(),
  negative_stock_policy: z.string().nullish(),
});

const accountingInputs = (rows: readonly z.infer<typeof ItemAccounting>[] | undefined) =>
  rows?.map((s) => ({
    legalEntityId: s.legal_entity_id,
    inventoryAccountId: s.inventory_account_id,
    cogsAccountId: s.cogs_account_id,
    revenueAccountId: s.revenue_account_id,
    purchaseAccountId: s.purchase_account_id,
    varianceAccountId: s.variance_account_id,
    salesTaxCodeId: s.sales_tax_code_id,
    purchaseTaxCodeId: s.purchase_tax_code_id,
    valuationOverride: s.valuation_override,
    negativeStockPolicy: s.negative_stock_policy,
  }));

@Controller()
export class InventoryController {
  constructor(
    @Inject(ItemsService) private readonly items: ItemsService,
    @Inject(WarehousesService) private readonly warehouses: WarehousesService,
    @Inject(InventoryDocumentsService) private readonly documents: InventoryDocumentsService,
    @Inject(InventoryPostingService) private readonly posting: InventoryPostingService,
    @Inject(StockCountsService) private readonly counts: StockCountsService,
    @Inject(LandedCostService) private readonly landedCosts: LandedCostService,
    @Inject(InventoryReportsService) private readonly reports: InventoryReportsService,
  ) {}

  // --- item master ---------------------------------------------------------

  @Get('items')
  @Operation('listItems')
  async listItems(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(
      z.object({
        organization_id: uuid.optional(),
        legal_entity_id: uuid.optional(),
        kind: z.string().optional(),
        status: z.string().optional(),
      }),
      query,
    );
    return this.items.listItems(tenantPrincipal(req), {
      organizationId: q.organization_id,
      legalEntityId: q.legal_entity_id,
      kind: q.kind,
      status: q.status,
    });
  }

  @Post('items')
  @Operation('createItem')
  async createItem(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const b = parse(
      z.object({
        organization_id: uuid,
        sku: z.string().min(1),
        name: z.string().min(1),
        kind: z.string().min(1),
        base_uom: z.string().min(1),
        barcode: z.string().nullish(),
        sales_description: z.string().nullish(),
        purchase_description: z.string().nullish(),
        item_category_id: uuid.nullish(),
        valuation: z.string().optional(),
        lot_tracking: z.boolean().optional(),
        serial_tracking: z.boolean().optional(),
        expiry_tracking: z.boolean().optional(),
        reorder_level: Quantity.nullish(),
        negative_stock_policy: z.string().optional(),
        accounting: z.array(ItemAccounting).optional(),
      }),
      body,
    );
    return this.items.createItem(tenantPrincipal(req), {
      organizationId: b.organization_id,
      sku: b.sku,
      name: b.name,
      kind: b.kind,
      baseUom: b.base_uom,
      barcode: b.barcode,
      salesDescription: b.sales_description,
      purchaseDescription: b.purchase_description,
      itemCategoryId: b.item_category_id,
      valuation: b.valuation,
      lotTracking: b.lot_tracking,
      serialTracking: b.serial_tracking,
      expiryTracking: b.expiry_tracking,
      reorderLevel: b.reorder_level,
      negativeStockPolicy: b.negative_stock_policy,
      accounting: accountingInputs(b.accounting),
    });
  }

  @Patch('items/:id')
  @Operation('updateItem')
  async updateItem(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    // No `valuation` field here on purpose — the contract refuses it (F-906),
    // and the service explains why: layers already consumed under the old
    // method would be reinterpreted.
    const b = parse(
      z.object({
        name: z.string().min(1).optional(),
        barcode: z.string().nullish(),
        sales_description: z.string().nullish(),
        purchase_description: z.string().nullish(),
        item_category_id: uuid.nullish(),
        reorder_level: Quantity.nullish(),
        negative_stock_policy: z.string().optional(),
        status: z.string().optional(),
        accounting: z.array(ItemAccounting).optional(),
      }),
      body,
    );
    return this.items.updateItem(tenantPrincipal(req), id, {
      name: b.name,
      barcode: b.barcode,
      salesDescription: b.sales_description,
      purchaseDescription: b.purchase_description,
      itemCategoryId: b.item_category_id,
      reorderLevel: b.reorder_level,
      negativeStockPolicy: b.negative_stock_policy,
      status: b.status,
      accounting: accountingInputs(b.accounting),
    });
  }

  // --- warehouses and locations --------------------------------------------

  @Get('warehouses')
  @Operation('listWarehouses')
  async listWarehouses(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(z.object({ legal_entity_id: uuid.optional() }), query);
    return this.warehouses.listWarehouses(tenantPrincipal(req), {
      legalEntityId: q.legal_entity_id,
    });
  }

  @Post('warehouses')
  @Operation('createWarehouse')
  async createWarehouse(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const b = parse(
      z.object({
        legal_entity_id: uuid,
        code: z.string().min(1),
        name: z.string().min(1),
        branch_id: uuid.nullish(),
      }),
      body,
    );
    return this.warehouses.createWarehouse(tenantPrincipal(req), {
      legalEntityId: b.legal_entity_id,
      code: b.code,
      name: b.name,
      branchId: b.branch_id,
    });
  }

  @Get('warehouses/:id/locations')
  @Operation('listWarehouseLocations')
  async listLocations(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.warehouses.listLocations(tenantPrincipal(req), id);
  }

  @Post('warehouses/:id/locations')
  @Operation('createWarehouseLocation')
  async createLocation(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(
      z.object({
        code: z.string().min(1),
        name: z.string().min(1),
        kind: z.string().optional(),
        parent_id: uuid.nullish(),
      }),
      body,
    );
    return this.warehouses.createLocation(tenantPrincipal(req), id, {
      code: b.code,
      name: b.name,
      kind: b.kind,
      parentId: b.parent_id,
    });
  }

  // --- stock documents: create (DRAFT — posting is a separate act, F-902) ---

  @Post('inventory/receipts')
  @Operation('createInventoryReceipt')
  async createReceipt(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const b = parse(
      DocumentHeader.extend({
        warehouse_id: uuid,
        goods_receipt_id: uuid.nullish(),
        purchase_order_id: uuid.nullish(),
        lines: z
          .array(
            z.object({
              item_id: uuid,
              to_location_id: uuid,
              quantity: Quantity,
              unit_cost: Money.optional(),
              uom: z.string().optional(),
              stock_lot_id: uuid.nullish(),
              goods_receipt_line_id: uuid.nullish(),
            }),
          )
          .min(1),
      }),
      body,
    );
    return this.documents.createReceipt(tenantPrincipal(req), {
      ...headerInput(b),
      warehouseId: b.warehouse_id,
      goodsReceiptId: b.goods_receipt_id,
      purchaseOrderId: b.purchase_order_id,
      lines: b.lines.map((l) => ({
        itemId: l.item_id,
        toLocationId: l.to_location_id,
        quantity: l.quantity,
        unitCost: l.unit_cost,
        uom: l.uom,
        stockLotId: l.stock_lot_id,
        goodsReceiptLineId: l.goods_receipt_line_id,
      })),
    });
  }

  @Post('inventory/issues')
  @Operation('createInventoryIssue')
  async createIssue(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    // No unit_cost on issue lines: an issue is valued by layer consumption at
    // posting time, and a caller-priced issue is one the valuation engine
    // cannot reproduce (see InventoryDocumentsService.createIssue).
    const b = parse(
      DocumentHeader.extend({
        warehouse_id: uuid.nullish(),
        sales_order_id: uuid.nullish(),
        invoice_id: uuid.nullish(),
        lines: z
          .array(
            z.object({
              item_id: uuid,
              from_location_id: uuid,
              quantity: Quantity,
              uom: z.string().optional(),
              stock_lot_id: uuid.nullish(),
              serial_unit_id: uuid.nullish(),
            }),
          )
          .min(1),
      }),
      body,
    );
    return this.documents.createIssue(tenantPrincipal(req), {
      ...headerInput(b),
      warehouseId: b.warehouse_id,
      salesOrderId: b.sales_order_id,
      invoiceId: b.invoice_id,
      lines: b.lines.map((l) => ({
        itemId: l.item_id,
        fromLocationId: l.from_location_id,
        quantity: l.quantity,
        uom: l.uom,
        stockLotId: l.stock_lot_id,
        serialUnitId: l.serial_unit_id,
      })),
    });
  }

  @Post('inventory/transfers')
  @Operation('createInventoryTransfer')
  async createTransfer(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const b = parse(
      DocumentHeader.extend({
        lines: z
          .array(
            z.object({
              item_id: uuid,
              from_location_id: uuid,
              to_location_id: uuid,
              quantity: Quantity,
              uom: z.string().optional(),
              stock_lot_id: uuid.nullish(),
            }),
          )
          .min(1),
      }),
      body,
    );
    return this.documents.createTransfer(tenantPrincipal(req), {
      ...headerInput(b),
      lines: b.lines.map((l) => ({
        itemId: l.item_id,
        fromLocationId: l.from_location_id,
        toLocationId: l.to_location_id,
        quantity: l.quantity,
        uom: l.uom,
        stockLotId: l.stock_lot_id,
      })),
    });
  }

  @Post('inventory/adjustments')
  @Operation('createInventoryAdjustment')
  async createAdjustment(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const b = parse(
      DocumentHeader.extend({
        warehouse_id: uuid.nullish(),
        reason: z.string().optional(),
        lines: z
          .array(
            z.object({
              item_id: uuid,
              location_id: uuid,
              // Signed: positive is a gain into the location, negative a
              // write-down out of it — the one document type where direction
              // comes from the sign rather than the type.
              quantity: Quantity,
              unit_cost: Money.optional(),
              uom: z.string().optional(),
              stock_lot_id: uuid.nullish(),
            }),
          )
          .min(1),
      }),
      body,
    );
    return this.documents.createAdjustment(tenantPrincipal(req), {
      ...headerInput(b),
      warehouseId: b.warehouse_id,
      reason: b.reason,
      lines: b.lines.map((l) => ({
        itemId: l.item_id,
        locationId: l.location_id,
        quantity: l.quantity,
        unitCost: l.unit_cost,
        uom: l.uom,
        stockLotId: l.stock_lot_id,
      })),
    });
  }

  @Post('inventory/returns')
  @Operation('createInventoryReturn')
  async createReturn(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const b = parse(
      DocumentHeader.extend({
        kind: z.enum(['CUSTOMER_RETURN', 'VENDOR_RETURN']),
        invoice_id: uuid.nullish(),
        vendor_bill_id: uuid.nullish(),
        purchase_order_id: uuid.nullish(),
        lines: z
          .array(
            z.object({
              item_id: uuid,
              to_location_id: uuid.optional(),
              from_location_id: uuid.optional(),
              quantity: Quantity,
              original_movement_id: uuid.nullish(),
              unit_cost: Money.optional(),
              uom: z.string().optional(),
              stock_lot_id: uuid.nullish(),
            }),
          )
          .min(1),
      }),
      body,
    );
    return this.documents.createReturn(tenantPrincipal(req), {
      ...headerInput(b),
      kind: b.kind,
      invoiceId: b.invoice_id,
      vendorBillId: b.vendor_bill_id,
      purchaseOrderId: b.purchase_order_id,
      lines: b.lines.map((l) => ({
        itemId: l.item_id,
        toLocationId: l.to_location_id,
        fromLocationId: l.from_location_id,
        quantity: l.quantity,
        originalMovementId: l.original_movement_id,
        unitCost: l.unit_cost,
        uom: l.uom,
        stockLotId: l.stock_lot_id,
      })),
    });
  }

  // --- stock counts — F-909's lifecycle: create, count, approve -------------

  @Post('inventory/counts')
  @Operation('createStockCount')
  async createCount(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const b = parse(
      z.object({
        warehouse_id: uuid,
        count_date: isoDate,
        item_ids: z.array(uuid).optional(),
        location_ids: z.array(uuid).optional(),
      }),
      body,
    );
    return this.counts.createCount(tenantPrincipal(req), {
      warehouseId: b.warehouse_id,
      countDate: b.count_date,
      itemIds: b.item_ids,
      locationIds: b.location_ids,
    });
  }

  @Patch('inventory/counts/:id')
  @Operation('updateStockCount')
  async updateCount(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(
      z.object({
        status: z.string().optional(),
        lines: z
          .array(
            z.object({
              id: uuid,
              counted_quantity: Quantity,
              recount_required: z.boolean().optional(),
            }),
          )
          .optional(),
      }),
      body,
    );
    return this.counts.updateCount(tenantPrincipal(req), id, {
      status: b.status,
      lines: b.lines?.map((l) => ({
        id: l.id,
        countedQuantity: l.counted_quantity,
        recountRequired: l.recount_required,
      })),
    });
  }

  @Post('inventory/counts/:id/approve')
  @Operation('approveStockCount')
  async approveCount(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(z.object({ accounting_book_id: uuid, posting_date: isoDate.optional() }), body);
    return this.counts.approveCount(tenantPrincipal(req), id, {
      accountingBookId: b.accounting_book_id,
      postingDate: b.posting_date,
    });
  }

  // --- landed cost ----------------------------------------------------------

  @Post('inventory/landed-costs')
  @Operation('createLandedCost')
  async createLandedCost(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const b = parse(
      z.object({
        accounting_book_id: uuid,
        posting_date: isoDate,
        charge_type: z.string().min(1),
        allocation_basis: z.string().min(1),
        amount: Money,
        clearing_account_id: uuid,
        vendor_bill_id: uuid.nullish(),
        document_number: z.string().nullish(),
        targets: z
          .array(
            z.object({
              cost_layer_id: uuid,
              weight: decimalString.optional(),
              volume: decimalString.optional(),
              manual_amount: Money.optional(),
            }),
          )
          .min(1),
      }),
      body,
    );
    return this.landedCosts.createLandedCost(tenantPrincipal(req), {
      accountingBookId: b.accounting_book_id,
      postingDate: b.posting_date,
      chargeType: b.charge_type,
      allocationBasis: b.allocation_basis,
      amount: b.amount,
      clearingAccountId: b.clearing_account_id,
      vendorBillId: b.vendor_bill_id,
      documentNumber: b.document_number,
      targets: b.targets.map((t) => ({
        costLayerId: t.cost_layer_id,
        weight: t.weight,
        volume: t.volume,
        manualAmount: t.manual_amount,
      })),
    });
  }

  // --- documents: read, post, reverse — F-902 and F-908 --------------------

  @Get('inventory/documents')
  @Operation('listInventoryDocuments')
  async listDocuments(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(
      z.object({
        legal_entity_id: uuid.optional(),
        document_type: z.string().optional(),
        status: z.string().optional(),
        warehouse_id: uuid.optional(),
      }),
      query,
    );
    return this.documents.listDocuments(tenantPrincipal(req), {
      legalEntityId: q.legal_entity_id,
      documentType: q.document_type,
      status: q.status,
      warehouseId: q.warehouse_id,
    });
  }

  @Get('inventory/documents/:id')
  @Operation('getInventoryDocument')
  async getDocument(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.documents.getDocument(tenantPrincipal(req), id);
  }

  @Post('inventory/documents/:id/post')
  @Operation('postInventoryDocument')
  // `Promise<unknown>`: the service's idempotent path returns its non-exported
  // document row type, which declaration emit cannot name from here (TS4053).
  // The wire shape is the service's business either way.
  async postDocument(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<unknown> {
    return this.posting.postDocument(tenantPrincipal(req), id);
  }

  @Post('inventory/documents/:id/reverse')
  @Operation('reverseInventoryDocument')
  async reverseDocument(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(
      z.object({ posting_date: isoDate.optional(), reason: z.string().optional() }),
      body,
    );
    return this.posting.reverseDocument(tenantPrincipal(req), id, {
      postingDate: b.posting_date,
      reason: b.reason,
    });
  }

  @Get('inventory/movements/:id/cost-breakdown')
  @Operation('getMovementCostBreakdown')
  async costBreakdown(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.posting.movementCostBreakdown(tenantPrincipal(req), id);
  }

  // --- reads and reports ----------------------------------------------------

  @Get('inventory/on-hand')
  @Operation('getInventoryOnHand')
  async onHand(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(
      z.object({
        legal_entity_id: uuid.optional(),
        warehouse_id: uuid.optional(),
        item_id: uuid.optional(),
      }),
      query,
    );
    return this.reports.onHand(tenantPrincipal(req), {
      legalEntityId: q.legal_entity_id,
      warehouseId: q.warehouse_id,
      itemId: q.item_id,
    });
  }

  @Get('inventory/valuation')
  @Operation('getInventoryValuation')
  // `Promise<unknown>` here and on the report below for the same TS4053 reason
  // as postDocument: the valuation row type is not exported by the package.
  async valuation(@Req() req: AuthenticatedRequest, @Query() query: unknown): Promise<unknown> {
    const q = parse(
      z.object({
        legal_entity_id: uuid.optional(),
        warehouse_id: uuid.optional(),
        item_id: uuid.optional(),
      }),
      query,
    );
    return this.reports.valuation(tenantPrincipal(req), {
      legalEntityId: q.legal_entity_id,
      warehouseId: q.warehouse_id,
      itemId: q.item_id,
    });
  }

  @Get('reports/inventory-valuation')
  @Operation('getInventoryValuationReport')
  async valuationReport(
    @Req() req: AuthenticatedRequest,
    @Query() query: unknown,
  ): Promise<unknown> {
    const q = parse(
      z.object({ legal_entity_id: uuid.optional(), warehouse_id: uuid.optional() }),
      query,
    );
    return this.reports.valuationReport(tenantPrincipal(req), {
      legalEntityId: q.legal_entity_id,
      warehouseId: q.warehouse_id,
    });
  }

  @Get('reports/inventory-reconciliation')
  @Operation('getInventoryReconciliation')
  async reconciliation(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    // legal_entity_id is required: the reconciliation compares one entity's
    // subledger to that entity's control accounts, and an all-entities blend
    // would hide a difference in one behind an offset in another.
    const q = parse(
      z.object({ legal_entity_id: uuid, accounting_book_id: uuid.optional() }),
      query,
    );
    return this.reports.reconciliation(tenantPrincipal(req), {
      legalEntityId: q.legal_entity_id,
      accountingBookId: q.accounting_book_id,
    });
  }
}
