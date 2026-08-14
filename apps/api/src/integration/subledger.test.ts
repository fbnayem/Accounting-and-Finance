import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accountBalance,
  closeTestApp,
  createLedger,
  createSubledger,
  createTenant,
  http,
  satisfyMfa,
  testApp,
  type SubledgerFixture,
  type TenantFixture,
} from './harness';

/**
 * Phase 3's six exit criteria, as executable claims.
 *
 * Over HTTP against the assembled application, for the reason `isolation.test.ts`
 * gives: every one of these is a statement about what the *system* does, and a
 * test that called the service directly would prove the service while leaving the
 * router, the guards and the interceptors out of the claim.
 *
 * The first criterion is the one that shapes the file. "AR and AP aging totals
 * reconcile to their GL control accounts" is a statement that two independently
 * maintained numbers agree — the aging comes from open documents, the control
 * balance from posted journal lines, and nothing derives either from the other.
 * That is the only reason comparing them means anything, and it is what caught
 * F-723: until settlement posted, these tests would have failed the moment
 * anything was paid.
 */

const YEAR = 2027;
const JAN = `${YEAR}-01-15`;
const FEB = `${YEAR}-02-15`;

let tenant: TenantFixture;
let fx: SubledgerFixture;

beforeAll(async () => {
  await testApp();
  tenant = await createTenant('Subledger');
  const ledger = await createLedger(tenant, { code: 'SUB', currency: 'GBP', year: YEAR });
  fx = await createSubledger(tenant, ledger, { year: YEAR });
  await satisfyMfa(tenant.userId);
}, 120_000);

afterAll(async () => {
  await closeTestApp();
});

const key = (label: string) => ({
  'Idempotency-Key': `${label}-${Math.random().toString(36).slice(2)}`,
});

async function postedInvoice(amount: string, date = JAN): Promise<Record<string, string>> {
  const draft = await http()
    .post('/invoices')
    .set(tenant.auth)
    .send({
      accounting_book_id: fx.accountingBookId,
      customer_id: fx.customerId,
      document_date: date,
      posting_date: date,
      lines: [
        {
          description: 'Consulting',
          quantity: '1',
          unit_price: amount,
          revenue_account_id: fx.accounts.revenue,
          tax_code_id: fx.taxCodeId,
        },
      ],
    })
    .expect(201);

  const posted = await http()
    .post(`/invoices/${draft.body.id}/post`)
    .set(tenant.auth)
    .set(key(`post-invoice-${draft.body.id}`))
    .send({})
    .expect(200);
  return posted.body;
}

async function postedBill(amount: string, reference: string, date = JAN) {
  const draft = await http()
    .post('/vendor-bills')
    .set(tenant.auth)
    .send({
      accounting_book_id: fx.accountingBookId,
      vendor_id: fx.vendorId,
      vendor_invoice_number: reference,
      document_date: date,
      posting_date: date,
      lines: [
        {
          description: 'Supplies',
          quantity: '1',
          unit_price: amount,
          destination_account_id: fx.accounts.expense,
          tax_code_id: fx.taxCodeId,
        },
      ],
    })
    .expect(201);

  const posted = await http()
    .post(`/vendor-bills/${draft.body.id}/post`)
    .set(tenant.auth)
    .set(key(`post-bill-${draft.body.id}`))
    .send({})
    .expect(200);
  return posted.body;
}

async function agingTotal(side: 'ar' | 'ap', asOf = FEB): Promise<number> {
  const response = await http()
    .get(`/reports/${side}-aging`)
    .query({ legal_entity_id: fx.legalEntityId, as_of: asOf })
    .set(tenant.auth)
    .expect(200);
  return Number(response.body.totals.total);
}

// ---------------------------------------------------------------------------

describe('exit criterion 1 — AR and AP aging reconcile to their GL control accounts', () => {
  it('AR aging equals the AR control balance across invoice, credit note and write-off', async () => {
    // Three ways an invoice's open balance moves, and the criterion is that all
    // three keep the two sides equal. F-703 exists because two of them could not
    // reach `amount_due` at all, which made this unreachable rather than false.
    const invoice = await postedInvoice('1000.00');
    const second = await postedInvoice('500.00');

    const creditNote = await http()
      .post('/credit-notes')
      .set(tenant.auth)
      .send({
        accounting_book_id: fx.accountingBookId,
        customer_id: fx.customerId,
        invoice_id: second.id,
        document_date: JAN,
        posting_date: JAN,
        lines: [
          {
            description: 'Goodwill credit',
            quantity: '1',
            unit_price: '100.00',
            revenue_account_id: fx.accounts.revenue,
            tax_code_id: fx.taxCodeId,
          },
        ],
      })
      .expect(201);
    await http()
      .post(`/credit-notes/${creditNote.body.id}/post`)
      .set(tenant.auth)
      .set(key('post-cn'))
      .send({})
      .expect(200);
    await http()
      .post(`/credit-notes/${creditNote.body.id}/apply`)
      .set(tenant.auth)
      .set(key('apply-cn'))
      .send({ applications: [{ invoice_id: second.id, amount: '120.00' }] })
      .expect(200);

    await http()
      .post('/ar/write-offs')
      .set(tenant.auth)
      .set(key('write-off'))
      .send({
        invoice_id: invoice.id,
        posting_date: JAN,
        amount: '200.00',
        reason_code: 'UNCOLLECTABLE',
      })
      .expect(201);

    const aging = await agingTotal('ar');
    const control = await accountBalance(tenant, fx, fx.accounts.ar);

    expect(aging).toBeCloseTo(control, 6);
  }, 120_000);

  it('AP aging equals the AP control balance after a bill is paid', async () => {
    // The half F-723 broke. Paying a bill moved `amount_due` and left the control
    // account carrying the full balance, so these two disagreed by exactly the
    // amount paid — and nothing else in the system said so.
    const bill = await postedBill('600.00', 'AP-RECON-1');

    await http()
      .post('/vendor-payments')
      .set(tenant.auth)
      .set(key('pay-bill'))
      .send({
        accounting_book_id: fx.accountingBookId,
        vendor_id: fx.vendorId,
        document_date: JAN,
        posting_date: JAN,
        amount: '300.00',
        allocations: [{ target_type: 'VENDOR_BILL', target_id: bill.id, amount: '300.00' }],
      })
      .expect(201);

    const aging = await agingTotal('ap');
    // AP is a credit balance, so the ledger side is negated to compare like with
    // like rather than asking the reader to remember the sign.
    const control = -(await accountBalance(tenant, fx, fx.accounts.ap));

    expect(aging).toBeCloseTo(control, 6);
  }, 120_000);
});

describe('exit criterion 2 — the tax subledger reconciles to the tax control accounts', () => {
  it('reported output tax equals the output tax account balance', async () => {
    const report = await http()
      .get('/reports/tax')
      .query({ legal_entity_id: fx.legalEntityId, from: `${YEAR}-01-01`, to: `${YEAR}-12-31` })
      .set(tenant.auth)
      .expect(200);

    const outputTax = Number(report.body.totals.output_tax);
    const control = -(await accountBalance(tenant, fx, fx.accounts.outputTax));

    // Computed from `tax_transactions` on one side and posted journal lines on
    // the other. `TaxService.recordTransactions` writes the subledger inside the
    // posting transaction, which is what makes them the same set of facts rather
    // than two systems that happen to agree today.
    expect(outputTax).toBeCloseTo(control, 6);
  }, 120_000);
});

describe('exit criterion 3 — invoice post and reversal pass golden accounting tests', () => {
  it('posts an invoice as debit AR gross, credit revenue net, credit output tax', async () => {
    const invoice = await postedInvoice('100.00', FEB);
    const entry = await http()
      .get(`/journals/${invoice.accounting_entry_id}`)
      .set(tenant.auth)
      .expect(200);

    const byAccount = new Map<string, { debit: string; credit: string }>(
      entry.body.lines.map((l: { account_id: string; base_debit: string; base_credit: string }) => [
        l.account_id,
        { debit: l.base_debit, credit: l.base_credit },
      ]),
    );

    expect(Number(byAccount.get(fx.accounts.ar)?.debit)).toBeCloseTo(120, 6);
    expect(Number(byAccount.get(fx.accounts.revenue)?.credit)).toBeCloseTo(100, 6);
    expect(Number(byAccount.get(fx.accounts.outputTax)?.credit)).toBeCloseTo(20, 6);
  }, 120_000);

  it('reverses a posted invoice by credit note rather than by editing it', async () => {
    // doc 04: "Correction states are handled by credit note/cancel-and-reissue;
    // no editing posted financial values." The posted invoice must still be there
    // afterwards, saying what it always said.
    const invoice = await postedInvoice('250.00', FEB);

    await http()
      .post(`/invoices/${invoice.id}/void-or-credit`)
      .set(tenant.auth)
      .set(key('void-or-credit'))
      .send({ reason: 'Cancelled by the customer after posting' })
      .expect(200);

    const after = await http().get(`/invoices/${invoice.id}`).set(tenant.auth).expect(200);
    expect(after.body.total).toBe(invoice.total);
    expect(Number(after.body.amount_due)).toBeCloseTo(0, 6);
  }, 120_000);

  it('refuses to edit a posted invoice at all', async () => {
    const invoice = await postedInvoice('75.00', FEB);
    const response = await http()
      .patch(`/invoices/${invoice.id}`)
      .set(tenant.auth)
      .send({ notes: 'trying to change a posted document' })
      // 409, not 422: the error taxonomy maps POSTED_IMMUTABLE to Conflict, which
      // is the honest status — the request is well-formed and the state refuses it.
      .expect(409);
    expect(response.body.code).toBe('POSTED_IMMUTABLE');
  }, 120_000);
});

describe('exit criterion 4 — partial allocation and overpayment do not corrupt balances', () => {
  it('refuses two allocations that each fit and together do not', async () => {
    // Gate G's "two receipts allocated to last invoice balance", in one request.
    // A per-request check passes both; the sum is what breaks the invoice.
    const invoice = await postedInvoice('100.00', FEB);
    const gross = Number(invoice.total);

    const receipt = await http()
      .post('/customer-receipts')
      .set(tenant.auth)
      .set(key('receipt-over'))
      .send({
        accounting_book_id: fx.accountingBookId,
        customer_id: fx.customerId,
        document_date: FEB,
        posting_date: FEB,
        amount: String(gross * 2),
      })
      .expect(201);

    const response = await http()
      .post(`/customer-receipts/${receipt.body.id}/allocate`)
      .set(tenant.auth)
      .set(key('allocate-over'))
      .send({
        allocations: [
          { target_type: 'INVOICE', target_id: invoice.id, amount: String(gross * 0.75) },
          { target_type: 'INVOICE', target_id: invoice.id, amount: String(gross * 0.75) },
        ],
      })
      .expect(422);

    expect(response.body.code).toBe('OVER_ALLOCATION');

    // And the invoice is untouched — a refused allocation that had already moved
    // one of its two amounts would be the corruption this criterion is about.
    const after = await http().get(`/invoices/${invoice.id}`).set(tenant.auth).expect(200);
    expect(Number(after.body.amount_due)).toBeCloseTo(gross, 6);
  }, 120_000);

  it('keeps overpaid cash visible as unapplied rather than hiding it in AR', async () => {
    // doc 04: "overpayment/unapplied funds remain visible and controlled."
    // Crediting the whole receipt to AR would settle the invoice and bury the
    // excess inside the control account, where nobody would find it again.
    const invoice = await postedInvoice('100.00', FEB);
    const gross = Number(invoice.total);

    const receipt = await http()
      .post('/customer-receipts')
      .set(tenant.auth)
      .set(key('receipt-partial'))
      .send({
        accounting_book_id: fx.accountingBookId,
        customer_id: fx.customerId,
        document_date: FEB,
        posting_date: FEB,
        amount: String(gross + 50),
        allocations: [{ target_type: 'INVOICE', target_id: invoice.id, amount: String(gross) }],
      })
      .expect(201);

    expect(Number(receipt.body.unapplied_amount)).toBeCloseTo(50, 6);

    const after = await http().get(`/invoices/${invoice.id}`).set(tenant.auth).expect(200);
    expect(Number(after.body.amount_due)).toBeCloseTo(0, 6);

    const advance = -(await accountBalance(tenant, fx, fx.accounts.customerAdvance));
    expect(advance).toBeGreaterThanOrEqual(50);
  }, 120_000);
});

describe('exit criterion 5 — three-way match flags quantity, price and tolerance violations', () => {
  it('matches a bill that agrees with its order and receipt', async () => {
    const { billId } = await threeWayFixture({
      orderQty: '10',
      receivedQty: '10',
      billQty: '10',
      unitPrice: '5.00',
    });
    const match = await http()
      .post(`/vendor-bills/${billId}/match`)
      .set(tenant.auth)
      .set(key('match-clean'))
      .send({})
      .expect(200);
    expect(match.body.match_state).toBe('MATCHED');
  }, 180_000);

  it('refuses outright to bill a receipt line for more than it accepted', async () => {
    // Stronger than flagging it: `grl_billed_bounded` will not let
    // `quantity_billed` exceed `quantity_accepted`, so a bill tied to the receipt
    // line cannot record the over-billing at all. Rejecting goods and paying for
    // them anyway is the failure matching exists to prevent, and here it is
    // structural rather than a rule someone has to run.
    await expect(
      threeWayFixture({ orderQty: '10', receivedQty: '10', billQty: '12', unitPrice: '5.00' }),
    ).rejects.toThrow();
  }, 180_000);

  it('flags a bill for more than was received when it is not tied to the receipt', async () => {
    // The way an over-billing actually gets in: entered against the order, with
    // nobody linking it to what arrived. The CHECK never sees it, so matching is
    // the only thing that will.
    const { billId } = await threeWayFixture({
      orderQty: '10',
      receivedQty: '10',
      billQty: '12',
      unitPrice: '5.00',
      linkReceiptLine: false,
    });
    const match = await http()
      .post(`/vendor-bills/${billId}/match`)
      .set(tenant.auth)
      .set(key('match-qty'))
      .send({})
      .expect(200);
    expect(match.body.match_state).toBe('EXCEPTION');
    // Which variance, not just that one exists: a match that flags the right bill
    // for the wrong reason sends somebody to check the price of a quantity error.
    expect(JSON.stringify(match.body.lines)).toMatch(/quantity/i);
  }, 180_000);

  it('flags a price above tolerance and accepts one within it', async () => {
    const overPrice = await threeWayFixture({
      orderQty: '10',
      receivedQty: '10',
      billQty: '10',
      unitPrice: '5.00',
      billUnitPrice: '6.00',
    });
    const flagged = await http()
      .post(`/vendor-bills/${overPrice.billId}/match`)
      .set(tenant.auth)
      .set(key('match-price'))
      .send({})
      .expect(200);
    expect(flagged.body.match_state).toBe('EXCEPTION');

    const withinTolerance = await threeWayFixture({
      orderQty: '10',
      receivedQty: '10',
      billQty: '10',
      unitPrice: '5.00',
      billUnitPrice: '5.05',
    });
    const accepted = await http()
      .post(`/vendor-bills/${withinTolerance.billId}/match`)
      .set(tenant.auth)
      .set(key('match-tolerance'))
      .send({
        tolerance: { price_percent: '0.02', quantity_percent: '0.02', absolute_amount: '5.00' },
      })
      .expect(200);
    expect(['MATCHED', 'WITHIN_TOLERANCE']).toContain(accepted.body.match_state);
  }, 180_000);
});

describe('exit criterion 6 — the drill chain is complete', () => {
  it('walks source document to accounting event to journal to report', async () => {
    // Each hop is a link somebody has to be able to follow during an audit, and
    // the chain is only as good as its weakest one: an invoice with no
    // accounting_entry_id, or a journal line the GL report cannot find.
    const invoice = await postedInvoice('400.00', FEB);
    expect(invoice.accounting_entry_id).toBeTruthy();

    const entry = await http()
      .get(`/journals/${invoice.accounting_entry_id}`)
      .set(tenant.auth)
      .expect(200);
    expect(entry.body.source_type).toBe('invoice');
    expect(entry.body.source_id).toBe(invoice.id);
    expect(entry.body.status).toBe('POSTED');

    // The contact on the control-account line is what makes the ledger drillable
    // back to a customer.
    const arLine = entry.body.lines.find(
      (l: { account_id: string }) => l.account_id === fx.accounts.ar,
    );
    expect(arLine.contact_id).toBe(fx.customerId);

    const ledgerReport = await http()
      .get('/reports/general-ledger')
      .query({
        book_id: fx.accountingBookId,
        account_id: fx.accounts.ar,
        from: `${YEAR}-01-01`,
        to: `${YEAR}-12-31`,
      })
      .set(tenant.auth)
      .expect(200);

    const reported = ledgerReport.body.data.find(
      (r: { journal_entry_id: string }) => r.journal_entry_id === invoice.accounting_entry_id,
    );
    expect(reported, 'the posted entry appears in the general ledger report').toBeTruthy();
  }, 120_000);
});

// ---------------------------------------------------------------------------

/**
 * An order, a receipt against it and a bill against both.
 *
 * All three point at the same purchase-order line, which is what the match joins
 * on — F-702 added the receipt side because `bill_matches.goods_receipt_line_id`
 * referenced a Phase 5 table and there was nothing for it to point at.
 */
let matchScenario = 0;

async function threeWayFixture(input: {
  orderQty: string;
  receivedQty: string;
  billQty: string;
  unitPrice: string;
  billUnitPrice?: string;
  linkReceiptLine?: boolean;
}): Promise<{ billId: string }> {
  // Each scenario gets its own date. Without it doc 05's duplicate detector is
  // right and the test is wrong: three bills to one vendor for similar amounts on
  // one day is exactly what it is built to flag, and it refuses the third with
  // DUPLICATE_SUSPECTED before matching ever runs.
  const scenario = matchScenario++;
  const billDate = `${YEAR}-01-${String(10 + scenario).padStart(2, '0')}`;
  const order = await http()
    .post('/purchase-orders')
    .set(tenant.auth)
    .send({
      legal_entity_id: fx.legalEntityId,
      vendor_id: fx.vendorId,
      document_date: JAN,
      currency: 'GBP',
      lines: [
        {
          description: 'Widgets',
          quantity: input.orderQty,
          unit_price: input.unitPrice,
          destination_account_id: fx.accounts.expense,
        },
      ],
    })
    .expect(201);
  const orderLineId = order.body.lines[0].id as string;

  await http()
    .post(`/purchase-orders/${order.body.id}/approve`)
    .set(tenant.auth)
    .set(key(`approve-po-${order.body.id}`))
    .send({})
    .expect(200);

  const receipt = await http()
    .post('/goods-receipts')
    .set(tenant.auth)
    .set(key(`grn-${order.body.id}`))
    .send({
      accounting_book_id: fx.accountingBookId,
      vendor_id: fx.vendorId,
      purchase_order_id: order.body.id,
      receipt_date: JAN,
      posting_date: JAN,
      lines: [
        {
          purchase_order_line_id: orderLineId,
          description: 'Widgets',
          quantity_received: input.receivedQty,
          quantity_accepted: input.receivedQty,
          unit_price: input.unitPrice,
          destination_account_id: fx.accounts.expense,
        },
      ],
    })
    .expect(201);
  const receiptLineId = receipt.body.lines[0].id as string;

  const bill = await http()
    .post('/vendor-bills')
    .set(tenant.auth)
    .send({
      accounting_book_id: fx.accountingBookId,
      vendor_id: fx.vendorId,
      purchase_order_id: order.body.id,
      // Numbered by scenario, not by a slice of the order id: uuidv7 encodes a
      // 48-bit millisecond timestamp, so two ids minted seconds apart share their
      // first eight hex characters — and doc 05's normalised-number signal was
      // quite right to call the second bill a duplicate of the first.
      vendor_invoice_number: `MATCH-SCENARIO-${scenario}`,
      document_date: billDate,
      posting_date: billDate,
      lines: [
        {
          description: 'Widgets',
          quantity: input.billQty,
          unit_price: input.billUnitPrice ?? input.unitPrice,
          destination_account_id: fx.accounts.expense,
          purchase_order_line_id: orderLineId,
          ...(input.linkReceiptLine === false ? {} : { goods_receipt_line_id: receiptLineId }),
        },
      ],
    })
    .expect(201);

  return { billId: bill.body.id as string };
}

// ---------------------------------------------------------------------------

describe('Phase 5 exit criterion 1 — a billed goods receipt clears GRNI instead of restating cost', () => {
  it('debits the destination once across receipt and bill, and GRNI nets to zero', async () => {
    // The receipt posts Dr destination / Cr GRNI; the bill for the same goods
    // must post Dr GRNI / Cr AP. The broken shape — the bill debiting the
    // destination again — passed every reconciliation above because none of
    // them asked whether the destination agrees with what was delivered. Both
    // assertions here read the trial balance with source=journal_lines
    // (accountBalance), because a reconciliation that trusts a read model to
    // prove the read model proves nothing.
    const MAR = `${YEAR}-03-15`;

    // A destination account no other test posts to, so "debited once" is a
    // claim about a total rather than about a delta someone has to compute.
    const destination = await http()
      .post('/accounts')
      .set(tenant.auth)
      .send({
        legal_entity_id: fx.legalEntityId,
        code: '1400',
        name: 'Inventory - received goods',
        account_type: 'ASSET',
      })
      .expect(201);
    const destinationId = destination.body.id as string;

    const order = await http()
      .post('/purchase-orders')
      .set(tenant.auth)
      .send({
        legal_entity_id: fx.legalEntityId,
        vendor_id: fx.vendorId,
        document_date: MAR,
        currency: 'GBP',
        lines: [
          {
            description: 'Stock widgets',
            quantity: '10',
            unit_price: '10.00',
            destination_account_id: destinationId,
          },
        ],
      })
      .expect(201);
    const orderLineId = order.body.lines[0].id as string;
    await http()
      .post(`/purchase-orders/${order.body.id}/approve`)
      .set(tenant.auth)
      .set(key('approve-po-grni'))
      .send({})
      .expect(200);

    const receipt = await http()
      .post('/goods-receipts')
      .set(tenant.auth)
      .set(key('grn-grni'))
      .send({
        accounting_book_id: fx.accountingBookId,
        vendor_id: fx.vendorId,
        purchase_order_id: order.body.id,
        receipt_date: MAR,
        posting_date: MAR,
        lines: [
          {
            purchase_order_line_id: orderLineId,
            description: 'Stock widgets',
            quantity_received: '10',
            quantity_accepted: '10',
            unit_price: '10.00',
            destination_account_id: destinationId,
          },
        ],
      })
      .expect(201);
    const receiptLineId = receipt.body.lines[0].id as string;

    await http()
      .post(`/goods-receipts/${receipt.body.id}/post`)
      .set(tenant.auth)
      .set(key('post-grn-grni'))
      .send({})
      .expect(200);

    // The accrual is the baseline the bill has to clear: the delivery's cost
    // in the destination, the same amount owed as GRNI.
    expect(await accountBalance(tenant, fx, destinationId)).toBeCloseTo(100, 6);
    expect(await accountBalance(tenant, fx, fx.accounts.grni)).toBeCloseTo(-100, 6);

    const bill = await http()
      .post('/vendor-bills')
      .set(tenant.auth)
      .send({
        accounting_book_id: fx.accountingBookId,
        vendor_id: fx.vendorId,
        purchase_order_id: order.body.id,
        vendor_invoice_number: 'GRNI-CLEAR-1',
        document_date: MAR,
        posting_date: MAR,
        lines: [
          {
            description: 'Stock widgets',
            quantity: '10',
            unit_price: '10.00',
            destination_account_id: destinationId,
            purchase_order_line_id: orderLineId,
            goods_receipt_line_id: receiptLineId,
          },
        ],
      })
      .expect(201);

    const match = await http()
      .post(`/vendor-bills/${bill.body.id}/match`)
      .set(tenant.auth)
      .set(key('match-grni'))
      .send({})
      .expect(200);
    expect(match.body.match_state).toBe('MATCHED');

    await http()
      .post(`/vendor-bills/${bill.body.id}/post`)
      .set(tenant.auth)
      .set(key('post-bill-grni'))
      .send({})
      .expect(200);

    // (a) The destination still carries the delivery exactly once. The defect
    // this proves absent debited it at receipt AND at billing: 200, not 100.
    expect(await accountBalance(tenant, fx, destinationId)).toBeCloseTo(100, 6);

    // (b) GRNI is empty again: the bill took out exactly the credit the
    // receipt put in. Under the defect it stayed at -100 for this delivery and
    // would have grown by every received-then-billed line forever.
    expect(await accountBalance(tenant, fx, fx.accounts.grni)).toBeCloseTo(0, 6);
  }, 180_000);
});
