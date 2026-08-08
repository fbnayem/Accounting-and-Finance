import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeTestApp,
  createEntityRestrictedUser,
  createLegalEntity,
  createTenant,
  fixturePool,
  http,
  satisfyMfa,
  testApp,
  type TenantFixture,
} from './harness';

/**
 * Phase 1 exit criterion 3: "fiscal periods are generated and can be
 * opened/soft-closed/hard-closed according to permission."
 *
 * Three claims in one sentence, tested separately: that generation produces the
 * right calendar, that the transitions are legal in the right order, and that the
 * permission — not the UI, not the caller's intent — is what decides.
 */
describe('fiscal calendar and period lifecycle', () => {
  let tenant: TenantFixture;
  let entityId: string;
  let periods: { id: string; period_no: number; name: string; status: string }[];

  beforeAll(async () => {
    await testApp();
    tenant = await createTenant('Periods');
    entityId = (await createLegalEntity(tenant, 'PER-1')).id;

    const response = await http()
      .post('/fiscal-years')
      .set(tenant.auth)
      .send({
        legal_entity_id: entityId,
        name: 'FY2028',
        start_date: '2028-01-01',
        end_date: '2028-12-31',
        adjustment_periods: 1,
      })
      .expect(201);
    periods = response.body.periods;
  }, 180_000);

  afterAll(closeTestApp);

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  it('generates twelve monthly periods plus the adjustment period', () => {
    const regular = periods.filter((p) => !(p as { is_adjustment: boolean }).is_adjustment);
    expect(regular).toHaveLength(12);
    expect(periods).toHaveLength(13);
  });

  it('covers the year exactly, with no gap and no overlap', () => {
    const regular = periods.filter((p) => !(p as { is_adjustment: boolean }).is_adjustment) as {
      start_date: string;
      end_date: string;
    }[];
    expect(regular[0]!.start_date).toBe('2028-01-01');
    expect(regular[11]!.end_date).toBe('2028-12-31');

    // Consecutive: each period starts the day after the previous one ends. This is
    // the assertion that catches a timezone bug, because a boundary computed in a
    // zone behind UTC lands a day early and silently reassigns every transaction
    // on it. 2028 is a leap year, so February is the interesting case.
    for (let i = 1; i < regular.length; i++) {
      const previousEnd = Date.parse(`${regular[i - 1]!.end_date}T00:00:00Z`);
      const thisStart = Date.parse(`${regular[i]!.start_date}T00:00:00Z`);
      expect(thisStart - previousEnd).toBe(86_400_000);
    }
    expect(regular[1]!.end_date).toBe('2028-02-29');
  });

  it('overlaps the adjustment period with the last regular period, by design', () => {
    // F-011: the exclusion constraint covers regular periods only, because
    // overlapping period 12 is exactly what an adjustment period is for.
    const adjustment = periods.find((p) => (p as { is_adjustment: boolean }).is_adjustment) as {
      start_date: string;
      end_date: string;
    };
    expect(adjustment.end_date).toBe('2028-12-31');
  });

  it('refuses a fiscal year overlapping an existing one', async () => {
    const response = await http().post('/fiscal-years').set(tenant.auth).send({
      legal_entity_id: entityId,
      name: 'FY2028 duplicate',
      start_date: '2028-06-01',
      end_date: '2029-05-31',
    });
    expect(response.status).toBe(422);
    expect(response.body.message).toContain('overlaps');
  });

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------

  it('soft-closes an open period', async () => {
    const response = await http()
      .post(`/accounting-periods/${periods[0]!.id}/soft-close`)
      .set(tenant.auth)
      .set('Idempotency-Key', 'sc-jan')
      .send({})
      .expect(200);
    expect(response.body.status).toBe('SOFT_CLOSED');
  });

  it('refuses to hard-close out of order', async () => {
    // February cannot be final while January can still take a privileged posting:
    // that posting would move the opening balances February was signed off against.
    const response = await http()
      .post(`/accounting-periods/${periods[1]!.id}/hard-close`)
      .set(tenant.auth)
      .set('Idempotency-Key', 'hc-feb-early')
      .send({ reason: 'month end' });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('PERIOD_NOT_OPEN');
    expect(response.body.message).toContain('SOFT_CLOSED');
  });

  it('requires a reason to hard-close', async () => {
    // doc 02: "Close/reopen requires permission, reason and audit." All three.
    const response = await http()
      .post(`/accounting-periods/${periods[0]!.id}/hard-close`)
      .set(tenant.auth)
      .set('Idempotency-Key', 'hc-jan-noreason')
      .send({});
    expect(response.status).toBe(422);
    expect(response.body.field_errors?.[0]?.field).toBe('reason');
  });

  it('hard-closes in order and records the reason in the audit trail', async () => {
    await http()
      .post(`/accounting-periods/${periods[0]!.id}/hard-close`)
      .set(tenant.auth)
      .set('Idempotency-Key', 'hc-jan')
      .send({ reason: 'January signed off by the finance manager' })
      .expect(200);

    const audit = await http()
      .get('/audit-events')
      .query({ resource_type: 'accounting_period', resource_id: periods[0]!.id })
      .set(tenant.auth)
      .expect(200);
    const closed = audit.body.data.find(
      (a: { action: string }) => a.action === 'accounting_period.hard_closed',
    );
    expect(closed.reason).toBe('January signed off by the finance manager');
    expect(closed.before_data.status).toBe('SOFT_CLOSED');
    expect(closed.after_data.status).toBe('HARD_CLOSED');
  });

  it('refuses to reopen without recent MFA, because reopen is high-risk', async () => {
    // doc 02 lists "reopen periods" among the seven high-risk permissions; ADR-0005
    // §3 ties those to re-authentication. The Owner holds the permission and is
    // still refused, which is the whole point.
    const response = await http()
      .post(`/accounting-periods/${periods[0]!.id}/reopen`)
      .set(tenant.auth)
      .set('Idempotency-Key', 'reopen-nomfa')
      .send({ reason: 'correction required' });
    expect(response.body.code).toBe('MFA_REQUIRED');
  });

  it('reopens with recent MFA, a reason, and an audit entry', async () => {
    await satisfyMfa(tenant.userId);

    const response = await http()
      .post(`/accounting-periods/${periods[0]!.id}/reopen`)
      .set(tenant.auth)
      .set('Idempotency-Key', 'reopen-ok')
      .send({ reason: 'a payroll accrual was missed and must be posted in January' })
      .expect(200);
    expect(response.body.status).toBe('OPEN');

    const { rows } = await fixturePool().query<{ reopened_reason: string; reopened_by: string }>(
      `SELECT reopened_reason, reopened_by::text FROM accounting_periods WHERE id = $1`,
      [periods[0]!.id],
    );
    expect(rows[0]!.reopened_reason).toContain('payroll accrual');
    expect(rows[0]!.reopened_by).toBe(tenant.userId);
  });

  it('refuses the close to a user without the permission', async () => {
    // An AR clerk has no reach over the setup family at all, so this is the
    // permission talking and not the entity scope.
    const clerk = await createEntityRestrictedUser(tenant, entityId, 'ar_clerk');
    const response = await http()
      .post(`/accounting-periods/${periods[2]!.id}/soft-close`)
      .set(clerk.auth)
      .set('Idempotency-Key', 'sc-clerk')
      .send({});
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
  });

  it('replays an identical close instead of applying it twice', async () => {
    // F-044. `softClosePeriod` is x-idempotency: required, so the second call
    // returns the first call's response rather than failing on a status transition
    // that is no longer legal.
    const key = `sc-idem-${Date.now()}`;
    const first = await http()
      .post(`/accounting-periods/${periods[3]!.id}/soft-close`)
      .set(tenant.auth)
      .set('Idempotency-Key', key)
      .send({})
      .expect(200);

    const second = await http()
      .post(`/accounting-periods/${periods[3]!.id}/soft-close`)
      .set(tenant.auth)
      .set('Idempotency-Key', key)
      .send({})
      .expect(200);

    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body.version).toBe(first.body.version);
  });

  it('does not let one key close a different period', async () => {
    // The reason the idempotency hash covers route params and not only the body:
    // these two requests have identical (empty) bodies, so a body-only hash would
    // replay January's response and leave April open.
    const key = `sc-shared-${Date.now()}`;
    await http()
      .post(`/accounting-periods/${periods[4]!.id}/soft-close`)
      .set(tenant.auth)
      .set('Idempotency-Key', key)
      .send({})
      .expect(200);

    const other = await http()
      .post(`/accounting-periods/${periods[5]!.id}/soft-close`)
      .set(tenant.auth)
      .set('Idempotency-Key', key)
      .send({});
    expect(other.status).toBe(422);
    expect(other.body.code).toBe('IDEMPOTENCY_KEY_REUSE');

    const { rows } = await fixturePool().query<{ status: string }>(
      `SELECT status FROM accounting_periods WHERE id = $1`,
      [periods[5]!.id],
    );
    expect(rows[0]!.status).toBe('OPEN');
  });

  it('requires an Idempotency-Key on the operations the contract marks required', async () => {
    const response = await http()
      .post(`/accounting-periods/${periods[6]!.id}/soft-close`)
      .set(tenant.auth)
      .send({});
    expect(response.status).toBe(422);
    expect(response.body.field_errors?.[0]?.field).toBe('Idempotency-Key');
  });
});
