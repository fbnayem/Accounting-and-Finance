import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  JournalService,
  LedgerProjectionService,
  PostingService,
  SYSTEM_ACTOR_ID,
  runDueReversals,
} from '@acct/ledger';
import {
  accountBalance,
  closeTestApp,
  createEntityRestrictedUser,
  createLedger,
  createTenant,
  elevatedSession,
  fixturePool,
  http,
  runtimePool,
  satisfyMfa,
  testApp,
  type LedgerFixture,
  type TenantFixture,
} from './harness';

/**
 * Phase 6's period-end entries and reconciling items, over real HTTP.
 *
 * Two claims are proved in BOTH directions, because a control that only refuses
 * is indistinguishable from one that refuses everything:
 *
 *   - An ACCRUAL registers its reversal with the F-612 scheduler at creation —
 *     and the reversal actually POSTS when the worker runs, unwinding the
 *     accrued liability. An accrual that is created but never reverses is a
 *     permanent misstatement, so "the schedule row exists" alone would not be
 *     evidence; the balance going back to zero is.
 *   - A reconciling item under an open reconciliation is ACCEPTED and under a
 *     CERTIFIED one is REFUSED (the certified sum is what the certifier signed);
 *     resolving an item under a CERTIFIED parent is ACCEPTED (a clearance
 *     changes no amount and ordinarily happens after certification), and the
 *     formal reopen unlocks the child side again.
 */
const silent = { info: () => {}, warn: () => {}, error: () => {} };

let tenant: TenantFixture;
let ledger: LedgerFixture;
let elevated: { Authorization: string };
let certifier: { auth: { Authorization: string }; userId: string };
let accruedLiabilityId: string;
let prepaidAssetId: string;
let deferredRevenueId: string;

let key = 0;
const idem = (label: string) => ({ 'Idempotency-Key': `pe-${label}-${key++}` });

async function createAccount(code: string, name: string, type: string): Promise<string> {
  const created = await http()
    .post('/accounts')
    .set(tenant.auth)
    .send({ legal_entity_id: ledger.legalEntityId, code, name, account_type: type })
    .expect(201);
  return created.body.id;
}

describe('period-end entries and reconciling items', () => {
  beforeAll(async () => {
    await testApp();
    tenant = await createTenant('PeriodEnd');
    ledger = await createLedger(tenant, { code: `PE${Date.now().toString(36).slice(-4)}` });
    elevated = await elevatedSession(tenant);
    // reconciliation.certify is a maker/checker control: the preparer (the
    // owner) cannot certify their own reconciliation. finance_manager reaches
    // reconciliation.certify and reconciliation.reopen.
    certifier = await createEntityRestrictedUser(tenant, ledger.legalEntityId, 'finance_manager');
    // reconciliation.reopen and journal.post_control are high-risk (ADR-0005 §3).
    await satisfyMfa(tenant.userId);
    await satisfyMfa(certifier.userId);

    accruedLiabilityId = await createAccount('2400', 'Accrued liabilities', 'LIABILITY');
    prepaidAssetId = await createAccount('1350', 'Prepaid expenses', 'ASSET');
    deferredRevenueId = await createAccount('2500', 'Deferred revenue', 'LIABILITY');
  }, 240_000);

  afterAll(closeTestApp);

  // =========================================================================
  // ACCRUAL — posts through EXPENSE_ACCRUAL and reverses through F-612
  // =========================================================================

  describe('accruals', () => {
    let entryId: string;
    let scheduledReversalId: string;

    it('creates the accrual, posts its journal and registers the scheduled reversal atomically', async () => {
      const created = await http()
        .post('/period-end-entries')
        .set(tenant.auth)
        .set(idem('accrual'))
        .send({
          accounting_book_id: ledger.accountingBookId,
          posting_date: '2027-05-31',
          entry_type: 'ACCRUAL',
          description: 'May electricity, invoice expected June',
          total_amount: '500.00',
          balance_account_id: accruedLiabilityId,
          pl_account_id: ledger.accounts.expense,
          reversal_date: '2027-06-30',
        })
        .expect(201);

      entryId = created.body.id;
      expect(created.body.entry_type).toBe('ACCRUAL');
      expect(created.body.journal_entry_id).toBeTruthy();
      expect(created.body.entry_number).toBeTruthy();
      expect(created.body.scheduled_reversal).toMatchObject({
        status: 'PENDING',
        scheduled_date: '2027-06-30',
      });
      scheduledReversalId = created.body.scheduled_reversal.id;

      // EXPENSE_ACCRUAL: Dr Expense / Cr Accrued Liability, as posted rows.
      expect(await accountBalance(tenant, ledger, accruedLiabilityId)).toBe(-500);

      // The schedule is a real F-612 row the claim function will find — not a
      // private copy of the machine.
      const { rows } = await fixturePool().query<{
        status: string;
        scheduled_date: string;
        journal_entry_id: string;
      }>(
        `SELECT status, scheduled_date::text AS scheduled_date, journal_entry_id
           FROM scheduled_reversals WHERE id = $1`,
        [scheduledReversalId],
      );
      expect(rows[0]).toMatchObject({
        status: 'PENDING',
        scheduled_date: '2027-06-30',
        journal_entry_id: created.body.journal_entry_id,
      });
    });

    it('actually unwinds: the standard scheduler posts the reversal and the liability returns to zero', async () => {
      const journals = new JournalService(
        runtimePool(),
        new PostingService(new LedgerProjectionService()),
      );
      const result = await runDueReversals(runtimePool(), journals, silent, {
        today: '2027-06-30',
        actorId: SYSTEM_ACTOR_ID,
      });
      expect(result.succeeded).toBeGreaterThanOrEqual(1);

      const { rows } = await fixturePool().query<{
        status: string;
        reversal_entry_id: string | null;
      }>(`SELECT status, reversal_entry_id FROM scheduled_reversals WHERE id = $1`, [
        scheduledReversalId,
      ]);
      expect(rows[0]!.status).toBe('EXECUTED');
      expect(rows[0]!.reversal_entry_id).not.toBeNull();

      // The accrued liability is cleared: recognised in May, unwound in June.
      expect(await accountBalance(tenant, ledger, accruedLiabilityId)).toBe(0);

      const got = await http().get(`/period-end-entries/${entryId}`).set(tenant.auth).expect(200);
      expect(got.body.scheduled_reversal.status).toBe('EXECUTED');
      expect(got.body.scheduled_reversal.reversal_entry_id).toBe(rows[0]!.reversal_entry_id);
      expect(got.body.journal_status).toBe('REVERSED');
    });

    it('refuses an accrual with no reversal date — the permanent-misstatement shape', async () => {
      const refused = await http()
        .post('/period-end-entries')
        .set(tenant.auth)
        .set(idem('accrual-no-rev'))
        .send({
          accounting_book_id: ledger.accountingBookId,
          posting_date: '2027-05-31',
          entry_type: 'ACCRUAL',
          description: 'accrual that would never unwind',
          total_amount: '10.00',
          balance_account_id: accruedLiabilityId,
          pl_account_id: ledger.accounts.expense,
        })
        .expect(422);
      expect(refused.body.code).toBe('VALIDATION_FAILED');
      expect(refused.body.message).toMatch(/reversal_date/);
      expect(refused.body.message).toMatch(/never unwinds|permanent misstatement/);
    });

    it('refuses a reversal date that is not after the posting date', async () => {
      const refused = await http()
        .post('/period-end-entries')
        .set(tenant.auth)
        .set(idem('accrual-same-day'))
        .send({
          accounting_book_id: ledger.accountingBookId,
          posting_date: '2027-05-31',
          entry_type: 'ACCRUAL',
          description: 'reverses into its own period',
          total_amount: '10.00',
          balance_account_id: accruedLiabilityId,
          pl_account_id: ledger.accounts.expense,
          reversal_date: '2027-05-31',
        })
        .expect(422);
      expect(refused.body.message).toContain('later period');
    });

    it('refuses recognition on an accrual, naming the scheduled reversal as the unwind path', async () => {
      const refused = await http()
        .post(`/period-end-entries/${entryId}/recognize`)
        .set(tenant.auth)
        .set(idem('accrual-recognize'))
        .send({ accounting_period_id: ledger.periods[5]!.id })
        .expect(422);
      expect(refused.body.message).toContain('ACCRUAL');
      expect(refused.body.message).toContain('scheduled reversal');
    });
  });

  // =========================================================================
  // PREPAID — PREPAID_PURCHASE then PREPAID_AMORTIZATION, idempotent per period
  // =========================================================================

  describe('prepaids', () => {
    let entryId: string;
    let januaryJournalId: string;

    it('creates the prepaid and posts Dr Prepaid Asset / Cr Bank', async () => {
      const created = await http()
        .post('/period-end-entries')
        .set(tenant.auth)
        .set(idem('prepaid'))
        .send({
          accounting_book_id: ledger.accountingBookId,
          posting_date: '2027-01-15',
          entry_type: 'PREPAID',
          description: 'Annual insurance premium',
          total_amount: '1200.00',
          balance_account_id: prepaidAssetId,
          pl_account_id: ledger.accounts.expense,
          settlement_account_id: ledger.accounts.bank,
          recognition_start_date: '2027-01-01',
          recognition_periods: 12,
        })
        .expect(201);
      entryId = created.body.id;
      expect(created.body.remaining_balance).toBe('1200.00000000');
      expect(created.body.status).toBe('ACTIVE');
      expect(await accountBalance(tenant, ledger, prepaidAssetId)).toBe(1200);
    });

    it('recognises one period at the straight-line portion', async () => {
      const jan = ledger.periods.find((p) => p.period_no === 1)!;
      const recognized = await http()
        .post(`/period-end-entries/${entryId}/recognize`)
        .set(tenant.auth)
        .set(idem('prepaid-jan'))
        .send({ accounting_period_id: jan.id })
        .expect(201);
      expect(recognized.body.amount).toBe('100.00000000');
      expect(recognized.body.recognized_total).toBe('100.00000000');
      expect(recognized.body.remaining_balance).toBe('1100.00000000');
      expect(recognized.body.replayed).toBe(false);
      januaryJournalId = recognized.body.journal_entry_id;
      expect(await accountBalance(tenant, ledger, prepaidAssetId)).toBe(1100);
    });

    it('is idempotent per entry and period: a rerun posts nothing and answers with the first run', async () => {
      const jan = ledger.periods.find((p) => p.period_no === 1)!;
      const rerun = await http()
        .post(`/period-end-entries/${entryId}/recognize`)
        .set(tenant.auth)
        .set(idem('prepaid-jan-rerun')) // a DIFFERENT key: this is the 0046 property, not the interceptor
        .send({ accounting_period_id: jan.id })
        .expect(201);
      expect(rerun.body.replayed).toBe(true);
      expect(rerun.body.amount).toBe('100.00000000');
      expect(rerun.body.journal_entry_id).toBe(januaryJournalId);
      expect(rerun.body.recognized_total).toBe('100.00000000');
      // Not a second month of amortization: the balance did not move.
      expect(await accountBalance(tenant, ledger, prepaidAssetId)).toBe(1100);
    });

    it('accepts an explicit amount, reaches FULLY_RECOGNIZED at exactly zero remaining', async () => {
      const feb = ledger.periods.find((p) => p.period_no === 2)!;
      const final = await http()
        .post(`/period-end-entries/${entryId}/recognize`)
        .set(tenant.auth)
        .set(idem('prepaid-feb'))
        .send({ accounting_period_id: feb.id, amount: '1100.00' })
        .expect(201);
      expect(final.body.remaining_balance).toBe('0.00000000');
      expect(final.body.entry_status).toBe('FULLY_RECOGNIZED');
      expect(await accountBalance(tenant, ledger, prepaidAssetId)).toBe(0);

      const mar = ledger.periods.find((p) => p.period_no === 3)!;
      const spent = await http()
        .post(`/period-end-entries/${entryId}/recognize`)
        .set(tenant.auth)
        .set(idem('prepaid-mar'))
        .send({ accounting_period_id: mar.id })
        .expect(409);
      expect(spent.body.code).toBe('POSTED_IMMUTABLE');
      expect(spent.body.message).toContain('fully recognised');
    });

    it('refuses to release more than the entry still carries, naming both numbers', async () => {
      const created = await http()
        .post('/period-end-entries')
        .set(tenant.auth)
        .set(idem('prepaid-small'))
        .send({
          accounting_book_id: ledger.accountingBookId,
          posting_date: '2027-01-15',
          entry_type: 'PREPAID',
          description: 'Small prepaid',
          total_amount: '100.00',
          balance_account_id: prepaidAssetId,
          pl_account_id: ledger.accounts.expense,
          settlement_account_id: ledger.accounts.bank,
          recognition_start_date: '2027-01-01',
          recognition_periods: 2,
        })
        .expect(201);

      const jan = ledger.periods.find((p) => p.period_no === 1)!;
      const over = await http()
        .post(`/period-end-entries/${created.body.id}/recognize`)
        .set(tenant.auth)
        .set(idem('prepaid-over'))
        .send({ accounting_period_id: jan.id, amount: '150.00' })
        .expect(422);
      expect(over.body.message).toContain('150.00');
      expect(over.body.message).toContain('100.00');
    });

    it('refuses a prepaid without its recognition schedule', async () => {
      const refused = await http()
        .post('/period-end-entries')
        .set(tenant.auth)
        .set(idem('prepaid-no-schedule'))
        .send({
          accounting_book_id: ledger.accountingBookId,
          posting_date: '2027-01-15',
          entry_type: 'PREPAID',
          description: 'no schedule',
          total_amount: '10.00',
          balance_account_id: prepaidAssetId,
          pl_account_id: ledger.accounts.expense,
          settlement_account_id: ledger.accounts.bank,
        })
        .expect(422);
      expect(refused.body.message).toContain('recognition_start_date');
    });

    it('shows the drill: the entry, its recognitions and the journals they posted', async () => {
      const got = await http().get(`/period-end-entries/${entryId}`).set(tenant.auth).expect(200);
      expect(got.body.recognized_total).toBe('1200.00000000');
      expect(got.body.remaining_balance).toBe('0.00000000');
      expect(got.body.status).toBe('FULLY_RECOGNIZED');
      expect(got.body.recognitions).toHaveLength(2);
      for (const recognition of got.body.recognitions) {
        expect(recognition.journal_entry_id).toBeTruthy();
        expect(recognition.entry_number).toBeTruthy();
        expect(recognition.period_name).toBeTruthy();
      }
    });
  });

  // =========================================================================
  // DEFERRAL — DEFERRED_REVENUE_BILLING then REVENUE_RECOGNIZED
  // =========================================================================

  describe('deferrals', () => {
    it('bills into deferred revenue and releases one period into revenue', async () => {
      const created = await http()
        .post('/period-end-entries')
        .set(tenant.auth)
        .set(idem('deferral'))
        .send({
          accounting_book_id: ledger.accountingBookId,
          posting_date: '2027-01-10',
          entry_type: 'DEFERRAL',
          description: 'Six-month support contract billed up front',
          total_amount: '600.00',
          balance_account_id: deferredRevenueId,
          pl_account_id: ledger.accounts.revenue,
          settlement_account_id: ledger.accounts.bank,
          recognition_start_date: '2027-01-01',
          recognition_periods: 6,
        })
        .expect(201);
      // Dr Bank / Cr Deferred Revenue: a liability, not revenue, on day one.
      expect(await accountBalance(tenant, ledger, deferredRevenueId)).toBe(-600);

      const jan = ledger.periods.find((p) => p.period_no === 1)!;
      const recognized = await http()
        .post(`/period-end-entries/${created.body.id}/recognize`)
        .set(tenant.auth)
        .set(idem('deferral-jan'))
        .send({ accounting_period_id: jan.id })
        .expect(201);
      expect(recognized.body.amount).toBe('100.00000000');
      // REVENUE_RECOGNIZED: Dr Deferred Revenue / Cr Revenue.
      expect(await accountBalance(tenant, ledger, deferredRevenueId)).toBe(-500);
    });

    it('lists entries with their remaining balances, filtered by book', async () => {
      const list = await http()
        .get('/period-end-entries')
        .query({ accounting_book_id: ledger.accountingBookId })
        .set(tenant.auth)
        .expect(200);
      expect(list.body.data.length).toBeGreaterThanOrEqual(4);
      expect(list.body.meta).toMatchObject({ has_more: false, next_cursor: null });
      for (const row of list.body.data) {
        expect(row.remaining_balance).toBeDefined();
        expect(row.entry_number).toBeTruthy();
      }
      const accrual = list.body.data.find(
        (r: { entry_type: string }) => r.entry_type === 'ACCRUAL',
      );
      expect(accrual.reversal_status).toBe('EXECUTED');
    });
  });

  // =========================================================================
  // Reconciling items — Gate D's artifact, and the certified-parent decision
  // =========================================================================

  describe('reconciling items', () => {
    let reconciliationId: string;
    let timingItemId: string;

    beforeAll(async () => {
      // 60.00 of GL that the subledger does not carry: post 100 into the AR
      // control account (journal.post_control, high-risk, MFA satisfied above)
      // and reconcile against a supporting balance of 40.
      const draft = await http()
        .post('/journals')
        .set(tenant.auth)
        .send({
          accounting_book_id: ledger.accountingBookId,
          journal_id: ledger.generalJournalId,
          posting_date: '2027-03-10',
          description: 'AR movement for the reconciliation fixture',
          lines: [
            { account_id: ledger.accounts.ar, debit: '100.00' },
            { account_id: ledger.accounts.revenue, credit: '100.00' },
          ],
        })
        .expect(201);
      await http()
        .post(`/journals/${draft.body.id}/post`)
        .set(elevated)
        .set(idem('ar-post'))
        .send({})
        .expect(200);

      const march = ledger.periods.find((p) => p.period_no === 3)!;
      const recon = await http()
        .post('/account-reconciliations')
        .set(tenant.auth)
        .send({
          legal_entity_id: ledger.legalEntityId,
          accounting_book_id: ledger.accountingBookId,
          accounting_period_id: march.id,
          account_id: ledger.accounts.ar,
          supporting_balance: '40.00',
        })
        .expect(201);
      reconciliationId = recon.body.id;
      expect(recon.body.difference).toBe('60.00000000');
    }, 120_000);

    it('refuses certification while the difference is unexplained', async () => {
      const refused = await http()
        .post(`/account-reconciliations/${reconciliationId}/certify`)
        .set(certifier.auth)
        .set(idem('certify-early'))
        .send({})
        .expect(422);
      expect(refused.body.message).toContain('difference of 60');
      expect(refused.body.message).toContain('reconciling-items');
    });

    it('ACCEPTS items under an open reconciliation — the half that makes a non-zero difference certifiable', async () => {
      const timing = await http()
        .post(`/account-reconciliations/${reconciliationId}/reconciling-items`)
        .set(tenant.auth)
        .set(idem('item-timing'))
        .send({
          item_type: 'TIMING',
          description: 'Invoice issued 31 Mar, in the subledger 1 Apr',
          amount: '45.00',
          expected_clear_date: '2027-04-15',
        })
        .expect(201);
      timingItemId = timing.body.id;
      expect(timing.body.explained).toBe(false);

      const suspense = await http()
        .post(`/account-reconciliations/${reconciliationId}/reconciling-items`)
        .set(tenant.auth)
        .set(idem('item-suspense'))
        .send({
          item_type: 'UNRECORDED',
          description: 'Unapplied receipt held in suspense',
          amount: '15.00',
        })
        .expect(201);
      expect(suspense.body.reconciling_items_total).toBe('60.00000000');
      expect(suspense.body.explained).toBe(true);
    });

    it('refuses an item that explains nothing', async () => {
      const zero = await http()
        .post(`/account-reconciliations/${reconciliationId}/reconciling-items`)
        .set(tenant.auth)
        .set(idem('item-zero'))
        .send({ item_type: 'OTHER', description: 'a note pretending to be an item', amount: '0' })
        .expect(422);
      expect(zero.body.message).toContain('explains nothing');
    });

    it('lists the items with the Gate D summary', async () => {
      const list = await http()
        .get(`/account-reconciliations/${reconciliationId}/reconciling-items`)
        .set(tenant.auth)
        .expect(200);
      expect(list.body.data).toHaveLength(2);
      expect(list.body.summary).toMatchObject({
        difference: '60.00000000',
        items_total: '60.00000000',
        explained: true,
        unresolved_count: 2,
      });
      expect(list.body.meta.has_more).toBe(false);
    });

    it('certifies once the items sum to the difference exactly', async () => {
      const certified = await http()
        .post(`/account-reconciliations/${reconciliationId}/certify`)
        .set(certifier.auth)
        .set(idem('certify'))
        .send({})
        .expect(200);
      expect(certified.body.status).toBe('CERTIFIED');
    });

    it('REFUSES a new item under the certified parent, naming the reopen route', async () => {
      const refused = await http()
        .post(`/account-reconciliations/${reconciliationId}/reconciling-items`)
        .set(tenant.auth)
        .set(idem('item-after-certify'))
        .send({ item_type: 'ERROR', description: 'late arrival', amount: '5.00' })
        .expect(409);
      expect(refused.body.code).toBe('POSTED_IMMUTABLE');
      expect(refused.body.message).toContain('/account-reconciliations/{id}/reopen');
    });

    it('ACCEPTS resolving an item under the certified parent — a clearance changes no amount', async () => {
      const resolved = await http()
        .post(`/reconciling-items/${timingItemId}/resolve`)
        .set(tenant.auth)
        .set(idem('resolve'))
        .send({ note: 'cleared with the April subledger close' })
        .expect(200);
      expect(resolved.body.resolved_at).toBeTruthy();
      expect(resolved.body.reconciliation_status).toBe('CERTIFIED');

      const again = await http()
        .post(`/reconciling-items/${timingItemId}/resolve`)
        .set(tenant.auth)
        .set(idem('resolve-again'))
        .send({})
        .expect(422);
      expect(again.body.message).toContain('already resolved');

      const list = await http()
        .get(`/account-reconciliations/${reconciliationId}/reconciling-items`)
        .set(tenant.auth)
        .expect(200);
      expect(list.body.summary.unresolved_count).toBe(1);
    });

    it('refuses to reopen a reconciliation that was never certified', async () => {
      const feb = ledger.periods.find((p) => p.period_no === 2)!;
      const prepared = await http()
        .post('/account-reconciliations')
        .set(tenant.auth)
        .send({
          legal_entity_id: ledger.legalEntityId,
          accounting_book_id: ledger.accountingBookId,
          accounting_period_id: feb.id,
          account_id: ledger.accounts.ar,
          supporting_balance: '0.00',
        })
        .expect(201);
      const refused = await http()
        .post(`/account-reconciliations/${prepared.body.id}/reopen`)
        .set(tenant.auth)
        .set(idem('reopen-prepared'))
        .send({ reason: 'nothing to withdraw' })
        .expect(422);
      expect(refused.body.message).toContain('only a CERTIFIED or APPROVED');
    });

    it('formally reopens the certified reconciliation and unlocks the child side again', async () => {
      const reopened = await http()
        .post(`/account-reconciliations/${reconciliationId}/reopen`)
        .set(tenant.auth)
        .set(idem('reopen'))
        .send({ reason: 'timing item was misstated; 45.00 was actually 40.00 plus a 5.00 error' })
        .expect(200);
      expect(reopened.body.status).toBe('REOPENED');
      expect(reopened.body.previous_status).toBe('CERTIFIED');

      // The withdrawn certification does not linger on the row.
      const { rows } = await fixturePool().query<{
        approved_by: string | null;
        reopened_reason: string;
      }>(`SELECT approved_by, reopened_reason FROM account_reconciliations WHERE id = $1`, [
        reconciliationId,
      ]);
      expect(rows[0]!.approved_by).toBeNull();
      expect(rows[0]!.reopened_reason).toContain('misstated');

      // The other half of the certified-parent refusal: after the formal
      // reopen, the child side is writable again.
      const accepted = await http()
        .post(`/account-reconciliations/${reconciliationId}/reconciling-items`)
        .set(tenant.auth)
        .set(idem('item-after-reopen'))
        .send({ item_type: 'ERROR', description: 'posting error found at reopen', amount: '5.00' })
        .expect(201);
      expect(accepted.body.reconciliation_status).toBe('REOPENED');
    });
  });
});
