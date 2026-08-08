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
import { ArService, SalesService, SubledgerReportsService } from '@acct/subledger';
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
 * doc 04 — customers and the sales cycle.
 *
 * The rule that shapes the whole file is doc 04's: "Correction states are
 * handled by credit note/cancel-and-reissue; no editing posted financial
 * values." So `PATCH /invoices/{id}` reaches drafts only, and the routes that
 * change what a customer owes after posting — void-or-credit, credit notes,
 * write-offs — all create a new document that says so.
 */

const InvoiceLine = z.object({
  line_no: z.number().int().min(1).max(9999).optional(),
  description: z.string().trim().min(1).max(500),
  quantity: decimalString,
  unit_price: decimalString,
  discount_amount: decimalString.optional(),
  revenue_account_id: uuid,
  tax_code_id: uuid.optional(),
  inclusive: z.boolean().optional(),
  sales_order_line_id: uuid.optional(),
  dimensions: z.record(uuid).optional(),
});

/** Quotes and orders are non-posting, so their lines carry no revenue account. */
const OfferLine = z.object({
  line_no: z.number().int().min(1).max(9999).optional(),
  description: z.string().trim().min(1).max(500),
  quantity: decimalString,
  unit_price: decimalString,
  discount_amount: decimalString.optional(),
  tax_code_id: uuid.optional(),
  inclusive: z.boolean().optional(),
});

const CustomerBody = z.object({
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
  credit_limit: decimalString.optional(),
  ar_account_id: uuid.optional(),
  revenue_account_id: uuid.optional(),
  sales_tax_code_id: uuid.optional(),
  billing_address: z.record(z.unknown()).optional(),
  collection_owner_id: uuid.optional(),
});

const CustomerPatchBody = z.object({
  legal_name: nameField.optional(),
  display_name: nameField.optional(),
  email: emailField.optional(),
  phone: z.string().trim().max(40).optional(),
  tax_identifier: z.string().trim().max(60).optional(),
  default_currency: currencyCode.optional(),
  payment_terms_days: z.number().int().min(0).max(365).optional(),
  // F-708: a credit limit that can be set once and never revised is not a
  // control. Nullable because removing the limit is a real decision.
  credit_limit: decimalString.nullable().optional(),
  ar_account_id: uuid.nullable().optional(),
  revenue_account_id: uuid.nullable().optional(),
  sales_tax_code_id: uuid.nullable().optional(),
  collection_owner_id: uuid.nullable().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']).optional(),
});

const Allocations = z.object({
  allocations: z
    .array(
      z.object({
        target_type: z.enum(['INVOICE', 'CREDIT_NOTE']),
        target_id: uuid,
        amount: decimalString,
      }),
    )
    .min(1)
    .max(200),
});

const allocationsOf = (list: z.infer<typeof Allocations>['allocations']) =>
  list.map((a) => ({ targetType: a.target_type, targetId: a.target_id, amount: a.amount }));

@Controller()
export class ArController {
  constructor(
    @Inject(ArService) private readonly ar: ArService,
    @Inject(SalesService) private readonly sales: SalesService,
    @Inject(SubledgerReportsService) private readonly reports: SubledgerReportsService,
  ) {}

  // -------------------------------------------------------------------------
  // Customers
  // -------------------------------------------------------------------------

  @Get('customers')
  @Operation('listCustomers')
  async listCustomers(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({ organization_id: uuid.optional(), search: z.string().trim().max(80).optional() }),
      query,
    );
    return this.ar.listContacts(tenantPrincipal(request), 'CUSTOMER', {
      organizationId: parsed.organization_id,
      search: parsed.search,
    });
  }

  @Post('customers')
  @Operation('createCustomer')
  async createCustomer(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(CustomerBody, body);
    return this.ar.createCustomer(tenantPrincipal(request), {
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
      creditLimit: input.credit_limit,
      arAccountId: input.ar_account_id,
      revenueAccountId: input.revenue_account_id,
      salesTaxCodeId: input.sales_tax_code_id,
      billingAddress: input.billing_address,
      collectionOwnerId: input.collection_owner_id,
    });
  }

  @Get('customers/:id')
  @Operation('getCustomer')
  async getCustomer(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.ar.getContact(tenantPrincipal(request), parse(uuid, id), 'CUSTOMER');
  }

  @Patch('customers/:id')
  @Operation('updateCustomer')
  async updateCustomer(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string,
    @Body() body: unknown,
  ) {
    const input = parse(CustomerPatchBody, body);
    return this.ar.updateContact(
      tenantPrincipal(request),
      parse(uuid, id),
      'CUSTOMER',
      input,
      ifMatch ?? null,
    );
  }

  @Get('customers/:id/statement')
  @Operation('getCustomerStatement')
  async statement(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Query() query: unknown,
  ) {
    const parsed = parse(
      z.object({ from: isoDate, to: isoDate, legal_entity_id: uuid.optional() }),
      query,
    );
    return this.reports.customerStatement(tenantPrincipal(request), parse(uuid, id), {
      from: parsed.from,
      to: parsed.to,
      legalEntityId: parsed.legal_entity_id,
    });
  }

  // -------------------------------------------------------------------------
  // Quotes and sales orders
  // -------------------------------------------------------------------------

  @Get('quotes')
  @Operation('listQuotes')
  async listQuotes(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({
        legal_entity_id: uuid.optional(),
        customer_id: uuid.optional(),
        status: z.string().trim().max(40).optional(),
      }),
      query,
    );
    return this.sales.listQuotes(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
      customerId: parsed.customer_id,
      status: parsed.status,
    });
  }

  @Post('quotes')
  @Operation('createQuote')
  async createQuote(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(
      z.object({
        legal_entity_id: uuid,
        customer_id: uuid,
        document_date: isoDate,
        valid_until: isoDate.optional(),
        currency: currencyCode.optional(),
        lines: z.array(OfferLine).min(1).max(500),
      }),
      body,
    );
    return this.sales.createQuote(tenantPrincipal(request), {
      legalEntityId: input.legal_entity_id,
      customerId: input.customer_id,
      documentDate: input.document_date,
      validUntil: input.valid_until,
      currency: input.currency,
      lines: input.lines.map(offerLine),
    });
  }

  @Post('quotes/:id/accept')
  @Operation('acceptQuote')
  async acceptQuote(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.sales.acceptQuote(tenantPrincipal(request), parse(uuid, id));
  }

  @Post('quotes/:id/convert')
  @Operation('convertQuote')
  async convertQuote(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(
      z.object({
        to: z.enum(['SALES_ORDER', 'INVOICE']),
        // Required for an invoice: an invoice posts, and posting needs a book.
        accounting_book_id: uuid.optional(),
        posting_date: isoDate.optional(),
        document_date: isoDate.optional(),
        due_date: isoDate.optional(),
      }),
      body,
    );
    return this.sales.convertQuote(tenantPrincipal(request), parse(uuid, id), {
      to: input.to,
      accountingBookId: input.accounting_book_id,
      postingDate: input.posting_date,
      documentDate: input.document_date,
      dueDate: input.due_date,
    });
  }

  @Get('sales-orders')
  @Operation('listSalesOrders')
  async listSalesOrders(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({
        legal_entity_id: uuid.optional(),
        customer_id: uuid.optional(),
        status: z.string().trim().max(40).optional(),
      }),
      query,
    );
    return this.sales.listSalesOrders(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
      customerId: parsed.customer_id,
      status: parsed.status,
    });
  }

  @Post('sales-orders')
  @Operation('createSalesOrder')
  async createSalesOrder(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(
      z.object({
        legal_entity_id: uuid,
        customer_id: uuid,
        quote_id: uuid.optional(),
        document_date: isoDate,
        requested_date: isoDate.optional(),
        currency: currencyCode.optional(),
        customer_po_ref: z.string().trim().max(120).optional(),
        lines: z.array(OfferLine).min(1).max(500),
      }),
      body,
    );
    return this.sales.createSalesOrder(tenantPrincipal(request), {
      legalEntityId: input.legal_entity_id,
      customerId: input.customer_id,
      quoteId: input.quote_id,
      documentDate: input.document_date,
      requestedDate: input.requested_date,
      currency: input.currency,
      customerPoRef: input.customer_po_ref,
      lines: input.lines.map(offerLine),
    });
  }

  @Post('sales-orders/:id/confirm')
  @Operation('confirmSalesOrder')
  async confirmSalesOrder(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.sales.confirmSalesOrder(tenantPrincipal(request), parse(uuid, id));
  }

  // -------------------------------------------------------------------------
  // Invoices
  // -------------------------------------------------------------------------

  @Get('invoices')
  @Operation('listInvoices')
  async listInvoices(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({
        legal_entity_id: uuid.optional(),
        customer_id: uuid.optional(),
        status: z.string().trim().max(40).optional(),
      }),
      query,
    );
    return this.ar.listInvoices(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
      customerId: parsed.customer_id,
      status: parsed.status,
    });
  }

  @Post('invoices')
  @Operation('createInvoice')
  async createInvoice(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(
      z.object({
        accounting_book_id: uuid,
        customer_id: uuid,
        branch_id: uuid.optional(),
        sales_order_id: uuid.optional(),
        document_date: isoDate,
        posting_date: isoDate,
        due_date: isoDate.optional(),
        currency: currencyCode.optional(),
        exchange_rate: decimalString.optional(),
        exchange_rate_date: isoDate.optional(),
        document_discount: decimalString.optional(),
        terms: z.string().trim().max(2000).optional(),
        notes: z.string().trim().max(2000).optional(),
        lines: z.array(InvoiceLine).min(1).max(1000),
      }),
      body,
    );
    return this.ar.createInvoice(tenantPrincipal(request), {
      accountingBookId: input.accounting_book_id,
      customerId: input.customer_id,
      branchId: input.branch_id,
      salesOrderId: input.sales_order_id,
      documentDate: input.document_date,
      postingDate: input.posting_date,
      dueDate: input.due_date,
      currency: input.currency,
      exchangeRate: input.exchange_rate,
      exchangeRateDate: input.exchange_rate_date,
      documentDiscount: input.document_discount,
      terms: input.terms,
      notes: input.notes,
      lines: input.lines.map(invoiceLine),
    });
  }

  @Get('invoices/:id')
  @Operation('getInvoice')
  async getInvoice(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.ar.getInvoice(tenantPrincipal(request), parse(uuid, id));
  }

  @Patch('invoices/:id')
  @Operation('updateInvoice')
  async updateInvoice(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string,
    @Body() body: unknown,
  ) {
    const input = parse(
      z.object({
        document_date: isoDate.optional(),
        posting_date: isoDate.optional(),
        due_date: isoDate.optional(),
        exchange_rate: decimalString.optional(),
        exchange_rate_date: isoDate.optional(),
        document_discount: decimalString.optional(),
        terms: z.string().trim().max(2000).optional(),
        notes: z.string().trim().max(2000).optional(),
        // Replacing the set whole, not patching individual lines: a partial line
        // edit has no way to express "this line is gone" (F-609's lesson on
        // dimension rules, one document over).
        lines: z.array(InvoiceLine).min(1).max(1000).optional(),
      }),
      body,
    );
    return this.ar.updateInvoice(
      tenantPrincipal(request),
      parse(uuid, id),
      {
        documentDate: input.document_date,
        postingDate: input.posting_date,
        dueDate: input.due_date,
        exchangeRate: input.exchange_rate,
        exchangeRateDate: input.exchange_rate_date,
        documentDiscount: input.document_discount,
        terms: input.terms,
        notes: input.notes,
        lines: input.lines?.map(invoiceLine),
      },
      ifMatch ?? null,
    );
  }

  @Post('invoices/:id/approve')
  @Operation('approveInvoice')
  async approveInvoice(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.ar.approveInvoice(tenantPrincipal(request), parse(uuid, id));
  }

  @Post('invoices/:id/post')
  @Operation('postInvoice')
  async postInvoice(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.ar.postInvoice(tenantPrincipal(request), parse(uuid, id));
  }

  @Post('invoices/:id/send')
  @Operation('sendInvoice')
  async sendInvoice(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(
      z.object({
        to: z.array(emailField).max(10).optional(),
        note: z.string().trim().max(2000).optional(),
      }),
      body ?? {},
    );
    return this.ar.sendInvoice(tenantPrincipal(request), parse(uuid, id), {
      to: input.to,
      note: input.note,
    });
  }

  @Post('invoices/:id/void-or-credit')
  @Operation('voidOrCreditInvoice')
  async voidOrCredit(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(z.object({ reason: reasonField, posting_date: isoDate.optional() }), body);
    return this.ar.voidOrCreditInvoice(tenantPrincipal(request), parse(uuid, id), {
      reason: input.reason,
      postingDate: input.posting_date,
    });
  }

  // -------------------------------------------------------------------------
  // Credit notes
  // -------------------------------------------------------------------------

  @Get('credit-notes')
  @Operation('listCreditNotes')
  async listCreditNotes(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({
        legal_entity_id: uuid.optional(),
        customer_id: uuid.optional(),
        status: z.string().trim().max(40).optional(),
      }),
      query,
    );
    return this.sales.listCreditNotes(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
      customerId: parsed.customer_id,
      status: parsed.status,
    });
  }

  @Post('credit-notes')
  @Operation('createCreditNote')
  async createCreditNote(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(
      z.object({
        accounting_book_id: uuid,
        customer_id: uuid,
        invoice_id: uuid.optional(),
        branch_id: uuid.optional(),
        document_date: isoDate,
        posting_date: isoDate,
        currency: currencyCode.optional(),
        exchange_rate: decimalString.optional(),
        reason: z.string().trim().max(1000).optional(),
        lines: z.array(InvoiceLine).min(1).max(1000),
      }),
      body,
    );
    return this.sales.createCreditNote(tenantPrincipal(request), {
      accountingBookId: input.accounting_book_id,
      customerId: input.customer_id,
      invoiceId: input.invoice_id,
      branchId: input.branch_id,
      documentDate: input.document_date,
      postingDate: input.posting_date,
      currency: input.currency,
      exchangeRate: input.exchange_rate,
      reason: input.reason,
      lines: input.lines.map(invoiceLine),
    });
  }

  @Post('credit-notes/:id/post')
  @Operation('postCreditNote')
  async postCreditNote(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.sales.postCreditNote(tenantPrincipal(request), parse(uuid, id));
  }

  @Post('credit-notes/:id/apply')
  @Operation('applyCreditNote')
  async applyCreditNote(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    // A credit note applies to invoices and to nothing else, so the body names
    // invoices rather than reusing the generic allocation vocabulary — a
    // `target_type: 'CREDIT_NOTE'` here would be a credit note applied to itself.
    const input = parse(
      z.object({
        applications: z
          .array(z.object({ invoice_id: uuid, amount: decimalString }))
          .min(1)
          .max(200),
      }),
      body,
    );
    return this.sales.applyCreditNote(
      tenantPrincipal(request),
      parse(uuid, id),
      input.applications.map((a) => ({ invoiceId: a.invoice_id, amount: a.amount })),
    );
  }

  // -------------------------------------------------------------------------
  // Receipts, refunds and write-offs
  // -------------------------------------------------------------------------

  @Get('customer-receipts')
  @Operation('listCustomerReceipts')
  async listReceipts(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({
        legal_entity_id: uuid.optional(),
        customer_id: uuid.optional(),
        status: z.string().trim().max(40).optional(),
      }),
      query,
    );
    return this.ar.listReceipts(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
      customerId: parsed.customer_id,
      status: parsed.status,
    });
  }

  @Post('customer-receipts')
  @Operation('createCustomerReceipt')
  async createReceipt(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(
      z.object({
        accounting_book_id: uuid,
        customer_id: uuid,
        document_date: isoDate,
        posting_date: isoDate,
        currency: currencyCode.optional(),
        amount: decimalString,
        exchange_rate: decimalString.optional(),
        bank_account_id: uuid.optional(),
        deposit_account_id: uuid.optional(),
        payment_method: z.string().trim().max(40).optional(),
        source: z.string().trim().max(40).optional(),
        external_reference: z.string().trim().max(120).optional(),
        allocations: Allocations.shape.allocations.optional(),
      }),
      body,
    );
    return this.ar.createReceipt(tenantPrincipal(request), {
      accountingBookId: input.accounting_book_id,
      customerId: input.customer_id,
      documentDate: input.document_date,
      postingDate: input.posting_date,
      currency: input.currency,
      amount: input.amount,
      exchangeRate: input.exchange_rate,
      bankAccountId: input.bank_account_id,
      depositAccountId: input.deposit_account_id,
      paymentMethod: input.payment_method,
      source: input.source,
      externalReference: input.external_reference,
      allocations: input.allocations ? allocationsOf(input.allocations) : undefined,
    });
  }

  @Post('customer-receipts/:id/allocate')
  @Operation('allocateCustomerReceipt')
  async allocateReceipt(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(Allocations, body);
    return this.ar.allocateReceipt(
      tenantPrincipal(request),
      parse(uuid, id),
      allocationsOf(input.allocations),
    );
  }

  @Post('customer-refunds')
  @Operation('createCustomerRefund')
  async createRefund(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(
      z.object({
        accounting_book_id: uuid,
        customer_id: uuid,
        customer_receipt_id: uuid.optional(),
        credit_note_id: uuid.optional(),
        posting_date: isoDate,
        amount: decimalString,
        bank_account_id: uuid.optional(),
        deposit_account_id: uuid.optional(),
      }),
      body,
    );
    // Currency is not accepted: a refund is denominated by the credit note or
    // receipt it returns, and letting the caller name a different one would be a
    // conversion nobody asked for.
    return this.sales.createCustomerRefund(tenantPrincipal(request), {
      accountingBookId: input.accounting_book_id,
      customerId: input.customer_id,
      customerReceiptId: input.customer_receipt_id,
      creditNoteId: input.credit_note_id,
      postingDate: input.posting_date,
      amount: input.amount,
      bankAccountId: input.bank_account_id,
      depositAccountId: input.deposit_account_id,
    });
  }

  @Post('ar/write-offs')
  @Operation('createArWriteOff')
  async createWriteOff(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(
      z.object({
        invoice_id: uuid,
        posting_date: isoDate,
        // Absent means the whole open balance, which is the common case and the
        // one a caller is most likely to get wrong by doing the arithmetic itself.
        amount: decimalString.optional(),
        // doc 04 makes a write-off an approval, not a correction: the reason code
        // is the whole record of why a receivable stopped being collectable.
        reason_code: codeField,
      }),
      body,
    );
    return this.sales.createArWriteOff(tenantPrincipal(request), {
      invoiceId: input.invoice_id,
      postingDate: input.posting_date,
      amount: input.amount,
      reasonCode: input.reason_code,
    });
  }

  // -------------------------------------------------------------------------
  // Recurring, dunning and e-invoicing
  // -------------------------------------------------------------------------

  @Get('recurring-invoices')
  @Operation('listRecurringInvoices')
  async listRecurring(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({ legal_entity_id: uuid.optional(), customer_id: uuid.optional() }),
      query,
    );
    return this.sales.listRecurringInvoices(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
      customerId: parsed.customer_id,
    });
  }

  @Post('recurring-invoices')
  @Operation('createRecurringInvoice')
  async createRecurring(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(
      z.object({
        accounting_book_id: uuid,
        customer_id: uuid,
        name: nameField,
        frequency: z.enum(['WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL']),
        start_date: isoDate,
        end_date: isoDate.optional(),
        due_date_rule: z.string().trim().max(40).optional(),
        auto_send: z.boolean().optional(),
        auto_post: z.boolean().optional(),
        lines: z.array(InvoiceLine).min(1).max(1000),
      }),
      body,
    );
    return this.sales.createRecurringInvoice(tenantPrincipal(request), {
      accountingBookId: input.accounting_book_id,
      customerId: input.customer_id,
      name: input.name,
      frequency: input.frequency,
      startDate: input.start_date,
      endDate: input.end_date,
      dueDateRule: input.due_date_rule,
      autoSend: input.auto_send,
      autoPost: input.auto_post,
      lines: input.lines.map(invoiceLine),
    });
  }

  @Get('dunning-cases')
  @Operation('listDunningCases')
  async listDunning(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({
        legal_entity_id: uuid.optional(),
        contact_id: uuid.optional(),
        status: z.string().trim().max(40).optional(),
      }),
      query,
    );
    return this.sales.listDunningCases(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
      contactId: parsed.contact_id,
      status: parsed.status,
    });
  }

  @Post('einvoice/:id/submit')
  @Operation('submitEInvoice')
  async submitEInvoice(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    // `{id}` is the invoice, not a submission: the submission row does not exist
    // until the first submit, and a retry returns the row it already produced
    // rather than transmitting a second time.
    return this.sales.submitEInvoice(tenantPrincipal(request), parse(uuid, id));
  }
}

function invoiceLine(l: z.infer<typeof InvoiceLine>) {
  return {
    lineNo: l.line_no,
    description: l.description,
    quantity: l.quantity,
    unitPrice: l.unit_price,
    discountAmount: l.discount_amount,
    revenueAccountId: l.revenue_account_id,
    taxCodeId: l.tax_code_id,
    inclusive: l.inclusive,
    salesOrderLineId: l.sales_order_line_id,
    dimensions: l.dimensions,
  };
}

function offerLine(l: z.infer<typeof OfferLine>) {
  return {
    lineNo: l.line_no,
    description: l.description,
    quantity: l.quantity,
    unitPrice: l.unit_price,
    discountAmount: l.discount_amount,
    taxCodeId: l.tax_code_id,
    inclusive: l.inclusive,
  };
}
