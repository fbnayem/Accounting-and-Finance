import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  JournalService,
  LedgerProjectionService,
  PostingService,
  SYSTEM_ACTOR_ID,
  runDueRecurringJournals,
  runDueReversals,
} from '@acct/ledger';
import {
  closeTestApp,
  createLedger,
  createTenant,
  elevatedSession,
  fixturePool,
  http,
  runtimePool,
  testApp,
  type LedgerFixture,
  type TenantFixture,
} from './harness';

/**
 * The scheduler, against a real database.
 *
 * Run here rather than in `apps/worker` because the interesting assertions are all
 * about what the ledger looks like afterwards, and the harness that can build a
 * posting-ready entity lives here. The scheduler functions themselves are imported
 * from `@acct/ledger` and given the application's own pool — the same objects the
 * worker constructs, connected as `app_runtime`, so row-level security applies
 * exactly as it does in production. That is the point of the test: F-620 is about
 * a background job being unable to see rows, and a test that used the owner's
 * connection would never have found it.
 */
const silent = { info: () => {}, warn: () => {}, error: () => {} };

describe('the ledger scheduler', () => {
  let tenant: TenantFixture;
  let ledger: LedgerFixture;
  let journals: JournalService;
  let elevated: { Authorization: string };

  beforeAll(async () => {
    await testApp();
    tenant = await createTenant('Scheduler');
    ledger = await createLedger(tenant, { code: 'SCHED', year: 2027 });
    elevated = await elevatedSession(tenant);
    journals = new JournalService(runtimePool(), new PostingService(new LedgerProjectionService()));
  }, 240_000);

  afterAll(closeTestApp);

  async function postAccrual(amount: string, date = '2027-05-31'): Promise<string> {
    const draft = await http()
      .post('/journals')
      .set(tenant.auth)
      .send({
        accounting_book_id: ledger.accountingBookId,
        journal_id: ledger.generalJournalId,
        posting_date: date,
        description: 'accrual to be reversed',
        lines: [
          { account_id: ledger.accounts.expense, debit: amount },
          { account_id: ledger.accounts.cash, credit: amount },
        ],
      })
      .expect(201);
    const posted = await http()
      .post(`/journals/${draft.body.id}/post`)
      .set(elevated)
      .set('Idempotency-Key', `sched-${draft.body.id}`)
      .send({})
      .expect(200);
    return posted.body.id;
  }

  describe('scheduled reversals', () => {
    it('posts a due reversal and marks the schedule EXECUTED', async () => {
      const entryId = await postAccrual('400.00');
      const schedule = await http()
        .post(`/journals/${entryId}/schedule-reversal`)
        .set(tenant.auth)
        .set('Idempotency-Key', `sched-rev-${entryId}`)
        .send({ scheduled_date: '2027-06-30', reason: 'monthly accrual reversal' })
        .expect(201);

      const result = await runDueReversals(runtimePool(), journals, silent, {
        today: '2027-06-30',
        actorId: SYSTEM_ACTOR_ID,
      });
      expect(result.succeeded).toBeGreaterThanOrEqual(1);

      const { rows } = await fixturePool().query<{
        status: string;
        reversal_entry_id: string | null;
      }>(`SELECT status, reversal_entry_id FROM scheduled_reversals WHERE id = $1`, [
        schedule.body.id,
      ]);
      expect(rows[0]!.status).toBe('EXECUTED');
      expect(rows[0]!.reversal_entry_id).not.toBeNull();

      // The original is REVERSED and the reversal is a real posted entry with a
      // number, posted by the system actor rather than by nobody.
      const original = await http().get(`/journals/${entryId}`).set(tenant.auth).expect(200);
      expect(original.body.status).toBe('REVERSED');

      const { rows: reversal } = await fixturePool().query<{
        posted_by: string;
        entry_number: string;
      }>(`SELECT posted_by, entry_number FROM journal_entries WHERE id = $1`, [
        rows[0]!.reversal_entry_id,
      ]);
      expect(reversal[0]!.posted_by).toBe(SYSTEM_ACTOR_ID);
      expect(reversal[0]!.entry_number).toMatch(/^SCHED-\d{5}$/);
    }, 60_000);

    it('leaves the schedule PENDING when the target period is closed, and records why', async () => {
      // doc 03: "still obeys period status at execution". The scheduler must not be
      // the one caller that can post into a closed period, and it must not silently
      // drop the work either.
      const entryId = await postAccrual('50.00', '2027-07-31');
      const schedule = await http()
        .post(`/journals/${entryId}/schedule-reversal`)
        .set(tenant.auth)
        .set('Idempotency-Key', `sched-closed-${entryId}`)
        .send({ scheduled_date: '2027-08-31', reason: 'reversal into a period that will close' })
        .expect(201);

      const august = ledger.periods.find((p) => p.period_no === 8)!;
      await fixturePool().query(
        `UPDATE accounting_periods SET status = 'HARD_CLOSED', closed_reason = 'test'
          WHERE id = $1`,
        [august.id],
      );

      const result = await runDueReversals(runtimePool(), journals, silent, {
        today: '2027-08-31',
        actorId: SYSTEM_ACTOR_ID,
      });
      expect(result.failed).toBeGreaterThanOrEqual(1);

      const { rows } = await fixturePool().query<{
        status: string;
        attempts: number;
        last_error: string;
      }>(`SELECT status, attempts, last_error FROM scheduled_reversals WHERE id = $1`, [
        schedule.body.id,
      ]);
      expect(rows[0]!.status).toBe('PENDING');
      expect(rows[0]!.attempts).toBe(1);
      expect(rows[0]!.last_error).toMatch(/hard-closed/i);

      // And the original is untouched — a failed reversal must not half-apply.
      const original = await http().get(`/journals/${entryId}`).set(tenant.auth).expect(200);
      expect(original.body.status).toBe('POSTED');

      await fixturePool().query(`UPDATE accounting_periods SET status = 'OPEN' WHERE id = $1`, [
        august.id,
      ]);
    }, 60_000);

    it('does not pick up a cancelled schedule', async () => {
      const entryId = await postAccrual('60.00', '2027-09-30');
      const schedule = await http()
        .post(`/journals/${entryId}/schedule-reversal`)
        .set(tenant.auth)
        .set('Idempotency-Key', `sched-cancel-${entryId}`)
        .send({ scheduled_date: '2027-10-31', reason: 'will be cancelled' })
        .expect(201);

      await http()
        .post(`/scheduled-reversals/${schedule.body.id}/cancel`)
        .set(tenant.auth)
        .set('Idempotency-Key', `sched-cancel-do-${schedule.body.id}`)
        .send({ reason: 'no longer needed' })
        .expect(200);

      await runDueReversals(runtimePool(), journals, silent, {
        today: '2027-10-31',
        actorId: SYSTEM_ACTOR_ID,
      });

      const original = await http().get(`/journals/${entryId}`).set(tenant.auth).expect(200);
      expect(original.body.status).toBe('POSTED');
    }, 60_000);
  });

  describe('recurring journals', () => {
    it('generates one journal per occurrence and never two', async () => {
      const template = await http()
        .post('/recurring-journals')
        .set(tenant.auth)
        .set('Idempotency-Key', `recur-${ledger.legalEntityId}`)
        .send({
          accounting_book_id: ledger.accountingBookId,
          journal_id: ledger.generalJournalId,
          name: 'Monthly office rent',
          frequency: 'MONTHLY',
          start_date: '2027-02-01',
          lines: [
            { account_id: ledger.accounts.expense, debit: '1200.00' },
            { account_id: ledger.accounts.cash, credit: '1200.00' },
          ],
        })
        .expect(201);

      const first = await runDueRecurringJournals(runtimePool(), journals, silent, {
        today: '2027-02-01',
        actorId: SYSTEM_ACTOR_ID,
      });
      expect(first.succeeded).toBe(1);

      // The same date again. doc 03: "occurrence is idempotent" — and the
      // enforcement is a unique index, not a SELECT another worker could interleave
      // with, so running it twice cannot produce a second journal.
      await fixturePool().query(
        `UPDATE recurring_journal_templates SET next_run_date = '2027-02-01' WHERE id = $1`,
        [template.body.id],
      );
      await runDueRecurringJournals(runtimePool(), journals, silent, {
        today: '2027-02-01',
        actorId: SYSTEM_ACTOR_ID,
      });

      const { rows } = await fixturePool().query<{ count: string }>(
        `SELECT count(*)::text FROM recurring_journal_occurrences WHERE template_id = $1`,
        [template.body.id],
      );
      expect(rows[0]!.count).toBe('1');

      const { rows: occurrence } = await fixturePool().query<{
        journal_entry_id: string;
        template_version: number;
      }>(
        `SELECT journal_entry_id, template_version FROM recurring_journal_occurrences
          WHERE template_id = $1`,
        [template.body.id],
      );
      expect(occurrence[0]!.journal_entry_id).not.toBeNull();
      // "Generated journal references template version and schedule occurrence."
      expect(occurrence[0]!.template_version).toBe(1);

      const generated = await http()
        .get(`/journals/${occurrence[0]!.journal_entry_id}`)
        .set(tenant.auth)
        .expect(200);
      // requires_approval defaults to true, so it is a draft awaiting a human even
      // though auto_post was not set — the safe combination is the default one.
      expect(generated.body.status).toBe('DRAFT');
      expect(generated.body.source_type).toBe('RECURRING_JOURNAL');
      expect(generated.body.lines).toHaveLength(2);
    }, 90_000);

    it('advances next_run_date, clamping a month-end template', async () => {
      const template = await http()
        .post('/recurring-journals')
        .set(tenant.auth)
        .set('Idempotency-Key', `recur-eom-${ledger.legalEntityId}`)
        .send({
          accounting_book_id: ledger.accountingBookId,
          journal_id: ledger.generalJournalId,
          name: 'Month-end depreciation accrual',
          frequency: 'MONTHLY',
          start_date: '2027-01-31',
          lines: [
            { account_id: ledger.accounts.expense, debit: '100.00' },
            { account_id: ledger.accounts.cash, credit: '100.00' },
          ],
        })
        .expect(201);

      await runDueRecurringJournals(runtimePool(), journals, silent, {
        today: '2027-01-31',
        actorId: SYSTEM_ACTOR_ID,
      });

      const { rows } = await fixturePool().query<{ next_run_date: string }>(
        `SELECT next_run_date::text FROM recurring_journal_templates WHERE id = $1`,
        [template.body.id],
      );
      // Not 2027-03-03, which is where naive month arithmetic lands.
      expect(rows[0]!.next_run_date).toBe('2027-02-28');
    }, 90_000);

    it('posts automatically only when auto_post is set and approval is not required', async () => {
      const template = await http()
        .post('/recurring-journals')
        .set(tenant.auth)
        .set('Idempotency-Key', `recur-auto-${ledger.legalEntityId}`)
        .send({
          accounting_book_id: ledger.accountingBookId,
          journal_id: ledger.generalJournalId,
          name: 'Auto-posted subscription',
          frequency: 'MONTHLY',
          start_date: '2027-04-01',
          auto_post: true,
          requires_approval: false,
          lines: [
            { account_id: ledger.accounts.expense, debit: '9.99' },
            { account_id: ledger.accounts.cash, credit: '9.99' },
          ],
        })
        .expect(201);

      await runDueRecurringJournals(runtimePool(), journals, silent, {
        today: '2027-04-01',
        actorId: SYSTEM_ACTOR_ID,
      });

      const { rows } = await fixturePool().query<{ journal_entry_id: string }>(
        `SELECT journal_entry_id FROM recurring_journal_occurrences WHERE template_id = $1`,
        [template.body.id],
      );
      const generated = await http()
        .get(`/journals/${rows[0]!.journal_entry_id}`)
        .set(tenant.auth)
        .expect(200);
      expect(generated.body.status).toBe('POSTED');
      expect(generated.body.entry_number).toMatch(/^SCHED-\d{5}$/);
    }, 90_000);
  });

  describe('the cross-tenant claim (F-620)', () => {
    it('sees due work in a tenant the connection has no context for', async () => {
      // The regression this guards. Every scheduled_reversals row is behind an RLS
      // policy keyed to app.tenant_id; a plain SELECT from the runtime pool returns
      // nothing, and the scheduler would report "no work" forever while a customer
      // waited for their accrual to reverse.
      const other = await createTenant('SchedulerOther');
      const otherLedger = await createLedger(other, { code: 'OTHSCH', year: 2027 });
      const otherElevated = await elevatedSession(other);

      const draft = await http()
        .post('/journals')
        .set(other.auth)
        .send({
          accounting_book_id: otherLedger.accountingBookId,
          journal_id: otherLedger.generalJournalId,
          posting_date: '2027-05-31',
          lines: [
            { account_id: otherLedger.accounts.expense, debit: '7.00' },
            { account_id: otherLedger.accounts.cash, credit: '7.00' },
          ],
        })
        .expect(201);
      const posted = await http()
        .post(`/journals/${draft.body.id}/post`)
        .set(otherElevated)
        .set('Idempotency-Key', `oth-${draft.body.id}`)
        .send({})
        .expect(200);
      await http()
        .post(`/journals/${posted.body.id}/schedule-reversal`)
        .set(other.auth)
        .set('Idempotency-Key', `oth-sched-${posted.body.id}`)
        .send({ scheduled_date: '2027-11-30', reason: 'cross-tenant claim probe' })
        .expect(201);

      // A plain read with no tenant context: RLS denies, which is the correct
      // behaviour and the reason the claim function has to exist.
      const blind = await runtimePool().query(
        `SELECT id FROM scheduled_reversals WHERE scheduled_date = '2027-11-30'`,
      );
      expect(blind.rows).toHaveLength(0);

      const result = await runDueReversals(runtimePool(), journals, silent, {
        today: '2027-11-30',
        actorId: SYSTEM_ACTOR_ID,
      });
      expect(result.considered).toBeGreaterThanOrEqual(1);
      expect(result.succeeded).toBeGreaterThanOrEqual(1);
    }, 120_000);
  });
});
