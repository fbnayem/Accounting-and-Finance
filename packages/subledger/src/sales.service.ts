import { Pool, PoolClient } from 'pg';
import {
  AppError,
  Money,
  D,
  notFound,
  uuidv7,
  assertEntityPermission,
  toBase,
  type TenantPrincipal,
  type RequestContext,
} from '@acct/domain';
import { publish, recordAudit, readInTenant, writeInTenant } from '@acct/database';
import { PostingService } from '@acct/ledger';
import { DocumentPostingService } from './document-posting.service';
import {
  lockTargets,
  validateAllocations,
  applyToTarget,
  type AllocationTarget,
  type CreditApplicationInput,
} from './allocation';
import { ArService, type CalculableLineInput, type InvoiceLineInput } from './ar.service';

/**
 * Sales documents around the invoice — doc 04.
 *
 * Quotes and sales orders are non-posting; credit notes, write-offs and refunds
 * all move AR. The rule this file lives by is that it never grows a second
 * posting or application path: everything that reaches the ledger goes through
 * the same ArService internals the invoice lifecycle uses
 * (`postCreditNoteFromCalculated`, `applyCreditNoteInTransaction`,
 * `createInvoiceInTransaction`), so the manual path and the automatic path
 * cannot drift apart.
 */

// ---------------------------------------------------------------------------
// E-invoice provider
// ---------------------------------------------------------------------------

export interface EInvoiceProviderResult {
  /**
   * False when nothing left the building. The submission row then stays
   * PENDING and records why — a government portal that was never called must
   * not acquire an answer.
   */
  readonly transmitted: boolean;
  readonly status?: 'SUBMITTED' | 'ACCEPTED' | 'REJECTED' | undefined;
  readonly governmentId?: string | undefined;
  readonly qrPayload?: string | undefined;
  readonly rejectionReason?: string | undefined;
  readonly response?: Record<string, unknown> | undefined;
}

/**
 * Injected the way FilesService injects StorageSigner: apps supply a real
 * gateway when one exists; tests supply a deterministic one.
 */
export interface EInvoiceProvider {
  readonly name: string;
  submit(request: {
    legalEntityId: string;
    sourceType: string;
    sourceId: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  }): Promise<EInvoiceProviderResult>;
}

/**
 * The Phase 3 default: no government gateway is connected. It transmits
 * nothing and says so, which keeps the submission row honest — PENDING with a
 * reason, never a fabricated ACCEPTED.
 */
export class NoEInvoiceProviderConnected implements EInvoiceProvider {
  readonly name = 'NONE';
  async submit(): Promise<EInvoiceProviderResult> {
    return {
      transmitted: false,
      response: {
        note:
          'No e-invoice provider is connected for this deployment. The submission is recorded ' +
          'and will be transmitted when a provider is configured.',
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Pure pieces, exported for the unit suite
// ---------------------------------------------------------------------------

/** The stored line columns quotes and sales orders share, as conversion reads them. */
export interface ConvertibleLineRow {
  readonly line_no: number;
  readonly description: string;
  readonly quantity: string;
  readonly unit_price: string;
  readonly discount_amount?: string | null | undefined;
  readonly tax_code_id: string | null;
}

/**
 * F-701/F-706: conversion copies the lines AND their tax treatment. A copy
 * that drops tax_code_id retaxes the document at whatever the default is,
 * which is exactly the loss doc 04's "preserving source link" forbids.
 */
export function conversionLineInputs(rows: readonly ConvertibleLineRow[]): CalculableLineInput[] {
  return rows.map((row) => ({
    lineNo: row.line_no,
    description: row.description,
    quantity: row.quantity,
    unitPrice: row.unit_price,
    ...(row.discount_amount ? { discountAmount: row.discount_amount } : {}),
    ...(row.tax_code_id ? { taxCodeId: row.tax_code_id } : {}),
  }));
}

const FREQUENCY_MONTHS: Record<string, number> = { MONTHLY: 1, QUARTERLY: 3, ANNUAL: 12 };

/**
 * The next occurrence after `date`. Month arithmetic clamps to the month end
 * rather than spilling: a template anchored on the 31st runs on Feb 28, not
 * Mar 3 — spilling would put two occurrences in March and invoice the
 * customer twice in one month.
 */
export function nextOccurrenceDate(date: string, frequency: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (frequency === 'WEEKLY') {
    parsed.setUTCDate(parsed.getUTCDate() + 7);
    return parsed.toISOString().slice(0, 10);
  }
  const months = FREQUENCY_MONTHS[frequency];
  if (!months) {
    throw new AppError('VALIDATION_FAILED', `Unknown recurrence frequency ${frequency}.`, {
      details: { frequency },
    });
  }
  const day = parsed.getUTCDate();
  parsed.setUTCDate(1);
  parsed.setUTCMonth(parsed.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 0),
  ).getUTCDate();
  parsed.setUTCDate(Math.min(day, lastDay));
  return parsed.toISOString().slice(0, 10);
}

/**
 * Every occurrence date due at `asOf`, starting from the stored cursor.
 *
 * Deterministic on purpose: the generator's idempotency is this function plus
 * the UNIQUE (template_id, occurrence_date) constraint — the same cursor
 * always names the same dates, and a date that was already generated inserts
 * nothing on the second attempt.
 */
export function dueOccurrenceDates(
  nextRunDate: string,
  frequency: string,
  asOf: string,
  endDate?: string | null,
): string[] {
  const dates: string[] = [];
  let cursor = nextRunDate;
  while (cursor <= asOf && (!endDate || cursor <= endDate)) {
    dates.push(cursor);
    cursor = nextOccurrenceDate(cursor, frequency);
  }
  return dates;
}

/**
 * doc 04: a refund "requires available customer credit". Refusing here is what
 * keeps a refund from quietly un-settling an invoice — money already applied
 * is not the customer's to take back until it is unapplied.
 */
export function assertRefundWithinAvailable(
  amount: string,
  available: string,
  currency: string,
  sourceLabel: string,
): void {
  const requested = Money.of(D(amount), currency);
  if (!requested.isPositive()) {
    throw new AppError('VALIDATION_FAILED', `A refund of ${amount} is not positive.`, {
      details: { amount },
    });
  }
  const unapplied = Money.of(D(available), currency);
  if (requested.gt(unapplied)) {
    throw new AppError(
      'OVER_ALLOCATION',
      `Refunding ${requested.toString()} ${currency} from ${sourceLabel}, which has only ` +
        `${unapplied.toString()} ${currency} unapplied.`,
      { details: { requested: requested.toString(), available: unapplied.toString() } },
    );
  }
}

const DRAFT_STATES = new Set(['DRAFT', 'PENDING_APPROVAL', 'APPROVED']);

export interface CreditNoteLineInput extends CalculableLineInput {
  revenueAccountId: string;
  invoiceLineId?: string | undefined;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class SalesService {
  constructor(
    private readonly pool: Pool,
    private readonly posting: PostingService,
    private readonly documents: DocumentPostingService,
    private readonly ar: ArService,
    private readonly einvoice: EInvoiceProvider = new NoEInvoiceProviderConnected(),
  ) {}

  // =========================================================================
  // Quotes — non-posting (doc 04), so no book, no rate, no journal.
  // =========================================================================

  async createQuote(
    principal: TenantPrincipal,
    input: {
      legalEntityId: string;
      customerId: string;
      branchId?: string | undefined;
      documentDate: string;
      validUntil?: string | undefined;
      currency?: string | undefined;
      lines: readonly CalculableLineInput[];
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      assertEntityPermission(principal, 'quote.create', input.legalEntityId);
      const customer = await this.ar.loadCustomer(client, input.customerId);

      // A quote has no accounting book to fall back on, so the currency must
      // come from the request or the customer — inventing one would price the
      // whole document in a currency nobody chose.
      const currency = input.currency ?? (customer.default_currency as string | null);
      if (!currency) {
        throw new AppError(
          'VALIDATION_FAILED',
          `No currency was given and ${customer.legal_name} has no default currency. Supply one ` +
            'on the quote or set default_currency on the customer.',
        );
      }

      const { calculated } = await this.ar.calculate(
        client,
        input.legalEntityId,
        currency,
        input.documentDate,
        input.lines,
      );

      const quoteId = uuidv7();
      const quoteNumber = await this.ar.allocateDocumentNumber(
        client,
        principal,
        input.legalEntityId,
        'QUOTE',
      );
      const { rows } = await client.query<Record<string, unknown>>(
        `INSERT INTO quotes (id, tenant_id, legal_entity_id, branch_id, customer_id, quote_number,
                             document_date, valid_until, currency, subtotal, tax_total, total)
         VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9,$10::numeric,$11::numeric,$12::numeric)
         RETURNING id, legal_entity_id, customer_id, quote_number, version,
                   document_date::text AS document_date, valid_until::text AS valid_until,
                   currency, status::text AS status, subtotal::text AS subtotal,
                   tax_total::text AS tax_total, total::text AS total`,
        [
          quoteId,
          principal.tenantId,
          input.legalEntityId,
          input.branchId ?? null,
          input.customerId,
          quoteNumber,
          input.documentDate,
          input.validUntil ?? null,
          currency,
          calculated.subtotal,
          calculated.taxTotal,
          calculated.total,
        ],
      );

      const byLineNo = new Map(
        input.lines.map((line, index) => [line.lineNo ?? index + 1, line] as const),
      );
      for (const line of calculated.lines) {
        const source = byLineNo.get(line.lineNo);
        if (!source) continue;
        await client.query(
          `INSERT INTO quote_lines (id, tenant_id, quote_id, legal_entity_id, line_no, description,
                                    quantity, unit_price, discount_amount, tax_code_id, net_amount,
                                    tax_amount, gross_amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,$8::numeric,$9::numeric,$10,$11::numeric,
                   $12::numeric,$13::numeric)`,
          [
            uuidv7(),
            principal.tenantId,
            quoteId,
            input.legalEntityId,
            line.lineNo,
            source.description,
            line.quantity,
            line.unitPrice,
            line.discountAmount,
            line.taxCodeId,
            line.netAmount,
            line.taxAmount,
            line.grossAmount,
          ],
        );
      }

      await publish(client, context, {
        eventType: 'quote.created',
        aggregateType: 'quote',
        aggregateId: quoteId,
        tenantId: principal.tenantId,
        legalEntityId: input.legalEntityId,
        payload: {
          quote_number: quoteNumber,
          customer_id: input.customerId,
          total: calculated.total,
        },
      });
      await recordAudit(client, context, {
        action: 'quote.created',
        resourceType: 'quote',
        resourceId: quoteId,
        tenantId: principal.tenantId,
        legalEntityId: input.legalEntityId,
        after: rows[0] as Record<string, unknown>,
      });

      return { ...rows[0], lines: calculated.lines };
    });
  }

  async listQuotes(
    principal: TenantPrincipal,
    filter: {
      legalEntityId?: string | undefined;
      customerId?: string | undefined;
      status?: string | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT q.id, q.legal_entity_id, q.customer_id, c.legal_name AS customer_name,
                q.quote_number, q.version, q.document_date::text AS document_date,
                q.valid_until::text AS valid_until, q.currency, q.status::text AS status,
                q.subtotal::text AS subtotal, q.tax_total::text AS tax_total,
                q.total::text AS total, q.converted_to_type, q.converted_to_id
           FROM quotes q
           JOIN contacts c ON c.id = q.customer_id
          WHERE ($1::uuid IS NULL OR q.legal_entity_id = $1)
            AND ($2::uuid IS NULL OR q.customer_id = $2)
            AND ($3::text IS NULL OR q.status::text = $3)
          ORDER BY q.document_date DESC, q.quote_number DESC
          LIMIT 200`,
        [filter.legalEntityId ?? null, filter.customerId ?? null, filter.status ?? null],
      );
      return { data: rows };
    });
  }

  async acceptQuote(principal: TenantPrincipal, id: string) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const quote = await this.loadQuote(client, id, { forUpdate: true });
      assertEntityPermission(principal, 'quote.edit', quote.legal_entity_id as string);

      if (quote.status === 'ACCEPTED') return quote;
      if (quote.status !== 'DRAFT' && quote.status !== 'SENT') {
        throw new AppError(
          'VALIDATION_FAILED',
          `This quote is ${quote.status} and cannot be accepted.`,
          { details: { status: quote.status } },
        );
      }
      // An expired offer is not one the customer can still take up; marking it
      // rather than silently accepting keeps "we honoured a lapsed price" a
      // decision someone makes by reissuing, not a default.
      const validUntil = quote.valid_until as string | null;
      if (validUntil && validUntil < todayIso()) {
        await client.query(`UPDATE quotes SET status = 'EXPIRED' WHERE id = $1`, [id]);
        throw new AppError(
          'VALIDATION_FAILED',
          `This quote expired on ${validUntil}. Issue a new quote at current prices.`,
          { details: { valid_until: validUntil } },
        );
      }

      const { rows } = await client.query<Record<string, unknown>>(
        `UPDATE quotes SET status = 'ACCEPTED' WHERE id = $1
         RETURNING id, quote_number, status::text AS status`,
        [id],
      );
      await publish(client, context, {
        eventType: 'quote.accepted',
        aggregateType: 'quote',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: quote.legal_entity_id as string,
        payload: { quote_number: quote.quote_number, customer_id: quote.customer_id },
      });
      await recordAudit(client, context, {
        action: 'quote.accepted',
        resourceType: 'quote',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: quote.legal_entity_id as string,
        after: rows[0] as Record<string, unknown>,
      });
      return { ...quote, ...rows[0] };
    });
  }

  /**
   * doc 04: "Convert to sales order or invoice while preserving source link."
   *
   * One transaction for the new document, the copied lines and the quote's
   * converted-to pointer — two transactions would allow a quote that says it
   * became a document that does not exist (which is why
   * `createInvoiceInTransaction` is callable inside one).
   */
  async convertQuote(
    principal: TenantPrincipal,
    id: string,
    input: {
      to: 'SALES_ORDER' | 'INVOICE';
      accountingBookId?: string | undefined;
      documentDate?: string | undefined;
      postingDate?: string | undefined;
      dueDate?: string | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const quote = await this.loadQuote(client, id, { forUpdate: true });
      assertEntityPermission(principal, 'quote.edit', quote.legal_entity_id as string);

      if (quote.status === 'CONVERTED') {
        throw new AppError(
          'VALIDATION_FAILED',
          `This quote already became ${String(quote.converted_to_type).toLowerCase()} ` +
            `${quote.converted_to_id}. Converting it again would duplicate the customer's order.`,
          {
            details: {
              converted_to_type: quote.converted_to_type,
              converted_to_id: quote.converted_to_id,
            },
          },
        );
      }
      if (quote.status !== 'ACCEPTED') {
        throw new AppError(
          'VALIDATION_FAILED',
          `This quote is ${quote.status}; only an accepted quote converts. Acceptance is the ` +
            'customer saying yes, and the document the quote becomes is the record of that yes.',
          { details: { status: quote.status } },
        );
      }

      const { rows: quoteLines } = await client.query<
        ConvertibleLineRow & {
          item_id: string | null;
          net_amount: string;
          tax_amount: string;
          gross_amount: string;
        }
      >(
        `SELECT line_no, item_id, description, quantity::text AS quantity,
                unit_price::text AS unit_price, discount_amount::text AS discount_amount,
                tax_code_id, net_amount::text AS net_amount, tax_amount::text AS tax_amount,
                gross_amount::text AS gross_amount
           FROM quote_lines WHERE quote_id = $1 ORDER BY line_no`,
        [id],
      );
      if (quoteLines.length === 0) {
        throw new AppError('VALIDATION_FAILED', 'This quote has no lines to convert.');
      }

      if (input.to === 'SALES_ORDER') {
        const orderId = uuidv7();
        const orderNumber = await this.ar.allocateDocumentNumber(
          client,
          principal,
          quote.legal_entity_id as string,
          'SALES_ORDER',
        );
        // The order copies the quote's own figures rather than repricing: the
        // quote is the agreement, and the invoice will be recalculated at its
        // own date through the one shared calculator anyway.
        const { rows: order } = await client.query<Record<string, unknown>>(
          `INSERT INTO sales_orders (id, tenant_id, legal_entity_id, branch_id, customer_id,
                                     order_number, quote_id, document_date, currency, subtotal,
                                     tax_total, total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10::numeric,$11::numeric,$12::numeric)
           RETURNING id, legal_entity_id, customer_id, order_number, quote_id,
                     document_date::text AS document_date, currency, status::text AS status,
                     subtotal::text AS subtotal, tax_total::text AS tax_total, total::text AS total`,
          [
            orderId,
            principal.tenantId,
            quote.legal_entity_id,
            quote.branch_id ?? null,
            quote.customer_id,
            orderNumber,
            id,
            input.documentDate ?? todayIso(),
            quote.currency,
            quote.subtotal,
            quote.tax_total,
            quote.total,
          ],
        );
        for (const line of quoteLines) {
          // F-706: tax_code_id survives the copy, so the treatment the quote
          // previewed is the treatment the eventual invoice applies.
          await client.query(
            `INSERT INTO sales_order_lines (id, tenant_id, sales_order_id, legal_entity_id,
                                            line_no, item_id, description, quantity, unit_price,
                                            tax_code_id, net_amount, tax_amount, gross_amount)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9::numeric,$10,$11::numeric,$12::numeric,
                     $13::numeric)`,
            [
              uuidv7(),
              principal.tenantId,
              orderId,
              quote.legal_entity_id,
              line.line_no,
              line.item_id,
              line.description,
              line.quantity,
              line.unit_price,
              line.tax_code_id,
              line.net_amount,
              line.tax_amount,
              line.gross_amount,
            ],
          );
        }
        await this.markQuoteConverted(client, context, principal, quote, 'SALES_ORDER', orderId);
        return { outcome: 'SALES_ORDER', sales_order: order[0], quote_id: id };
      }

      // INVOICE.
      if (!input.accountingBookId) {
        throw new AppError(
          'VALIDATION_FAILED',
          'Converting a quote to an invoice needs accounting_book_id — a quote is non-posting ' +
            'and carries no book, and an invoice cannot exist without one.',
        );
      }
      const customer = await this.ar.loadCustomer(client, quote.customer_id as string);
      const revenueAccountId = customer.revenue_account_id as string | null;
      if (!revenueAccountId) {
        throw new AppError(
          'VALIDATION_FAILED',
          `${customer.legal_name} has no default revenue account, and quote lines carry none. ` +
            'Set revenue_account_id on the customer, or create the invoice directly with ' +
            'explicit revenue accounts per line.',
          { details: { customer_id: quote.customer_id } },
        );
      }

      const documentDate = input.documentDate ?? todayIso();
      const invoice = (await this.ar.createInvoiceInTransaction(client, context, principal, {
        accountingBookId: input.accountingBookId,
        customerId: quote.customer_id as string,
        branchId: (quote.branch_id as string) ?? undefined,
        documentDate,
        postingDate: input.postingDate ?? documentDate,
        dueDate: input.dueDate,
        currency: quote.currency as string,
        lines: conversionLineInputs(quoteLines).map((line) => ({ ...line, revenueAccountId })),
      })) as Record<string, unknown>;
      await this.markQuoteConverted(
        client,
        context,
        principal,
        quote,
        'INVOICE',
        invoice.id as string,
      );
      return { outcome: 'INVOICE', invoice, quote_id: id };
    });
  }

  private async markQuoteConverted(
    client: PoolClient,
    context: RequestContext,
    principal: TenantPrincipal,
    quote: Record<string, unknown>,
    toType: 'SALES_ORDER' | 'INVOICE',
    toId: string,
  ): Promise<void> {
    await client.query(
      `UPDATE quotes SET status = 'CONVERTED', converted_to_type = $2, converted_to_id = $3
        WHERE id = $1`,
      [quote.id, toType, toId],
    );
    await recordAudit(client, context, {
      action: 'quote.converted',
      resourceType: 'quote',
      resourceId: quote.id as string,
      tenantId: principal.tenantId,
      legalEntityId: quote.legal_entity_id as string,
      before: quote,
      after: { converted_to_type: toType, converted_to_id: toId },
    });
  }

  private async loadQuote(
    client: PoolClient,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT id, legal_entity_id, branch_id, customer_id, quote_number, version,
              document_date::text AS document_date, valid_until::text AS valid_until, currency,
              status::text AS status, subtotal::text AS subtotal, tax_total::text AS tax_total,
              total::text AS total, converted_to_type, converted_to_id
         FROM quotes WHERE id = $1 ${options.forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    );
    if (!rows[0]) throw notFound('quote', id);
    return rows[0];
  }

  // =========================================================================
  // Sales orders — non-posting; confirmation is what makes one invoiceable.
  // =========================================================================

  async createSalesOrder(
    principal: TenantPrincipal,
    input: {
      legalEntityId: string;
      customerId: string;
      branchId?: string | undefined;
      quoteId?: string | undefined;
      documentDate: string;
      requestedDate?: string | undefined;
      customerPoRef?: string | undefined;
      currency?: string | undefined;
      lines: readonly CalculableLineInput[];
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      assertEntityPermission(principal, 'sales_order.create', input.legalEntityId);
      const customer = await this.ar.loadCustomer(client, input.customerId);
      const currency = input.currency ?? (customer.default_currency as string | null);
      if (!currency) {
        throw new AppError(
          'VALIDATION_FAILED',
          `No currency was given and ${customer.legal_name} has no default currency. Supply one ` +
            'on the order or set default_currency on the customer.',
        );
      }

      const { calculated } = await this.ar.calculate(
        client,
        input.legalEntityId,
        currency,
        input.documentDate,
        input.lines,
      );

      const orderId = uuidv7();
      const orderNumber = await this.ar.allocateDocumentNumber(
        client,
        principal,
        input.legalEntityId,
        'SALES_ORDER',
      );
      const { rows } = await client.query<Record<string, unknown>>(
        `INSERT INTO sales_orders (id, tenant_id, legal_entity_id, branch_id, customer_id,
                                   order_number, quote_id, document_date, requested_date,
                                   customer_po_ref, currency, subtotal, tax_total, total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9::date,$10,$11,$12::numeric,$13::numeric,
                 $14::numeric)
         RETURNING id, legal_entity_id, customer_id, order_number, quote_id,
                   document_date::text AS document_date, requested_date::text AS requested_date,
                   customer_po_ref, currency, status::text AS status, subtotal::text AS subtotal,
                   tax_total::text AS tax_total, total::text AS total`,
        [
          orderId,
          principal.tenantId,
          input.legalEntityId,
          input.branchId ?? null,
          input.customerId,
          orderNumber,
          input.quoteId ?? null,
          input.documentDate,
          input.requestedDate ?? null,
          input.customerPoRef ?? null,
          currency,
          calculated.subtotal,
          calculated.taxTotal,
          calculated.total,
        ],
      );

      const byLineNo = new Map(
        input.lines.map((line, index) => [line.lineNo ?? index + 1, line] as const),
      );
      for (const line of calculated.lines) {
        const source = byLineNo.get(line.lineNo);
        if (!source) continue;
        await client.query(
          `INSERT INTO sales_order_lines (id, tenant_id, sales_order_id, legal_entity_id, line_no,
                                          description, quantity, unit_price, tax_code_id,
                                          net_amount, tax_amount, gross_amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,$8::numeric,$9,$10::numeric,$11::numeric,
                   $12::numeric)`,
          [
            uuidv7(),
            principal.tenantId,
            orderId,
            input.legalEntityId,
            line.lineNo,
            source.description,
            line.quantity,
            line.unitPrice,
            line.taxCodeId,
            line.netAmount,
            line.taxAmount,
            line.grossAmount,
          ],
        );
      }

      await recordAudit(client, context, {
        action: 'sales_order.created',
        resourceType: 'sales_order',
        resourceId: orderId,
        tenantId: principal.tenantId,
        legalEntityId: input.legalEntityId,
        after: rows[0] as Record<string, unknown>,
      });
      return { ...rows[0], lines: calculated.lines };
    });
  }

  async listSalesOrders(
    principal: TenantPrincipal,
    filter: {
      legalEntityId?: string | undefined;
      customerId?: string | undefined;
      status?: string | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT o.id, o.legal_entity_id, o.customer_id, c.legal_name AS customer_name,
                o.order_number, o.quote_id, o.document_date::text AS document_date,
                o.requested_date::text AS requested_date, o.customer_po_ref, o.currency,
                o.status::text AS status, o.subtotal::text AS subtotal,
                o.tax_total::text AS tax_total, o.total::text AS total
           FROM sales_orders o
           JOIN contacts c ON c.id = o.customer_id
          WHERE ($1::uuid IS NULL OR o.legal_entity_id = $1)
            AND ($2::uuid IS NULL OR o.customer_id = $2)
            AND ($3::text IS NULL OR o.status::text = $3)
          ORDER BY o.document_date DESC, o.order_number DESC
          LIMIT 200`,
        [filter.legalEntityId ?? null, filter.customerId ?? null, filter.status ?? null],
      );
      return { data: rows };
    });
  }

  /**
   * F-710: confirmation is separate from approval — approval gates spending
   * authority, confirmation is the customer commitment that makes the order
   * invoiceable.
   */
  async confirmSalesOrder(principal: TenantPrincipal, id: string) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows: current } = await client.query<Record<string, unknown>>(
        `SELECT id, legal_entity_id, customer_id, order_number, total::text AS total,
                status::text AS status
           FROM sales_orders WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const order = current[0];
      if (!order) throw notFound('sales order', id);
      assertEntityPermission(principal, 'sales_order.confirm', order.legal_entity_id as string);

      if (order.status === 'CONFIRMED') return order;
      if (order.status === 'APPROVAL_PENDING') {
        throw new AppError(
          'VALIDATION_FAILED',
          'This order is awaiting approval. Confirming past a pending approval would commit to ' +
            'the customer what nobody has authorised.',
          { details: { status: order.status } },
        );
      }
      if (order.status !== 'DRAFT' && order.status !== 'APPROVED') {
        throw new AppError(
          'VALIDATION_FAILED',
          `This order is ${order.status} and cannot be confirmed.`,
          { details: { status: order.status } },
        );
      }

      const { rows } = await client.query<Record<string, unknown>>(
        `UPDATE sales_orders SET status = 'CONFIRMED' WHERE id = $1
         RETURNING id, order_number, status::text AS status`,
        [id],
      );
      await publish(client, context, {
        eventType: 'sales_order.confirmed',
        aggregateType: 'sales_order',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: order.legal_entity_id as string,
        payload: {
          order_number: order.order_number,
          customer_id: order.customer_id,
          total: order.total,
        },
      });
      await recordAudit(client, context, {
        action: 'sales_order.confirmed',
        resourceType: 'sales_order',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: order.legal_entity_id as string,
        after: rows[0] as Record<string, unknown>,
      });
      return { ...order, ...rows[0] };
    });
  }

  // =========================================================================
  // Credit notes — thin wrappers over the ArService internals, so the manual
  // path and void-by-credit cannot drift apart (doc 04).
  // =========================================================================

  async createCreditNote(
    principal: TenantPrincipal,
    input: {
      accountingBookId: string;
      customerId: string;
      invoiceId?: string | undefined;
      branchId?: string | undefined;
      documentDate: string;
      postingDate: string;
      currency?: string | undefined;
      exchangeRate?: string | undefined;
      reason?: string | undefined;
      lines: readonly CreditNoteLineInput[];
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const book = await this.posting.loadBookContext(
        client,
        principal,
        input.accountingBookId,
        input.postingDate,
      );
      assertEntityPermission(principal, 'credit_note.create', book.legalEntityId);

      const customer = await this.ar.loadCustomer(client, input.customerId);
      const currency =
        input.currency ?? (customer.default_currency as string | null) ?? book.baseCurrency;
      const exchangeRate = await this.ar.resolveRate(
        client,
        currency,
        book.baseCurrency,
        input.exchangeRate,
        input.postingDate,
      );

      // Against an invoice or against the account (doc 04) — but never against
      // someone else's invoice or a currency the credit cannot settle in.
      if (input.invoiceId) {
        const { rows: invoice } = await client.query<{ customer_id: string; currency: string }>(
          `SELECT customer_id, currency FROM invoices WHERE id = $1`,
          [input.invoiceId],
        );
        if (!invoice[0]) throw notFound('invoice', input.invoiceId);
        if (invoice[0].customer_id !== input.customerId) {
          throw new AppError(
            'VALIDATION_FAILED',
            `Invoice ${input.invoiceId} belongs to a different customer than this credit note.`,
            { details: { invoice_id: input.invoiceId } },
          );
        }
        if (invoice[0].currency !== currency) {
          throw new AppError(
            'VALIDATION_FAILED',
            `Invoice ${input.invoiceId} is in ${invoice[0].currency} and this credit note is in ` +
              `${currency}; a credit in one currency cannot settle an invoice in another.`,
            { details: { invoice_currency: invoice[0].currency, credit_currency: currency } },
          );
        }
      }

      const { calculated } = await this.ar.calculate(
        client,
        book.legalEntityId,
        currency,
        input.documentDate,
        input.lines,
      );

      const creditNoteId = uuidv7();
      const { rows } = await client.query<Record<string, unknown>>(
        `INSERT INTO credit_notes (id, tenant_id, legal_entity_id, accounting_book_id, branch_id,
                                   customer_id, invoice_id, document_date, posting_date, currency,
                                   exchange_rate, subtotal, tax_total, total, amount_applied,
                                   amount_available, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9::date,$10,$11::numeric,$12::numeric,
                 $13::numeric,$14::numeric,0,$14::numeric,$15)
         RETURNING id, legal_entity_id, accounting_book_id, customer_id, invoice_id,
                   credit_note_number, document_date::text AS document_date,
                   posting_date::text AS posting_date, currency,
                   exchange_rate::text AS exchange_rate, status::text AS status,
                   subtotal::text AS subtotal, tax_total::text AS tax_total, total::text AS total,
                   amount_applied::text AS amount_applied,
                   amount_available::text AS amount_available, reason`,
        [
          creditNoteId,
          principal.tenantId,
          book.legalEntityId,
          input.accountingBookId,
          input.branchId ?? null,
          input.customerId,
          input.invoiceId ?? null,
          input.documentDate,
          input.postingDate,
          currency,
          exchangeRate,
          calculated.subtotal,
          calculated.taxTotal,
          calculated.total,
          input.reason ?? null,
        ],
      );

      const byLineNo = new Map(
        input.lines.map((line, index) => [line.lineNo ?? index + 1, line] as const),
      );
      for (const line of calculated.lines) {
        const source = byLineNo.get(line.lineNo);
        if (!source) continue;
        await client.query(
          `INSERT INTO credit_note_lines (id, tenant_id, credit_note_id, legal_entity_id, line_no,
                                          invoice_line_id, description, quantity, unit_price,
                                          revenue_account_id, tax_code_id, net_amount, tax_amount,
                                          gross_amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9::numeric,$10,$11,$12::numeric,$13::numeric,
                   $14::numeric)`,
          [
            uuidv7(),
            principal.tenantId,
            creditNoteId,
            book.legalEntityId,
            line.lineNo,
            source.invoiceLineId ?? null,
            source.description,
            line.quantity,
            line.unitPrice,
            source.revenueAccountId,
            line.taxCodeId,
            line.netAmount,
            line.taxAmount,
            line.grossAmount,
          ],
        );
      }

      await recordAudit(client, context, {
        action: 'credit_note.created',
        resourceType: 'credit_note',
        resourceId: creditNoteId,
        tenantId: principal.tenantId,
        legalEntityId: book.legalEntityId,
        after: rows[0] as Record<string, unknown>,
      });
      return { ...rows[0], lines: calculated.lines };
    });
  }

  async listCreditNotes(
    principal: TenantPrincipal,
    filter: {
      legalEntityId?: string | undefined;
      customerId?: string | undefined;
      invoiceId?: string | undefined;
      status?: string | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT n.id, n.legal_entity_id, n.customer_id, c.legal_name AS customer_name,
                n.invoice_id, n.credit_note_number, n.document_date::text AS document_date,
                n.posting_date::text AS posting_date, n.currency, n.status::text AS status,
                n.total::text AS total, n.amount_applied::text AS amount_applied,
                n.amount_available::text AS amount_available, n.reason, n.accounting_entry_id
           FROM credit_notes n
           JOIN contacts c ON c.id = n.customer_id
          WHERE ($1::uuid IS NULL OR n.legal_entity_id = $1)
            AND ($2::uuid IS NULL OR n.customer_id = $2)
            AND ($3::uuid IS NULL OR n.invoice_id = $3)
            AND ($4::text IS NULL OR n.status::text = $4)
          ORDER BY n.document_date DESC, n.credit_note_number DESC
          LIMIT 200`,
        [
          filter.legalEntityId ?? null,
          filter.customerId ?? null,
          filter.invoiceId ?? null,
          filter.status ?? null,
        ],
      );
      return { data: rows };
    });
  }

  /** F-711: the route that lets a credit note reach the ledger. */
  async postCreditNote(principal: TenantPrincipal, id: string) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const creditNote = await this.loadCreditNote(client, id, { forUpdate: true });
      assertEntityPermission(principal, 'credit_note.post', creditNote.legal_entity_id as string);

      if (creditNote.status === 'POSTED') return creditNote;
      if (!DRAFT_STATES.has(creditNote.status as string)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `This credit note is ${creditNote.status} and cannot be posted.`,
          { details: { status: creditNote.status } },
        );
      }

      const book = await this.posting.loadBookContext(
        client,
        principal,
        creditNote.accounting_book_id as string,
        creditNote.posting_date as string,
      );

      const { rows: lines } = await client.query<{
        line_no: number;
        description: string;
        quantity: string;
        unit_price: string;
        revenue_account_id: string;
        tax_code_id: string | null;
      }>(
        `SELECT line_no, description, quantity::text AS quantity,
                unit_price::text AS unit_price, revenue_account_id, tax_code_id
           FROM credit_note_lines WHERE credit_note_id = $1 ORDER BY line_no`,
        [id],
      );
      const { calculated, codes } = await this.ar.calculate(
        client,
        creditNote.legal_entity_id as string,
        creditNote.currency as string,
        creditNote.document_date as string,
        lines.map((line) => ({
          lineNo: line.line_no,
          description: line.description,
          quantity: line.quantity,
          unitPrice: line.unit_price,
          ...(line.tax_code_id ? { taxCodeId: line.tax_code_id } : {}),
        })),
      );
      // The journal is built from the recalculation; if the tax configuration
      // moved since the draft was written, posting the stored total would put a
      // number in the subledger the journal does not contain.
      if (!D(calculated.total).equals(D(creditNote.total as string))) {
        throw new AppError(
          'VALIDATION_FAILED',
          `This credit note was drafted at ${creditNote.total} but recalculates to ` +
            `${calculated.total} — the tax configuration changed since it was written. ` +
            'Recreate the credit note so the document and its journal agree.',
          { details: { drafted_total: creditNote.total, recalculated_total: calculated.total } },
        );
      }
      const revenueByLine = new Map(lines.map((line) => [line.line_no, line.revenue_account_id]));

      const posted = await this.ar.postCreditNoteFromCalculated(
        client,
        context,
        principal,
        book,
        creditNote,
        calculated,
        codes,
        revenueByLine,
      );
      return {
        ...posted.credit_note,
        journal_entry: { id: posted.entry.id, entry_number: posted.entry.entry_number },
      };
    });
  }

  /**
   * F-711: applies available credit to open invoices. ADR-0004's lock order —
   * the credit note first, then the invoices in ascending id inside the
   * delegate — and the whole request set validated as one.
   */
  async applyCreditNote(
    principal: TenantPrincipal,
    id: string,
    applications: readonly CreditApplicationInput[],
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const creditNote = await this.loadCreditNote(client, id, { forUpdate: true });
      assertEntityPermission(principal, 'credit_note.apply', creditNote.legal_entity_id as string);

      const book = await this.posting.loadBookContext(
        client,
        principal,
        creditNote.accounting_book_id as string,
        creditNote.posting_date as string,
      );
      return this.ar.applyCreditNoteInTransaction(
        client,
        context,
        principal,
        creditNote,
        book.baseCurrency,
        applications,
      );
    });
  }

  private async loadCreditNote(
    client: PoolClient,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT id, legal_entity_id, accounting_book_id, branch_id, customer_id, invoice_id,
              credit_note_number, document_date::text AS document_date,
              posting_date::text AS posting_date, currency, exchange_rate::text AS exchange_rate,
              status::text AS status, subtotal::text AS subtotal, tax_total::text AS tax_total,
              total::text AS total, amount_applied::text AS amount_applied,
              amount_available::text AS amount_available, accounting_entry_id, reason
         FROM credit_notes WHERE id = $1 ${options.forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    );
    if (!rows[0]) throw notFound('credit note', id);
    return rows[0];
  }

  // =========================================================================
  // AR write-offs — doc 04's bad debt path, F-703's column.
  // =========================================================================

  /**
   * Posts Dr bad debt expense, Cr AR control, and moves the invoice's
   * amount_written_off — the third of the four ways an invoice closes (F-703).
   * Omitting the amount writes off the whole open balance.
   */
  async createArWriteOff(
    principal: TenantPrincipal,
    input: {
      invoiceId: string;
      postingDate: string;
      amount?: string | undefined;
      reasonCode: string;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const invoice = await this.ar.loadInvoice(client, input.invoiceId, { forUpdate: true });
      assertEntityPermission(principal, 'ar.write_off', invoice.legal_entity_id as string);

      const currency = invoice.currency as string;
      const amount = input.amount ?? (invoice.amount_due as string);
      // The same protocol receipts use: lock, then validate the whole request.
      // sourceUnapplied is the write-off itself, so the binding check is the
      // per-target one — a write-off may never exceed what is still owed,
      // because the excess would credit AR for money nobody is owed.
      const requests = [{ targetType: 'INVOICE' as const, targetId: input.invoiceId, amount }];
      const targets = await lockTargets(client, principal, requests);
      validateAllocations({
        sourceUnapplied: amount,
        sourceCurrency: currency,
        requests,
        targets,
        documentLabel: (t) => `invoice ${invoice.invoice_number ?? t.id}`,
      });
      const target = targets.get(input.invoiceId) as AllocationTarget;

      const book = await this.posting.loadBookContext(
        client,
        principal,
        invoice.accounting_book_id as string,
        input.postingDate,
      );
      const badDebtAccountId = await this.ar.policyAccount(
        client,
        book.legalEntityId,
        'bad_debt_account_id',
        input.postingDate,
      );
      if (!badDebtAccountId) {
        throw new AppError(
          'VALIDATION_FAILED',
          'No bad debt account is configured. Set bad_debt_account_id on the accounting policy — ' +
            'a write-off has to name the expense that absorbs it.',
          { details: { legal_entity_id: book.legalEntityId } },
        );
      }
      const arAccountId = await this.ar.resolveArAccount(
        client,
        { customer_id: invoice.customer_id, posting_date: input.postingDate },
        book,
      );

      const exchangeRate = (invoice.exchange_rate as string) ?? '1';
      const writeOffId = uuidv7();
      const result = await this.documents.post(client, context, principal, book, {
        ruleCode: 'AR_BAD_DEBT_WRITE_OFF',
        sourceType: 'ar_write_off',
        sourceId: writeOffId,
        sourceEventId: `ar_write_off.posted:${writeOffId}`,
        journalCode: 'GEN',
        postingDate: input.postingDate,
        documentDate: input.postingDate,
        description: `Write-off of invoice ${invoice.invoice_number ?? input.invoiceId}`,
        branchId: (invoice.branch_id as string) ?? null,
        contactId: invoice.customer_id as string,
        lines: [
          {
            accountId: badDebtAccountId,
            description: `Bad debt (${input.reasonCode})`,
            debit: amount,
            transactionCurrency: currency,
            exchangeRate,
          },
          {
            accountId: arAccountId,
            description: 'Accounts receivable',
            credit: amount,
            contactId: invoice.customer_id as string,
            transactionCurrency: currency,
            exchangeRate,
          },
        ],
      });

      const { rows } = await client.query<Record<string, unknown>>(
        `INSERT INTO ar_write_offs (id, tenant_id, legal_entity_id, accounting_book_id, invoice_id,
                                    posting_date, amount, reason_code, approved_by, approved_at,
                                    accounting_entry_id)
         VALUES ($1,$2,$3,$4,$5,$6::date,$7::numeric,$8,$9,now(),$10)
         RETURNING id, legal_entity_id, invoice_id, posting_date::text AS posting_date,
                   amount::text AS amount, reason_code, approved_by, accounting_entry_id`,
        [
          writeOffId,
          principal.tenantId,
          invoice.legal_entity_id,
          invoice.accounting_book_id,
          input.invoiceId,
          input.postingDate,
          amount,
          input.reasonCode,
          principal.userId,
          result.entry.id,
        ],
      );

      const outcome = await applyToTarget(client, target, amount, 'amount_written_off');

      await publish(client, context, {
        eventType: 'ar.writeoff_posted',
        aggregateType: 'ar_write_off',
        aggregateId: writeOffId,
        tenantId: principal.tenantId,
        organizationId: book.organizationId,
        legalEntityId: invoice.legal_entity_id as string,
        accountingBookId: book.bookId,
        payload: {
          invoice_id: input.invoiceId,
          amount,
          currency,
          reason_code: input.reasonCode,
          journal_entry_id: result.entry.id,
        },
      });
      await recordAudit(client, context, {
        action: 'ar_write_off.posted',
        resourceType: 'ar_write_off',
        resourceId: writeOffId,
        tenantId: principal.tenantId,
        legalEntityId: invoice.legal_entity_id as string,
        after: { ...(rows[0] as Record<string, unknown>), invoice: outcome },
      });

      return {
        ...rows[0],
        invoice: { id: input.invoiceId, ...outcome },
        journal_entry: { id: result.entry.id, entry_number: result.entry.entry_number },
      };
    });
  }

  // =========================================================================
  // Customer refunds — doc 04: "requires available customer credit".
  // =========================================================================

  /**
   * Pays out available customer credit: Dr the account holding the credit (AR
   * control for a credit note, customer advances for an unapplied receipt),
   * Cr bank/cash. The refund names its source, and consuming the source's
   * stored balance is what stops the same credit being refunded twice.
   */
  async createCustomerRefund(
    principal: TenantPrincipal,
    input: {
      accountingBookId: string;
      customerId: string;
      creditNoteId?: string | undefined;
      customerReceiptId?: string | undefined;
      postingDate: string;
      amount: string;
      bankAccountId?: string | undefined;
      depositAccountId?: string | undefined;
    },
  ) {
    if (Boolean(input.creditNoteId) === Boolean(input.customerReceiptId)) {
      throw new AppError(
        'VALIDATION_FAILED',
        'A refund names exactly one source of credit: credit_note_id or customer_receipt_id. ' +
          'An unsourced refund is how the same credit gets paid out twice.',
      );
    }
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const book = await this.posting.loadBookContext(
        client,
        principal,
        input.accountingBookId,
        input.postingDate,
      );
      assertEntityPermission(principal, 'customer_refund.create', book.legalEntityId);

      const refundId = uuidv7();
      let currency: string;
      let exchangeRate: string;
      let sourceAccountId: string;
      let consume: () => Promise<void>;

      if (input.creditNoteId) {
        const creditNoteId = input.creditNoteId;
        const { rows: header } = await client.query<{
          customer_id: string;
          credit_note_number: string | null;
        }>(`SELECT customer_id, credit_note_number FROM credit_notes WHERE id = $1`, [
          creditNoteId,
        ]);
        if (!header[0]) throw notFound('credit note', creditNoteId);
        if (header[0].customer_id !== input.customerId) {
          throw new AppError(
            'VALIDATION_FAILED',
            `Credit note ${creditNoteId} belongs to a different customer than this refund.`,
            { details: { credit_note_id: creditNoteId } },
          );
        }
        const targets = await lockTargets(client, principal, [
          { targetType: 'CREDIT_NOTE', targetId: creditNoteId, amount: input.amount },
        ]);
        const target = targets.get(creditNoteId) as AllocationTarget;
        if (target.status !== 'POSTED') {
          throw new AppError(
            'VALIDATION_FAILED',
            `This credit note is ${target.status}; only a posted credit note has credit to refund.`,
            { details: { status: target.status } },
          );
        }
        assertRefundWithinAvailable(
          input.amount,
          target.amountDue,
          target.currency,
          `credit note ${header[0].credit_note_number ?? creditNoteId}`,
        );
        currency = target.currency;
        exchangeRate = target.exchangeRate ?? '1';
        // The posted credit note already credited AR, so the customer's credit
        // sits in the control account; paying it out debits AR back to zero.
        sourceAccountId = await this.ar.resolveArAccount(
          client,
          { customer_id: input.customerId, posting_date: input.postingDate },
          book,
        );
        // Consuming amount_available is what makes the refund the third of doc
        // 04's three fates for a credit note, exclusive with the other two.
        consume = async () => {
          await applyToTarget(client, target, input.amount, 'amount_paid');
        };
      } else {
        const receiptId = input.customerReceiptId as string;
        const { rows: receipts } = await client.query<{
          id: string;
          customer_id: string;
          receipt_number: string | null;
          currency: string;
          unapplied_amount: string;
          exchange_rate: string | null;
          status: string;
        }>(
          `SELECT id, customer_id, receipt_number, currency,
                  unapplied_amount::text AS unapplied_amount,
                  exchange_rate::text AS exchange_rate, status::text AS status
             FROM customer_receipts WHERE id = $1 FOR UPDATE`,
          [receiptId],
        );
        const receipt = receipts[0];
        if (!receipt) throw notFound('customer receipt', receiptId);
        if (receipt.customer_id !== input.customerId) {
          throw new AppError(
            'VALIDATION_FAILED',
            `Receipt ${receiptId} belongs to a different customer than this refund.`,
            { details: { customer_receipt_id: receiptId } },
          );
        }
        if (receipt.status !== 'POSTED') {
          throw new AppError(
            'VALIDATION_FAILED',
            `This receipt is ${receipt.status}; only a posted receipt has unapplied money to refund.`,
            { details: { status: receipt.status } },
          );
        }
        assertRefundWithinAvailable(
          input.amount,
          receipt.unapplied_amount,
          receipt.currency,
          `receipt ${receipt.receipt_number ?? receiptId}`,
        );
        currency = receipt.currency;
        exchangeRate = receipt.exchange_rate ?? '1';
        // The unapplied half of a receipt was credited to customer advances,
        // not AR (doc 04's visibility rule) — so that is where the refund
        // comes from. Debiting AR instead would push the control account below
        // what customers actually owe.
        const advanceAccountId = await this.ar.policyAccount(
          client,
          book.legalEntityId,
          'customer_advance_account_id',
          input.postingDate,
        );
        if (!advanceAccountId) {
          throw new AppError(
            'VALIDATION_FAILED',
            'No customer advance account is configured, so the unapplied money this refund ' +
              'returns has no account to leave. Set customer_advance_account_id on the ' +
              'accounting policy.',
            { details: { legal_entity_id: book.legalEntityId } },
          );
        }
        sourceAccountId = advanceAccountId;
        consume = async () => {
          // An allocation row plus the balance move, so allocated_amount stays
          // explained by its detail table. OLD-row semantics as everywhere:
          // unapplied_amount is derived from the pre-increment allocated_amount.
          await client.query(
            `INSERT INTO receipt_allocations (id, tenant_id, customer_receipt_id, target_type,
                                              target_id, amount, base_amount, allocated_by)
             VALUES ($1,$2,$3,'ADVANCE',$4,$5::numeric,$6::numeric,$7)`,
            [
              uuidv7(),
              principal.tenantId,
              receiptId,
              refundId,
              input.amount,
              toBase(input.amount, exchangeRate, currency, book.baseCurrency),
              principal.userId,
            ],
          );
          await client.query(
            `UPDATE customer_receipts
                SET allocated_amount = allocated_amount + $2::numeric,
                    unapplied_amount = amount - (allocated_amount + $2::numeric)
              WHERE id = $1`,
            [receiptId, input.amount],
          );
        };
      }

      const depositAccountId = await this.ar.resolveDepositAccount(
        client,
        book,
        input.depositAccountId,
        input.postingDate,
      );
      const refundNumber = await this.ar.allocateDocumentNumber(
        client,
        principal,
        book.legalEntityId,
        'CUSTOMER_REFUND',
      );

      const result = await this.documents.post(client, context, principal, book, {
        ruleCode: 'CUSTOMER_REFUND',
        sourceType: 'customer_refund',
        sourceId: refundId,
        sourceEventId: `customer_refund.posted:${refundId}`,
        journalCode: 'BNK',
        postingDate: input.postingDate,
        documentDate: input.postingDate,
        description: `Refund ${refundNumber}`,
        branchId: null,
        contactId: input.customerId,
        lines: [
          {
            accountId: sourceAccountId,
            description: `Refund ${refundNumber}`,
            debit: input.amount,
            contactId: input.customerId,
            transactionCurrency: currency,
            exchangeRate,
          },
          {
            accountId: depositAccountId,
            description: 'Bank/cash',
            credit: input.amount,
            transactionCurrency: currency,
            exchangeRate,
          },
        ],
      });

      await consume();

      const { rows } = await client.query<Record<string, unknown>>(
        `INSERT INTO customer_refunds (id, tenant_id, legal_entity_id, accounting_book_id,
                                       customer_id, credit_note_id, customer_receipt_id,
                                       refund_number, posting_date, currency, amount,
                                       bank_account_id, status, accounting_entry_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11::numeric,$12,'POSTED',$13)
         RETURNING id, legal_entity_id, customer_id, credit_note_id, customer_receipt_id,
                   refund_number, posting_date::text AS posting_date, currency,
                   amount::text AS amount, status::text AS status, accounting_entry_id`,
        [
          refundId,
          principal.tenantId,
          book.legalEntityId,
          input.accountingBookId,
          input.customerId,
          input.creditNoteId ?? null,
          input.customerReceiptId ?? null,
          refundNumber,
          input.postingDate,
          currency,
          input.amount,
          input.bankAccountId ?? null,
          result.entry.id,
        ],
      );

      await publish(client, context, {
        eventType: 'customer_refund.completed',
        aggregateType: 'customer_refund',
        aggregateId: refundId,
        tenantId: principal.tenantId,
        organizationId: book.organizationId,
        legalEntityId: book.legalEntityId,
        accountingBookId: book.bookId,
        payload: {
          refund_number: refundNumber,
          customer_id: input.customerId,
          amount: input.amount,
          currency,
          credit_note_id: input.creditNoteId ?? null,
          customer_receipt_id: input.customerReceiptId ?? null,
          journal_entry_id: result.entry.id,
        },
      });
      await recordAudit(client, context, {
        action: 'customer_refund.completed',
        resourceType: 'customer_refund',
        resourceId: refundId,
        tenantId: principal.tenantId,
        legalEntityId: book.legalEntityId,
        after: rows[0] as Record<string, unknown>,
      });

      return {
        ...rows[0],
        journal_entry: { id: result.entry.id, entry_number: result.entry.entry_number },
      };
    });
  }

  // =========================================================================
  // Recurring invoices — doc 04: every generated invoice is a normal invoice
  // linked to template version/occurrence, and occurrence is idempotent.
  // =========================================================================

  async createRecurringInvoice(
    principal: TenantPrincipal,
    input: {
      accountingBookId: string;
      customerId: string;
      name: string;
      frequency: 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
      startDate: string;
      endDate?: string | undefined;
      dueDateRule?: string | undefined;
      autoSend?: boolean | undefined;
      autoPost?: boolean | undefined;
      lines: readonly InvoiceLineInput[];
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const book = await this.posting.loadBookContext(
        client,
        principal,
        input.accountingBookId,
        input.startDate,
      );
      assertEntityPermission(principal, 'invoice.create', book.legalEntityId);
      const customer = await this.ar.loadCustomer(client, input.customerId);

      if (input.lines.length === 0) {
        throw new AppError('VALIDATION_FAILED', 'A recurring invoice template needs lines.');
      }
      if (input.endDate && input.endDate < input.startDate) {
        throw new AppError(
          'VALIDATION_FAILED',
          `The template ends (${input.endDate}) before it starts (${input.startDate}).`,
        );
      }
      // A dry run through the one shared calculator, so a bad tax code fails
      // here in front of the person typing it rather than in the 2am job.
      const currency = (customer.default_currency as string | null) ?? book.baseCurrency;
      await this.ar.calculate(client, book.legalEntityId, currency, input.startDate, input.lines);

      const templateId = uuidv7();
      const { rows } = await client.query<Record<string, unknown>>(
        `INSERT INTO recurring_invoice_templates (id, tenant_id, legal_entity_id,
                                                  accounting_book_id, customer_id, name, frequency,
                                                  start_date, end_date, next_run_date,
                                                  due_date_rule, auto_send, auto_post,
                                                  line_template)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9::date,$8::date,$10,$11,$12,$13::jsonb)
         RETURNING id, legal_entity_id, accounting_book_id, customer_id, name, version, frequency,
                   start_date::text AS start_date, end_date::text AS end_date,
                   next_run_date::text AS next_run_date, due_date_rule, auto_send, auto_post,
                   status::text AS status`,
        [
          templateId,
          principal.tenantId,
          book.legalEntityId,
          input.accountingBookId,
          input.customerId,
          input.name,
          input.frequency,
          input.startDate,
          input.endDate ?? null,
          input.dueDateRule ?? null,
          input.autoSend ?? false,
          input.autoPost ?? false,
          JSON.stringify(input.lines),
        ],
      );

      await recordAudit(client, context, {
        action: 'recurring_invoice_template.created',
        resourceType: 'recurring_invoice_template',
        resourceId: templateId,
        tenantId: principal.tenantId,
        legalEntityId: book.legalEntityId,
        after: rows[0] as Record<string, unknown>,
      });
      return rows[0];
    });
  }

  async listRecurringInvoices(
    principal: TenantPrincipal,
    filter: {
      legalEntityId?: string | undefined;
      customerId?: string | undefined;
      status?: string | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT t.id, t.legal_entity_id, t.accounting_book_id, t.customer_id,
                c.legal_name AS customer_name, t.name, t.version, t.frequency,
                t.start_date::text AS start_date, t.end_date::text AS end_date,
                t.next_run_date::text AS next_run_date, t.due_date_rule, t.auto_send, t.auto_post,
                t.status::text AS status
           FROM recurring_invoice_templates t
           JOIN contacts c ON c.id = t.customer_id
          WHERE ($1::uuid IS NULL OR t.legal_entity_id = $1)
            AND ($2::uuid IS NULL OR t.customer_id = $2)
            AND ($3::text IS NULL OR t.status::text = $3)
          ORDER BY t.name
          LIMIT 200`,
        [filter.legalEntityId ?? null, filter.customerId ?? null, filter.status ?? null],
      );
      return { data: rows };
    });
  }

  /**
   * The worker's entry point: generates every occurrence due at `asOf`.
   *
   * Idempotent per (template, occurrence date) — the cursor maths is
   * deterministic and `recurring_invoice_occurrences`' UNIQUE constraint plus
   * ON CONFLICT DO NOTHING makes the second run of the same day insert
   * nothing, so a crashed-and-retried job cannot invoice a customer twice.
   *
   * One transaction per template, so one template with a broken tax code does
   * not hold every other customer's invoicing hostage; its failure is reported
   * rather than thrown.
   */
  async generateDueOccurrences(principal: TenantPrincipal, asOf: string) {
    const due = await readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM recurring_invoice_templates
          WHERE status = 'ACTIVE' AND next_run_date IS NOT NULL AND next_run_date <= $1::date
          ORDER BY id`,
        [asOf],
      );
      return rows.map((row) => row.id);
    });

    const generated: Array<Record<string, unknown>> = [];
    const failures: Array<{ template_id: string; error: string }> = [];
    for (const templateId of due) {
      try {
        generated.push(...(await this.generateForTemplate(principal, templateId, asOf)));
      } catch (error) {
        failures.push({
          template_id: templateId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { as_of: asOf, generated, failures };
  }

  private async generateForTemplate(
    principal: TenantPrincipal,
    templateId: string,
    asOf: string,
  ): Promise<Array<Record<string, unknown>>> {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `SELECT id, legal_entity_id, accounting_book_id, customer_id, name, version, frequency,
                start_date::text AS start_date, end_date::text AS end_date,
                next_run_date::text AS next_run_date, due_date_rule, auto_send, auto_post,
                line_template, status::text AS status
           FROM recurring_invoice_templates WHERE id = $1 FOR UPDATE`,
        [templateId],
      );
      const template = rows[0];
      // Re-checked under the lock: a concurrent worker may have advanced the
      // cursor between the scan and here.
      if (
        !template ||
        template.status !== 'ACTIVE' ||
        !template.next_run_date ||
        (template.next_run_date as string) > asOf
      ) {
        return [];
      }

      const frequency = template.frequency as string;
      const endDate = template.end_date as string | null;
      const dates = dueOccurrenceDates(template.next_run_date as string, frequency, asOf, endDate);
      const lines = template.line_template as unknown as InvoiceLineInput[];
      const results: Array<Record<string, unknown>> = [];

      for (const occurrenceDate of dates) {
        const { rows: occurrence } = await client.query<{ id: string }>(
          `INSERT INTO recurring_invoice_occurrences (id, template_id, occurrence_date,
                                                      template_version)
           VALUES ($1,$2,$3::date,$4)
           ON CONFLICT (template_id, occurrence_date) DO NOTHING
           RETURNING id`,
          [uuidv7(), templateId, occurrenceDate, template.version],
        );
        // No row back means a previous run already generated this occurrence.
        if (!occurrence[0]) continue;

        const dueDate = dueDateFromRule(occurrenceDate, template.due_date_rule as string | null);
        const invoice = (await this.ar.createInvoiceInTransaction(client, context, principal, {
          accountingBookId: template.accounting_book_id as string,
          customerId: template.customer_id as string,
          documentDate: occurrenceDate,
          postingDate: occurrenceDate,
          ...(dueDate ? { dueDate } : {}),
          lines,
        })) as Record<string, unknown>;
        // The link back to template and occurrence, doc 04's requirement that a
        // generated invoice explains where it came from. Still DRAFT, so the
        // immutability guard permits it.
        await client.query(`UPDATE invoices SET recurring_template_id = $2 WHERE id = $1`, [
          invoice.id,
          templateId,
        ]);
        await client.query(
          `UPDATE recurring_invoice_occurrences SET invoice_id = $2 WHERE id = $1`,
          [occurrence[0].id, invoice.id],
        );
        results.push({
          template_id: templateId,
          occurrence_date: occurrenceDate,
          invoice_id: invoice.id,
          auto_post: template.auto_post,
          auto_send: template.auto_send,
        });
      }

      const lastGenerated = dates[dates.length - 1];
      // Advance the cursor past everything generated; a template past its end
      // date parks at NULL so the scan stops returning it.
      const nextRun = lastGenerated
        ? nextOccurrenceDate(lastGenerated, frequency)
        : (template.next_run_date as string);
      const parked = endDate !== null && nextRun > endDate;
      await client.query(
        `UPDATE recurring_invoice_templates SET next_run_date = $2 WHERE id = $1`,
        [templateId, parked ? null : nextRun],
      );

      return results;
    });
  }

  // =========================================================================
  // Dunning — doc 04 collections. Phase 3 exposes the queue; stage advancement
  // is the worker's job.
  // =========================================================================

  async listDunningCases(
    principal: TenantPrincipal,
    filter: {
      legalEntityId?: string | undefined;
      contactId?: string | undefined;
      status?: string | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT d.id, d.legal_entity_id, d.contact_id, c.legal_name AS customer_name, d.stage,
                d.status, d.promise_to_pay_at::text AS promise_to_pay_at, d.dispute_reason,
                d.owner_user_id, d.last_action_at, d.created_at
           FROM dunning_cases d
           JOIN contacts c ON c.id = d.contact_id
          WHERE ($1::uuid IS NULL OR d.legal_entity_id = $1)
            AND ($2::uuid IS NULL OR d.contact_id = $2)
            AND ($3::text IS NULL OR d.status = $3)
          ORDER BY d.stage DESC, d.created_at
          LIMIT 200`,
        [filter.legalEntityId ?? null, filter.contactId ?? null, filter.status ?? null],
      );
      return { data: rows };
    });
  }

  // =========================================================================
  // E-invoice — doc 07: retry must never cause a duplicate government
  // submission.
  // =========================================================================

  /**
   * Submits a posted invoice to the injected e-invoice provider.
   *
   * One submission row per (provider, invoice), keyed by the UNIQUE
   * (provider, idempotency_key) constraint. A row that reached SUBMITTED or
   * ACCEPTED is returned as-is — that is the doc 07 acceptance criterion; only
   * PENDING and REJECTED rows are retried.
   */
  async submitEInvoice(principal: TenantPrincipal, invoiceId: string) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const invoice = await this.ar.loadInvoice(client, invoiceId);
      assertEntityPermission(principal, 'einvoice.submit', invoice.legal_entity_id as string);

      if (!['POSTED', 'PARTIALLY_PAID', 'PAID'].includes(invoice.status as string)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `This invoice is ${invoice.status}. Post it first — a government submission carries ` +
            'the final invoice number, and an unposted invoice has none.',
          { details: { status: invoice.status } },
        );
      }

      const idempotencyKey = `invoice:${invoiceId}`;
      const { rows: existing } = await client.query<Record<string, unknown>>(
        `SELECT id, status::text AS status, government_id, qr_payload, rejection_reason, attempts,
                submitted_at, responded_at
           FROM einvoice_submissions
          WHERE provider = $1 AND idempotency_key = $2
          FOR UPDATE`,
        [this.einvoice.name, idempotencyKey],
      );
      const current = existing[0];
      if (current && (current.status === 'SUBMITTED' || current.status === 'ACCEPTED')) {
        return { ...current, replayed: true };
      }

      const payload = {
        invoice_number: invoice.invoice_number,
        customer_id: invoice.customer_id,
        document_date: invoice.document_date,
        currency: invoice.currency,
        subtotal: invoice.subtotal,
        tax_total: invoice.tax_total,
        total: invoice.total,
      };

      const submissionId = (current?.id as string) ?? uuidv7();
      if (!current) {
        await client.query(
          `INSERT INTO einvoice_submissions (id, tenant_id, legal_entity_id, source_type,
                                             source_id, provider, idempotency_key, request_payload)
           VALUES ($1,$2,$3,'invoice',$4,$5,$6,$7::jsonb)`,
          [
            submissionId,
            principal.tenantId,
            invoice.legal_entity_id,
            invoiceId,
            this.einvoice.name,
            idempotencyKey,
            JSON.stringify(payload),
          ],
        );
      }

      const result = await this.einvoice.submit({
        legalEntityId: invoice.legal_entity_id as string,
        sourceType: 'invoice',
        sourceId: invoiceId,
        idempotencyKey,
        payload,
      });

      if (!result.transmitted) {
        // Nothing reached a government endpoint, so the row keeps saying so:
        // PENDING, no attempt counted, no submitted_at, no event.
        const { rows } = await client.query<Record<string, unknown>>(
          `UPDATE einvoice_submissions SET response_payload = $2::jsonb
            WHERE id = $1
            RETURNING id, source_id, provider, status::text AS status, attempts,
                      response_payload, submitted_at, responded_at`,
          [submissionId, JSON.stringify(result.response ?? {})],
        );
        return { ...rows[0], transmitted: false };
      }

      const status = result.status ?? 'SUBMITTED';
      const { rows } = await client.query<Record<string, unknown>>(
        `UPDATE einvoice_submissions
            SET status = $2::einvoice_status, attempts = attempts + 1, submitted_at = now(),
                responded_at = CASE WHEN $2 IN ('ACCEPTED','REJECTED') THEN now() ELSE responded_at END,
                government_id = coalesce($3, government_id),
                qr_payload = coalesce($4, qr_payload),
                rejection_reason = $5,
                response_payload = $6::jsonb
          WHERE id = $1
          RETURNING id, source_id, provider, status::text AS status, government_id, qr_payload,
                    rejection_reason, attempts, submitted_at, responded_at`,
        [
          submissionId,
          status,
          result.governmentId ?? null,
          result.qrPayload ?? null,
          result.rejectionReason ?? null,
          JSON.stringify(result.response ?? {}),
        ],
      );

      const eventType =
        status === 'ACCEPTED'
          ? 'einvoice.accepted'
          : status === 'REJECTED'
            ? 'einvoice.rejected'
            : 'einvoice.submitted';
      await publish(client, context, {
        eventType,
        aggregateType: 'einvoice_submission',
        aggregateId: submissionId,
        tenantId: principal.tenantId,
        legalEntityId: invoice.legal_entity_id as string,
        payload: {
          invoice_id: invoiceId,
          invoice_number: invoice.invoice_number,
          provider: this.einvoice.name,
          status,
          government_id: result.governmentId ?? null,
        },
      });
      await recordAudit(client, context, {
        action: 'einvoice.submitted',
        resourceType: 'einvoice_submission',
        resourceId: submissionId,
        tenantId: principal.tenantId,
        legalEntityId: invoice.legal_entity_id as string,
        after: rows[0] as Record<string, unknown>,
      });

      return { ...rows[0], transmitted: true };
    });
  }
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * doc 04's due-date rule on the template. `NET_<days>` is the only rule Phase 3
 * understands; anything else returns undefined so the customer's own payment
 * terms apply — the same default a manually created invoice gets.
 */
function dueDateFromRule(documentDate: string, rule: string | null): string | undefined {
  if (!rule) return undefined;
  const match = /^NET_(\d+)$/.exec(rule.trim().toUpperCase());
  if (!match) return undefined;
  const parsed = new Date(`${documentDate}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + Number(match[1]));
  return parsed.toISOString().slice(0, 10);
}
