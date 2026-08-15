import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalWorkflowService } from '../workflows.service';
import { ApprovalEngine } from '../engine.service';
import { ApprovalTaskService } from '../tasks.service';
import {
  closeTestPool,
  createApprovalFixture,
  createDraftJournal,
  testPool,
  type ApprovalFixture,
} from './fixture';

/**
 * Versioned definitions, against a real PostgreSQL.
 *
 * The claims here are claims about the SCHEMA as much as about the service — the
 * exclusion constraint, the immutability trigger, the snapshot — so a mock would
 * prove none of them.
 *
 * Each group gets its OWN tenant. A published workflow with no conditions
 * matches every document in its tenant, so two groups sharing a tenant would
 * each be measuring the other's workflows, and "no workflow applied" could never
 * be observed.
 */
const oneStep = (userId: string) => ({
  steps: [{ approvers: [{ resolved_from: 'NAMED_USER', user_id: userId }] }],
});

afterAll(closeTestPool);

describe('a monetary condition survives jsonb', () => {
  let fx: ApprovalFixture;
  let workflows: ApprovalWorkflowService;

  beforeAll(async () => {
    fx = await createApprovalFixture('wf-money');
    workflows = new ApprovalWorkflowService(testPool());
  }, 180_000);

  it('keeps a value no double can hold, exactly, through the database and back', async () => {
    // If the read path went through JSON.parse — which is how node-postgres
    // delivers a jsonb column — this would return as 9007199254740992, and the
    // workflow would apply to documents it was never meant to.
    const exact = '9007199254740993.01';
    const created = await workflows.create(fx.admin.principal, {
      resourceType: 'JOURNAL',
      code: 'EXACT',
      name: 'Exactness',
      legalEntityId: fx.legalEntityId,
      conditions: { min_amount: exact },
      definition: oneStep(fx.approverA.userId),
    });
    expect((created['conditions'] as Record<string, unknown>)['min_amount']).toBe(exact);

    const listed = await workflows.list(fx.admin.principal, { code: 'EXACT' });
    const row = listed.data[0] as Record<string, unknown>;
    expect((row['conditions'] as Record<string, unknown>)['min_amount']).toBe(exact);

    // What is on disk is a JSON string, so nothing downstream can round it either.
    const { rows } = await testPool().query<{ kind: string; text: string }>(
      `SELECT jsonb_typeof(conditions -> 'min_amount') AS kind,
              conditions ->> 'min_amount' AS text
         FROM approval_workflows WHERE id = $1`,
      [created['id'] as string],
    );
    expect(rows[0]?.kind).toBe('string');
    expect(rows[0]?.text).toBe(exact);
  });

  it('refuses a monetary condition supplied as a JSON number', async () => {
    await expect(
      workflows.create(fx.admin.principal, {
        resourceType: 'JOURNAL',
        code: 'FLOATY',
        name: 'Floaty',
        legalEntityId: fx.legalEntityId,
        conditions: { min_amount: 10000.55 },
        definition: oneStep(fx.approverA.userId),
      }),
    ).rejects.toThrowError(/decimal strings/);
  });
});

describe('publication', () => {
  let fx: ApprovalFixture;
  let other: ApprovalFixture;
  let workflows: ApprovalWorkflowService;

  beforeAll(async () => {
    fx = await createApprovalFixture('wf-publish');
    other = await createApprovalFixture('wf-publish-other');
    workflows = new ApprovalWorkflowService(testPool());
  }, 180_000);

  it('publishes a step whose role somebody actually holds', async () => {
    const created = await workflows.create(fx.admin.principal, {
      resourceType: 'INVOICE',
      code: 'ROLEBASED',
      name: 'Role based',
      legalEntityId: fx.legalEntityId,
      definition: {
        steps: [{ approvers: [{ resolved_from: 'ROLE', role_id: fx.roles.approver }] }],
      },
    });
    const published = await workflows.publish(fx.admin.principal, created['id'] as string);
    expect(published['status']).toBe('PUBLISHED');
  });

  it('refuses to publish a step that resolves to nobody', async () => {
    const { rows } = await testPool().query<{ id: string }>(
      `INSERT INTO roles (id, tenant_id, code, name)
       VALUES (gen_random_uuid(), $1, 'nobody', 'Nobody') RETURNING id`,
      [fx.tenantId],
    );
    const orphan = await workflows.create(fx.admin.principal, {
      resourceType: 'INVOICE',
      code: 'GHOST',
      name: 'Ghost approvers',
      legalEntityId: fx.legalEntityId,
      definition: { steps: [{ approvers: [{ resolved_from: 'ROLE', role_id: rows[0]!.id }] }] },
    });
    await expect(
      workflows.publish(fx.admin.principal, orphan['id'] as string),
    ).rejects.toThrowError(/nobody holds/);
  });

  it('refuses to publish a step naming a user from another tenant', async () => {
    const created = await workflows.create(fx.admin.principal, {
      resourceType: 'INVOICE',
      code: 'FOREIGN',
      name: 'Foreign approver',
      legalEntityId: fx.legalEntityId,
      definition: oneStep(other.approverA.userId),
    });
    await expect(
      workflows.publish(fx.admin.principal, created['id'] as string),
    ).rejects.toThrowError(/no active membership in this tenant/);
  });

  it('refuses a caller without workflow.manage', async () => {
    await expect(
      workflows.create(fx.approverA.principal, {
        resourceType: 'INVOICE',
        code: 'NOPERM',
        name: 'No permission',
        legalEntityId: fx.legalEntityId,
        definition: oneStep(fx.approverA.userId),
      }),
    ).rejects.toThrowError(/workflow.manage/);
  });

  it('is idempotent — publishing twice answers the same thing', async () => {
    const created = await workflows.create(fx.admin.principal, {
      resourceType: 'INVOICE',
      code: 'TWICE',
      name: 'Twice',
      legalEntityId: fx.legalEntityId,
      definition: oneStep(fx.approverA.userId),
    });
    const first = await workflows.publish(fx.admin.principal, created['id'] as string);
    const second = await workflows.publish(fx.admin.principal, created['id'] as string);
    expect(second['published_at']).toEqual(first['published_at']);
  });

  it("does not leak another tenant's workflows into the list", async () => {
    const listed = await workflows.list(other.admin.principal, {});
    expect(listed.data).toHaveLength(0);
  });
});

describe('republishing under a pending approval', () => {
  let fx: ApprovalFixture;
  let workflows: ApprovalWorkflowService;
  let engine: ApprovalEngine;
  let tasks: ApprovalTaskService;
  let requestId: string;

  beforeAll(async () => {
    fx = await createApprovalFixture('wf-inflight');
    workflows = new ApprovalWorkflowService(testPool());
    engine = new ApprovalEngine(testPool());
    tasks = new ApprovalTaskService(testPool());
  }, 180_000);

  it('leaves the running instance on the version it started with', async () => {
    const v1 = await workflows.create(fx.admin.principal, {
      resourceType: 'JOURNAL',
      code: 'INFLIGHT',
      name: 'In flight',
      legalEntityId: fx.legalEntityId,
      conditions: { min_amount: '1000.00' },
      definition: oneStep(fx.approverA.userId),
    });
    await workflows.publish(fx.admin.principal, v1['id'] as string);

    const journalId = await createDraftJournal(fx, {
      amount: '5000.00',
      preparedBy: fx.preparer.userId,
      description: 'in flight',
    });
    const raised = await engine.requestApproval(fx.preparer.principal, {
      resourceType: 'JOURNAL',
      resourceId: journalId,
    });
    expect(raised.required).toBe(true);
    requestId = raised.required ? raised.requestId : '';

    // Version 2 demands TWO approvals instead of one. If a running instance read
    // the table rather than its snapshot, this pending request would silently
    // acquire a second step — and the approval already collected would be judged
    // by rules that did not exist when it was given.
    const v2 = await workflows.create(fx.admin.principal, {
      resourceType: 'JOURNAL',
      code: 'INFLIGHT',
      name: 'In flight v2',
      legalEntityId: fx.legalEntityId,
      conditions: { min_amount: '1000.00' },
      definition: {
        steps: [
          { approvers: [{ resolved_from: 'NAMED_USER', user_id: fx.approverA.userId }] },
          { approvers: [{ resolved_from: 'NAMED_USER', user_id: fx.approverB.userId }] },
        ],
      },
    });
    const published = await workflows.publish(fx.admin.principal, v2['id'] as string);
    expect(published['version']).toBe(2);
    expect(published['superseded_versions']).toBe(1);

    const { rows: versions } = await testPool().query<{
      version: number;
      valid_to: string | null;
    }>(
      `SELECT version, valid_to::text AS valid_to FROM approval_workflows
        WHERE tenant_id = $1 AND code = 'INFLIGHT' ORDER BY version`,
      [fx.tenantId],
    );
    expect(versions[0]?.valid_to).not.toBeNull();
    expect(versions[1]?.valid_to).toBeNull();

    const { rows: instance } = await testPool().query<{
      workflow_version: number;
      steps: string;
      snapshot_steps: string;
    }>(
      `SELECT r.workflow_version,
              (SELECT count(*)::text FROM approval_steps s
                WHERE s.approval_request_id = r.id) AS steps,
              jsonb_array_length(r.snapshot -> 'workflow' -> 'definition' -> 'steps')::text
                AS snapshot_steps
         FROM approval_requests r WHERE r.id = $1`,
      [requestId],
    );
    expect(instance[0]?.workflow_version).toBe(1);
    expect(instance[0]?.steps).toBe('1');
    expect(instance[0]?.snapshot_steps).toBe('1');

    // And approving that one step still completes it.
    const inbox = await tasks.listApprovalTasks(fx.approverA.principal, {});
    const task = (inbox.data as Array<Record<string, unknown>>).find(
      (t) => t['approval_request_id'] === requestId,
    );
    expect(task).toBeTruthy();
    const decision = (await tasks.approve(fx.approverA.principal, task!['id'] as string, {
      comment: 'fine',
    })) as Record<string, unknown>;
    expect(decision['request_status']).toBe('APPROVED');
  });

  it('a new request raised now gets the new version, with both steps', async () => {
    // The other half: v2 governs everything raised after the publish, so the
    // republish is not merely ignored.
    const journalId = await createDraftJournal(fx, {
      amount: '5000.00',
      preparedBy: fx.preparer.userId,
      description: 'after republish',
    });
    const raised = await engine.requestApproval(fx.preparer.principal, {
      resourceType: 'JOURNAL',
      resourceId: journalId,
    });
    expect(raised.required && raised.workflowVersion).toBe(2);
    expect(raised.required && raised.steps).toBe(2);
  });

  it('refuses to change a published definition, at the database', async () => {
    const { rows } = await testPool().query<{ id: string }>(
      `SELECT id FROM approval_workflows
        WHERE tenant_id = $1 AND code = 'INFLIGHT' AND version = 1`,
      [fx.tenantId],
    );
    await expect(
      testPool().query(
        `UPDATE approval_workflows SET definition = '{"steps":[]}'::jsonb WHERE id = $1`,
        [rows[0]!.id],
      ),
    ).rejects.toThrowError(/WORKFLOW_PUBLISHED/);
  });
});

describe('conditions decide whether a workflow applies at all', () => {
  let fx: ApprovalFixture;
  let engine: ApprovalEngine;

  beforeAll(async () => {
    fx = await createApprovalFixture('wf-conditions');
    const workflows = new ApprovalWorkflowService(testPool());
    engine = new ApprovalEngine(testPool());
    const created = await workflows.create(fx.admin.principal, {
      resourceType: 'JOURNAL',
      code: 'BANDED',
      name: 'Over ten thousand',
      legalEntityId: fx.legalEntityId,
      conditions: { min_amount: '10000.00', currencies: ['USD'] },
      definition: oneStep(fx.approverA.userId),
    });
    await workflows.publish(fx.admin.principal, created['id'] as string);
  }, 180_000);

  it('applies exactly at the boundary', async () => {
    const id = await createDraftJournal(fx, { amount: '10000.00', preparedBy: fx.preparer.userId });
    const raised = await engine.requestApproval(fx.preparer.principal, {
      resourceType: 'JOURNAL',
      resourceId: id,
    });
    expect(raised.required).toBe(true);
    expect(raised.required && raised.workflowCode).toBe('BANDED');
  });

  it('does not apply a hundredth below it, and does not park the document', async () => {
    const id = await createDraftJournal(fx, { amount: '9999.99', preparedBy: fx.preparer.userId });
    const raised = await engine.requestApproval(fx.preparer.principal, {
      resourceType: 'JOURNAL',
      resourceId: id,
    });
    expect(raised.required).toBe(false);
    const { rows } = await testPool().query<{ status: string }>(
      `SELECT status::text AS status FROM journal_entries WHERE id = $1`,
      [id],
    );
    expect(rows[0]?.status).toBe('DRAFT');
  });
});
