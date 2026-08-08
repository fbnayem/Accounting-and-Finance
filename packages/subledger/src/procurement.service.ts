import { Pool, PoolClient } from 'pg';
import {
  AppError,
  Money,
  D,
  notFound,
  uuidv7,
  assertEntityPermission,
  calculateDocument,
  toBase,
  type TenantPrincipal,
  type CalculatedDocument,
  type DocumentLineInput,
} from '@acct/domain';
import { publish, recordAudit, readInTenant, writeInTenant } from '@acct/database';
import { PostingService } from '@acct/ledger';
import { TaxService, type ResolvedTaxCode } from './tax.service';
import { DocumentPostingService, vendorBillLines } from './document-posting.service';
import { ApService } from './ap.service';
import {
  lockTargets,
  validateAllocations,
  applyToTarget,
  recordAllocation,
  type AllocationRequest,
  type SettlementAllocation,
} from './allocation';

/**
 * Procurement — the rest of doc 05: requisitions, purchase orders, vendor
 * credits, expense claims and payment runs.
 *
 * Everything here is either an authority gate (a requisition or an order is
 * permission to spend, not an accounting event) or a document that reaches the
 * ledger through the same one path every other document does. The two controls
 * this file owns outright are doc 14's separations: the claimant never approves
 * their own expense claim, and a payment run is approved by someone other than
 * the person who built it — with a second approver above the policy threshold.
 *
 * Constructor:
 *
 *   new ProcurementService(pool, posting, documents, tax, ap)
 *
 *     pool:      pg Pool
 *     posting:   @acct/ledger PostingService   (book context, periods)
 *     documents: DocumentPostingService        (the one path to a journal)
 *     tax:       TaxService                    (code resolution)
 *     ap:        ApService                     (bills, vendors, holds, numbering
 *                — a vendor credit posts from its bill's lines and a payment run
 *                pays bills, so this service reads them through the service that
 *                owns them rather than carrying a second copy of the SQL)
 */

export interface RequisitionLineInput {
  lineNo?: number | undefined;
  itemId?: string | undefined;
  description: string;
  quantity: string;
  estimatedPrice: string;
}

export interface PurchaseOrderLineInput {
  lineNo?: number | undefined;
  itemId?: string | undefined;
  description: string;
  quantity: string;
  uom?: string | undefined;
  unitPrice: string;
  destinationAccountId?: string | undefined;
  taxCodeId?: string | undefined;
  inclusive?: boolean | undefined;
}

export interface ExpenseItemInput {
  lineNo?: number | undefined;
  expenseDate: string;
  merchant?: string | undefined;
  category?: string | undefined;
  businessPurpose?: string | undefined;
  /** What the employee actually paid — gross, tax inside. */
  amount: string;
  expenseAccountId: string;
  taxCodeId?: string | undefined;
  receiptFileId?: string | undefined;
  isCompanyCard?: boolean | undefined;
}

export class ProcurementService {
  constructor(
    private readonly pool: Pool,
    private readonly posting: PostingService,
    private readonly documents: DocumentPostingService,
    private readonly tax: TaxService,
    private readonly ap: ApService,
  ) {}

  // =========================================================================
  // Purchase requisitions — F-712
  // =========================================================================

  async createPurchaseRequisition(
    principal: TenantPrincipal,
    input: {
      legalEntityId: string;
      branchId?: string | undefined;
      requesterId?: string | undefined;
      businessReason?: string | undefined;
      suggestedVendorId?: string | undefined;
      requiredDate?: string | undefined;
      currency: string;
      lines: readonly RequisitionLineInput[];
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      assertEntityPermission(principal, 'purchase_requisition.create', input.legalEntityId);
      if (input.lines.length === 0) {
        throw new AppError(
          'VALIDATION_FAILED',
          'A requisition with no lines requests nothing, so there is nothing to approve.',
        );
      }

      let estimated = Money.zero(input.currency);
      for (const line of input.lines) {
        estimated = estimated.add(
          Money.of(D(line.quantity).mul(D(line.estimatedPrice)), input.currency),
        );
      }

      const requisitionId = uuidv7();
      const requisitionNumber = await this.ap.allocateDocumentNumber(
        client,
        principal,
        input.legalEntityId,
        'REQUISITION',
      );

      const { rows } = await client.query<Record<string, unknown>>(
        `INSERT INTO purchase_requisitions (id, tenant_id, legal_entity_id, branch_id,
                                            requisition_number, requester_id, business_reason,
                                            suggested_vendor_id, required_date, currency,
                                            estimated_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11::numeric)
         RETURNING id, legal_entity_id, branch_id, requisition_number, requester_id,
                   business_reason, suggested_vendor_id, required_date::text AS required_date,
                   currency, estimated_total::text AS estimated_total, status::text AS status`,
        [
          requisitionId,
          principal.tenantId,
          input.legalEntityId,
          input.branchId ?? null,
          requisitionNumber,
          input.requesterId ?? principal.userId,
          input.businessReason ?? null,
          input.suggestedVendorId ?? null,
          input.requiredDate ?? null,
          input.currency,
          estimated.toString(),
        ],
      );

      const lines: Array<Record<string, unknown>> = [];
      for (const [index, line] of input.lines.entries()) {
        const lineNo = line.lineNo ?? index + 1;
        await client.query(
          `INSERT INTO purchase_requisition_lines (id, tenant_id, requisition_id, line_no, item_id,
                                                   description, quantity, estimated_price)
           VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,$8::numeric)`,
          [
            uuidv7(),
            principal.tenantId,
            requisitionId,
            lineNo,
            line.itemId ?? null,
            line.description,
            line.quantity,
            line.estimatedPrice,
          ],
        );
        lines.push({
          line_no: lineNo,
          description: line.description,
          quantity: line.quantity,
          estimated_price: line.estimatedPrice,
        });
      }

      await recordAudit(client, context, {
        action: 'purchase_requisition.created',
        resourceType: 'purchase_requisition',
        resourceId: requisitionId,
        tenantId: principal.tenantId,
        legalEntityId: input.legalEntityId,
        after: rows[0] as Record<string, unknown>,
      });

      return { ...rows[0], lines };
    });
  }

  async listPurchaseRequisitions(
    principal: TenantPrincipal,
    filter: {
      legalEntityId?: string | undefined;
      requesterId?: string | undefined;
      status?: string | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT id, legal_entity_id, requisition_number, requester_id, business_reason,
                suggested_vendor_id, required_date::text AS required_date, currency,
                estimated_total::text AS estimated_total, status::text AS status, created_at
           FROM purchase_requisitions
          WHERE ($1::uuid IS NULL OR legal_entity_id = $1)
            AND ($2::uuid IS NULL OR requester_id = $2)
            AND ($3::text IS NULL OR status::text = $3)
          ORDER BY created_at DESC
          LIMIT 200`,
        [filter.legalEntityId ?? null, filter.requesterId ?? null, filter.status ?? null],
      );
      return { data: rows };
    });
  }

  /**
   * doc 05 routes requisition approval by amount, dimension or category; which
   * route applies is workflow configuration, but the state machine is not:
   * approval is the one gate between "someone wants this" and "an order may be
   * placed", and a rejected or already-converted requisition must not slip back
   * through it.
   */
  async approvePurchaseRequisition(principal: TenantPrincipal, id: string) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `SELECT id, legal_entity_id, requisition_number, requester_id, currency,
                estimated_total::text AS estimated_total, status::text AS status
           FROM purchase_requisitions WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const requisition = rows[0];
      if (!requisition) throw notFound('purchase requisition', id);
      assertEntityPermission(
        principal,
        'purchase_requisition.approve',
        requisition.legal_entity_id as string,
      );

      // Idempotent: the contract requires an Idempotency-Key on this route, and
      // a retried approval must not fail on its own success.
      const transition = requisitionApprovalTransition(requisition.status as string);
      if (transition.alreadyApproved) return requisition;

      const { rows: updated } = await client.query<Record<string, unknown>>(
        `UPDATE purchase_requisitions SET status = 'APPROVED'
          WHERE id = $1
          RETURNING id, legal_entity_id, requisition_number, requester_id, currency,
                    estimated_total::text AS estimated_total, status::text AS status`,
        [id],
      );

      await publish(client, context, {
        eventType: 'purchase_requisition.approved',
        aggregateType: 'purchase_requisition',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: requisition.legal_entity_id as string,
        payload: {
          requisition_number: requisition.requisition_number,
          estimated_total: requisition.estimated_total,
          approved_by: principal.userId,
        },
      });
      await recordAudit(client, context, {
        action: 'purchase_requisition.approved',
        resourceType: 'purchase_requisition',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: requisition.legal_entity_id as string,
        before: requisition,
        after: updated[0] as Record<string, unknown>,
      });

      return updated[0];
    });
  }

  // =========================================================================
  // Purchase orders
  // =========================================================================

  async createPurchaseOrder(
    principal: TenantPrincipal,
    input: {
      legalEntityId: string;
      branchId?: string | undefined;
      vendorId: string;
      requisitionId?: string | undefined;
      documentDate: string;
      expectedDate?: string | undefined;
      currency?: string | undefined;
      exchangeRate?: string | undefined;
      lines: readonly PurchaseOrderLineInput[];
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      assertEntityPermission(principal, 'purchase_order.create', input.legalEntityId);
      if (input.lines.length === 0) {
        throw new AppError('VALIDATION_FAILED', 'A purchase order with no lines orders nothing.');
      }

      const vendor = await this.ap.loadVendor(client, input.vendorId);
      const currency = input.currency ?? (vendor.default_currency as string | null);
      if (!currency) {
        throw new AppError(
          'VALIDATION_FAILED',
          'The order has no currency. Give the order one, or set default_currency on the vendor.',
          { details: { vendor_id: input.vendorId } },
        );
      }

      // An order raised against a requisition consumes it — and consumes it only
      // once it is APPROVED, because the requisition IS the spending authority
      // the order claims to have (doc 05). Converting a draft one would make the
      // approval route decorative.
      if (input.requisitionId) {
        const { rows: requisitions } = await client.query<Record<string, unknown>>(
          `SELECT id, legal_entity_id, status::text AS status
             FROM purchase_requisitions WHERE id = $1 FOR UPDATE`,
          [input.requisitionId],
        );
        const requisition = requisitions[0];
        if (!requisition) throw notFound('purchase requisition', input.requisitionId);
        if (requisition.legal_entity_id !== input.legalEntityId) {
          throw new AppError(
            'VALIDATION_FAILED',
            'The requisition belongs to a different legal entity than the order.',
          );
        }
        if (requisition.status !== 'APPROVED') {
          throw new AppError(
            'VALIDATION_FAILED',
            `Requisition ${input.requisitionId} is ${requisition.status}; only an APPROVED ` +
              'requisition carries the spending authority an order is issued under.',
            { details: { status: requisition.status } },
          );
        }
      }

      const { calculated } = await this.calculateLines(
        client,
        input.legalEntityId,
        currency,
        input.documentDate,
        input.lines.map((line, index) => ({
          lineNo: line.lineNo ?? index + 1,
          description: line.description,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          taxCodeId: line.taxCodeId,
          inclusive: line.inclusive,
        })),
      );

      const orderId = uuidv7();
      const poNumber = await this.ap.allocateDocumentNumber(
        client,
        principal,
        input.legalEntityId,
        'PO',
      );

      const { rows } = await client.query<Record<string, unknown>>(
        `INSERT INTO purchase_orders (id, tenant_id, legal_entity_id, branch_id, vendor_id,
                                      requisition_id, po_number, document_date, expected_date,
                                      currency, exchange_rate, subtotal, tax_total, total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9::date,$10,$11::numeric,$12::numeric,
                 $13::numeric,$14::numeric)
         RETURNING id, legal_entity_id, branch_id, vendor_id, requisition_id, po_number, revision,
                   document_date::text AS document_date, expected_date::text AS expected_date,
                   currency, exchange_rate::text AS exchange_rate, status::text AS status,
                   subtotal::text AS subtotal, tax_total::text AS tax_total, total::text AS total`,
        [
          orderId,
          principal.tenantId,
          input.legalEntityId,
          input.branchId ?? null,
          input.vendorId,
          input.requisitionId ?? null,
          poNumber,
          input.documentDate,
          input.expectedDate ?? null,
          currency,
          input.exchangeRate ?? null,
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
          `INSERT INTO purchase_order_lines (id, tenant_id, purchase_order_id, legal_entity_id,
                                             line_no, item_id, description, quantity_ordered, uom,
                                             unit_price, destination_account_id, tax_code_id,
                                             net_amount, tax_amount, gross_amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9,$10::numeric,$11,$12,$13::numeric,
                   $14::numeric,$15::numeric)`,
          [
            uuidv7(),
            principal.tenantId,
            orderId,
            input.legalEntityId,
            line.lineNo,
            source.itemId ?? null,
            source.description,
            line.quantity,
            source.uom ?? null,
            line.unitPrice,
            source.destinationAccountId ?? null,
            line.taxCodeId,
            line.netAmount,
            line.taxAmount,
            line.grossAmount,
          ],
        );
      }

      if (input.requisitionId) {
        await client.query(`UPDATE purchase_requisitions SET status = 'CONVERTED' WHERE id = $1`, [
          input.requisitionId,
        ]);
      }

      await recordAudit(client, context, {
        action: 'purchase_order.created',
        resourceType: 'purchase_order',
        resourceId: orderId,
        tenantId: principal.tenantId,
        legalEntityId: input.legalEntityId,
        after: rows[0] as Record<string, unknown>,
      });

      // The persisted lines, not the calculated ones (F-727). A goods receipt is
      // recorded against `purchase_order_line_id` and a bill against both that and
      // the receipt line, so a create response carrying a calculation with no row
      // ids leaves three-way matching unreachable for any caller that did not
      // write the rows itself.
      const { rows: lines } = await client.query(
        `SELECT id, line_no, item_id, description, quantity_ordered::text AS quantity_ordered,
                quantity_received::text AS quantity_received, uom,
                unit_price::text AS unit_price, destination_account_id, tax_code_id,
                net_amount::text AS net_amount, tax_amount::text AS tax_amount,
                gross_amount::text AS gross_amount
           FROM purchase_order_lines WHERE purchase_order_id = $1 ORDER BY line_no`,
        [orderId],
      );

      return { ...rows[0], lines };
    });
  }

  async listPurchaseOrders(
    principal: TenantPrincipal,
    filter: {
      legalEntityId?: string | undefined;
      vendorId?: string | undefined;
      status?: string | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT o.id, o.legal_entity_id, o.vendor_id, c.legal_name AS vendor_name, o.requisition_id,
                o.po_number, o.revision, o.document_date::text AS document_date,
                o.expected_date::text AS expected_date, o.currency, o.status::text AS status,
                o.subtotal::text AS subtotal, o.tax_total::text AS tax_total,
                o.total::text AS total, o.created_at
           FROM purchase_orders o
           JOIN contacts c ON c.id = o.vendor_id
          WHERE ($1::uuid IS NULL OR o.legal_entity_id = $1)
            AND ($2::uuid IS NULL OR o.vendor_id = $2)
            AND ($3::text IS NULL OR o.status::text = $3)
          ORDER BY o.document_date DESC
          LIMIT 200`,
        [filter.legalEntityId ?? null, filter.vendorId ?? null, filter.status ?? null],
      );
      return { data: rows };
    });
  }

  async approvePurchaseOrder(principal: TenantPrincipal, id: string) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `SELECT id, legal_entity_id, vendor_id, po_number, currency, total::text AS total,
                status::text AS status
           FROM purchase_orders WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const order = rows[0];
      if (!order) throw notFound('purchase order', id);
      assertEntityPermission(principal, 'purchase_order.approve', order.legal_entity_id as string);

      const transition = purchaseOrderApprovalTransition(order.status as string);
      if (transition.alreadyApproved) return order;

      const { rows: updated } = await client.query<Record<string, unknown>>(
        `UPDATE purchase_orders SET status = 'APPROVED'
          WHERE id = $1
          RETURNING id, legal_entity_id, vendor_id, po_number, currency, total::text AS total,
                    status::text AS status`,
        [id],
      );

      await publish(client, context, {
        eventType: 'purchase_order.approved',
        aggregateType: 'purchase_order',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: order.legal_entity_id as string,
        payload: {
          po_number: order.po_number,
          total: order.total,
          currency: order.currency,
          approved_by: principal.userId,
        },
      });
      await recordAudit(client, context, {
        action: 'purchase_order.approved',
        resourceType: 'purchase_order',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: order.legal_entity_id as string,
        before: order,
        after: updated[0] as Record<string, unknown>,
      });

      return updated[0];
    });
  }

  // =========================================================================
  // Vendor credits — F-711
  // =========================================================================

  /**
   * There is no vendor-credit line table: a credit's content IS its source
   * bill's lines, sign-inverted (see ApService.reloadLines). That is why the
   * source bill is mandatory and must already be posted — a posted bill's lines
   * are frozen by trigger, so what this credit will post is fixed at creation
   * rather than drifting with a draft, and why the credit's totals are copied
   * from the bill rather than accepted from the caller.
   */
  async createVendorCredit(
    principal: TenantPrincipal,
    input: {
      vendorBillId: string;
      documentDate: string;
      postingDate: string;
      reason?: string | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const bill = await this.ap.loadBill(client, input.vendorBillId, { forUpdate: true });
      assertEntityPermission(principal, 'vendor_credit.create', bill.legal_entity_id as string);

      if (!['POSTED', 'PARTIALLY_PAID', 'PAID'].includes(bill.status as string)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Bill ${input.vendorBillId} is ${bill.status}. A vendor credit posts the sign-inverse ` +
            'of its bill lines, and only a posted bill has lines that can no longer change.',
          { details: { status: bill.status } },
        );
      }

      const creditId = uuidv7();
      const creditNumber = await this.ap.allocateDocumentNumber(
        client,
        principal,
        bill.legal_entity_id as string,
        'VENDOR_CREDIT',
      );

      const { rows } = await client.query<Record<string, unknown>>(
        `INSERT INTO vendor_credits (id, tenant_id, legal_entity_id, accounting_book_id, vendor_id,
                                     vendor_bill_id, credit_number, document_date, posting_date,
                                     currency, exchange_rate, subtotal, tax_total, total,
                                     amount_available)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9::date,$10,$11::numeric,$12::numeric,
                 $13::numeric,$14::numeric,$14::numeric)
         RETURNING id, legal_entity_id, accounting_book_id, vendor_id, vendor_bill_id,
                   credit_number, document_date::text AS document_date,
                   posting_date::text AS posting_date, currency, status::text AS status,
                   subtotal::text AS subtotal, tax_total::text AS tax_total, total::text AS total,
                   amount_applied::text AS amount_applied,
                   amount_available::text AS amount_available`,
        [
          creditId,
          principal.tenantId,
          bill.legal_entity_id,
          bill.accounting_book_id,
          bill.vendor_id,
          input.vendorBillId,
          creditNumber,
          input.documentDate,
          input.postingDate,
          bill.currency,
          bill.exchange_rate ?? null,
          bill.subtotal,
          bill.tax_total,
          bill.total,
        ],
      );

      await recordAudit(client, context, {
        action: 'vendor_credit.created',
        resourceType: 'vendor_credit',
        resourceId: creditId,
        tenantId: principal.tenantId,
        legalEntityId: bill.legal_entity_id as string,
        after: { ...(rows[0] as Record<string, unknown>), reason: input.reason ?? null },
      });

      return rows[0];
    });
  }

  async listVendorCredits(
    principal: TenantPrincipal,
    filter: {
      legalEntityId?: string | undefined;
      vendorId?: string | undefined;
      status?: string | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT v.id, v.legal_entity_id, v.vendor_id, c.legal_name AS vendor_name,
                v.vendor_bill_id, v.credit_number, v.document_date::text AS document_date,
                v.posting_date::text AS posting_date, v.currency, v.status::text AS status,
                v.total::text AS total, v.amount_applied::text AS amount_applied,
                v.amount_available::text AS amount_available, v.accounting_entry_id
           FROM vendor_credits v
           JOIN contacts c ON c.id = v.vendor_id
          WHERE ($1::uuid IS NULL OR v.legal_entity_id = $1)
            AND ($2::uuid IS NULL OR v.vendor_id = $2)
            AND ($3::text IS NULL OR v.status::text = $3)
          ORDER BY v.document_date DESC
          LIMIT 200`,
        [filter.legalEntityId ?? null, filter.vendorId ?? null, filter.status ?? null],
      );
      return { data: rows };
    });
  }

  /**
   * Posts a vendor credit: the vendor-bill rule with the sign inverted.
   *
   *   Dr Accounts Payable        — gross
   *   Cr Destination             — net (+ non-recoverable tax), by line
   *   Cr Recoverable Input Tax   — by component
   *
   * The same `vendorBillLines` builds both documents, so the credit can never
   * disagree with the bill about which account moves — the failure a hand-rolled
   * "reverse" implementation invites.
   */
  async postVendorCredit(principal: TenantPrincipal, id: string) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const credit = await this.loadCredit(client, id, { forUpdate: true });
      assertEntityPermission(principal, 'vendor_credit.post', credit.legal_entity_id as string);

      if (credit.status === 'POSTED') return credit;
      if (!['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(credit.status as string)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `This vendor credit is ${credit.status} and cannot be posted.`,
        );
      }
      if (!credit.vendor_bill_id) {
        throw new AppError(
          'VALIDATION_FAILED',
          'This credit has no source bill, so there are no lines to invert.',
        );
      }

      const bill = await this.ap.loadBill(client, credit.vendor_bill_id as string);
      const book = await this.posting.loadBookContext(
        client,
        principal,
        credit.accounting_book_id as string,
        credit.posting_date as string,
      );

      const { calculated, codes, destinationByLine, dimensionsByLine } = await this.ap.reloadLines(
        client,
        bill,
      );
      // The bill's lines are frozen once posted, so this only fires if the
      // credit was created against a different bill state than exists now —
      // which is exactly the case that must not post.
      if (
        !D(calculated.total)
          .sub(D(credit.total as string))
          .isZero()
      ) {
        throw new AppError(
          'VALIDATION_FAILED',
          `The source bill's lines produce ${calculated.total}, but this credit was created ` +
            `for ${credit.total}. The two no longer describe the same document.`,
        );
      }

      const apAccountId = await this.ap.resolveApAccount(
        client,
        { vendor_id: credit.vendor_id, posting_date: credit.posting_date },
        book,
      );
      const taxAccounts = new Map<string, string>();
      for (const code of codes.values()) {
        for (const component of code.components) {
          if (code.receivableAccountId) taxAccounts.set(component.id, code.receivableAccountId);
        }
      }

      const exchangeRate = (credit.exchange_rate as string | null) ?? '1';
      const lines = vendorBillLines({
        calculated,
        destinationAccountByLine: destinationByLine,
        taxAccountByComponent: taxAccounts,
        apAccountId,
        currency: credit.currency as string,
        exchangeRate,
        exchangeRateDate: (bill.exchange_rate_date as string) ?? null,
        contactId: credit.vendor_id as string,
        dimensionsByLine,
        sign: -1,
      });

      const result = await this.documents.post(client, context, principal, book, {
        ruleCode: 'VENDOR_CREDIT_POSTED',
        sourceType: 'vendor_credit',
        sourceId: id,
        sourceEventId: `vendor_credit.posted:${id}`,
        journalCode: 'PUR',
        postingDate: credit.posting_date as string,
        documentDate: credit.document_date as string,
        description: `Vendor credit ${credit.credit_number ?? ''}`.trim(),
        branchId: (bill.branch_id as string) ?? null,
        contactId: credit.vendor_id as string,
        lines,
        tax: {
          calculated,
          codes,
          direction: 'INPUT',
          // Sign -1: the credit takes back the input tax the bill claimed, in
          // the same subledger the return is built from.
          sign: -1,
          currency: credit.currency as string,
          exchangeRate,
        },
      });

      const { rows } = await client.query<Record<string, unknown>>(
        `UPDATE vendor_credits SET status = 'POSTED', accounting_entry_id = $2
          WHERE id = $1
          RETURNING id, credit_number, vendor_bill_id, status::text AS status,
                    total::text AS total, amount_available::text AS amount_available,
                    accounting_entry_id`,
        [id, result.entry.id],
      );

      await publish(client, context, {
        eventType: 'vendor_credit.posted',
        aggregateType: 'vendor_credit',
        aggregateId: id,
        tenantId: principal.tenantId,
        organizationId: book.organizationId,
        legalEntityId: credit.legal_entity_id as string,
        accountingBookId: book.bookId,
        payload: {
          vendor_id: credit.vendor_id,
          total: credit.total,
          currency: credit.currency,
          journal_entry_id: result.entry.id,
        },
      });

      return {
        ...rows[0],
        journal_entry: { id: result.entry.id, entry_number: result.entry.entry_number },
      };
    });
  }

  /**
   * Applies available credit to open bills, under the same protocol as every
   * other allocation: lock the source, lock the targets in ascending id order,
   * validate the whole set at once, then apply.
   *
   * Validating the set — not each request — is what refuses two applications
   * that each fit individually and together do not (Gate G's failure mode). The
   * deferred trigger on vendor_credit_applications backstops the same rule at
   * COMMIT for anything that reaches the table another way.
   */
  async applyVendorCredit(
    principal: TenantPrincipal,
    id: string,
    allocations: ReadonlyArray<{ vendorBillId: string; amount: string }>,
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const credit = await this.loadCredit(client, id, { forUpdate: true });
      assertEntityPermission(principal, 'vendor_credit.apply', credit.legal_entity_id as string);

      if (credit.status !== 'POSTED') {
        throw new AppError(
          'VALIDATION_FAILED',
          `This vendor credit is ${credit.status}; only a posted credit holds value to apply.`,
        );
      }
      if (allocations.length === 0) {
        throw new AppError('VALIDATION_FAILED', 'No applications were given.');
      }

      const requests: AllocationRequest[] = allocations.map((a) => ({
        targetType: 'VENDOR_BILL',
        targetId: a.vendorBillId,
        amount: a.amount,
      }));
      const targets = await lockTargets(client, principal, requests);

      // A credit is an obligation from one vendor; applying it to another
      // vendor's bill would settle a debt with money the vendor never owed us.
      const { rows: bills } = await client.query<{ id: string; vendor_id: string }>(
        `SELECT id, vendor_id FROM vendor_bills WHERE id = ANY($1::uuid[])`,
        [allocations.map((a) => a.vendorBillId)],
      );
      for (const bill of bills) {
        if (bill.vendor_id !== credit.vendor_id) {
          throw new AppError(
            'VALIDATION_FAILED',
            `Bill ${bill.id} belongs to a different vendor than this credit.`,
            { details: { bill_id: bill.id } },
          );
        }
      }
      for (const target of targets.values()) {
        if (target.legalEntityId !== credit.legal_entity_id) {
          throw new AppError(
            'CROSS_ENTITY_REFERENCE',
            `Bill ${target.id} belongs to a different legal entity than this credit.`,
          );
        }
      }

      validateAllocations({
        sourceUnapplied: credit.amount_available as string,
        sourceCurrency: credit.currency as string,
        requests,
        targets,
        documentLabel: (t) => `bill ${t.id}`,
      });

      const book = await this.posting.loadBookContext(
        client,
        principal,
        credit.accounting_book_id as string,
        credit.posting_date as string,
      );
      const exchangeRate = (credit.exchange_rate as string | null) ?? '1';

      let total = Money.zero(credit.currency as string);
      for (const request of requests) {
        const target = targets.get(request.targetId)!;
        await client.query(
          `INSERT INTO vendor_credit_applications (id, tenant_id, vendor_credit_id, vendor_bill_id,
                                                   amount, base_amount, applied_by)
           VALUES ($1,$2,$3,$4,$5::numeric,$6::numeric,$7)`,
          [
            uuidv7(),
            principal.tenantId,
            id,
            request.targetId,
            request.amount,
            toBase(request.amount, exchangeRate, credit.currency as string, book.baseCurrency),
            principal.userId,
          ],
        );
        await applyToTarget(client, target, request.amount, 'amount_credited');
        total = total.add(Money.of(D(request.amount), credit.currency as string));
      }

      // amount_available is written from its full definition rather than
      // decremented: every SET expression evaluates against the OLD row.
      const { rows: updated } = await client.query<Record<string, unknown>>(
        `UPDATE vendor_credits
            SET amount_applied = amount_applied + $2::numeric,
                amount_available = total - (amount_applied + $2::numeric)
          WHERE id = $1
          RETURNING id, credit_number, amount_applied::text AS amount_applied,
                    amount_available::text AS amount_available`,
        [id, total.toString()],
      );

      await recordAudit(client, context, {
        action: 'vendor_credit.applied',
        resourceType: 'vendor_credit',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: credit.legal_entity_id as string,
        after: { applied: total.toString(), targets: allocations.length },
      });

      return { ...updated[0], applied_now: total.toString() };
    });
  }

  // =========================================================================
  // Expense claims — F-714
  // =========================================================================

  async createExpenseClaim(
    principal: TenantPrincipal,
    input: {
      accountingBookId: string;
      claimantUserId?: string | undefined;
      documentDate: string;
      currency?: string | undefined;
      lines: readonly ExpenseItemInput[];
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const book = await this.posting.loadBookContext(
        client,
        principal,
        input.accountingBookId,
        input.documentDate,
      );
      assertEntityPermission(principal, 'expense_claim.create', book.legalEntityId);
      if (input.lines.length === 0) {
        throw new AppError('VALIDATION_FAILED', 'An expense claim with no items claims nothing.');
      }

      const currency = input.currency ?? book.baseCurrency;
      const { calculated } = await this.calculateClaimItems(
        client,
        book.legalEntityId,
        currency,
        input.documentDate,
        input.lines,
      );

      const claimId = uuidv7();
      const claimNumber = await this.ap.allocateDocumentNumber(
        client,
        principal,
        book.legalEntityId,
        'EXPENSE_CLAIM',
      );

      const { rows } = await client.query<Record<string, unknown>>(
        `INSERT INTO expense_claims (id, tenant_id, legal_entity_id, accounting_book_id,
                                     claimant_user_id, claim_number, document_date, currency, total)
         VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9::numeric)
         RETURNING id, legal_entity_id, accounting_book_id, claimant_user_id, claim_number,
                   document_date::text AS document_date, currency, total::text AS total,
                   status::text AS status`,
        [
          claimId,
          principal.tenantId,
          book.legalEntityId,
          book.bookId,
          input.claimantUserId ?? principal.userId,
          claimNumber,
          input.documentDate,
          currency,
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
          `INSERT INTO expense_items (id, tenant_id, expense_claim_id, legal_entity_id, line_no,
                                      expense_date, merchant, category, business_purpose, currency,
                                      amount, expense_account_id, tax_code_id, tax_amount,
                                      receipt_file_id, is_company_card)
           VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11::numeric,$12,$13,$14::numeric,$15,
                   coalesce($16,false))`,
          [
            uuidv7(),
            principal.tenantId,
            claimId,
            book.legalEntityId,
            line.lineNo,
            source.expenseDate,
            source.merchant ?? null,
            source.category ?? null,
            source.businessPurpose ?? null,
            currency,
            source.amount,
            source.expenseAccountId,
            line.taxCodeId,
            line.taxAmount,
            source.receiptFileId ?? null,
            source.isCompanyCard ?? null,
          ],
        );
      }

      await recordAudit(client, context, {
        action: 'expense_claim.created',
        resourceType: 'expense_claim',
        resourceId: claimId,
        tenantId: principal.tenantId,
        legalEntityId: book.legalEntityId,
        after: rows[0] as Record<string, unknown>,
      });

      return { ...rows[0], lines: calculated.lines };
    });
  }

  async listExpenseClaims(
    principal: TenantPrincipal,
    filter: {
      legalEntityId?: string | undefined;
      claimantUserId?: string | undefined;
      status?: string | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT id, legal_entity_id, accounting_book_id, claimant_user_id, claim_number,
                document_date::text AS document_date, posting_date::text AS posting_date, currency,
                total::text AS total, status::text AS status, accounting_entry_id, reimbursed_at,
                created_at
           FROM expense_claims
          WHERE ($1::uuid IS NULL OR legal_entity_id = $1)
            AND ($2::uuid IS NULL OR claimant_user_id = $2)
            AND ($3::text IS NULL OR status::text = $3)
          ORDER BY created_at DESC
          LIMIT 200`,
        [filter.legalEntityId ?? null, filter.claimantUserId ?? null, filter.status ?? null],
      );
      return { data: rows };
    });
  }

  /**
   * Runs doc 05's policy engine — missing receipt, weekend risk, duplicate
   * against the claimant's other claims — and records the flags on the items.
   * The flags inform the approver; they do not block, because a weekend expense
   * with a reason is ordinary and a policy that blocks it just teaches people to
   * re-date receipts.
   */
  async submitExpenseClaim(principal: TenantPrincipal, id: string) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const claim = await this.loadClaim(client, id);

      // Self-service on the claimant's own claim; submitting someone else's
      // needs the permission (the contract states this split on the route).
      if (claim.claimant_user_id !== principal.userId) {
        assertEntityPermission(principal, 'expense_claim.submit', claim.legal_entity_id as string);
      }

      const transition = expenseClaimTransition(claim.status as string, 'SUBMIT');
      if (transition.already) return claim;

      const items = await this.loadClaimItems(client, id);
      for (const item of items) {
        const { rows: prior } = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n
             FROM expense_items i
             JOIN expense_claims c ON c.id = i.expense_claim_id
            WHERE c.claimant_user_id = $1 AND c.id <> $2 AND c.status <> 'REJECTED'
              AND i.expense_date = $3::date AND i.amount = $4::numeric
              AND coalesce(i.merchant, '') = coalesce($5, '')`,
          [claim.claimant_user_id, id, item.expense_date, item.amount, item.merchant],
        );
        const withinClaim = items.filter(
          (other) =>
            other.id !== item.id &&
            other.expense_date === item.expense_date &&
            other.amount === item.amount &&
            (other.merchant ?? '') === (item.merchant ?? ''),
        ).length;
        const flags = expensePolicyFlags(
          { expenseDate: item.expense_date, receiptFileId: item.receipt_file_id },
          (prior[0]?.n ?? 0) + withinClaim,
        );
        await client.query(`UPDATE expense_items SET policy_flags = $2::jsonb WHERE id = $1`, [
          item.id,
          JSON.stringify(flags),
        ]);
      }

      const { rows: updated } = await client.query<Record<string, unknown>>(
        `UPDATE expense_claims SET status = 'SUBMITTED'
          WHERE id = $1
          RETURNING id, claim_number, claimant_user_id, total::text AS total, currency,
                    status::text AS status`,
        [id],
      );

      await publish(client, context, {
        eventType: 'expense_claim.submitted',
        aggregateType: 'expense_claim',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: claim.legal_entity_id as string,
        accountingBookId: claim.accounting_book_id as string,
        payload: { claim_number: claim.claim_number, total: claim.total },
      });
      await recordAudit(client, context, {
        action: 'expense_claim.submitted',
        resourceType: 'expense_claim',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: claim.legal_entity_id as string,
        before: claim,
        after: updated[0] as Record<string, unknown>,
      });

      return updated[0];
    });
  }

  /**
   * doc 14 SoD: the claimant may never approve their own claim. That separation
   * is the entire control — everything else on this route is bookkeeping. It is
   * checked before the idempotency shortcut so that a claimant retrying their
   * own forbidden approval is refused every time, not just the first.
   */
  async approveExpenseClaim(principal: TenantPrincipal, id: string) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const claim = await this.loadClaim(client, id);
      assertEntityPermission(principal, 'expense_claim.approve', claim.legal_entity_id as string);

      assertNotSelfApproval({
        approverId: principal.userId,
        ownerId: claim.claimant_user_id as string,
        ownerRole: 'claimant of an expense claim',
      });

      const transition = expenseClaimTransition(claim.status as string, 'APPROVE');
      if (transition.already) return claim;

      const { rows: updated } = await client.query<Record<string, unknown>>(
        `UPDATE expense_claims SET status = 'APPROVED'
          WHERE id = $1
          RETURNING id, claim_number, claimant_user_id, total::text AS total, currency,
                    status::text AS status`,
        [id],
      );

      await publish(client, context, {
        eventType: 'expense_claim.approved',
        aggregateType: 'expense_claim',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: claim.legal_entity_id as string,
        accountingBookId: claim.accounting_book_id as string,
        payload: {
          claim_number: claim.claim_number,
          total: claim.total,
          approved_by: principal.userId,
        },
      });
      // expense_claims has no approved_by column; the audit record is where the
      // approver's identity lives, which is also where an SoD review reads it.
      await recordAudit(client, context, {
        action: 'expense_claim.approved',
        resourceType: 'expense_claim',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: claim.legal_entity_id as string,
        before: claim,
        after: { ...(updated[0] as Record<string, unknown>), approved_by: principal.userId },
      });

      return updated[0];
    });
  }

  /**
   * Posts an approved claim:
   *
   *   Dr Expense (per item)      — net + non-recoverable tax
   *   Dr Recoverable Input Tax   — by component
   *   Cr Payable to the employee — gross
   *
   * Items are inclusive of tax — the employee paid the gross — and the
   * non-recoverable half capitalises into the expense line exactly as a vendor
   * bill's does, because it is the same `vendorBillLines` builder.
   *
   * The credit side: accounting_policies has no employee-payable account, and
   * the schema's reimbursement path (vendor_payments) pays contacts. So the
   * employee is treated as a vendor: pass employeeVendorId to credit that
   * contact's AP account (falling back to the AP control account) with the
   * contact on the line; without one, the credit lands on the AP control account
   * and the claim itself is the subledger detail behind it.
   */
  async postExpenseClaim(
    principal: TenantPrincipal,
    id: string,
    input: { postingDate?: string | undefined; employeeVendorId?: string | undefined } = {},
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const claim = await this.loadClaim(client, id);
      assertEntityPermission(principal, 'expense_claim.post', claim.legal_entity_id as string);

      const transition = expenseClaimTransition(claim.status as string, 'POST');
      if (transition.already) return claim;

      const postingDate =
        input.postingDate ??
        (claim.posting_date as string | null) ??
        (claim.document_date as string);
      const book = await this.posting.loadBookContext(
        client,
        principal,
        claim.accounting_book_id as string,
        postingDate,
      );
      const exchangeRate = await this.ap.resolveRate(
        client,
        claim.currency as string,
        book.baseCurrency,
        undefined,
        postingDate,
      );

      const items = await this.loadClaimItems(client, id);
      const { calculated, codes } = await this.calculateClaimItems(
        client,
        claim.legal_entity_id as string,
        claim.currency as string,
        claim.document_date as string,
        items.map((item) => ({
          lineNo: item.line_no,
          expenseDate: item.expense_date,
          merchant: item.merchant ?? undefined,
          category: item.category ?? undefined,
          amount: item.amount,
          expenseAccountId: item.expense_account_id,
          taxCodeId: item.tax_code_id ?? undefined,
        })),
      );

      const destinationByLine = new Map<number, string>(
        items.map((item) => [item.line_no, item.expense_account_id]),
      );
      const taxAccounts = new Map<string, string>();
      for (const code of codes.values()) {
        for (const component of code.components) {
          if (code.receivableAccountId) taxAccounts.set(component.id, code.receivableAccountId);
        }
      }

      let employeeApAccountId: string | null = null;
      let employeeContactId: string | null = null;
      if (input.employeeVendorId) {
        const vendor = await this.ap.loadVendor(client, input.employeeVendorId);
        employeeContactId = vendor.id as string;
        employeeApAccountId = (vendor.ap_account_id as string | null) ?? null;
      }
      const apAccountId =
        employeeApAccountId ??
        (await this.ap.policyAccount(
          client,
          book.legalEntityId,
          'ap_control_account_id',
          postingDate,
        ));
      if (!apAccountId) {
        throw new AppError(
          'VALIDATION_FAILED',
          'No payable account is configured for the employee. Set ap_control_account_id on the ' +
            'accounting policy, or pass an employee vendor contact with an ap_account_id.',
          { details: { legal_entity_id: book.legalEntityId } },
        );
      }

      const draftLines = vendorBillLines({
        calculated,
        destinationAccountByLine: destinationByLine,
        taxAccountByComponent: taxAccounts,
        apAccountId,
        currency: claim.currency as string,
        exchangeRate,
        exchangeRateDate: postingDate,
        contactId: employeeContactId ?? '',
      });
      // journal_lines.contact_id references contacts, and the claimant is a
      // user. Without an employee vendor contact the payable line carries no
      // contact — the claim itself is the drill-down — rather than a uuid the
      // FK would reject.
      const lines = employeeContactId
        ? draftLines
        : draftLines.map(({ contactId: _ignored, ...rest }) => rest);

      const result = await this.documents.post(client, context, principal, book, {
        ruleCode: 'EXPENSE_CLAIM_POSTED',
        sourceType: 'expense_claim',
        sourceId: id,
        sourceEventId: `expense_claim.posted:${id}`,
        journalCode: 'PUR',
        postingDate,
        documentDate: claim.document_date as string,
        description: `Expense claim ${claim.claim_number ?? ''}`.trim(),
        branchId: null,
        contactId: employeeContactId,
        lines,
        tax: {
          calculated,
          codes,
          direction: 'INPUT',
          sign: 1,
          currency: claim.currency as string,
          exchangeRate,
        },
      });

      const { rows: updated } = await client.query<Record<string, unknown>>(
        `UPDATE expense_claims
            SET status = 'POSTED', posting_date = $2::date, accounting_entry_id = $3
          WHERE id = $1
          RETURNING id, claim_number, claimant_user_id, total::text AS total, currency,
                    posting_date::text AS posting_date, status::text AS status,
                    accounting_entry_id`,
        [id, postingDate, result.entry.id],
      );

      await publish(client, context, {
        eventType: 'expense_claim.posted',
        aggregateType: 'expense_claim',
        aggregateId: id,
        tenantId: principal.tenantId,
        organizationId: book.organizationId,
        legalEntityId: claim.legal_entity_id as string,
        accountingBookId: book.bookId,
        payload: {
          claim_number: claim.claim_number,
          total: claim.total,
          currency: claim.currency,
          journal_entry_id: result.entry.id,
        },
      });

      return {
        ...updated[0],
        journal_entry: { id: result.entry.id, entry_number: result.entry.entry_number },
      };
    });
  }

  // =========================================================================
  // Payment runs — doc 05 step 6, doc 14 SoD
  // =========================================================================

  /**
   * Builds a run from the bills due: same entity and currency, due on or before
   * the cutoff, posted with a balance, not under a hold on the bill or its
   * vendor, not blocked by an unresolved match exception, and not already
   * reserved by another pending run.
   *
   * One payment per vendor, one allocation per bill. The allocations are
   * recorded now — so the approver approves a specific set of bills, and a
   * second run built before this one executes cannot select the same balances —
   * but they are applied only at execution, because until then no money has
   * been promised to anyone.
   */
  async createPaymentRun(
    principal: TenantPrincipal,
    input: {
      accountingBookId: string;
      paymentDate: string;
      currency: string;
      bankAccountId?: string | undefined;
      dueOnOrBefore?: string | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const book = await this.posting.loadBookContext(
        client,
        principal,
        input.accountingBookId,
        input.paymentDate,
      );
      assertEntityPermission(principal, 'payment_run.create', book.legalEntityId);

      const exchangeRate = await this.ap.resolveRate(
        client,
        input.currency,
        book.baseCurrency,
        undefined,
        input.paymentDate,
      );
      const dueOnOrBefore = input.dueOnOrBefore ?? input.paymentDate;

      const { rows: candidates } = await client.query<RunCandidateBill>(
        `SELECT b.id, b.vendor_id, b.currency, b.status::text AS status, b.on_hold,
                b.due_date::text AS due_date, b.amount_due::text AS amount_due
           FROM vendor_bills b
          WHERE b.legal_entity_id = $1
            AND b.currency = $2
            AND b.status IN ('POSTED','PARTIALLY_PAID')
            AND b.amount_due > 0
            AND b.due_date <= $3::date
            AND NOT b.on_hold
            AND NOT EXISTS (SELECT 1 FROM match_exceptions e
                              JOIN bill_matches m ON m.id = e.bill_match_id
                             WHERE m.vendor_bill_id = b.id AND e.blocks_payment
                               AND e.resolved_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM payment_allocations pa
                              JOIN vendor_payments vp ON vp.id = pa.vendor_payment_id
                             WHERE pa.target_id = b.id AND pa.target_type = 'VENDOR_BILL'
                               AND vp.status = 'DRAFT')
          ORDER BY b.id`,
        [book.legalEntityId, input.currency, dueOnOrBefore],
      );

      const { data: holds } = await this.ap.listHolds(principal, { active: true });
      const eligible = selectBillsForRun({
        bills: candidates,
        holds: holds as ActiveHold[],
        currency: input.currency,
        dueOnOrBefore,
      });

      // Lock the selected bills so the balances the run is built on are the
      // balances it will pay. Ascending id order, as everywhere (ADR-0004).
      const targets = await lockTargets(
        client,
        principal,
        eligible.map((bill) => ({
          targetType: 'VENDOR_BILL' as const,
          targetId: bill.id,
          amount: '0',
        })),
      );

      const runId = uuidv7();
      const runNumber = await this.ap.allocateDocumentNumber(
        client,
        principal,
        book.legalEntityId,
        'PAYMENT_RUN',
      );

      const byVendor = new Map<string, RunCandidateBill[]>();
      for (const bill of eligible) {
        const list = byVendor.get(bill.vendor_id) ?? [];
        list.push(bill);
        byVendor.set(bill.vendor_id, list);
      }

      let runTotal = Money.zero(input.currency);
      const payments: Array<Record<string, unknown>> = [];
      for (const [vendorId, bills] of byVendor) {
        let amount = Money.zero(input.currency);
        for (const bill of bills) {
          amount = amount.add(Money.of(D(targets.get(bill.id)!.amountDue), input.currency));
        }

        const paymentId = uuidv7();
        const paymentNumber = await this.ap.allocateDocumentNumber(
          client,
          principal,
          book.legalEntityId,
          'PAYMENT',
        );
        await client.query(
          `INSERT INTO vendor_payments (id, tenant_id, legal_entity_id, accounting_book_id,
                                        vendor_id, payment_run_id, payment_number, document_date,
                                        posting_date, currency, amount, exchange_rate,
                                        exchange_rate_date, base_amount, unapplied_amount,
                                        bank_account_id, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$8::date,$9,$10::numeric,$11::numeric,$8::date,
                   $12::numeric,$10::numeric,$13,'DRAFT')`,
          [
            paymentId,
            principal.tenantId,
            book.legalEntityId,
            book.bookId,
            vendorId,
            runId,
            paymentNumber,
            input.paymentDate,
            input.currency,
            amount.toString(),
            exchangeRate,
            toBase(amount.toString(), exchangeRate, input.currency, book.baseCurrency),
            input.bankAccountId ?? null,
          ],
        );

        for (const bill of bills) {
          const target = targets.get(bill.id)!;
          await recordAllocation(client, principal, {
            table: 'payment_allocations',
            sourceColumn: 'vendor_payment_id',
            sourceId: paymentId,
            target,
            amount: target.amountDue,
            settlementRate: exchangeRate,
            baseCurrency: book.baseCurrency,
          });
        }

        runTotal = runTotal.add(amount);
        payments.push({
          id: paymentId,
          vendor_id: vendorId,
          payment_number: paymentNumber,
          amount: amount.toString(),
          bills: bills.map((bill) => ({
            vendor_bill_id: bill.id,
            amount: targets.get(bill.id)!.amountDue,
          })),
        });
      }

      const { rows } = await client.query<Record<string, unknown>>(
        `INSERT INTO payment_runs (id, tenant_id, legal_entity_id, accounting_book_id, run_number,
                                   bank_account_id, payment_date, currency, total_amount,
                                   created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9::numeric,$10)
         RETURNING id, legal_entity_id, accounting_book_id, run_number, bank_account_id,
                   payment_date::text AS payment_date, currency,
                   total_amount::text AS total_amount, status::text AS status, created_by`,
        [
          runId,
          principal.tenantId,
          book.legalEntityId,
          book.bookId,
          runNumber,
          input.bankAccountId ?? null,
          input.paymentDate,
          input.currency,
          runTotal.toString(),
          principal.userId,
        ],
      );

      await recordAudit(client, context, {
        action: 'payment_run.created',
        resourceType: 'payment_run',
        resourceId: runId,
        tenantId: principal.tenantId,
        legalEntityId: book.legalEntityId,
        after: { ...(rows[0] as Record<string, unknown>), payments: payments.length },
      });

      return { ...rows[0], payments };
    });
  }

  async listPaymentRuns(
    principal: TenantPrincipal,
    filter: { legalEntityId?: string | undefined; status?: string | undefined },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT id, legal_entity_id, accounting_book_id, run_number, bank_account_id,
                payment_date::text AS payment_date, currency, total_amount::text AS total_amount,
                status::text AS status, approved_by, approved_at, second_approved_by,
                second_approved_at, executed_at, created_by, created_at
           FROM payment_runs
          WHERE ($1::uuid IS NULL OR legal_entity_id = $1)
            AND ($2::text IS NULL OR status::text = $2)
          ORDER BY created_at DESC
          LIMIT 200`,
        [filter.legalEntityId ?? null, filter.status ?? null],
      );
      return { data: rows };
    });
  }

  /**
   * doc 14 SoD, both halves. The creator never approves their own run
   * (maker-checker, and the schema CHECKs it too), and a run over the policy's
   * dual-approval threshold needs a second, different approver before it may
   * execute. The first approval of such a run parks it in APPROVAL_PENDING —
   * approved by one person is not approved.
   */
  async approvePaymentRun(principal: TenantPrincipal, id: string) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `SELECT id, legal_entity_id, run_number, payment_date::text AS payment_date, currency,
                total_amount::text AS total_amount, status::text AS status, approved_by,
                second_approved_by, created_by
           FROM payment_runs WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const run = rows[0];
      if (!run) throw notFound('payment run', id);
      assertEntityPermission(principal, 'payment_run.approve', run.legal_entity_id as string);

      // policyAccount reads one effective-dated policy column; the threshold is
      // numeric, not an account, but the plumbing is identical.
      const threshold = await this.ap.policyAccount(
        client,
        run.legal_entity_id as string,
        'payment_dual_approval_threshold',
        run.payment_date as string,
      );

      const decision = paymentRunApprovalDecision({
        status: run.status as string,
        createdBy: (run.created_by as string) ?? null,
        approvedBy: (run.approved_by as string) ?? null,
        approverId: principal.userId,
        totalAmount: run.total_amount as string,
        dualApprovalThreshold: threshold,
      });
      if (decision.kind === 'ALREADY_APPROVED') return run;

      const { rows: updated } =
        decision.kind === 'FIRST'
          ? await client.query<Record<string, unknown>>(
              `UPDATE payment_runs
                  SET approved_by = $2, approved_at = now(), status = $3::payment_run_status
                WHERE id = $1
                RETURNING id, run_number, status::text AS status, approved_by, second_approved_by,
                          total_amount::text AS total_amount`,
              [id, principal.userId, decision.nextStatus],
            )
          : await client.query<Record<string, unknown>>(
              `UPDATE payment_runs
                  SET second_approved_by = $2, second_approved_at = now(), status = 'APPROVED'
                WHERE id = $1
                RETURNING id, run_number, status::text AS status, approved_by, second_approved_by,
                          total_amount::text AS total_amount`,
              [id, principal.userId],
            );
      const after = updated[0]!;

      if (after.status === 'APPROVED') {
        await publish(client, context, {
          eventType: 'payment_run.approved',
          aggregateType: 'payment_run',
          aggregateId: id,
          tenantId: principal.tenantId,
          legalEntityId: run.legal_entity_id as string,
          payload: {
            run_number: run.run_number,
            total_amount: run.total_amount,
            currency: run.currency,
            approved_by: after.approved_by,
            second_approved_by: after.second_approved_by,
          },
        });
      }
      await recordAudit(client, context, {
        action: decision.kind === 'FIRST' ? 'payment_run.approved' : 'payment_run.second_approved',
        resourceType: 'payment_run',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: run.legal_entity_id as string,
        before: run,
        after,
      });

      return after;
    });
  }

  /**
   * Executes an approved run: applies each payment's recorded allocations to
   * its bills and marks the payment SENT.
   *
   * Idempotent by construction — only DRAFT payments are processed, and a
   * completed run short-circuits — so executing twice cannot pay a bill twice.
   * Holds are re-read at execution: a hold placed after approval still stops
   * the money, which is the entire point of a hold. A payment whose bills no
   * longer carry the balance the run reserved (paid by other means in the
   * window) is cancelled with the reason recorded, not force-fitted.
   */
  async executePaymentRun(principal: TenantPrincipal, id: string) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `SELECT id, legal_entity_id, accounting_book_id, run_number, currency,
                payment_date::text AS payment_date, total_amount::text AS total_amount,
                status::text AS status
           FROM payment_runs WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const run = rows[0];
      if (!run) throw notFound('payment run', id);
      assertEntityPermission(principal, 'payment_run.execute', run.legal_entity_id as string);

      if (run.status === 'COMPLETED') return { ...run, executed: 0, cancelled: 0 };
      if (run.status !== 'APPROVED') {
        throw new AppError(
          'VALIDATION_FAILED',
          `This payment run is ${run.status}; only an APPROVED run may be executed. Approval is ` +
            'the control that stands between building a run and money leaving.',
          { details: { status: run.status } },
        );
      }

      const book = await this.posting.loadBookContext(
        client,
        principal,
        run.accounting_book_id as string,
        run.payment_date as string,
      );

      const { rows: paymentRows } = await client.query<{
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
        unapplied_amount: string;
        status: string;
      }>(
        `SELECT id, vendor_id, payment_number, currency, amount::text AS amount,
                exchange_rate::text AS exchange_rate, document_date::text AS document_date,
                posting_date::text AS posting_date, bank_account_id, branch_id,
                unapplied_amount::text AS unapplied_amount, status::text AS status
           FROM vendor_payments WHERE payment_run_id = $1 ORDER BY id FOR UPDATE`,
        [id],
      );

      const { data: holdRows } = await this.ap.listHolds(principal, { active: true });
      const holds = holdRows as ActiveHold[];
      const heldVendors = new Set(
        holds.filter((h) => !h.released_at && h.scope_type === 'VENDOR').map((h) => h.scope_id),
      );
      const heldBills = new Set(
        holds
          .filter((h) => !h.released_at && h.scope_type === 'VENDOR_BILL')
          .map((h) => h.scope_id),
      );

      let executed = 0;
      let cancelled = 0;
      const outcomes: Array<Record<string, unknown>> = [];

      for (const payment of paymentsToExecute(paymentRows)) {
        const { rows: allocations } = await client.query<{
          id: string;
          target_id: string;
          amount: string;
          realized_fx_amount: string;
        }>(
          `SELECT id, target_id, amount::text AS amount,
                  realized_fx_amount::text AS realized_fx_amount
             FROM payment_allocations
            WHERE vendor_payment_id = $1 AND target_type = 'VENDOR_BILL'
            ORDER BY target_id`,
          [payment.id],
        );
        const requests: AllocationRequest[] = allocations.map((a) => ({
          targetType: 'VENDOR_BILL',
          targetId: a.target_id,
          amount: a.amount,
        }));
        const targets = await lockTargets(client, principal, requests);

        const { rows: billStates } = await client.query<{ id: string; on_hold: boolean }>(
          `SELECT id, on_hold FROM vendor_bills WHERE id = ANY($1::uuid[])`,
          [allocations.map((a) => a.target_id)],
        );
        const nowHeld = billStates.filter((b) => b.on_hold || heldBills.has(b.id)).map((b) => b.id);

        if (heldVendors.has(payment.vendor_id) || nowHeld.length > 0) {
          const reason = heldVendors.has(payment.vendor_id)
            ? `Vendor ${payment.vendor_id} is under an active payment hold.`
            : `Bill(s) ${nowHeld.join(', ')} are under an active payment hold.`;
          await this.cancelRunPayment(client, payment.id, reason);
          cancelled += 1;
          outcomes.push({ payment_id: payment.id, status: 'CANCELLED', reason });
          continue;
        }

        try {
          validateAllocations({
            sourceUnapplied: payment.unapplied_amount,
            sourceCurrency: payment.currency,
            requests,
            targets,
            documentLabel: (t) => `bill ${t.id}`,
          });
        } catch (error) {
          // The reserved balance moved between approval and execution — paid
          // manually, credited, whatever. Refusing this one payment, with the
          // reason on the record, is the safe answer; paying "what is left"
          // would be a decision nobody approved.
          if (error instanceof AppError && error.code === 'OVER_ALLOCATION') {
            await this.cancelRunPayment(client, payment.id, error.message);
            cancelled += 1;
            outcomes.push({ payment_id: payment.id, status: 'CANCELLED', reason: error.message });
            continue;
          }
          throw error;
        }

        let applied = Money.zero(payment.currency);
        for (const request of requests) {
          await applyToTarget(
            client,
            targets.get(request.targetId)!,
            request.amount,
            'amount_paid',
          );
          applied = applied.add(Money.of(D(request.amount), payment.currency));
        }

        // The run just reduced the AP subledger; the control account must move
        // in the same transaction. One builder with the standalone payment
        // path (VENDOR_PAYMENT_POSTED) — the allocations were reserved at run
        // creation, so their realized FX is already on the rows and travels
        // into the journal with them.
        const entries: SettlementAllocation[] = allocations.map((allocation) => ({
          allocationId: allocation.id,
          targetId: allocation.target_id,
          amount: allocation.amount,
          documentRate:
            targets.get(allocation.target_id)!.exchangeRate ?? payment.exchange_rate ?? '1',
          realizedFx: allocation.realized_fx_amount,
        }));
        const posted = await this.ap.postPaymentJournal(
          client,
          context,
          principal,
          book,
          payment,
          applied.toString(),
          entries,
        );
        await client.query(
          `UPDATE vendor_payments
              SET allocated_amount = allocated_amount + $2::numeric,
                  unapplied_amount = amount - (allocated_amount + $2::numeric),
                  status = 'SENT', accounting_entry_id = $3
            WHERE id = $1`,
          [payment.id, applied.toString(), posted.entry.id],
        );
        if (allocations.length > 0) {
          await client.query(
            `UPDATE payment_allocations SET accounting_entry_id = $2 WHERE id = ANY($1::uuid[])`,
            [allocations.map((allocation) => allocation.id), posted.entry.id],
          );
        }
        executed += 1;
        outcomes.push({
          payment_id: payment.id,
          payment_number: payment.payment_number,
          status: 'SENT',
          amount: applied.toString(),
          journal_entry_id: posted.entry.id,
        });
      }

      const { rows: updated } = await client.query<Record<string, unknown>>(
        `UPDATE payment_runs SET status = 'COMPLETED', executed_at = now()
          WHERE id = $1
          RETURNING id, run_number, status::text AS status, total_amount::text AS total_amount,
                    executed_at`,
        [id],
      );

      await recordAudit(client, context, {
        action: 'payment_run.executed',
        resourceType: 'payment_run',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: run.legal_entity_id as string,
        before: run,
        after: { ...(updated[0] as Record<string, unknown>), executed, cancelled },
      });

      return { ...updated[0], executed, cancelled, payments: outcomes };
    });
  }

  // =========================================================================
  // Shared
  // =========================================================================

  private async loadCredit(
    client: PoolClient,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT id, tenant_id, legal_entity_id, accounting_book_id, vendor_id, vendor_bill_id,
              credit_number, document_date::text AS document_date,
              posting_date::text AS posting_date, currency, exchange_rate::text AS exchange_rate,
              status::text AS status, subtotal::text AS subtotal, tax_total::text AS tax_total,
              total::text AS total, amount_applied::text AS amount_applied,
              amount_available::text AS amount_available, accounting_entry_id
         FROM vendor_credits WHERE id = $1 ${options.forUpdate ? 'FOR UPDATE' : ''}`,
      [id],
    );
    if (!rows[0]) throw notFound('vendor credit', id);
    return rows[0];
  }

  private async loadClaim(client: PoolClient, id: string): Promise<Record<string, unknown>> {
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT id, tenant_id, legal_entity_id, accounting_book_id, claimant_user_id, claim_number,
              document_date::text AS document_date, posting_date::text AS posting_date, currency,
              total::text AS total, status::text AS status, accounting_entry_id
         FROM expense_claims WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!rows[0]) throw notFound('expense claim', id);
    return rows[0];
  }

  private async loadClaimItems(client: PoolClient, claimId: string) {
    const { rows } = await client.query<{
      id: string;
      line_no: number;
      expense_date: string;
      merchant: string | null;
      category: string | null;
      amount: string;
      expense_account_id: string;
      tax_code_id: string | null;
      receipt_file_id: string | null;
    }>(
      `SELECT id, line_no, expense_date::text AS expense_date, merchant, category,
              amount::text AS amount, expense_account_id, tax_code_id, receipt_file_id
         FROM expense_items WHERE expense_claim_id = $1 ORDER BY line_no`,
      [claimId],
    );
    return rows;
  }

  /**
   * Expense items are tax-inclusive by definition: the employee paid the till
   * price, and the tax is inside it. Forcing `inclusive` here rather than
   * honouring the code's default is deliberate — an exclusive default would
   * gross the claim UP past what the employee actually spent.
   */
  private async calculateClaimItems(
    client: PoolClient,
    legalEntityId: string,
    currency: string,
    documentDate: string,
    items: ReadonlyArray<{
      lineNo?: number | undefined;
      expenseDate: string;
      merchant?: string | undefined;
      category?: string | undefined;
      amount: string;
      expenseAccountId: string;
      taxCodeId?: string | undefined;
    }>,
  ): Promise<{ calculated: CalculatedDocument; codes: Map<string, ResolvedTaxCode> }> {
    const codes = await this.tax.resolveCodes(
      client,
      legalEntityId,
      items.map((item) => item.taxCodeId).filter((codeId): codeId is string => Boolean(codeId)),
      documentDate,
    );
    const documentLines: DocumentLineInput[] = items.map((item, index) => {
      const code = item.taxCodeId ? codes.get(item.taxCodeId) : undefined;
      return {
        lineNo: item.lineNo ?? index + 1,
        description: item.merchant ?? item.category ?? `Expense ${item.lineNo ?? index + 1}`,
        quantity: '1',
        unitPrice: item.amount,
        ...(code ? { taxCode: { ...code, inclusive: true } } : {}),
      };
    });
    return { calculated: calculateDocument(documentLines, { currency }), codes };
  }

  private async calculateLines(
    client: PoolClient,
    legalEntityId: string,
    currency: string,
    documentDate: string,
    lines: ReadonlyArray<{
      lineNo: number;
      description: string;
      quantity: string;
      unitPrice: string;
      taxCodeId?: string | undefined;
      inclusive?: boolean | undefined;
    }>,
  ): Promise<{ calculated: CalculatedDocument; codes: Map<string, ResolvedTaxCode> }> {
    const codes = await this.tax.resolveCodes(
      client,
      legalEntityId,
      lines.map((line) => line.taxCodeId).filter((codeId): codeId is string => Boolean(codeId)),
      documentDate,
    );
    const documentLines: DocumentLineInput[] = lines.map((line) => {
      const code = line.taxCodeId ? codes.get(line.taxCodeId) : undefined;
      return {
        lineNo: line.lineNo,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        ...(code ? { taxCode: { ...code, inclusive: line.inclusive ?? code.inclusive } } : {}),
      };
    });
    return { calculated: calculateDocument(documentLines, { currency }), codes };
  }

  private async cancelRunPayment(
    client: PoolClient,
    paymentId: string,
    reason: string,
  ): Promise<void> {
    await client.query(
      `UPDATE vendor_payments SET status = 'CANCELLED', failure_reason = $2 WHERE id = $1`,
      [paymentId, reason],
    );
  }
}

// =============================================================================
// Pure decision logic — exported so the state machines and controls are
// testable without a database, in the manner of posting-lines.test.ts.
// =============================================================================

export interface ApprovalTransition {
  readonly alreadyApproved: boolean;
}

/**
 * DRAFT/SUBMITTED/APPROVAL_PENDING may be approved; APPROVED is idempotent.
 * REJECTED, CONVERTED and CLOSED are terminal: a rejected requisition
 * re-approved quietly is a spending decision nobody made.
 */
export function requisitionApprovalTransition(status: string): ApprovalTransition {
  if (status === 'APPROVED') return { alreadyApproved: true };
  if (['DRAFT', 'SUBMITTED', 'APPROVAL_PENDING'].includes(status)) {
    return { alreadyApproved: false };
  }
  throw new AppError('VALIDATION_FAILED', `This requisition is ${status} and cannot be approved.`, {
    details: { status },
  });
}

/**
 * ISSUED and the partially-fulfilled states report "already approved" rather
 * than failing: an order that has been received against was certainly approved,
 * and a retried approval must not fail on its own success. CANCELLED and CLOSED
 * refuse — approving a cancelled order would resurrect authority to spend.
 */
export function purchaseOrderApprovalTransition(status: string): ApprovalTransition {
  if (
    ['APPROVED', 'ISSUED', 'PARTIALLY_RECEIVED', 'PARTIALLY_BILLED', 'COMPLETED'].includes(status)
  ) {
    return { alreadyApproved: true };
  }
  if (['DRAFT', 'APPROVAL_PENDING'].includes(status)) return { alreadyApproved: false };
  throw new AppError(
    'VALIDATION_FAILED',
    `This purchase order is ${status} and cannot be approved.`,
    { details: { status } },
  );
}

/**
 * The expense-claim lifecycle, one action at a time. APPROVE from DRAFT is the
 * transition worth refusing explicitly: the policy engine runs at submission,
 * so approving an unsubmitted claim would approve flags nobody has seen.
 */
export function expenseClaimTransition(
  status: string,
  action: 'SUBMIT' | 'APPROVE' | 'POST',
): { readonly already: boolean } {
  if (action === 'SUBMIT') {
    if (['SUBMITTED', 'APPROVAL_PENDING'].includes(status)) return { already: true };
    if (status === 'DRAFT') return { already: false };
    throw new AppError('VALIDATION_FAILED', `This claim is ${status} and cannot be submitted.`, {
      details: { status },
    });
  }
  if (action === 'APPROVE') {
    if (status === 'APPROVED') return { already: true };
    if (['SUBMITTED', 'APPROVAL_PENDING'].includes(status)) return { already: false };
    if (status === 'DRAFT') {
      throw new AppError(
        'VALIDATION_FAILED',
        'This claim has not been submitted. Submission runs the expense policy checks, and an ' +
          'approval that skips them approves flags nobody has seen.',
        { details: { status } },
      );
    }
    throw new AppError('VALIDATION_FAILED', `This claim is ${status} and cannot be approved.`, {
      details: { status },
    });
  }
  if (['POSTED', 'REIMBURSED'].includes(status)) return { already: true };
  if (status === 'APPROVED') return { already: false };
  throw new AppError('VALIDATION_FAILED', `This claim is ${status} and cannot be posted.`, {
    details: { status },
  });
}

/**
 * doc 14: approval by the person who benefits is not a control. Used for
 * expense claims (claimant vs approver); the payment-run variant lives in
 * `paymentRunApprovalDecision` because a run has two approver seats.
 */
export function assertNotSelfApproval(input: {
  readonly approverId: string;
  readonly ownerId: string;
  readonly ownerRole: string;
}): void {
  if (input.approverId === input.ownerId) {
    throw new AppError(
      'SEGREGATION_OF_DUTIES',
      `The ${input.ownerRole} may not approve it themselves (doc 14). Approval by the person ` +
        'who stands to gain is not a control.',
      { details: { approver_id: input.approverId } },
    );
  }
}

export interface PaymentRunApprovalInput {
  readonly status: string;
  readonly createdBy: string | null;
  readonly approvedBy: string | null;
  readonly approverId: string;
  readonly totalAmount: string;
  readonly dualApprovalThreshold: string | null;
}

export type PaymentRunApprovalDecision =
  | { readonly kind: 'ALREADY_APPROVED' }
  | { readonly kind: 'FIRST'; readonly nextStatus: 'APPROVED' | 'APPROVAL_PENDING' }
  | { readonly kind: 'SECOND' };

/**
 * Maker-checker plus dual control (doc 14, and the schema's own CHECKs).
 *
 * The creator never approves; over the threshold the first approval parks the
 * run in APPROVAL_PENDING and only a DIFFERENT second approver completes it.
 * The same person approving twice is idempotent, not a second approval — two
 * signatures from one hand is one signature.
 */
export function paymentRunApprovalDecision(
  input: PaymentRunApprovalInput,
): PaymentRunApprovalDecision {
  if (input.status === 'APPROVED') return { kind: 'ALREADY_APPROVED' };
  if (!['DRAFT', 'APPROVAL_PENDING'].includes(input.status)) {
    throw new AppError(
      'VALIDATION_FAILED',
      `This payment run is ${input.status} and cannot be approved.`,
      { details: { status: input.status } },
    );
  }
  if (input.createdBy !== null && input.approverId === input.createdBy) {
    throw new AppError(
      'SEGREGATION_OF_DUTIES',
      'The person who built a payment run may not approve it (doc 14). Building the run chooses ' +
        'who gets paid; approval is the check on that choice.',
      { details: { approver_id: input.approverId } },
    );
  }
  if (input.approvedBy === null) {
    const needsSecond =
      input.dualApprovalThreshold !== null &&
      D(input.totalAmount).gt(D(input.dualApprovalThreshold));
    return { kind: 'FIRST', nextStatus: needsSecond ? 'APPROVAL_PENDING' : 'APPROVED' };
  }
  if (input.approverId === input.approvedBy) return { kind: 'ALREADY_APPROVED' };
  return { kind: 'SECOND' };
}

export interface RunCandidateBill {
  readonly id: string;
  readonly vendor_id: string;
  readonly currency: string;
  readonly status: string;
  readonly on_hold: boolean;
  readonly due_date: string | null;
  readonly amount_due: string;
}

export interface ActiveHold {
  readonly scope_type: string;
  readonly scope_id: string;
  readonly released_at?: string | null;
}

/**
 * doc 05: a run "excludes unapproved, held or blocked vendors/bills". A hold on
 * the bill and a hold on its vendor both exclude it; a released hold excludes
 * nothing, because release is the recorded decision that the concern is over.
 * Already-settled bills fall out on their zero balance, whatever their status
 * row says today.
 */
export function selectBillsForRun(input: {
  readonly bills: readonly RunCandidateBill[];
  readonly holds: readonly ActiveHold[];
  readonly currency: string;
  readonly dueOnOrBefore: string;
}): RunCandidateBill[] {
  const active = input.holds.filter((hold) => !hold.released_at);
  const heldBills = new Set(
    active.filter((hold) => hold.scope_type === 'VENDOR_BILL').map((hold) => hold.scope_id),
  );
  const heldVendors = new Set(
    active.filter((hold) => hold.scope_type === 'VENDOR').map((hold) => hold.scope_id),
  );
  return input.bills.filter(
    (bill) =>
      bill.currency === input.currency &&
      ['POSTED', 'PARTIALLY_PAID'].includes(bill.status) &&
      bill.due_date !== null &&
      bill.due_date <= input.dueOnOrBefore &&
      Money.of(D(bill.amount_due), bill.currency).isPositive() &&
      !bill.on_hold &&
      !heldBills.has(bill.id) &&
      !heldVendors.has(bill.vendor_id),
  );
}

/**
 * Execution processes DRAFT payments only. After a successful run they are
 * SENT and a re-run finds nothing to do; a CANCELLED payment stays cancelled.
 * This filter is the whole idempotency argument, so it is a function rather
 * than an inline predicate.
 */
export function paymentsToExecute<T extends { readonly id: string; readonly status: string }>(
  payments: readonly T[],
): T[] {
  return payments.filter((payment) => payment.status === 'DRAFT');
}

/**
 * doc 05's expense policy signals. Flags, not verdicts: each one is a reason
 * for the approver to look, recorded on the item where the approver will see it.
 */
export function expensePolicyFlags(
  item: { readonly expenseDate: string; readonly receiptFileId: string | null },
  duplicateMatches: number,
): string[] {
  const flags: string[] = [];
  if (!item.receiptFileId) flags.push('MISSING_RECEIPT');
  const day = new Date(`${item.expenseDate}T00:00:00Z`).getUTCDay();
  if (day === 0 || day === 6) flags.push('WEEKEND');
  if (duplicateMatches > 0) flags.push('DUPLICATE_SUSPECTED');
  return flags;
}
