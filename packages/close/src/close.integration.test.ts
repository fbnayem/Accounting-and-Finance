import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { AppError, D, uuidv7, type Grant, type TenantPrincipal } from '@acct/domain';
import { createPool } from '@acct/database';
import { CloseRunService } from './close-run.service';
import { CloseChecklistService } from './checklist.service';
import { AccountReconciliationService, glBalanceAsAt } from './reconciliation.service';
import { FinancialSnapshotService } from './snapshot.service';
import { assertPeriodReadyForHardClose, assertPeriodReopenApproved } from './period-gate';
import { ApprovalRequestReader } from './approvals';

/**
 * Phase 6, against a real database, both halves of every claim.
 *
 * The three exit criteria this package carries, and the audit's finding on each:
 *
 *   1. "Close dashboard proves all configured reconciliations/checklists complete
 *      before hard close." The audit: hard-closing a period was COMPLETELY
 *      DECOUPLED from the close run, and `readiness_percent` was a stored number
 *      nothing derived. Proved here in both directions — the hard close is REFUSED
 *      while an item is outstanding and PERMITTED when every one is done — and in
 *      the two directions that are easy to miss: a close run that asked for nothing
 *      is refused rather than trivially complete, and a run recorded COMPLETED
 *      whose reconciliation has since been withdrawn is refused again, because the
 *      gate re-derives instead of reading the stored answer.
 *
 *   2. "Reopening a period is privileged, approved and audited." Privileged,
 *      reasoned and audited were already true; approved was not. Five refusals and
 *      one acceptance here: no approval, an approval nobody decided, a
 *      self-approval, an approval by the person being overruled, an approval that
 *      predates the decision it overrules — and then a genuine third-party approval,
 *      which works.
 *
 *   3. Financial snapshots immutable once issued. The audit: approval was
 *      structurally unreachable because the immutability trigger forbids the UPDATE
 *      that would record it. Both lawful routes are proved — approval recorded at
 *      issue, and a separate append-only approval fact afterwards — with the
 *      snapshot row byte-identical either way, and the UPDATE still refused.
 *
 * Against PostgreSQL and not a mock: every one of those claims is about rows,
 * triggers and constraints, several of which (recon_sod, close_tasks_waived_has_reason)
 * are satisfied by a NULL and therefore cannot be tested anywhere else.
 */
const url = testDatabaseUrl();

interface Users {
  preparer: string;
  certifier: string;
  closer: string;
  reopener: string;
  approver: string;
}

interface Fixture {
  tenantId: string;
  organizationId: string;
  entityId: string;
  bookId: string;
  fiscalYearId: string;
  periodJan: string;
  periodFeb: string;
  arControlAccountId: string;
  revenueAccountId: string;
  cashAccountId: string;
  journalId: string;
  templateId: string;
  emptyTemplateId: string;
  /** 0053: a core statement must name the definition it was rendered from. */
  balanceSheetDefinitionId: string;
  profitLossDefinitionId: string;
  users: Users;
  /** A second entity with no control accounts and no template — the vacuity case. */
  vacantEntityId: string;
  vacantBookId: string;
  vacantPeriodId: string;
}

describe.skipIf(!url)('period close, reconciliation and statement snapshots', () => {
  let pool: Pool;
  let f: Fixture;
  let runs: CloseRunService;
  let checklist: CloseChecklistService;
  let reconciliations: AccountReconciliationService;
  let snapshots: FinancialSnapshotService;

  let closeRunId: string;
  let cutoffTaskId: string;
  let accrualTaskId: string;
  let reconciliationId: string;
  let snapshotAtIssueId: string;
  let snapshotUnapprovedId: string;
  let snapshotHash: string;

  beforeAll(async () => {
    pool = createPool({
      connectionString: url!,
      max: 4,
      applicationName: 'acct-close-test',
      statementTimeoutMs: 60_000,
    });
    // Deliberately NOT `migrate(pool)`: other agents are writing migrations into
    // this repository right now, and applying a half-written one would both fail
    // this suite for an unrelated reason and freeze that file's checksum under
    // them. What this suite needs is 0016 (the close tables) and 0050 (their tenant
    // columns, scope keys and the snapshot content-hash guard), so it asserts those
    // are present and says so plainly if they are not.
    await assertMigrated(pool, ['0016', '0017', '0050']);
    f = await createFixture(pool);
    runs = new CloseRunService(pool);
    checklist = new CloseChecklistService(pool);
    reconciliations = new AccountReconciliationService(pool);
    snapshots = new FinancialSnapshotService(pool);
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
  });

  // =========================================================================
  // Criterion 1 — the close gates the hard close
  // =========================================================================

  it('starts a close run from a template, at nought per cent', async () => {
    const run = (await runs.create(principal(f, f.users.preparer, ['close.manage']), {
      legalEntityId: f.entityId,
      accountingBookId: f.bookId,
      accountingPeriodId: f.periodJan,
      templateId: f.templateId,
    })) as unknown as {
      id: string;
      status: string;
      version: number;
      tasks_added: number;
      readiness_percent: string;
      required_total: number;
      configured: boolean;
      complete: boolean;
    };

    closeRunId = run.id;
    expect(run.status).toBe('OPEN');
    expect(run.version).toBe(1);
    expect(run.tasks_added).toBe(3);
    // Two required tasks from the template plus one required reconciliation: the
    // entity's single control account. The reconciliation is required by the chart
    // of accounts, not by the template — that is what stops "no configured
    // reconciliations" from being a way to make the close vacuous.
    expect(run.required_total).toBe(3);
    expect(run.configured).toBe(true);
    expect(run.complete).toBe(false);
    expect(run.readiness_percent).toBe('0.0000');

    const stored = await one<{ readiness_percent: string; status: string }>(
      pool,
      `SELECT readiness_percent::text AS readiness_percent, status::text AS status
         FROM close_runs WHERE id = $1`,
      [closeRunId],
    );
    expect(D(stored.readiness_percent).equals(D('0'))).toBe(true);
    expect(stored.status).toBe('OPEN');
  }, 60_000);

  it('refuses a second run beside the first', async () => {
    await expect(
      runs.create(principal(f, f.users.preparer, ['close.manage']), {
        legalEntityId: f.entityId,
        accountingBookId: f.bookId,
        accountingPeriodId: f.periodJan,
        templateId: f.templateId,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses to finalize while the checklist and the reconciliation are outstanding', async () => {
    const error = await failure(
      runs.finalize(principal(f, f.users.closer, ['close.finalize']), closeRunId),
    );
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.message).toContain('0 of 3');
    expect(error.message).toContain('SUBLEDGER_CUTOFF');
    // The reconciliation is named as well as the tasks, and it is named as MISSING
    // rather than merely absent from the list.
    expect(error.message).toContain('reconciliation 1100');
    expect(error.message).toContain('MISSING');
  });

  it('refuses the hard close of the period while the close is outstanding — the REFUSE half', async () => {
    const error = await failure(gate(pool, f.periodJan));
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.message).toContain('no completed close run');
    expect(error.message).toContain('PRI');
    expect(error.message).toContain('POST /close-runs/{id}/finalize');
  });

  it('refuses a task whose prerequisite is open, and accepts it once the prerequisite is done', async () => {
    const tasks = (await checklist.listTasks(
      principal(f, f.users.preparer, ['close.view']),
      closeRunId,
    )) as unknown as {
      data: { id: string; code: string; status: string }[];
      readiness: { readiness_percent: string; required_total: number; configured: boolean };
    };
    cutoffTaskId = tasks.data.find((t) => t.code === 'SUBLEDGER_CUTOFF')!.id;
    accrualTaskId = tasks.data.find((t) => t.code === 'ACCRUALS')!.id;

    const blocked = await failure(
      checklist.completeTask(principal(f, f.users.preparer, ['close.manage']), accrualTaskId),
    );
    expect(blocked.code).toBe('VALIDATION_FAILED');
    expect(blocked.message).toContain('depends on SUBLEDGER_CUTOFF');

    const first = (await checklist.completeTask(
      principal(f, f.users.preparer, ['close.manage']),
      cutoffTaskId,
      { evidence: [{ kind: 'NOTE', text: 'subledgers cut off' }] },
    )) as unknown as { readiness_percent: string; close_run_status: string };
    expect(first.readiness_percent).toBe('33.3333');
    expect(first.close_run_status).toBe('IN_PROGRESS');

    const second = (await checklist.completeTask(
      principal(f, f.users.preparer, ['close.manage']),
      accrualTaskId,
    )) as unknown as { readiness_percent: string };
    expect(second.readiness_percent).toBe('66.6667');

    // Completing it twice is refused: a second sign-off that never happened.
    const again = await failure(
      checklist.completeTask(principal(f, f.users.preparer, ['close.manage']), cutoffTaskId),
    );
    expect(again.message).toContain('already COMPLETED');
  }, 60_000);

  it('does not count a task waived by nobody — the NULL case', async () => {
    // `close_tasks_waived_has_reason` requires the reason and nothing requires the
    // waiver, so this row is reachable in the database. The optional FLUX_REVIEW
    // task is used so the required count is unaffected; what is asserted is that a
    // waiver with no waiver does not satisfy anything.
    await pool.query(
      `UPDATE close_tasks SET status = 'WAIVED', waived_reason = 'immaterial', waived_by = NULL
        WHERE close_run_id = $1 AND code = 'FLUX_REVIEW'`,
      [closeRunId],
    );
    const view = (await checklist.listTasks(
      principal(f, f.users.preparer, ['close.view']),
      closeRunId,
    )) as unknown as { readiness: { waived_count: number; readiness_percent: string } };
    expect(view.readiness.waived_count).toBe(0);
    expect(view.readiness.readiness_percent).toBe('66.6667');

    await pool.query(
      `UPDATE close_tasks SET status = 'OPEN', waived_reason = NULL WHERE close_run_id = $1
        AND code = 'FLUX_REVIEW'`,
      [closeRunId],
    );
  });

  it('computes the GL side of a reconciliation from journal lines rather than accepting one', async () => {
    const prepared = (await reconciliations.create(
      principal(f, f.users.preparer, ['reconciliation.manage']),
      {
        legalEntityId: f.entityId,
        accountingBookId: f.bookId,
        accountingPeriodId: f.periodJan,
        accountId: f.arControlAccountId,
        supportingBalance: '940.00',
        closeRunId,
      },
    )) as unknown as {
      id: string;
      gl_balance: string;
      supporting_balance: string;
      difference: string;
      status: string;
      explained: boolean;
    };
    reconciliationId = prepared.id;

    // 1000 posted to the AR control account in January; the caller said the
    // subledger carries 940. Neither number was taken on trust: the GL side is
    // summed from journal lines and the difference is derived, which is what
    // `recon_difference_derived` also insists on.
    expect(D(prepared.gl_balance).equals(D('1000'))).toBe(true);
    expect(D(prepared.difference).equals(D('60'))).toBe(true);
    expect(prepared.status).toBe('PREPARED');
    expect(prepared.explained).toBe(false);
  }, 60_000);

  it('refuses certification while the difference is unexplained, and accepts it when the items sum exactly', async () => {
    const unexplained = await failure(
      reconciliations.certify(
        principal(f, f.users.certifier, ['reconciliation.certify']),
        reconciliationId,
      ),
    );
    expect(unexplained.code).toBe('VALIDATION_FAILED');
    expect(unexplained.message).toContain('difference of 60');
    expect(unexplained.message).toContain('totalling 0');

    // Two items that sum to the difference exactly — Gate D's "explicit,
    // explainable reconciliation item". (`createReconcilingItem` is a separate
    // operation and a separate agent's; the rows are what this gate reads.)
    for (const [amount, description] of [
      ['45.00', 'invoice INV-1041 issued 31 Jan, posted 1 Feb'],
      ['15.00', 'unapplied receipt held in suspense'],
    ]) {
      await pool.query(
        `INSERT INTO reconciling_items
           (id, tenant_id, account_reconciliation_id, item_type, description, amount)
         VALUES ($1,$2,$3,'TIMING',$4,$5::numeric)`,
        [uuidv7(), f.tenantId, reconciliationId, description, amount],
      );
    }

    const byPreparer = await failure(
      reconciliations.certify(
        principal(f, f.users.preparer, ['reconciliation.certify']),
        reconciliationId,
      ),
    );
    expect(byPreparer.code).toBe('SEGREGATION_OF_DUTIES');
    expect(byPreparer.message).toContain('prepared by you');

    const certified = (await reconciliations.certify(
      principal(f, f.users.certifier, ['reconciliation.certify']),
      reconciliationId,
    )) as unknown as { status: string; approved_by: string; reconciling_items_total: string };
    expect(certified.status).toBe('CERTIFIED');
    expect(certified.approved_by).toBe(f.users.certifier);
    expect(D(certified.reconciling_items_total).equals(D('60'))).toBe(true);

    const view = (await checklist.listTasks(
      principal(f, f.users.preparer, ['close.view']),
      closeRunId,
    )) as unknown as { readiness: { readiness_percent: string; complete: boolean } };
    expect(view.readiness.readiness_percent).toBe('100.0000');
    expect(view.readiness.complete).toBe(true);

    const stored = await one<{ status: string; readiness_percent: string }>(
      pool,
      `SELECT status::text AS status, readiness_percent::text AS readiness_percent
         FROM close_runs WHERE id = $1`,
      [closeRunId],
    );
    expect(stored.status).toBe('READY');
    expect(D(stored.readiness_percent).equals(D('100'))).toBe(true);
  }, 60_000);

  it('still refuses the hard close until the close run is actually finalized', async () => {
    // Ready is not closed. A dashboard at 100% that let the period close would be
    // gating on the display rather than on the decision.
    const error = await failure(gate(pool, f.periodJan));
    expect(error.message).toContain('no completed close run');
  });

  it('finalizes the close and then permits the hard close — the ACCEPT half', async () => {
    const finalized = (await runs.finalize(
      principal(f, f.users.closer, ['close.finalize']),
      closeRunId,
      { note: 'January signed off' },
    )) as unknown as { status: string; readiness_percent: string; required_total: number };
    expect(finalized.status).toBe('COMPLETED');
    expect(D(finalized.readiness_percent).equals(D('100'))).toBe(true);
    expect(finalized.required_total).toBe(3);

    const readiness = await gate(pool, f.periodJan);
    expect(readiness.ready).toBe(true);
    expect(readiness.books).toHaveLength(1);
    expect(readiness.books[0]!.complete).toBe(true);
    expect(readiness.books[0]!.readinessPercent).toBe('100.0000');

    // Audited: the finalize is on the hash chain, and it is the only record of WHO
    // finalized — close_runs has completed_at and no completed_by.
    const audit = await one<{ actor_id: string; action: string }>(
      pool,
      `SELECT actor_id, action FROM audit_events
        WHERE resource_type = 'close_run' AND resource_id = $1 AND action = 'close_run.finalized'
        ORDER BY id DESC LIMIT 1`,
      [closeRunId],
    );
    expect(audit.actor_id).toBe(f.users.closer);

    const event = await one<{ event_type: string }>(
      pool,
      `SELECT event_type FROM outbox_events
        WHERE aggregate_type = 'close_run' AND aggregate_id = $1 AND event_type = 'period.closed'
        LIMIT 1`,
      [closeRunId],
    );
    expect(event.event_type).toBe('period.closed');
  }, 60_000);

  it('refuses the hard close again when a certified reconciliation is withdrawn', async () => {
    // The close run still says COMPLETED. The gate re-derives, so withdrawing the
    // certification — which `reopenAccountReconciliation` does — closes the period
    // gate again. This is the difference between gating on a stored number and
    // gating on the facts.
    await pool.query(
      `UPDATE account_reconciliations SET status = 'REOPENED', reopened_reason = 'item disputed'
        WHERE id = $1`,
      [reconciliationId],
    );

    const error = await failure(gate(pool, f.periodJan));
    expect(error.message).toContain('recorded COMPLETED but is not complete now');
    expect(error.message).toContain('2 of 3');
    expect(error.message).toContain('reconciliation 1100');

    await pool.query(
      `UPDATE account_reconciliations SET status = 'CERTIFIED', reopened_reason = NULL
        WHERE id = $1`,
      [reconciliationId],
    );
    expect((await gate(pool, f.periodJan)).ready).toBe(true);
  }, 60_000);

  it('refuses the hard close when the ledger moved after the certification', async () => {
    // A late January journal on the control account. The reconciliation is still
    // CERTIFIED and its items still explain the difference it recorded — but it
    // reconciles a balance the period no longer carries.
    await postJournal(pool, f, {
      periodId: f.periodJan,
      date: '2026-01-31',
      number: 'GJ-LATE',
      lines: [
        { accountId: f.arControlAccountId, debit: '500.00', credit: '0' },
        { accountId: f.revenueAccountId, debit: '0', credit: '500.00' },
      ],
    });

    const error = await failure(gate(pool, f.periodJan));
    expect(error.message).toContain('general ledger has moved since this was certified');

    // Re-prepared against the new balance and certified again: the ACCEPT half of
    // the same rule. (Re-preparing needs the certification withdrawn first, which
    // is what the reopen route does.)
    await pool.query(`UPDATE account_reconciliations SET status = 'REOPENED' WHERE id = $1`, [
      reconciliationId,
    ]);
    const reprepared = (await reconciliations.create(
      principal(f, f.users.preparer, ['reconciliation.manage']),
      {
        legalEntityId: f.entityId,
        accountingBookId: f.bookId,
        accountingPeriodId: f.periodJan,
        accountId: f.arControlAccountId,
        supportingBalance: '1440.00',
        closeRunId,
      },
    )) as unknown as { id: string; gl_balance: string; difference: string };
    expect(D(reprepared.gl_balance).equals(D('1500'))).toBe(true);
    expect(D(reprepared.difference).equals(D('60'))).toBe(true);

    await reconciliations.certify(
      principal(f, f.users.certifier, ['reconciliation.certify']),
      reconciliationId,
    );
    expect((await gate(pool, f.periodJan)).ready).toBe(true);
  }, 60_000);

  it('does not count a reconciliation certified against no preparer — the NULL case', async () => {
    // `recon_sod` is `approved_by IS NULL OR approved_by <> prepared_by`, which a
    // NULL preparer satisfies because the comparison is NULL. The row is therefore
    // reachable, and the gate must not accept it.
    await pool.query(`UPDATE account_reconciliations SET prepared_by = NULL WHERE id = $1`, [
      reconciliationId,
    ]);

    const error = await failure(gate(pool, f.periodJan));
    expect(error.message).toContain('certified against no preparer');

    // And certification itself refuses the same case rather than leaning on the CHECK.
    await pool.query(
      `UPDATE account_reconciliations SET status = 'PREPARED', approved_by = NULL, approved_at = NULL
        WHERE id = $1`,
      [reconciliationId],
    );
    const refused = await failure(
      reconciliations.certify(
        principal(f, f.users.certifier, ['reconciliation.certify']),
        reconciliationId,
      ),
    );
    expect(refused.code).toBe('SEGREGATION_OF_DUTIES');
    expect(refused.message).toContain('records no preparer');

    await pool.query(
      `UPDATE account_reconciliations
          SET prepared_by = $2, status = 'CERTIFIED', approved_by = $3, approved_at = now()
        WHERE id = $1`,
      [reconciliationId, f.users.preparer, f.users.certifier],
    );
    expect((await gate(pool, f.periodJan)).ready).toBe(true);
  }, 60_000);

  it('refuses to finalize a close run that asked for nothing', async () => {
    // The vacuity case, end to end: an entity with no control accounts, a close run
    // with no template. Nothing is outstanding because nothing was ever required,
    // and "complete" over an empty set is exactly the failure this gate exists to
    // prevent.
    const run = (await runs.create(principal(f, f.users.preparer, ['close.manage']), {
      legalEntityId: f.vacantEntityId,
      accountingBookId: f.vacantBookId,
      accountingPeriodId: f.vacantPeriodId,
    })) as unknown as { id: string; required_total: number; configured: boolean };
    expect(run.required_total).toBe(0);
    expect(run.configured).toBe(false);

    const error = await failure(
      runs.finalize(principal(f, f.users.closer, ['close.finalize']), run.id),
    );
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.message).toContain('no required checklist task and no account configured');
    expect(error.message).toContain('POST /close-checklists/generate');

    // And the period gate refuses too, for the same reason and separately.
    const gateError = await failure(gate(pool, f.vacantPeriodId));
    expect(gateError.message).toContain('no completed close run');
  }, 60_000);

  it('refuses to generate a checklist from a template that has no tasks', async () => {
    const run = await one<{ id: string }>(
      pool,
      `SELECT id FROM close_runs WHERE accounting_period_id = $1 ORDER BY version DESC LIMIT 1`,
      [f.vacantPeriodId],
    );
    const error = await failure(
      checklist.generate(principal(f, f.users.preparer, ['close.manage']), {
        closeRunId: run.id,
        templateId: f.emptyTemplateId,
      }),
    );
    expect(error.message).toContain('has no tasks');
  });

  // =========================================================================
  // Criterion 2 — the reopen is approved, not merely permitted
  // =========================================================================

  it('refuses a reopen that nobody approved', async () => {
    const error = await failure(
      runs.reopen(principal(f, f.users.reopener, ['close.reopen']), closeRunId, {
        reason: 'a payroll accrual was missed',
      }),
    );
    expect(error.code).toBe('APPROVAL_REQUIRED');
    expect(error.message).toContain('has not been approved');
    expect(error.message).toContain('approval request');
  });

  it('refuses a reopen with no reason, before it even looks at the approval', async () => {
    const error = await failure(
      runs.reopen(principal(f, f.users.reopener, ['close.reopen']), closeRunId, { reason: '  ' }),
    );
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.fieldErrors[0]?.field).toBe('reason');
  });

  it('refuses an approval nobody decided, a self-approval, and the finalizer approving their own close', async () => {
    const requestId = await raiseApprovalRequest(pool, f, {
      resourceType: 'CLOSE_RUN',
      resourceId: closeRunId,
      decidedBy: null,
      decidedAt: null,
    });

    // (a) An APPROVED request whose step records no decider. `decided_by <> actor`
    // against NULL is NULL — which passes — so the reader excludes it in SQL and
    // the caller sees "not approved" rather than a silent acceptance.
    const undecided = await failure(reopen());
    expect(undecided.code).toBe('APPROVAL_REQUIRED');

    // (b) Self-approval.
    await decide(pool, requestId, f.users.reopener);
    const self = await failure(reopen());
    expect(self.code).toBe('SEGREGATION_OF_DUTIES');
    expect(self.message).toContain('approved by the person requesting it');

    // (c) The person who finalized the close approving the reopening of it.
    await decide(pool, requestId, f.users.closer);
    const byFinalizer = await failure(reopen());
    expect(byFinalizer.code).toBe('SEGREGATION_OF_DUTIES');
    expect(byFinalizer.message).toContain('finalized this close');

    // (d) A third party's approval, but decided before the close was finalized —
    // an approval cannot authorise the undoing of a decision that had not been
    // taken when it was given.
    await decide(pool, requestId, f.users.approver, '2020-01-01T00:00:00Z');
    const stale = await failure(reopen());
    expect(stale.code).toBe('APPROVAL_REQUIRED');

    function reopen() {
      return runs.reopen(principal(f, f.users.reopener, ['close.reopen']), closeRunId, {
        reason: 'a payroll accrual was missed',
      });
    }
  }, 60_000);

  it('reopens on a third party approval, as a new version that keeps the old one', async () => {
    const requestId = await one<{ id: string }>(
      pool,
      `SELECT id FROM approval_requests WHERE resource_type = 'CLOSE_RUN' AND resource_id = $1
        ORDER BY requested_at DESC LIMIT 1`,
      [closeRunId],
    );
    await decide(pool, requestId.id, f.users.approver);

    const next = (await runs.reopen(principal(f, f.users.reopener, ['close.reopen']), closeRunId, {
      reason: 'a payroll accrual for January was missed and must be posted',
    })) as unknown as {
      id: string;
      version: number;
      status: string;
      reopened_close_run_id: string;
      approval: { approved_by: string };
      required_total: number;
    };

    expect(next.version).toBe(2);
    expect(next.status).toBe('OPEN');
    expect(next.approval.approved_by).toBe(f.users.approver);
    // The new version carries the checklist again, so the second attempt at the
    // close has to prove the same things — not inherit the first attempt's answer.
    expect(next.required_total).toBe(3);

    const previous = await one<{ status: string; reopen_reason: string; reopened_by: string }>(
      pool,
      `SELECT status::text AS status, reopen_reason, reopened_by FROM close_runs WHERE id = $1`,
      [closeRunId],
    );
    expect(previous.status).toBe('REOPENED');
    expect(previous.reopen_reason).toContain('payroll accrual');
    expect(previous.reopened_by).toBe(f.users.reopener);

    // Version 1's task history survives the reopen (F-038): the second version has
    // its own tasks, and the first version's completions are still there.
    const history = await one<{ completed: string }>(
      pool,
      `SELECT count(*)::text AS completed FROM close_tasks
        WHERE close_run_id = $1 AND status = 'COMPLETED'`,
      [closeRunId],
    );
    expect(history.completed).toBe('2');

    // Audited, with the approval named on the audit row rather than only in a log.
    const audit = await one<{ after_data: { approved_by: string }; reason: string }>(
      pool,
      `SELECT after_data, reason FROM audit_events
        WHERE resource_type = 'close_run' AND resource_id = $1 AND action = 'close_run.reopened'
        ORDER BY id DESC LIMIT 1`,
      [closeRunId],
    );
    expect(audit.after_data.approved_by).toBe(f.users.approver);
    expect(audit.reason).toContain('payroll accrual');

    // And the period is gateable again only through the new version.
    const error = await failure(gate(pool, f.periodJan));
    expect(error.message).toContain('no completed close run');
  }, 60_000);

  it('refuses a period reopen that is unapproved or approved by the person who closed it', async () => {
    // The calendar period, not the close run — the exit criterion's literal
    // subject. February is used so January stays open for the snapshot tests.
    await pool.query(
      `UPDATE accounting_periods
          SET status = 'HARD_CLOSED', closed_by = $2, closed_at = now(), closed_reason = 'February closed'
        WHERE id = $1`,
      [f.periodFeb, f.users.closer],
    );

    const reader = new ApprovalRequestReader();
    const unapproved = await failure(
      withClient(pool, (client) =>
        assertPeriodReopenApproved(client, reader, {
          tenantId: f.tenantId,
          accountingPeriodId: f.periodFeb,
          actorId: f.users.reopener,
        }),
      ),
    );
    expect(unapproved.code).toBe('APPROVAL_REQUIRED');
    expect(unapproved.message).toContain('period FEB-26');

    const requestId = await raiseApprovalRequest(pool, f, {
      resourceType: 'ACCOUNTING_PERIOD',
      resourceId: f.periodFeb,
      decidedBy: f.users.closer,
      decidedAt: null,
    });
    const byCloser = await failure(
      withClient(pool, (client) =>
        assertPeriodReopenApproved(client, reader, {
          tenantId: f.tenantId,
          accountingPeriodId: f.periodFeb,
          actorId: f.users.reopener,
        }),
      ),
    );
    expect(byCloser.code).toBe('SEGREGATION_OF_DUTIES');
    expect(byCloser.message).toContain('closed this period');

    // The NULL case: a period whose closer is unknown cannot be shown to have been
    // reopened by somebody else, so it is refused rather than waved through.
    await pool.query(`UPDATE accounting_periods SET closed_by = NULL WHERE id = $1`, [f.periodFeb]);
    await decide(pool, requestId, f.users.approver);
    const unknownCloser = await failure(
      withClient(pool, (client) =>
        assertPeriodReopenApproved(client, reader, {
          tenantId: f.tenantId,
          accountingPeriodId: f.periodFeb,
          actorId: f.users.reopener,
        }),
      ),
    );
    expect(unknownCloser.code).toBe('SEGREGATION_OF_DUTIES');
    expect(unknownCloser.message).toContain('does not say who closed this period');

    // And with a known closer and a third party's approval, it passes.
    await pool.query(`UPDATE accounting_periods SET closed_by = $2 WHERE id = $1`, [
      f.periodFeb,
      f.users.closer,
    ]);
    const approval = await withClient(pool, (client) =>
      assertPeriodReopenApproved(client, reader, {
        tenantId: f.tenantId,
        accountingPeriodId: f.periodFeb,
        actorId: f.users.reopener,
      }),
    );
    expect(approval.decidedBy).toBe(f.users.approver);
  }, 60_000);

  // =========================================================================
  // Criterion 3 — an issued statement cannot change
  // =========================================================================

  it('issues a statement with a hash the database computes, and records an approval at issue', async () => {
    const balance = await withClient(pool, (client) =>
      glBalanceAsAt(client, {
        accountingBookId: f.bookId,
        accountId: f.arControlAccountId,
        accountingPeriodId: f.periodJan,
      }),
    );

    const issued = (await snapshots.create(principal(f, f.users.preparer, ['report.snapshot']), {
      legalEntityId: f.entityId,
      accountingBookId: f.bookId,
      accountingPeriodId: f.periodJan,
      reportDefinitionId: f.balanceSheetDefinitionId,
      snapshotType: 'BALANCE_SHEET',
      parameters: { basis: 'ACCRUAL' },
      payload: { rows: [{ account: '1100', amount: balance }] },
    })) as unknown as {
      id: string;
      version: number;
      content_hash: string;
      approved_by: string | null;
    };
    snapshotUnapprovedId = issued.id;
    snapshotHash = issued.content_hash;
    expect(issued.version).toBe(1);
    expect(issued.approved_by).toBeNull();

    const expected = await one<{ h: string }>(
      pool,
      `SELECT financial_snapshot_content_hash(payload) AS h FROM financial_snapshots WHERE id = $1`,
      [issued.id],
    );
    expect(issued.content_hash).toBe(expected.h);

    // Approval at issue — the one moment the immutability trigger permits it,
    // because it is part of the INSERT and not an UPDATE.
    const selfApproved = await failure(
      snapshots.create(principal(f, f.users.preparer, ['report.snapshot']), {
        legalEntityId: f.entityId,
        accountingBookId: f.bookId,
        accountingPeriodId: f.periodJan,
        reportDefinitionId: f.profitLossDefinitionId,
        snapshotType: 'PROFIT_LOSS',
        payload: { rows: [] },
        approval: { approvedBy: f.users.preparer },
      }),
    );
    expect(selfApproved.code).toBe('SEGREGATION_OF_DUTIES');
    expect(selfApproved.message).toContain('issued and approved by the same person');

    const approvedAtIssue = (await snapshots.create(
      principal(f, f.users.preparer, ['report.snapshot']),
      {
        legalEntityId: f.entityId,
        accountingBookId: f.bookId,
        accountingPeriodId: f.periodJan,
        reportDefinitionId: f.profitLossDefinitionId,
        snapshotType: 'PROFIT_LOSS',
        payload: { rows: [{ account: '4000', amount: '-1500.00000000' }] },
        approval: { approvedBy: f.users.approver, reason: 'reviewed against the trial balance' },
      },
    )) as unknown as { id: string; approved_by: string; approval_recorded: string };
    snapshotAtIssueId = approvedAtIssue.id;
    expect(approvedAtIssue.approved_by).toBe(f.users.approver);
    expect(approvedAtIssue.approval_recorded).toBe('AT_ISSUE');

    const event = await one<{ event_type: string }>(
      pool,
      `SELECT event_type FROM outbox_events
        WHERE aggregate_id = $1 AND event_type = 'financial_statements.approved' LIMIT 1`,
      [snapshotAtIssueId],
    );
    expect(event.event_type).toBe('financial_statements.approved');
  }, 60_000);

  it('refuses every update of an issued statement, including the approval columns', async () => {
    // Why the approval has to be recorded at issue or as a separate fact: these are
    // the writes the 0016 trigger refuses, and neither control is relaxed here.
    await expect(
      pool.query(`UPDATE financial_snapshots SET payload = '{"rows":[]}'::jsonb WHERE id = $1`, [
        snapshotUnapprovedId,
      ]),
    ).rejects.toThrow(/POSTED_IMMUTABLE/);

    await expect(
      pool.query(
        `UPDATE financial_snapshots SET approved_by = $2, approved_at = now() WHERE id = $1`,
        [snapshotUnapprovedId, f.users.approver],
      ),
    ).rejects.toThrow(/POSTED_IMMUTABLE/);

    await expect(
      pool.query(`DELETE FROM financial_snapshots WHERE id = $1`, [snapshotUnapprovedId]),
    ).rejects.toThrow(/POSTED_IMMUTABLE/);
  });

  it('records a post-issue approval as an append-only fact, leaving the statement byte-identical', async () => {
    const before = await one<{
      payload: unknown;
      content_hash: string;
      approved_by: string | null;
    }>(pool, `SELECT payload, content_hash, approved_by FROM financial_snapshots WHERE id = $1`, [
      snapshotUnapprovedId,
    ]);

    const issuerApproving = await failure(
      snapshots.recordApproval(
        principal(f, f.users.preparer, ['financial_statement.approve']),
        snapshotUnapprovedId,
      ),
    );
    expect(issuerApproving.code).toBe('SEGREGATION_OF_DUTIES');

    const fact = (await snapshots.recordApproval(
      principal(f, f.users.approver, ['financial_statement.approve']),
      snapshotUnapprovedId,
      { reason: 'approved at the February board meeting' },
    )) as unknown as { approved_by: string; content_hash: string; approval_recorded: string };
    expect(fact.approved_by).toBe(f.users.approver);
    expect(fact.approval_recorded).toBe('APPROVAL_FACT');
    expect(fact.content_hash).toBe(snapshotHash);

    const after = await one<{ payload: unknown; content_hash: string; approved_by: string | null }>(
      pool,
      `SELECT payload, content_hash, approved_by FROM financial_snapshots WHERE id = $1`,
      [snapshotUnapprovedId],
    );
    expect(after).toEqual(before);
    // The row still says nobody approved it; the FACT says who did. That is the
    // whole point — the statement is unchanged and the approval is recorded.
    expect(after.approved_by).toBeNull();

    const listed = (await snapshots.list(principal(f, f.users.preparer, ['report.view']), {
      legalEntityId: f.entityId,
    })) as unknown as {
      data: { id: string; approved_by: string | null; approval_recorded: string | null }[];
    };
    const readBack = listed.data.find((s) => s.id === snapshotUnapprovedId)!;
    expect(readBack.approved_by).toBe(f.users.approver);
    expect(readBack.approval_recorded).toBe('APPROVAL_FACT');
    expect(listed.data.find((s) => s.id === snapshotAtIssueId)!.approval_recorded).toBe('AT_ISSUE');

    const second = await failure(
      snapshots.recordApproval(
        principal(f, f.users.approver, ['financial_statement.approve']),
        snapshotUnapprovedId,
      ),
    );
    expect(second.message).toContain('already approved');
  }, 60_000);

  it('is unchanged by transactions posted after it was issued — Gate E', async () => {
    const balanceAtIssue = await one<{ payload: { rows: { amount: string }[] } }>(
      pool,
      `SELECT payload FROM financial_snapshots WHERE id = $1`,
      [snapshotUnapprovedId],
    );

    await postJournal(pool, f, {
      periodId: f.periodJan,
      date: '2026-01-31',
      number: 'GJ-AFTER-SNAPSHOT',
      lines: [
        { accountId: f.arControlAccountId, debit: '250.00', credit: '0' },
        { accountId: f.revenueAccountId, debit: '0', credit: '250.00' },
      ],
    });

    const now = await withClient(pool, (client) =>
      glBalanceAsAt(client, {
        accountingBookId: f.bookId,
        accountId: f.arControlAccountId,
        accountingPeriodId: f.periodJan,
      }),
    );
    const after = await one<{ payload: { rows: { amount: string }[] }; content_hash: string }>(
      pool,
      `SELECT payload, content_hash FROM financial_snapshots WHERE id = $1`,
      [snapshotUnapprovedId],
    );

    // The ledger moved; the statement did not, and its hash still matches the bytes
    // it was issued with.
    expect(D(now).equals(D('1750'))).toBe(true);
    expect(after.payload).toEqual(balanceAtIssue.payload);
    expect(after.content_hash).toBe(snapshotHash);
    expect(D(after.payload.rows[0]!.amount).equals(D('1500'))).toBe(true);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Fixture and helpers
// ---------------------------------------------------------------------------

function testDatabaseUrl(): string | undefined {
  const fromEnv = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (fromEnv) return fromEnv;

  let dir = resolve(process.cwd());
  for (let depth = 0; depth < 4; depth++) {
    const file = join(dir, '.env');
    if (existsSync(file)) {
      const found: Record<string, string> = {};
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const match = /^\s*(TEST_DATABASE_URL|DATABASE_URL)\s*=\s*(.*?)\s*$/.exec(line);
        if (match) found[match[1]!] = match[2]!.replace(/^["']|["']$/g, '');
      }
      return found.TEST_DATABASE_URL ?? found.DATABASE_URL;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

async function assertMigrated(pool: Pool, versions: readonly string[]): Promise<void> {
  const { rows } = await pool.query<{ version: string }>(
    `SELECT version FROM schema_migrations WHERE version = ANY($1::text[])`,
    [[...versions]],
  );
  const applied = new Set(rows.map((r) => r.version));
  const missing = versions.filter((v) => !applied.has(v));
  if (missing.length > 0) {
    throw new Error(
      `The test database is missing migration(s) ${missing.join(', ')}. Run \`pnpm db:migrate\` ` +
        `against TEST_DATABASE_URL before this suite.`,
    );
  }
}

async function one<T>(pool: Pool, sql: string, params: unknown[]): Promise<T> {
  const { rows } = await pool.query<T>(sql, params);
  if (!rows[0]) throw new Error(`expected a row from: ${sql}`);
  return rows[0];
}

async function withClient<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** The period hard-close gate, as finance-setup will call it. */
async function gate(pool: Pool, periodId: string) {
  return withClient(pool, (client) => assertPeriodReadyForHardClose(client, periodId));
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (e) {
    if (AppError.isAppError(e)) return e;
    throw e;
  }
  throw new Error('expected a refusal, and the call succeeded');
}

function principal(f: Fixture, userId: string, permissions: readonly string[]): TenantPrincipal {
  const grant: Grant = {
    membershipId: uuidv7(),
    roleId: uuidv7(),
    roleCode: 'CLOSE_TEST',
    organizationId: null,
    legalEntityId: null,
    branchId: null,
    permissions: new Set<string>(permissions),
  };
  return {
    userId,
    sessionId: uuidv7(),
    email: `${userId}@example.test`,
    displayName: 'close test',
    tenantId: f.tenantId,
    grants: [grant],
    mfaSatisfied: true,
    mfaVerifiedAt: new Date(),
    impersonatedBy: null,
  };
}

interface JournalArgs {
  periodId: string;
  date: string;
  number: string;
  lines: { accountId: string; debit: string; credit: string }[];
}

/**
 * A posted journal, written directly.
 *
 * `PostingService` is @acct/ledger's and composing a journal is not this package's
 * business — what these tests need is ledger FACTS for the reconciliation to read
 * and for Gate E to move underneath a snapshot. The rows go in inside one
 * transaction so `journal_entries_balanced` (DEFERRABLE INITIALLY DEFERRED) fires
 * at COMMIT with the lines present.
 */
async function postJournal(pool: Pool, f: Fixture, args: JournalArgs): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const entryId = uuidv7();
    await client.query(
      `INSERT INTO journal_entries
         (id, tenant_id, legal_entity_id, accounting_book_id, journal_id, accounting_period_id,
          entry_number, posting_date, source_type, base_currency, status, posted_at, posted_by,
          created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,'MANUAL','USD','POSTED',now(),$9,$9)`,
      [
        entryId,
        f.tenantId,
        f.entityId,
        f.bookId,
        f.journalId,
        args.periodId,
        args.number,
        args.date,
        f.users.preparer,
      ],
    );
    let lineNo = 1;
    for (const line of args.lines) {
      await client.query(
        `INSERT INTO journal_lines
           (id, tenant_id, journal_entry_id, legal_entity_id, accounting_book_id,
            accounting_period_id, posting_date, line_no, account_id,
            transaction_currency, transaction_debit, transaction_credit,
            base_currency, base_debit, base_credit)
         VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9,'USD',$10::numeric,$11::numeric,'USD',
                 $10::numeric,$11::numeric)`,
        [
          uuidv7(),
          f.tenantId,
          entryId,
          f.entityId,
          f.bookId,
          args.periodId,
          args.date,
          lineNo++,
          line.accountId,
          line.debit,
          line.credit,
        ],
      );
    }
    await client.query('COMMIT');
    return entryId;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * An approval request and its decision, as the approval engine would record them.
 *
 * @acct/approvals does not exist yet, so the FACTS are written here rather than
 * raised through it: `assertReopenApproved` reads `approval_requests` and
 * `approval_steps`, and what these tests prove is that it reads them correctly —
 * including the NULL decider, which is the case a comparison cannot catch.
 */
async function raiseApprovalRequest(
  pool: Pool,
  f: Fixture,
  input: {
    resourceType: string;
    resourceId: string;
    decidedBy: string | null;
    decidedAt: string | null;
  },
): Promise<string> {
  const workflowId = await ensureWorkflow(pool, f, input.resourceType);
  const requestId = uuidv7();
  await pool.query(
    `INSERT INTO approval_requests
       (id, tenant_id, legal_entity_id, approval_workflow_id, workflow_version, resource_type,
        resource_id, status, requested_by, snapshot)
     VALUES ($1,$2,$3,$4,1,$5,$6,'APPROVED',$7,'{}'::jsonb)`,
    [
      requestId,
      f.tenantId,
      f.entityId,
      workflowId,
      input.resourceType,
      input.resourceId,
      f.users.reopener,
    ],
  );
  await pool.query(
    `INSERT INTO approval_steps
       (id, tenant_id, approval_request_id, step_no, approver_user_id, resolved_from, status,
        decision, decided_by, decided_at)
     VALUES ($1,$2,$3,1,$4,'NAMED_USER','APPROVED','APPROVE',$5,coalesce($6::timestamptz, now()))`,
    [uuidv7(), f.tenantId, requestId, f.users.approver, input.decidedBy, input.decidedAt],
  );
  return requestId;
}

/** Re-decides the request's step — who approved, and when. */
async function decide(
  pool: Pool,
  requestId: string,
  decidedBy: string,
  decidedAt?: string,
): Promise<void> {
  await pool.query(
    `UPDATE approval_steps
        SET decided_by = $2, decided_at = coalesce($3::timestamptz, now()),
            status = 'APPROVED', decision = 'APPROVE'
      WHERE approval_request_id = $1`,
    [requestId, decidedBy, decidedAt ?? null],
  );
}

async function ensureWorkflow(pool: Pool, f: Fixture, resourceType: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM approval_workflows WHERE tenant_id = $1 AND resource_type = $2 LIMIT 1`,
    [f.tenantId, resourceType],
  );
  if (rows[0]) return rows[0].id;
  const id = uuidv7();
  await pool.query(
    `INSERT INTO approval_workflows
       (id, tenant_id, legal_entity_id, resource_type, code, name, version, valid_from,
        definition, published_at)
     VALUES ($1,$2,$3,$4,$5,$6,1,now() - interval '1 year','{"steps":[{"step_no":1}]}'::jsonb,now())`,
    [id, f.tenantId, f.entityId, resourceType, `${resourceType}_reopen`, `${resourceType} reopen`],
  );
  return id;
}

async function createFixture(pool: Pool): Promise<Fixture> {
  const tenantId = uuidv7();
  const organizationId = uuidv7();
  const entityId = uuidv7();
  const bookId = uuidv7();
  const fiscalYearId = uuidv7();
  const journalId = uuidv7();
  const templateId = uuidv7();
  const emptyTemplateId = uuidv7();
  const roleId = uuidv7();
  const slug = `close-${tenantId}`;

  const users: Users = {
    preparer: uuidv7(),
    certifier: uuidv7(),
    closer: uuidv7(),
    reopener: uuidv7(),
    approver: uuidv7(),
  };

  await pool.query(`INSERT INTO tenants (id, name, slug) VALUES ($1,$2,$3)`, [
    tenantId,
    slug,
    slug,
  ]);
  for (const [name, id] of Object.entries(users)) {
    await pool.query(`INSERT INTO users (id, email, display_name) VALUES ($1,$2,$3)`, [
      id,
      `${id}@example.test`,
      `close ${name}`,
    ]);
  }
  await pool.query(`INSERT INTO organizations (id, tenant_id, name) VALUES ($1,$2,$3)`, [
    organizationId,
    tenantId,
    'Close Org',
  ]);
  await pool.query(`INSERT INTO roles (id, tenant_id, code, name) VALUES ($1,$2,'CLOSE_TEST',$3)`, [
    roleId,
    tenantId,
    'Close test role',
  ]);
  // Memberships are what `assertUserOfTenant` reads when a snapshot names its
  // approver: an approval by somebody who cannot act in this tenant is not one.
  for (const id of Object.values(users)) {
    await pool.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role_id, organization_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [uuidv7(), tenantId, id, roleId, organizationId],
    );
  }

  const entities: Record<string, string> = {};
  for (const [key, code, name] of [
    [entityId, 'CLS', 'Close Entity'],
    [uuidv7(), 'VAC', 'Vacant Entity'],
  ] as const) {
    await pool.query(
      `INSERT INTO legal_entities
         (id, tenant_id, organization_id, code, legal_name, country_code, functional_currency,
          timezone, activated_at, posting_enabled)
       VALUES ($1,$2,$3,$4,$5,'US','USD','UTC',now(),true)`,
      [key, tenantId, organizationId, code, name],
    );
    entities[code] = key;
  }
  const vacantEntityId = entities.VAC!;

  const vacantBookId = uuidv7();
  for (const [id, entity] of [
    [bookId, entityId],
    [vacantBookId, vacantEntityId],
  ] as const) {
    await pool.query(
      `INSERT INTO accounting_books
         (id, tenant_id, legal_entity_id, code, name, base_currency, is_primary)
       VALUES ($1,$2,$3,'PRI','Primary','USD',true)`,
      [id, tenantId, entity],
    );
  }

  const vacantFiscalYearId = uuidv7();
  for (const [id, entity] of [
    [fiscalYearId, entityId],
    [vacantFiscalYearId, vacantEntityId],
  ] as const) {
    await pool.query(
      `INSERT INTO fiscal_years (id, tenant_id, legal_entity_id, name, start_date, end_date)
       VALUES ($1,$2,$3,'FY26','2026-01-01','2026-12-31')`,
      [id, tenantId, entity],
    );
  }

  const periodJan = uuidv7();
  const periodFeb = uuidv7();
  const vacantPeriodId = uuidv7();
  const periods: [string, string, string, number, string, string][] = [
    [periodJan, entityId, fiscalYearId, 1, 'JAN-26', '2026-01-01'],
    [periodFeb, entityId, fiscalYearId, 2, 'FEB-26', '2026-02-01'],
    [vacantPeriodId, vacantEntityId, vacantFiscalYearId, 1, 'JAN-26', '2026-01-01'],
  ];
  for (const [id, entity, fy, no, name, start] of periods) {
    await pool.query(
      `INSERT INTO accounting_periods
         (id, tenant_id, legal_entity_id, fiscal_year_id, period_no, name, start_date, end_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7::date,($7::date + interval '1 month - 1 day')::date)`,
      [id, tenantId, entity, fy, no, name, start],
    );
  }

  const arControlAccountId = uuidv7();
  const revenueAccountId = uuidv7();
  const cashAccountId = uuidv7();
  const chart: [string, string, string, string, string, boolean][] = [
    // The one control account of the entity: the required reconciliation of every
    // close run on this book, whether or not any template mentions it.
    [arControlAccountId, '1100', 'Accounts receivable', 'ASSET', 'DEBIT', true],
    [cashAccountId, '1000', 'Cash', 'ASSET', 'DEBIT', false],
    [revenueAccountId, '4000', 'Revenue', 'REVENUE', 'CREDIT', false],
  ];
  for (const [id, code, name, type, normal, control] of chart) {
    await pool.query(
      `INSERT INTO accounts
         (id, tenant_id, legal_entity_id, code, name, account_type, normal_balance, is_control)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, tenantId, entityId, code, name, type, normal, control],
    );
  }
  // The vacant entity has a chart with no control account and nothing opted in —
  // the state in which "all configured reconciliations are complete" is vacuously
  // true.
  await pool.query(
    `INSERT INTO accounts (id, tenant_id, legal_entity_id, code, name, account_type, normal_balance)
     VALUES ($1,$2,$3,'1000','Cash','ASSET','DEBIT')`,
    [uuidv7(), tenantId, vacantEntityId],
  );

  await pool.query(
    `INSERT INTO journals (id, tenant_id, legal_entity_id, accounting_book_id, code, name, journal_type)
     VALUES ($1,$2,$3,$4,'GJ','General journal','GENERAL')`,
    [journalId, tenantId, entityId, bookId],
  );

  await pool.query(
    `INSERT INTO close_checklist_templates (id, tenant_id, organization_id, code, name, cadence)
     VALUES ($1,$2,$3,'MONTHLY','Monthly close','MONTHLY')`,
    [templateId, tenantId, organizationId],
  );
  await pool.query(
    `INSERT INTO close_checklist_templates (id, tenant_id, organization_id, code, name, cadence)
     VALUES ($1,$2,$3,'EMPTY','Empty template','MONTHLY')`,
    [emptyTemplateId, tenantId, organizationId],
  );
  const templateTasks: [number, string, string, string, boolean, string | null][] = [
    [10, 'SUBLEDGER_CUTOFF', 'Cut off the subledgers', 'CUTOFF', true, null],
    [20, 'ACCRUALS', 'Post accruals and prepayments', 'ENTRY', true, 'SUBLEDGER_CUTOFF'],
    [30, 'FLUX_REVIEW', 'Review the flux analysis', 'REVIEW', false, null],
  ];
  for (const [sequence, code, name, type, required, dependsOn] of templateTasks) {
    await pool.query(
      `INSERT INTO close_checklist_template_tasks
         (id, tenant_id, template_id, sequence, code, name, task_type, required, depends_on_task_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [uuidv7(), tenantId, templateId, sequence, code, name, type, required, dependsOn],
    );
  }

  // 0053 (`assert_statement_snapshot_complete`): a PROFIT_LOSS or BALANCE_SHEET
  // snapshot must name the definition it was rendered from, and every posting
  // ACTIVE account in that statement's domain must roll up to one of its lines.
  // The two definitions below map this entity's chart completely — the assets
  // (1100, 1000) to the balance sheet, the revenue (4000) to the P&L.
  const balanceSheetDefinitionId = uuidv7();
  const profitLossDefinitionId = uuidv7();
  const definitions: [string, string, string, string, string[]][] = [
    [
      balanceSheetDefinitionId,
      'BS',
      'Balance sheet',
      'BALANCE_SHEET',
      [arControlAccountId, cashAccountId],
    ],
    [profitLossDefinitionId, 'PL', 'Profit and loss', 'PROFIT_LOSS', [revenueAccountId]],
  ];
  for (const [defId, code, name, reportType, accountIds] of definitions) {
    await pool.query(
      `INSERT INTO report_definitions
         (id, tenant_id, organization_id, legal_entity_id, code, name, report_type, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1)`,
      [defId, tenantId, organizationId, entityId, code, name, reportType],
    );
    const rowId = uuidv7();
    await pool.query(
      `INSERT INTO report_rows (id, tenant_id, report_definition_id, row_no, label, row_type)
       VALUES ($1,$2,$3,10,$4,'ACCOUNT_RANGE')`,
      [rowId, tenantId, defId, `${name} accounts`],
    );
    for (const accountId of accountIds) {
      await pool.query(
        `INSERT INTO statement_account_mappings
           (id, tenant_id, report_definition_id, legal_entity_id, account_id, report_row_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [uuidv7(), tenantId, defId, entityId, accountId, rowId],
      );
    }
  }

  const fixture: Fixture = {
    tenantId,
    organizationId,
    entityId,
    bookId,
    fiscalYearId,
    periodJan,
    periodFeb,
    arControlAccountId,
    revenueAccountId,
    cashAccountId,
    journalId,
    templateId,
    emptyTemplateId,
    balanceSheetDefinitionId,
    profitLossDefinitionId,
    users,
    vacantEntityId,
    vacantBookId,
    vacantPeriodId,
  };

  // One posted January journal: 1000 to the AR control account.
  await postJournal(pool, fixture, {
    periodId: periodJan,
    date: '2026-01-20',
    number: 'GJ-1',
    lines: [
      { accountId: arControlAccountId, debit: '1000.00', credit: '0' },
      { accountId: revenueAccountId, debit: '0', credit: '1000.00' },
    ],
  });

  return fixture;
}
