import { Pool, PoolClient } from 'pg';
import {
  AppError,
  Money,
  D,
  notFound,
  uuidv7,
  assertPermission,
  assertEntityPermission,
  calculateDocument,
  toBase,
  can,
  type TenantPrincipal,
  type RequestContext,
  type CalculatedDocument,
  type DocumentLineInput,
  type DraftLineInput,
} from '@acct/domain';
import { publish, recordAudit, readInTenant, writeInTenant } from '@acct/database';
import { PostingService, type BookContext } from '@acct/ledger';
import { TaxService, type ResolvedTaxCode } from './tax.service';
import {
  DocumentPostingService,
  vendorBillLines,
  type DocumentPostingResult,
} from './document-posting.service';
import { ArService } from './ar.service';
import {
  lockTargets,
  validateAllocations,
  applyToTarget,
  recordAllocation,
  settlementPostingLines,
  type AllocationRequest,
  type SettlementAllocation,
} from './allocation';

/**
 * Accounts payable and procurement — doc 05.
 *
 * Two controls in this file are the reason it is not simply AR with the signs
 * reversed. Duplicate bill detection, because paying the same invoice twice is
 * the most common way money leaves a company by accident; and three-way
 * matching, because paying for goods that were never accepted is the second.
 * Both are stated by doc 05 as workflows with an override, not as validations —
 * an override that requires a permission and a reason, and that is recorded.
 */

const DRAFT_STATES = new Set(['DRAFT', 'PENDING_APPROVAL', 'APPROVED']);

/**
 * The seam between AP and doc 10's commitment accounting — F-106.
 *
 * `@acct/projects` already depends on `@acct/subledger` (project billing hands a
 * draft invoice to ArService), so a direct import of CommitmentsService here
 * would close a package cycle and neither package would build. Structural typing
 * makes the fix free: this interface names exactly the in-transaction methods
 * `CommitmentsService` already exposes, so `apps/api` wires the concrete service
 * straight in and there is no adapter to keep in step.
 *
 * The port is deliberately *in-transaction only*. Relief that ran on its own
 * connection after the bill posted could commit while the posting rolled back,
 * leaving a commitment relieved against a journal that does not exist — which is
 * the double-count this exists to prevent, with the sign reversed.
 *
 * Required at the constructor, not optional. An optional dependency is how this
 * control was lost the first time: `assertSpendAllowed` and
 * `releasePurchaseOrderInTransaction` were both written, both correct, and both
 * unreachable, and nothing failed to build to say so. Made mandatory, "the
 * commitment side is wired" is a fact the compiler checks rather than a thing
 * somebody remembered.
 */
export interface CommitmentReliefPort {
  /**
   * Relieves `amount` of whatever commitment stands behind this PO line, capped
   * at what is open, and returns null when the line was never committed —
   * commitment accounting is optional per doc 10, so an uncommitted line is a
   * fact about the order, not an error in the bill.
   */
  relieveForPurchaseOrderLineInTransaction(
    client: PoolClient,
    context: RequestContext,
    principal: TenantPrincipal,
    input: { purchaseOrderLineId: string; amount: string },
  ): Promise<unknown>;
}

export interface BillLineInput {
  lineNo?: number | undefined;
  description: string;
  quantity: string;
  unitPrice: string;
  destinationAccountId: string;
  taxCodeId?: string | undefined;
  inclusive?: boolean | undefined;
  purchaseOrderLineId?: string | undefined;
  goodsReceiptLineId?: string | undefined;
  capitalizeAsAsset?: boolean | undefined;
  dimensions?: Record<string, string> | undefined;
}

export interface MatchTolerance {
  readonly quantityPercent: string;
  readonly pricePercent: string;
  readonly absoluteAmount: string;
}

/** doc 05 leaves tolerance to policy; these are the defaults until one is set. */
export const DEFAULT_TOLERANCE: MatchTolerance = {
  quantityPercent: '0.02',
  pricePercent: '0.02',
  absoluteAmount: '5.00',
};

export class ApService {
  constructor(
    private readonly pool: Pool,
    private readonly posting: PostingService,
    private readonly documents: DocumentPostingService,
    private readonly tax: TaxService,
    // The contact table is one table with a kind, so the vendor methods below
    // delegate to ArService's contact methods rather than carrying a second copy
    // of the same SQL that would drift from the first.
    private readonly ar: ArService,
    /** doc 10 commitment relief on the posting path — see CommitmentReliefPort. */
    private readonly commitments: CommitmentReliefPort,
  ) {}

  // =========================================================================
  // Vendors — F-708
  // =========================================================================

  async createVendor(
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
      apAccountId?: string | undefined;
      expenseAccountId?: string | undefined;
      purchaseTaxCodeId?: string | undefined;
      billingAddress?: Record<string, unknown> | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      // F-026: a vendor may be shared across the organization, in which case
      // there is no entity to scope the check to (see createCustomer).
      if (input.legalEntityId) {
        assertEntityPermission(principal, 'vendor.create', input.legalEntityId);
      } else {
        assertPermission(principal, 'vendor.create');
      }

      const { rows } = await client.query<Record<string, unknown>>(
        `INSERT INTO contacts (id, tenant_id, organization_id, legal_entity_id, kind, code,
                               legal_name, display_name, email, phone, tax_identifier,
                               default_currency, payment_terms_days, ap_account_id,
                               expense_account_id, purchase_tax_code_id, billing_address)
         VALUES ($1,$2,$3,$4,'VENDOR',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
         RETURNING id, organization_id, legal_entity_id, kind::text AS kind, code, legal_name,
                   display_name, email, phone, tax_identifier, default_currency,
                   payment_terms_days, ap_account_id, expense_account_id, purchase_tax_code_id,
                   status::text AS status, version::text AS version`,
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
          input.apAccountId ?? null,
          input.expenseAccountId ?? null,
          input.purchaseTaxCodeId ?? null,
          JSON.stringify(input.billingAddress ?? {}),
        ],
      );
      const created = rows[0]!;

      // vendor.created is book-scoped in contracts/events.yaml, so its envelope
      // requires a legal entity; an org-shared vendor is announced by its audit
      // record instead of by an event it cannot legally carry.
      if (input.legalEntityId) {
        await publish(client, context, {
          eventType: 'vendor.created',
          aggregateType: 'contact',
          aggregateId: created.id as string,
          tenantId: principal.tenantId,
          organizationId: input.organizationId,
          legalEntityId: input.legalEntityId,
          payload: { legal_name: input.legalName, code: input.code ?? null },
        });
      }
      await recordAudit(client, context, {
        action: 'vendor.created',
        resourceType: 'contact',
        resourceId: created.id as string,
        tenantId: principal.tenantId,
        after: created,
      });

      return created;
    });
  }

  async getVendor(principal: TenantPrincipal, id: string) {
    return this.ar.getContact(principal, id, 'VENDOR');
  }

  async listVendors(
    principal: TenantPrincipal,
    filter: { organizationId?: string | undefined; search?: string | undefined },
  ) {
    return this.ar.listContacts(principal, 'VENDOR', filter);
  }

  /**
   * Everything about a vendor except its bank details. `updateContact` updates
   * only its whitelist of contacts columns, and bank details live in
   * `contact_bank_details` — a table this path never writes — so the ordinary
   * edit route cannot reach the field that decides where money goes. That is
   * the split the contract describes on PATCH /vendors/{id}.
   */
  async updateVendor(
    principal: TenantPrincipal,
    id: string,
    input: Record<string, unknown>,
    expectedVersion: string | null,
  ) {
    return this.ar.updateContact(principal, id, 'VENDOR', input, expectedVersion);
  }

  /**
   * doc 05: "Bank detail change is high risk: record before/after, actor,
   * reason, verification and optional independent approval."
   *
   * Changing where a vendor is paid is the classic payment-fraud vector, which
   * is why this is a separate permission (vendor.change_bank_details) on a
   * separate route, why a reason is mandatory, and why the storage is a new
   * versioned row rather than an UPDATE — the Vendor Bank Change Audit report
   * reads the history this method refuses to overwrite.
   */
  async updateVendorBankDetails(
    principal: TenantPrincipal,
    id: string,
    input: {
      reason: string;
      accountHolderName?: string | undefined;
      accountNumber?: string | undefined;
      bankName?: string | undefined;
      branchCode?: string | undefined;
      iban?: string | undefined;
      swiftBic?: string | undefined;
      currency?: string | undefined;
      countryCode?: string | undefined;
      encryptedRef?: string | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows: vendors } = await client.query<Record<string, unknown>>(
        `SELECT id, legal_name, legal_entity_id FROM contacts
          WHERE id = $1 AND kind IN ('VENDOR','BOTH') FOR UPDATE`,
        [id],
      );
      const vendor = vendors[0];
      if (!vendor) throw notFound('vendor', id);
      const scope = vendor.legal_entity_id as string | null;
      if (scope) assertEntityPermission(principal, 'vendor.change_bank_details', scope);
      else assertPermission(principal, 'vendor.change_bank_details');

      if (!input.reason || input.reason.trim().length === 0) {
        throw new AppError(
          'VALIDATION_FAILED',
          'A bank-detail change must carry a reason (doc 05). The reason is what an ' +
            'investigation reads first.',
        );
      }

      const { rows: current } = await client.query<Record<string, unknown>>(
        `SELECT id, version, account_holder_name, masked_account_no, bank_name, branch_code,
                iban, swift_bic, currency, country_code
           FROM contact_bank_details WHERE contact_id = $1 AND valid_to IS NULL`,
        [id],
      );
      const before = current[0] ?? null;
      if (before) {
        await client.query(`UPDATE contact_bank_details SET valid_to = now() WHERE id = $1`, [
          before.id,
        ]);
      }

      // Unstated fields carry forward from the current version: "change the bank
      // name" must not silently blank the IBAN, because a half-empty new version
      // is indistinguishable from a deliberate removal.
      const masked = input.accountNumber
        ? maskAccountNumber(input.accountNumber)
        : ((before?.masked_account_no as string | null) ?? null);
      const { rows: created } = await client.query<Record<string, unknown>>(
        `INSERT INTO contact_bank_details (id, tenant_id, contact_id, version,
                                           account_holder_name, masked_account_no, encrypted_ref,
                                           bank_name, branch_code, iban, swift_bic, currency,
                                           country_code, changed_by, change_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id, contact_id, version, account_holder_name, masked_account_no, bank_name,
                   branch_code, iban, swift_bic, currency, country_code,
                   valid_from, changed_by, change_reason`,
        [
          uuidv7(),
          principal.tenantId,
          id,
          Number((before?.version as number | undefined) ?? 0) + 1,
          input.accountHolderName ?? before?.account_holder_name ?? null,
          masked,
          input.encryptedRef ?? null,
          input.bankName ?? before?.bank_name ?? null,
          input.branchCode ?? before?.branch_code ?? null,
          input.iban ?? before?.iban ?? null,
          input.swiftBic ?? before?.swift_bic ?? null,
          input.currency ?? before?.currency ?? null,
          input.countryCode ?? before?.country_code ?? null,
          principal.userId,
          input.reason,
        ],
      );
      const after = created[0]!;

      await recordAudit(client, context, {
        action: 'vendor.bank_details_changed',
        resourceType: 'contact',
        resourceId: id,
        tenantId: principal.tenantId,
        ...(scope ? { legalEntityId: scope } : {}),
        before: before ?? {},
        after: { ...after, reason: input.reason },
      });
      // Book-scoped event; an org-shared vendor has no entity to carry on the
      // envelope, so doc 13's anomaly feed reads the audit trail for those.
      if (scope) {
        await publish(client, context, {
          eventType: 'vendor.bank_details_changed',
          aggregateType: 'contact',
          aggregateId: id,
          tenantId: principal.tenantId,
          legalEntityId: scope,
          payload: {
            vendor_name: vendor.legal_name,
            version: after.version,
            changed_by: principal.userId,
            reason: input.reason,
          },
        });
      }

      return after;
    });
  }

  // =========================================================================
  // Vendor bills
  // =========================================================================

  /**
   * Creates a DRAFT bill, refusing a suspected duplicate unless overridden.
   *
   * doc 05 lists four duplicate signals and requires an override to carry a
   * permission and a reason. F-020 moved the check here from a UNIQUE
   * constraint, because a constraint cannot be overridden by anyone for any
   * reason — which made the documented workflow impossible to execute.
   */
  async createBill(
    principal: TenantPrincipal,
    input: {
      accountingBookId: string;
      vendorId: string;
      branchId?: string | undefined;
      purchaseOrderId?: string | undefined;
      vendorInvoiceNumber: string;
      documentDate: string;
      postingDate: string;
      dueDate?: string | undefined;
      currency?: string | undefined;
      exchangeRate?: string | undefined;
      sourceDocumentHash?: string | undefined;
      duplicateOverrideReason?: string | undefined;
      lines: readonly BillLineInput[];
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const book = await this.posting.loadBookContext(
        client,
        principal,
        input.accountingBookId,
        input.postingDate,
      );
      assertEntityPermission(principal, 'vendor_bill.create', book.legalEntityId);

      const vendor = await this.loadVendor(client, input.vendorId);
      const currency =
        input.currency ?? (vendor.default_currency as string | null) ?? book.baseCurrency;
      const rate = await this.resolveRate(
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
      );

      const duplicates = await this.findDuplicateBills(client, {
        legalEntityId: book.legalEntityId,
        vendorId: input.vendorId,
        vendorInvoiceNumber: input.vendorInvoiceNumber,
        documentDate: input.documentDate,
        total: calculated.total,
        sourceDocumentHash: input.sourceDocumentHash,
      });

      if (duplicates.length > 0 && !input.duplicateOverrideReason) {
        throw new AppError(
          'DUPLICATE_SUSPECTED',
          `This looks like a bill already recorded: ${duplicates
            .map((d) => `${d.internal_number ?? d.id} (${d.matched_on})`)
            .join(', ')}. If it is genuinely a separate document, resubmit with ` +
            'duplicate_override_reason and the vendor_bill.override_duplicate permission.',
          { details: { duplicates } },
        );
      }
      if (input.duplicateOverrideReason && !can(principal, 'vendor_bill.override_duplicate')) {
        throw new AppError(
          'FORBIDDEN',
          'Overriding duplicate detection requires vendor_bill.override_duplicate (doc 05).',
          { details: { permission: 'vendor_bill.override_duplicate' } },
        );
      }

      const dueDate =
        input.dueDate ??
        (vendor.payment_terms_days !== null
          ? addDays(input.documentDate, Number(vendor.payment_terms_days))
          : input.documentDate);

      const billId = uuidv7();
      const { rows } = await client.query<Record<string, unknown>>(
        `INSERT INTO vendor_bills (id, tenant_id, legal_entity_id, accounting_book_id, branch_id,
                                   vendor_id, purchase_order_id, vendor_invoice_number,
                                   normalized_invoice_number, document_date, posting_date, due_date,
                                   currency, exchange_rate, exchange_rate_date, subtotal, tax_total,
                                   total, base_total, amount_due, source_document_hash,
                                   duplicate_override_by, duplicate_override_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11::date,$12::date,$13,$14::numeric,
                 $11::date,$15::numeric,$16::numeric,$17::numeric,$18::numeric,$17::numeric,
                 $19,$20,$21)
         RETURNING id, legal_entity_id, accounting_book_id, vendor_id, vendor_invoice_number,
                   document_date::text AS document_date, posting_date::text AS posting_date,
                   due_date::text AS due_date, currency, status::text AS status,
                   match_state::text AS match_state, subtotal::text AS subtotal,
                   tax_total::text AS tax_total, total::text AS total,
                   amount_due::text AS amount_due, version::text AS version`,
        [
          billId,
          principal.tenantId,
          book.legalEntityId,
          book.bookId,
          input.branchId ?? null,
          input.vendorId,
          input.purchaseOrderId ?? null,
          input.vendorInvoiceNumber,
          normalizeInvoiceNumber(input.vendorInvoiceNumber),
          input.documentDate,
          input.postingDate,
          dueDate,
          currency,
          rate,
          calculated.subtotal,
          calculated.taxTotal,
          calculated.total,
          toBase(calculated.total, rate, currency, book.baseCurrency),
          input.sourceDocumentHash ?? null,
          input.duplicateOverrideReason ? principal.userId : null,
          input.duplicateOverrideReason ?? null,
        ],
      );

      await this.writeBillLines(client, principal, {
        billId,
        legalEntityId: book.legalEntityId,
        calculated,
        inputs: input.lines,
      });

      await publish(client, context, {
        eventType: 'vendor_bill.created',
        aggregateType: 'vendor_bill',
        aggregateId: billId,
        tenantId: principal.tenantId,
        organizationId: book.organizationId,
        legalEntityId: book.legalEntityId,
        accountingBookId: book.bookId,
        payload: { vendor_id: input.vendorId, total: calculated.total, currency },
      });
      if (input.duplicateOverrideReason) {
        await recordAudit(client, context, {
          action: 'vendor_bill.duplicate_overridden',
          resourceType: 'vendor_bill',
          resourceId: billId,
          tenantId: principal.tenantId,
          legalEntityId: book.legalEntityId,
          after: { reason: input.duplicateOverrideReason, matched: duplicates },
        });
      }

      return { ...rows[0], lines: calculated.lines };
    });
  }

  /**
   * doc 05's four duplicate signals, in the order they are worth trusting.
   *
   * The file hash is the strongest — the same PDF twice is the same bill. The
   * normalised number catches `INV-001` against `inv 001`. Vendor + date +
   * amount catches a re-keyed bill with a new reference. Each match is reported
   * with which signal fired, because the person deciding needs to know whether
   * they are looking at a certainty or a coincidence.
   */
  private async findDuplicateBills(
    client: PoolClient,
    signals: {
      legalEntityId: string;
      vendorId: string;
      vendorInvoiceNumber: string;
      documentDate: string;
      total: string;
      sourceDocumentHash?: string | undefined;
    },
  ): Promise<Array<{ id: string; internal_number: string | null; matched_on: string }>> {
    const { rows } = await client.query<{
      id: string;
      internal_number: string | null;
      matched_on: string;
    }>(
      `SELECT id, internal_number,
              CASE WHEN $5::text IS NOT NULL AND source_document_hash = $5 THEN 'file_hash'
                   WHEN normalized_invoice_number = $3                     THEN 'invoice_number'
                   ELSE 'vendor_date_amount' END AS matched_on
         FROM vendor_bills
        WHERE legal_entity_id = $1 AND vendor_id = $2
          AND status <> 'CANCELLED'
          AND ( ($5::text IS NOT NULL AND source_document_hash = $5)
             OR normalized_invoice_number = $3
             OR (document_date = $4::date AND total = $6::numeric) )
        LIMIT 5`,
      [
        signals.legalEntityId,
        signals.vendorId,
        normalizeInvoiceNumber(signals.vendorInvoiceNumber),
        signals.documentDate,
        signals.sourceDocumentHash ?? null,
        signals.total,
      ],
    );
    return rows;
  }

  private async calculate(
    client: PoolClient,
    legalEntityId: string,
    currency: string,
    documentDate: string,
    lines: readonly BillLineInput[],
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
        ...(code ? { taxCode: { ...code, inclusive: line.inclusive ?? code.inclusive } } : {}),
      };
    });
    return { calculated: calculateDocument(documentLines, { currency }), codes };
  }

  private async writeBillLines(
    client: PoolClient,
    principal: TenantPrincipal,
    input: {
      billId: string;
      legalEntityId: string;
      calculated: CalculatedDocument;
      inputs: readonly BillLineInput[];
    },
  ): Promise<void> {
    const byLineNo = new Map(
      input.inputs.map((line, index) => [line.lineNo ?? index + 1, line] as const),
    );
    for (const line of input.calculated.lines) {
      const source = byLineNo.get(line.lineNo);
      if (!source) continue;
      const recoverable = line.components.reduce(
        (a, c) =>
          Money.of(D(a), 'XXX')
            .add(Money.of(D(c.recoverableAmount), 'XXX'))
            .toString(),
        '0',
      );
      const lineId = uuidv7();
      await client.query(
        `INSERT INTO vendor_bill_lines (id, tenant_id, vendor_bill_id, legal_entity_id, line_no,
                                        purchase_order_line_id, goods_receipt_line_id, description,
                                        quantity, unit_price, destination_account_id, tax_code_id,
                                        net_amount, tax_amount, recoverable_tax_amount,
                                        gross_amount, capitalize_as_asset, calculation_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::numeric,$10::numeric,$11,$12,$13::numeric,
                 $14::numeric,$15::numeric,$16::numeric,coalesce($17,false),$18::jsonb)`,
        [
          lineId,
          principal.tenantId,
          input.billId,
          input.legalEntityId,
          line.lineNo,
          source.purchaseOrderLineId ?? null,
          source.goodsReceiptLineId ?? null,
          source.description,
          line.quantity,
          line.unitPrice,
          source.destinationAccountId,
          line.taxCodeId,
          line.netAmount,
          line.taxAmount,
          recoverable,
          line.grossAmount,
          source.capitalizeAsAsset ?? null,
          JSON.stringify(line.snapshot),
        ],
      );

      for (const [dimensionId, valueId] of Object.entries(source.dimensions ?? {})) {
        await client.query(
          `INSERT INTO document_line_dimensions (tenant_id, resource_type, resource_id,
                                                 legal_entity_id, dimension_id, dimension_value_id)
           VALUES ($1,'vendor_bill_line',$2,$3,$4,$5)`,
          [principal.tenantId, lineId, input.legalEntityId, dimensionId, valueId],
        );
      }

      if (source.purchaseOrderLineId) {
        await client.query(
          `UPDATE purchase_order_lines SET quantity_billed = quantity_billed + $2::numeric
            WHERE id = $1`,
          [source.purchaseOrderLineId, line.quantity],
        );
      }
      if (source.goodsReceiptLineId) {
        await client.query(
          `UPDATE goods_receipt_lines SET quantity_billed = quantity_billed + $2::numeric
            WHERE id = $1`,
          [source.goodsReceiptLineId, line.quantity],
        );
      }
    }
  }

  // =========================================================================
  // Matching — doc 05, and Phase 3's fifth exit criterion
  // =========================================================================

  /**
   * Two-way (PO vs bill) and three-way (PO vs receipt vs bill) matching.
   *
   * The exit criterion is "three-way match flags quantity/price/tolerance
   * violations correctly", so each variance is computed and recorded
   * individually rather than collapsed into a pass/fail. A match that says only
   * "EXCEPTION" leaves the buyer to find the difference by hand, which is the
   * work the match existed to do.
   *
   * WITHIN_TOLERANCE is a distinct result from MATCHED on purpose: an invoice
   * that is 1% over on every line is within tolerance and is also a pattern
   * somebody should see.
   */
  async matchBill(
    principal: TenantPrincipal,
    id: string,
    input: { tolerance?: Partial<MatchTolerance> | undefined },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const bill = await this.loadBill(client, id, { forUpdate: true });
      assertEntityPermission(principal, 'vendor_bill.match', bill.legal_entity_id as string);

      const tolerance: MatchTolerance = { ...DEFAULT_TOLERANCE, ...(input.tolerance ?? {}) };

      const { rows: lines } = await client.query<{
        id: string;
        line_no: number;
        description: string;
        quantity: string;
        unit_price: string;
        net_amount: string;
        purchase_order_line_id: string | null;
        goods_receipt_line_id: string | null;
        po_quantity: string | null;
        po_unit_price: string | null;
        po_received: string | null;
        gr_accepted: string | null;
      }>(
        `SELECT l.id, l.line_no, l.description, l.quantity::text AS quantity,
                l.unit_price::text AS unit_price, l.net_amount::text AS net_amount,
                l.purchase_order_line_id, l.goods_receipt_line_id,
                pol.quantity_ordered::text AS po_quantity, pol.unit_price::text AS po_unit_price,
                pol.quantity_received::text AS po_received,
                grl.quantity_accepted::text AS gr_accepted
           FROM vendor_bill_lines l
           LEFT JOIN purchase_order_lines pol ON pol.id = l.purchase_order_line_id
           LEFT JOIN goods_receipt_lines grl  ON grl.id = l.goods_receipt_line_id
          WHERE l.vendor_bill_id = $1
          ORDER BY l.line_no`,
        [id],
      );

      // Clearing prior results rather than appending: re-matching after a
      // correction must not leave the earlier exceptions attached, or a bill
      // that now matches still shows as blocked.
      await client.query(
        `DELETE FROM match_exceptions WHERE bill_match_id IN
           (SELECT id FROM bill_matches WHERE vendor_bill_id = $1)`,
        [id],
      );
      await client.query(`DELETE FROM bill_matches WHERE vendor_bill_id = $1`, [id]);

      const results: Array<Record<string, unknown>> = [];
      let worst: 'MATCHED' | 'WITHIN_TOLERANCE' | 'EXCEPTION' = 'MATCHED';

      for (const line of lines) {
        if (!line.purchase_order_line_id) {
          // A bill line with no order behind it is not an exception in itself —
          // doc 05 permits a bill created directly — but it is unmatched, and
          // saying so is different from saying it matched.
          continue;
        }
        const threeWay = Boolean(line.goods_receipt_line_id);
        const billedQty = D(line.quantity);
        const orderedQty = D(line.po_quantity ?? '0');
        const acceptedQty = D(line.gr_accepted ?? '0');
        const billedPrice = D(line.unit_price);
        const orderedPrice = D(line.po_unit_price ?? '0');

        // Against the receipt when there is one, against the order otherwise.
        // Billing 10 against an order for 10 when only 6 arrived is exactly the
        // failure three-way matching exists to catch.
        const referenceQty = threeWay ? acceptedQty : orderedQty;
        const quantityVariance = billedQty.sub(referenceQty);
        const priceVariance = billedPrice.sub(orderedPrice);
        const amountVariance = quantityVariance
          .mul(billedPrice)
          .add(priceVariance.mul(referenceQty));

        const quantityBreach = exceeds(quantityVariance, referenceQty, tolerance.quantityPercent);
        const priceBreach = exceeds(priceVariance, orderedPrice, tolerance.pricePercent);
        const absoluteBreach = amountVariance.abs().gt(D(tolerance.absoluteAmount));

        let result: 'MATCHED' | 'WITHIN_TOLERANCE' | 'EXCEPTION' = 'MATCHED';
        if ((quantityBreach || priceBreach) && absoluteBreach) result = 'EXCEPTION';
        else if (!quantityVariance.isZero() || !priceVariance.isZero()) result = 'WITHIN_TOLERANCE';

        if (result === 'EXCEPTION') worst = 'EXCEPTION';
        else if (result === 'WITHIN_TOLERANCE' && worst === 'MATCHED') worst = 'WITHIN_TOLERANCE';

        const matchId = uuidv7();
        await client.query(
          `INSERT INTO bill_matches (id, tenant_id, vendor_bill_id, vendor_bill_line_id,
                                     purchase_order_line_id, goods_receipt_line_id, match_kind,
                                     result, quantity_variance, price_variance,
                                     tolerance_pct_applied, tolerance_abs_applied)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::bill_match_status,$9::numeric,$10::numeric,
                   $11::numeric,$12::numeric)`,
          [
            matchId,
            principal.tenantId,
            id,
            line.id,
            line.purchase_order_line_id,
            line.goods_receipt_line_id,
            threeWay ? 'THREE_WAY' : 'TWO_WAY',
            result,
            quantityVariance.toString(),
            priceVariance.toString(),
            tolerance.quantityPercent,
            tolerance.absoluteAmount,
          ],
        );

        if (result === 'EXCEPTION') {
          await client.query(
            `INSERT INTO match_exceptions (id, bill_match_id, exception_type, detail,
                                           blocks_posting, blocks_payment)
             VALUES ($1,$2,$3,$4,true,true)`,
            [
              uuidv7(),
              matchId,
              quantityBreach ? 'QUANTITY_VARIANCE' : 'PRICE_VARIANCE',
              quantityBreach
                ? `Line ${line.line_no}: billed ${billedQty.toString()} against ` +
                  `${threeWay ? 'accepted' : 'ordered'} ${referenceQty.toString()}.`
                : `Line ${line.line_no}: billed at ${billedPrice.toString()} against an ordered ` +
                  `price of ${orderedPrice.toString()}.`,
            ],
          );
        }

        results.push({
          line_no: line.line_no,
          match_kind: threeWay ? 'THREE_WAY' : 'TWO_WAY',
          result,
          quantity_variance: quantityVariance.toString(),
          price_variance: priceVariance.toString(),
          amount_variance: amountVariance.toString(),
        });
      }

      await client.query(
        `UPDATE vendor_bills SET match_state = $2::bill_match_status WHERE id = $1`,
        [id, results.length === 0 ? 'UNMATCHED' : worst],
      );

      if (worst === 'EXCEPTION') {
        await publish(client, context, {
          eventType: 'vendor_bill.match_failed',
          aggregateType: 'vendor_bill',
          aggregateId: id,
          tenantId: principal.tenantId,
          legalEntityId: bill.legal_entity_id as string,
          payload: { exceptions: results.filter((r) => r.result === 'EXCEPTION') },
        });
      } else if (results.length > 0) {
        await publish(client, context, {
          eventType: 'vendor_bill.matched',
          aggregateType: 'vendor_bill',
          aggregateId: id,
          tenantId: principal.tenantId,
          legalEntityId: bill.legal_entity_id as string,
          payload: { result: worst, lines: results.length },
        });
      }

      return {
        vendor_bill_id: id,
        match_state: results.length === 0 ? 'UNMATCHED' : worst,
        lines: results,
        tolerance,
      };
    });
  }

  /**
   * Approves a bill — the human gate between matching and posting (doc 05's
   * bill lifecycle: DRAFT -> MATCH_REVIEW -> APPROVAL_PENDING -> APPROVED).
   *
   * A bill with an unresolved `blocks_posting` exception is not approvable:
   * approval is the statement "this may become a payable", and letting someone
   * approve past an open quantity/price exception makes the match a report
   * rather than a control. Resolving or re-matching clears the block.
   */
  async approveVendorBill(principal: TenantPrincipal, id: string) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const bill = await this.loadBill(client, id, { forUpdate: true });
      assertEntityPermission(principal, 'vendor_bill.approve', bill.legal_entity_id as string);

      // Idempotent: the contract requires an Idempotency-Key on this route, and
      // a retried approval must not fail on its own success.
      if (bill.status === 'APPROVED') return bill;
      if (!['DRAFT', 'PENDING_APPROVAL'].includes(bill.status as string)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `This bill is ${bill.status} and cannot be approved.`,
          { details: { status: bill.status } },
        );
      }

      const { rows: exceptions } = await client.query<MatchExceptionRow>(
        `SELECT e.exception_type, e.detail, e.blocks_posting,
                e.resolved_at::text AS resolved_at
           FROM match_exceptions e
           JOIN bill_matches m ON m.id = e.bill_match_id
          WHERE m.vendor_bill_id = $1`,
        [id],
      );
      const blockers = unresolvedPostingBlockers(exceptions);
      if (blockers.length > 0) {
        throw new AppError(
          'VALIDATION_FAILED',
          `This bill has ${blockers.length} unresolved match exception(s) that block it: ` +
            blockers.map((b) => b.detail ?? b.exception_type).join(' '),
          { details: { exceptions: blockers } },
        );
      }

      const { rows } = await client.query<Record<string, unknown>>(
        `UPDATE vendor_bills
            SET status = 'APPROVED', approval_state = 'APPROVED', version = version + 1
          WHERE id = $1
          RETURNING id, vendor_invoice_number, internal_number, status::text AS status,
                    approval_state::text AS approval_state, match_state::text AS match_state,
                    total::text AS total, amount_due::text AS amount_due,
                    version::text AS version`,
        [id],
      );

      await publish(client, context, {
        eventType: 'vendor_bill.approved',
        aggregateType: 'vendor_bill',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: bill.legal_entity_id as string,
        payload: { total: bill.total, currency: bill.currency, approved_by: principal.userId },
      });
      await recordAudit(client, context, {
        action: 'vendor_bill.approved',
        resourceType: 'vendor_bill',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: bill.legal_entity_id as string,
        before: bill,
        after: rows[0] as Record<string, unknown>,
      });

      return rows[0];
    });
  }

  /**
   * Posts a bill.
   *
   * Refuses while a blocking match exception is open, which is doc 05's
   * "posting/payment may be blocked according to policy" made concrete. The
   * exception carries `blocks_posting` so a policy can relax it per exception
   * type without this method growing a special case.
   */
  async postBill(principal: TenantPrincipal, id: string) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const bill = await this.loadBill(client, id, { forUpdate: true });
      assertEntityPermission(principal, 'vendor_bill.post', bill.legal_entity_id as string);

      if (bill.status === 'POSTED' || bill.status === 'PARTIALLY_PAID') return bill;
      if (!DRAFT_STATES.has(bill.status as string)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `This bill is ${bill.status} and cannot be posted.`,
        );
      }

      const { rows: blocking } = await client.query<{ detail: string; exception_type: string }>(
        `SELECT e.exception_type, e.detail
           FROM match_exceptions e
           JOIN bill_matches m ON m.id = e.bill_match_id
          WHERE m.vendor_bill_id = $1 AND e.blocks_posting AND e.resolved_at IS NULL`,
        [id],
      );
      if (blocking.length > 0) {
        throw new AppError(
          'VALIDATION_FAILED',
          `This bill has ${blocking.length} unresolved match exception(s) that block posting: ` +
            blocking.map((b) => b.detail).join(' '),
          { details: { exceptions: blocking } },
        );
      }

      const book = await this.posting.loadBookContext(
        client,
        principal,
        bill.accounting_book_id as string,
        bill.posting_date as string,
      );
      const { calculated, codes, destinationByLine, dimensionsByLine } = await this.reloadLines(
        client,
        bill,
      );

      const apAccountId = await this.resolveApAccount(client, bill, book);
      const taxAccounts = new Map<string, string>();
      for (const code of codes.values()) {
        for (const component of code.components) {
          if (code.receivableAccountId) taxAccounts.set(component.id, code.receivableAccountId);
        }
      }

      // F-713's second half: a line billed against a POSTED goods receipt was
      // already debited to its destination by the receipt accrual, so its bill
      // debit must clear GRNI instead — otherwise the destination carries one
      // delivery twice and the GRNI credit is never relieved. Gated on the
      // receipt being POSTED because a receipt that never posted put nothing
      // into GRNI for this bill to take out.
      const { rows: accruedLines } = await client.query<{ line_no: number }>(
        `SELECT l.line_no
           FROM vendor_bill_lines l
           JOIN goods_receipt_lines grl ON grl.id = l.goods_receipt_line_id
           JOIN goods_receipts gr ON gr.id = grl.goods_receipt_id
          WHERE l.vendor_bill_id = $1 AND gr.status = 'POSTED'`,
        [id],
      );
      let grniAccountByLine: Map<number, string> | undefined;
      if (accruedLines.length > 0) {
        const grniAccountId = await this.policyAccount(
          client,
          book.legalEntityId,
          'grni_account_id',
          bill.posting_date as string,
        );
        if (!grniAccountId) {
          throw new AppError(
            'VALIDATION_FAILED',
            'This bill is matched to a posted goods receipt, but no Goods Received Not Invoiced ' +
              'account is configured to clear the accrual against. Set grni_account_id on the ' +
              'accounting policy.',
          );
        }
        grniAccountByLine = new Map(accruedLines.map((row) => [row.line_no, grniAccountId]));
      }

      const lines = vendorBillLines({
        calculated,
        destinationAccountByLine: destinationByLine,
        grniAccountByLine,
        taxAccountByComponent: taxAccounts,
        apAccountId,
        currency: bill.currency as string,
        exchangeRate: (bill.exchange_rate as string) ?? '1',
        exchangeRateDate: (bill.exchange_rate_date as string) ?? null,
        contactId: bill.vendor_id as string,
        dimensionsByLine,
      });

      const result = await this.documents.post(client, context, principal, book, {
        ruleCode: 'VENDOR_BILL_POSTED',
        sourceType: 'vendor_bill',
        sourceId: id,
        sourceEventId: `vendor_bill.posted:${id}`,
        journalCode: 'PUR',
        postingDate: bill.posting_date as string,
        documentDate: bill.document_date as string,
        description: `Bill ${bill.vendor_invoice_number ?? ''}`.trim(),
        branchId: (bill.branch_id as string) ?? null,
        contactId: bill.vendor_id as string,
        lines,
        tax: {
          calculated,
          codes,
          direction: 'INPUT',
          sign: 1,
          currency: bill.currency as string,
          exchangeRate: (bill.exchange_rate as string) ?? '1',
        },
      });

      const { rows } = await client.query<Record<string, unknown>>(
        `UPDATE vendor_bills
            SET status = 'POSTED', accounting_entry_id = $2, version = version + 1
          WHERE id = $1
          RETURNING id, vendor_invoice_number, internal_number, status::text AS status,
                    total::text AS total, amount_due::text AS amount_due, accounting_entry_id,
                    version::text AS version`,
        [id, result.entry.id],
      );

      // doc 10, and the second half of F-106: the moment a PO line's spend
      // becomes an actual posted journal line it stops being a commitment. Left
      // out, the same taka is counted twice by the budget formula — once in
      // `open commitments` and again in `actual posted` — and every remaining
      // approval in the period is measured against an availability that is too
      // low by the amount already spent.
      //
      // Net of tax, because that is what was committed: recoverable tax is a
      // receivable, not spend, and relieving gross would over-relieve a
      // commitment that never included it. Relief is capped at what is open by
      // the commitment side, so a bill priced above the order consumes the
      // commitment and no more.
      const relieved = await this.relieveCommitments(client, context, principal, id);

      await publish(client, context, {
        eventType: 'vendor_bill.posted',
        aggregateType: 'vendor_bill',
        aggregateId: id,
        tenantId: principal.tenantId,
        organizationId: book.organizationId,
        legalEntityId: bill.legal_entity_id as string,
        accountingBookId: book.bookId,
        payload: {
          vendor_id: bill.vendor_id,
          total: bill.total,
          currency: bill.currency,
          journal_entry_id: result.entry.id,
          tax_rows: result.taxRowsWritten,
        },
      });

      return {
        ...rows[0],
        journal_entry: { id: result.entry.id, entry_number: result.entry.entry_number },
        commitments_relieved: relieved,
      };
    });
  }

  /**
   * Relieves the commitment behind every bill line that names a PO line.
   *
   * Reads the persisted lines rather than the calculated ones: `net_amount` on
   * the row is what the commitment was measured against and what a later reader
   * of this bill will see, and re-deriving it here would introduce a second
   * opinion about the same number.
   */
  private async relieveCommitments(
    client: PoolClient,
    context: RequestContext,
    principal: TenantPrincipal,
    billId: string,
  ): Promise<number> {
    const { rows } = await client.query<{
      purchase_order_line_id: string;
      net_amount: string;
    }>(
      `SELECT purchase_order_line_id, net_amount::text AS net_amount
         FROM vendor_bill_lines
        WHERE vendor_bill_id = $1 AND purchase_order_line_id IS NOT NULL
        ORDER BY line_no`,
      [billId],
    );
    let relieved = 0;
    for (const line of rows) {
      const result = await this.commitments.relieveForPurchaseOrderLineInTransaction(
        client,
        context,
        principal,
        { purchaseOrderLineId: line.purchase_order_line_id, amount: line.net_amount },
      );
      if (result) relieved++;
    }
    return relieved;
  }

  // =========================================================================
  // Goods receipts — F-702 / F-713
  // =========================================================================

  async createGoodsReceipt(
    principal: TenantPrincipal,
    input: {
      accountingBookId: string;
      vendorId: string;
      purchaseOrderId?: string | undefined;
      receiptKind?: 'GOODS' | 'SERVICE' | undefined;
      receiptDate: string;
      postingDate: string;
      location?: string | undefined;
      notes?: string | undefined;
      lines: ReadonlyArray<{
        lineNo?: number | undefined;
        purchaseOrderLineId?: string | undefined;
        description: string;
        quantityReceived: string;
        quantityAccepted?: string | undefined;
        quantityRejected?: string | undefined;
        unitPrice?: string | undefined;
        destinationAccountId?: string | undefined;
        rejectionReason?: string | undefined;
      }>;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client }) => {
      const book = await this.posting.loadBookContext(
        client,
        principal,
        input.accountingBookId,
        input.postingDate,
      );
      assertEntityPermission(principal, 'goods_receipt.create', book.legalEntityId);

      const receiptId = uuidv7();
      const receiptNumber = await this.allocateDocumentNumber(
        client,
        principal,
        book.legalEntityId,
        'GRN',
      );

      await client.query(
        `INSERT INTO goods_receipts (id, tenant_id, legal_entity_id, accounting_book_id, vendor_id,
                                     purchase_order_id, receipt_number, receipt_kind, receipt_date,
                                     posting_date, location, notes, received_by, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,coalesce($8,'GOODS'),$9::date,$10::date,$11,$12,$13,$13)`,
        [
          receiptId,
          principal.tenantId,
          book.legalEntityId,
          book.bookId,
          input.vendorId,
          input.purchaseOrderId ?? null,
          receiptNumber,
          input.receiptKind ?? null,
          input.receiptDate,
          input.postingDate,
          input.location ?? null,
          input.notes ?? null,
          principal.userId,
        ],
      );

      for (const [index, line] of input.lines.entries()) {
        // Accepted defaults to received. Requiring it explicitly would make the
        // ordinary case — everything arrived and was fine — the one that needs
        // extra typing, and an unstated acceptance would then block billing.
        const accepted = line.quantityAccepted ?? line.quantityReceived;
        await client.query(
          `INSERT INTO goods_receipt_lines (id, tenant_id, goods_receipt_id, legal_entity_id,
                                            line_no, purchase_order_line_id, description,
                                            quantity_received, quantity_accepted, quantity_rejected,
                                            unit_price, destination_account_id, rejection_reason)
           -- The cast goes INSIDE the coalesce. Writing coalesce($10,0)::numeric
           -- infers $10 as integer from the literal 0 and casts the result
           -- afterwards, so an ordinary '5.00' unit price fails to parse as an
           -- integer before the ::numeric is ever reached.
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9::numeric,coalesce($10::numeric,0),
                   coalesce($11::numeric,0),$12,$13)`,
          [
            uuidv7(),
            principal.tenantId,
            receiptId,
            book.legalEntityId,
            line.lineNo ?? index + 1,
            line.purchaseOrderLineId ?? null,
            line.description,
            line.quantityReceived,
            accepted,
            line.quantityRejected ?? null,
            line.unitPrice ?? null,
            line.destinationAccountId ?? null,
            line.rejectionReason ?? null,
          ],
        );
        if (line.purchaseOrderLineId) {
          await client.query(
            `UPDATE purchase_order_lines SET quantity_received = quantity_received + $2::numeric
              WHERE id = $1`,
            [line.purchaseOrderLineId, accepted],
          );
        }
      }

      const { rows } = await client.query<Record<string, unknown>>(
        `SELECT id, legal_entity_id, vendor_id, purchase_order_id, receipt_number,
                receipt_kind, receipt_date::text AS receipt_date,
                posting_date::text AS posting_date, status::text AS status,
                version::text AS version
           FROM goods_receipts WHERE id = $1`,
        [receiptId],
      );
      // F-727: the lines come back with their ids. `vendor_bill_lines` references
      // `goods_receipt_line_id`, so without them the caller cannot record the bill
      // that closes the three-way match it just opened.
      const { rows: lines } = await client.query(
        `SELECT id, line_no, purchase_order_line_id, description,
                quantity_received::text AS quantity_received,
                quantity_accepted::text AS quantity_accepted,
                quantity_rejected::text AS quantity_rejected,
                quantity_billed::text AS quantity_billed,
                unit_price::text AS unit_price, destination_account_id, rejection_reason
           FROM goods_receipt_lines WHERE goods_receipt_id = $1 ORDER BY line_no`,
        [receiptId],
      );
      return { ...rows[0], lines };
    });
  }

  /**
   * F-713. Receiving goods before the bill arrives is an accounting event:
   *
   *   Dr destination (expense / asset / inventory)
   *   Cr Goods Received Not Invoiced
   *
   * and the bill then debits GRNI instead of the destination. Without it the
   * cost lands in the period the invoice happens to arrive in rather than the
   * period the goods did, which is the accrual doc 05 separates receipt from
   * billing to make possible.
   */
  async postGoodsReceipt(principal: TenantPrincipal, id: string) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `SELECT id, legal_entity_id, accounting_book_id, vendor_id, receipt_number,
                receipt_date::text AS receipt_date, posting_date::text AS posting_date,
                status::text AS status, accounting_entry_id, branch_id
           FROM goods_receipts WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const receipt = rows[0];
      if (!receipt) throw notFound('goods receipt', id);
      assertEntityPermission(principal, 'goods_receipt.post', receipt.legal_entity_id as string);
      if (receipt.status === 'POSTED') return receipt;

      const book = await this.posting.loadBookContext(
        client,
        principal,
        receipt.accounting_book_id as string,
        receipt.posting_date as string,
      );
      const grniAccountId = await this.policyAccount(
        client,
        book.legalEntityId,
        'grni_account_id',
        receipt.posting_date as string,
      );
      if (!grniAccountId) {
        throw new AppError(
          'VALIDATION_FAILED',
          'No Goods Received Not Invoiced account is configured, so a receipt has nothing to ' +
            'accrue against. Set grni_account_id on the accounting policy.',
        );
      }

      const { rows: lines } = await client.query<{
        line_no: number;
        description: string;
        quantity_accepted: string;
        unit_price: string;
        destination_account_id: string | null;
        po_account: string | null;
      }>(
        `SELECT l.line_no, l.description, l.quantity_accepted::text AS quantity_accepted,
                l.unit_price::text AS unit_price, l.destination_account_id,
                pol.destination_account_id AS po_account
           FROM goods_receipt_lines l
           LEFT JOIN purchase_order_lines pol ON pol.id = l.purchase_order_line_id
          WHERE l.goods_receipt_id = $1 ORDER BY l.line_no`,
        [id],
      );

      const postingLines = [];
      let total = Money.zero(book.baseCurrency);
      for (const line of lines) {
        const amount = Money.of(
          D(line.quantity_accepted).mul(D(line.unit_price)),
          book.baseCurrency,
        );
        if (amount.isZero()) continue;
        const accountId = line.destination_account_id ?? line.po_account;
        if (!accountId) {
          throw new AppError(
            'VALIDATION_FAILED',
            `Receipt line ${line.line_no} has no destination account, on the line or on the ` +
              'order line it came from, so the accrual has nowhere to go.',
          );
        }
        postingLines.push({
          accountId,
          description: line.description,
          debit: amount.toString(),
        });
        total = total.add(amount);
      }
      if (postingLines.length === 0) {
        throw new AppError(
          'VALIDATION_FAILED',
          'This receipt accepted nothing with a price, so there is no accrual to post.',
        );
      }
      postingLines.push({
        accountId: grniAccountId,
        description: 'Goods received not invoiced',
        credit: total.toString(),
      } as never);

      const result = await this.documents.post(client, context, principal, book, {
        ruleCode: 'GOODS_RECEIPT_ACCRUAL',
        sourceType: 'goods_receipt',
        sourceId: id,
        sourceEventId: `goods_receipt.posted:${id}`,
        journalCode: 'PUR',
        postingDate: receipt.posting_date as string,
        documentDate: receipt.receipt_date as string,
        description: `Goods receipt ${receipt.receipt_number ?? ''}`.trim(),
        branchId: (receipt.branch_id as string) ?? null,
        contactId: receipt.vendor_id as string,
        lines: postingLines,
      });

      const { rows: posted } = await client.query<Record<string, unknown>>(
        `UPDATE goods_receipts SET status = 'POSTED', accounting_entry_id = $2,
                                   version = version + 1
          WHERE id = $1
          RETURNING id, receipt_number, status::text AS status, accounting_entry_id,
                    version::text AS version`,
        [id, result.entry.id],
      );

      await publish(client, context, {
        eventType: 'goods_receipt.posted',
        aggregateType: 'goods_receipt',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: book.legalEntityId,
        accountingBookId: book.bookId,
        payload: { accrued: total.toString(), journal_entry_id: result.entry.id },
      });

      return posted[0];
    });
  }

  // =========================================================================
  // Payments
  // =========================================================================

  /**
   * Records a standalone vendor payment and posts it.
   *
   * Posting rule catalog, VENDOR_PAYMENT_POSTED: Dr accounts payable for the
   * allocated amount, Dr vendor advances for the unapplied remainder, Cr the
   * bank or payment clearing account. The mirror of `createReceipt`, and for
   * the same doc 05 reason the AR side splits: a prepayment debited straight
   * to AP disappears into the control account instead of standing visible as
   * money the vendor owes us goods for.
   */
  async createPayment(
    principal: TenantPrincipal,
    input: {
      accountingBookId: string;
      vendorId: string;
      branchId?: string | undefined;
      documentDate: string;
      postingDate: string;
      currency?: string | undefined;
      exchangeRate?: string | undefined;
      amount: string;
      paymentMethod?: string | undefined;
      bankAccountId?: string | undefined;
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
      assertEntityPermission(principal, 'vendor_payment.pay', book.legalEntityId);

      const vendor = await this.loadVendor(client, input.vendorId);
      const currency =
        input.currency ?? (vendor.default_currency as string | null) ?? book.baseCurrency;
      const rate = await this.resolveRate(
        client,
        currency,
        book.baseCurrency,
        input.exchangeRate,
        input.postingDate,
      );

      const paymentId = uuidv7();
      const paymentNumber = await this.allocateDocumentNumber(
        client,
        principal,
        book.legalEntityId,
        'PAYMENT',
      );

      await client.query(
        `INSERT INTO vendor_payments (id, tenant_id, legal_entity_id, accounting_book_id,
                                      branch_id, vendor_id, payment_number, document_date,
                                      posting_date, currency, amount, exchange_rate,
                                      exchange_rate_date, base_amount, unapplied_amount,
                                      bank_account_id, payment_method, external_reference, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9::date,$10,$11::numeric,$12::numeric,$9::date,
                 $13::numeric,$11::numeric,$14,$15,$16,'DRAFT')`,
        [
          paymentId,
          principal.tenantId,
          book.legalEntityId,
          book.bookId,
          input.branchId ?? null,
          input.vendorId,
          paymentNumber,
          input.documentDate,
          input.postingDate,
          currency,
          input.amount,
          rate,
          toBase(input.amount, rate, currency, book.baseCurrency),
          input.bankAccountId ?? null,
          input.paymentMethod ?? null,
          input.externalReference ?? null,
        ],
      );

      const allocated = input.allocations?.length
        ? await this.allocatePaymentInternal(
            client,
            principal,
            book,
            paymentId,
            input.allocations,
            {
              currency,
              amount: input.amount,
              unapplied_amount: input.amount,
              exchange_rate: rate,
            },
          )
        : { total: '0', realizedFx: '0', count: 0, entries: [] as SettlementAllocation[] };

      const result = await this.postPaymentJournal(
        client,
        context,
        principal,
        book,
        {
          id: paymentId,
          vendor_id: input.vendorId,
          payment_number: paymentNumber,
          currency,
          amount: input.amount,
          exchange_rate: rate,
          document_date: input.documentDate,
          posting_date: input.postingDate,
          bank_account_id: input.bankAccountId ?? null,
          branch_id: input.branchId ?? null,
        },
        allocated.total,
        allocated.entries,
      );

      if (allocated.count > 0) {
        await client.query(
          `UPDATE payment_allocations SET accounting_entry_id = $2 WHERE vendor_payment_id = $1`,
          [paymentId, result.entry.id],
        );
      }

      const { rows } = await client.query<Record<string, unknown>>(
        `UPDATE vendor_payments
            SET status = 'POSTED', accounting_entry_id = $2, allocated_amount = $3::numeric,
                unapplied_amount = amount - $3::numeric
          WHERE id = $1
          RETURNING id, payment_number, vendor_id, currency, amount::text AS amount,
                    allocated_amount::text AS allocated_amount,
                    unapplied_amount::text AS unapplied_amount, status::text AS status,
                    accounting_entry_id`,
        [paymentId, result.entry.id, allocated.total],
      );

      await recordAudit(client, context, {
        action: 'vendor_payment.created',
        resourceType: 'vendor_payment',
        resourceId: paymentId,
        tenantId: principal.tenantId,
        legalEntityId: book.legalEntityId,
        after: rows[0] as Record<string, unknown>,
      });

      return { ...rows[0], allocations: allocated.count, realized_fx: allocated.realizedFx };
    });
  }

  /**
   * @internal Posts one vendor payment's journal. Shared with
   * ProcurementService.executePaymentRun so a run payment and a standalone
   * payment reach the ledger through one builder — a second posting path is
   * how the two learn to disagree about what an AP relief looks like.
   *
   * Publishes `vendor_payment.posted` (the accounting moment, distinct from
   * `.completed` — contracts/events.yaml) and returns the posting result; the
   * caller persists the entry id alongside its own status change.
   */
  async postPaymentJournal(
    client: PoolClient,
    context: RequestContext,
    principal: TenantPrincipal,
    book: BookContext,
    payment: {
      id: string;
      vendor_id: string;
      payment_number: string | null;
      currency: string;
      amount: string;
      exchange_rate: string | null;
      document_date: string;
      posting_date: string;
      bank_account_id: string | null;
      branch_id: string | null;
    },
    allocatedTotal: string,
    allocations: readonly SettlementAllocation[],
  ): Promise<DocumentPostingResult> {
    const rate = payment.exchange_rate ?? '1';
    const apAccountId = await this.resolveApAccount(
      client,
      { vendor_id: payment.vendor_id, posting_date: payment.posting_date },
      book,
    );
    const advanceAccountId = await this.policyAccount(
      client,
      book.legalEntityId,
      'vendor_advance_account_id',
      payment.posting_date,
    );
    // "Also the refund payout side: money leaves by the same nameable account
    // it arrived" — the receipt's resolver, reused for exactly that reason.
    const paymentAccountId = await this.ar.resolveDepositAccount(
      client,
      book,
      payment.bank_account_id ?? undefined,
      payment.posting_date,
    );

    const lines = vendorPaymentLines({
      amount: payment.amount,
      allocatedTotal,
      apAccountId,
      vendorAdvanceAccountId: advanceAccountId,
      paymentAccountId,
      currency: payment.currency,
      exchangeRate: rate,
      contactId: payment.vendor_id,
      reference: `Payment ${payment.payment_number ?? payment.id}`,
    });
    // The AP debit above relieved the control at the SETTLEMENT rate; bills
    // booked at other rates leave a base residue that is realized FX
    // (ADR-0007), recognized here so the control account gives back exactly
    // what the bills put in. Amounts are zeroed: the split above already
    // moved the money, only the rate difference remains.
    const fxAccounts = await this.ar.resolveSettlementAccounts(
      client,
      book.legalEntityId,
      payment.posting_date,
      allocations,
    );
    lines.push(
      ...settlementPostingLines({
        side: 'AP',
        controlAccountId: apAccountId,
        advanceAccountId,
        realizedFxGainAccountId: fxAccounts.gain,
        realizedFxLossAccountId: fxAccounts.loss,
        contactId: payment.vendor_id,
        currency: payment.currency,
        baseCurrency: book.baseCurrency,
        settlementRate: rate,
        allocations: allocations.map((entry) => ({ ...entry, amount: '0' })),
      }),
    );

    const result = await this.documents.post(client, context, principal, book, {
      ruleCode: 'VENDOR_PAYMENT_POSTED',
      sourceType: 'vendor_payment',
      sourceId: payment.id,
      sourceEventId: `vendor_payment.posted:${payment.id}`,
      journalCode: 'BNK',
      postingDate: payment.posting_date,
      documentDate: payment.document_date,
      description: `Payment ${payment.payment_number ?? ''}`.trim(),
      branchId: payment.branch_id,
      contactId: payment.vendor_id,
      lines,
    });

    await publish(client, context, {
      eventType: 'vendor_payment.posted',
      aggregateType: 'vendor_payment',
      aggregateId: payment.id,
      tenantId: principal.tenantId,
      organizationId: book.organizationId,
      legalEntityId: book.legalEntityId,
      accountingBookId: book.bookId,
      payload: {
        payment_number: payment.payment_number,
        vendor_id: payment.vendor_id,
        amount: payment.amount,
        currency: payment.currency,
        allocated: allocatedTotal,
        journal_entry_id: result.entry.id,
      },
    });

    return result;
  }

  /**
   * The allocation protocol, AP side: source locked by the caller, targets in
   * ascending id order, validation over the whole request set. Returns what
   * the settlement posting needs — one entry per allocation row written.
   */
  private async allocatePaymentInternal(
    client: PoolClient,
    principal: TenantPrincipal,
    book: BookContext,
    paymentId: string,
    allocations: readonly AllocationRequest[],
    payment: Record<string, unknown>,
  ): Promise<{
    total: string;
    realizedFx: string;
    count: number;
    entries: SettlementAllocation[];
  }> {
    const currency = payment.currency as string;
    const settlementRate = (payment.exchange_rate as string) ?? '1';
    const targets = await lockTargets(client, principal, allocations);
    validateAllocations({
      sourceUnapplied: (payment.unapplied_amount as string) ?? (payment.amount as string),
      sourceCurrency: currency,
      requests: allocations,
      targets,
      documentLabel: (t) => `${t.kind === 'VENDOR_BILL' ? 'bill' : 'vendor credit'} ${t.id}`,
    });

    let total = Money.zero(currency);
    let fxTotal = Money.zero(book.baseCurrency);
    const entries: SettlementAllocation[] = [];
    for (const request of allocations) {
      const target = targets.get(request.targetId)!;
      const allocation = await recordAllocation(client, principal, {
        table: 'payment_allocations',
        sourceColumn: 'vendor_payment_id',
        sourceId: paymentId,
        target,
        amount: request.amount,
        settlementRate,
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
    }
    return {
      total: total.toString(),
      realizedFx: fxTotal.toString(),
      count: allocations.length,
      entries,
    };
  }

  /**
   * doc 05: "Concurrent payments cannot consume the same bill balance twice."
   *
   * Same protocol as the AR side, which is the point — one allocation
   * implementation means one set of locking rules to get right. And the same
   * settlement journal: applying previously unapplied cash reclassifies the
   * vendor advance onto AP — Dr AP, Cr vendor advance, plus the realized FX —
   * in the same transaction that moves the subledger. Without it a payment run
   * or a late allocation reduces the AP aging while the control account stands
   * still.
   */
  async allocatePayment(
    principal: TenantPrincipal,
    id: string,
    allocations: readonly AllocationRequest[],
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `SELECT id, legal_entity_id, accounting_book_id, vendor_id, payment_number, currency,
                amount::text AS amount, allocated_amount::text AS allocated_amount,
                unapplied_amount::text AS unapplied_amount, document_date::text AS document_date,
                posting_date::text AS posting_date,
                exchange_rate::text AS exchange_rate, status::text AS status
           FROM vendor_payments WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const payment = rows[0];
      if (!payment) throw notFound('vendor payment', id);
      assertEntityPermission(
        principal,
        'vendor_payment.allocate',
        payment.legal_entity_id as string,
      );

      const book = await this.posting.loadBookContext(
        client,
        principal,
        payment.accounting_book_id as string,
        payment.posting_date as string,
      );
      const result = await this.allocatePaymentInternal(
        client,
        principal,
        book,
        id,
        allocations,
        payment,
      );

      let journalEntry: { id: string; entry_number: unknown } | null = null;
      if (result.entries.length > 0) {
        const apAccountId = await this.resolveApAccount(
          client,
          { vendor_id: payment.vendor_id, posting_date: payment.posting_date },
          book,
        );
        const advanceAccountId = await this.policyAccount(
          client,
          book.legalEntityId,
          'vendor_advance_account_id',
          payment.posting_date as string,
        );
        const fxAccounts = await this.ar.resolveSettlementAccounts(
          client,
          book.legalEntityId,
          payment.posting_date as string,
          result.entries,
        );
        const lines = settlementPostingLines({
          side: 'AP',
          controlAccountId: apAccountId,
          advanceAccountId,
          realizedFxGainAccountId: fxAccounts.gain,
          realizedFxLossAccountId: fxAccounts.loss,
          contactId: payment.vendor_id as string,
          currency: payment.currency as string,
          baseCurrency: book.baseCurrency,
          settlementRate: (payment.exchange_rate as string) ?? '1',
          allocations: result.entries,
        });
        if (lines.length > 0) {
          // The allocation row ids are fresh uuidv7s minted by THIS call: the
          // smallest names this batch and no other, so the kernel replays a
          // retried posting of the same batch and never dedupes away the next
          // allocation against the same payment.
          const batchId = result.entries.map((entry) => entry.allocationId).sort()[0]!;
          const posted = await this.documents.post(client, context, principal, book, {
            ruleCode: 'VENDOR_PAYMENT_ALLOCATED',
            sourceType: 'vendor_payment',
            sourceId: id,
            sourceEventId: `vendor_payment.allocated:${id}:${batchId}`,
            journalCode: 'GEN',
            postingDate: payment.posting_date as string,
            documentDate: (payment.document_date as string) ?? (payment.posting_date as string),
            description: `Payment ${payment.payment_number ?? id} allocation`,
            branchId: null,
            contactId: payment.vendor_id as string,
            lines,
          });
          await client.query(
            `UPDATE payment_allocations SET accounting_entry_id = $2 WHERE id = ANY($1::uuid[])`,
            [result.entries.map((entry) => entry.allocationId), posted.entry.id],
          );
          journalEntry = { id: posted.entry.id, entry_number: posted.entry.entry_number };
        }
      }

      const { rows: updated } = await client.query<Record<string, unknown>>(
        `UPDATE vendor_payments
            SET allocated_amount = allocated_amount + $2::numeric,
                unapplied_amount = amount - (allocated_amount + $2::numeric)
          WHERE id = $1
          RETURNING id, payment_number, allocated_amount::text AS allocated_amount,
                    unapplied_amount::text AS unapplied_amount`,
        [id, result.total],
      );

      await recordAudit(client, context, {
        action: 'vendor_payment.allocated',
        resourceType: 'vendor_payment',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: payment.legal_entity_id as string,
        after: {
          allocated: result.total,
          targets: allocations.length,
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

  /**
   * F-715. Records the bank's answer to a payment already sent.
   *
   * A failure releases the allocations rather than deleting them: the history of
   * what was attempted is the thing an investigation reads, and the privilege
   * layer has no DELETE on the allocation tables anyway.
   */
  async confirmPayment(
    principal: TenantPrincipal,
    id: string,
    input: {
      outcome: 'CONFIRMED' | 'FAILED';
      bankReference?: string | undefined;
      reason?: string | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `SELECT id, legal_entity_id, accounting_book_id, vendor_id, payment_number,
                posting_date::text AS posting_date, status::text AS status,
                amount::text AS amount
           FROM vendor_payments WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const payment = rows[0];
      if (!payment) throw notFound('vendor payment', id);
      assertEntityPermission(
        principal,
        'vendor_payment.confirm',
        payment.legal_entity_id as string,
      );

      if (payment.status === input.outcome) return payment;
      if (!['SENT', 'PENDING', 'POSTED'].includes(payment.status as string)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `This payment is ${payment.status}; only a payment that has been sent has an outcome ` +
            'to record.',
        );
      }

      const { rows: updated } = await client.query<Record<string, unknown>>(
        `UPDATE vendor_payments
            SET status = $2::payment_status, external_reference = coalesce($3, external_reference),
                failure_reason = $4
          WHERE id = $1
          RETURNING id, payment_number, status::text AS status, external_reference, failure_reason`,
        [id, input.outcome, input.bankReference ?? null, input.reason ?? null],
      );

      const reversals: Array<{ reverses: string; journal_entry_id: string }> = [];
      if (input.outcome === 'FAILED') {
        // Reversing allocations rather than removing them: the bill goes back to
        // open, and the record that a payment was attempted and failed stays.
        const { rows: allocations } = await client.query<{ target_id: string; amount: string }>(
          `SELECT target_id, amount::text AS amount FROM payment_allocations
            WHERE vendor_payment_id = $1`,
          [id],
        );
        for (const allocation of allocations) {
          await client.query(
            `UPDATE vendor_bills
                SET amount_paid = amount_paid - $2::numeric,
                    amount_due = amount_due + $2::numeric,
                    status = CASE WHEN amount_paid - $2::numeric = 0 THEN 'POSTED'
                                  ELSE 'PARTIALLY_PAID' END::document_status
              WHERE id = $1`,
            [allocation.target_id, allocation.amount],
          );
        }
        await client.query(
          `UPDATE vendor_payments SET allocated_amount = 0, unapplied_amount = amount WHERE id = $1`,
          [id],
        );

        // The ledger half of the failure. The payment posted VENDOR_PAYMENT_POSTED
        // when it was created and VENDOR_PAYMENT_ALLOCATED for any later
        // allocation; leaving those standing while the bills reopen is exactly
        // the control-account-vs-aging divergence Phase 3's first exit criterion
        // tests for. doc 01 rule 4: a posted fact is corrected by a compensating
        // entry, so each entry is mirrored from its own stored lines — the lines
        // the payment actually produced, realized FX included — never rebuilt
        // from the inputs a rebuild could disagree with.
        const { rows: postedEntries } = await client.query<{
          id: string;
          entry_number: string | null;
          document_date: string | null;
          branch_id: string | null;
          journal_code: string;
        }>(
          // The compensating entries this block posts carry the same
          // source_type/source_id, so a replay must match the originals only —
          // finding its own output would post reversals of reversals.
          `SELECT e.id, e.entry_number, e.document_date::text AS document_date, e.branch_id,
                  j.code AS journal_code
             FROM journal_entries e
             JOIN journals j ON j.id = e.journal_id
            WHERE e.source_type = 'vendor_payment' AND e.source_id = $1
              AND e.status = 'POSTED'
              AND e.source_event_id NOT LIKE 'vendor_payment.reversed:%'
            ORDER BY e.id`,
          [id],
        );

        // A payment that failed before it ever posted has nothing to compensate.
        if (postedEntries.length > 0) {
          // Reverse in the period the money was booked in while it is still
          // open, so the failure nets to nothing inside one period. Once that
          // period has closed the reversal lands on the confirmation date —
          // and if that period is closed too, the posting service refuses with
          // the period named rather than this method inventing a date.
          const originalPeriod = await this.posting.resolvePeriod(client, principal, {
            legalEntityId: payment.legal_entity_id as string,
            postingDate: payment.posting_date as string,
          });
          const reversalDate =
            originalPeriod.status === 'OPEN' ? (payment.posting_date as string) : todayIso();
          const book = await this.posting.loadBookContext(
            client,
            principal,
            payment.accounting_book_id as string,
            reversalDate,
          );

          const journals: PostedPaymentJournal[] = [];
          for (const entry of postedEntries) {
            journals.push({
              entryId: entry.id,
              lines: await this.posting.readLines(client, entry.id),
            });
          }
          const byEntry = new Map(postedEntries.map((entry) => [entry.id, entry] as const));
          for (const mirrored of mirrorPaymentJournals(journals)) {
            const original = byEntry.get(mirrored.entryId)!;
            const posted = await this.documents.post(client, context, principal, book, {
              ruleCode: 'VENDOR_PAYMENT_REVERSED',
              sourceType: 'vendor_payment',
              sourceId: id,
              // Keyed by the entry being reversed: if the status short-circuit
              // above ever let a second FAILED confirmation through, the kernel
              // would replay these keys and return the first reversals rather
              // than posting a second set.
              sourceEventId: `vendor_payment.reversed:${id}:${mirrored.entryId}`,
              // The same journal the original landed in, so the bank journal's
              // failure nets out in the bank journal, not in GEN.
              journalCode: original.journal_code,
              postingDate: reversalDate,
              documentDate: original.document_date ?? reversalDate,
              description:
                `Reversal of ${original.entry_number ?? mirrored.entryId}: payment ` +
                `${payment.payment_number ?? id} failed`,
              branchId: original.branch_id,
              contactId: payment.vendor_id as string,
              // What makes the ledger's own drill chain work: `reversal_of_id` is
              // the column `JournalService.reverse` fills and every "what
              // cancelled this entry" query follows. Without it the two entries
              // are a pair only someone reading amounts could recognise.
              reversalOfId: mirrored.entryId,
              lines: mirrored.lines,
            });
            reversals.push({ reverses: mirrored.entryId, journal_entry_id: posted.entry.id });
          }
        }
      }

      await publish(client, context, {
        eventType:
          input.outcome === 'CONFIRMED' ? 'vendor_payment.completed' : 'vendor_payment.failed',
        aggregateType: 'vendor_payment',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: payment.legal_entity_id as string,
        payload: {
          payment_number: payment.payment_number,
          amount: payment.amount,
          ...(input.reason ? { reason: input.reason } : {}),
        },
      });
      await recordAudit(client, context, {
        action: `vendor_payment.${input.outcome.toLowerCase()}`,
        resourceType: 'vendor_payment',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: payment.legal_entity_id as string,
        before: payment,
        // The pairing also lives on `journal_entries.reversal_of_id`, which is
        // where a ledger query finds it. Repeating it here is for the reader who
        // starts from the payment rather than from the journal.
        after: {
          ...(updated[0] as Record<string, unknown>),
          ...(reversals.length > 0 ? { reversal_journal_entries: reversals } : {}),
        },
      });

      return updated[0];
    });
  }

  // =========================================================================
  // Payment holds — F-716
  // =========================================================================

  async placeHold(
    principal: TenantPrincipal,
    input: { scopeType: 'VENDOR' | 'VENDOR_BILL'; scopeId: string; reason: string },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `INSERT INTO payment_holds (id, tenant_id, scope_type, scope_id, reason, placed_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, scope_type, scope_id, reason, placed_by, placed_at`,
        [
          uuidv7(),
          principal.tenantId,
          input.scopeType,
          input.scopeId,
          input.reason,
          principal.userId,
        ],
      );
      if (input.scopeType === 'VENDOR_BILL') {
        await client.query(
          `UPDATE vendor_bills SET on_hold = true, hold_reason = $2 WHERE id = $1`,
          [input.scopeId, input.reason],
        );
      }
      await recordAudit(client, context, {
        action: 'payment_hold.placed',
        resourceType: input.scopeType.toLowerCase(),
        resourceId: input.scopeId,
        tenantId: principal.tenantId,
        after: rows[0] as Record<string, unknown>,
      });
      return rows[0];
    });
  }

  async releaseHold(principal: TenantPrincipal, id: string, reason: string) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `UPDATE payment_holds
            SET released_by = $2, released_at = now()
          WHERE id = $1 AND released_at IS NULL
          RETURNING id, scope_type, scope_id, reason, released_by, released_at`,
        [id, principal.userId],
      );
      if (!rows[0]) throw notFound('payment hold', id);
      if (rows[0].scope_type === 'VENDOR_BILL') {
        await client.query(
          `UPDATE vendor_bills SET on_hold = false, hold_reason = NULL WHERE id = $1`,
          [rows[0].scope_id],
        );
      }
      await recordAudit(client, context, {
        action: 'payment_hold.released',
        resourceType: 'payment_hold',
        resourceId: id,
        tenantId: principal.tenantId,
        after: { ...rows[0], release_reason: reason },
      });
      return rows[0];
    });
  }

  async listHolds(principal: TenantPrincipal, filter: { active?: boolean | undefined }) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT id, scope_type, scope_id, reason, placed_by, placed_at, released_by, released_at
           FROM payment_holds
          WHERE ($1::boolean IS NULL OR ($1 AND released_at IS NULL) OR (NOT $1))
          ORDER BY placed_at DESC LIMIT 200`,
        [filter.active ?? null],
      );
      return { data: rows };
    });
  }

  // =========================================================================
  // Shared
  // =========================================================================

  /** Shared with ProcurementService: vendor credits derive from a bill's lines. */
  async loadBill(
    client: PoolClient,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT id, tenant_id, legal_entity_id, accounting_book_id, branch_id, vendor_id,
              purchase_order_id, vendor_invoice_number, internal_number,
              document_date::text AS document_date, posting_date::text AS posting_date,
              due_date::text AS due_date, currency, exchange_rate::text AS exchange_rate,
              exchange_rate_date::text AS exchange_rate_date, status::text AS status,
              approval_state::text AS approval_state,
              match_state::text AS match_state, subtotal::text AS subtotal,
              tax_total::text AS tax_total, total::text AS total,
              amount_paid::text AS amount_paid, amount_credited::text AS amount_credited,
              amount_due::text AS amount_due, on_hold, accounting_entry_id,
              version::text AS version
         FROM vendor_bills WHERE id = $1 ${options.forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    );
    if (!rows[0]) throw notFound('vendor bill', id);
    return rows[0];
  }

  /** Shared with ProcurementService: purchase orders bill the same vendors. */
  async loadVendor(client: PoolClient, id: string): Promise<Record<string, unknown>> {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT id, legal_name, default_currency, payment_terms_days, ap_account_id,
              expense_account_id, purchase_tax_code_id, status::text AS status
         FROM contacts WHERE id = $1 AND kind IN ('VENDOR','BOTH')`,
      [id],
    );
    if (!rows[0]) throw notFound('vendor', id);
    if (rows[0].status !== 'ACTIVE') {
      throw new AppError(
        'VALIDATION_FAILED',
        `${rows[0].legal_name} is ${rows[0].status} and cannot be billed.`,
      );
    }
    return rows[0];
  }

  /**
   * Shared with ProcurementService. There is no vendor-credit line table, so a
   * credit's posting lines are the source bill's, sign-inverted — one reader of
   * bill lines keeps the two documents structurally identical.
   */
  async reloadLines(
    client: PoolClient,
    bill: Record<string, unknown>,
  ): Promise<{
    calculated: CalculatedDocument;
    codes: Map<string, ResolvedTaxCode>;
    destinationByLine: Map<number, string>;
    dimensionsByLine: Map<number, Record<string, string>>;
  }> {
    const { rows } = await client.query<{
      id: string;
      line_no: number;
      description: string;
      quantity: string;
      unit_price: string;
      destination_account_id: string;
      tax_code_id: string | null;
      calculation_snapshot: Record<string, unknown> | null;
    }>(
      `SELECT id, line_no, description, quantity::text AS quantity, unit_price::text AS unit_price,
              destination_account_id, tax_code_id, calculation_snapshot
         FROM vendor_bill_lines WHERE vendor_bill_id = $1 ORDER BY line_no`,
      [bill.id],
    );

    const codes = await this.tax.resolveCodes(
      client,
      bill.legal_entity_id as string,
      rows.map((r) => r.tax_code_id).filter((id): id is string => Boolean(id)),
      bill.document_date as string,
    );

    const destinationByLine = new Map<number, string>();
    const dimensionsByLine = new Map<number, Record<string, string>>();
    const documentLines: DocumentLineInput[] = [];

    for (const row of rows) {
      destinationByLine.set(row.line_no, row.destination_account_id);
      const code = row.tax_code_id ? codes.get(row.tax_code_id) : undefined;
      const inclusive = (row.calculation_snapshot?.inclusive as boolean | undefined) ?? false;
      documentLines.push({
        lineNo: row.line_no,
        description: row.description,
        quantity: row.quantity,
        unitPrice: row.unit_price,
        ...(code ? { taxCode: { ...code, inclusive } } : {}),
      });

      const { rows: dimensions } = await client.query<{
        dimension_id: string;
        dimension_value_id: string;
      }>(
        `SELECT dimension_id, dimension_value_id FROM document_line_dimensions
          WHERE resource_type = 'vendor_bill_line' AND resource_id = $1`,
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
      calculated: calculateDocument(documentLines, { currency: bill.currency as string }),
      codes,
      destinationByLine,
      dimensionsByLine,
    };
  }

  /** Takes any row shaped {vendor_id, posting_date}; payments and credits qualify. */
  async resolveApAccount(
    client: PoolClient,
    bill: Record<string, unknown>,
    book: BookContext,
  ): Promise<string> {
    const { rows } = await client.query<{ ap_account_id: string | null }>(
      `SELECT ap_account_id FROM contacts WHERE id = $1`,
      [bill.vendor_id],
    );
    if (rows[0]?.ap_account_id) return rows[0].ap_account_id;

    const fromPolicy = await this.policyAccount(
      client,
      book.legalEntityId,
      'ap_control_account_id',
      bill.posting_date as string,
    );
    if (fromPolicy) return fromPolicy;

    throw new AppError(
      'VALIDATION_FAILED',
      'No accounts payable account is configured. Set ap_control_account_id on the accounting ' +
        'policy, or ap_account_id on the vendor.',
      { details: { legal_entity_id: book.legalEntityId } },
    );
  }

  /** Reads one accounting-policy column effective on a date. null = not configured. */
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
        `No exchange rate from ${currency} to ${baseCurrency} on or before ${on}.`,
        { details: { from: currency, to: baseCurrency, on } },
      );
    }
    return rows[0].rate;
  }

  /** F-726: one allocator, in `@acct/ledger`. See `ArService.allocateDocumentNumber`. */
  async allocateDocumentNumber(
    client: PoolClient,
    principal: TenantPrincipal,
    legalEntityId: string,
    documentType: string,
    resourceId?: string,
  ): Promise<string> {
    return this.ar.allocateDocumentNumber(
      client,
      principal,
      legalEntityId,
      documentType,
      resourceId,
    );
  }

  async listBills(
    principal: TenantPrincipal,
    filter: {
      legalEntityId?: string | undefined;
      vendorId?: string | undefined;
      status?: string | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT b.id, b.legal_entity_id, b.vendor_id, c.legal_name AS vendor_name,
                b.vendor_invoice_number, b.internal_number,
                b.document_date::text AS document_date, b.due_date::text AS due_date,
                b.currency, b.status::text AS status, b.match_state::text AS match_state,
                b.total::text AS total, b.amount_due::text AS amount_due, b.on_hold,
                b.accounting_entry_id, b.version::text AS version
           FROM vendor_bills b
           JOIN contacts c ON c.id = b.vendor_id
          WHERE ($1::uuid IS NULL OR b.legal_entity_id = $1)
            AND ($2::uuid IS NULL OR b.vendor_id = $2)
            AND ($3::text IS NULL OR b.status::text = $3)
          ORDER BY b.document_date DESC
          LIMIT 200`,
        [filter.legalEntityId ?? null, filter.vendorId ?? null, filter.status ?? null],
      );
      return { data: rows };
    });
  }

  async listGoodsReceipts(
    principal: TenantPrincipal,
    filter: {
      legalEntityId?: string | undefined;
      vendorId?: string | undefined;
      purchaseOrderId?: string | undefined;
      status?: string | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT g.id, g.legal_entity_id, g.vendor_id, c.legal_name AS vendor_name,
                g.purchase_order_id, g.receipt_number, g.receipt_kind,
                g.receipt_date::text AS receipt_date, g.posting_date::text AS posting_date,
                g.location, g.status::text AS status, g.accounting_entry_id,
                g.version::text AS version
           FROM goods_receipts g
           JOIN contacts c ON c.id = g.vendor_id
          WHERE ($1::uuid IS NULL OR g.legal_entity_id = $1)
            AND ($2::uuid IS NULL OR g.vendor_id = $2)
            AND ($3::uuid IS NULL OR g.purchase_order_id = $3)
            AND ($4::text IS NULL OR g.status::text = $4)
          ORDER BY g.receipt_date DESC, g.receipt_number DESC
          LIMIT 200`,
        [
          filter.legalEntityId ?? null,
          filter.vendorId ?? null,
          filter.purchaseOrderId ?? null,
          filter.status ?? null,
        ],
      );
      return { data: rows };
    });
  }

  async listPayments(
    principal: TenantPrincipal,
    filter: {
      legalEntityId?: string | undefined;
      vendorId?: string | undefined;
      status?: string | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT p.id, p.legal_entity_id, p.vendor_id, c.legal_name AS vendor_name,
                p.payment_run_id, p.payment_number, p.document_date::text AS document_date,
                p.posting_date::text AS posting_date, p.currency, p.amount::text AS amount,
                p.allocated_amount::text AS allocated_amount,
                p.unapplied_amount::text AS unapplied_amount, p.payment_method,
                p.status::text AS status, p.accounting_entry_id, p.external_reference
           FROM vendor_payments p
           JOIN contacts c ON c.id = p.vendor_id
          WHERE ($1::uuid IS NULL OR p.legal_entity_id = $1)
            AND ($2::uuid IS NULL OR p.vendor_id = $2)
            AND ($3::text IS NULL OR p.status::text = $3)
          ORDER BY p.document_date DESC, p.payment_number DESC
          LIMIT 200`,
        [filter.legalEntityId ?? null, filter.vendorId ?? null, filter.status ?? null],
      );
      return { data: rows };
    });
  }
}

/**
 * Builds the accounting lines for a vendor payment.
 *
 * Posting rule catalog, VENDOR_PAYMENT_POSTED:
 *   Dr Accounts Payable — the allocated amount
 *   Dr Vendor Advances  — the unapplied remainder
 *   Cr Bank / Payment Clearing — the full payment
 *
 * The mirror of the customer receipt split. The advance half is the part worth
 * defending: a prepayment debited straight to AP would make the control
 * account disagree with an AP aging that has no open item for it — doc 05's
 * unapplied funds stay visible, on both sides of the house.
 */
export function vendorPaymentLines(input: {
  readonly amount: string;
  readonly allocatedTotal: string;
  readonly apAccountId: string;
  readonly vendorAdvanceAccountId: string | null;
  readonly paymentAccountId: string;
  readonly currency: string;
  readonly exchangeRate: string;
  readonly contactId: string;
  readonly reference: string;
}): DraftLineInput[] {
  const allocated = Money.of(D(input.allocatedTotal), input.currency);
  const unapplied = Money.of(D(input.amount), input.currency).sub(allocated);
  if (unapplied.isNegative()) {
    throw new AppError(
      'OVER_ALLOCATION',
      `This payment is for ${input.amount} ${input.currency} but ${input.allocatedTotal} was ` +
        'allocated from it. A payment cannot apply more money than it moves.',
      { details: { amount: input.amount, allocated: input.allocatedTotal } },
    );
  }

  const fx = { transactionCurrency: input.currency, exchangeRate: input.exchangeRate };
  const lines: DraftLineInput[] = [];

  if (!allocated.isZero()) {
    lines.push({
      accountId: input.apAccountId,
      description: 'Accounts payable',
      contactId: input.contactId,
      debit: allocated.toString(),
      ...fx,
    });
  }
  if (!unapplied.isZero()) {
    if (!input.vendorAdvanceAccountId) {
      throw new AppError(
        'VALIDATION_FAILED',
        `This payment leaves ${unapplied.toString()} ${input.currency} unapplied and no vendor ` +
          'advance account is configured. An unapplied payment debited to AP disappears into ' +
          'the control account, which is what doc 05 asks to remain visible — set ' +
          'vendor_advance_account_id on the accounting policy.',
        { details: { unapplied: unapplied.toString() } },
      );
    }
    lines.push({
      accountId: input.vendorAdvanceAccountId,
      description: 'Vendor advance',
      contactId: input.contactId,
      debit: unapplied.toString(),
      ...fx,
    });
  }
  lines.push({
    accountId: input.paymentAccountId,
    description: input.reference,
    credit: input.amount,
    ...fx,
  });

  return lines;
}

/** One posted journal a payment produced, read back as the lines it stored. */
export interface PostedPaymentJournal {
  readonly entryId: string;
  readonly lines: readonly DraftLineInput[];
}

/**
 * The compensating entries for a failed payment: every journal the payment
 * posted, each with debits and credits swapped and everything else — account,
 * amount, currency, rate, contact, dimensions — copied verbatim.
 *
 * Mirrored from the stored lines rather than rebuilt from vendorPaymentLines,
 * for the same reason a credit note is `salesInvoiceLines({ sign: -1 })` and
 * not a second builder: the stored lines are what the payment actually posted,
 * including a later allocation's realized FX, and a reversal recomputed from
 * inputs is a reversal that can disagree with the entry it claims to cancel.
 * No entries in, no entries out — a payment that failed before posting has
 * nothing to compensate.
 */
export function mirrorPaymentJournals(
  journals: readonly PostedPaymentJournal[],
): Array<{ entryId: string; lines: DraftLineInput[] }> {
  return journals.map((journal) => ({
    entryId: journal.entryId,
    lines: journal.lines.map((line) => ({ ...line, debit: line.credit, credit: line.debit })),
  }));
}

/**
 * doc 05's "similar invoice number normalization".
 *
 * Case, spaces and separators removed, and the zero padding on the numeric part
 * collapsed — `INV-0042`, `inv 42` and `Inv/42` are one document in every case
 * anyone has ever meant them to be two.
 *
 * The padding is stripped after the alphabetic prefix rather than at the start
 * of the string, which is where the first version got it wrong: `^0+` never
 * matched `INV0042` at all, so the padded and unpadded forms of the same
 * reference stayed different and the signal quietly did nothing. Anchoring past
 * the prefix also leaves a year-prefixed number like `2026001` alone, which a
 * global strip would have mangled into `2026`.
 *
 * Aggressive on purpose. This is a duplicate *signal*, not a rule: doc 05 makes
 * every match overridable with a permission and a reason, so a false positive
 * costs a sentence and a false negative costs a payment.
 */
export function normalizeInvoiceNumber(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^([A-Z]*)0+(?=\d)/, '$1');
}

export interface MatchExceptionRow {
  readonly exception_type: string;
  readonly detail: string | null;
  readonly blocks_posting: boolean;
  readonly resolved_at: string | null;
}

/**
 * The exceptions that stand between a bill and approval.
 *
 * `blocks_posting` gates approval as well as posting, deliberately: an approval
 * given over an open quantity or price exception is a promise the match already
 * contradicted, and the person who resolves the exception — not the approver —
 * is the one doc 05 makes answerable for the variance. A resolved exception no
 * longer blocks; resolution is the record of who accepted the difference.
 */
export function unresolvedPostingBlockers(
  exceptions: readonly MatchExceptionRow[],
): MatchExceptionRow[] {
  return exceptions.filter((e) => e.blocks_posting && e.resolved_at === null);
}

/**
 * Only the last four characters survive into storage. doc 16 keeps the full
 * account number out of the database entirely (encrypted_ref points at the
 * secret store), and four characters is what a person needs to recognise their
 * own account on a remittance advice without them being enough to redirect one.
 */
export function maskAccountNumber(raw: string): string {
  const digits = raw.replace(/[^0-9A-Za-z]/g, '');
  return `****${digits.slice(-4)}`;
}

/** True when a variance exceeds the tolerance percentage of its reference. */
function exceeds(
  variance: ReturnType<typeof D>,
  reference: ReturnType<typeof D>,
  percent: string,
): boolean {
  if (variance.isZero()) return false;
  if (reference.isZero()) return true;
  return variance.abs().gt(reference.abs().mul(D(percent)));
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

/** The confirmation date: the bank's answer arrives today, whenever the payment posted. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
