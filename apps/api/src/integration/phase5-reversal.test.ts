import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  accountBalance,
  closeTestApp,
  createInventory,
  createLedger,
  createTenant,
  elevatedSession,
  http,
  testApp,
  type InventoryFixture,
  type LedgerFixture,
  type TenantFixture,
} from './harness';

/**
 * F-923 — reversing an inventory issue, over real HTTP against the assembled
 * application.
 *
 * Phase 5 shipped this defect knowingly: `restoreConsumedLayers` restores the
 * layer QUANTITIES an issue drew down and writes no offsetting cost fact, while
 * the reversal journal restores the GL by the reversed COGS. For a weighted
 * average item the valuation is received minus issued over the stored facts
 * (F-922), so it stays short by exactly the reversed COGS and the two sides
 * disagree with no reconciling item able to name the gap.
 *
 * It survived because NO test exercised a weighted-average issue reversal —
 * phase5.test.ts proves criterion 1 across a receipt, an issue and a transfer,
 * and criterion 1's weighted-average case stops at the issue. That is the same
 * shape as F-922 itself ("the criterion was green because its scenario was
 * FIFO") one level down: the correction path of a method is part of the method.
 *
 * The suite is written so that a fix cannot pass by making the reversal inert:
 * every REJECT-shaped claim is paired with the ACCEPT-shaped one next to it —
 * the stock really comes back, it can be issued again at the recomputed
 * average, and the original issue's own COGS evidence is not rewritten by the
 * correction.
 */

let tenant: TenantFixture;
let ledger: LedgerFixture;
let stock: InventoryFixture;
let auth: { Authorization: string };

const YEAR = 2027;
const DAY = (d: string) => `${YEAR}-${d}`;

/** The document ids the reversal cases act on, shared across the its. */
let wavIssueDocId: string;
let wavIssueMovementId: string;
let wavReversalDocId: string;
/** The re-issue after the reversal — a live issue, never reversed. */
let wavSecondMovementId: string;
let fifoIssueDocId: string;

beforeAll(async () => {
  await testApp();
  tenant = await createTenant('F923');
  ledger = await createLedger(tenant, { year: YEAR });
  auth = await elevatedSession(tenant);
  stock = await createInventory(tenant, ledger);
}, 180_000);

afterAll(async () => {
  await closeTestApp();
});

// ---------------------------------------------------------------------------
// helpers — the same shape phase5.test.ts uses, and for the same reasons
// ---------------------------------------------------------------------------

const idOf = (body: { id?: string; data?: { id?: string } }): string => {
  const id = body.id ?? body.data?.id;
  if (!id) throw new Error(`no id in response: ${JSON.stringify(body).slice(0, 200)}`);
  return id;
};

/** Asserts a status and, when it is wrong, says what the server actually said. */
function ok<T extends { status: number; body: unknown }>(
  response: T,
  expected: number | readonly number[],
  what: string,
): T {
  const allowed = typeof expected === 'number' ? [expected] : expected;
  if (!allowed.includes(response.status)) {
    throw new Error(
      `${what}: expected ${allowed.join(' or ')}, got ${response.status} — ` +
        JSON.stringify(response.body),
    );
  }
  return response;
}

const header = (date: string) => ({
  accounting_book_id: ledger.accountingBookId,
  document_date: date,
  posting_date: date,
});

async function receive(
  itemId: string,
  quantity: string,
  unitCost: string,
  date: string,
): Promise<string> {
  const draft = ok(
    await http()
      .post('/inventory/receipts')
      .set(auth)
      .set('Idempotency-Key', `f923-recv-${itemId}-${date}-${quantity}-${unitCost}`)
      .send({
        ...header(date),
        warehouse_id: stock.warehouseId,
        lines: [
          {
            item_id: itemId,
            to_location_id: stock.locationId,
            quantity,
            unit_cost: unitCost,
            uom: 'EA',
          },
        ],
      }),
    201,
    `receipt draft ${itemId} x${quantity}`,
  );
  const id = idOf(draft.body);
  ok(
    await http()
      .post(`/inventory/documents/${id}/post`)
      .set(auth)
      .set('Idempotency-Key', `f923-post-recv-${id}`),
    200,
    `post receipt ${id}`,
  );
  return id;
}

async function issue(itemId: string, quantity: string, date: string): Promise<string> {
  const draft = ok(
    await http()
      .post('/inventory/issues')
      .set(auth)
      .set('Idempotency-Key', `f923-iss-${itemId}-${date}-${quantity}`)
      .send({
        ...header(date),
        warehouse_id: stock.warehouseId,
        lines: [{ item_id: itemId, from_location_id: stock.locationId, quantity, uom: 'EA' }],
      }),
    201,
    `issue draft ${itemId} x${quantity}`,
  );
  const id = idOf(draft.body);
  ok(
    await http()
      .post(`/inventory/documents/${id}/post`)
      .set(auth)
      .set('Idempotency-Key', `f923-post-iss-${id}`),
    200,
    `post issue ${id}`,
  );
  return id;
}

interface MovementRow {
  id: string;
  quantity: string;
  unit_cost: string | null;
  total_cost: string | null;
}

/** The movements of a posted document, read back through the API. */
async function movementsOf(documentId: string): Promise<MovementRow[]> {
  const document = ok(
    await http().get(`/inventory/documents/${documentId}`).set(auth),
    200,
    `read back document ${documentId}`,
  );
  const rows: MovementRow[] = document.body.movements ?? document.body.data?.movements ?? [];
  expect(rows.length, `document ${documentId} has movements`).toBeGreaterThan(0);
  return rows;
}

/** The one outbound movement of an issue document. */
async function outboundMovement(documentId: string): Promise<MovementRow> {
  const movement = (await movementsOf(documentId)).find((m) => Number(m.quantity) < 0);
  expect(movement, `document ${documentId} posted an outbound movement`).toBeDefined();
  return movement as MovementRow;
}

async function reverse(documentId: string, date: string, key: string) {
  return http()
    .post(`/inventory/documents/${documentId}/reverse`)
    .set(auth)
    .set('Idempotency-Key', key)
    .send({ posting_date: date, reason: 'F-923 scenario' });
}

interface Reconciliation {
  valuation_total: string;
  gl_balance: string;
  difference: string;
  unexplained: string;
  reconciling_items: { kind: string; amount: string }[];
}

async function reconciliation(): Promise<Reconciliation> {
  const response = ok(
    await http()
      .get('/reports/inventory-reconciliation')
      .query({
        legal_entity_id: ledger.legalEntityId,
        accounting_book_id: ledger.accountingBookId,
      })
      .set(auth),
    200,
    'inventory reconciliation',
  );
  // Named fields, asserted present before they are compared. `?? 0` on a
  // renamed field reads undefined, defaults to zero and passes while measuring
  // nothing — the exact failure this file exists to close.
  expect(response.body.difference, 'the report states a difference').toBeDefined();
  expect(response.body.unexplained, 'the report states an unexplained remainder').toBeDefined();
  return response.body as Reconciliation;
}

/** The subledger's own value of one item, as the valuation read serves it. */
async function itemValuation(itemId: string): Promise<number> {
  const response = ok(
    await http()
      .get('/inventory/valuation')
      .query({ legal_entity_id: ledger.legalEntityId, item_id: itemId })
      .set(auth),
    200,
    `valuation of ${itemId}`,
  );
  expect(response.body.total_value, 'the valuation states a total').toBeDefined();
  return Number(response.body.total_value);
}

async function itemOnHand(itemId: string): Promise<number> {
  const response = ok(
    await http()
      .get('/inventory/on-hand')
      .query({ legal_entity_id: ledger.legalEntityId, item_id: itemId })
      .set(auth),
    200,
    `on-hand of ${itemId}`,
  );
  const rows: { quantity: string }[] = response.body.data ?? [];
  return rows.reduce((sum, r) => sum + Number(r.quantity), 0);
}

/** The stored cost breakdown of one movement, and the sum of its rows. */
async function breakdown(movementId: string) {
  const response = ok(
    await http().get(`/inventory/movements/${movementId}/cost-breakdown`).set(auth),
    200,
    `cost breakdown of ${movementId}`,
  );
  return response.body as {
    consumptions: { total_cost: string; quantity: string }[];
    restorations?: { total_cost: string; quantity: string }[];
    total_cost: string;
    reproduces_movement_total: boolean | null;
  };
}

// ---------------------------------------------------------------------------

describe('F-923 — a reversed issue puts value back on both sides', () => {
  describe('weighted average', () => {
    it('reconciles before the reversal, so the reversal is the only variable', async () => {
      // The doc 08 worked example: 100 @ 2.00 + 150 @ 2.20 = 530.00 over 250
      // units, an average of exactly 2.12, and an issue of 120 costing exactly
      // 254.40. No rounding anywhere, so any difference below is a real
      // accounting difference and not a cent of arithmetic.
      await receive(stock.avgItemId, '100', '2.00', DAY('01-05'));
      await receive(stock.avgItemId, '150', '2.20', DAY('01-12'));
      wavIssueDocId = await issue(stock.avgItemId, '120', DAY('01-15'));
      wavIssueMovementId = (await outboundMovement(wavIssueDocId)).id;

      const report = await reconciliation();
      expect(Number(report.difference)).toBeCloseTo(0, 2);
      expect(Number(report.unexplained)).toBeCloseTo(0, 2);
      // Both sides are the real figures, not two zeroes agreeing.
      expect(await itemValuation(stock.avgItemId)).toBeCloseTo(275.6, 2);
      expect(await accountBalance(tenant, ledger, ledger.accounts.inventory)).toBeCloseTo(275.6, 2);
    });

    it('reconciles after the issue is reversed', async () => {
      // THE criterion. The reversal journal debits Inventory by the 254.40 it
      // reverses, so the control account returns to 530.00; the valuation must
      // return with it. Before the fix `restoreConsumedLayers` gives back the
      // layer quantities and writes no offsetting cost fact, so received-minus-
      // issued stays at 275.60 and this fails by the whole reversed COGS.
      const reversal = ok(
        await reverse(wavIssueDocId, DAY('02-10'), 'f923-rev-wav'),
        [200, 201],
        'reverse the weighted-average issue',
      );
      wavReversalDocId = idOf(reversal.body);
      expect(wavReversalDocId, 'the reversal is its own document').not.toBe(wavIssueDocId);

      const report = await reconciliation();
      expect(Number(report.gl_balance)).toBeCloseTo(530, 2);
      expect(Number(report.valuation_total)).toBeCloseTo(530, 2);
      expect(Number(report.difference)).toBeCloseTo(0, 2);
      expect(Number(report.unexplained)).toBeCloseTo(0, 2);
    });

    it('gives the stock itself back, not only the money', async () => {
      // The other half of the same claim. A "fix" that adjusted the valuation
      // expression without restoring the layers would satisfy the reconciliation
      // above and leave 130 units on a shelf holding 250 units of value.
      expect(await itemOnHand(stock.avgItemId)).toBeCloseTo(250, 6);
      expect(await itemValuation(stock.avgItemId)).toBeCloseTo(530, 2);
    });

    it('leaves the original issue COGS reproducible from its own stored rows', async () => {
      // Exit criterion 3 is about the issue that happened. It DID charge 254.40
      // and the reversal is a separate event with its own journal; a correction
      // that rewrote the original calculation would erase the evidence rather
      // than reverse it, and the breakdown would stop reproducing the journal
      // the issue actually posted.
      const rows = await breakdown(wavIssueMovementId);
      expect(rows.consumptions.length, 'the issue recorded the layers it drew').toBe(2);
      const summed = rows.consumptions.reduce((total, r) => total + Number(r.total_cost), 0);
      expect(summed).toBeCloseTo(254.4, 2);
      expect(rows.reproduces_movement_total).toBe(true);
    });

    it('re-issues the restored stock at the recomputed average and still reconciles', async () => {
      // The decisive ACCEPT half. The pool is genuinely back to 530.00 over 250
      // units, so a fresh issue of 120 costs 254.40 again. A fix that merely
      // parked the reversed value somewhere the valuation could find it, without
      // returning it to the pool, would price this issue off a 275.60 pool and
      // land at 132.29.
      const secondIssue = await issue(stock.avgItemId, '120', DAY('02-15'));
      const movement = await outboundMovement(secondIssue);
      wavSecondMovementId = movement.id;
      expect(Number(movement.total_cost)).toBeCloseTo(254.4, 2);

      const rows = await breakdown(movement.id);
      const summed = rows.consumptions.reduce((total, r) => total + Number(r.total_cost), 0);
      expect(summed).toBeCloseTo(254.4, 2);
      expect(rows.reproduces_movement_total).toBe(true);

      const report = await reconciliation();
      expect(Number(report.difference)).toBeCloseTo(0, 2);
      expect(Number(report.unexplained)).toBeCloseTo(0, 2);
      expect(await itemValuation(stock.avgItemId)).toBeCloseTo(275.6, 2);
      expect(await itemOnHand(stock.avgItemId)).toBeCloseTo(130, 6);
    });
  });

  describe('FIFO', () => {
    it('reconciles after a FIFO issue is reversed, and the stock comes back', async () => {
      // FIFO reconciled across a reversal before this work, because its
      // valuation is remaining × receipt cost and restoring the quantity
      // restores the value. Asserted anyway: the fix touches the shared
      // restoration path, and "the method that already worked still works" is
      // not something to find out from a customer.
      await receive(stock.fifoItemId, '100', '3.00', DAY('03-02'));
      fifoIssueDocId = await issue(stock.fifoItemId, '40', DAY('03-05'));
      expect(await itemValuation(stock.fifoItemId)).toBeCloseTo(180, 2);

      ok(
        await reverse(fifoIssueDocId, DAY('03-10'), 'f923-rev-fifo'),
        [200, 201],
        'reverse the FIFO issue',
      );

      expect(await itemValuation(stock.fifoItemId)).toBeCloseTo(300, 2);
      expect(await itemOnHand(stock.fifoItemId)).toBeCloseTo(100, 6);

      const report = await reconciliation();
      expect(Number(report.difference)).toBeCloseTo(0, 2);
      expect(Number(report.unexplained)).toBeCloseTo(0, 2);
    });
  });

  describe('the value comes back once, and only through a reversal', () => {
    it('reverses idempotently — a second attempt restores nothing further', async () => {
      // A different Idempotency-Key on purpose, as criterion 5 does for the
      // depreciation rerun: an idempotent HTTP replay would prove the
      // interceptor works, and the claim here is about the DOMAIN refusing to
      // give the same consumption back twice. The valuation is the witness — a
      // second restoration would put another 254.40 into a pool that never lost
      // it twice, and only the value side would ever notice.
      const before = await itemValuation(stock.avgItemId);

      const again = ok(
        await reverse(wavIssueDocId, DAY('02-20'), 'f923-rev-wav-again'),
        [200, 201],
        'reverse the same issue a second time',
      );
      expect(idOf(again.body), 'the existing reversal is returned').toBe(wavReversalDocId);
      expect(await itemValuation(stock.avgItemId)).toBeCloseTo(before, 2);

      const report = await reconciliation();
      expect(Number(report.difference)).toBeCloseTo(0, 2);
      expect(Number(report.unexplained)).toBeCloseTo(0, 2);
    });

    it('refuses to reverse a reversal', async () => {
      // Mirroring a reversal mirrors its journal correctly and does nothing at
      // all to the stock — the layers it restored were not created by it, and
      // the consumptions it gave back are already given back — so it moved the
      // control account with no cost fact behind it. That is F-923's own shape
      // one step along, and the honest answer is a refusal: re-doing what the
      // original document did is a new document, because the goods moved twice.
      const response = await reverse(wavReversalDocId, DAY('02-25'), 'f923-rev-of-rev');
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(response.body)).toMatch(/reversal/i);

      // And nothing moved. A refusal that had already written half a document
      // would be worse than none.
      const report = await reconciliation();
      expect(Number(report.difference)).toBeCloseTo(0, 2);
      expect(Number(report.unexplained)).toBeCloseTo(0, 2);
    });

    it('refuses a customer return against an issue a reversal already gave back', async () => {
      // doc 08 prices a customer return at "the linked original issue cost".
      // Returning against an issue that was reversed would restore the same
      // units twice — once as the layers the reversal reopened, once as a new
      // layer priced off an issue that no longer stands. The restoration rows
      // are what make that visible, so this is the first build that can refuse
      // it.
      const refused = await http()
        .post('/inventory/returns')
        .set(auth)
        .set('Idempotency-Key', 'f923-return-reversed')
        .send({
          ...header(DAY('03-15')),
          kind: 'CUSTOMER_RETURN',
          warehouse_id: stock.warehouseId,
          lines: [
            {
              item_id: stock.avgItemId,
              to_location_id: stock.locationId,
              quantity: '10',
              original_movement_id: wavIssueMovementId,
              uom: 'EA',
            },
          ],
        });
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(refused.body)).toMatch(/reversed/i);
    });

    it('still allows a customer return against an issue that stands', async () => {
      // The half that matters most. A guard that refused every linked return
      // would pass the scenario above and quietly remove doc 08's stated
      // pricing rule from the product.
      const allowed = await http()
        .post('/inventory/returns')
        .set(auth)
        .set('Idempotency-Key', 'f923-return-live')
        .send({
          ...header(DAY('03-16')),
          kind: 'CUSTOMER_RETURN',
          warehouse_id: stock.warehouseId,
          lines: [
            {
              item_id: stock.avgItemId,
              to_location_id: stock.locationId,
              quantity: '10',
              original_movement_id: wavSecondMovementId,
              uom: 'EA',
            },
          ],
        });
      ok(allowed, 201, 'customer return against the live issue');

      // And priced by the evidence, not by a guess: the linked issue's stored
      // consumption rows sum to 254.40 over 120 units, so the returned units
      // come back at 2.12 each. The draft carries the unit cost; the extended
      // value is written when it posts.
      const movements = await movementsOf(idOf(allowed.body));
      const inbound = movements.find((m) => Number(m.quantity) > 0);
      expect(inbound, 'the return drafted an inbound movement').toBeDefined();
      expect(inbound!.unit_cost, 'the return is priced from the linked issue').not.toBeNull();
      expect(Number(inbound!.unit_cost)).toBeCloseTo(2.12, 6);
    });
  });
});
