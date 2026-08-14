import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  accountBalance,
  closeTestApp,
  createLedger,
  createSubledger,
  createTenant,
  elevatedSession,
  http,
  testApp,
  type LedgerFixture,
  type SubledgerFixture,
  type TenantFixture,
} from './harness';

/**
 * Phase 4's five exit criteria, over real HTTP against the assembled application.
 *
 * Same construction as the Phase 3 suite and for the same reason: 656 tests were
 * green before this file existed, and the ones that would notice a broken
 * banking path — unit tests over pure adapters, authorization tests that get
 * their 403 before reaching a service — structurally cannot see a database.
 */

let tenant: TenantFixture;
let ledger: LedgerFixture;
let sub: SubledgerFixture;
let auth: { Authorization: string };
let bankAccountId: string;
let savingsAccountId: string;

const YEAR = 2027;
const DAY = (d: string) => `${YEAR}-${d}`;

/**
 * The fixture book's base currency.
 *
 * Named rather than written as a literal in twenty places: `createLedger`
 * defaults to GBP, and a USD literal here produced "a USD line in a GBP book
 * needs an exchange rate" from three different tests at once. Cross-currency
 * transfer is its own criterion, and mixing it into all five would give every
 * failure two candidate causes.
 */
const BOOK_CURRENCY = 'GBP';

beforeAll(async () => {
  await testApp();
  tenant = await createTenant('Banking');
  ledger = await createLedger(tenant, { year: YEAR });
  sub = await createSubledger(tenant, ledger, { year: YEAR });
  auth = await elevatedSession(tenant);

  bankAccountId = await makeBankAccount(ledger.accounts.bank, 'Operating');
  savingsAccountId = await makeBankAccount(ledger.accounts.bank2, 'Savings');
}, 120_000);

afterAll(async () => {
  await closeTestApp();
});

/**
 * Creates a bank account and quotes the server's own words on refusal.
 *
 * `.expect(201)` reports "expected 201, got 422" and discards the body, which is
 * the one thing that says why — so every fixture step that can be refused goes
 * through here instead.
 */
async function makeBankAccount(glAccountId: string, name: string): Promise<string> {
  const response = await http().post('/bank-accounts').set(auth).send({
    legal_entity_id: ledger.legalEntityId,
    account_id: glAccountId,
    name,
    currency: BOOK_CURRENCY,
  });
  if (response.status !== 201) {
    throw new Error(
      `POST /bank-accounts for "${name}" returned ${response.status}: ${JSON.stringify(response.body)}`,
    );
  }
  return response.body.id as string;
}

/** One CSV statement body, so each test states only what it varies. */
function csv(rows: readonly [string, string, string?][]): string {
  return ['Date,Amount,Reference', ...rows.map((r) => [r[0], r[1], r[2] ?? ''].join(','))].join(
    '\n',
  );
}

function importCsv(body: string, accountId = bankAccountId) {
  return http()
    .post(`/bank-accounts/${accountId}/imports`)
    .set(auth)
    .set('Idempotency-Key', `imp-${Math.random().toString(36).slice(2)}`)
    .send({ format: 'CSV', content: body });
}

describe('exit criterion 1 — the same imported transaction cannot create a duplicate', () => {
  it('re-importing an identical statement file imports nothing the second time', async () => {
    // doc 06 acceptance: "reimport same statement is idempotent." Not an error —
    // people re-upload when a browser tab is unclear about the first attempt.
    const body = csv([
      [DAY('01-05'), '1200.00', 'INV-A'],
      [DAY('01-06'), '-340.00', 'RENT'],
    ]);

    const first = await importCsv(body).expect(202);
    expect(first.body.imported).toBe(2);
    expect(first.body.replayed).toBe(false);

    const second = await importCsv(body).expect(202);
    expect(second.body.imported).toBe(0);
    expect(second.body.replayed).toBe(true);
    expect(second.body.statement_id).toBe(first.body.statement_id);
  });

  it('refuses a transaction whose provider id is already recorded', async () => {
    // The primary tier of doc 06's rule: the bank telling us it is the same one.
    const rows = [{ provider_transaction_id: 'PROV-DUP-1', date: DAY('02-01'), amount: '500.00' }];
    const first = await http()
      .post(`/bank-accounts/${bankAccountId}/sync`)
      .set(auth)
      .set('Idempotency-Key', 'sync-dup-a')
      .send({ rows })
      .expect(202);
    expect(first.body.imported).toBe(1);

    // A different statement (extra row) so the file hash differs and the
    // per-row rule is what has to catch the repeat rather than the file check.
    const second = await http()
      .post(`/bank-accounts/${bankAccountId}/sync`)
      .set(auth)
      .set('Idempotency-Key', 'sync-dup-b')
      .send({
        rows: [
          ...rows,
          { provider_transaction_id: 'PROV-NEW-1', date: DAY('02-02'), amount: '25.00' },
        ],
      })
      .expect(202);

    expect(second.body.duplicates).toBe(1);
    expect(second.body.imported).toBe(1);
  });

  it('imports a fingerprint collision for review instead of silently dropping it', async () => {
    // F-028's whole point. Two identical same-day payments with no provider id
    // are one fingerprint and two real cash movements; the blueprint's unique
    // index dropped the second, which is how a reconciliation stops balancing
    // for a reason nobody can find.
    const a = await importCsv(csv([[DAY('03-01'), '-4.20', 'COFFEE']])).expect(202);
    expect(a.body.imported).toBe(1);

    const b = await importCsv(
      csv([
        [DAY('03-01'), '-4.20', 'COFFEE'],
        [DAY('03-02'), '-9.00', 'LUNCH'],
      ]),
    ).expect(202);

    expect(b.body.imported).toBe(2);
    expect(b.body.suspected_duplicates).toBe(1);
    expect(b.body.review).toHaveLength(1);
    expect(b.body.review[0].reason).toMatch(/review/i);
  });
});

describe('exit criterion 2 — a reconciliation closes to zero difference', () => {
  it('refuses to complete a session whose difference is not zero', async () => {
    // F-801, over HTTP. Before migration 0038 this row was simply accepted.
    const account = await makeBankAccount(ledger.accounts.cash, `Recon-fail-${Date.now()}`);

    const session = await http()
      .post('/bank-reconciliations')
      .set(auth)
      .send({
        bank_account_id: account,
        statement_start_date: DAY('04-01'),
        statement_end_date: DAY('04-30'),
        statement_opening_balance: '0.00',
        statement_closing_balance: '900.00',
      })
      .expect(201);

    // The book side is zero — nothing has posted to that cash account — so the
    // statement's 900 is entirely unexplained.
    expect(session.body.difference).toBe('900.00000000');

    const refused = await http()
      .post(`/bank-reconciliations/${session.body.id}/complete`)
      .set(auth)
      .set('Idempotency-Key', `rc-${session.body.id}`)
      .send({})
      .expect(422);

    expect(refused.body.code).toBe('VALIDATION_FAILED');
    expect(refused.body.message).toMatch(/difference of 900/);
    // The refusal names the tolerance it was measured against, because "not
    // balanced" without the threshold is not actionable.
    expect(refused.body.message).toMatch(/tolerance/i);
  });

  it('shows the working view of an open session — the difference, before failing on it', async () => {
    // F-813. `BankReconciliationService.get` computed all of this from the start
    // and no route reached it, so the only way to see a session's difference was
    // to attempt a completion and read the refusal. A reconciliation screen has
    // to show the difference *while* you work it down, not once you fail.
    const account = await makeBankAccount(ledger.accounts.cash, `Recon-view-${Date.now()}`);

    const session = await http()
      .post('/bank-reconciliations')
      .set(auth)
      .send({
        bank_account_id: account,
        statement_start_date: DAY('04-01'),
        statement_end_date: DAY('04-30'),
        statement_opening_balance: '0.00',
        statement_closing_balance: '450.00',
      })
      .expect(201);

    const view = await http().get(`/bank-reconciliations/${session.body.id}`).set(auth).expect(200);

    expect(view.body.status).toBe('IN_PROGRESS');
    expect(view.body.statement_closing_balance).toBe('450.00000000');
    expect(view.body.difference).toBe('450.00000000');
    // The decomposition the list endpoint does not carry: what the book says,
    // what is still unexplained, and how many lines are in the way. The lines
    // themselves are not repeated here — `/reports/unreconciled` and the
    // transaction list already return them, and a second query answering the
    // same question is a second answer to keep in step.
    expect(view.body.book_closing_balance).toBe('0.00000000');
    expect(view.body.unexplained_total).toBe('0.00000000');
    expect(view.body.adjusted_difference).toBe('450.00000000');
    expect(view.body.unresolved_count).toBe(0);

    // The same number the completion refuses on — one source, not two. Compared
    // through the message because the contract's Error shape is
    // `{code, message, correlation_id, field_errors}` and nothing else:
    // `AppError.details` is a diagnostic the filter logs, never a field a client
    // can read. A refusal that a caller has to act on has to say so in words.
    const refused = await http()
      .post(`/bank-reconciliations/${session.body.id}/complete`)
      .set(auth)
      .set('Idempotency-Key', `rc-view-${session.body.id}`)
      .send({})
      .expect(422);
    expect(refused.body.message).toContain(view.body.difference);
  });

  it('completes a session whose statement equals its book balance, and locks it', async () => {
    const account = await makeBankAccount(ledger.accounts.cash, `Recon-ok-${Date.now()}`);

    const session = await http()
      .post('/bank-reconciliations')
      .set(auth)
      .send({
        bank_account_id: account,
        statement_start_date: DAY('05-01'),
        statement_end_date: DAY('05-31'),
        statement_opening_balance: '0.00',
        statement_closing_balance: '0.00',
      })
      .expect(201);

    const completed = await http()
      .post(`/bank-reconciliations/${session.body.id}/complete`)
      .set(auth)
      .set('Idempotency-Key', `rc-ok-${session.body.id}`)
      .send({})
      .expect(200);

    expect(completed.body.status).toBe('COMPLETED');
    expect(completed.body.difference).toBe('0.00000000');

    // doc 06: "finalized session is locked". A second complete is refused.
    const again = await http()
      .post(`/bank-reconciliations/${session.body.id}/complete`)
      .set(auth)
      .set('Idempotency-Key', `rc-again-${session.body.id}`)
      .send({})
      .expect(409);
    expect(again.body.code).toBe('POSTED_IMMUTABLE');
  });

  it('reopens a completed session only with a reason', async () => {
    const account = await makeBankAccount(ledger.accounts.cash, `Recon-reopen-${Date.now()}`);

    const session = await http()
      .post('/bank-reconciliations')
      .set(auth)
      .send({
        bank_account_id: account,
        statement_start_date: DAY('06-01'),
        statement_end_date: DAY('06-30'),
        statement_opening_balance: '0.00',
        statement_closing_balance: '0.00',
      })
      .expect(201);

    await http()
      .post(`/bank-reconciliations/${session.body.id}/complete`)
      .set(auth)
      .set('Idempotency-Key', `rc-r-${session.body.id}`)
      .send({})
      .expect(200);

    const reopened = await http()
      .post(`/bank-reconciliations/${session.body.id}/reopen`)
      .set(auth)
      .set('Idempotency-Key', `ro-${session.body.id}`)
      .send({ reason: 'Bank restated a fee' })
      .expect(200);

    expect(reopened.body.status).toBe('REOPENED');
    expect(reopened.body.reopen_reason).toBe('Bank restated a fee');
  });
});

describe('exit criterion 3 — processor receipts, fees and net settlement reconcile through clearing', () => {
  it("clears the clearing account exactly on doc 06's 100/97/3 example", async () => {
    const before = await accountBalance(tenant, ledger, ledger.accounts.paymentClearing);

    const batch = await http()
      .post('/settlement-batches')
      .set(auth)
      .set('Idempotency-Key', `sb-${Date.now()}`)
      .send({
        legal_entity_id: ledger.legalEntityId,
        processor: 'StripeTest',
        external_batch_id: `B-${Date.now()}`,
        settlement_date: DAY('07-15'),
        currency: BOOK_CURRENCY,
        gross_amount: '100.00',
        fee_amount: '3.00',
        net_amount: '97.00',
      })
      .expect(201);

    const posted = await http()
      .post(`/settlement-batches/${batch.body.id}/reconcile`)
      .set(auth)
      .set('Idempotency-Key', `sbr-${batch.body.id}`)
      .send({
        accounting_book_id: ledger.accountingBookId,
        bank_account_id: bankAccountId,
        fee_account_id: ledger.accounts.processingFee,
      })
      .expect(200);

    expect(posted.body.status).toBe('RECONCILED');
    expect(posted.body.journal_entry_id).toBeTruthy();

    // doc 06's acceptance, asserted as arithmetic rather than as a status:
    // Dr Bank 97 + Dr Fee 3 / Cr Clearing 100.
    const clearing = await accountBalance(tenant, ledger, ledger.accounts.paymentClearing);
    const fee = await accountBalance(tenant, ledger, ledger.accounts.processingFee);
    expect(Number(clearing) - Number(before)).toBeCloseTo(-100, 6);
    expect(Number(fee)).toBeCloseTo(3, 6);
  });

  it('refuses a batch whose gross does not decompose into fee and net', async () => {
    // Refused by the service with the arithmetic named, before
    // `settlement_decomposes` refuses it as a constraint violation.
    const refused = await http()
      .post('/settlement-batches')
      .set(auth)
      .set('Idempotency-Key', `sb-bad-${Date.now()}`)
      .send({
        legal_entity_id: ledger.legalEntityId,
        processor: 'StripeTest',
        settlement_date: DAY('07-16'),
        currency: BOOK_CURRENCY,
        gross_amount: '100.00',
        fee_amount: '3.00',
        net_amount: '98.00',
      })
      .expect(422);

    expect(refused.body.message).toMatch(/SETTLEMENT_DOES_NOT_DECOMPOSE|does not|decompose/i);
  });

  it('reverses recognised cash when a cleared item is charged back', async () => {
    const batch = await http()
      .post('/settlement-batches')
      .set(auth)
      .set('Idempotency-Key', `sb-cb-${Date.now()}`)
      .send({
        legal_entity_id: ledger.legalEntityId,
        processor: 'StripeTest',
        external_batch_id: `CB-${Date.now()}`,
        settlement_date: DAY('08-01'),
        currency: BOOK_CURRENCY,
        gross_amount: '50.00',
        fee_amount: '1.50',
        net_amount: '48.50',
        items: [
          { source_type: 'customer_receipt', source_id: sub.customerId, gross_amount: '50.00' },
        ],
      })
      .expect(201);

    const itemId = batch.body.items[0].id;
    const charged = await http()
      .post(`/clearing-items/${itemId}/chargeback`)
      .set(auth)
      .set('Idempotency-Key', `cb-${itemId}`)
      .send({
        accounting_book_id: ledger.accountingBookId,
        posting_date: DAY('08-10'),
        reason: 'Customer disputed the charge',
      })
      .expect(200);

    // F-808. The state moves *and* it posts — restating the row alone would
    // leave the ledger claiming money that has gone back.
    expect(charged.body.status).toBe('CHARGED_BACK');
    expect(charged.body.journal_entry_id).toBeTruthy();
  });
});

describe('exit criterion 4 — an internal transfer does not double-count cash', () => {
  it('moves cash between two accounts on one journal, leaving the total unchanged', async () => {
    const bankBefore = await accountBalance(tenant, ledger, ledger.accounts.bank);
    const savingsBefore = await accountBalance(tenant, ledger, ledger.accounts.bank2);

    const transfer = await http()
      .post('/bank-transfers')
      .set(auth)
      .set('Idempotency-Key', `tr-${Date.now()}`)
      .send({
        accounting_book_id: ledger.accountingBookId,
        posting_date: DAY('09-01'),
        source_bank_account_id: bankAccountId,
        target_bank_account_id: savingsAccountId,
        source_amount: '250.00',
      })
      .expect(201);

    expect(transfer.body.status).toBe('CONFIRMED');
    expect(transfer.body.journal_entry_id).toBeTruthy();

    const bankAfter = await accountBalance(tenant, ledger, ledger.accounts.bank);
    const savingsAfter = await accountBalance(tenant, ledger, ledger.accounts.bank2);

    expect(Number(bankAfter) - Number(bankBefore)).toBeCloseTo(-250, 6);
    expect(Number(savingsAfter) - Number(savingsBefore)).toBeCloseTo(250, 6);

    // The criterion's actual words: cash is not double-counted. One journal, and
    // the two legs sum to nothing.
    const netChange =
      Number(bankAfter) - Number(bankBefore) + (Number(savingsAfter) - Number(savingsBefore));
    expect(netChange).toBeCloseTo(0, 6);
  });

  it('refuses a transfer to the same account', async () => {
    const refused = await http()
      .post('/bank-transfers')
      .set(auth)
      .set('Idempotency-Key', `tr-same-${Date.now()}`)
      .send({
        accounting_book_id: ledger.accountingBookId,
        posting_date: DAY('09-02'),
        source_bank_account_id: bankAccountId,
        target_bank_account_id: bankAccountId,
        source_amount: '10.00',
      })
      .expect(422);
    expect(refused.body.message).toMatch(/two different accounts/i);
  });

  it('refuses a same-currency transfer whose arrival differs from its departure', async () => {
    // Money that vanishes between two USD accounts is a fee, and calling it one
    // is what puts it on the income statement instead of into thin air.
    const refused = await http()
      .post('/bank-transfers')
      .set(auth)
      .set('Idempotency-Key', `tr-shrink-${Date.now()}`)
      .send({
        accounting_book_id: ledger.accountingBookId,
        posting_date: DAY('09-03'),
        source_bank_account_id: bankAccountId,
        target_bank_account_id: savingsAccountId,
        source_amount: '100.00',
        target_amount: '95.00',
      })
      .expect(422);
    expect(refused.body.message).toMatch(/Record the shortfall as a fee/i);
  });
});

describe('exit criterion 5 — matching suggestions never post without policy', () => {
  it('returns candidates without confirming or posting any of them', async () => {
    const imported = await importCsv(
      csv([[DAY('10-01'), '1200.00', 'Payment INV-SUGGEST thanks']]),
      bankAccountId,
    ).expect(202);
    expect(imported.body.imported).toBe(1);

    const listed = await http()
      .get('/bank-transactions')
      .set(auth)
      .query({ bank_account_id: bankAccountId, from: DAY('10-01'), to: DAY('10-01') })
      .expect(200);
    const txn = listed.body.data[0];
    expect(txn.reconciliation_state).toBe('UNMATCHED');

    const candidates = await http()
      .get(`/bank-transactions/${txn.id}/matches`)
      .set(auth)
      .expect(200);

    // The suggestion endpoint is inert by construction: it says so, and the
    // transaction it was asked about has not moved.
    expect(candidates.body.note).toMatch(/suggestions only/i);
    for (const c of candidates.body.candidates ?? []) {
      expect(c).toHaveProperty('score');
      expect(c).toHaveProperty('auto_matchable');
    }

    const after = await http()
      .get('/bank-transactions')
      .set(auth)
      .query({ bank_account_id: bankAccountId, from: DAY('10-01'), to: DAY('10-01') })
      .expect(200);
    expect(after.body.data[0].reconciliation_state).toBe('UNMATCHED');
  });

  it('refuses to match more than the bank transaction is worth', async () => {
    const imported = await importCsv(
      csv([[DAY('10-05'), '100.00', 'OVERMATCH']]),
      bankAccountId,
    ).expect(202);
    expect(imported.body.imported).toBe(1);

    const listed = await http()
      .get('/bank-transactions')
      .set(auth)
      .query({ bank_account_id: bankAccountId, from: DAY('10-05'), to: DAY('10-05') })
      .expect(200);
    const txn = listed.body.data[0];

    const refused = await http()
      .post(`/bank-transactions/${txn.id}/match`)
      .set(auth)
      .set('Idempotency-Key', `m-over-${txn.id}`)
      .send({
        targets: [{ target_type: 'INVOICE', target_id: sub.customerId, matched_amount: '150.00' }],
      })
      .expect(422);

    expect(refused.body.code).toBe('OVER_ALLOCATION');
  });

  it('splits a transaction into parts that sum to it, and refuses parts that do not', async () => {
    const imported = await importCsv(
      csv([[DAY('11-01'), '-90.00', 'SPLITME']]),
      bankAccountId,
    ).expect(202);
    expect(imported.body.imported).toBe(1);

    const listed = await http()
      .get('/bank-transactions')
      .set(auth)
      .query({ bank_account_id: bankAccountId, from: DAY('11-01'), to: DAY('11-01') })
      .expect(200);
    const txn = listed.body.data.find((t: { reference: string }) => t.reference === 'SPLITME');

    const bad = await http()
      .post(`/bank-transactions/${txn.id}/split`)
      .set(auth)
      .set('Idempotency-Key', `sp-bad-${txn.id}`)
      .send({ parts: [{ amount: '-50.00' }, { amount: '-30.00' }] })
      .expect(422);
    expect(bad.body.message).toMatch(/does not change what the bank said/i);

    const ok = await http()
      .post(`/bank-transactions/${txn.id}/split`)
      .set(auth)
      .set('Idempotency-Key', `sp-ok-${txn.id}`)
      .send({ parts: [{ amount: '-50.00' }, { amount: '-40.00' }] })
      .expect(200);
    expect(ok.body.parts).toHaveLength(2);
  });

  it('refuses to match the parent of a split, which would double-count the cash', async () => {
    // F-803. `bank_matches_bounded` cannot see this: the parent's 90 and the
    // children's 50 and 40 are each individually within their own amount.
    const listed = await http()
      .get('/bank-transactions')
      .set(auth)
      .query({ bank_account_id: bankAccountId, from: DAY('11-01'), to: DAY('11-01') })
      .expect(200);
    const parent = listed.body.data.find(
      (t: { reference: string; reconciliation_state: string }) =>
        t.reference === 'SPLITME' && t.reconciliation_state === 'SPLIT',
    );
    expect(parent).toBeTruthy();

    const refused = await http()
      .post(`/bank-transactions/${parent.id}/match`)
      .set(auth)
      .set('Idempotency-Key', `m-parent-${parent.id}`)
      .send({
        targets: [
          { target_type: 'VENDOR_BILL', target_id: sub.vendorId, matched_amount: '-90.00' },
        ],
      });

    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refused.body)).toMatch(/SPLIT_PARENT_NOT_MATCHABLE|split/i);
  });
});

describe('the reports Phase 4 owes', () => {
  it('reports unreconciled lines split into the populations a difference decomposes into', async () => {
    const report = await http()
      .get('/reports/unreconciled')
      .set(auth)
      .query({ legal_entity_id: ledger.legalEntityId })
      .expect(200);

    expect(report.body).toHaveProperty('outstanding_payments');
    expect(report.body).toHaveProperty('deposits_in_transit');
    expect(report.body).toHaveProperty('net_unreconciled');
    expect(report.body.rows.length).toBeGreaterThan(0);
    for (const row of report.body.rows) {
      expect(['OUTSTANDING_PAYMENT', 'DEPOSIT_IN_TRANSIT']).toContain(row.population);
    }
  });

  it('distinguishes bank-source from book-source values in cash position', async () => {
    // doc 06: "values clearly distinguish bank-source vs book-source timestamps".
    const position = await http()
      .get('/cash-position')
      .set(auth)
      .query({ legal_entity_id: ledger.legalEntityId })
      .expect(200);

    expect(position.body.accounts.length).toBeGreaterThan(0);
    for (const account of position.body.accounts) {
      expect(account.book_balance_source).toBe('BOOK');
      expect(account).toHaveProperty('book_balance_as_of');
      expect(account).toHaveProperty('bank_balance_as_of');
    }
    expect(position.body.by_currency.length).toBeGreaterThan(0);
  });
});

describe('a bank connection never stores a credential', () => {
  it('refuses something that looks like a connection string', async () => {
    const refused = await http()
      .post('/bank-connections')
      .set(auth)
      .set('Idempotency-Key', `bc-bad-${Date.now()}`)
      .send({
        legal_entity_id: ledger.legalEntityId,
        provider: 'TestBank',
        encrypted_config_ref: 'postgres://user:password@host/db',
      })
      .expect(422);
    expect(refused.body.message).toMatch(/secret-manager reference/i);
  });

  it('never returns the secret reference it does store', async () => {
    await http()
      .post('/bank-connections')
      .set(auth)
      .set('Idempotency-Key', `bc-ok-${Date.now()}`)
      .send({
        legal_entity_id: ledger.legalEntityId,
        provider: 'TestBank',
        encrypted_config_ref: 'sm-ref-abc123',
      })
      .expect(201);

    const listed = await http()
      .get('/bank-connections')
      .set(auth)
      .query({ legal_entity_id: ledger.legalEntityId })
      .expect(200);

    expect(listed.body.data.length).toBeGreaterThan(0);
    // A pointer at a secret in a response body is a pointer at a secret in a log.
    expect(JSON.stringify(listed.body)).not.toMatch(/sm-ref-abc123/);
  });
});
