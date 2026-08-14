import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  accountBalance,
  closeTestApp,
  createInventory,
  createLedger,
  createTenant,
  elevatedSession,
  http,
  fixturePool,
  testApp,
  type InventoryFixture,
  type LedgerFixture,
  type TenantFixture,
} from './harness';

/**
 * Phase 5's six exit criteria, over real HTTP against the assembled application.
 *
 * Same construction as the Phase 3 and Phase 4 suites, and for the same reason:
 * 816 tests were green before this file existed, and none of them asked whether
 * inventory reconciles to its control account. That is not a hypothetical — the
 * GRNI double-debit shipped in Phase 3 and survived 374 subledger and API tests
 * precisely because nothing had yet posed that question.
 *
 * Each criterion is quoted verbatim from doc 21 above its block, so the claim a
 * test makes and the claim the spec makes can be compared without leaving the
 * file.
 */

let tenant: TenantFixture;
let ledger: LedgerFixture;
let stock: InventoryFixture;
let auth: { Authorization: string };
/** The FIFO issue from criterion 1, reused by criterion 3's reproduction. */
let fifoIssueDocId: string;

const YEAR = 2027;
const DAY = (d: string) => `${YEAR}-${d}`;

beforeAll(async () => {
  await testApp();
  tenant = await createTenant('Phase5');
  ledger = await createLedger(tenant, { year: YEAR });
  auth = await elevatedSession(tenant);
  stock = await createInventory(tenant, ledger);
}, 180_000);

afterAll(async () => {
  await closeTestApp();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const idOf = (body: { id?: string; data?: { id?: string } }): string => {
  const id = body.id ?? body.data?.id;
  if (!id) throw new Error(`no id in response: ${JSON.stringify(body).slice(0, 200)}`);
  return id;
};

/**
 * Asserts a status and, when it is wrong, says what the server actually said.
 *
 * `supertest`'s own `.expect(201)` reports "expected 201, got 422" and discards
 * the body — so a refusal that carefully explains itself in its message, which
 * every guard and service in this codebase is written to do, arrives as a bare
 * number. The whole point of the error taxonomy is that a refusal is actionable;
 * a test harness that throws the reason away is the one place that guarantee
 * stops being worth anything.
 */
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

/** Creates a DRAFT receipt and posts it. Returns the document id. */
async function receive(
  itemId: string,
  quantity: string,
  unitCost: string,
  date: string,
  locationId: string = stock.locationId,
): Promise<string> {
  const draft = await http()
    .post('/inventory/receipts')
    .set(auth)
    .set('Idempotency-Key', `recv-${itemId}-${date}-${quantity}-${unitCost}`)
    .send({
      ...header(date),
      warehouse_id: stock.warehouseId,
      lines: [
        { item_id: itemId, to_location_id: locationId, quantity, unit_cost: unitCost, uom: 'EA' },
      ],
    });
  ok(draft, 201, `receipt draft ${itemId} x${quantity}`);
  const id = idOf(draft.body);
  ok(
    await http()
      .post(`/inventory/documents/${id}/post`)
      .set(auth)
      .set('Idempotency-Key', `post-recv-${id}`),
    200,
    `post receipt ${id}`,
  );
  return id;
}

/** Creates a DRAFT issue and posts it. Returns the document id. */
async function issue(
  itemId: string,
  quantity: string,
  date: string,
  locationId: string = stock.locationId,
): Promise<string> {
  const draft = await http()
    .post('/inventory/issues')
    .set(auth)
    .set('Idempotency-Key', `iss-${itemId}-${date}-${quantity}`)
    .send({
      ...header(date),
      warehouse_id: stock.warehouseId,
      lines: [{ item_id: itemId, from_location_id: locationId, quantity, uom: 'EA' }],
    });
  ok(draft, 201, `issue draft ${itemId} x${quantity}`);
  const id = idOf(draft.body);
  ok(
    await http()
      .post(`/inventory/documents/${id}/post`)
      .set(auth)
      .set('Idempotency-Key', `post-iss-${id}`),
    200,
    `post issue ${id}`,
  );
  return id;
}

/**
 * The inventory subledger's own valuation, as the report serves it.
 *
 * Read through the API rather than by summing a table: criterion 1 is about the
 * REPORT reconciling, and a test that recomputed the value from movements would
 * prove the movements agree with themselves while the report said something else
 * entirely to every human who looked at it.
 */
async function reportedValuation(): Promise<number> {
  const response = await http()
    .get('/reports/inventory-valuation')
    .query({ legal_entity_id: ledger.legalEntityId, accounting_book_id: ledger.accountingBookId })
    .set(auth)
    .expect(200);
  // The report's own total, not a sum this test recomputes from its rows. The
  // figure a person reads is the one the criterion is about.
  const total = response.body.total_value;
  expect(total, 'the valuation report states a total').toBeDefined();
  return Number(total);
}

// ---------------------------------------------------------------------------

describe('Phase 5 exit criteria', () => {
  // "Inventory valuation report reconciles to inventory GL control account."
  describe('criterion 1 — valuation reconciles to the inventory control account', () => {
    it('agrees with the control account after receipts, an issue and a transfer', async () => {
      await receive(stock.fifoItemId, '100', '2.00', DAY('01-05'));
      await receive(stock.fifoItemId, '150', '2.20', DAY('01-12'));
      fifoIssueDocId = await issue(stock.fifoItemId, '120', DAY('01-15'));

      // A transfer relocates stock; it must change neither the valuation nor the
      // control account. Including one is the point: a transfer posted as an
      // issue-plus-receipt would leave both figures self-consistent and both
      // wrong, and only a criterion that spans the transfer notices.
      const transfer = await http()
        .post('/inventory/transfers')
        .set(auth)
        .set('Idempotency-Key', 'xfer-1')
        .send({
          ...header(DAY('01-18')),
          warehouse_id: stock.warehouseId,
          lines: [
            {
              item_id: stock.fifoItemId,
              from_location_id: stock.locationId,
              to_location_id: stock.secondLocationId,
              quantity: '30',
              uom: 'EA',
            },
          ],
        })
        .expect(201);
      await http()
        .post(`/inventory/documents/${idOf(transfer.body)}/post`)
        .set(auth)
        .set('Idempotency-Key', 'post-xfer-1')
        .expect(200);

      const valuation = await reportedValuation();
      const control = await accountBalance(tenant, ledger, ledger.accounts.inventory);

      // 100 @ 2.00 + 150 @ 2.20 = 530.00 in; FIFO issue of 120 takes
      // 100 @ 2.00 + 20 @ 2.20 = 244.00 out. 286.00 remains.
      expect(valuation).toBeCloseTo(286, 2);
      expect(control).toBeCloseTo(valuation, 2);
    });

    it('reports a zero difference through the reconciliation route itself', async () => {
      // The route a user would actually open. It has to agree with the two
      // figures compared above — a reconciliation report that computes its own
      // difference differently is a third opinion, not a check.
      const response = await http()
        .get('/reports/inventory-reconciliation')
        .query({
          legal_entity_id: ledger.legalEntityId,
          accounting_book_id: ledger.accountingBookId,
        })
        .set(auth)
        .expect(200);
      // Named fields, asserted individually. `body.difference ?? 0` would read
      // undefined on a renamed field, default to zero and pass while measuring
      // nothing — which is the failure this suite exists to prevent, so it must
      // not be the shape of the suite itself.
      expect(response.body.difference, 'the report states a difference').toBeDefined();
      expect(Number(response.body.difference)).toBeCloseTo(0, 2);
      expect(Number(response.body.unexplained)).toBeCloseTo(0, 2);
      expect(Number(response.body.gl_balance)).toBeCloseTo(
        Number(response.body.valuation_total),
        2,
      );
    });

    it('holds for a weighted-average item too, not only FIFO', async () => {
      // The criterion says "inventory valuation", not "FIFO valuation". Two of
      // the four valuation methods are implemented and the first two tests
      // exercise one of them; a criterion proved on half the implemented methods
      // is proved on none of them, because the half left out is where the harder
      // arithmetic lives — weighted average rounds COGS once per issue and the
      // stored layers have to end up agreeing with that single rounding.
      const created = ok(
        await http()
          .post('/items')
          .set(auth)
          .set('Idempotency-Key', 'wav-item')
          .send({
            organization_id: tenant.organizationId,
            sku: 'WAV-RECON',
            name: 'Weighted average reconciliation',
            kind: 'INVENTORY',
            base_uom: 'EA',
            valuation: 'WEIGHTED_AVERAGE',
            accounting: [
              {
                legal_entity_id: ledger.legalEntityId,
                inventory_account_id: ledger.accounts.inventory,
                cogs_account_id: ledger.accounts.cogs,
                variance_account_id: ledger.accounts.inventoryVariance,
                purchase_account_id: ledger.accounts.grni,
              },
            ],
          }),
        201,
        'create weighted-average item',
      );
      const wavItemId = idOf(created.body);

      // The doc 08 worked example. 100 @ 2.00 + 150 @ 2.20 = 530.00 over 250
      // units, so the average is exactly 2.12 and an issue of 120 costs exactly
      // 254.40 — no rounding anywhere, which means any difference this test finds
      // is a real accounting difference and not a cent of arithmetic.
      await receive(wavItemId, '100', '2.00', DAY('04-05'));
      await receive(wavItemId, '150', '2.20', DAY('04-12'));
      await issue(wavItemId, '120', DAY('04-15'));

      const report = ok(
        await http()
          .get('/reports/inventory-reconciliation')
          .query({
            legal_entity_id: ledger.legalEntityId,
            accounting_book_id: ledger.accountingBookId,
          })
          .set(auth),
        200,
        'reconciliation after the weighted-average issue',
      );

      expect(Number(report.body.difference)).toBeCloseTo(0, 2);
      expect(Number(report.body.unexplained)).toBeCloseTo(0, 2);
    });
  });

  // "COGS is reproducible from stored cost layers/calculations."
  describe('criterion 3 — COGS is reproducible from the stored layers', () => {
    it('reproduces the FIFO issue cost by adding up its consumption rows', async () => {
      // Through the API, deliberately. A direct pool query returns NOTHING here —
      // `runtimePool()` sets no tenant GUC, so `app_current_tenant()` is null and
      // 0042's row-level security correctly hides every row. Reaching around the
      // application to check the application's work would have meant either
      // disabling that isolation for the test or misreading its silence as an
      // empty table.
      const document = ok(
        await http().get(`/inventory/documents/${fifoIssueDocId}`).set(auth),
        200,
        'read back the issue document',
      );
      const posted: { id: string; quantity: string; total_cost: string }[] =
        document.body.movements ?? document.body.data?.movements ?? [];
      const movement = posted.find((m) => Number(m.quantity) < 0);
      expect(movement, 'the issue posted an outbound movement').toBeDefined();

      const breakdown = await http()
        .get(`/inventory/movements/${movement!.id}/cost-breakdown`)
        .set(auth)
        .expect(200);

      const rows: { total_cost: string; quantity: string; unit_cost: string }[] =
        breakdown.body.consumptions ?? breakdown.body.data ?? [];
      expect(rows.length, 'the issue consumed layers and recorded them').toBeGreaterThan(0);

      const summed = rows.reduce((total, r) => total + Number(r.total_cost), 0);

      // Both halves. That the parts add to the whole, AND that the whole is the
      // 244.00 the accounting actually used — a breakdown that adds up to a
      // different number than the journal is internally consistent and useless.
      expect(summed).toBeCloseTo(Number(movement!.total_cost), 2);
      expect(summed).toBeCloseTo(244, 2);
      expect(rows).toHaveLength(2);

      // The service reports its own verdict on this. Checked too — but AFTER the
      // independent sum above, and never instead of it: a service that computes
      // `reproduces_movement_total` from the same expression it used to write
      // the rows would answer true no matter what the ledger says.
      expect(breakdown.body.reproduces_movement_total).toBe(true);
    });
  });

  // "Negative stock behavior follows configured policy under concurrent
  //  sales/issues."
  describe('criterion 2 — negative stock follows policy under concurrency', () => {
    it('refuses to let two simultaneous issues both draw the last of the stock', async () => {
      // 40 units on hand, two issues of 30 launched together. Under the default
      // BLOCK policy exactly one may succeed: the other has no stock left to
      // take. Sequential issues would prove nothing here — the interesting
      // failure is two transactions each reading 40, each deciding 30 is
      // available, and both committing.
      await receive(stock.avgItemId, '40', '5.00', DAY('02-01'));

      const attempt = async (key: string) => {
        const draft = await http()
          .post('/inventory/issues')
          .set(auth)
          .set('Idempotency-Key', `race-draft-${key}`)
          .send({
            ...header(DAY('02-10')),
            warehouse_id: stock.warehouseId,
            lines: [
              {
                item_id: stock.avgItemId,
                from_location_id: stock.locationId,
                quantity: '30',
                uom: 'EA',
              },
            ],
          })
          .expect(201);
        return http()
          .post(`/inventory/documents/${idOf(draft.body)}/post`)
          .set(auth)
          .set('Idempotency-Key', `race-post-${key}`);
      };

      // Both drafts exist before either posts, so the contention is on the
      // posting path where the layers are locked — which is where ADR-0004 §3
      // says it must be resolved.
      const [first, second] = await Promise.all([attempt('a'), attempt('b')]);
      const statuses = [first.status, second.status].sort();

      expect(statuses[0]).toBe(200);
      expect(statuses[1]).toBeGreaterThanOrEqual(400);

      const loser = first.status >= 400 ? first : second;
      expect(JSON.stringify(loser.body)).toMatch(/stock|INSUFFICIENT/i);

      // The decisive assertion. A refusal is only worth anything if the stock
      // actually stayed non-negative: an implementation that returned 409 and
      // committed anyway would pass every check above this line.
      // The on-hand REPORT, not the `inventory_on_hand` table: 0012 marks that
      // table a rebuildable projection and the posting path deliberately does not
      // maintain it, so reading it would have measured a table nobody writes and
      // called the zero a pass.
      const onHand = ok(
        await http()
          .get('/inventory/on-hand')
          .query({ legal_entity_id: ledger.legalEntityId, item_id: stock.avgItemId })
          .set(auth),
        200,
        'on-hand after the race',
      );
      const rows: { quantity: string }[] = onHand.body.data ?? [];
      const remaining = rows.reduce((sum, r) => sum + Number(r.quantity), 0);
      expect(remaining).toBeCloseTo(10, 6);
      expect(remaining).toBeGreaterThanOrEqual(0);
    });
  });

  // "Fixed asset cost and accumulated depreciation reconcile to GL."
  // "Depreciation rerun is idempotent for same asset/book/period."
  describe('criteria 4 and 5 — assets reconcile to GL, and a rerun is idempotent', () => {
    let categoryId: string;
    let assetId: string;
    let marchPeriodId: string;

    it('capitalizes an asset and reconciles cost to the GL control account', async () => {
      const category = await http()
        .post('/asset-categories')
        .set(auth)
        .set('Idempotency-Key', 'asset-cat-1')
        .send({
          legal_entity_id: ledger.legalEntityId,
          code: 'MACH',
          name: 'Machinery',
          asset_account_id: ledger.accounts.assetCost,
          accumulated_depreciation_account_id: ledger.accounts.accumulatedDepreciation,
          depreciation_expense_account_id: ledger.accounts.depreciationExpense,
          gain_account_id: ledger.accounts.disposalGainLoss,
          loss_account_id: ledger.accounts.disposalGainLoss,
          default_method: 'STRAIGHT_LINE',
          // Ten months, not the 36 of the golden fixture: the fixture ledger has
          // one fiscal year, and capitalization correctly refuses a schedule that
          // runs past the last period ("Create the fiscal years through the end of
          // the asset's useful life, then capitalize"). The 36-month schedule and
          // its 333.45 final-period residue are already proved in
          // packages/domain/src/depreciation.test.ts; what these criteria are about
          // is whether the register reconciles to the GL and whether a rerun is
          // idempotent, and ten months divides 12,000 exactly so neither claim has
          // to be read through a rounding argument.
          default_useful_life_months: 10,
          default_proration: 'FULL_MONTH',
        })
        .expect(201);
      categoryId = idOf(category.body);

      const asset = await http()
        .post('/assets')
        .set(auth)
        .set('Idempotency-Key', 'asset-1')
        .send({
          legal_entity_id: ledger.legalEntityId,
          asset_category_id: categoryId,
          asset_number: 'FA-0001',
          name: 'Lathe',
          currency: 'GBP',
          acquisition_cost: '12000.00',
          acquisition_date: DAY('03-15'),
          in_service_date: DAY('03-15'),
        })
        .expect(201);
      assetId = idOf(asset.body);

      await http()
        .post(`/assets/${assetId}/books`)
        .set(auth)
        .set('Idempotency-Key', 'asset-book-1')
        .send({
          accounting_book_id: ledger.accountingBookId,
          method: 'STRAIGHT_LINE',
          proration: 'FULL_MONTH',
          useful_life_months: 10,
          residual_value: '0.00',
          depreciation_start_date: DAY('03-15'),
          cost_basis: '12000.00',
        })
        .expect(201);

      const capitalize = await http()
        .post(`/assets/${assetId}/capitalize`)
        .set(auth)
        .set('Idempotency-Key', 'asset-cap-1')
        .send({ posting_date: DAY('03-15'), credit_account_id: ledger.accounts.bank });
      ok(capitalize, 200, 'capitalize FA-0001');

      const cost = await accountBalance(tenant, ledger, ledger.accounts.assetCost);
      expect(cost).toBeCloseTo(12000, 2);
    });

    it('posts one period of depreciation and reconciles it to GL', async () => {
      const march = ledger.periods.find((p) => !p.is_adjustment && p.period_no === 3);
      expect(march, 'the fixture year has a March period').toBeDefined();
      marchPeriodId = march!.id;

      const run = await http()
        .post('/assets/depreciation-runs')
        .set(auth)
        .set('Idempotency-Key', 'dep-run-march')
        .send({
          accounting_book_id: ledger.accountingBookId,
          accounting_period_id: marchPeriodId,
        });
      ok(run, 201, 'depreciation run for March');

      // 12,000 over 10 months, full month in the month of service: 1,200.00.
      const accumulated = await accountBalance(
        tenant,
        ledger,
        ledger.accounts.accumulatedDepreciation,
      );
      const expense = await accountBalance(tenant, ledger, ledger.accounts.depreciationExpense);
      expect(expense).toBeCloseTo(1200, 2);
      expect(accumulated).toBeCloseTo(-1200, 2);

      // The register's own figure, against the GL. Criterion 4 is that these
      // reconcile — comparing the GL to itself would prove nothing.
      const report = await http()
        .get('/reports/asset-reconciliation')
        .query({
          legal_entity_id: ledger.legalEntityId,
          accounting_book_id: ledger.accountingBookId,
        })
        .set(auth)
        .expect(200);
      const rows: {
        category_id: string;
        cost: { subledger: string; gl: string; difference: string };
        accumulated_depreciation: { subledger: string; gl: string; difference: string };
      }[] = report.body.data ?? [];

      // Asserted non-empty first. The report is per category, so a lookup that
      // found nothing would leave every difference check with no subject and
      // the criterion would pass by measuring an empty list.
      const row = rows.find((r) => r.category_id === categoryId);
      expect(row, 'the machinery category appears in the reconciliation').toBeDefined();

      expect(Number(row!.cost.difference)).toBeCloseTo(0, 2);
      expect(Number(row!.accumulated_depreciation.difference)).toBeCloseTo(0, 2);
      // And both sides are the real figures, not two zeroes agreeing.
      expect(Number(row!.cost.subledger)).toBeCloseTo(12000, 2);
      expect(Number(row!.accumulated_depreciation.subledger)).toBeCloseTo(1200, 2);
    });

    it('is idempotent on rerun — the second run posts nothing again', async () => {
      const before = await accountBalance(tenant, ledger, ledger.accounts.depreciationExpense);

      const rerun = await http()
        .post('/assets/depreciation-runs')
        .set(auth)
        // Deliberately a DIFFERENT idempotency key. An idempotent HTTP replay
        // would prove only that the interceptor works; criterion 5 is about the
        // DOMAIN refusing to depreciate the same asset/book/period twice, which
        // is a different claim and the one that protects the ledger.
        .set('Idempotency-Key', 'dep-run-march-again')
        .send({
          accounting_book_id: ledger.accountingBookId,
          accounting_period_id: marchPeriodId,
        });

      expect([200, 201, 409]).toContain(rerun.status);

      const after = await accountBalance(tenant, ledger, ledger.accounts.depreciationExpense);
      expect(after).toBeCloseTo(before, 2);

      // And exactly one posted schedule line exists for that asset book and
      // period — the rerun hole 0043 closes is an UPDATE of the existing line,
      // which would leave the count at one while silently repointing it at a
      // second journal. So the journal is checked too.
      // fixturePool(): the superuser connection. Same reason as criterion 3 —
      // runtimePool() would be filtered to nothing by RLS and the counts would
      // both read zero, which is not what "exactly one posted line" means.
      const lines = await fixturePool().query<{ n: string; journals: string }>(
        `SELECT count(*) AS n, count(DISTINCT journal_entry_id) AS journals
           FROM depreciation_schedule_lines l
           JOIN asset_books b ON b.id = l.asset_book_id
          WHERE b.fixed_asset_id = $1 AND l.accounting_period_id = $2 AND l.status = 'POSTED'`,
        [assetId, marchPeriodId],
      );
      expect(Number(lines.rows[0]!.n)).toBe(1);
      expect(Number(lines.rows[0]!.journals)).toBe(1);
    });

    it('still posts a genuinely new asset capitalized into the same period', async () => {
      // The other half, and the one a naive fix breaks: a service that simply
      // refused every second run for a period would pass the idempotence test
      // above and quietly make it impossible to depreciate anything acquired
      // after the first run of the month.
      const asset = await http()
        .post('/assets')
        .set(auth)
        .set('Idempotency-Key', 'asset-2')
        .send({
          legal_entity_id: ledger.legalEntityId,
          asset_category_id: categoryId,
          asset_number: 'FA-0002',
          name: 'Press',
          currency: 'GBP',
          acquisition_cost: '3600.00',
          acquisition_date: DAY('03-20'),
          in_service_date: DAY('03-20'),
        })
        .expect(201);
      const secondId = idOf(asset.body);

      await http()
        .post(`/assets/${secondId}/books`)
        .set(auth)
        .set('Idempotency-Key', 'asset-book-2')
        .send({
          accounting_book_id: ledger.accountingBookId,
          method: 'STRAIGHT_LINE',
          proration: 'FULL_MONTH',
          useful_life_months: 10,
          residual_value: '0.00',
          depreciation_start_date: DAY('03-20'),
          cost_basis: '3600.00',
        })
        .expect(201);

      const capitalize2 = await http()
        .post(`/assets/${secondId}/capitalize`)
        .set(auth)
        .set('Idempotency-Key', 'asset-cap-2')
        .send({ posting_date: DAY('03-20'), credit_account_id: ledger.accounts.bank });
      ok(capitalize2, 200, 'capitalize FA-0002');

      const incremental = await http()
        .post('/assets/depreciation-runs')
        .set(auth)
        .set('Idempotency-Key', 'dep-run-march-incremental')
        .send({
          accounting_book_id: ledger.accountingBookId,
          accounting_period_id: marchPeriodId,
        });
      ok(incremental, 201, 'incremental depreciation run');

      // 3,600 over 10 months = 360.00, on top of the first asset's 1,200.00, and
      // the first asset must NOT have depreciated a second time.
      const expense = await accountBalance(tenant, ledger, ledger.accounts.depreciationExpense);
      expect(expense).toBeCloseTo(1560, 2);
    });
  });

  // "Budget actuals derive from posted ledger, not duplicated transaction
  //  totals."
  describe('criterion 6 — budget actuals come from the posted ledger', () => {
    it('reports actuals that match the ledger, and moves only when the ledger moves', async () => {
      const march = ledger.periods.find((p) => !p.is_adjustment && p.period_no === 3)!;

      const budget = await http()
        .post('/budgets')
        .set(auth)
        .set('Idempotency-Key', 'budget-1')
        .send({
          legal_entity_id: ledger.legalEntityId,
          accounting_book_id: ledger.accountingBookId,
          fiscal_year_id: ledger.fiscalYearId,
          name: 'FY27 operating',
          currency: 'GBP',
          lines: [
            {
              accounting_period_id: march.id,
              account_id: ledger.accounts.depreciationExpense,
              amount: '2000.00',
            },
          ],
        })
        .expect(201);
      const budgetId = idOf(budget.body);

      await http()
        .post(`/budgets/${budgetId}/approve`)
        .set(auth)
        .set('Idempotency-Key', 'budget-approve-1')
        .expect(200);

      const report = await http()
        .get('/reports/budget-vs-actual')
        .query({
          legal_entity_id: ledger.legalEntityId,
          accounting_book_id: ledger.accountingBookId,
          budget_id: budgetId,
        })
        .set(auth)
        .expect(200);

      const rows: { account_id: string; budget_amount: string; actual_amount: string }[] =
        report.body.data ?? [];
      const row = rows.find((r) => r.account_id === ledger.accounts.depreciationExpense);
      expect(row, 'the budgeted account appears in the report').toBeDefined();

      // The report declares its own provenance. Worth asserting — a later change
      // that started summing documents would have to lie here to pass — but the
      // penny-level comparison below is what actually proves it.
      expect(report.body.source).toBe('journal_lines');

      // The decisive comparison. The actual is read from the posted ledger, so
      // it must equal the trial balance for that account to the penny — 433.33
      // from the two depreciation runs above. A report that summed source
      // documents instead would agree here only by coincidence and would drift
      // the moment a document posted differently from its own totals, which is
      // exactly what doc 10 forbids and what this criterion exists to catch.
      const ledgerBalance = await accountBalance(
        tenant,
        ledger,
        ledger.accounts.depreciationExpense,
      );
      expect(Number(row!.actual_amount)).toBeCloseTo(ledgerBalance, 2);
      expect(Number(row!.actual_amount)).toBeCloseTo(1560, 2);
      expect(Number(row!.budget_amount)).toBeCloseTo(2000, 2);
    });
  });
});
