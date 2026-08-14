import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import { ApService, ProcurementService } from '@acct/subledger';
import { Operation } from '../common/operation';
import {
  code as codeField,
  currencyCode,
  decimalString,
  email as emailField,
  isoDate,
  name as nameField,
  parse,
  reason as reasonField,
  uuid,
} from '../common/validation';
import type { AuthenticatedRequest } from '../common/auth.guard';
import { tenantPrincipal } from '../common/request';

/**
 * doc 05 — vendors, procurement and everything that ends in money leaving.
 *
 * Two things here are split across routes rather than folded into one body, and
 * both splits are the control rather than an aesthetic: a vendor's bank details
 * have their own route and their own permission, because changing where a vendor
 * is paid is the classic payment-fraud vector; and approving a payment run is a
 * different permission from executing one, because a role holding both sides
 * bypasses maker/checker without touching the API.
 */

const BillLine = z.object({
  line_no: z.number().int().min(1).max(9999).optional(),
  description: z.string().trim().min(1).max(500),
  quantity: decimalString,
  unit_price: decimalString,
  destination_account_id: uuid,
  tax_code_id: uuid.optional(),
  inclusive: z.boolean().optional(),
  purchase_order_line_id: uuid.optional(),
  goods_receipt_line_id: uuid.optional(),
  capitalize_as_asset: z.boolean().optional(),
  dimensions: z.record(uuid).optional(),
});

const ContactBody = {
  organization_id: uuid,
  legal_entity_id: uuid.optional(),
  code: codeField.optional(),
  legal_name: nameField,
  display_name: nameField.optional(),
  email: emailField.optional(),
  phone: z.string().trim().max(40).optional(),
  tax_identifier: z.string().trim().max(60).optional(),
  default_currency: currencyCode.optional(),
  payment_terms_days: z.number().int().min(0).max(365).optional(),
};

const VendorBody = z.object({
  ...ContactBody,
  ap_account_id: uuid.optional(),
  expense_account_id: uuid.optional(),
  purchase_tax_code_id: uuid.optional(),
  billing_address: z.record(z.unknown()).optional(),
});

const VendorPatchBody = z.object({
  legal_name: nameField.optional(),
  display_name: nameField.optional(),
  email: emailField.optional(),
  phone: z.string().trim().max(40).optional(),
  tax_identifier: z.string().trim().max(60).optional(),
  default_currency: currencyCode.optional(),
  payment_terms_days: z.number().int().min(0).max(365).optional(),
  ap_account_id: uuid.nullable().optional(),
  expense_account_id: uuid.nullable().optional(),
  purchase_tax_code_id: uuid.nullable().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']).optional(),
});

/**
 * Note what is absent: every bank field. `updateVendor` may not reach them, and
 * the schema here is what makes that true at the edge rather than only in the
 * service — an unknown key is stripped, so a request that smuggles
 * `account_number` into a PATCH /vendors/{id} changes nothing.
 */
const BankDetailsBody = z.object({
  reason: reasonField,
  account_holder_name: z.string().trim().max(200).optional(),
  account_number: z.string().trim().max(64).optional(),
  bank_name: z.string().trim().max(200).optional(),
  branch_code: z.string().trim().max(40).optional(),
  iban: z.string().trim().max(40).optional(),
  swift_bic: z.string().trim().max(20).optional(),
  currency: currencyCode.optional(),
  country_code: z.string().trim().toUpperCase().length(2).optional(),
  encrypted_ref: z.string().trim().max(200).optional(),
});

const Allocations = z.object({
  allocations: z
    .array(
      z.object({
        target_type: z.enum(['VENDOR_BILL', 'VENDOR_CREDIT']),
        target_id: uuid,
        amount: decimalString,
      }),
    )
    .min(1)
    .max(200),
});

@Controller()
export class ApController {
  constructor(
    @Inject(ApService) private readonly ap: ApService,
    @Inject(ProcurementService) private readonly procurement: ProcurementService,
  ) {}

  // -------------------------------------------------------------------------
  // Vendors
  // -------------------------------------------------------------------------

  @Get('vendors')
  @Operation('listVendors')
  async listVendors(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({ organization_id: uuid.optional(), search: z.string().trim().max(80).optional() }),
      query,
    );
    return this.ap.listVendors(tenantPrincipal(request), {
      organizationId: parsed.organization_id,
      search: parsed.search,
    });
  }

  @Post('vendors')
  @Operation('createVendor')
  async createVendor(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(VendorBody, body);
    return this.ap.createVendor(tenantPrincipal(request), {
      organizationId: input.organization_id,
      legalEntityId: input.legal_entity_id,
      code: input.code,
      legalName: input.legal_name,
      displayName: input.display_name,
      email: input.email,
      phone: input.phone,
      taxIdentifier: input.tax_identifier,
      defaultCurrency: input.default_currency,
      paymentTermsDays: input.payment_terms_days,
      apAccountId: input.ap_account_id,
      expenseAccountId: input.expense_account_id,
      purchaseTaxCodeId: input.purchase_tax_code_id,
      billingAddress: input.billing_address,
    });
  }

  @Get('vendors/:id')
  @Operation('getVendor')
  async getVendor(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.ap.getVendor(tenantPrincipal(request), parse(uuid, id));
  }

  @Patch('vendors/:id')
  @Operation('updateVendor')
  async updateVendor(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string,
    @Body() body: unknown,
  ) {
    const input = parse(VendorPatchBody, body);
    return this.ap.updateVendor(tenantPrincipal(request), parse(uuid, id), input, ifMatch ?? null);
  }

  @Patch('vendors/:id/bank-details')
  @Operation('updateVendorBankDetails')
  async updateBankDetails(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(BankDetailsBody, body);
    return this.ap.updateVendorBankDetails(tenantPrincipal(request), parse(uuid, id), {
      reason: input.reason,
      accountHolderName: input.account_holder_name,
      accountNumber: input.account_number,
      bankName: input.bank_name,
      branchCode: input.branch_code,
      iban: input.iban,
      swiftBic: input.swift_bic,
      currency: input.currency,
      countryCode: input.country_code,
      encryptedRef: input.encrypted_ref,
    });
  }

  // -------------------------------------------------------------------------
  // Requisitions and purchase orders
  // -------------------------------------------------------------------------

  @Get('purchase-requisitions')
  @Operation('listPurchaseRequisitions')
  async listRequisitions(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({
        legal_entity_id: uuid.optional(),
        requester_id: uuid.optional(),
        status: z.string().trim().max(40).optional(),
      }),
      query,
    );
    return this.procurement.listPurchaseRequisitions(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
      requesterId: parsed.requester_id,
      status: parsed.status,
    });
  }

  @Post('purchase-requisitions')
  @Operation('createPurchaseRequisition')
  async createRequisition(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(
      z.object({
        legal_entity_id: uuid,
        branch_id: uuid.optional(),
        requester_id: uuid.optional(),
        business_reason: z.string().trim().max(2000).optional(),
        suggested_vendor_id: uuid.optional(),
        required_date: isoDate.optional(),
        // Required, not defaulted: a requisition is a spending request, and one
        // whose currency was assumed is an approval for an amount nobody stated.
        currency: currencyCode,
        lines: z
          .array(
            z.object({
              line_no: z.number().int().min(1).max(9999).optional(),
              item_id: uuid.optional(),
              description: z.string().trim().min(1).max(500),
              quantity: decimalString,
              estimated_price: decimalString,
            }),
          )
          .min(1)
          .max(500),
      }),
      body,
    );
    return this.procurement.createPurchaseRequisition(tenantPrincipal(request), {
      legalEntityId: input.legal_entity_id,
      branchId: input.branch_id,
      requesterId: input.requester_id,
      businessReason: input.business_reason,
      suggestedVendorId: input.suggested_vendor_id,
      requiredDate: input.required_date,
      currency: input.currency,
      lines: input.lines.map((l) => ({
        lineNo: l.line_no,
        itemId: l.item_id,
        description: l.description,
        quantity: l.quantity,
        estimatedPrice: l.estimated_price,
      })),
    });
  }

  @Post('purchase-requisitions/:id/approve')
  @Operation('approvePurchaseRequisition')
  async approveRequisition(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.procurement.approvePurchaseRequisition(tenantPrincipal(request), parse(uuid, id));
  }

  @Get('purchase-orders')
  @Operation('listPurchaseOrders')
  async listPurchaseOrders(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({
        legal_entity_id: uuid.optional(),
        vendor_id: uuid.optional(),
        status: z.string().trim().max(40).optional(),
      }),
      query,
    );
    return this.procurement.listPurchaseOrders(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
      vendorId: parsed.vendor_id,
      status: parsed.status,
    });
  }

  @Post('purchase-orders')
  @Operation('createPurchaseOrder')
  async createPurchaseOrder(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(
      z.object({
        legal_entity_id: uuid,
        branch_id: uuid.optional(),
        vendor_id: uuid,
        requisition_id: uuid.optional(),
        document_date: isoDate,
        expected_date: isoDate.optional(),
        currency: currencyCode.optional(),
        exchange_rate: decimalString.optional(),
        lines: z
          .array(
            z.object({
              line_no: z.number().int().min(1).max(9999).optional(),
              item_id: uuid.optional(),
              description: z.string().trim().min(1).max(500),
              quantity: decimalString,
              uom: z.string().trim().max(20).optional(),
              unit_price: decimalString,
              destination_account_id: uuid.optional(),
              tax_code_id: uuid.optional(),
              inclusive: z.boolean().optional(),
            }),
          )
          .min(1)
          .max(500),
      }),
      body,
    );
    return this.procurement.createPurchaseOrder(tenantPrincipal(request), {
      legalEntityId: input.legal_entity_id,
      branchId: input.branch_id,
      vendorId: input.vendor_id,
      requisitionId: input.requisition_id,
      documentDate: input.document_date,
      expectedDate: input.expected_date,
      currency: input.currency,
      exchangeRate: input.exchange_rate,
      lines: input.lines.map((l) => ({
        lineNo: l.line_no,
        itemId: l.item_id,
        description: l.description,
        quantity: l.quantity,
        uom: l.uom,
        unitPrice: l.unit_price,
        destinationAccountId: l.destination_account_id,
        taxCodeId: l.tax_code_id,
        inclusive: l.inclusive,
      })),
    });
  }

  /**
   * Approval is where doc 10's budget control is enforced, so the body may name
   * the book whose budget controls. Omitted, the entity's primary book is used —
   * which is the book the bill will post to unless someone says otherwise, and
   * requiring it here would make every existing caller of this route wrong.
   */
  @Post('purchase-orders/:id/approve')
  @Operation('approvePurchaseOrder')
  async approvePurchaseOrder(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(z.object({ accounting_book_id: uuid.optional() }), body ?? {});
    return this.procurement.approvePurchaseOrder(tenantPrincipal(request), parse(uuid, id), {
      accountingBookId: input.accounting_book_id,
    });
  }

  /**
   * doc 10: "Closing/canceling PO releases unused commitment."
   *
   * `purchase_order.close`, not `purchase_order.approve`. A permission code is
   * inherited whole by everything that declares it — its risk flag and every
   * grant of it (F-921) — so a new capability gets a new code rather than
   * widening an existing one by stealth.
   */
  @Post('purchase-orders/:id/close')
  @Operation('closePurchaseOrder')
  async closePurchaseOrder(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(
      z.object({
        // CLOSE by default: it is the ordinary end of an order's life, and
        // CANCEL asserts something stronger — that it should never have been
        // placed — which nobody should say by omission.
        action: z.enum(['CLOSE', 'CANCEL']).optional(),
        reason: reasonField.optional(),
      }),
      body ?? {},
    );
    return this.procurement.closePurchaseOrder(tenantPrincipal(request), parse(uuid, id), {
      action: input.action,
      reason: input.reason,
    });
  }

  // -------------------------------------------------------------------------
  // Goods receipts
  // -------------------------------------------------------------------------

  @Get('goods-receipts')
  @Operation('listGoodsReceipts')
  async listGoodsReceipts(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({
        legal_entity_id: uuid.optional(),
        vendor_id: uuid.optional(),
        purchase_order_id: uuid.optional(),
        status: z.string().trim().max(40).optional(),
      }),
      query,
    );
    return this.ap.listGoodsReceipts(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
      vendorId: parsed.vendor_id,
      purchaseOrderId: parsed.purchase_order_id,
      status: parsed.status,
    });
  }

  @Post('goods-receipts')
  @Operation('createGoodsReceipt')
  async createGoodsReceipt(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(
      z.object({
        accounting_book_id: uuid,
        vendor_id: uuid,
        purchase_order_id: uuid.optional(),
        receipt_kind: z.enum(['GOODS', 'SERVICE']).optional(),
        receipt_date: isoDate,
        posting_date: isoDate,
        location: z.string().trim().max(120).optional(),
        notes: z.string().trim().max(2000).optional(),
        lines: z
          .array(
            z.object({
              line_no: z.number().int().min(1).max(9999).optional(),
              purchase_order_line_id: uuid.optional(),
              description: z.string().trim().min(1).max(500),
              quantity_received: decimalString,
              quantity_accepted: decimalString.optional(),
              quantity_rejected: decimalString.optional(),
              unit_price: decimalString.optional(),
              destination_account_id: uuid.optional(),
              rejection_reason: z.string().trim().max(500).optional(),
            }),
          )
          .min(1)
          .max(500),
      }),
      body,
    );
    return this.ap.createGoodsReceipt(tenantPrincipal(request), {
      accountingBookId: input.accounting_book_id,
      vendorId: input.vendor_id,
      purchaseOrderId: input.purchase_order_id,
      receiptKind: input.receipt_kind,
      receiptDate: input.receipt_date,
      postingDate: input.posting_date,
      location: input.location,
      notes: input.notes,
      lines: input.lines.map((l) => ({
        lineNo: l.line_no,
        purchaseOrderLineId: l.purchase_order_line_id,
        description: l.description,
        quantityReceived: l.quantity_received,
        quantityAccepted: l.quantity_accepted,
        quantityRejected: l.quantity_rejected,
        unitPrice: l.unit_price,
        destinationAccountId: l.destination_account_id,
        rejectionReason: l.rejection_reason,
      })),
    });
  }

  @Post('goods-receipts/:id/post')
  @Operation('postGoodsReceipt')
  async postGoodsReceipt(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.ap.postGoodsReceipt(tenantPrincipal(request), parse(uuid, id));
  }

  // -------------------------------------------------------------------------
  // Vendor bills
  // -------------------------------------------------------------------------

  @Get('vendor-bills')
  @Operation('listVendorBills')
  async listBills(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({
        legal_entity_id: uuid.optional(),
        vendor_id: uuid.optional(),
        status: z.string().trim().max(40).optional(),
      }),
      query,
    );
    return this.ap.listBills(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
      vendorId: parsed.vendor_id,
      status: parsed.status,
    });
  }

  @Post('vendor-bills')
  @Operation('createVendorBill')
  async createBill(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(
      z.object({
        accounting_book_id: uuid,
        vendor_id: uuid,
        branch_id: uuid.optional(),
        purchase_order_id: uuid.optional(),
        vendor_invoice_number: z.string().trim().min(1).max(80),
        document_date: isoDate,
        posting_date: isoDate,
        due_date: isoDate.optional(),
        currency: currencyCode.optional(),
        exchange_rate: decimalString.optional(),
        source_document_hash: z.string().trim().max(128).optional(),
        // doc 05: the duplicate override needs a permission AND a reason. The
        // reason is the whole audit trail for a deliberate second payment.
        duplicate_override_reason: reasonField.optional(),
        lines: z.array(BillLine).min(1).max(1000),
      }),
      body,
    );
    return this.ap.createBill(tenantPrincipal(request), {
      accountingBookId: input.accounting_book_id,
      vendorId: input.vendor_id,
      branchId: input.branch_id,
      purchaseOrderId: input.purchase_order_id,
      vendorInvoiceNumber: input.vendor_invoice_number,
      documentDate: input.document_date,
      postingDate: input.posting_date,
      dueDate: input.due_date,
      currency: input.currency,
      exchangeRate: input.exchange_rate,
      sourceDocumentHash: input.source_document_hash,
      duplicateOverrideReason: input.duplicate_override_reason,
      lines: input.lines.map((l) => ({
        lineNo: l.line_no,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unit_price,
        destinationAccountId: l.destination_account_id,
        taxCodeId: l.tax_code_id,
        inclusive: l.inclusive,
        purchaseOrderLineId: l.purchase_order_line_id,
        goodsReceiptLineId: l.goods_receipt_line_id,
        capitalizeAsAsset: l.capitalize_as_asset,
        dimensions: l.dimensions,
      })),
    });
  }

  @Post('vendor-bills/:id/match')
  @Operation('matchVendorBill')
  async matchBill(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(
      z.object({
        tolerance: z
          .object({
            quantity_percent: decimalString.optional(),
            price_percent: decimalString.optional(),
            absolute_amount: decimalString.optional(),
          })
          .optional(),
      }),
      body ?? {},
    );
    return this.ap.matchBill(tenantPrincipal(request), parse(uuid, id), {
      tolerance: input.tolerance
        ? {
            ...(input.tolerance.quantity_percent
              ? { quantityPercent: input.tolerance.quantity_percent }
              : {}),
            ...(input.tolerance.price_percent
              ? { pricePercent: input.tolerance.price_percent }
              : {}),
            ...(input.tolerance.absolute_amount
              ? { absoluteAmount: input.tolerance.absolute_amount }
              : {}),
          }
        : undefined,
    });
  }

  @Post('vendor-bills/:id/approve')
  @Operation('approveVendorBill')
  async approveBill(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.ap.approveVendorBill(tenantPrincipal(request), parse(uuid, id));
  }

  @Post('vendor-bills/:id/post')
  @Operation('postVendorBill')
  async postBill(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.ap.postBill(tenantPrincipal(request), parse(uuid, id));
  }

  // -------------------------------------------------------------------------
  // Vendor credits
  // -------------------------------------------------------------------------

  @Get('vendor-credits')
  @Operation('listVendorCredits')
  async listVendorCredits(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({
        legal_entity_id: uuid.optional(),
        vendor_id: uuid.optional(),
        status: z.string().trim().max(40).optional(),
      }),
      query,
    );
    return this.procurement.listVendorCredits(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
      vendorId: parsed.vendor_id,
      status: parsed.status,
    });
  }

  @Post('vendor-credits')
  @Operation('createVendorCredit')
  async createVendorCredit(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(
      // A vendor credit mirrors the bill it credits: no lines of its own, because
      // a posted bill's lines are frozen by trigger and the credit's journal is
      // that bill's lines sign-inverted. Partial credits would need a line table
      // the schema does not have.
      z.object({
        vendor_bill_id: uuid,
        document_date: isoDate,
        posting_date: isoDate,
        reason: z.string().trim().max(1000).optional(),
      }),
      body,
    );
    return this.procurement.createVendorCredit(tenantPrincipal(request), {
      vendorBillId: input.vendor_bill_id,
      documentDate: input.document_date,
      postingDate: input.posting_date,
      reason: input.reason,
    });
  }

  @Post('vendor-credits/:id/post')
  @Operation('postVendorCredit')
  async postVendorCredit(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.procurement.postVendorCredit(tenantPrincipal(request), parse(uuid, id));
  }

  @Post('vendor-credits/:id/apply')
  @Operation('applyVendorCredit')
  async applyVendorCredit(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    // Names bills rather than reusing the generic allocation vocabulary: a
    // vendor credit applies to vendor bills and to nothing else.
    const input = parse(
      z.object({
        applications: z
          .array(z.object({ vendor_bill_id: uuid, amount: decimalString }))
          .min(1)
          .max(200),
      }),
      body,
    );
    return this.procurement.applyVendorCredit(
      tenantPrincipal(request),
      parse(uuid, id),
      input.applications.map((a) => ({ vendorBillId: a.vendor_bill_id, amount: a.amount })),
    );
  }

  // -------------------------------------------------------------------------
  // Expense claims
  // -------------------------------------------------------------------------

  @Get('expense-claims')
  @Operation('listExpenseClaims')
  async listExpenseClaims(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({
        legal_entity_id: uuid.optional(),
        claimant_user_id: uuid.optional(),
        status: z.string().trim().max(40).optional(),
      }),
      query,
    );
    return this.procurement.listExpenseClaims(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
      claimantUserId: parsed.claimant_user_id,
      status: parsed.status,
    });
  }

  @Post('expense-claims')
  @Operation('createExpenseClaim')
  async createExpenseClaim(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(
      z.object({
        accounting_book_id: uuid,
        // Absent means the caller. Someone else's claim needs the permission, and
        // the approver can never be the claimant either way.
        claimant_user_id: uuid.optional(),
        document_date: isoDate,
        currency: currencyCode.optional(),
        lines: z
          .array(
            z.object({
              line_no: z.number().int().min(1).max(9999).optional(),
              expense_date: isoDate,
              merchant: z.string().trim().max(200).optional(),
              category: z.string().trim().max(80).optional(),
              business_purpose: z.string().trim().max(500).optional(),
              // What the employee actually paid — gross, tax inside. An expense
              // line is a till receipt, so it is always tax-inclusive.
              amount: decimalString,
              expense_account_id: uuid,
              tax_code_id: uuid.optional(),
              receipt_file_id: uuid.optional(),
              is_company_card: z.boolean().optional(),
            }),
          )
          .min(1)
          .max(200),
      }),
      body,
    );
    return this.procurement.createExpenseClaim(tenantPrincipal(request), {
      accountingBookId: input.accounting_book_id,
      claimantUserId: input.claimant_user_id,
      documentDate: input.document_date,
      currency: input.currency,
      lines: input.lines.map((l) => ({
        lineNo: l.line_no,
        expenseDate: l.expense_date,
        merchant: l.merchant,
        category: l.category,
        businessPurpose: l.business_purpose,
        amount: l.amount,
        expenseAccountId: l.expense_account_id,
        taxCodeId: l.tax_code_id,
        receiptFileId: l.receipt_file_id,
        isCompanyCard: l.is_company_card,
      })),
    });
  }

  @Post('expense-claims/:id/submit')
  @Operation('submitExpenseClaim')
  async submitExpenseClaim(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.procurement.submitExpenseClaim(tenantPrincipal(request), parse(uuid, id));
  }

  @Post('expense-claims/:id/approve')
  @Operation('approveExpenseClaim')
  async approveExpenseClaim(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    // The claimant can never reach this on their own claim — the service raises
    // SEGREGATION_OF_DUTIES before it looks at anything else.
    return this.procurement.approveExpenseClaim(tenantPrincipal(request), parse(uuid, id));
  }

  @Post('expense-claims/:id/post')
  @Operation('postExpenseClaim')
  async postExpenseClaim(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(
      z.object({
        posting_date: isoDate.optional(),
        // journal_lines.contact_id references contacts and a claimant is a user,
        // so reimbursing through a contact is what makes the payable drillable to
        // a person. Without one the credit lands on the AP control account and
        // the claim itself is the subledger detail.
        employee_vendor_id: uuid.optional(),
      }),
      body ?? {},
    );
    return this.procurement.postExpenseClaim(tenantPrincipal(request), parse(uuid, id), {
      postingDate: input.posting_date,
      employeeVendorId: input.employee_vendor_id,
    });
  }

  // -------------------------------------------------------------------------
  // Payments
  // -------------------------------------------------------------------------

  @Get('vendor-payments')
  @Operation('listVendorPayments')
  async listPayments(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({
        legal_entity_id: uuid.optional(),
        vendor_id: uuid.optional(),
        status: z.string().trim().max(40).optional(),
      }),
      query,
    );
    return this.ap.listPayments(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
      vendorId: parsed.vendor_id,
      status: parsed.status,
    });
  }

  @Post('vendor-payments')
  @Operation('createVendorPayment')
  async createPayment(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(
      z.object({
        accounting_book_id: uuid,
        vendor_id: uuid,
        branch_id: uuid.optional(),
        document_date: isoDate,
        posting_date: isoDate,
        currency: currencyCode.optional(),
        exchange_rate: decimalString.optional(),
        amount: decimalString,
        payment_method: z.string().trim().max(40).optional(),
        bank_account_id: uuid.optional(),
        external_reference: z.string().trim().max(120).optional(),
        // Allocating at creation is the ordinary case, and doing it in the same
        // transaction as the posting is what keeps the payment's journal and the
        // bills it settles from ever disagreeing.
        allocations: Allocations.shape.allocations.optional(),
      }),
      body,
    );
    return this.ap.createPayment(tenantPrincipal(request), {
      accountingBookId: input.accounting_book_id,
      vendorId: input.vendor_id,
      branchId: input.branch_id,
      documentDate: input.document_date,
      postingDate: input.posting_date,
      currency: input.currency,
      exchangeRate: input.exchange_rate,
      amount: input.amount,
      paymentMethod: input.payment_method,
      bankAccountId: input.bank_account_id,
      externalReference: input.external_reference,
      allocations: input.allocations?.map((a) => ({
        targetType: a.target_type,
        targetId: a.target_id,
        amount: a.amount,
      })),
    });
  }

  @Post('vendor-payments/:id/allocate')
  @Operation('allocateVendorPayment')
  async allocatePayment(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(Allocations, body);
    return this.ap.allocatePayment(
      tenantPrincipal(request),
      parse(uuid, id),
      input.allocations.map((a) => ({
        targetType: a.target_type,
        targetId: a.target_id,
        amount: a.amount,
      })),
    );
  }

  @Post('vendor-payments/:id/confirm')
  @Operation('confirmVendorPayment')
  async confirmPayment(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(
      z.object({
        // The bank's answer, not ours. FAILED is as ordinary an outcome as
        // CONFIRMED and reverses the allocations (F-715).
        outcome: z.enum(['CONFIRMED', 'FAILED']),
        bank_reference: z.string().trim().max(120).optional(),
        reason: z.string().trim().max(1000).optional(),
      }),
      body,
    );
    return this.ap.confirmPayment(tenantPrincipal(request), parse(uuid, id), {
      outcome: input.outcome,
      bankReference: input.bank_reference,
      reason: input.reason,
    });
  }

  // -------------------------------------------------------------------------
  // Payment runs
  // -------------------------------------------------------------------------

  @Get('payment-runs')
  @Operation('listPaymentRuns')
  async listPaymentRuns(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({ legal_entity_id: uuid.optional(), status: z.string().trim().max(40).optional() }),
      query,
    );
    return this.procurement.listPaymentRuns(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
      status: parsed.status,
    });
  }

  @Post('payment-runs')
  @Operation('createPaymentRun')
  async createPaymentRun(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(
      z.object({
        accounting_book_id: uuid,
        payment_date: isoDate,
        // Required: a run pays one currency. Selecting across currencies would
        // need a conversion nobody approved.
        currency: currencyCode,
        due_on_or_before: isoDate.optional(),
        bank_account_id: uuid.optional(),
      }),
      body,
    );
    return this.procurement.createPaymentRun(tenantPrincipal(request), {
      accountingBookId: input.accounting_book_id,
      paymentDate: input.payment_date,
      currency: input.currency,
      dueOnOrBefore: input.due_on_or_before,
      bankAccountId: input.bank_account_id,
    });
  }

  @Post('payment-runs/:id/approve')
  @Operation('approvePaymentRun')
  async approvePaymentRun(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.procurement.approvePaymentRun(tenantPrincipal(request), parse(uuid, id));
  }

  @Post('payment-runs/:id/execute')
  @Operation('executePaymentRun')
  async executePaymentRun(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.procurement.executePaymentRun(tenantPrincipal(request), parse(uuid, id));
  }

  // -------------------------------------------------------------------------
  // Payment holds
  // -------------------------------------------------------------------------

  @Get('payment-holds')
  @Operation('listPaymentHolds')
  async listHolds(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(z.object({ active: z.coerce.boolean().optional() }), query);
    return this.ap.listHolds(tenantPrincipal(request), { active: parsed.active });
  }

  @Post('payment-holds')
  @Operation('placePaymentHold')
  async placeHold(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(
      z.object({
        scope_type: z.enum(['VENDOR', 'VENDOR_BILL']),
        scope_id: uuid,
        reason: reasonField,
      }),
      body,
    );
    return this.ap.placeHold(tenantPrincipal(request), {
      scopeType: input.scope_type,
      scopeId: input.scope_id,
      reason: input.reason,
    });
  }

  @Post('payment-holds/:id/release')
  @Operation('releasePaymentHold')
  async releaseHold(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    // Released, never deleted: who held payment to a vendor and who let it go is
    // exactly what an investigation asks, so the release carries its own reason.
    const input = parse(z.object({ reason: reasonField }), body);
    return this.ap.releaseHold(tenantPrincipal(request), parse(uuid, id), input.reason);
  }
}
