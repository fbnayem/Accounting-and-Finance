import { Pool, PoolClient } from 'pg';
import {
  AppError,
  Money,
  D,
  notFound,
  uuidv7,
  assertVersion,
  assertPermission,
  assertEntityPermission,
  calculateDocument,
  toBase,
  type TenantPrincipal,
  type RequestContext,
  type CalculatedDocument,
  type DocumentLineInput,
  type DraftLineInput,
} from '@acct/domain';
import { publish, recordAudit, readInTenant, writeInTenant } from '@acct/database';
import { PostingService, allocateNumber, type BookContext } from '@acct/ledger';
import { TaxService, type ResolvedTaxCode } from './tax.service';
import { DocumentPostingService, salesInvoiceLines } from './document-posting.service';
import {
  lockTargets,
  validateAllocations,
  applyToTarget,
  recordAllocation,
  settlementPostingLines,
  assertInvoiceEditable,
  creditApplicationRequests,
  type AllocationRequest,
  type CreditApplicationInput,
  type SettlementAllocation,
} from './allocation';

/**
 * Accounts receivable — doc 04.
 *
 * The lifecycle rule that shapes every method here is the one doc 04 states
 * plainly: "Correction states are handled by credit note/cancel-and-reissue; no
 * editing posted financial values." So a posted invoice is read-only in this
 * file, and every operation that changes what a customer owes creates a new
 * document that says so.
 */

const DRAFT_STATES = new Set(['DRAFT', 'PENDING_APPROVAL', 'APPROVED']);

/**
 * The inputs `calculate` actually reads. Quotes and sales orders are non-posting
 * (doc 04), so their lines carry no revenue account — splitting the type is what
 * lets one calculator serve every sales document instead of each service growing
 * its own arithmetic.
 */
export interface CalculableLineInput {
  lineNo?: number | undefined;
  description: string;
  quantity: string;
  unitPrice: string;
  discountAmount?: string | undefined;
  taxCodeId?: string | undefined;
  inclusive?: boolean | undefined;
}

export interface InvoiceLineInput extends CalculableLineInput {
  revenueAccountId: string;
  salesOrderLineId?: string | undefined;
  dimensions?: Record<string, string> | undefined;
}

export interface InvoiceCreateInput {
  accountingBookId: string;
  customerId: string;
  branchId?: string | undefined;
  salesOrderId?: string | undefined;
  documentDate: string;
  postingDate: string;
  dueDate?: string | undefined;
  currency?: string | undefined;
  exchangeRate?: string | undefined;
  exchangeRateDate?: string | undefined;
  documentDiscount?: string | undefined;
  terms?: string | undefined;
  notes?: string | undefined;
  lines: readonly InvoiceLineInput[];
}

export class ArService {
  constructor(
    private readonly pool: Pool,
    private readonly posting: PostingService,
    private readonly documents: DocumentPostingService,
    private readonly tax: TaxService,
  ) {}

  // =========================================================================
  // Customers
  // =========================================================================

  async createCustomer(
    principal: TenantPrincipal,
    input: {
      organizationId: string;
      legalEntityId?: string | undefined;
      code?: string | undefined;
      legalName: string;
      displayName?: string | undefined;
      email?: string | undefined;
      phone?: string | undefined;
      taxIdentifier?: string | undefined;
      defaultCurrency?: string | undefined;
      paymentTermsDays?: number | undefined;
      creditLimit?: string | undefined;
      arAccountId?: string | undefined;
      revenueAccountId?: string | undefined;
      salesTaxCodeId?: string | undefined;
      billingAddress?: Record<string, unknown> | undefined;
      collectionOwnerId?: string | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      // A contact may be shared across the organization (F-026), in which case
      // there is no entity to scope the check to and the tenant-wide grant is the
      // right question. Passing a null entity id to the entity check would be a
      // check that cannot fail.
      if (input.legalEntityId) {
        assertEntityPermission(principal, 'customer.create', input.legalEntityId);
      } else {
        assertPermission(principal, 'customer.create');
      }

      // doc 02: duplicate detection on tax id, email and normalised name. A
      // warning rather than a refusal — two branches of one group genuinely do
      // share a tax identifier, and refusing would make the legitimate case
      // impossible while the accidental one is merely inconvenient.
      const duplicates = await this.findDuplicateContacts(client, input.organizationId, {
        taxIdentifier: input.taxIdentifier,
        email: input.email,
        legalName: input.legalName,
      });

      const { rows } = await client.query<Record<string, unknown>>(
        `INSERT INTO contacts (id, tenant_id, organization_id, legal_entity_id, kind, code,
                               legal_name, display_name, email, phone, tax_identifier,
                               default_currency, payment_terms_days, credit_limit,
                               ar_account_id, revenue_account_id, sales_tax_code_id,
                               billing_address, collection_owner_id)
         VALUES ($1,$2,$3,$4,'CUSTOMER',$5,$6,$7,$8,$9,$10,$11,$12,$13::numeric,$14,$15,$16,
                 $17::jsonb,$18)
         RETURNING id, organization_id, legal_entity_id, kind::text AS kind, code, legal_name,
                   display_name, email, phone, tax_identifier, default_currency,
                   payment_terms_days, credit_limit::text AS credit_limit, ar_account_id,
                   revenue_account_id, status::text AS status, version::text AS version`,
        [
          uuidv7(),
          principal.tenantId,
          input.organizationId,
          input.legalEntityId ?? null,
          input.code ?? null,
          input.legalName,
          input.displayName ?? null,
          input.email ?? null,
          input.phone ?? null,
          input.taxIdentifier ?? null,
          input.defaultCurrency ?? null,
          input.paymentTermsDays ?? null,
          input.creditLimit ?? null,
          input.arAccountId ?? null,
          input.revenueAccountId ?? null,
          input.salesTaxCodeId ?? null,
          JSON.stringify(input.billingAddress ?? {}),
          input.collectionOwnerId ?? null,
        ],
      );
      const created = rows[0]!;

      await publish(client, context, {
        eventType: 'customer.created',
        aggregateType: 'contact',
        aggregateId: created.id as string,
        tenantId: principal.tenantId,
        organizationId: input.organizationId,
        ...(input.legalEntityId ? { legalEntityId: input.legalEntityId } : {}),
        payload: { legal_name: input.legalName, code: input.code ?? null },
      });
      await recordAudit(client, context, {
        action: 'customer.created',
        resourceType: 'contact',
        resourceId: created.id as string,
        tenantId: principal.tenantId,
        after: created,
      });

      return { ...created, possible_duplicates: duplicates };
    });
  }

  /**
   * doc 02's duplicate signals, run before the insert so the answer can be shown
   * with the created record rather than discovered by a report a month later.
   */
  private async findDuplicateContacts(
    client: PoolClient,
    organizationId: string,
    signals: { taxIdentifier?: string | undefined; email?: string | undefined; legalName: string },
  ): Promise<Array<{ id: string; legal_name: string; matched_on: string }>> {
    const { rows } = await client.query<{ id: string; legal_name: string; matched_on: string }>(
      `SELECT id, legal_name,
              CASE WHEN $2::text IS NOT NULL AND tax_identifier = $2 THEN 'tax_identifier'
                   WHEN $3::citext IS NOT NULL AND email = $3          THEN 'email'
                   ELSE 'normalised_name' END AS matched_on
         FROM contacts
        WHERE organization_id = $1
          AND ( ($2::text IS NOT NULL AND tax_identifier = $2)
             OR ($3::citext IS NOT NULL AND email = $3)
             OR lower(regexp_replace(legal_name, '[^a-zA-Z0-9]', '', 'g'))
                = lower(regexp_replace($4, '[^a-zA-Z0-9]', '', 'g')) )
        LIMIT 5`,
      [organizationId, signals.taxIdentifier ?? null, signals.email ?? null, signals.legalName],
    );
    return rows;
  }

  async getContact(principal: TenantPrincipal, id: string, kind: 'CUSTOMER' | 'VENDOR') {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `SELECT c.id, c.organization_id, c.legal_entity_id, c.kind::text AS kind, c.code,
                c.legal_name, c.display_name, c.email, c.phone, c.tax_identifier,
                c.default_currency, c.payment_terms_days, c.credit_limit::text AS credit_limit,
                c.ar_account_id, c.ap_account_id, c.revenue_account_id, c.expense_account_id,
                c.sales_tax_code_id, c.purchase_tax_code_id, c.billing_address, c.shipping_address,
                c.collection_owner_id, c.status::text AS status, c.version::text AS version,
                coalesce(json_agg(json_build_object('id', p.id, 'name', p.name, 'email', p.email,
                  'role', p.role, 'is_primary', p.is_primary))
                  FILTER (WHERE p.id IS NOT NULL), '[]') AS contacts
           FROM contacts c
           LEFT JOIN contact_persons p ON p.contact_id = c.id AND p.status = 'ACTIVE'
          WHERE c.id = $1 AND c.kind IN ($2, 'BOTH')
          GROUP BY c.id`,
        [id, kind],
      );
      if (!rows[0]) throw notFound(kind.toLowerCase(), id);
      return rows[0];
    });
  }

  /**
   * F-708. Everything about a contact except bank details, which have their own
   * high-risk route — an ordinary edit must not become a way to reach the field
   * that decides where money goes.
   */
  async updateContact(
    principal: TenantPrincipal,
    id: string,
    kind: 'CUSTOMER' | 'VENDOR',
    input: Record<string, unknown>,
    expectedVersion: string | null,
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows: current } = await client.query<Record<string, unknown>>(
        `SELECT id, legal_entity_id, kind::text AS kind, legal_name, version::text AS version
           FROM contacts WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const before = current[0];
      if (!before) throw notFound(kind.toLowerCase(), id);
      const permission = kind === 'CUSTOMER' ? 'customer.edit' : 'vendor.edit';
      const scope = before.legal_entity_id as string | null;
      if (scope) assertEntityPermission(principal, permission, scope);
      else assertPermission(principal, permission);
      // If-Match is optional on this route, so an absent header means "I did not
      // read a version" rather than "I read version null" — and skipping the check
      // is the documented behaviour of an optional precondition (RFC 9110 §13.1.1).
      if (expectedVersion !== null) {
        assertVersion(before.version as string, expectedVersion, 'contact', id);
      }

      const editable = [
        'code',
        'legal_name',
        'display_name',
        'email',
        'phone',
        'tax_identifier',
        'default_currency',
        'payment_terms_days',
        'credit_limit',
        'ar_account_id',
        'ap_account_id',
        'revenue_account_id',
        'expense_account_id',
        'sales_tax_code_id',
        'purchase_tax_code_id',
        'collection_owner_id',
        'status',
      ];
      const sets: string[] = [];
      const values: unknown[] = [id];
      for (const field of editable) {
        if (!(field in input)) continue;
        values.push(input[field]);
        sets.push(
          field === 'status'
            ? `${field} = $${values.length}::record_status`
            : `${field} = $${values.length}`,
        );
      }
      if (sets.length === 0) return before;

      const { rows } = await client.query<Record<string, unknown>>(
        `UPDATE contacts SET ${sets.join(', ')}, version = version + 1
          WHERE id = $1
          RETURNING id, legal_entity_id, kind::text AS kind, code, legal_name, display_name,
                    email, phone, tax_identifier, default_currency, payment_terms_days,
                    credit_limit::text AS credit_limit, ar_account_id, ap_account_id,
                    status::text AS status, version::text AS version`,
        values,
      );
      await recordAudit(client, context, {
        action: kind === 'CUSTOMER' ? 'customer.updated' : 'vendor.updated',
        resourceType: 'contact',
        resourceId: id,
        tenantId: principal.tenantId,
        before,
        after: rows[0] as Record<string, unknown>,
      });
      return rows[0];
    });
  }

  async listContacts(
    principal: TenantPrincipal,
    kind: 'CUSTOMER' | 'VENDOR',
    filter: { organizationId?: string | undefined; search?: string | undefined },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT id, organization_id, legal_entity_id, code, legal_name, display_name, email,
                default_currency, payment_terms_days, credit_limit::text AS credit_limit,
                status::text AS status, version::text AS version
           FROM contacts
          WHERE kind IN ($1, 'BOTH')
            AND ($2::uuid IS NULL OR organization_id = $2)
            AND ($3::text IS NULL OR legal_name ILIKE '%' || $3 || '%' OR code ILIKE '%' || $3 || '%')
          ORDER BY legal_name
          LIMIT 200`,
        [kind, filter.organizationId ?? null, filter.search ?? null],
      );
      return { data: rows };
    });
  }

  // =========================================================================
  // Invoices
  // =========================================================================

  /**
   * Creates a DRAFT invoice with its lines calculated server-side.
   *
   * The client supplies quantity, price, discount and tax code; every amount on
   * the stored row is computed here. doc 04: "UI may preview but server result is
   * authoritative" — which is only true if the server never reads an amount the
   * client sent.
   */
  async createInvoice(principal: TenantPrincipal, input: InvoiceCreateInput) {
    return writeInTenant(this.pool, principal, async ({ client, context }) =>
      this.createInvoiceInTransaction(client, context, principal, input),
    );
  }

  /**
   * @internal The body of `createInvoice`, callable inside an existing
   * transaction. Quote conversion needs the invoice and the quote's converted-to
   * link to commit together — two transactions would allow a quote that says it
   * became an invoice that does not exist.
   */
  async createInvoiceInTransaction(
    client: PoolClient,
    context: RequestContext,
    principal: TenantPrincipal,
    input: InvoiceCreateInput,
  ) {
    {
      const book = await this.posting.loadBookContext(
        client,
        principal,
        input.accountingBookId,
        input.postingDate,
      );
      assertEntityPermission(principal, 'invoice.create', book.legalEntityId);

      const customer = await this.loadCustomer(client, input.customerId);
      const currency =
        input.currency ?? (customer.default_currency as string | null) ?? book.baseCurrency;
      const exchangeRate = await this.resolveRate(
        client,
        currency,
        book.baseCurrency,
        input.exchangeRate,
        input.postingDate,
      );

      const { calculated } = await this.calculate(
        client,
        book.legalEntityId,
        currency,
        input.documentDate,
        input.lines,
        input.documentDiscount,
      );

      const dueDate =
        input.dueDate ??
        (customer.payment_terms_days !== null
          ? addDays(input.documentDate, Number(customer.payment_terms_days))
          : input.documentDate);

      await this.assertCreditLimit(client, customer, calculated.total, currency, book);

      const invoiceId = uuidv7();
      const { rows } = await client.query<Record<string, unknown>>(
        `INSERT INTO invoices (id, tenant_id, legal_entity_id, accounting_book_id, branch_id,
                               customer_id, sales_order_id, document_date, posting_date, due_date,
                               currency, exchange_rate, exchange_rate_date, subtotal,
                               discount_total, tax_total, total, base_total, amount_due,
                               terms, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9::date,$10::date,$11,$12::numeric,$13::date,
                 $14::numeric,$15::numeric,$16::numeric,$17::numeric,$18::numeric,$17::numeric,
                 $19,$20,$21)
         RETURNING id, legal_entity_id, accounting_book_id, customer_id, invoice_number,
                   document_date::text AS document_date, posting_date::text AS posting_date,
                   due_date::text AS due_date, currency, exchange_rate::text AS exchange_rate,
                   status::text AS status, subtotal::text AS subtotal,
                   discount_total::text AS discount_total, tax_total::text AS tax_total,
                   total::text AS total, base_total::text AS base_total,
                   amount_due::text AS amount_due, version::text AS version`,
        [
          invoiceId,
          principal.tenantId,
          book.legalEntityId,
          book.bookId,
          input.branchId ?? null,
          input.customerId,
          input.salesOrderId ?? null,
          input.documentDate,
          input.postingDate,
          dueDate,
          currency,
          exchangeRate,
          input.exchangeRateDate ?? input.postingDate,
          calculated.subtotal,
          calculated.discountTotal,
          calculated.taxTotal,
          calculated.total,
          toBase(calculated.total, exchangeRate, currency, book.baseCurrency),
          input.terms ?? null,
          input.notes ?? null,
          principal.userId,
        ],
      );

      await this.writeInvoiceLines(client, principal, {
        invoiceId,
        legalEntityId: book.legalEntityId,
        calculated,
        inputs: input.lines,
      });

      await publish(client, context, {
        eventType: 'invoice.created',
        aggregateType: 'invoice',
        aggregateId: invoiceId,
        tenantId: principal.tenantId,
        organizationId: book.organizationId,
        legalEntityId: book.legalEntityId,
        accountingBookId: book.bookId,
        payload: { customer_id: input.customerId, total: calculated.total, currency },
      });

      return { ...rows[0], lines: calculated.lines };
    }
  }

  /**
   * doc 04's credit limit. A block, not a warning, because a credit limit whose
   * only effect is a message is a number somebody typed once.
   *
   * Checked against posted exposure plus this document, and skipped entirely
   * when no limit is set — the absence of a limit is the common case and must
   * not cost a query.
   */
  private async assertCreditLimit(
    client: PoolClient,
    customer: Record<string, unknown>,
    documentTotal: string,
    currency: string,
    book: BookContext,
  ): Promise<void> {
    const limit = customer.credit_limit as string | null;
    if (!limit || D(limit).isZero()) return;

    const { rows } = await client.query<{ exposure: string }>(
      `SELECT coalesce(sum(amount_due), 0)::text AS exposure
         FROM invoices
        WHERE customer_id = $1 AND legal_entity_id = $2
          AND status IN ('POSTED','PARTIALLY_PAID')`,
      [customer.id, book.legalEntityId],
    );
    const exposure = Money.of(D(rows[0]?.exposure ?? '0'), currency);
    const after = exposure.add(Money.of(D(documentTotal), currency));
    if (after.gt(Money.of(D(limit), currency))) {
      throw new AppError(
        'VALIDATION_FAILED',
        `This invoice would take ${customer.legal_name} to ${after.toString()} ${currency} ` +
          `against a credit limit of ${Money.of(D(limit), currency).toString()}. Raising the ` +
          'limit is a customer decision recorded on the customer, not an override on the invoice.',
        {
          details: {
            credit_limit: limit,
            current_exposure: exposure.toString(),
            after_this_invoice: after.toString(),
          },
        },
      );
    }
  }

  /** @internal Shared with SalesService so every sales document is priced by one calculator. */
  async calculate(
    client: PoolClient,
    legalEntityId: string,
    currency: string,
    documentDate: string,
    lines: readonly CalculableLineInput[],
    documentDiscount?: string | undefined,
  ): Promise<{ calculated: CalculatedDocument; codes: Map<string, ResolvedTaxCode> }> {
    const codes = await this.tax.resolveCodes(
      client,
      legalEntityId,
      lines.map((l) => l.taxCodeId).filter((id): id is string => Boolean(id)),
      documentDate,
    );

    const documentLines: DocumentLineInput[] = lines.map((line, index) => {
      const code = line.taxCodeId ? codes.get(line.taxCodeId) : undefined;
      return {
        lineNo: line.lineNo ?? index + 1,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        ...(line.discountAmount !== undefined ? { discountAmount: line.discountAmount } : {}),
        ...(code ? { taxCode: { ...code, inclusive: line.inclusive ?? code.inclusive } } : {}),
      };
    });

    return {
      calculated: calculateDocument(documentLines, {
        currency,
        ...(documentDiscount !== undefined ? { documentDiscount } : {}),
      }),
      codes,
    };
  }

  private async writeInvoiceLines(
    client: PoolClient,
    principal: TenantPrincipal,
    input: {
      invoiceId: string;
      legalEntityId: string;
      calculated: CalculatedDocument;
      inputs: readonly InvoiceLineInput[];
    },
  ): Promise<void> {
    const byLineNo = new Map(
      input.inputs.map((line, index) => [line.lineNo ?? index + 1, line] as const),
    );

    for (const line of input.calculated.lines) {
      const source = byLineNo.get(line.lineNo);
      if (!source) continue;
      const lineId = uuidv7();
      await client.query(
        `INSERT INTO invoice_lines (id, tenant_id, invoice_id, legal_entity_id, line_no,
                                    description, quantity, unit_price, discount_amount,
                                    revenue_account_id, tax_code_id, sales_order_line_id,
                                    net_amount, tax_amount, gross_amount, calculation_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,$8::numeric,$9::numeric,$10,$11,$12,
                 $13::numeric,$14::numeric,$15::numeric,$16::jsonb)`,
        [
          lineId,
          principal.tenantId,
          input.invoiceId,
          input.legalEntityId,
          line.lineNo,
          source.description,
          line.quantity,
          line.unitPrice,
          line.discountAmount,
          source.revenueAccountId,
          line.taxCodeId,
          source.salesOrderLineId ?? null,
          line.netAmount,
          line.taxAmount,
          line.grossAmount,
          JSON.stringify(line.snapshot),
        ],
      );

      for (const [dimensionId, valueId] of Object.entries(source.dimensions ?? {})) {
        await client.query(
          `INSERT INTO document_line_dimensions (tenant_id, resource_type, resource_id,
                                                 legal_entity_id, dimension_id, dimension_value_id)
           VALUES ($1,'invoice_line',$2,$3,$4,$5)`,
          [principal.tenantId, lineId, input.legalEntityId, dimensionId, valueId],
        );
      }

      // doc 04: partial invoicing maintains the order's invoiced quantity. F-707
      // added the link that makes this possible; without it the order would show
      // nothing invoiced no matter how many invoices came from it.
      if (source.salesOrderLineId) {
        await client.query(
          `UPDATE sales_order_lines SET quantity_invoiced = quantity_invoiced + $2::numeric
            WHERE id = $1`,
          [source.salesOrderLineId, line.quantity],
        );
      }
    }
  }

  /**
   * Posts an invoice.
   *
   * doc 04's on-post list, in order: allocate the number, freeze the snapshots,
   * create the accounting event, post AR/revenue/tax, update the open-item
   * subledger, emit invoice.posted. All of it in one transaction, because an
   * invoice that is POSTED with no journal is a receivable the ledger has never
   * heard of.
   */
  async postInvoice(principal: TenantPrincipal, id: string) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const invoice = await this.loadInvoice(client, id, { forUpdate: true });
      assertEntityPermission(principal, 'invoice.post', invoice.legal_entity_id as string);

      if (invoice.status === 'POSTED' || invoice.status === 'PARTIALLY_PAID') return invoice;
      if (!DRAFT_STATES.has(invoice.status as string)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `This invoice is ${invoice.status} and cannot be posted.`,
          { details: { status: invoice.status } },
        );
      }

      const book = await this.posting.loadBookContext(
        client,
        principal,
        invoice.accounting_book_id as string,
        invoice.posting_date as string,
      );
      const { calculated, codes, revenueByLine, dimensionsByLine } = await this.reloadLines(
        client,
        invoice,
      );

      const arAccountId = await this.resolveArAccount(client, invoice, book);
      const taxAccounts = new Map<string, string>();
      for (const code of codes.values()) {
        for (const component of code.components) {
          if (code.payableAccountId) taxAccounts.set(component.id, code.payableAccountId);
        }
      }

      const lines = salesInvoiceLines({
        calculated,
        revenueAccountByLine: revenueByLine,
        taxAccountByComponent: taxAccounts,
        arAccountId,
        currency: invoice.currency as string,
        baseCurrency: book.baseCurrency,
        exchangeRate: (invoice.exchange_rate as string) ?? '1',
        exchangeRateDate: (invoice.exchange_rate_date as string) ?? null,
        contactId: invoice.customer_id as string,
        dimensionsByLine,
      });

      const result = await this.documents.post(client, context, principal, book, {
        ruleCode: 'SALES_INVOICE_POSTED',
        sourceType: 'invoice',
        sourceId: id,
        sourceEventId: `invoice.posted:${id}`,
        journalCode: 'SAL',
        postingDate: invoice.posting_date as string,
        documentDate: invoice.document_date as string,
        description: `Invoice ${invoice.invoice_number ?? ''}`.trim(),
        branchId: (invoice.branch_id as string) ?? null,
        contactId: invoice.customer_id as string,
        lines,
        tax: {
          calculated,
          codes,
          direction: 'OUTPUT',
          sign: 1,
          currency: invoice.currency as string,
          exchangeRate: (invoice.exchange_rate as string) ?? '1',
        },
      });

      const invoiceNumber = await this.allocateDocumentNumber(
        client,
        principal,
        invoice.legal_entity_id as string,
        'INVOICE',
      );

      const { rows } = await client.query<Record<string, unknown>>(
        `UPDATE invoices
            SET status = 'POSTED', invoice_number = $2, accounting_entry_id = $3,
                version = version + 1
          WHERE id = $1
          RETURNING id, invoice_number, status::text AS status, total::text AS total,
                    amount_due::text AS amount_due, accounting_entry_id,
                    version::text AS version`,
        [id, invoiceNumber, result.entry.id],
      );

      await publish(client, context, {
        eventType: 'invoice.posted',
        aggregateType: 'invoice',
        aggregateId: id,
        tenantId: principal.tenantId,
        organizationId: book.organizationId,
        legalEntityId: invoice.legal_entity_id as string,
        accountingBookId: book.bookId,
        payload: {
          invoice_number: invoiceNumber,
          customer_id: invoice.customer_id,
          total: invoice.total,
          currency: invoice.currency,
          journal_entry_id: result.entry.id,
          tax_rows: result.taxRowsWritten,
        },
      });
      await recordAudit(client, context, {
        action: 'invoice.posted',
        resourceType: 'invoice',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: invoice.legal_entity_id as string,
        after: { invoice_number: invoiceNumber, journal_entry_id: result.entry.id },
      });

      return {
        ...rows[0],
        journal_entry: { id: result.entry.id, entry_number: result.entry.entry_number },
      };
    });
  }

  /** @internal Shared with SalesService: credit notes, write-offs and refunds all move AR. */
  async resolveArAccount(
    client: PoolClient,
    invoice: Record<string, unknown>,
    book: BookContext,
  ): Promise<string> {
    // doc 04 puts an AR account on the customer; doc 01 puts one on the policy.
    // The customer wins when set, because that is the more specific statement —
    // and doc 01's precedence chain runs from specific to general throughout.
    const { rows } = await client.query<{ ar_account_id: string | null }>(
      `SELECT ar_account_id FROM contacts WHERE id = $1`,
      [invoice.customer_id],
    );
    const fromCustomer = rows[0]?.ar_account_id;
    if (fromCustomer) return fromCustomer;

    const { rows: policy } = await client.query<{ ar_control_account_id: string | null }>(
      `SELECT ar_control_account_id FROM accounting_policies
        WHERE legal_entity_id = $1 AND valid_from <= $2::date
        ORDER BY valid_from DESC LIMIT 1`,
      [book.legalEntityId, invoice.posting_date],
    );
    const fromPolicy = policy[0]?.ar_control_account_id;
    if (fromPolicy) return fromPolicy;

    throw new AppError(
      'VALIDATION_FAILED',
      'No accounts receivable account is configured. Set ar_control_account_id on the ' +
        'accounting policy, or ar_account_id on the customer — an invoice cannot post without ' +
        'somewhere to put the receivable.',
      { details: { legal_entity_id: book.legalEntityId } },
    );
  }

  private async reloadLines(
    client: PoolClient,
    invoice: Record<string, unknown>,
  ): Promise<{
    calculated: CalculatedDocument;
    codes: Map<string, ResolvedTaxCode>;
    revenueByLine: Map<number, string>;
    dimensionsByLine: Map<number, Record<string, string>>;
  }> {
    const { rows } = await client.query<{
      id: string;
      line_no: number;
      description: string;
      quantity: string;
      unit_price: string;
      discount_amount: string;
      revenue_account_id: string;
      tax_code_id: string | null;
      calculation_snapshot: Record<string, unknown> | null;
    }>(
      `SELECT id, line_no, description, quantity::text AS quantity, unit_price::text AS unit_price,
              discount_amount::text AS discount_amount, revenue_account_id, tax_code_id,
              calculation_snapshot
         FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_no`,
      [invoice.id],
    );

    const codes = await this.tax.resolveCodes(
      client,
      invoice.legal_entity_id as string,
      rows.map((r) => r.tax_code_id).filter((id): id is string => Boolean(id)),
      invoice.document_date as string,
    );

    const revenueByLine = new Map<number, string>();
    const dimensionsByLine = new Map<number, Record<string, string>>();
    const documentLines: DocumentLineInput[] = [];

    for (const row of rows) {
      revenueByLine.set(row.line_no, row.revenue_account_id);
      const code = row.tax_code_id ? codes.get(row.tax_code_id) : undefined;
      const inclusive = (row.calculation_snapshot?.inclusive as boolean | undefined) ?? false;
      documentLines.push({
        lineNo: row.line_no,
        description: row.description,
        quantity: row.quantity,
        unitPrice: row.unit_price,
        discountAmount: row.discount_amount,
        ...(code ? { taxCode: { ...code, inclusive } } : {}),
      });

      const { rows: dimensions } = await client.query<{
        dimension_id: string;
        dimension_value_id: string;
      }>(
        `SELECT dimension_id, dimension_value_id FROM document_line_dimensions
          WHERE resource_type = 'invoice_line' AND resource_id = $1`,
        [row.id],
      );
      if (dimensions.length > 0) {
        dimensionsByLine.set(
          row.line_no,
          Object.fromEntries(dimensions.map((d) => [d.dimension_id, d.dimension_value_id])),
        );
      }
    }

    return {
      calculated: calculateDocument(documentLines, { currency: invoice.currency as string }),
      codes,
      revenueByLine,
      dimensionsByLine,
    };
  }

  /** @internal */
  async loadInvoice(
    client: PoolClient,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT id, tenant_id, legal_entity_id, accounting_book_id, branch_id, customer_id,
              sales_order_id, invoice_number, document_date::text AS document_date,
              posting_date::text AS posting_date, due_date::text AS due_date, currency,
              exchange_rate::text AS exchange_rate, exchange_rate_date::text AS exchange_rate_date,
              status::text AS status, subtotal::text AS subtotal,
              discount_total::text AS discount_total, tax_total::text AS tax_total,
              total::text AS total, base_total::text AS base_total,
              amount_paid::text AS amount_paid, amount_credited::text AS amount_credited,
              amount_written_off::text AS amount_written_off, amount_due::text AS amount_due,
              accounting_entry_id, version::text AS version
         FROM invoices WHERE id = $1 ${options.forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    );
    if (!rows[0]) throw notFound('invoice', id);
    return rows[0];
  }

  /** @internal */
  async loadCustomer(client: PoolClient, id: string): Promise<Record<string, unknown>> {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT id, legal_name, default_currency, payment_terms_days,
              credit_limit::text AS credit_limit, ar_account_id, revenue_account_id,
              sales_tax_code_id, status::text AS status
         FROM contacts WHERE id = $1 AND kind IN ('CUSTOMER','BOTH')`,
      [id],
    );
    if (!rows[0]) throw notFound('customer', id);
    if (rows[0].status !== 'ACTIVE') {
      throw new AppError(
        'VALIDATION_FAILED',
        `${rows[0].legal_name} is ${rows[0].status} and cannot be invoiced.`,
      );
    }
    return rows[0];
  }

  /** @internal */
  async resolveRate(
    client: PoolClient,
    currency: string,
    baseCurrency: string,
    supplied: string | undefined,
    on: string,
  ): Promise<string> {
    if (currency === baseCurrency) return '1';
    if (supplied) return supplied;
    const { rows } = await client.query<{ rate: string }>(
      `SELECT rate::text AS rate FROM exchange_rates
        WHERE from_currency = $1 AND to_currency = $2 AND rate_date <= $3::date
        ORDER BY rate_date DESC LIMIT 1`,
      [currency, baseCurrency, on],
    );
    if (!rows[0]) {
      throw new AppError(
        'EXCHANGE_RATE_MISSING',
        `No exchange rate from ${currency} to ${baseCurrency} on or before ${on}. Supply one on ` +
          'the document or load the rate — guessing at a rate would produce a base amount that ' +
          'nothing can reconcile.',
        { details: { from: currency, to: baseCurrency, on } },
      );
    }
    return rows[0].rate;
  }

  /**
   * doc 01: document numbers are gapless and allocated under FOR UPDATE.
   *
   * Resolves (or creates) the sequence and hands the allocation to the ledger's
   * `allocateNumber`. F-726: this file and `ap.service.ts` each carried their own
   * copy of the increment, and both wrote `next_value` — a column that does not
   * exist. The one in `@acct/ledger` has been allocating journal entry numbers
   * since Phase 2 against the real `next_number`, writes the `number_allocations`
   * audit row that doc 02's "voided numbers remain visible in the audit sequence"
   * depends on, and applies the `{YYYY}` reset rules. Three things the copies did
   * not do, for a function nobody needed twice.
   */
  /** @internal Shared with SalesService: quotes, orders, credit notes and refunds number here. */
  async allocateDocumentNumber(
    client: PoolClient,
    principal: TenantPrincipal,
    legalEntityId: string,
    documentType: string,
    resourceId?: string,
  ): Promise<string> {
    const sequenceId = await resolveSequence(client, principal, legalEntityId, documentType);
    const allocated = await allocateNumber(client, {
      sequenceId,
      resourceType: documentType.toLowerCase(),
      resourceId: resourceId ?? uuidv7(),
    });
    return allocated.formatted;
  }

  async listInvoices(
    principal: TenantPrincipal,
    filter: {
      legalEntityId?: string | undefined;
      customerId?: string | undefined;
      status?: string | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT i.id, i.legal_entity_id, i.customer_id, c.legal_name AS customer_name,
                i.invoice_number, i.document_date::text AS document_date,
                i.posting_date::text AS posting_date, i.due_date::text AS due_date,
                i.currency, i.status::text AS status, i.total::text AS total,
                i.amount_paid::text AS amount_paid, i.amount_due::text AS amount_due,
                i.accounting_entry_id, i.version::text AS version
           FROM invoices i
           JOIN contacts c ON c.id = i.customer_id
          WHERE ($1::uuid IS NULL OR i.legal_entity_id = $1)
            AND ($2::uuid IS NULL OR i.customer_id = $2)
            AND ($3::text IS NULL OR i.status::text = $3)
          ORDER BY i.document_date DESC, i.invoice_number DESC
          LIMIT 200`,
        [filter.legalEntityId ?? null, filter.customerId ?? null, filter.status ?? null],
      );
      return { data: rows };
    });
  }

  async getInvoice(principal: TenantPrincipal, id: string) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const invoice = await this.loadInvoice(client, id);
      const { rows: lines } = await client.query(
        `SELECT id, line_no, description, quantity::text AS quantity,
                unit_price::text AS unit_price, discount_amount::text AS discount_amount,
                revenue_account_id, tax_code_id, net_amount::text AS net_amount,
                tax_amount::text AS tax_amount, gross_amount::text AS gross_amount,
                calculation_snapshot
           FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_no`,
        [id],
      );
      // doc 21's drill chain: source document -> accounting event -> journal ->
      // report. This is the second link, and returning the id alone would leave
      // the caller to guess at the third.
      const { rows: entry } = await client.query(
        `SELECT id, entry_number, posting_date::text AS posting_date, status::text AS status
           FROM journal_entries WHERE id = $1`,
        [invoice.accounting_entry_id ?? null],
      );
      const { rows: allocations } = await client.query(
        `SELECT 'RECEIPT' AS kind, a.amount::text AS amount, a.allocated_at,
                r.receipt_number AS reference
           FROM receipt_allocations a
           JOIN customer_receipts r ON r.id = a.customer_receipt_id
          WHERE a.target_type = 'INVOICE' AND a.target_id = $1
          UNION ALL
         SELECT 'CREDIT_NOTE', ca.amount::text, ca.applied_at, cn.credit_note_number
           FROM credit_note_applications ca
           JOIN credit_notes cn ON cn.id = ca.credit_note_id
          WHERE ca.invoice_id = $1
          ORDER BY 3`,
        [id],
      );
      return { ...invoice, lines, journal_entry: entry[0] ?? null, settlements: allocations };
    });
  }

  // =========================================================================
  // Invoice lifecycle — doc 04. DRAFT is the only editable state; everything
  // after posting is corrected by a new document, never by mutation.
  // =========================================================================

  /**
   * Edits a DRAFT invoice by recalculating the whole document.
   *
   * Always the whole document: a header change (document date, discount) moves
   * the tax and the totals, so patching one column while the stored lines keep
   * their old arithmetic would leave an invoice that disagrees with itself.
   * Currency is deliberately not editable — a currency change is a different
   * invoice, not a correction to this one.
   */
  async updateInvoice(
    principal: TenantPrincipal,
    id: string,
    input: {
      documentDate?: string | undefined;
      postingDate?: string | undefined;
      dueDate?: string | undefined;
      exchangeRate?: string | undefined;
      exchangeRateDate?: string | undefined;
      documentDiscount?: string | undefined;
      terms?: string | undefined;
      notes?: string | undefined;
      lines?: readonly InvoiceLineInput[] | undefined;
    },
    expectedVersion: string | null,
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const before = await this.loadInvoice(client, id, { forUpdate: true });
      assertEntityPermission(principal, 'invoice.edit_draft', before.legal_entity_id as string);
      assertInvoiceEditable(before.status as string);
      if (expectedVersion !== null) {
        assertVersion(before.version as string, expectedVersion, 'invoice', id);
      }

      const documentDate = input.documentDate ?? (before.document_date as string);
      const postingDate = input.postingDate ?? (before.posting_date as string);
      const currency = before.currency as string;
      const book = await this.posting.loadBookContext(
        client,
        principal,
        before.accounting_book_id as string,
        postingDate,
      );

      const lines = input.lines ?? (await this.reconstructLineInputs(client, id));
      const { calculated } = await this.calculate(
        client,
        before.legal_entity_id as string,
        currency,
        documentDate,
        lines,
        input.documentDiscount,
      );

      const customer = await this.loadCustomer(client, before.customer_id as string);
      await this.assertCreditLimit(client, customer, calculated.total, currency, book);

      // Unwind before rewrite: the order's invoiced quantity and the dimension
      // rows both point at lines that are about to be replaced.
      const { rows: oldLines } = await client.query<{
        id: string;
        sales_order_line_id: string | null;
        quantity: string;
      }>(
        `SELECT id, sales_order_line_id, quantity::text AS quantity
           FROM invoice_lines WHERE invoice_id = $1`,
        [id],
      );
      for (const line of oldLines) {
        if (line.sales_order_line_id) {
          await client.query(
            `UPDATE sales_order_lines SET quantity_invoiced = quantity_invoiced - $2::numeric
              WHERE id = $1`,
            [line.sales_order_line_id, line.quantity],
          );
        }
        await client.query(
          `DELETE FROM document_line_dimensions
            WHERE resource_type = 'invoice_line' AND resource_id = $1`,
          [line.id],
        );
      }
      await client.query(`DELETE FROM invoice_lines WHERE invoice_id = $1`, [id]);

      const exchangeRate =
        input.exchangeRate ??
        (currency === book.baseCurrency ? '1' : ((before.exchange_rate as string) ?? '1'));

      const { rows } = await client.query<Record<string, unknown>>(
        `UPDATE invoices
            SET document_date = $2::date, posting_date = $3::date, due_date = $4::date,
                exchange_rate = $5::numeric, exchange_rate_date = $6::date,
                subtotal = $7::numeric, discount_total = $8::numeric, tax_total = $9::numeric,
                total = $10::numeric, base_total = $11::numeric, amount_due = $10::numeric,
                terms = coalesce($12, terms), notes = coalesce($13, notes),
                version = version + 1
          WHERE id = $1
          RETURNING id, legal_entity_id, customer_id, document_date::text AS document_date,
                    posting_date::text AS posting_date, due_date::text AS due_date, currency,
                    exchange_rate::text AS exchange_rate, status::text AS status,
                    subtotal::text AS subtotal, discount_total::text AS discount_total,
                    tax_total::text AS tax_total, total::text AS total,
                    amount_due::text AS amount_due, terms, notes, version::text AS version`,
        [
          id,
          documentDate,
          postingDate,
          input.dueDate ?? (before.due_date as string | null),
          exchangeRate,
          input.exchangeRateDate ?? postingDate,
          calculated.subtotal,
          calculated.discountTotal,
          calculated.taxTotal,
          calculated.total,
          toBase(calculated.total, exchangeRate, currency, book.baseCurrency),
          input.terms ?? null,
          input.notes ?? null,
        ],
      );

      await this.writeInvoiceLines(client, principal, {
        invoiceId: id,
        legalEntityId: before.legal_entity_id as string,
        calculated,
        inputs: lines,
      });

      await recordAudit(client, context, {
        action: 'invoice.updated',
        resourceType: 'invoice',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: before.legal_entity_id as string,
        before,
        after: rows[0] as Record<string, unknown>,
      });

      return { ...rows[0], lines: calculated.lines };
    });
  }

  /**
   * Rebuilds `InvoiceLineInput`s from the stored draft lines, so a header-only
   * PATCH recalculates through exactly the code path a full edit uses.
   */
  private async reconstructLineInputs(
    client: PoolClient,
    invoiceId: string,
  ): Promise<InvoiceLineInput[]> {
    const { rows } = await client.query<{
      id: string;
      line_no: number;
      description: string;
      quantity: string;
      unit_price: string;
      discount_amount: string;
      revenue_account_id: string;
      tax_code_id: string | null;
      sales_order_line_id: string | null;
      calculation_snapshot: Record<string, unknown> | null;
    }>(
      `SELECT id, line_no, description, quantity::text AS quantity,
              unit_price::text AS unit_price, discount_amount::text AS discount_amount,
              revenue_account_id, tax_code_id, sales_order_line_id, calculation_snapshot
         FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_no`,
      [invoiceId],
    );

    const inputs: InvoiceLineInput[] = [];
    for (const row of rows) {
      const { rows: dims } = await client.query<{
        dimension_id: string;
        dimension_value_id: string;
      }>(
        `SELECT dimension_id, dimension_value_id FROM document_line_dimensions
          WHERE resource_type = 'invoice_line' AND resource_id = $1`,
        [row.id],
      );
      inputs.push({
        lineNo: row.line_no,
        description: row.description,
        quantity: row.quantity,
        unitPrice: row.unit_price,
        discountAmount: row.discount_amount,
        revenueAccountId: row.revenue_account_id,
        ...(row.tax_code_id ? { taxCodeId: row.tax_code_id } : {}),
        ...(row.calculation_snapshot?.inclusive !== undefined
          ? { inclusive: row.calculation_snapshot.inclusive as boolean }
          : {}),
        ...(row.sales_order_line_id ? { salesOrderLineId: row.sales_order_line_id } : {}),
        ...(dims.length > 0
          ? {
              dimensions: Object.fromEntries(
                dims.map((d) => [d.dimension_id, d.dimension_value_id]),
              ),
            }
          : {}),
      });
    }
    return inputs;
  }

  async approveInvoice(principal: TenantPrincipal, id: string) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const invoice = await this.loadInvoice(client, id, { forUpdate: true });
      assertEntityPermission(principal, 'invoice.approve', invoice.legal_entity_id as string);

      if (invoice.status === 'APPROVED') return invoice;
      if (invoice.status !== 'DRAFT' && invoice.status !== 'PENDING_APPROVAL') {
        throw new AppError(
          'VALIDATION_FAILED',
          `This invoice is ${invoice.status}; approval is a step between draft and posting.`,
          { details: { status: invoice.status } },
        );
      }

      const { rows } = await client.query<Record<string, unknown>>(
        `UPDATE invoices
            SET status = 'APPROVED', approval_state = 'APPROVED', version = version + 1
          WHERE id = $1
          RETURNING id, status::text AS status, approval_state::text AS approval_state,
                    version::text AS version`,
        [id],
      );

      await publish(client, context, {
        eventType: 'invoice.approved',
        aggregateType: 'invoice',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: invoice.legal_entity_id as string,
        payload: { customer_id: invoice.customer_id, total: invoice.total },
      });
      await recordAudit(client, context, {
        action: 'invoice.approved',
        resourceType: 'invoice',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: invoice.legal_entity_id as string,
        after: rows[0] as Record<string, unknown>,
      });
      return { ...invoice, ...rows[0] };
    });
  }

  /**
   * Marks a posted invoice sent. Posted, because sending allocates nothing and
   * proves nothing — but an unposted invoice has no number, and a numberless
   * document in a customer's inbox is not one this system can stand behind.
   *
   * doc 04 treats the send as evidence, and "we sent it" without "to whom" is
   * not evidence — so every send appends who it went to, in the row's metadata
   * and in the audit trail. Every send, not only the first: a resend to a new
   * address is a new fact a collections dispute will ask about.
   */
  async sendInvoice(
    principal: TenantPrincipal,
    id: string,
    input: { to?: readonly string[] | undefined; note?: string | undefined },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const invoice = await this.loadInvoice(client, id, { forUpdate: true });
      assertEntityPermission(principal, 'invoice.send', invoice.legal_entity_id as string);

      if (!['POSTED', 'PARTIALLY_PAID', 'PAID'].includes(invoice.status as string)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `This invoice is ${invoice.status}. Post it first — an unposted invoice has no ` +
            'invoice number, and the number is what the customer pays against.',
          { details: { status: invoice.status } },
        );
      }

      const send = {
        to: input.to ?? [],
        note: input.note ?? null,
        by: principal.userId,
        at: new Date().toISOString(),
      };
      const { rows } = await client.query<Record<string, unknown>>(
        `UPDATE invoices
            SET sent_at = now(),
                metadata = jsonb_set(metadata, '{sends}',
                                     coalesce(metadata->'sends', '[]'::jsonb) || $2::jsonb)
          WHERE id = $1
          RETURNING id, invoice_number, status::text AS status, sent_at,
                    metadata->'sends' AS sends`,
        [id, JSON.stringify([send])],
      );

      await publish(client, context, {
        eventType: 'invoice.sent',
        aggregateType: 'invoice',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: invoice.legal_entity_id as string,
        payload: {
          invoice_number: invoice.invoice_number,
          customer_id: invoice.customer_id,
          to: send.to,
          note: send.note,
        },
      });
      await recordAudit(client, context, {
        action: 'invoice.sent',
        resourceType: 'invoice',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: invoice.legal_entity_id as string,
        after: { invoice_number: invoice.invoice_number, to: send.to, note: send.note },
      });
      return { ...invoice, ...rows[0] };
    });
  }

  /**
   * doc 04's cancel path, split by what the invoice has become.
   *
   * A draft never reached the ledger, so VOID is a status change and nothing
   * more. A posted, untouched invoice is an accounting fact, so it is reversed
   * by a credit note built from ITS OWN stored calculation — the exact figures
   * its journal was posted from — and applied in full, in one transaction. A
   * partially settled invoice is refused: what remains open is a decision about
   * amounts, which is `createCreditNote`'s job, not a void's.
   */
  async voidOrCreditInvoice(
    principal: TenantPrincipal,
    id: string,
    input: { reason: string; postingDate?: string | undefined },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const invoice = await this.loadInvoice(client, id, { forUpdate: true });
      assertEntityPermission(principal, 'invoice.void', invoice.legal_entity_id as string);

      if (DRAFT_STATES.has(invoice.status as string)) {
        const { rows } = await client.query<Record<string, unknown>>(
          `UPDATE invoices SET status = 'VOID', version = version + 1
            WHERE id = $1
            RETURNING id, status::text AS status, version::text AS version`,
          [id],
        );
        await recordAudit(client, context, {
          action: 'invoice.voided',
          resourceType: 'invoice',
          resourceId: id,
          tenantId: principal.tenantId,
          legalEntityId: invoice.legal_entity_id as string,
          before: invoice,
          after: { ...(rows[0] as Record<string, unknown>), reason: input.reason },
        });
        return { outcome: 'VOIDED', invoice: { ...invoice, ...rows[0] } };
      }

      if (invoice.status !== 'POSTED') {
        throw new AppError(
          'VALIDATION_FAILED',
          `This invoice is ${invoice.status} and cannot be voided or fully credited here.`,
          { details: { status: invoice.status } },
        );
      }
      const untouched =
        D((invoice.amount_paid as string) ?? '0').isZero() &&
        D((invoice.amount_credited as string) ?? '0').isZero() &&
        D((invoice.amount_written_off as string) ?? '0').isZero();
      if (!untouched) {
        throw new AppError(
          'VALIDATION_FAILED',
          'This invoice is partially settled. How much of the remainder to credit is an ' +
            'amount decision — raise a credit note for it with createCreditNote and apply it, ' +
            'rather than voiding history a payment has already touched.',
          {
            details: {
              amount_paid: invoice.amount_paid,
              amount_credited: invoice.amount_credited,
              amount_written_off: invoice.amount_written_off,
            },
          },
        );
      }

      const postingDate = input.postingDate ?? (invoice.posting_date as string);
      const book = await this.posting.loadBookContext(
        client,
        principal,
        invoice.accounting_book_id as string,
        postingDate,
      );
      const { calculated, codes, revenueByLine, dimensionsByLine } = await this.reloadLines(
        client,
        invoice,
      );

      // The credit note's lines are copies of the invoice's, with the link back,
      // so the reversal explains itself line by line.
      const creditNoteId = uuidv7();
      await client.query(
        `INSERT INTO credit_notes (id, tenant_id, legal_entity_id, accounting_book_id, branch_id,
                                   customer_id, invoice_id, document_date, posting_date, currency,
                                   exchange_rate, subtotal, tax_total, total, amount_applied,
                                   amount_available, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9::date,$10,$11::numeric,$12::numeric,
                 $13::numeric,$14::numeric,0,$14::numeric,$15)`,
        [
          creditNoteId,
          principal.tenantId,
          invoice.legal_entity_id,
          invoice.accounting_book_id,
          invoice.branch_id ?? null,
          invoice.customer_id,
          id,
          invoice.document_date,
          postingDate,
          invoice.currency,
          invoice.exchange_rate ?? null,
          calculated.subtotal,
          calculated.taxTotal,
          calculated.total,
          input.reason,
        ],
      );
      const { rows: sourceLines } = await client.query<Record<string, unknown>>(
        `SELECT id, line_no, description, quantity::text AS quantity,
                unit_price::text AS unit_price, revenue_account_id, tax_code_id,
                net_amount::text AS net_amount, tax_amount::text AS tax_amount,
                gross_amount::text AS gross_amount
           FROM invoice_lines WHERE invoice_id = $1 ORDER BY line_no`,
        [id],
      );
      for (const line of sourceLines) {
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
            invoice.legal_entity_id,
            line.line_no,
            line.id,
            line.description,
            line.quantity,
            line.unit_price,
            line.revenue_account_id,
            line.tax_code_id,
            line.net_amount,
            line.tax_amount,
            line.gross_amount,
          ],
        );
      }

      const creditNote = {
        id: creditNoteId,
        legal_entity_id: invoice.legal_entity_id,
        accounting_book_id: invoice.accounting_book_id,
        branch_id: invoice.branch_id ?? null,
        customer_id: invoice.customer_id,
        invoice_id: id,
        document_date: invoice.document_date,
        posting_date: postingDate,
        currency: invoice.currency,
        exchange_rate: invoice.exchange_rate ?? null,
        total: calculated.total,
        amount_available: calculated.total,
        status: 'DRAFT',
      } as Record<string, unknown>;

      const posted = await this.postCreditNoteFromCalculated(
        client,
        context,
        principal,
        book,
        creditNote,
        calculated,
        codes,
        revenueByLine,
        dimensionsByLine,
      );

      const application = await this.applyCreditNoteInTransaction(
        client,
        context,
        principal,
        { ...creditNote, status: 'POSTED' },
        book.baseCurrency,
        [{ invoiceId: id, amount: calculated.total }],
      );

      await recordAudit(client, context, {
        action: 'invoice.voided_by_credit',
        resourceType: 'invoice',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: invoice.legal_entity_id as string,
        before: invoice,
        after: { credit_note_id: creditNoteId, reason: input.reason },
      });

      return {
        outcome: 'CREDITED',
        credit_note: posted.credit_note,
        journal_entry: { id: posted.entry.id, entry_number: posted.entry.entry_number },
        invoice: application.targets[0] ?? null,
      };
    });
  }

  // =========================================================================
  // Credit note internals — shared with SalesService so the manual credit path
  // and the void-by-credit path cannot drift apart.
  // =========================================================================

  /**
   * @internal Posts a credit note from an already-built calculation.
   *
   * The lines are `salesInvoiceLines` with `sign: -1` — the same builder the
   * invoice posted through, so the credit journal is the invoice journal
   * mirrored, by construction rather than by review.
   */
  async postCreditNoteFromCalculated(
    client: PoolClient,
    context: RequestContext,
    principal: TenantPrincipal,
    book: BookContext,
    creditNote: Record<string, unknown>,
    calculated: CalculatedDocument,
    codes: Map<string, ResolvedTaxCode>,
    revenueByLine: Map<number, string>,
    dimensionsByLine?: Map<number, Record<string, string>>,
  ) {
    const arAccountId = await this.resolveArAccount(
      client,
      { customer_id: creditNote.customer_id, posting_date: creditNote.posting_date },
      book,
    );
    const taxAccounts = new Map<string, string>();
    for (const code of codes.values()) {
      for (const component of code.components) {
        if (code.payableAccountId) taxAccounts.set(component.id, code.payableAccountId);
      }
    }

    const exchangeRate = (creditNote.exchange_rate as string | null) ?? '1';
    const lines = salesInvoiceLines({
      calculated,
      revenueAccountByLine: revenueByLine,
      taxAccountByComponent: taxAccounts,
      arAccountId,
      currency: creditNote.currency as string,
      baseCurrency: book.baseCurrency,
      exchangeRate,
      exchangeRateDate: null,
      contactId: creditNote.customer_id as string,
      ...(dimensionsByLine ? { dimensionsByLine } : {}),
      sign: -1,
    });

    const result = await this.documents.post(client, context, principal, book, {
      ruleCode: 'SALES_CREDIT_NOTE',
      sourceType: 'credit_note',
      sourceId: creditNote.id as string,
      sourceEventId: `credit_note.posted:${creditNote.id}`,
      journalCode: 'SAL',
      postingDate: creditNote.posting_date as string,
      documentDate: creditNote.document_date as string,
      description: `Credit note against ${creditNote.invoice_id ?? 'customer account'}`,
      branchId: (creditNote.branch_id as string) ?? null,
      contactId: creditNote.customer_id as string,
      lines,
      tax: {
        calculated,
        codes,
        direction: 'OUTPUT',
        sign: -1,
        currency: creditNote.currency as string,
        exchangeRate,
      },
    });

    const creditNoteNumber = await this.allocateDocumentNumber(
      client,
      principal,
      creditNote.legal_entity_id as string,
      'CREDIT_NOTE',
    );
    const { rows } = await client.query<Record<string, unknown>>(
      `UPDATE credit_notes
          SET status = 'POSTED', credit_note_number = $2, accounting_entry_id = $3
        WHERE id = $1
        RETURNING id, credit_note_number, customer_id, invoice_id, currency,
                  status::text AS status, total::text AS total,
                  amount_applied::text AS amount_applied,
                  amount_available::text AS amount_available, accounting_entry_id`,
      [creditNote.id, creditNoteNumber, result.entry.id],
    );

    await publish(client, context, {
      eventType: 'credit_note.posted',
      aggregateType: 'credit_note',
      aggregateId: creditNote.id as string,
      tenantId: principal.tenantId,
      organizationId: book.organizationId,
      legalEntityId: creditNote.legal_entity_id as string,
      accountingBookId: book.bookId,
      payload: {
        credit_note_number: creditNoteNumber,
        customer_id: creditNote.customer_id,
        invoice_id: creditNote.invoice_id ?? null,
        total: calculated.total,
        currency: creditNote.currency,
        journal_entry_id: result.entry.id,
        tax_rows: result.taxRowsWritten,
      },
    });
    await recordAudit(client, context, {
      action: 'credit_note.posted',
      resourceType: 'credit_note',
      resourceId: creditNote.id as string,
      tenantId: principal.tenantId,
      legalEntityId: creditNote.legal_entity_id as string,
      after: rows[0] as Record<string, unknown>,
    });

    return { credit_note: rows[0] as Record<string, unknown>, entry: result.entry };
  }

  /**
   * @internal Applies available credit to open invoices, ADR-0004's protocol:
   * source already locked by the caller, targets locked in ascending id order,
   * validation over the whole request set — two applications that each fit and
   * together do not are one refusal, not two acceptances.
   */
  async applyCreditNoteInTransaction(
    client: PoolClient,
    context: RequestContext,
    principal: TenantPrincipal,
    creditNote: Record<string, unknown>,
    baseCurrency: string,
    applications: readonly CreditApplicationInput[],
  ) {
    if (creditNote.status !== 'POSTED') {
      throw new AppError(
        'VALIDATION_FAILED',
        `This credit note is ${creditNote.status}; only a posted credit note has credit to apply.`,
        { details: { status: creditNote.status } },
      );
    }
    const currency = creditNote.currency as string;
    const requests = creditApplicationRequests(applications);
    const targets = await lockTargets(client, principal, requests);

    // A credit belongs to a customer; applying it across customers would settle
    // one customer's invoice with another's money and both statements would lie.
    for (const target of targets.values()) {
      const { rows } = await client.query<{ customer_id: string }>(
        `SELECT customer_id FROM invoices WHERE id = $1`,
        [target.id],
      );
      if (rows[0] && rows[0].customer_id !== creditNote.customer_id) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Invoice ${target.id} belongs to a different customer than this credit note.`,
          { details: { invoice_id: target.id } },
        );
      }
    }

    validateAllocations({
      sourceUnapplied: (creditNote.amount_available as string) ?? '0',
      sourceCurrency: currency,
      requests,
      targets,
      documentLabel: (t) => `invoice ${t.id}`,
    });

    let applied = Money.zero(currency);
    const outcomes: Array<Record<string, unknown>> = [];
    for (const request of requests) {
      const target = targets.get(request.targetId)!;
      await client.query(
        `INSERT INTO credit_note_applications (id, tenant_id, credit_note_id, invoice_id, amount,
                                               base_amount, applied_by, accounting_entry_id)
         VALUES ($1,$2,$3,$4,$5::numeric,$6::numeric,$7,$8)`,
        [
          uuidv7(),
          principal.tenantId,
          creditNote.id,
          request.targetId,
          request.amount,
          toBase(
            request.amount,
            (creditNote.exchange_rate as string | null) ?? '1',
            currency,
            baseCurrency,
          ),
          principal.userId,
          creditNote.accounting_entry_id ?? null,
        ],
      );
      const outcome = await applyToTarget(client, target, request.amount, 'amount_credited');
      applied = applied.add(Money.of(D(request.amount), currency));
      outcomes.push({ invoice_id: request.targetId, ...outcome });

      await publish(client, context, {
        eventType: outcome.settled ? 'invoice.paid' : 'invoice.partially_paid',
        aggregateType: 'invoice',
        aggregateId: request.targetId,
        tenantId: principal.tenantId,
        legalEntityId: target.legalEntityId,
        payload: { credited: request.amount, credit_note_id: creditNote.id },
      });
    }

    // OLD-row semantics, same as applyToTarget: amount_applied on the right of
    // the derivation still holds its pre-increment value.
    const { rows } = await client.query<Record<string, unknown>>(
      `UPDATE credit_notes
          SET amount_applied  = amount_applied + $2::numeric,
              amount_available = total - (amount_applied + $2::numeric)
        WHERE id = $1
        RETURNING id, credit_note_number, amount_applied::text AS amount_applied,
                  amount_available::text AS amount_available, status::text AS status`,
      [creditNote.id, applied.toString()],
    );
    await recordAudit(client, context, {
      action: 'credit_note.applied',
      resourceType: 'credit_note',
      resourceId: creditNote.id as string,
      tenantId: principal.tenantId,
      legalEntityId: creditNote.legal_entity_id as string,
      after: { applied: applied.toString(), invoices: outcomes },
    });

    return {
      credit_note: rows[0] as Record<string, unknown>,
      applied: applied.toString(),
      targets: outcomes,
    };
  }

  // =========================================================================
  // Receipts and allocation
  // =========================================================================

  /**
   * Records a customer receipt and posts it.
   *
   * Posting rule catalog, CUSTOMER_RECEIPT: Dr bank/cash, Cr AR for the
   * allocated amount, Cr customer advances for the unapplied remainder. The
   * unapplied half matters — doc 04's acceptance criterion is that
   * "overpayment/unapplied funds remain visible and controlled", and crediting
   * the whole receipt to AR would hide it inside the control account.
   */
  async createReceipt(
    principal: TenantPrincipal,
    input: {
      accountingBookId: string;
      customerId: string;
      documentDate: string;
      postingDate: string;
      currency?: string | undefined;
      amount: string;
      exchangeRate?: string | undefined;
      bankAccountId?: string | undefined;
      depositAccountId?: string | undefined;
      paymentMethod?: string | undefined;
      source?: string | undefined;
      externalReference?: string | undefined;
      allocations?: readonly AllocationRequest[] | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const book = await this.posting.loadBookContext(
        client,
        principal,
        input.accountingBookId,
        input.postingDate,
      );
      assertEntityPermission(principal, 'customer_receipt.create', book.legalEntityId);

      const customer = await this.loadCustomer(client, input.customerId);
      const currency =
        input.currency ?? (customer.default_currency as string | null) ?? book.baseCurrency;
      const rate = await this.resolveRate(
        client,
        currency,
        book.baseCurrency,
        input.exchangeRate,
        input.postingDate,
      );

      const receiptId = uuidv7();
      const receiptNumber = await this.allocateDocumentNumber(
        client,
        principal,
        book.legalEntityId,
        'RECEIPT',
      );

      await client.query(
        `INSERT INTO customer_receipts (id, tenant_id, legal_entity_id, accounting_book_id,
                                        customer_id, receipt_number, document_date, posting_date,
                                        currency, amount, exchange_rate, exchange_rate_date,
                                        base_amount, unapplied_amount, bank_account_id,
                                        payment_method, source, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9,$10::numeric,$11::numeric,$8::date,
                 $12::numeric,$10::numeric,$13,$14,coalesce($15,'MANUAL'),'DRAFT')`,
        [
          receiptId,
          principal.tenantId,
          book.legalEntityId,
          book.bookId,
          input.customerId,
          receiptNumber,
          input.documentDate,
          input.postingDate,
          currency,
          input.amount,
          rate,
          toBase(input.amount, rate, currency, book.baseCurrency),
          input.bankAccountId ?? null,
          input.paymentMethod ?? null,
          input.source ?? null,
        ],
      );

      const allocated = input.allocations?.length
        ? await this.allocateInternal(
            client,
            context,
            principal,
            book,
            receiptId,
            input.allocations,
          )
        : { total: '0', realizedFx: '0', count: 0, entries: [] as SettlementAllocation[] };

      const unapplied = Money.of(D(input.amount), currency)
        .sub(Money.of(D(allocated.total), currency))
        .toString();

      const depositAccountId = await this.resolveDepositAccount(
        client,
        book,
        input.depositAccountId,
        input.postingDate,
      );
      const arAccountId = await this.resolveArAccount(
        client,
        { customer_id: input.customerId, posting_date: input.postingDate },
        book,
      );
      const advanceAccountId = await this.policyAccount(
        client,
        book.legalEntityId,
        'customer_advance_account_id',
        input.postingDate,
      );

      const lines: DraftLineInput[] = [
        {
          accountId: depositAccountId,
          description: `Receipt ${receiptNumber}`,
          debit: input.amount,
          transactionCurrency: currency,
          exchangeRate: rate,
        },
      ];
      if (!D(allocated.total).isZero()) {
        lines.push({
          accountId: arAccountId,
          description: 'Accounts receivable',
          credit: allocated.total,
          contactId: input.customerId,
          transactionCurrency: currency,
          exchangeRate: rate,
        });
      }
      if (!D(unapplied).isZero()) {
        if (!advanceAccountId) {
          throw new AppError(
            'VALIDATION_FAILED',
            `This receipt leaves ${unapplied} ${currency} unapplied and no customer advance ` +
              'account is configured. An unapplied receipt credited to AR disappears into the ' +
              'control account, which is what doc 04 asks to remain visible — set ' +
              'customer_advance_account_id on the accounting policy.',
            { details: { unapplied } },
          );
        }
        lines.push({
          accountId: advanceAccountId,
          description: 'Customer advance',
          credit: unapplied,
          contactId: input.customerId,
          transactionCurrency: currency,
          exchangeRate: rate,
        });
      }
      // The AR credit above relieved the control at the SETTLEMENT rate; any
      // invoice booked at a different rate needs the difference recognized as
      // realized FX (ADR-0007), or the base residue sits in AR forever with no
      // open item explaining it. Amounts are zeroed because the split above
      // already moved the money — only the rate difference remains.
      const fxAccounts = await this.resolveSettlementAccounts(
        client,
        book.legalEntityId,
        input.postingDate,
        allocated.entries,
      );
      lines.push(
        ...settlementPostingLines({
          side: 'AR',
          controlAccountId: arAccountId,
          advanceAccountId,
          realizedFxGainAccountId: fxAccounts.gain,
          realizedFxLossAccountId: fxAccounts.loss,
          contactId: input.customerId,
          currency,
          baseCurrency: book.baseCurrency,
          settlementRate: rate,
          allocations: allocated.entries.map((entry) => ({ ...entry, amount: '0' })),
        }),
      );

      const result = await this.documents.post(client, context, principal, book, {
        ruleCode: 'CUSTOMER_RECEIPT',
        sourceType: 'customer_receipt',
        sourceId: receiptId,
        sourceEventId: `customer_receipt.posted:${receiptId}`,
        journalCode: 'BNK',
        postingDate: input.postingDate,
        documentDate: input.documentDate,
        description: `Receipt ${receiptNumber}`,
        branchId: null,
        contactId: input.customerId,
        lines,
      });

      // doc 21's drill chain: the allocation rows point at the journal that
      // accounts for them, which for a creation-time allocation is the
      // receipt's own posting.
      if (allocated.count > 0) {
        await client.query(
          `UPDATE receipt_allocations SET accounting_entry_id = $2 WHERE customer_receipt_id = $1`,
          [receiptId, result.entry.id],
        );
      }

      const { rows } = await client.query<Record<string, unknown>>(
        `UPDATE customer_receipts
            SET status = 'POSTED', accounting_entry_id = $2, allocated_amount = $3::numeric,
                unapplied_amount = amount - $3::numeric
          WHERE id = $1
          RETURNING id, receipt_number, customer_id, currency, amount::text AS amount,
                    allocated_amount::text AS allocated_amount,
                    unapplied_amount::text AS unapplied_amount, status::text AS status,
                    accounting_entry_id`,
        [receiptId, result.entry.id, allocated.total],
      );

      await publish(client, context, {
        eventType: 'customer_receipt.posted',
        aggregateType: 'customer_receipt',
        aggregateId: receiptId,
        tenantId: principal.tenantId,
        organizationId: book.organizationId,
        legalEntityId: book.legalEntityId,
        accountingBookId: book.bookId,
        payload: {
          receipt_number: receiptNumber,
          amount: input.amount,
          allocated: allocated.total,
          unapplied,
          journal_entry_id: result.entry.id,
        },
      });

      return { ...rows[0], allocations: allocated.count, realized_fx: allocated.realizedFx };
    });
  }

  async listReceipts(
    principal: TenantPrincipal,
    filter: {
      legalEntityId?: string | undefined;
      customerId?: string | undefined;
      status?: string | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT r.id, r.legal_entity_id, r.customer_id, c.legal_name AS customer_name,
                r.receipt_number, r.document_date::text AS document_date,
                r.posting_date::text AS posting_date, r.currency, r.amount::text AS amount,
                r.allocated_amount::text AS allocated_amount,
                r.unapplied_amount::text AS unapplied_amount, r.payment_method, r.source,
                r.status::text AS status, r.accounting_entry_id, r.external_reference
           FROM customer_receipts r
           JOIN contacts c ON c.id = r.customer_id
          WHERE ($1::uuid IS NULL OR r.legal_entity_id = $1)
            AND ($2::uuid IS NULL OR r.customer_id = $2)
            AND ($3::text IS NULL OR r.status::text = $3)
          ORDER BY r.document_date DESC, r.receipt_number DESC
          LIMIT 200`,
        [filter.legalEntityId ?? null, filter.customerId ?? null, filter.status ?? null],
      );
      return { data: rows };
    });
  }

  /**
   * doc 04's allocate command, and Gate G's "two receipts allocated to last
   * invoice balance" test.
   */
  async allocateReceipt(
    principal: TenantPrincipal,
    id: string,
    allocations: readonly AllocationRequest[],
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `SELECT id, legal_entity_id, accounting_book_id, customer_id, receipt_number, currency,
                amount::text AS amount, allocated_amount::text AS allocated_amount,
                unapplied_amount::text AS unapplied_amount, document_date::text AS document_date,
                posting_date::text AS posting_date,
                exchange_rate::text AS exchange_rate, status::text AS status
           FROM customer_receipts WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const receipt = rows[0];
      if (!receipt) throw notFound('customer receipt', id);
      assertEntityPermission(
        principal,
        'customer_receipt.allocate',
        receipt.legal_entity_id as string,
      );

      const book = await this.posting.loadBookContext(
        client,
        principal,
        receipt.accounting_book_id as string,
        receipt.posting_date as string,
      );
      const result = await this.allocateInternal(
        client,
        context,
        principal,
        book,
        id,
        allocations,
        receipt,
      );

      // The subledger just moved; the ledger must move with it, in the same
      // transaction. The cash was credited to customer advances when the
      // receipt posted, so applying it now is a reclassification onto AR —
      // plus the realized FX the settlement crystallised. Leaving this out is
      // the defect this method used to have: the invoice reads paid while the
      // advance stays outstanding and AR stays unreduced.
      let journalEntry: { id: string; entry_number: unknown } | null = null;
      if (result.entries.length > 0) {
        const arAccountId = await this.resolveArAccount(
          client,
          { customer_id: receipt.customer_id, posting_date: receipt.posting_date },
          book,
        );
        const advanceAccountId = await this.policyAccount(
          client,
          book.legalEntityId,
          'customer_advance_account_id',
          receipt.posting_date as string,
        );
        const fxAccounts = await this.resolveSettlementAccounts(
          client,
          book.legalEntityId,
          receipt.posting_date as string,
          result.entries,
        );
        const lines = settlementPostingLines({
          side: 'AR',
          controlAccountId: arAccountId,
          advanceAccountId,
          realizedFxGainAccountId: fxAccounts.gain,
          realizedFxLossAccountId: fxAccounts.loss,
          contactId: receipt.customer_id as string,
          currency: receipt.currency as string,
          baseCurrency: book.baseCurrency,
          settlementRate: (receipt.exchange_rate as string) ?? '1',
          allocations: result.entries,
        });
        if (lines.length > 0) {
          // The allocation row ids are fresh uuidv7s minted by THIS call, so the
          // smallest of them names this batch and no other: the kernel replays a
          // retried posting of the same batch and can never dedupe away the next
          // allocation against the same receipt.
          const batchId = result.entries.map((entry) => entry.allocationId).sort()[0]!;
          const posted = await this.documents.post(client, context, principal, book, {
            ruleCode: 'CUSTOMER_RECEIPT_ALLOCATED',
            sourceType: 'customer_receipt',
            sourceId: id,
            sourceEventId: `customer_receipt.allocated:${id}:${batchId}`,
            journalCode: 'GEN',
            postingDate: receipt.posting_date as string,
            documentDate: (receipt.document_date as string) ?? (receipt.posting_date as string),
            description: `Receipt ${receipt.receipt_number ?? id} allocation`,
            branchId: null,
            contactId: receipt.customer_id as string,
            lines,
          });
          await client.query(
            `UPDATE receipt_allocations SET accounting_entry_id = $2 WHERE id = ANY($1::uuid[])`,
            [result.entries.map((entry) => entry.allocationId), posted.entry.id],
          );
          journalEntry = { id: posted.entry.id, entry_number: posted.entry.entry_number };
        }
      }

      const { rows: updated } = await client.query<Record<string, unknown>>(
        `UPDATE customer_receipts
            SET allocated_amount = allocated_amount + $2::numeric,
                unapplied_amount = amount - (allocated_amount + $2::numeric)
          WHERE id = $1
          RETURNING id, receipt_number, allocated_amount::text AS allocated_amount,
                    unapplied_amount::text AS unapplied_amount`,
        [id, result.total],
      );

      await publish(client, context, {
        eventType: 'customer_receipt.allocated',
        aggregateType: 'customer_receipt',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: receipt.legal_entity_id as string,
        payload: {
          allocated: result.total,
          targets: result.count,
          realized_fx: result.realizedFx,
          journal_entry_id: journalEntry?.id ?? null,
        },
      });

      return {
        ...updated[0],
        allocated_now: result.total,
        realized_fx: result.realizedFx,
        journal_entry: journalEntry,
      };
    });
  }

  private async allocateInternal(
    client: PoolClient,
    context: RequestContext,
    principal: TenantPrincipal,
    book: BookContext,
    receiptId: string,
    allocations: readonly AllocationRequest[],
    preloaded?: Record<string, unknown>,
  ): Promise<{
    total: string;
    realizedFx: string;
    count: number;
    entries: SettlementAllocation[];
  }> {
    const receipt =
      preloaded ??
      (
        await client.query<Record<string, unknown>>(
          `SELECT id, currency, amount::text AS amount,
                  unapplied_amount::text AS unapplied_amount,
                  exchange_rate::text AS exchange_rate
             FROM customer_receipts WHERE id = $1 FOR UPDATE`,
          [receiptId],
        )
      ).rows[0]!;

    const currency = receipt.currency as string;
    const targets = await lockTargets(client, principal, allocations);
    validateAllocations({
      sourceUnapplied: (receipt.unapplied_amount as string) ?? (receipt.amount as string),
      sourceCurrency: currency,
      requests: allocations,
      targets,
      documentLabel: (t) => `${t.kind === 'INVOICE' ? 'invoice' : 'credit note'} ${t.id}`,
    });

    let total = Money.zero(currency);
    let fxTotal = Money.zero(book.baseCurrency);
    const entries: SettlementAllocation[] = [];

    for (const request of allocations) {
      const target = targets.get(request.targetId)!;
      const allocation = await recordAllocation(client, principal, {
        table: 'receipt_allocations',
        sourceColumn: 'customer_receipt_id',
        sourceId: receiptId,
        target,
        amount: request.amount,
        settlementRate: (receipt.exchange_rate as string) ?? '1',
        baseCurrency: book.baseCurrency,
      });
      await applyToTarget(client, target, request.amount, 'amount_paid');
      total = total.add(Money.of(D(request.amount), currency));
      fxTotal = fxTotal.add(Money.of(D(allocation.realizedFx), book.baseCurrency));
      entries.push({
        allocationId: allocation.id,
        targetId: target.id,
        amount: request.amount,
        documentRate: allocation.documentRate,
        realizedFx: allocation.realizedFx,
      });

      const settled = D(target.amountDue).sub(D(request.amount)).isZero();
      if (target.kind === 'INVOICE') {
        await publish(client, context, {
          eventType: settled ? 'invoice.paid' : 'invoice.partially_paid',
          aggregateType: 'invoice',
          aggregateId: target.id,
          tenantId: principal.tenantId,
          legalEntityId: target.legalEntityId,
          payload: { allocated: request.amount, receipt_id: receiptId },
        });
      }
    }

    return {
      total: total.toString(),
      realizedFx: fxTotal.toString(),
      count: allocations.length,
      entries,
    };
  }

  /**
   * Resolves the realized-FX accounts a settlement posting needs, letting the
   * line builder refuse — naming the policy column — when one it actually
   * needs is missing. The accounts are only read when an allocation realized
   * any FX, so a single-currency tenant never pays the two extra lookups.
   */
  /** @internal Shared with ApService: both sides realize FX into the same policy accounts. */
  async resolveSettlementAccounts(
    client: PoolClient,
    legalEntityId: string,
    on: string,
    entries: readonly SettlementAllocation[],
  ): Promise<{ gain: string | null; loss: string | null }> {
    const hasFx = entries.some((entry) => !D(entry.realizedFx).isZero());
    if (!hasFx) return { gain: null, loss: null };
    return {
      gain: await this.policyAccount(client, legalEntityId, 'realized_fx_gain_account_id', on),
      loss: await this.policyAccount(client, legalEntityId, 'realized_fx_loss_account_id', on),
    };
  }

  /** @internal Also the refund payout side: money leaves by the same nameable account it arrived. */
  async resolveDepositAccount(
    client: PoolClient,
    book: BookContext,
    supplied: string | undefined,
    on: string,
  ): Promise<string> {
    if (supplied) return supplied;
    const clearing = await this.policyAccount(
      client,
      book.legalEntityId,
      'payment_clearing_account_id',
      on,
    );
    if (clearing) return clearing;
    throw new AppError(
      'VALIDATION_FAILED',
      'No deposit account was given and no payment clearing account is configured. Money has to ' +
        'land somewhere nameable — set payment_clearing_account_id on the accounting policy.',
    );
  }

  /** @internal */
  async policyAccount(
    client: PoolClient,
    legalEntityId: string,
    column: string,
    on: string,
  ): Promise<string | null> {
    const { rows } = await client.query<Record<string, string | null>>(
      `SELECT ${column} AS account_id FROM accounting_policies
        WHERE legal_entity_id = $1 AND valid_from <= $2::date
        ORDER BY valid_from DESC LIMIT 1`,
      [legalEntityId, on],
    );
    return rows[0]?.account_id ?? null;
  }
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

/**
 * The sequence a document type numbers from, created on first use.
 *
 * Shaped on `PostingService`'s JOURNAL sequence for the same reason it exists
 * there: failing the first invoice because nobody created an INVOICE sequence
 * would be correct and useless, and doc 02's criterion is that an organization
 * reaches posting-ready without direct database work. `branch_id NULLS LAST` so
 * a branch sequence wins over the entity-wide one where a tenant has configured
 * both.
 */
export async function resolveSequence(
  client: PoolClient,
  principal: TenantPrincipal,
  legalEntityId: string,
  documentType: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM number_sequences
      WHERE legal_entity_id = $1 AND document_type = $2 AND status = 'ACTIVE'
        AND branch_id IS NULL
      ORDER BY id
      LIMIT 1`,
    [legalEntityId, documentType],
  );
  if (rows[0]) return rows[0].id;

  const id = uuidv7();
  await client.query(
    `INSERT INTO number_sequences (id, tenant_id, legal_entity_id, document_type, prefix,
                                   padding, next_number, reset_rule)
     VALUES ($1,$2,$3,$4,$5,5,1,'ANNUAL')
     ON CONFLICT ON CONSTRAINT number_sequences_uq DO NOTHING`,
    [id, principal.tenantId, legalEntityId, documentType, `${documentType}-{YYYY}-`],
  );

  // The INSERT may have lost a race with a concurrent first document, in which
  // case ON CONFLICT did nothing and the winner's row is the one to use.
  const { rows: settled } = await client.query<{ id: string }>(
    `SELECT id FROM number_sequences
      WHERE legal_entity_id = $1 AND document_type = $2 AND branch_id IS NULL
      LIMIT 1`,
    [legalEntityId, documentType],
  );
  return settled[0]!.id;
}
