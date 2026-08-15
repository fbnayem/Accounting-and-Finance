/**
 * The close-management routes over real HTTP.
 *
 * This file proves the HTTP layer, not the rules: `@acct/close` has its own
 * integration test for what "complete" means. What is proved here is the part that
 * has failed historically between a router and a service — that the routes are
 * mounted where the contract says, that the permission and Idempotency-Key the
 * contract declares are applied, and above all that `finalizeCloseRun`'s refusal
 * reaches the CALLER with the outstanding work named in the message.
 *
 * `AppError.details` is log-only. If the controller ever caught that error and
 * re-threw it, the response would still be a 422 and every "the close is gated"
 * claim would still look true — while the person holding the response would have
 * no way to learn which reconciliation was missing. So both halves are asserted:
 * the refusal names the blocking items, and the same route succeeds once the work
 * is genuinely done.
 */
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { APP_LOGGER } from '../common/database.module';
import { HttpExceptionFilter } from '../common/http-exception.filter';
import type { AppLogger } from '../common/logger';
import { reconcileRoutes } from '../common/operation';
import {
  closeTestApp,
  createEntityRestrictedUser,
  createLedger,
  createTenant,
  fixturePool,
  satisfyMfa,
  testApp,
  type LedgerFixture,
  type TenantFixture,
} from '../integration/harness';

/**
 * The application, imported whole and re-declaring nothing.
 *
 * When this file was written the close controller was not yet registered in
 * `AppModule`, so declaring it here was how the routes got mounted. Integration
 * registered it — and the two declarations then mounted the controller twice and
 * constructed every provider twice. Nest died at initialization with a native
 * crash carrying no JavaScript error, so the suite reported nine tests that never
 * ran rather than one that failed, and `Test Files 17 passed (18)` looked close
 * enough to green to scroll past.
 *
 * Worth naming, because it is the shape this codebase keeps meeting: a worker
 * that dies is not a suite that passed.
 */
@Module({ imports: [AppModule] })
class CloseTestModule {}

let app: INestApplication;
const http = () => request(app.getHttpServer());

let tenant: TenantFixture;
let ledger: LedgerFixture;
let certifier: { auth: { Authorization: string }; userId: string };
let statementApprover: { auth: { Authorization: string }; userId: string };
let periodId: string;
let templateId: string;

beforeAll(async () => {
  // The harness's own app builds the fixtures through the public routes; the close
  // routes are only on this one.
  await testApp();
  app = await NestFactory.create(CloseTestModule, { logger: false });
  app.useGlobalFilters(new HttpExceptionFilter(app.get<AppLogger>(APP_LOGGER)));
  await app.init();

  tenant = await createTenant('Close');
  ledger = await createLedger(tenant, { code: `CLS${Date.now().toString(36).slice(-4)}` });
  periodId = ledger.periods[0]!.id;

  // A second person, because certification is a maker/checker control: the same
  // user cannot both prepare and certify a reconciliation. finance_manager is the
  // template that reaches reconciliation.certify.
  certifier = await createEntityRestrictedUser(tenant, ledger.legalEntityId, 'finance_manager');

  // And a third, for the statement approval, because the approver of a statement
  // may not be its issuer. `owner` rather than `finance_manager`: the resource
  // `financial_statement` is not classified into any family in role-templates.ts,
  // so `financial_statement.approve` currently belongs to no template except the
  // Owner's `everything`. See INTEGRATION NOTES — the route is right, the grant is
  // missing.
  statementApprover = await createEntityRestrictedUser(tenant, ledger.legalEntityId, 'owner');

  // Checklist templates have no route of their own in the contract, so this is the
  // one fixture that goes in by SQL.
  const pool = fixturePool();
  const created = await pool.query<{ id: string }>(
    `INSERT INTO close_checklist_templates (tenant_id, organization_id, code, name, cadence)
     VALUES ($1,$2,'MONTHLY-HTTP','Monthly close','MONTHLY') RETURNING id`,
    [tenant.tenantId, tenant.organizationId],
  );
  templateId = created.rows[0]!.id;
  await pool.query(
    `INSERT INTO close_checklist_template_tasks
       (tenant_id, template_id, sequence, code, name, task_type, required)
     VALUES ($1,$2,10,'SUBLEDGER_CUTOFF','Cut off the subledgers','CUTOFF',true),
            ($1,$2,20,'FLUX_REVIEW','Review the flux analysis','REVIEW',false)`,
    [tenant.tenantId, templateId],
  );
}, 180_000);

afterAll(async () => {
  await app?.close();
  await closeTestApp();
});

describe('the close routes are the contract routes', () => {
  it('mounts every close operation it binds at the contract path and method', () => {
    const { mismatches } = reconcileRoutes(app, { phases: [] });
    const closeMismatches = mismatches.filter((m) => /close|reconcil|snapshot/i.test(m.detail));
    expect(closeMismatches).toEqual([]);
  });
});

describe('finalizeCloseRun refuses, and says what is outstanding', () => {
  let closeRunId: string;

  it('opens a close run', async () => {
    const response = await http()
      .post('/close-runs')
      .set(tenant.auth)
      .set('Idempotency-Key', `run-${Date.now()}`)
      .send({
        legal_entity_id: ledger.legalEntityId,
        accounting_book_id: ledger.accountingBookId,
        accounting_period_id: periodId,
        template_id: templateId,
      })
      .expect(201);
    closeRunId = response.body.id;
    // The fixture chart has five control accounts, and the one required template
    // task. Nothing is done yet.
    expect(response.body.configured).toBe(true);
    expect(response.body.complete).toBe(false);
    expect(response.body.required_total).toBeGreaterThan(1);
  });

  it('names the outstanding items in the MESSAGE, not only in the log', async () => {
    const response = await http()
      .post(`/close-runs/${closeRunId}/finalize`)
      .set(tenant.auth)
      .set('Idempotency-Key', `finalize-early-${closeRunId}`)
      .send({})
      .expect(422);

    expect(response.body.code).toBe('VALIDATION_FAILED');
    // The claim under test: a caller holding only the response body can tell WHICH
    // work is incomplete.
    expect(response.body.message).toContain('Outstanding');
    expect(response.body.message).toContain('SUBLEDGER_CUTOFF');
    expect(response.body.message).toMatch(/reconciliation 1100/);
    // And nothing was closed.
    const runs = await http()
      .get('/close-runs')
      .query({ accounting_period_id: periodId })
      .set(tenant.auth)
      .expect(200);
    expect(runs.body.data[0].status).not.toBe('COMPLETED');
  });

  it('refuses without an Idempotency-Key, because the contract says required', async () => {
    const response = await http()
      .post(`/close-runs/${closeRunId}/finalize`)
      .set(tenant.auth)
      .send({})
      .expect(422);
    expect(response.body.field_errors?.[0]?.field).toBe('Idempotency-Key');
  });

  it('completes the required checklist task', async () => {
    const tasks = await http().get(`/close-runs/${closeRunId}/tasks`).set(tenant.auth).expect(200);
    const cutoff = tasks.body.data.find((t: { code: string }) => t.code === 'SUBLEDGER_CUTOFF') as {
      id: string;
    };
    expect(cutoff).toBeTruthy();

    const done = await http()
      .post(`/close-tasks/${cutoff.id}/complete`)
      .set(tenant.auth)
      .set('Idempotency-Key', `task-${cutoff.id}`)
      .send({ note: 'AR and AP cut off', evidence: [{ kind: 'note', ref: 'cutoff' }] })
      .expect(200);
    expect(done.body.status).toBe('COMPLETED');
  });

  it('prepares and certifies every required reconciliation', async () => {
    const tasks = await http().get(`/close-runs/${closeRunId}/tasks`).set(tenant.auth).expect(200);
    const required = tasks.body.reconciliations as { account_id: string; account_code: string }[];
    expect(required.length).toBeGreaterThan(0);

    for (const account of required) {
      // No journals were posted, so every control account's GL balance is zero and
      // the supporting balance that reconciles it is zero. Exact decimal string —
      // never a JSON number (ADR-0006 §1).
      const prepared = await http()
        .post('/account-reconciliations')
        .set(tenant.auth)
        .set('Idempotency-Key', `recon-${closeRunId}-${account.account_code}`)
        .send({
          legal_entity_id: ledger.legalEntityId,
          accounting_book_id: ledger.accountingBookId,
          accounting_period_id: periodId,
          account_id: account.account_id,
          supporting_balance: '0',
          close_run_id: closeRunId,
        })
        .expect(201);
      expect(prepared.body.difference).toMatch(/^-?0(\.0+)?$/);

      // Certified by the OTHER user. The same user would be refused, which is the
      // control `recon_sod` cannot enforce on its own.
      await http()
        .post(`/account-reconciliations/${prepared.body.id}/certify`)
        .set(certifier.auth)
        .set('Idempotency-Key', `certify-${prepared.body.id}`)
        .send({ note: 'agreed to the schedule' })
        .expect(200);
    }

    const listed = await http()
      .get('/account-reconciliations')
      .query({ close_run_id: closeRunId })
      .set(tenant.auth)
      .expect(200);
    expect(listed.body.data.length).toBe(required.length);
    expect(listed.body.data.every((r: { status: string }) => r.status === 'CERTIFIED')).toBe(true);
  });

  it('finalizes once the work is genuinely done — the ACCEPT half', async () => {
    const response = await http()
      .post(`/close-runs/${closeRunId}/finalize`)
      .set(tenant.auth)
      .set('Idempotency-Key', `finalize-ready-${closeRunId}`)
      .send({ note: 'January close' })
      .expect(200);

    expect(response.body.status).toBe('COMPLETED');
    expect(response.body.complete).toBe(true);
    expect(response.body.required_satisfied).toBe(response.body.required_total);
    expect(response.body.readiness_percent).toBe('100.0000');
  });

  /**
   * The reopen route, refusing.
   *
   * Only the refusal half is asserted over HTTP: raising the approval request that
   * would let it succeed is `@acct/approvals`' work and its `GATED_RESOURCES`
   * registry does not cover CLOSE_RUN yet (INTEGRATION NOTES). The accept half is
   * proved at the service level in `@acct/close`'s own integration test, with a
   * fixtured approval. What this asserts is that the route is bound, that the
   * contract's `x-high-risk` reaches it, and that a permitted, MFA-elevated,
   * reasoned reopen is still refused for want of somebody else's approval.
   */
  it('refuses a reopen that nobody approved, after MFA', async () => {
    const withoutMfa = await http()
      .post(`/close-runs/${closeRunId}/reopen`)
      .set(tenant.auth)
      .set('Idempotency-Key', `reopen-nomfa-${closeRunId}`)
      .send({ reason: 'a payroll accrual for January was missed' })
      .expect(401);
    expect(withoutMfa.body.code).toBe('MFA_REQUIRED');

    await satisfyMfa(tenant.userId);

    const response = await http()
      .post(`/close-runs/${closeRunId}/reopen`)
      .set(tenant.auth)
      .set('Idempotency-Key', `reopen-unapproved-${closeRunId}`)
      .send({ reason: 'a payroll accrual for January was missed' })
      .expect(403);
    expect(response.body.code).toBe('APPROVAL_REQUIRED');
    // Log-only details would leave the caller with nothing to do next.
    expect(response.body.message).toContain('approval');

    const runs = await http()
      .get('/close-runs')
      .query({ accounting_period_id: periodId, status: 'COMPLETED' })
      .set(tenant.auth)
      .expect(200);
    expect(runs.body.data.length).toBe(1);
  });
});

describe('financial statement snapshots', () => {
  it('issues a snapshot and records an approval by a second person', async () => {
    const created = await http()
      .post('/financial-statement-snapshots')
      .set(tenant.auth)
      .set('Idempotency-Key', `snap-${Date.now()}`)
      .send({
        legal_entity_id: ledger.legalEntityId,
        accounting_book_id: ledger.accountingBookId,
        accounting_period_id: periodId,
        // TRIAL_BALANCE rather than BALANCE_SHEET: `assert_statement_snapshot_complete`
        // (0053) requires a core statement to name the report definition version it
        // was rendered from, and report definitions are @acct/reporting's. The close
        // routes are what is under test here.
        snapshot_type: 'TRIAL_BALANCE',
        parameters: { basis: 'ACCRUAL' },
        // Money inside the payload stays a decimal string end to end.
        payload: { lines: [{ account: '1000', closing: '0.00' }] },
      })
      .expect(201);
    expect(created.body.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(created.body.approved_by).toBeNull();

    const approved = await http()
      .post(`/financial-statement-snapshots/${created.body.id}/approve`)
      .set(statementApprover.auth)
      .set('Idempotency-Key', `snap-approve-${created.body.id}`)
      .send({ reason: 'reviewed against the trial balance' })
      .expect(201);
    expect(approved.body.approved_by).toBe(statementApprover.userId);
    // Gate E: the approval changed no byte of the statement.
    expect(approved.body.content_hash).toBe(created.body.content_hash);

    const listed = await http()
      .get('/financial-statement-snapshots')
      .query({ accounting_period_id: periodId, include_payload: 'false' })
      .set(tenant.auth)
      .expect(200);
    expect(listed.body.data.length).toBe(1);
    expect(listed.body.data[0].payload).toBeUndefined();
  });
});
