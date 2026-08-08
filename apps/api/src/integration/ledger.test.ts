import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestApp,
  createLedger,
  createTenant,
  fixturePool,
  http,
  postJournal,
  runtimePool,
  satisfyMfa,
  testApp,
  type LedgerFixture,
  type TenantFixture,
} from './harness';

/**
 * Phase 2's six exit criteria, and Gate C.
 *
 *   1. Every generated posted journal balances exactly in book/base currency.
 *   2. No supported application role can edit/delete posted journal lines.
 *   3. Duplicate accounting event cannot double-post.
 *   4. Full ledger read model can be destroyed and rebuilt with identical balances.
 *   5. Opening Trial Balance imports and validates Assets = Liabilities + Equity.
 *   6. Journal reversal produces exact opposite accounting effect and traceability.
 *
 * Everything here goes through HTTP against a real PostgreSQL. The parts that can
 * be proved without one — the balance property over twenty thousand generated
 * journals, the rounding boundary chain, the rule interpreter — are unit tests in
 * @acct/domain, and are not repeated here. What is left is what only the assembled
 * system can answer: does the lock hold, does the trigger fire, does the privilege
 * revocation actually bite.
 */
describe('Phase 2 — the accounting kernel', () => {
  let tenant: TenantFixture;
  let ledger: LedgerFixture;

  beforeAll(async () => {
    await testApp();
    tenant = await createTenant('Ledger');
    ledger = await createLedger(tenant, { code: 'GATEC', year: 2027 });
    // ledger.rebuild and opening_balance.manage are high-risk, so ADR-0005 §3
    // demands recent re-authentication. Driving a real TOTP enrolment per test would
    // test the clock; `credentials.test.ts` covers the algorithm itself.
    await satisfyMfa(tenant.userId);
  }, 240_000);

  afterAll(closeTestApp);

  const march = '2027-03-15';

  // -------------------------------------------------------------------------
  // 1. Every posted journal balances
  // -------------------------------------------------------------------------

  describe('criterion 1 — every posted journal balances in base currency', () => {
    it('posts a balanced journal and allocates a gapless number', async () => {
      const posted = await postJournal(tenant, ledger, {
        postingDate: march,
        debitAccountId: ledger.accounts.expense,
        creditAccountId: ledger.accounts.cash,
        amount: '250.00',
      });
      expect(posted.entry_number).toMatch(/^GATEC-\d{5}$/);

      const entry = await http().get(`/journals/${posted.id}`).set(tenant.auth).expect(200);
      expect(entry.body.status).toBe('POSTED');
      const debit = entry.body.lines.reduce(
        (a: number, l: { base_debit: string }) => a + Number(l.base_debit),
        0,
      );
      const credit = entry.body.lines.reduce(
        (a: number, l: { base_credit: string }) => a + Number(l.base_credit),
        0,
      );
      expect(debit).toBe(credit);
    });

    it('refuses an unbalanced journal at post time, naming the difference', async () => {
      const draft = await http()
        .post('/journals')
        .set(tenant.auth)
        .send({
          accounting_book_id: ledger.accountingBookId,
          journal_id: ledger.generalJournalId,
          posting_date: march,
          description: 'deliberately unbalanced',
          lines: [
            { account_id: ledger.accounts.expense, debit: '100.00' },
            { account_id: ledger.accounts.cash, credit: '90.00' },
          ],
        })
        .expect(201);

      // doc 03: "Draft may be temporarily unbalanced" — the draft is accepted.
      expect(draft.body.is_balanced).toBe(false);

      const response = await http()
        .post(`/journals/${draft.body.id}/post`)
        .set(tenant.auth)
        .set('Idempotency-Key', `unbalanced-${draft.body.id}`)
        .send({});
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('UNBALANCED_JOURNAL');
    });

    it('refuses a line on a non-posting heading account', async () => {
      const response = await http()
        .post('/journals')
        .set(tenant.auth)
        .send({
          accounting_book_id: ledger.accountingBookId,
          journal_id: ledger.generalJournalId,
          posting_date: march,
          lines: [
            { account_id: ledger.accounts.heading, debit: '10.00' },
            { account_id: ledger.accounts.cash, credit: '10.00' },
          ],
        });
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('ACCOUNT_NOT_POSTABLE');
    });

    it('refuses a posting to a control account without journal.post_control', async () => {
      // The tenant owner holds everything, so the probe is a role that holds
      // journal.post but not journal.post_control — which is the exact distinction
      // doc 02 draws and the only one this test is about.
      const restricted = await probeSession(tenant, ['journal.post_control']);
      const draft = await http()
        .post('/journals')
        .set(tenant.auth)
        .send({
          accounting_book_id: ledger.accountingBookId,
          journal_id: ledger.generalJournalId,
          posting_date: march,
          description: 'manual posting to AR',
          lines: [
            { account_id: ledger.accounts.ar, debit: '40.00' },
            { account_id: ledger.accounts.revenue, credit: '40.00' },
          ],
        })
        .expect(201);

      const refused = await http()
        .post(`/journals/${draft.body.id}/post`)
        .set(restricted)
        .set('Idempotency-Key', `control-${draft.body.id}`)
        .send({});
      expect(refused.status).toBe(403);
      expect(refused.body.message).toMatch(/control account/i);

      // And the same journal posts for someone who does hold it, so the refusal is
      // attributable to the permission rather than to the journal.
      await http()
        .post(`/journals/${draft.body.id}/post`)
        .set(tenant.auth)
        .set('Idempotency-Key', `control-ok-${draft.body.id}`)
        .send({})
        .expect(200);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Posted lines are immutable — under the application's own credentials
  // -------------------------------------------------------------------------

  describe('criterion 2 — no application role can edit or delete a posted line', () => {
    let postedId: string;

    beforeAll(async () => {
      const posted = await postJournal(tenant, ledger, {
        postingDate: march,
        debitAccountId: ledger.accounts.expense,
        creditAccountId: ledger.accounts.bank,
        amount: '75.00',
      });
      postedId = posted.id;
    });

    it('refuses to edit a posted entry through the API', async () => {
      const response = await http()
        .patch(`/journals/${postedId}`)
        .set(tenant.auth)
        .set('If-Match', '2')
        .send({ description: 'tampered' });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('POSTED_IMMUTABLE');
    });

    it('refuses to delete a posted entry through the API', async () => {
      const response = await http().delete(`/journals/${postedId}`).set(tenant.auth);
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('POSTED_IMMUTABLE');
    });

    it('refuses an UPDATE on journal_lines through the application database role', async () => {
      // The layer the API cannot reach around. Migration 0025 revoked UPDATE and
      // DELETE from app_runtime, and this is the connection the application itself
      // uses — not a test role invented to make the assertion pass.
      await expect(
        runtimePool().query(`UPDATE journal_lines SET base_debit = base_debit + 1 WHERE true`),
      ).rejects.toThrow(/permission denied|denied for table/i);
    });

    it('refuses a DELETE on journal_entries through the application database role', async () => {
      await expect(
        runtimePool().query(`DELETE FROM journal_entries WHERE id = $1`, [postedId]),
      ).rejects.toThrow(/permission denied|denied for table/i);
    });

    it('refuses an UPDATE even as the schema owner, because the trigger also refuses', async () => {
      // Two layers, and this is the second. The owner has every privilege; 0006's
      // trigger is what stops it, which is why Gate C asks for both.
      await expect(
        fixturePool().query(
          `UPDATE journal_lines SET base_debit = base_debit + 1
            WHERE journal_entry_id = $1`,
          [postedId],
        ),
      ).rejects.toThrow(/POSTED_IMMUTABLE/);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Duplicate accounting events
  // -------------------------------------------------------------------------

  describe('criterion 3 — a duplicate accounting event cannot double-post', () => {
    it('returns the existing entry for a repeated source_event_id', async () => {
      const sourceEventId = crypto.randomUUID();
      const body = {
        accounting_book_id: ledger.accountingBookId,
        journal_id: ledger.generalJournalId,
        posting_date: march,
        description: 'from a source event',
        source_type: 'TEST_EVENT',
        source_event_id: sourceEventId,
        lines: [
          { account_id: ledger.accounts.expense, debit: '12.00' },
          { account_id: ledger.accounts.cash, credit: '12.00' },
        ],
      };

      const first = await http().post('/journals').set(tenant.auth).send(body).expect(201);
      const second = await http().post('/journals').set(tenant.auth).send(body).expect(201);

      // The same entry, not a second one — doc 03: "Duplicate source event returns
      // existing result and creates no duplicate."
      expect(second.body.id).toBe(first.body.id);

      const { rows } = await fixturePool().query<{ count: string }>(
        `SELECT count(*)::text FROM journal_entries WHERE source_event_id = $1`,
        [sourceEventId],
      );
      expect(rows[0]!.count).toBe('1');
    });

    it('replays a retried post rather than posting twice (F-044)', async () => {
      const draft = await http()
        .post('/journals')
        .set(tenant.auth)
        .send({
          accounting_book_id: ledger.accountingBookId,
          journal_id: ledger.generalJournalId,
          posting_date: march,
          lines: [
            { account_id: ledger.accounts.expense, debit: '5.00' },
            { account_id: ledger.accounts.cash, credit: '5.00' },
          ],
        })
        .expect(201);

      const key = `retry-${draft.body.id}`;
      const first = await http()
        .post(`/journals/${draft.body.id}/post`)
        .set(tenant.auth)
        .set('Idempotency-Key', key)
        .send({})
        .expect(200);
      const second = await http()
        .post(`/journals/${draft.body.id}/post`)
        .set(tenant.auth)
        .set('Idempotency-Key', key)
        .send({})
        .expect(200);

      expect(second.body.entry_number).toBe(first.body.entry_number);
      expect(second.headers['idempotent-replay']).toBe('true');
    });
  });

  // -------------------------------------------------------------------------
  // 4. The projection rebuilds identically
  // -------------------------------------------------------------------------

  describe('criterion 4 — the ledger read model rebuilds identically', () => {
    it('destroys and rebuilds the projection with no differences', async () => {
      const response = await http()
        .post('/ledger/projections/rebuild')
        .set(tenant.auth)
        .set('Idempotency-Key', `rebuild-${Date.now()}`)
        .send({ accounting_book_id: ledger.accountingBookId })
        .expect(200);

      expect(response.body.rows_after).toBeGreaterThan(0);
      expect(
        response.body.differences,
        `rebuild produced ${response.body.differences.length} difference(s): ` +
          JSON.stringify(response.body.differences.slice(0, 5)),
      ).toEqual([]);
      expect(response.body.identical).toBe(true);
      expect(response.body.rows_before).toBe(response.body.rows_after);
    });

    it('detects drift rather than papering over it', async () => {
      // The check on the check. Corrupt one projection row behind the service's
      // back; the rebuild must report the difference, not quietly fix it and
      // return `identical: true`.
      await fixturePool().query(
        `UPDATE ledger_account_balances SET period_debit = period_debit + 99
          WHERE accounting_book_id = $1
          AND ctid = (SELECT ctid FROM ledger_account_balances
                       WHERE accounting_book_id = $1 LIMIT 1)`,
        [ledger.accountingBookId],
      );

      const response = await http()
        .post('/ledger/projections/rebuild')
        .set(tenant.auth)
        .set('Idempotency-Key', `rebuild-drift-${Date.now()}`)
        .send({ accounting_book_id: ledger.accountingBookId })
        .expect(200);

      expect(response.body.identical).toBe(false);
      expect(response.body.differences.length).toBeGreaterThan(0);
      expect(response.body.differences[0]).toHaveProperty('before');
      expect(response.body.differences[0]).toHaveProperty('after');
    });

    it('agrees with a trial balance computed from raw journal lines', async () => {
      // doc 03's acceptance criterion, asked directly: "Rebuilding trial balance
      // from raw journal lines equals cached balance model."
      const [projection, lines] = await Promise.all([
        http()
          .get('/reports/trial-balance')
          .query({ book_id: ledger.accountingBookId, source: 'projection' })
          .set(tenant.auth)
          .expect(200),
        http()
          .get('/reports/trial-balance')
          .query({ book_id: ledger.accountingBookId, source: 'journal_lines' })
          .set(tenant.auth)
          .expect(200),
      ]);

      expect(projection.body.totals).toEqual(lines.body.totals);
      expect(projection.body.balances).toBe(true);
      expect(lines.body.balances).toBe(true);

      const key = (row: { account_code: string }) => row.account_code;
      const byCode = (rows: { account_code: string }[]) =>
        Object.fromEntries(rows.map((r) => [key(r), r]));
      expect(byCode(projection.body.data)).toEqual(byCode(lines.body.data));
    });
  });

  // -------------------------------------------------------------------------
  // 5. Opening balances
  // -------------------------------------------------------------------------

  describe('criterion 5 — the opening trial balance validates the accounting equation', () => {
    it('accepts a balanced opening set and reports the equation', async () => {
      const opening = await createLedger(tenant, { code: 'OPEN', year: 2027 });
      const response = await http()
        .post('/opening-balances')
        .set(tenant.auth)
        .set('Idempotency-Key', `opening-${opening.legalEntityId}`)
        .send({
          accounting_book_id: opening.accountingBookId,
          journal_id: opening.openingJournalId,
          as_of_date: '2027-01-01',
          lines: [
            { account_id: opening.accounts.cash, debit: '10000.00' },
            { account_id: opening.accounts.equity, credit: '7000.00' },
            { account_id: opening.accounts.revenue, credit: '5000.00' },
            { account_id: opening.accounts.expense, debit: '2000.00' },
          ],
        })
        .expect(201);

      expect(response.body.status).toBe('VALIDATED');
      const equation = response.body.equation;
      expect(equation.balances).toBe(true);
      // Assets 10000 = Liabilities 0 + Equity 7000 + current-year earnings 3000.
      // The literal reading of the criterion, Assets = Liabilities + Equity, is
      // 10000 = 7000 and would fail on this perfectly correct mid-year cutover.
      expect(Number(equation.assets)).toBe(10000);
      expect(Number(equation.currentYearEarnings)).toBe(3000);
      expect(Number(equation.rightSide)).toBe(10000);

      const posted = await http()
        .post(`/opening-balances/${response.body.id}/post`)
        .set(tenant.auth)
        .set('Idempotency-Key', `opening-post-${response.body.id}`)
        .send({})
        .expect(200);
      expect(posted.body.status).toBe('POSTED');
    });

    it('refuses an unbalanced opening set', async () => {
      const opening = await createLedger(tenant, { code: 'OPENBAD', year: 2027 });
      const response = await http()
        .post('/opening-balances')
        .set(tenant.auth)
        .set('Idempotency-Key', `opening-bad-${opening.legalEntityId}`)
        .send({
          accounting_book_id: opening.accountingBookId,
          journal_id: opening.openingJournalId,
          as_of_date: '2027-01-01',
          lines: [
            { account_id: opening.accounts.cash, debit: '10000.00' },
            { account_id: opening.accounts.equity, credit: '9000.00' },
          ],
        });
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('UNBALANCED_JOURNAL');
    });
  });

  // -------------------------------------------------------------------------
  // 6. Reversal
  // -------------------------------------------------------------------------

  describe('criterion 6 — reversal is the exact opposite, and traceable', () => {
    it('produces inverted lines, links both ways, and nets to zero per account', async () => {
      const original = await postJournal(tenant, ledger, {
        postingDate: march,
        debitAccountId: ledger.accounts.expense,
        creditAccountId: ledger.accounts.bank,
        amount: '333.33',
        description: 'to be reversed',
      });

      const reversal = await http()
        .post(`/journals/${original.id}/reverse`)
        .set(tenant.auth)
        .set('Idempotency-Key', `reverse-${original.id}`)
        .send({ reason: 'posted to the wrong account' })
        .expect(200);

      expect(reversal.body.reverses.id).toBe(original.id);

      const [before, after] = await Promise.all([
        http().get(`/journals/${original.id}`).set(tenant.auth).expect(200),
        http().get(`/journals/${reversal.body.id}`).set(tenant.auth).expect(200),
      ]);

      expect(before.body.status).toBe('REVERSED');
      expect(after.body.status).toBe('POSTED');
      // Traceability in both directions — the original names its reversal and the
      // reversal names its original, so neither is reachable only from the other.
      expect(before.body.related.some((r: { relation: string }) => r.relation === 'REVERSAL')).toBe(
        true,
      );
      expect(after.body.related.some((r: { relation: string }) => r.relation === 'REVERSES')).toBe(
        true,
      );

      const net = new Map<string, number>();
      for (const line of [...before.body.lines, ...after.body.lines]) {
        const current = net.get(line.account_code) ?? 0;
        net.set(line.account_code, current + Number(line.base_debit) - Number(line.base_credit));
      }
      for (const [code, amount] of net) {
        expect(amount, `${code} did not net to zero after reversal`).toBe(0);
      }
    });

    it('refuses to reverse the same entry twice', async () => {
      const original = await postJournal(tenant, ledger, {
        postingDate: march,
        debitAccountId: ledger.accounts.expense,
        creditAccountId: ledger.accounts.cash,
        amount: '20.00',
      });
      await http()
        .post(`/journals/${original.id}/reverse`)
        .set(tenant.auth)
        .set('Idempotency-Key', `rev1-${original.id}`)
        .send({ reason: 'first reversal' })
        .expect(200);

      const second = await http()
        .post(`/journals/${original.id}/reverse`)
        .set(tenant.auth)
        .set('Idempotency-Key', `rev2-${original.id}`)
        .send({ reason: 'second reversal' });
      expect(second.status).toBe(422);
      expect(second.body.message).toMatch(/already reversed/i);
    });
  });

  // -------------------------------------------------------------------------
  // Period locking — Gate C's "period close race tests pass"
  // -------------------------------------------------------------------------

  describe('period status is obeyed at posting time', () => {
    it('refuses a posting into a hard-closed period', async () => {
      const closed = await createLedger(tenant, { code: 'CLOSED', year: 2026 });
      const january = closed.periods.find((p) => p.period_no === 1)!;

      await http()
        .post(`/accounting-periods/${january.id}/hard-close`)
        .set(tenant.auth)
        .set('Idempotency-Key', `close-${january.id}`)
        .send({ reason: 'year end signed off' })
        .expect(200);

      const draft = await http()
        .post('/journals')
        .set(tenant.auth)
        .send({
          accounting_book_id: closed.accountingBookId,
          journal_id: closed.generalJournalId,
          posting_date: '2026-01-15',
          lines: [
            { account_id: closed.accounts.expense, debit: '10.00' },
            { account_id: closed.accounts.cash, credit: '10.00' },
          ],
        })
        .expect(201);

      const response = await http()
        .post(`/journals/${draft.body.id}/post`)
        .set(tenant.auth)
        .set('Idempotency-Key', `closed-${draft.body.id}`)
        .send({});
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('PERIOD_CLOSED');
    });

    it('a close cannot interleave with a post — the lock serialises them', async () => {
      // The race Gate C names: "Closing a period between request validation and
      // commit cannot allow a race-condition post."
      //
      // Fired together, the two must not both succeed against the same period in a
      // way that leaves a posting inside a closed period. Whichever order the
      // database picks, the invariant is the same afterwards, and it is the
      // invariant this asserts rather than a particular winner.
      const raced = await createLedger(tenant, { code: 'RACE', year: 2028 });
      const april = raced.periods.find((p) => p.period_no === 4)!;

      const draft = await http()
        .post('/journals')
        .set(tenant.auth)
        .send({
          accounting_book_id: raced.accountingBookId,
          journal_id: raced.generalJournalId,
          posting_date: '2028-04-10',
          lines: [
            { account_id: raced.accounts.expense, debit: '60.00' },
            { account_id: raced.accounts.cash, credit: '60.00' },
          ],
        })
        .expect(201);

      const [post, close] = await Promise.allSettled([
        http()
          .post(`/journals/${draft.body.id}/post`)
          .set(tenant.auth)
          .set('Idempotency-Key', `race-post-${draft.body.id}`)
          .send({}),
        http()
          .post(`/accounting-periods/${april.id}/hard-close`)
          .set(tenant.auth)
          .set('Idempotency-Key', `race-close-${april.id}`)
          .send({ reason: 'racing the post' }),
      ]);

      const postStatus = post.status === 'fulfilled' ? post.value.status : 500;
      const closeStatus = close.status === 'fulfilled' ? close.value.status : 500;

      const { rows } = await fixturePool().query<{ status: string; period_status: string }>(
        `SELECT e.status::text AS status, p.status::text AS period_status
           FROM journal_entries e
           JOIN accounting_periods p ON p.id = e.accounting_period_id
          WHERE e.id = $1`,
        [draft.body.id],
      );
      const outcome = rows[0]!;

      // The forbidden state: a POSTED entry sitting in a HARD_CLOSED period that
      // was closed without it. Every other combination is a legitimate ordering.
      const bothWon = outcome.status === 'POSTED' && outcome.period_status === 'HARD_CLOSED';
      expect(
        bothWon && postStatus === 200 && closeStatus === 200,
        `post ${postStatus}, close ${closeStatus}, entry ${outcome.status} in a ` +
          `${outcome.period_status} period — the close was allowed to overtake an in-flight post`,
      ).toBe(false);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  // Period resolution — F-403
  // -------------------------------------------------------------------------

  describe('period resolution is the regular period unless permitted otherwise', () => {
    it('resolves a posting date to the regular period, not the overlapping adjustment one', async () => {
      const december = ledger.periods.find((p) => p.period_no === 12 && !p.is_adjustment)!;
      const draft = await http()
        .post('/journals')
        .set(tenant.auth)
        .send({
          accounting_book_id: ledger.accountingBookId,
          journal_id: ledger.generalJournalId,
          posting_date: december.end_date,
          lines: [
            { account_id: ledger.accounts.expense, debit: '11.00' },
            { account_id: ledger.accounts.cash, credit: '11.00' },
          ],
        })
        .expect(201);

      expect(draft.body.accounting_period_id).toBe(december.id);
    });

    it('refuses an adjustment period without journal.post_to_adjustment_period', async () => {
      const adjustment = ledger.periods.find((p) => p.is_adjustment)!;
      const restricted = await probeSession(tenant, ['journal.post_to_adjustment_period']);

      const response = await http()
        .post('/journals')
        .set(restricted)
        .send({
          accounting_book_id: ledger.accountingBookId,
          journal_id: ledger.generalJournalId,
          posting_date: adjustment.start_date,
          accounting_period_id: adjustment.id,
          lines: [
            { account_id: ledger.accounts.expense, debit: '13.00' },
            { account_id: ledger.accounts.cash, credit: '13.00' },
          ],
        });
      expect(response.status).toBe(403);
      expect(response.body.message).toMatch(/adjustment period/i);
    });

    it('accepts the adjustment period for a caller who holds it', async () => {
      const adjustment = ledger.periods.find((p) => p.is_adjustment)!;
      const draft = await http()
        .post('/journals')
        .set(tenant.auth)
        .send({
          accounting_book_id: ledger.accountingBookId,
          journal_id: ledger.generalJournalId,
          posting_date: adjustment.start_date,
          accounting_period_id: adjustment.id,
          lines: [
            { account_id: ledger.accounts.expense, debit: '14.00' },
            { account_id: ledger.accounts.cash, credit: '14.00' },
          ],
        })
        .expect(201);
      expect(draft.body.accounting_period_id).toBe(adjustment.id);
    });
  });

  // -------------------------------------------------------------------------
  // Cross-entity and cross-tenant — F-003, Gate B, still true in Phase 2
  // -------------------------------------------------------------------------

  describe('the ledger is scoped like everything else', () => {
    it('refuses a line whose account belongs to another legal entity (F-003)', async () => {
      const other = await createLedger(tenant, { code: 'OTHER', year: 2027 });
      const response = await http()
        .post('/journals')
        .set(tenant.auth)
        .send({
          accounting_book_id: ledger.accountingBookId,
          journal_id: ledger.generalJournalId,
          posting_date: march,
          lines: [
            { account_id: other.accounts.expense, debit: '9.00' },
            { account_id: ledger.accounts.cash, credit: '9.00' },
          ],
        });
      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).toMatch(/No account .* in this entity/);
    });

    it('cannot read another tenant’s journal even with its id', async () => {
      const stranger = await createTenant('Stranger');
      const posted = await postJournal(tenant, ledger, {
        postingDate: march,
        debitAccountId: ledger.accounts.expense,
        creditAccountId: ledger.accounts.cash,
        amount: '17.00',
      });

      const response = await http().get(`/journals/${posted.id}`).set(stranger.auth);
      expect(response.status).toBe(404);
    });

    it('a trial balance for another tenant’s book returns nothing', async () => {
      const stranger = await createTenant('Stranger2');
      const response = await http()
        .get('/reports/trial-balance')
        .query({ book_id: ledger.accountingBookId })
        .set(stranger.auth);
      expect(response.status).toBe(404);
    });
  });
});

// ---------------------------------------------------------------------------

/**
 * A session holding every permission except the ones named.
 *
 * The same shape as the authorization suite's probe, and for the same reason: a
 * caller with no permissions is refused by any bug, so the refusal proves nothing.
 */
async function probeSession(
  tenant: TenantFixture,
  without: readonly string[],
): Promise<{ Authorization: string }> {
  const { createHash, randomUUID } = await import('node:crypto');
  const code = `probe_${without.join('_').replace(/\W/g, '_')}`.slice(0, 40);

  const { rows: roleRows } = await fixturePool().query<{ id: string }>(
    `INSERT INTO roles (tenant_id, code, name, is_system) VALUES ($1, $2, $3, false)
     ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [tenant.tenantId, code, `Probe without ${without.join(', ')}`],
  );
  const roleId = roleRows[0]!.id;
  await fixturePool().query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
  await fixturePool().query(
    `INSERT INTO role_permissions (role_id, permission_code)
     SELECT $1, code FROM permissions WHERE code <> ALL($2::text[]) AND code NOT LIKE 'platform.%'`,
    [roleId, without],
  );

  const { rows: userRows } = await fixturePool().query<{ id: string }>(
    `INSERT INTO users (email, display_name, password_hash) VALUES ($1, 'Probe', 'x') RETURNING id`,
    [`probe-${randomUUID()}@example.test`],
  );
  const userId = userRows[0]!.id;
  await fixturePool().query(
    `INSERT INTO memberships (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`,
    [tenant.tenantId, userId, roleId],
  );

  const secret = randomUUID();
  const { rows: sessionRows } = await fixturePool().query<{ id: string }>(
    `INSERT INTO sessions (user_id, tenant_id, expires_at, access_expires_at, mfa_satisfied,
                           mfa_verified_at, access_token_hash)
     VALUES ($1, $2, now() + interval '1 hour', now() + interval '1 hour', true, now(), $3)
     RETURNING id`,
    [userId, tenant.tenantId, createHash('sha256').update(secret, 'utf8').digest('base64url')],
  );
  return { Authorization: `Bearer ${sessionRows[0]!.id}.${secret}` };
}
