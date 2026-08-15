import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestApp,
  createEntityRestrictedUser,
  createLedger,
  createTenant,
  fixturePool,
  http,
  satisfyMfa,
  testApp,
  type LedgerFixture,
  type TenantFixture,
} from './harness';

/**
 * The approval bypass, closed — over HTTP, as a caller meets it.
 *
 * The Phase 6 audit's worst finding, and it was in shipped Phase 2/3 code:
 * `accounting_policies.journal_approval_threshold` had been configurable since
 * Phase 0 and readable in every posting context since Phase 2, and was compared
 * to nothing. Phase 6's exit criterion is "Approval bypass attempts fail at
 * API/domain layer" — there was nothing to bypass, because posting without
 * approval was the only path.
 *
 * Over HTTP rather than against the service, because the criterion is about the
 * API layer and because the message is half the deliverable: `AppError.details`
 * never reaches a response body, so a refusal whose message does not name the
 * amount and the threshold tells the person holding the journal nothing they can
 * act on. That is asserted here on the wire, not on an object.
 *
 * Both halves, every time. A control that only refuses is indistinguishable from
 * one that refuses everything, and one that refused every large journal would be
 * an outage wearing a control's clothes:
 *
 *   - at or over the threshold with no approval  -> 403 APPROVAL_REQUIRED
 *   - at or over the threshold WITH an approval  -> posts
 *   - under the threshold with no approval       -> posts
 *   - approving your own submission              -> 403 SEGREGATION_OF_DUTIES
 *   - a different person approving it            -> succeeds
 */
describe('Phase 6 — the journal approval threshold is enforced', () => {
  let tenant: TenantFixture;
  let ledger: LedgerFixture;
  /** Prepares journals. `accountant` is OPERATE on the ledger: creates, submits, posts. */
  let maker: { auth: { Authorization: string }; userId: string };
  /** Approves them. `finance_manager` is APPROVE on the ledger. */
  let checker: { auth: { Authorization: string }; userId: string };

  const THRESHOLD = '10000.00';
  const march = '2027-03-15';

  beforeAll(async () => {
    await testApp();
    tenant = await createTenant('Approval');
    ledger = await createLedger(tenant, { code: 'APPR', year: 2027 });

    maker = await createEntityRestrictedUser(tenant, ledger.legalEntityId, 'accountant');
    checker = await createEntityRestrictedUser(tenant, ledger.legalEntityId, 'finance_manager');

    // `journal.post` is one of doc 02's high-risk permissions, so ADR-0005 §3
    // demands recent re-authentication before any of these posts. Driving a real
    // TOTP enrolment per user would test the clock; `credentials.test.ts` covers
    // the algorithm.
    await satisfyMfa(maker.userId);
    await satisfyMfa(tenant.userId);

    // A second policy version carrying the threshold, through the same route a
    // tenant would use. `createPolicyVersion` does not carry columns forward — a
    // version is a complete statement of policy, not a patch — so the account
    // mappings the fixture set are restated alongside it. Effective from
    // February, which is after the fixture's version and before every journal
    // below, so the policy in force on the posting date is this one.
    await http()
      .post('/accounting-policies')
      .set(tenant.auth)
      .send({
        legal_entity_id: ledger.legalEntityId,
        valid_from: '2027-02-01',
        rounding_account_id: ledger.accounts.rounding,
        ar_control_account_id: ledger.accounts.ar,
        ap_control_account_id: ledger.accounts.ap,
        cash_clearing_account_id: ledger.accounts.cash,
        payment_clearing_account_id: ledger.accounts.paymentClearing,
        retained_earnings_account_id: ledger.accounts.equity,
        bad_debt_account_id: ledger.accounts.badDebt,
        grni_account_id: ledger.accounts.grni,
        customer_advance_account_id: ledger.accounts.customerAdvance,
        vendor_advance_account_id: ledger.accounts.vendorAdvance,
        realized_fx_gain_account_id: ledger.accounts.fxGain,
        realized_fx_loss_account_id: ledger.accounts.fxLoss,
        journal_approval_threshold: THRESHOLD,
      })
      .expect(201);
  }, 240_000);

  afterAll(closeTestApp);

  async function draft(
    auth: { Authorization: string },
    amount: string,
    description: string,
  ): Promise<string> {
    const response = await http()
      .post('/journals')
      .set(auth)
      .send({
        accounting_book_id: ledger.accountingBookId,
        journal_id: ledger.generalJournalId,
        posting_date: march,
        description,
        lines: [
          { account_id: ledger.accounts.expense, debit: amount },
          { account_id: ledger.accounts.cash, credit: amount },
        ],
      })
      .expect(201);
    return response.body.id as string;
  }

  const post = (auth: { Authorization: string }, id: string) =>
    http().post(`/journals/${id}/post`).set(auth).set('Idempotency-Key', `post-${id}`).send({});

  // -------------------------------------------------------------------------
  // The threshold itself
  // -------------------------------------------------------------------------

  it('refuses to post a journal at or over the threshold with no approval, and says why', async () => {
    // The bypass, as it stood. Before this work the same request returned 200
    // and the journal was in the ledger.
    const id = await draft(maker.auth, '25000.00', 'Unapproved and large');
    const refused = await post(maker.auth, id).expect(403);

    expect(refused.body.code).toBe('APPROVAL_REQUIRED');
    // The two numbers the caller has to reconcile, in the message. `details` is
    // log-only, so a caller who must act on this refusal would otherwise learn
    // nothing from it beyond the word "approval".
    expect(refused.body.message).toContain('25000.00');
    expect(refused.body.message).toContain(THRESHOLD);
    expect(refused.body.message).toMatch(/GBP/);
    // And the route that fixes it, because a refusal without a remedy is a dead
    // end for the person holding the journal.
    expect(refused.body.message).toMatch(/approve/i);
    expect(refused.body.correlation_id).toBeTruthy();

    // Refused means refused: nothing was written, no number was consumed.
    const after = await http().get(`/journals/${id}`).set(maker.auth).expect(200);
    expect(after.body.status).toBe('DRAFT');
    expect(after.body.entry_number).toBeNull();
  });

  it('refuses exactly AT the threshold, not only above it', async () => {
    // Gate F: "approval thresholds and conditions pass boundary tests." The
    // roundest number anyone will test with is the threshold itself.
    const id = await draft(maker.auth, THRESHOLD, 'Exactly at the threshold');
    const refused = await post(maker.auth, id).expect(403);
    expect(refused.body.code).toBe('APPROVAL_REQUIRED');
  });

  it('posts a journal under the threshold with no approval at all', async () => {
    // The half that keeps this from being an outage. A control that refuses
    // everything is not a control, and an ordinary journal must stay ordinary.
    const id = await draft(maker.auth, '9999.99', 'Under the threshold');
    const posted = await post(maker.auth, id).expect(200);
    expect(posted.body.status).toBe('POSTED');
    expect(posted.body.entry_number).toBeTruthy();
  });

  it('posts a journal over the threshold once a second person has approved it', async () => {
    const id = await draft(maker.auth, '25000.00', 'Large and properly approved');

    await http()
      .post(`/journals/${id}/submit`)
      .set(maker.auth)
      .set('Idempotency-Key', `submit-${id}`)
      .send({})
      .expect(200);

    const approved = await http()
      .post(`/journals/${id}/approve`)
      .set(checker.auth)
      .set('Idempotency-Key', `approve-${id}`)
      .send({})
      .expect(200);
    expect(approved.body.approval_state).toBe('APPROVED');

    const posted = await post(maker.auth, id).expect(200);
    expect(posted.body.status).toBe('POSTED');

    // The approval is on the entry, which is what both the service check and
    // 0049's deferred trigger read. Asserted against the row rather than the
    // response so "it posted" cannot stand in for "it was approved".
    const { rows } = await fixturePool().query<{ created_by: string; approved_by: string }>(
      `SELECT created_by, approved_by FROM journal_entries WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.created_by).toBe(maker.userId);
    expect(rows[0]?.approved_by).toBe(checker.userId);
  });

  // -------------------------------------------------------------------------
  // Maker/checker
  // -------------------------------------------------------------------------

  it('refuses an approval by the person who prepared the journal', async () => {
    // The tenant owner holds both journal.submit and journal.approve, which is
    // the only way to reach this refusal rather than a permission one: a role
    // that cannot approve at all would return FORBIDDEN and prove nothing about
    // segregation of duties.
    const id = await draft(tenant.auth, '25000.00', 'Self-approved');
    await http()
      .post(`/journals/${id}/submit`)
      .set(tenant.auth)
      .set('Idempotency-Key', `submit-self-${id}`)
      .send({})
      .expect(200);

    const refused = await http()
      .post(`/journals/${id}/approve`)
      .set(tenant.auth)
      .set('Idempotency-Key', `approve-self-${id}`)
      .send({})
      .expect(403);
    expect(refused.body.code).toBe('SEGREGATION_OF_DUTIES');
    expect(refused.body.message).toMatch(/cannot approve it/i);

    // And the refusal is not cosmetic: with no approval recorded, the journal
    // its author submitted still cannot post.
    const stillRefused = await post(tenant.auth, id).expect(403);
    expect(stillRefused.body.code).toBe('APPROVAL_REQUIRED');
  });

  it('lets a different person approve the same journal', async () => {
    const id = await draft(tenant.auth, '25000.00', 'Approved by someone else');
    await http()
      .post(`/journals/${id}/submit`)
      .set(tenant.auth)
      .set('Idempotency-Key', `submit-other-${id}`)
      .send({})
      .expect(200);
    await http()
      .post(`/journals/${id}/approve`)
      .set(checker.auth)
      .set('Idempotency-Key', `approve-other-${id}`)
      .send({})
      .expect(200);
    const posted = await post(tenant.auth, id).expect(200);
    expect(posted.body.status).toBe('POSTED');
  });

  // -------------------------------------------------------------------------
  // The database half
  // -------------------------------------------------------------------------

  it('refuses the same post through the runtime role, with the service check bypassed', async () => {
    // The reason 0049 exists as well as the service check. `commitPosting` is
    // today's only writer of a POSTED journal; a rule that lives only in the
    // writer is bypassed by the next path that forgets it. This drives the
    // application's own database credentials — RLS on, tenant GUC set, exactly
    // what the API connects as — straight past the TypeScript.
    const id = await draft(maker.auth, '30000.00', 'Straight to the database');
    const pool = fixturePool();
    const client = await pool.connect();
    let message = '';
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE app_runtime`);
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.tenantId]);
      await client.query(
        `UPDATE journal_entries SET status = 'POSTED', entry_number = 'BYPASS-1', posted_at = now()
          WHERE id = $1`,
        [id],
      );
      await client.query('COMMIT');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
      await client.query('ROLLBACK').catch(() => undefined);
    } finally {
      client.release();
    }

    expect(message).toContain('APPROVAL_REQUIRED');
    expect(message).toContain('30000');
    expect(message).toContain(THRESHOLD.replace('.00', ''));

    const after = await http().get(`/journals/${id}`).set(maker.auth).expect(200);
    expect(after.body.status).toBe('DRAFT');
  });
});
