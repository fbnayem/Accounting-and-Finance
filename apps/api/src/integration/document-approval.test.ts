import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestApp,
  createEntityRestrictedUser,
  createLedger,
  createSubledger,
  createTenant,
  fixturePool,
  http,
  testApp,
  type SubledgerFixture,
  type TenantFixture,
} from './harness';

/**
 * Maker/checker on the two documents the Phase 6 audit named, and the
 * PENDING_APPROVAL hole underneath them.
 *
 * Three separate defects, all shipped in Phase 3:
 *
 *   1. `PENDING_APPROVAL` was in the set of statuses an invoice or a bill could
 *      post FROM. A document explicitly waiting for an approval could become an
 *      accounting fact without ever getting one, which made the approval step
 *      advisory rather than a control.
 *
 *   2. `approveInvoice` and `approveVendorBill` recorded no approver. They
 *      flipped a status and published an event whose payload named `approved_by`
 *      — the only place that fact was ever written down, and an event payload is
 *      not something a later check can read.
 *
 *   3. `vendor_bills` had no preparer column at all, so "the approver is not the
 *      preparer" was not a sentence the table could form. Migration 0049 adds it,
 *      and adds the approver to both tables with a NULL-safe CHECK: an approval
 *      against an unknown preparer is refused rather than passed by a comparison
 *      that quietly evaluates to NULL.
 *
 * Both halves throughout: the approval that must be refused, and the one that
 * must succeed.
 */
describe('Phase 6 — maker/checker on invoices and vendor bills', () => {
  let tenant: TenantFixture;
  let fx: SubledgerFixture;
  let checker: { auth: { Authorization: string }; userId: string };

  const JAN = '2027-01-15';
  const key = (value: string) => ({ 'Idempotency-Key': value });

  beforeAll(async () => {
    await testApp();
    tenant = await createTenant('DocApproval');
    const ledger = await createLedger(tenant, { code: 'DOCAP', year: 2027 });
    fx = await createSubledger(tenant, ledger, { year: 2027 });
    // APPROVE reach over AR and AP. The tenant owner prepares every document
    // below, so this is the only person who can approve one of them.
    checker = await createEntityRestrictedUser(tenant, ledger.legalEntityId, 'finance_manager');
  }, 240_000);

  afterAll(closeTestApp);

  async function draftInvoice(amount: string): Promise<string> {
    const response = await http()
      .post('/invoices')
      .set(tenant.auth)
      .send({
        accounting_book_id: fx.accountingBookId,
        customer_id: fx.customerId,
        document_date: JAN,
        posting_date: JAN,
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
    return response.body.id as string;
  }

  let billCounter = 0;
  async function draftBill(amount: string): Promise<string> {
    const response = await http()
      .post('/vendor-bills')
      .set(tenant.auth)
      .send({
        accounting_book_id: fx.accountingBookId,
        vendor_id: fx.vendorId,
        vendor_invoice_number: `APPROVAL-${billCounter++}`,
        document_date: JAN,
        posting_date: JAN,
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
    return response.body.id as string;
  }

  // -------------------------------------------------------------------------
  // 1. A document awaiting approval cannot post
  // -------------------------------------------------------------------------

  describe('a document awaiting approval', () => {
    // PENDING_APPROVAL is in `document_status` and in the contract's lifecycle,
    // and no route in the platform puts a document into it — which is a separate
    // gap, reported rather than fixed here, because entering the state is the
    // approval engine's job and that is Phase 6 proper. The state is set
    // directly so the guard can be tested against the state itself: whatever
    // eventually writes it, a document sitting in it must not become a journal.
    async function park(
      table: 'invoices' | 'vendor_bills' | 'credit_notes',
      id: string,
    ): Promise<void> {
      await fixturePool().query(`UPDATE ${table} SET status = 'PENDING_APPROVAL' WHERE id = $1`, [
        id,
      ]);
    }

    it('refuses to post an invoice that is waiting for approval', async () => {
      const id = await draftInvoice('500.00');
      await park('invoices', id);

      const refused = await http()
        .post(`/invoices/${id}/post`)
        .set(tenant.auth)
        .set(key(`post-pending-invoice-${id}`))
        .send({})
        .expect(403);
      expect(refused.body.code).toBe('APPROVAL_REQUIRED');
      expect(refused.body.message).toMatch(/waiting for approval/i);
    });

    it('refuses to post a vendor bill that is waiting for approval', async () => {
      const id = await draftBill('500.00');
      await park('vendor_bills', id);

      const refused = await http()
        .post(`/vendor-bills/${id}/post`)
        .set(tenant.auth)
        .set(key(`post-pending-bill-${id}`))
        .send({})
        .expect(403);
      expect(refused.body.code).toBe('APPROVAL_REQUIRED');
      expect(refused.body.message).toMatch(/waiting for approval/i);
    });

    it('refuses to post a credit note that is waiting for approval', async () => {
      // The document the hole mattered most on. A credit note reduces what a
      // customer owes, so posting one out of the approval queue moves money in
      // the direction nobody has reviewed — and a control the credit documents
      // did not share is a control with a documented way round it.
      const invoiceId = await draftInvoice('600.00');
      await http()
        .post(`/invoices/${invoiceId}/post`)
        .set(tenant.auth)
        .set(key(`post-for-credit-${invoiceId}`))
        .send({})
        .expect(200);

      const creditNote = await http()
        .post('/credit-notes')
        .set(tenant.auth)
        .send({
          accounting_book_id: fx.accountingBookId,
          customer_id: fx.customerId,
          invoice_id: invoiceId,
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
      await park('credit_notes', creditNote.body.id);

      const refused = await http()
        .post(`/credit-notes/${creditNote.body.id}/post`)
        .set(tenant.auth)
        .set(key(`post-pending-cn-${creditNote.body.id}`))
        .send({})
        .expect(403);
      expect(refused.body.code).toBe('APPROVAL_REQUIRED');
      expect(refused.body.message).toMatch(/waiting for approval/i);
    });

    it('still posts an ordinary draft that never entered the approval step', async () => {
      // doc 04: `DRAFT -> PENDING_APPROVAL(optional) -> APPROVED -> POSTED`. The
      // step is optional to ENTER; it is finishing it that is not optional. A
      // fix that made every invoice need an approval would be a different bug.
      const id = await draftInvoice('500.00');
      const posted = await http()
        .post(`/invoices/${id}/post`)
        .set(tenant.auth)
        .set(key(`post-plain-invoice-${id}`))
        .send({})
        .expect(200);
      expect(posted.body.status).toBe('POSTED');
    });
  });

  // -------------------------------------------------------------------------
  // 2. Maker/checker
  // -------------------------------------------------------------------------

  describe('invoice approval', () => {
    it('refuses an approval by the person who raised the invoice', async () => {
      const id = await draftInvoice('750.00');
      const refused = await http()
        .post(`/invoices/${id}/approve`)
        .set(tenant.auth)
        .set(key(`approve-self-invoice-${id}`))
        .send({})
        .expect(403);
      expect(refused.body.code).toBe('SEGREGATION_OF_DUTIES');
      expect(refused.body.message).toMatch(/you raised this invoice/i);
    });

    it('records who approved it when a different person does, and carries it onto the journal', async () => {
      const id = await draftInvoice('751.00');
      await http()
        .post(`/invoices/${id}/approve`)
        .set(checker.auth)
        .set(key(`approve-invoice-${id}`))
        .send({})
        .expect(200);

      // On the row, not only in the event payload. Before 0049 the only trace of
      // an approval was a published event, which nothing downstream could check.
      const { rows } = await fixturePool().query<{ created_by: string; approved_by: string }>(
        `SELECT created_by, approved_by FROM invoices WHERE id = $1`,
        [id],
      );
      expect(rows[0]?.created_by).toBe(tenant.userId);
      expect(rows[0]?.approved_by).toBe(checker.userId);

      const posted = await http()
        .post(`/invoices/${id}/post`)
        .set(tenant.auth)
        .set(key(`post-approved-invoice-${id}`))
        .send({})
        .expect(200);
      expect(posted.body.status).toBe('POSTED');

      // The document's maker and checker become the journal's, so the ledger's
      // own approval threshold is satisfied by the approval the DOCUMENT carries
      // rather than by whoever called the post endpoint — who is recorded
      // separately as posted_by.
      const { rows: entry } = await fixturePool().query<{
        created_by: string;
        approved_by: string;
        posted_by: string;
      }>(
        `SELECT e.created_by, e.approved_by, e.posted_by
           FROM journal_entries e
           JOIN invoices i ON i.accounting_entry_id = e.id
          WHERE i.id = $1`,
        [id],
      );
      expect(entry[0]?.created_by).toBe(tenant.userId);
      expect(entry[0]?.approved_by).toBe(checker.userId);
      expect(entry[0]?.posted_by).toBe(tenant.userId);
    });
  });

  describe('vendor bill approval', () => {
    it('refuses an approval by the person who entered the bill', async () => {
      const id = await draftBill('900.00');
      const refused = await http()
        .post(`/vendor-bills/${id}/approve`)
        .set(tenant.auth)
        .set(key(`approve-self-bill-${id}`))
        .send({})
        .expect(403);
      expect(refused.body.code).toBe('SEGREGATION_OF_DUTIES');
      expect(refused.body.message).toMatch(/you entered this bill/i);
    });

    it('records the preparer the table never had, and the approver, when a different person approves', async () => {
      // A different amount from the bill above: doc 05 duplicate detection reads
      // vendor + date + amount as one of its signals, and two bills for the same
      // vendor, day and total are exactly what it is meant to stop.
      const id = await draftBill('901.00');

      // The column migration 0049 added. Without it the refusal above could not
      // be expressed at all — there was no maker to compare a checker against.
      const { rows: before } = await fixturePool().query<{ created_by: string | null }>(
        `SELECT created_by FROM vendor_bills WHERE id = $1`,
        [id],
      );
      expect(before[0]?.created_by).toBe(tenant.userId);

      await http()
        .post(`/vendor-bills/${id}/approve`)
        .set(checker.auth)
        .set(key(`approve-bill-${id}`))
        .send({})
        .expect(200);

      const { rows } = await fixturePool().query<{ approved_by: string; approved_at: string }>(
        `SELECT approved_by, approved_at::text AS approved_at FROM vendor_bills WHERE id = $1`,
        [id],
      );
      expect(rows[0]?.approved_by).toBe(checker.userId);
      expect(rows[0]?.approved_at).toBeTruthy();

      const posted = await http()
        .post(`/vendor-bills/${id}/post`)
        .set(tenant.auth)
        .set(key(`post-approved-bill-${id}`))
        .send({})
        .expect(200);
      expect(posted.body.status).toBe('POSTED');
    });
  });

  // -------------------------------------------------------------------------
  // 3. The ledger threshold reaches the subledger path
  // -------------------------------------------------------------------------

  /**
   * A criterion proved on part of its domain is proved on none of it.
   *
   * `approval-threshold.test.ts` proves the threshold on manual journals, which
   * is the path a person drives by hand. Every subledger document arrives at the
   * same `commitPosting` through `DocumentPostingService`, and that is the path
   * most of the money actually takes — so the same two halves are proved there
   * rather than assumed from the shared function.
   */
  describe('a subledger document over the ledger threshold', () => {
    const THRESHOLD = '10000.00';

    beforeAll(async () => {
      // Effective from the 10th, which covers the 15th every document here is
      // dated. `createPolicyVersion` states a version in full rather than
      // patching one, so the fixture's account mappings are restated with it.
      await http()
        .post('/accounting-policies')
        .set(tenant.auth)
        .send({
          legal_entity_id: fx.legalEntityId,
          valid_from: '2027-01-10',
          rounding_account_id: fx.accounts.rounding,
          ar_control_account_id: fx.accounts.ar,
          ap_control_account_id: fx.accounts.ap,
          cash_clearing_account_id: fx.accounts.cash,
          payment_clearing_account_id: fx.accounts.paymentClearing,
          retained_earnings_account_id: fx.accounts.equity,
          bad_debt_account_id: fx.accounts.badDebt,
          grni_account_id: fx.accounts.grni,
          customer_advance_account_id: fx.accounts.customerAdvance,
          vendor_advance_account_id: fx.accounts.vendorAdvance,
          realized_fx_gain_account_id: fx.accounts.fxGain,
          realized_fx_loss_account_id: fx.accounts.fxLoss,
          journal_approval_threshold: THRESHOLD,
        })
        .expect(201);
    }, 60_000);

    it('refuses to post a large unapproved invoice, naming the threshold', async () => {
      const id = await draftInvoice('20000.00');
      const refused = await http()
        .post(`/invoices/${id}/post`)
        .set(tenant.auth)
        .set(key(`post-big-invoice-${id}`))
        .send({})
        .expect(403);
      expect(refused.body.code).toBe('APPROVAL_REQUIRED');
      expect(refused.body.message).toContain(THRESHOLD);
      // 20000 net plus 20% VAT: the journal's value, which is what the threshold
      // is measured against — not the invoice subtotal.
      expect(refused.body.message).toContain('24000');
    });

    it('posts the same invoice once a second person has approved it', async () => {
      const id = await draftInvoice('20001.00');
      await http()
        .post(`/invoices/${id}/approve`)
        .set(checker.auth)
        .set(key(`approve-big-invoice-${id}`))
        .send({})
        .expect(200);

      const posted = await http()
        .post(`/invoices/${id}/post`)
        .set(tenant.auth)
        .set(key(`post-big-approved-invoice-${id}`))
        .send({})
        .expect(200);
      expect(posted.body.status).toBe('POSTED');
    });

    it('still posts a small invoice with no approval', async () => {
      // The half that keeps the threshold from being an outage for the subledger
      // as well as for the ledger.
      const id = await draftInvoice('300.00');
      const posted = await http()
        .post(`/invoices/${id}/post`)
        .set(tenant.auth)
        .set(key(`post-small-invoice-${id}`))
        .send({})
        .expect(200);
      expect(posted.body.status).toBe('POSTED');
    });

    it('refuses to post a large unapproved vendor bill', async () => {
      const id = await draftBill('20000.00');
      const refused = await http()
        .post(`/vendor-bills/${id}/post`)
        .set(tenant.auth)
        .set(key(`post-big-bill-${id}`))
        .send({})
        .expect(403);
      expect(refused.body.code).toBe('APPROVAL_REQUIRED');
      expect(refused.body.message).toContain(THRESHOLD);
    });

    it('posts the same bill once a second person has approved it', async () => {
      const id = await draftBill('20002.00');
      await http()
        .post(`/vendor-bills/${id}/approve`)
        .set(checker.auth)
        .set(key(`approve-big-bill-${id}`))
        .send({})
        .expect(200);
      const posted = await http()
        .post(`/vendor-bills/${id}/post`)
        .set(tenant.auth)
        .set(key(`post-big-approved-bill-${id}`))
        .send({})
        .expect(200);
      expect(posted.body.status).toBe('POSTED');
    });
  });
});
