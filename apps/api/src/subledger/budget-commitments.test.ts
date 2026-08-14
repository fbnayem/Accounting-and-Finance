import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestApp,
  createLedger,
  createSubledger,
  createTenant,
  http,
  periodContaining,
  satisfyMfa,
  testApp,
  type SubledgerFixture,
  type TenantFixture,
} from '../integration/harness';

/**
 * doc 10's budget control and commitment relief, as executable claims — F-106.
 *
 * The finding this file exists for is not "the arithmetic is wrong". The
 * arithmetic was right and unreachable: `BudgetControlService.assertSpendAllowed`
 * had no caller, `CommitmentsService.releasePurchaseOrderInTransaction` had no
 * route, and doc 10's acceptance criteria therefore appeared covered by code
 * nothing could execute. So every assertion below goes through HTTP against the
 * assembled application. A test that called the services directly would prove the
 * services again and leave the gap exactly where it was.
 *
 * The four claims, in doc 10's own terms:
 *
 *   - a purchase order that would exceed the budget is REFUSED, with the numbers;
 *   - one within budget is approved and its commitment recorded;
 *   - "Closing/canceling PO releases unused commitment";
 *   - billing against a PO line relieves the commitment rather than letting the
 *     same spend count as an open commitment and as an actual at once.
 *
 * Each scenario gets its own expense account, budgeted separately. Sharing one
 * account would make every assertion a statement about the running total left by
 * the tests before it, and the first one to be reordered would fail for a reason
 * that has nothing to do with what it tests.
 */

const YEAR = 2028;
const JAN = `${YEAR}-01-20`;

/** Every scenario's account is budgeted at this, for January only. */
const APPROVED_BUDGET = '1000.00';

/** One account per scenario — see the file comment. */
const SCENARIOS = ['over', 'within', 'close', 'partial', 'idempotent', 'relief', 'race'] as const;
type Scenario = (typeof SCENARIOS)[number];

let tenant: TenantFixture;
let fx: SubledgerFixture;
let janPeriodId: string;
const account: Partial<Record<Scenario, string>> = {};

const key = (label: string) => ({
  'Idempotency-Key': `${label}-${Math.random().toString(36).slice(2)}`,
});

beforeAll(async () => {
  await testApp();
  tenant = await createTenant('BudgetControl');
  const ledger = await createLedger(tenant, { code: 'BUD', currency: 'GBP', year: YEAR });
  fx = await createSubledger(tenant, ledger, { year: YEAR });
  await satisfyMfa(tenant.userId);
  janPeriodId = periodContaining(fx, JAN).id;

  for (const [index, scenario] of SCENARIOS.entries()) {
    const created = await http()
      .post('/accounts')
      .set(tenant.auth)
      .send({
        legal_entity_id: fx.legalEntityId,
        // 65xx: the shared chart in `createLedger` already uses 6000, 6100, 6200
        // and 6900, and an account code is unique per entity.
        code: `65${String(index).padStart(2, '0')}`,
        name: `Budgeted expense — ${scenario}`,
        account_type: 'EXPENSE',
      })
      .expect(201);
    account[scenario] = created.body.id as string;
  }

  // BLOCK, not WARN: doc 10 offers four policies and only two of them refuse.
  // The claim under test is that a refusal actually refuses, so the budget is
  // configured to refuse.
  const budget = await http()
    .post('/budgets')
    .set(tenant.auth)
    .send({
      legal_entity_id: fx.legalEntityId,
      accounting_book_id: fx.accountingBookId,
      fiscal_year_id: fx.fiscalYearId,
      name: 'Operating budget',
      currency: 'GBP',
      control_policy: 'BLOCK',
      lines: SCENARIOS.map((scenario) => ({
        accounting_period_id: janPeriodId,
        account_id: account[scenario],
        amount: APPROVED_BUDGET,
      })),
    })
    .expect(201);

  // A DRAFT budget controls nothing; `resolveBudget` looks for ACTIVE.
  await http()
    .post(`/budgets/${budget.body.id}/approve`)
    .set(tenant.auth)
    .set(key('approve-budget'))
    .send({})
    .expect(200);
}, 180_000);

afterAll(async () => {
  await closeTestApp();
});

/**
 * A one-line order against a scenario's account, dated inside January.
 *
 * No tax code: the fixture vendor has none, so net equals gross and the numbers
 * in the assertions are the numbers in the request. Commitments and the budget
 * formula both measure net, and a test that had to explain the difference would
 * be testing the tax engine instead.
 */
async function purchaseOrder(
  scenario: Scenario,
  unitPrice: string,
): Promise<{ id: string; lineId: string }> {
  const response = await http()
    .post('/purchase-orders')
    .set(tenant.auth)
    .send({
      legal_entity_id: fx.legalEntityId,
      vendor_id: fx.vendorId,
      document_date: JAN,
      currency: 'GBP',
      lines: [
        {
          description: `Consultancy — ${scenario}`,
          quantity: '1',
          unit_price: unitPrice,
          destination_account_id: account[scenario],
        },
      ],
    })
    .expect(201);
  return { id: response.body.id as string, lineId: response.body.lines[0].id as string };
}

/**
 * doc 10's formula for one budgeted cell, read back through the public route.
 *
 * Reading the same numbers the enforcement point uses, from the endpoint a person
 * would use, is what makes "the commitment was released" a claim about the system
 * rather than about a row somebody looked up in a table.
 */
async function control(scenario: Scenario, amount = '0'): Promise<Record<string, string>> {
  const response = await http()
    .get('/budget-control/check')
    .query({
      legal_entity_id: fx.legalEntityId,
      accounting_book_id: fx.accountingBookId,
      accounting_period_id: janPeriodId,
      account_id: account[scenario],
      amount,
    })
    .set(tenant.auth)
    .expect(200);
  return response.body;
}

async function approve(orderId: string, label: string) {
  return http()
    .post(`/purchase-orders/${orderId}/approve`)
    .set(tenant.auth)
    .set(key(label))
    .send({});
}

async function close(orderId: string, label: string, action: 'CLOSE' | 'CANCEL', reason: string) {
  return http()
    .post(`/purchase-orders/${orderId}/close`)
    .set(tenant.auth)
    .set(key(label))
    .send({ action, reason });
}

async function statusOf(orderId: string): Promise<string> {
  const response = await http()
    .get('/purchase-orders')
    .query({ legal_entity_id: fx.legalEntityId })
    .set(tenant.auth)
    .expect(200);
  const order = response.body.data.find((o: { id: string }) => o.id === orderId);
  return order.status as string;
}

/** A bill for part or all of a PO line, posted straight from DRAFT. */
async function billAndPost(input: {
  scenario: Scenario;
  orderId: string;
  lineId: string;
  amount: string;
}): Promise<void> {
  const bill = await http()
    .post('/vendor-bills')
    .set(tenant.auth)
    .send({
      accounting_book_id: fx.accountingBookId,
      vendor_id: fx.vendorId,
      purchase_order_id: input.orderId,
      vendor_invoice_number: `INV-${input.scenario}-${input.amount}`,
      document_date: JAN,
      posting_date: JAN,
      lines: [
        {
          description: `Consultancy — ${input.scenario}`,
          quantity: '1',
          unit_price: input.amount,
          destination_account_id: account[input.scenario],
          purchase_order_line_id: input.lineId,
        },
      ],
    })
    .expect(201);

  await http()
    .post(`/vendor-bills/${bill.body.id}/post`)
    .set(tenant.auth)
    .set(key(`post-${input.scenario}`))
    .send({})
    .expect(200);
}

describe('doc 10 budget control — an order over budget is refused at approval', () => {
  it('refuses with every term of the formula in the message, and commits nothing', async () => {
    const order = await purchaseOrder('over', '1500.00');

    const refused = await approve(order.id, 'over-budget');

    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('VALIDATION_FAILED');
    // The envelope is top-level and `AppError.details` is log-only, so if the
    // caller is to know how far over they are the MESSAGE has to say it. These
    // assertions are on the message for that reason, not by preference.
    expect(refused.body.message).toContain('BUDGET_BLOCKED');
    expect(refused.body.message).toContain('approved 1000.00000000');
    expect(refused.body.message).toContain('proposed spend 1500.00000000');
    expect(refused.body.message).toContain('over budget by 500.00000000');

    // The refusal must leave nothing behind. The check runs inside the approving
    // transaction (F-106), so the throw rolls back the status change and the
    // commitment together — if either survived, the order would be approved
    // without authority, or encumbering a budget that refused it.
    expect(await statusOf(order.id)).toBe('DRAFT');
    const after = await control('over');
    expect(after.open_commitments).toBe('0.00000000');
    expect(after.available).toBe('1000.00000000');
  });
});

describe('doc 10 budget control — approval within budget commits the spend', () => {
  it('approves, records the commitment, and reduces what is available', async () => {
    const order = await purchaseOrder('within', '400.00');

    const approved = await approve(order.id, 'within-budget');
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('APPROVED');
    expect(await statusOf(order.id)).toBe('APPROVED');

    const after = await control('within');
    expect(after.open_commitments).toBe('400.00000000');
    // Nothing is posted yet. The order consumes budget as a commitment, which is
    // the point of commitment accounting: the money is spoken for before any
    // journal exists.
    expect(after.actual_posted).toBe('0.00000000');
    expect(after.available).toBe('600.00000000');

    // And that commitment is what refuses the next order. Without it, 400 and
    // 700 would both pass, each measured against a budget the other had spent.
    const second = await purchaseOrder('within', '700.00');
    const refused = await approve(second.id, 'second-over');
    expect(refused.status).toBe(422);
    expect(refused.body.message).toContain('open commitments 400.00000000');
    expect(await statusOf(second.id)).toBe('DRAFT');
  });
});

describe('doc 10 budget control — the check is a guard, not a report', () => {
  it('lets exactly one of two simultaneous approvals through', async () => {
    // F-106's sentence is that a check outside the transaction which performs
    // the write it guards is a race. Being inside the transaction is necessary
    // and not sufficient: write transactions run at READ COMMITTED, so without a
    // lock both of these would take their snapshot before the other's commitment
    // existed, both would find 1000 available, and 1200 would be committed
    // against a budget of 1000. The budget row is taken FOR UPDATE before the
    // consumption terms are summed, so the loser waits and then sees the
    // winner's encumbrance.
    const first = await purchaseOrder('race', '600.00');
    const second = await purchaseOrder('race', '600.00');

    const [a, b] = await Promise.all([approve(first.id, 'race-a'), approve(second.id, 'race-b')]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 422]);

    const refused = a.status === 422 ? a : b;
    expect(refused.body.code).toBe('VALIDATION_FAILED');
    expect(refused.body.message).toContain('BUDGET_BLOCKED');

    // 600 committed, not 1200. The winner's order is the only one encumbering.
    const after = await control('race');
    expect(after.open_commitments).toBe('600.00000000');
    expect(after.available).toBe('400.00000000');
  });
});

describe('doc 10 acceptance — "Closing/canceling PO releases unused commitment"', () => {
  it('releases the whole commitment of an order nothing was billed against', async () => {
    const order = await purchaseOrder('close', '250.00');
    await approve(order.id, 'to-close');
    expect((await control('close')).open_commitments).toBe('250.00000000');

    const closed = await close(order.id, 'close-unbilled', 'CLOSE', 'vendor withdrew');
    expect(closed.status).toBe(200);
    expect(closed.body.status).toBe('CLOSED');

    const after = await control('close');
    expect(after.open_commitments).toBe('0.00000000');
    expect(after.available).toBe('1000.00000000');
  });

  it('releases only the UNUSED part, leaving what a bill already consumed', async () => {
    // "Unused" is doc 10's word, and this is the case that tells the two readings
    // apart: an order for 300 with 100 billed must release 200. A release that
    // took the whole committed amount back would hand the budget back 100 it has
    // genuinely spent.
    const order = await purchaseOrder('partial', '300.00');
    await approve(order.id, 'partial');
    expect((await control('partial')).open_commitments).toBe('300.00000000');

    await billAndPost({
      scenario: 'partial',
      orderId: order.id,
      lineId: order.lineId,
      amount: '100.00',
    });

    const billed = await control('partial');
    expect(billed.actual_posted).toBe('100.00000000');
    expect(billed.open_commitments).toBe('200.00000000');
    expect(billed.available).toBe('700.00000000');

    const closed = await close(order.id, 'close-partial', 'CLOSE', 'remainder not required');
    expect(closed.status).toBe(200);

    const after = await control('partial');
    expect(after.open_commitments).toBe('0.00000000');
    // The 100 that was spent is still spent: available is 900, not 1000.
    expect(after.actual_posted).toBe('100.00000000');
    expect(after.available).toBe('900.00000000');
  });

  it('is idempotent, and refuses to relabel an order that has already ended', async () => {
    const order = await purchaseOrder('idempotent', '50.00');
    await approve(order.id, 'idempotent-approve');

    const first = await close(order.id, 'close-once', 'CLOSE', 'finished with');
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('CLOSED');

    // A retry after a timeout must not fail on its own success.
    const retry = await close(order.id, 'close-twice', 'CLOSE', 'finished with');
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('CLOSED');

    // But CANCEL says something different from CLOSE to whoever reads the order
    // later, so answering a question other than the one asked is refused.
    const relabel = await close(order.id, 'close-relabel', 'CANCEL', 'changed my mind');
    expect(relabel.status).toBe(422);
    expect(relabel.body.message).toContain('already CLOSED');

    // Released once, and the failed relabel released nothing a second time.
    expect((await control('idempotent')).open_commitments).toBe('0.00000000');
  });
});

describe('doc 10 — a posted bill relieves its commitment rather than double-counting it', () => {
  it('moves the spend from open commitments to actual posted, not into both', async () => {
    const order = await purchaseOrder('relief', '300.00');
    await approve(order.id, 'relief-approve');
    expect((await control('relief')).open_commitments).toBe('300.00000000');

    await billAndPost({
      scenario: 'relief',
      orderId: order.id,
      lineId: order.lineId,
      amount: '300.00',
    });

    const after = await control('relief');
    expect(after.actual_posted).toBe('300.00000000');
    expect(after.open_commitments).toBe('0.00000000');
    // The assertion this whole file exists for. Counted once, available is 700.
    // Counted twice — as an open commitment AND as an actual — it would read 400,
    // and every remaining approval in January would be measured against a budget
    // understated by exactly the amount already spent.
    expect(after.available).toBe('700.00000000');

    // Which is not a claim about arithmetic alone: an order for the remaining 700
    // must now be approvable, and would not be if the 300 were still committed.
    const remaining = await purchaseOrder('relief', '700.00');
    const approved = await approve(remaining.id, 'relief-remaining');
    expect(approved.status).toBe(200);
    expect((await control('relief')).available).toBe('0.00000000');
  });
});
