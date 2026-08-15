import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppError } from '@acct/domain';
import { uuidv7 } from '@acct/domain';
import { ApprovalWorkflowService } from '../workflows.service';
import { ApprovalEngine, assertApprovalSatisfied } from '../engine.service';
import { ApprovalTaskService } from '../tasks.service';
import {
  attemptPost,
  closeTestPool,
  createApprovalFixture,
  createDraftJournal,
  journalRow,
  setJournalApprovalThreshold,
  testPool,
  type ApprovalFixture,
} from './fixture';

/**
 * Phase 6's exit criterion: "Approval bypass attempts fail at API/domain layer."
 *
 * Every refusal here is provoked by the shortest route available, not by the
 * polite one. `attemptPost` is a bare UPDATE straight at `journal_entries` — no
 * service, no route, no permission check — because a bypass that goes through
 * the application is not a bypass. What refuses it is migration 0049's deferred
 * constraint trigger, firing at COMMIT.
 *
 * And every refusal has its matching acceptance, because a control that refuses
 * everything is an outage, not a control.
 */

const oneStep = (userId: string) => ({
  steps: [{ approvers: [{ resolved_from: 'NAMED_USER', user_id: userId }] }],
});

let workflows: ApprovalWorkflowService;
let engine: ApprovalEngine;
let tasks: ApprovalTaskService;

beforeAll(() => {
  workflows = new ApprovalWorkflowService(testPool());
  engine = new ApprovalEngine(testPool());
  tasks = new ApprovalTaskService(testPool());
});

afterAll(closeTestPool);

/** Runs the gate a posting path is meant to call, and returns the refusal. */
async function gate(fx: ApprovalFixture, journalId: string): Promise<AppError | null> {
  const client = await testPool().connect();
  try {
    await assertApprovalSatisfied(client, {
      tenantId: fx.tenantId,
      resourceType: 'JOURNAL',
      resourceId: journalId,
      action: 'posted',
    });
    return null;
  } catch (error) {
    return error as AppError;
  } finally {
    client.release();
  }
}

async function inboxTaskFor(
  actor: ApprovalFixture['approverA'],
  requestId: string,
): Promise<Record<string, unknown>> {
  const inbox = await tasks.listApprovalTasks(actor.principal, {});
  const found = (inbox.data as Array<Record<string, unknown>>).find(
    (t) => t['approval_request_id'] === requestId,
  );
  if (!found) throw new Error(`no inbox task for request ${requestId}`);
  return found;
}

// ---------------------------------------------------------------------------

describe('the threshold gate, with no engine involved', () => {
  let fx: ApprovalFixture;

  beforeAll(async () => {
    fx = await createApprovalFixture('gate');
    await setJournalApprovalThreshold(fx, '10000.00');
  }, 180_000);

  it('refuses a direct POSTED update on an unapproved journal at the threshold', async () => {
    const id = await createDraftJournal(fx, { amount: '10000.00', preparedBy: fx.preparer.userId });
    const attempt = await attemptPost(id, fx.preparer.userId, `JE-${uuidv7()}`);
    expect(attempt.posted).toBe(false);
    expect(attempt.message).toContain('APPROVAL_REQUIRED');
    // The refusal names both numbers, because AppError.details never reaches a caller.
    expect(attempt.message).toContain('10000.00');
  });

  it('posts a journal below the threshold with no approval at all', async () => {
    const id = await createDraftJournal(fx, { amount: '9999.99', preparedBy: fx.preparer.userId });
    const attempt = await attemptPost(id, fx.preparer.userId, `JE-${uuidv7()}`);
    expect(attempt.posted).toBe(true);
  });

  it('refuses an approval recorded by the preparer, at the database', async () => {
    const id = await createDraftJournal(fx, { amount: '25000.00', preparedBy: fx.preparer.userId });
    await expect(
      testPool().query(
        `UPDATE journal_entries SET approved_by = $2, approved_at = now() WHERE id = $1`,
        [id, fx.preparer.userId],
      ),
    ).rejects.toThrowError(/je_maker_checker/);
  });

  it('refuses an approval against an UNKNOWN preparer — the NULL case', async () => {
    // `approved_by <> created_by` against a NULL created_by is NULL, and a NULL
    // CHECK passes. 0049 wrote the constraint so it refuses instead; this is the
    // negative test for that specific case.
    const id = await createDraftJournal(fx, { amount: '25000.00', preparedBy: null });
    await expect(
      testPool().query(
        `UPDATE journal_entries SET approved_by = $2, approved_at = now() WHERE id = $1`,
        [id, fx.approverA.userId],
      ),
    ).rejects.toThrowError(/je_maker_checker/);
  });
});

// ---------------------------------------------------------------------------

describe('the engine end to end', () => {
  let fx: ApprovalFixture;

  beforeAll(async () => {
    fx = await createApprovalFixture('engine');
    await setJournalApprovalThreshold(fx, '10000.00');
    const created = await workflows.create(fx.admin.principal, {
      resourceType: 'JOURNAL',
      code: 'BIG',
      name: 'Large journals',
      legalEntityId: fx.legalEntityId,
      conditions: { min_amount: '10000.00' },
      definition: oneStep(fx.approverA.userId),
    });
    await workflows.publish(fx.admin.principal, created['id'] as string);
  }, 180_000);

  it('parks the document, refuses the post, then releases it on approval', async () => {
    const id = await createDraftJournal(fx, { amount: '25000.00', preparedBy: fx.preparer.userId });

    const raised = await engine.requestApproval(fx.preparer.principal, {
      resourceType: 'JOURNAL',
      resourceId: id,
    });
    expect(raised.required).toBe(true);
    const requestId = raised.required ? raised.requestId : '';

    // Parked: SUBMITTED with approval_state PENDING.
    expect(await journalRow(id)).toMatchObject({ status: 'SUBMITTED', approval_state: 'PENDING' });

    // Bypass 1 — post it anyway, straight at the table.
    const whilePending = await attemptPost(id, fx.preparer.userId, `JE-${uuidv7()}`);
    expect(whilePending.posted).toBe(false);
    expect(whilePending.message).toContain('APPROVAL_REQUIRED');

    // Bypass 2 — the gate a posting path calls.
    const refusedByGate = await gate(fx, id);
    expect(refusedByGate?.code).toBe('APPROVAL_REQUIRED');
    expect(refusedByGate?.message).toMatch(/waiting for approval/);

    // Bypass 3 — somebody who is not the resolved approver.
    const task = await inboxTaskFor(fx.approverA, requestId);
    await expect(
      tasks.approve(fx.approverB.principal, task['id'] as string, {}),
    ).rejects.toThrowError(/assigned to somebody else/);

    // Bypass 4 — the person who raised it.
    await expect(
      tasks.approve(fx.preparer.principal, task['id'] as string, {}),
    ).rejects.toThrowError(/approval.approve|assigned to somebody else/);

    // The accepting half.
    const decision = (await tasks.approve(fx.approverA.principal, task['id'] as string, {
      comment: 'checked against the contract',
    })) as Record<string, unknown>;
    expect(decision['request_status']).toBe('APPROVED');

    const after = await journalRow(id);
    expect(after).toMatchObject({ status: 'APPROVED', approval_state: 'APPROVED' });
    expect(after?.approved_by).toBe(fx.approverA.userId);

    expect(await gate(fx, id)).toBeNull();
    const posted = await attemptPost(id, fx.preparer.userId, `JE-${uuidv7()}`);
    expect(posted.posted).toBe(true);
  });

  it('refuses a document that falls under a workflow and was never submitted', async () => {
    // The bypass that needs no cleverness: do not ask the approval engine
    // anything. Without this clause the whole package is optional.
    const id = await createDraftJournal(fx, { amount: '30000.00', preparedBy: fx.preparer.userId });
    const refused = await gate(fx, id);
    expect(refused?.code).toBe('APPROVAL_REQUIRED');
    expect(refused?.message).toMatch(/no approval request has ever been raised/);
    expect(refused?.message).toContain('BIG');
  });

  it('permits a document no workflow governs', async () => {
    const id = await createDraftJournal(fx, { amount: '100.00', preparedBy: fx.preparer.userId });
    expect(await gate(fx, id)).toBeNull();
  });

  it('refuses the self-approval the workflow itself resolved to', async () => {
    // The step names approverA, and approverA also prepared the document. Every
    // check about WHO is assigned passes; what refuses is maker/checker.
    const id = await createDraftJournal(fx, {
      amount: '25000.00',
      preparedBy: fx.approverA.userId,
    });
    const raised = await engine.requestApproval(fx.approverA.principal, {
      resourceType: 'JOURNAL',
      resourceId: id,
    });
    const requestId = raised.required ? raised.requestId : '';
    const task = await inboxTaskFor(fx.approverA, requestId);

    let thrown: AppError | undefined;
    try {
      await tasks.approve(fx.approverA.principal, task['id'] as string, {});
    } catch (error) {
      thrown = error as AppError;
    }
    expect(thrown?.code).toBe('SEGREGATION_OF_DUTIES');
    expect(thrown?.message).toMatch(/you prepared/i);

    // Still parked, still unpostable.
    expect(await journalRow(id)).toMatchObject({ status: 'SUBMITTED' });
    expect((await attemptPost(id, fx.approverA.userId, `JE-${uuidv7()}`)).posted).toBe(false);
  });

  it('refuses an approval when the preparer is unknown', async () => {
    const id = await createDraftJournal(fx, { amount: '25000.00', preparedBy: null });
    const raised = await engine.requestApproval(fx.preparer.principal, {
      resourceType: 'JOURNAL',
      resourceId: id,
    });
    const task = await inboxTaskFor(fx.approverA, raised.required ? raised.requestId : '');
    await expect(
      tasks.approve(fx.approverA.principal, task['id'] as string, {}),
    ).rejects.toThrowError(/records no preparer/);
  });

  it('returns the document to DRAFT on rejection, and keeps it unpostable', async () => {
    const id = await createDraftJournal(fx, { amount: '25000.00', preparedBy: fx.preparer.userId });
    const raised = await engine.requestApproval(fx.preparer.principal, {
      resourceType: 'JOURNAL',
      resourceId: id,
    });
    const requestId = raised.required ? raised.requestId : '';
    const task = await inboxTaskFor(fx.approverA, requestId);

    await expect(
      tasks.reject(fx.approverA.principal, task['id'] as string, {}),
    ).rejects.toThrowError(/needs a reason/);

    const decision = (await tasks.reject(fx.approverA.principal, task['id'] as string, {
      comment: 'the counterparty is wrong',
    })) as Record<string, unknown>;
    expect(decision['request_status']).toBe('REJECTED');

    const after = await journalRow(id);
    expect(after).toMatchObject({ status: 'DRAFT', approval_state: 'REJECTED' });
    expect(after?.approved_by).toBeNull();

    const refused = await gate(fx, id);
    expect(refused?.message).toMatch(/was REJECTED/);
    expect((await attemptPost(id, fx.preparer.userId, `JE-${uuidv7()}`)).posted).toBe(false);
  });

  it('refuses to approve a document that was edited under the request', async () => {
    const id = await createDraftJournal(fx, { amount: '25000.00', preparedBy: fx.preparer.userId });
    const raised = await engine.requestApproval(fx.preparer.principal, {
      resourceType: 'JOURNAL',
      resourceId: id,
    });
    const requestId = raised.required ? raised.requestId : '';
    const task = await inboxTaskFor(fx.approverA, requestId);

    await testPool().query(`UPDATE journal_entries SET version = version + 1 WHERE id = $1`, [id]);

    await expect(
      tasks.approve(fx.approverA.principal, task['id'] as string, {}),
    ).rejects.toThrowError(/has been edited since approval was requested/);

    // Fail closed: still parked, still unpostable, and the request is still open
    // rather than silently cancelled by a statement the refusal rolled back.
    expect(await journalRow(id)).toMatchObject({ status: 'SUBMITTED' });
    expect((await attemptPost(id, fx.preparer.userId, `JE-${uuidv7()}`)).posted).toBe(false);

    // And the approver still has a way to clear it — refusing the rejection too
    // would leave the request unapprovable, unrejectable and permanent.
    const rejected = (await tasks.reject(fx.approverA.principal, task['id'] as string, {
      comment: 'changed after I was asked',
    })) as Record<string, unknown>;
    expect(rejected['request_status']).toBe('REJECTED');
    expect(await journalRow(id)).toMatchObject({ status: 'DRAFT' });
  });

  it('does not raise a second request for a document already awaiting one', async () => {
    const id = await createDraftJournal(fx, { amount: '25000.00', preparedBy: fx.preparer.userId });
    const first = await engine.requestApproval(fx.preparer.principal, {
      resourceType: 'JOURNAL',
      resourceId: id,
    });
    const second = await engine.requestApproval(fx.preparer.principal, {
      resourceType: 'JOURNAL',
      resourceId: id,
    });
    expect(first.required && second.required && second.requestId).toBe(
      first.required ? first.requestId : '',
    );
  });
});

// ---------------------------------------------------------------------------

describe('what the database does NOT stop', () => {
  let fx: ApprovalFixture;

  beforeAll(async () => {
    fx = await createApprovalFixture('nogate');
    await setJournalApprovalThreshold(fx, '10000.00');
    const created = await workflows.create(fx.admin.principal, {
      resourceType: 'JOURNAL',
      code: 'ANY',
      name: 'Every journal',
      legalEntityId: fx.legalEntityId,
      definition: oneStep(fx.approverA.userId),
    });
    await workflows.publish(fx.admin.principal, created['id'] as string);
  }, 180_000);

  /**
   * Recorded as a test rather than as a caveat in a document, because it is the
   * boundary of the claim this package can make.
   *
   * 0049's trigger is about the THRESHOLD. A workflow condition that is not the
   * threshold — an account, a vendor, a risk flag, or an amount below the
   * threshold — is enforced by `assertApprovalSatisfied` and by nothing else. So
   * until a posting path calls it, a small journal with an open approval request
   * can still be posted by a caller who goes straight at the table.
   */
  it('a small journal with an OPEN request is still postable by a direct UPDATE', async () => {
    const id = await createDraftJournal(fx, { amount: '500.00', preparedBy: fx.preparer.userId });
    const raised = await engine.requestApproval(fx.preparer.principal, {
      resourceType: 'JOURNAL',
      resourceId: id,
    });
    expect(raised.required).toBe(true);

    const refusedByGate = await gate(fx, id);
    expect(refusedByGate?.code).toBe('APPROVAL_REQUIRED');

    const attempt = await attemptPost(id, fx.preparer.userId, `JE-${uuidv7()}`);
    expect(attempt.posted).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('serial ordering', () => {
  let fx: ApprovalFixture;
  let requestId: string;

  beforeAll(async () => {
    fx = await createApprovalFixture('serial');
    await setJournalApprovalThreshold(fx, '10000.00');
    const created = await workflows.create(fx.admin.principal, {
      resourceType: 'JOURNAL',
      code: 'TWOSTEP',
      name: 'Two step',
      legalEntityId: fx.legalEntityId,
      definition: {
        steps: [
          { approvers: [{ resolved_from: 'NAMED_USER', user_id: fx.approverA.userId }] },
          { approvers: [{ resolved_from: 'NAMED_USER', user_id: fx.approverB.userId }] },
        ],
      },
    });
    await workflows.publish(fx.admin.principal, created['id'] as string);

    const id = await createDraftJournal(fx, { amount: '25000.00', preparedBy: fx.preparer.userId });
    const raised = await engine.requestApproval(fx.preparer.principal, {
      resourceType: 'JOURNAL',
      resourceId: id,
    });
    requestId = raised.required ? raised.requestId : '';
  }, 180_000);

  it('shows the later step to nobody until it is active', async () => {
    const inbox = await tasks.listApprovalTasks(fx.approverB.principal, {});
    expect(
      (inbox.data as Array<Record<string, unknown>>).filter(
        (t) => t['approval_request_id'] === requestId,
      ),
    ).toHaveLength(0);
  });

  it('refuses the second step while the first is pending', async () => {
    const all = await tasks.listApprovalTasks(fx.admin.principal, { requestId });
    const second = (all.data as Array<Record<string, unknown>>).find((t) => t['step_no'] === 2);
    await expect(
      tasks.approve(fx.approverB.principal, second!['id'] as string, {}),
    ).rejects.toThrowError(/not the step awaiting a decision/);
  });

  it('activates the second step once the first is approved, and completes on both', async () => {
    const first = await inboxTaskFor(fx.approverA, requestId);
    const afterFirst = (await tasks.approve(fx.approverA.principal, first['id'] as string, {
      comment: 'step one',
    })) as Record<string, unknown>;
    expect(afterFirst['request_status']).toBe('PENDING');
    expect(afterFirst['next_step_no']).toBe(2);

    const second = await inboxTaskFor(fx.approverB, requestId);
    const afterSecond = (await tasks.approve(fx.approverB.principal, second['id'] as string, {
      comment: 'step two',
    })) as Record<string, unknown>;
    expect(afterSecond['request_status']).toBe('APPROVED');
    expect((afterSecond['approvers'] as string[]).sort()).toEqual(
      [fx.approverA.userId, fx.approverB.userId].sort(),
    );
  });

  it('records actor, timestamp, comment and session on every decision', async () => {
    const { rows } = await testPool().query<{
      n: string;
      with_session: string;
    }>(
      `SELECT count(*)::text AS n,
              count(session_id)::text AS with_session
         FROM approval_steps
        WHERE approval_request_id = $1 AND decided_by IS NOT NULL
          AND decided_at IS NOT NULL AND decision_reason IS NOT NULL`,
      [requestId],
    );
    expect(rows[0]?.n).toBe('2');
    expect(rows[0]?.with_session).toBe('2');
  });
});

// ---------------------------------------------------------------------------

describe('one person cannot satisfy two steps', () => {
  let fx: ApprovalFixture;

  beforeAll(async () => {
    fx = await createApprovalFixture('sameperson');
    await setJournalApprovalThreshold(fx, '10000.00');
    const created = await workflows.create(fx.admin.principal, {
      resourceType: 'JOURNAL',
      code: 'SAMEPERSON',
      name: 'Two steps, one name',
      legalEntityId: fx.legalEntityId,
      definition: {
        steps: [
          { approvers: [{ resolved_from: 'NAMED_USER', user_id: fx.approverA.userId }] },
          { approvers: [{ resolved_from: 'NAMED_USER', user_id: fx.approverA.userId }] },
        ],
      },
    });
    await workflows.publish(fx.admin.principal, created['id'] as string);
  }, 180_000);

  it('refuses the second step to the person who approved the first', async () => {
    // A two-step approval one person can complete alone is a one-step approval
    // with a longer audit trail.
    const id = await createDraftJournal(fx, { amount: '25000.00', preparedBy: fx.preparer.userId });
    const raised = await engine.requestApproval(fx.preparer.principal, {
      resourceType: 'JOURNAL',
      resourceId: id,
    });
    const requestId = raised.required ? raised.requestId : '';

    const first = await inboxTaskFor(fx.approverA, requestId);
    await tasks.approve(fx.approverA.principal, first['id'] as string, { comment: 'one' });

    const second = await inboxTaskFor(fx.approverA, requestId);
    let thrown: AppError | undefined;
    try {
      await tasks.approve(fx.approverA.principal, second['id'] as string, { comment: 'two' });
    } catch (error) {
      thrown = error as AppError;
    }
    expect(thrown?.code).toBe('SEGREGATION_OF_DUTIES');
    expect(thrown?.message).toMatch(/already approved/);

    expect(await journalRow(id)).toMatchObject({ status: 'SUBMITTED' });
    expect((await attemptPost(id, fx.preparer.userId, `JE-${uuidv7()}`)).posted).toBe(false);
  });

  it('accepts it when the workflow says approvers need not be distinct', async () => {
    const created = await workflows.create(fx.admin.principal, {
      resourceType: 'JOURNAL',
      code: 'SAMEPERSON',
      name: 'Two steps, one name, allowed',
      legalEntityId: fx.legalEntityId,
      definition: {
        steps: [
          { approvers: [{ resolved_from: 'NAMED_USER', user_id: fx.approverA.userId }] },
          { approvers: [{ resolved_from: 'NAMED_USER', user_id: fx.approverA.userId }] },
        ],
        require_distinct_approvers: false,
      },
    });
    await workflows.publish(fx.admin.principal, created['id'] as string);

    const id = await createDraftJournal(fx, { amount: '25000.00', preparedBy: fx.preparer.userId });
    const raised = await engine.requestApproval(fx.preparer.principal, {
      resourceType: 'JOURNAL',
      resourceId: id,
    });
    const requestId = raised.required ? raised.requestId : '';
    expect(raised.required && raised.workflowVersion).toBe(2);

    const first = await inboxTaskFor(fx.approverA, requestId);
    await tasks.approve(fx.approverA.principal, first['id'] as string, { comment: 'one' });
    const second = await inboxTaskFor(fx.approverA, requestId);
    const done = (await tasks.approve(fx.approverA.principal, second['id'] as string, {
      comment: 'two',
    })) as Record<string, unknown>;
    expect(done['request_status']).toBe('APPROVED');
  });
});

// ---------------------------------------------------------------------------

describe('parallel approval is deterministic', () => {
  let fx: ApprovalFixture;

  beforeAll(async () => {
    fx = await createApprovalFixture('parallel');
    await setJournalApprovalThreshold(fx, '10000.00');
    const created = await workflows.create(fx.admin.principal, {
      resourceType: 'JOURNAL',
      code: 'TWOOFTHREE',
      name: 'Two of three',
      legalEntityId: fx.legalEntityId,
      definition: {
        steps: [
          {
            mode: 'PARALLEL',
            quorum: 2,
            approvers: [
              { resolved_from: 'NAMED_USER', user_id: fx.approverA.userId },
              { resolved_from: 'NAMED_USER', user_id: fx.approverB.userId },
              { resolved_from: 'NAMED_USER', user_id: fx.approverC.userId },
            ],
          },
        ],
      },
    });
    await workflows.publish(fx.admin.principal, created['id'] as string);
  }, 180_000);

  it('completes at the quorum and closes the outstanding slot', async () => {
    const id = await createDraftJournal(fx, { amount: '25000.00', preparedBy: fx.preparer.userId });
    const raised = await engine.requestApproval(fx.preparer.principal, {
      resourceType: 'JOURNAL',
      resourceId: id,
    });
    const requestId = raised.required ? raised.requestId : '';

    const a = await inboxTaskFor(fx.approverA, requestId);
    const first = (await tasks.approve(fx.approverA.principal, a['id'] as string, {})) as Record<
      string,
      unknown
    >;
    expect(first['request_status']).toBe('PENDING');
    expect(first['approvals']).toBe(1);
    expect(first['quorum']).toBe(2);
    expect((await journalRow(id))?.status).toBe('SUBMITTED');

    const b = await inboxTaskFor(fx.approverB, requestId);
    const second = (await tasks.approve(fx.approverB.principal, b['id'] as string, {})) as Record<
      string,
      unknown
    >;
    expect(second['request_status']).toBe('APPROVED');

    // The third approver's slot and inbox item are closed, not left dangling.
    const { rows } = await testPool().query<{ status: string }>(
      `SELECT s.status::text AS status FROM approval_steps s
        WHERE s.approval_request_id = $1 AND s.approver_user_id = $2`,
      [requestId, fx.approverC.userId],
    );
    expect(rows[0]?.status).toBe('CANCELLED');
    const cInbox = await tasks.listApprovalTasks(fx.approverC.principal, {});
    expect(
      (cInbox.data as Array<Record<string, unknown>>).filter(
        (t) => t['approval_request_id'] === requestId,
      ),
    ).toHaveLength(0);
  });

  it('lets one rejection end the request whatever else was approved', async () => {
    const id = await createDraftJournal(fx, { amount: '26000.00', preparedBy: fx.preparer.userId });
    const raised = await engine.requestApproval(fx.preparer.principal, {
      resourceType: 'JOURNAL',
      resourceId: id,
    });
    const requestId = raised.required ? raised.requestId : '';

    const a = await inboxTaskFor(fx.approverA, requestId);
    await tasks.approve(fx.approverA.principal, a['id'] as string, {});
    const b = await inboxTaskFor(fx.approverB, requestId);
    const rejected = (await tasks.reject(fx.approverB.principal, b['id'] as string, {
      comment: 'no',
    })) as Record<string, unknown>;
    expect(rejected['request_status']).toBe('REJECTED');
    expect(await journalRow(id)).toMatchObject({ status: 'DRAFT', approval_state: 'REJECTED' });
  });
});

// ---------------------------------------------------------------------------

describe('expiry fails closed, and escalation is the way out', () => {
  let fx: ApprovalFixture;
  let journalId: string;
  let requestId: string;

  beforeAll(async () => {
    fx = await createApprovalFixture('expiry');
    await setJournalApprovalThreshold(fx, '10000.00');
    const created = await workflows.create(fx.admin.principal, {
      resourceType: 'JOURNAL',
      code: 'EXPIRES',
      name: 'Expires',
      legalEntityId: fx.legalEntityId,
      definition: {
        steps: [
          {
            approvers: [{ resolved_from: 'NAMED_USER', user_id: fx.approverA.userId }],
            expires_after_hours: 24,
            on_expiry: 'ESCALATE',
          },
        ],
      },
    });
    await workflows.publish(fx.admin.principal, created['id'] as string);

    journalId = await createDraftJournal(fx, {
      amount: '25000.00',
      preparedBy: fx.preparer.userId,
    });
    const raised = await engine.requestApproval(fx.preparer.principal, {
      resourceType: 'JOURNAL',
      resourceId: journalId,
    });
    requestId = raised.required ? raised.requestId : '';

    // Time travel. The clock is the only thing being simulated; everything the
    // engine then does is real.
    await testPool().query(
      `UPDATE approval_steps SET expires_at = now() - interval '1 hour'
        WHERE approval_request_id = $1`,
      [requestId],
    );
  }, 180_000);

  it('refuses a decision on an expired task', async () => {
    const all = await tasks.listApprovalTasks(fx.admin.principal, { requestId });
    const step = (all.data as Array<Record<string, unknown>>)[0]!;
    expect(step['is_expired']).toBe(true);
    await expect(
      tasks.approve(fx.approverA.principal, step['id'] as string, {}),
    ).rejects.toThrowError(/expired .* and can no longer be decided/s);
  });

  it('leaves the request pending and the document unpostable — it did not approve itself', async () => {
    const { rows } = await testPool().query<{ status: string }>(
      `SELECT status::text AS status FROM approval_requests WHERE id = $1`,
      [requestId],
    );
    expect(rows[0]?.status).toBe('PENDING');
    expect(await journalRow(journalId)).toMatchObject({ status: 'SUBMITTED' });
    expect((await attemptPost(journalId, fx.preparer.userId, `JE-${uuidv7()}`)).posted).toBe(false);
  });

  it('escalates to another human rather than to an approval', async () => {
    await testPool().query(
      `INSERT INTO escalation_rules
         (id, tenant_id, approval_workflow_id, after_interval, action, target_user_id)
       SELECT gen_random_uuid(), $1, r.approval_workflow_id, interval '0 seconds',
              'ADD_APPROVER', $2
         FROM approval_requests r WHERE r.id = $3`,
      [fx.tenantId, fx.approverB.userId, requestId],
    );

    const swept = await engine.sweepExpirations(fx.admin.principal, {});
    expect(swept.escalated.map((e) => e.action)).toContain('ADD_APPROVER');

    // Still not approved by the sweep — a second person now has the task.
    const { rows } = await testPool().query<{ status: string }>(
      `SELECT status::text AS status FROM approval_requests WHERE id = $1`,
      [requestId],
    );
    expect(rows[0]?.status).toBe('PENDING');

    const task = await inboxTaskFor(fx.approverB, requestId);
    const decision = (await tasks.approve(fx.approverB.principal, task['id'] as string, {
      comment: 'covering the expired step',
    })) as Record<string, unknown>;
    expect(decision['request_status']).toBe('APPROVED');
    expect((await journalRow(journalId))?.approved_by).toBe(fx.approverB.userId);
    expect((await attemptPost(journalId, fx.preparer.userId, `JE-${uuidv7()}`)).posted).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("delegation carries the delegator's authority", () => {
  let fx: ApprovalFixture;

  beforeAll(async () => {
    fx = await createApprovalFixture('delegate');
    await setJournalApprovalThreshold(fx, '10000.00');
    const created = await workflows.create(fx.admin.principal, {
      resourceType: 'JOURNAL',
      code: 'DELEG',
      name: 'Delegable',
      legalEntityId: fx.legalEntityId,
      definition: oneStep(fx.approverA.userId),
    });
    await workflows.publish(fx.admin.principal, created['id'] as string);
  }, 180_000);

  async function raise(amount: string): Promise<{ requestId: string; journalId: string }> {
    const journalId = await createDraftJournal(fx, { amount, preparedBy: fx.preparer.userId });
    const raised = await engine.requestApproval(fx.preparer.principal, {
      resourceType: 'JOURNAL',
      resourceId: journalId,
    });
    return { requestId: raised.required ? raised.requestId : '', journalId };
  }

  it('refuses a delegate to whom nothing has been delegated', async () => {
    const { requestId } = await raise('25000.00');
    const task = await inboxTaskFor(fx.approverA, requestId);
    await expect(
      tasks.approve(fx.approverB.principal, task['id'] as string, {}),
    ).rejects.toThrowError(/no delegation from that approver names you/);
  });

  it('refuses delegating to the person who prepared the document', async () => {
    const { requestId } = await raise('25000.00');
    const task = await inboxTaskFor(fx.approverA, requestId);
    await expect(
      tasks.delegate(fx.approverA.principal, task['id'] as string, {
        delegateUserId: fx.preparer.userId,
        reason: 'holiday',
      }),
    ).rejects.toThrowError(/Delegation cannot violate segregation of duties/);
  });

  it('refuses delegating to somebody without approval.approve', async () => {
    const { requestId } = await raise('25000.00');
    const task = await inboxTaskFor(fx.approverA, requestId);
    await expect(
      tasks.delegate(fx.approverA.principal, task['id'] as string, {
        delegateUserId: fx.clerk.userId,
        reason: 'holiday',
      }),
    ).rejects.toThrowError(/does not hold approval.approve/);
  });

  it("lets the delegate decide, on the delegator's authority, within the cap", async () => {
    const { requestId, journalId } = await raise('25000.00');
    const task = await inboxTaskFor(fx.approverA, requestId);

    const delegation = (await tasks.delegate(fx.approverA.principal, task['id'] as string, {
      delegateUserId: fx.approverB.userId,
      reason: 'on leave',
      maxAmount: '30000.00',
    })) as Record<string, unknown>;
    expect(delegation['authority_of']).toBe(fx.approverA.userId);

    // The task moved; the step did not. `approver_user_id` is still the
    // delegator, which is what records whose authority is being exercised.
    const moved = await inboxTaskFor(fx.approverB, requestId);
    expect(moved['approver_user_id']).toBe(fx.approverA.userId);

    const decision = (await tasks.approve(fx.approverB.principal, moved['id'] as string, {
      comment: 'covering',
    })) as Record<string, unknown>;
    expect(decision['request_status']).toBe('APPROVED');

    const { rows } = await testPool().query<{ approver: string; decided_by: string }>(
      `SELECT approver_user_id AS approver, decided_by FROM approval_steps
        WHERE approval_request_id = $1`,
      [requestId],
    );
    expect(rows[0]?.approver).toBe(fx.approverA.userId);
    expect(rows[0]?.decided_by).toBe(fx.approverB.userId);
    expect((await journalRow(journalId))?.approved_by).toBe(fx.approverB.userId);
  });

  it("refuses the delegate above the delegation's cap, exactly", async () => {
    const { requestId } = await raise('30000.01');
    const task = await inboxTaskFor(fx.approverA, requestId);
    // The delegation from the previous test is still in force (30,000 cap).
    await expect(
      tasks.approve(fx.approverB.principal, task['id'] as string, {}),
    ).rejects.toThrowError(/capped at 30000.00/);
  });

  it('leaves the delegator able to act', async () => {
    const { requestId } = await raise('40000.00');
    const task = await inboxTaskFor(fx.approverA, requestId);
    const decision = (await tasks.approve(fx.approverA.principal, task['id'] as string, {
      comment: 'back early',
    })) as Record<string, unknown>;
    expect(decision['request_status']).toBe('APPROVED');
  });

  it('refuses a second, conflicting delegation of the same scope', async () => {
    const { requestId } = await raise('25000.00');
    const task = await inboxTaskFor(fx.approverA, requestId);
    await expect(
      tasks.delegate(fx.approverA.principal, task['id'] as string, {
        delegateUserId: fx.approverC.userId,
        reason: 'also away',
      }),
    ).rejects.toThrowError(/already have an active delegation/);
  });
});

// ---------------------------------------------------------------------------

describe('the unified inbox', () => {
  let fx: ApprovalFixture;
  let requestId: string;

  beforeAll(async () => {
    fx = await createApprovalFixture('inbox');
    const created = await workflows.create(fx.admin.principal, {
      resourceType: 'JOURNAL',
      code: 'INBOX',
      name: 'Inbox',
      legalEntityId: fx.legalEntityId,
      definition: oneStep(fx.approverA.userId),
    });
    await workflows.publish(fx.admin.principal, created['id'] as string);
    const journalId = await createDraftJournal(fx, {
      amount: '4000.00',
      preparedBy: fx.preparer.userId,
    });
    const raised = await engine.requestApproval(fx.preparer.principal, {
      resourceType: 'JOURNAL',
      resourceId: journalId,
    });
    requestId = raised.required ? raised.requestId : '';
  }, 180_000);

  it("puts the approval in the resolved approver's task list", async () => {
    const listed = await tasks.listTasks(fx.approverA.principal, {});
    const mine = (listed.data as Array<Record<string, unknown>>).filter(
      (t) => t['source_type'] === 'APPROVAL',
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]!['title']).toMatch(/Approve journal/);
  });

  it('refuses to complete an approval task by marking it done', async () => {
    const listed = await tasks.listTasks(fx.approverA.principal, {});
    const approvalTask = (listed.data as Array<Record<string, unknown>>).find(
      (t) => t['source_type'] === 'APPROVAL',
    )!;
    let thrown: AppError | undefined;
    try {
      await tasks.completeTask(fx.approverA.principal, approvalTask['id'] as string, {});
    } catch (error) {
      thrown = error as AppError;
    }
    expect(thrown?.code).toBe('APPROVAL_REQUIRED');
    expect(thrown?.message).toMatch(/completed by deciding it/);
  });

  it('completes an ordinary task — the other half', async () => {
    const id = uuidv7();
    await testPool().query(
      `INSERT INTO tasks (id, tenant_id, legal_entity_id, source_type, title, owner_user_id)
       VALUES ($1,$2,$3,'CLOSE','Reconcile suspense',$4)`,
      [id, fx.tenantId, fx.legalEntityId, fx.approverA.userId],
    );
    const done = (await tasks.completeTask(fx.approverA.principal, id, {
      note: 'agreed to the bank',
    })) as Record<string, unknown>;
    expect(done['status']).toBe('COMPLETED');
    expect(done['completed_by']).toBe(fx.approverA.userId);
  });

  it('does not show another tenant the task, or let them decide it', async () => {
    const other = await createApprovalFixture('inbox-other');
    const theirs = await tasks.listApprovalTasks(other.approverA.principal, {});
    expect(theirs.data).toHaveLength(0);

    const mine = await tasks.listApprovalTasks(fx.approverA.principal, {});
    const stepId = (mine.data as Array<Record<string, unknown>>)[0]!['id'] as string;
    await expect(tasks.approve(other.approverA.principal, stepId, {})).rejects.toThrowError(
      /was not found/,
    );
  });

  it('returns the whole decision history for a request', async () => {
    const history = await tasks.listApprovalTasks(fx.admin.principal, { requestId });
    expect((history.data as unknown[]).length).toBeGreaterThan(0);
    const row = (history.data as Array<Record<string, unknown>>)[0]!;
    expect(row['workflow_code']).toBe('INBOX');
    // Exact decimal text out of the snapshot, never a JSON number.
    expect(row['amount']).toBe('4000.00000000');
  });
});
