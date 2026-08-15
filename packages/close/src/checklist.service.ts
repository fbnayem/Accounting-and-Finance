/**
 * The close checklist — doc 12's task list, and the half of the completeness
 * question a person answers by hand.
 *
 * The other half (reconciliations) is derived from the chart of accounts and lives
 * in `internals.loadRequiredReconciliations`. Both are folded together by
 * `collectChecklist`, so a close is complete when the tasks AND the reconciliations
 * are, and neither can be satisfied by the other being empty.
 */
import { PoolClient, Pool } from 'pg';
import {
  AppError,
  assertEntityPermission,
  notFound,
  uuidv7,
  type TenantPrincipal,
} from '@acct/domain';
import { publish, readInTenant, recordAudit, writeInTenant } from '@acct/database';
import {
  collectChecklist,
  loadCloseRun,
  loadCloseTasks,
  persistReadiness,
  type CloseRunRow,
} from './internals';

interface TemplateTaskRow {
  id: string;
  sequence: number;
  code: string;
  name: string;
  task_type: string;
  required: boolean;
  depends_on_task_code: string | null;
}

/**
 * Copies a template's tasks onto a run.
 *
 * Idempotent by `UNIQUE (close_run_id, code)`: regenerating after the template
 * gained a task adds the new one and leaves the completed ones alone. That is the
 * behaviour a close needs — a checklist that reset itself on regeneration would
 * lose the evidence of what was already done, and one that refused to regenerate
 * would leave the new control unenforced for the whole period.
 *
 * Returns the number of tasks added.
 */
export async function materializeChecklist(
  client: PoolClient,
  run: CloseRunRow,
  templateId: string,
): Promise<{ added: number; template: { id: string; code: string; name: string } }> {
  const { rows: templates } = await client.query<{
    id: string;
    tenant_id: string;
    organization_id: string;
    code: string;
    name: string;
    status: string;
  }>(
    `SELECT t.id, t.tenant_id, t.organization_id, t.code, t.name, t.status::text AS status
       FROM close_checklist_templates t WHERE t.id = $1`,
    [templateId],
  );
  const template = templates[0];
  if (!template) throw notFound('Close checklist template', templateId);
  if (template.tenant_id !== run.tenant_id) {
    throw new AppError('TENANT_MISMATCH', `Close checklist template ${templateId} is not yours.`);
  }
  if (template.status !== 'ACTIVE') {
    throw new AppError(
      'VALIDATION_FAILED',
      `Close checklist template ${template.code} is ${template.status}. A close cannot be governed ` +
        `by a template that is no longer in force.`,
    );
  }

  // The template is an organization artifact and the run is an entity one; a
  // template from another organization would put another organization's controls
  // on this close.
  const { rows: entities } = await client.query<{ organization_id: string }>(
    `SELECT organization_id FROM legal_entities WHERE id = $1`,
    [run.legal_entity_id],
  );
  if (entities[0] && entities[0].organization_id !== template.organization_id) {
    throw new AppError(
      'CROSS_ENTITY_REFERENCE',
      `Close checklist template ${template.code} belongs to another organization.`,
      { details: { template_id: templateId } },
    );
  }

  const { rows: templateTasks } = await client.query<TemplateTaskRow>(
    `SELECT id, sequence, code, name, task_type, required, depends_on_task_code
       FROM close_checklist_template_tasks
      WHERE template_id = $1
      ORDER BY sequence, code`,
    [templateId],
  );

  if (templateTasks.length === 0) {
    // A template with no tasks generates an empty checklist, and an empty
    // checklist is exactly the vacuous "complete" this package refuses. Caught
    // here, where the remedy is obvious, rather than at finalize.
    throw new AppError(
      'VALIDATION_FAILED',
      `Close checklist template ${template.code} has no tasks, so generating from it would produce ` +
        `a checklist that is complete because it asks for nothing. Add tasks to the template first.`,
      { details: { template_id: templateId } },
    );
  }

  // A dependency naming a task the template does not contain is a dependency that
  // silently does not exist — the gate would be weaker than the template reads.
  const codes = new Set(templateTasks.map((t) => t.code));
  for (const task of templateTasks) {
    if (task.depends_on_task_code !== null && !codes.has(task.depends_on_task_code)) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Template task ${task.code} depends on ${task.depends_on_task_code}, which is not a task of ` +
          `template ${template.code}. A dependency on a task that does not exist would be no ` +
          `dependency at all.`,
      );
    }
    if (task.depends_on_task_code === task.code) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Template task ${task.code} depends on itself, which can never be satisfied.`,
      );
    }
  }

  let added = 0;
  for (const task of templateTasks) {
    const { rowCount } = await client.query(
      `INSERT INTO close_tasks
         (id, tenant_id, close_run_id, sequence, code, name, task_type, required, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'OPEN')
       ON CONFLICT (close_run_id, code) DO NOTHING`,
      [
        uuidv7(),
        run.tenant_id,
        run.id,
        task.sequence,
        task.code,
        task.name,
        task.task_type,
        task.required,
      ],
    );
    added += rowCount ?? 0;
  }

  // Second pass: the dependency is a task id on this run, which only exists once
  // every task has been inserted.
  await client.query(
    `UPDATE close_tasks t
        SET depends_on_task_id = d.id
       FROM close_checklist_template_tasks tt
       JOIN close_tasks d ON d.close_run_id = $1 AND d.code = tt.depends_on_task_code
      WHERE tt.template_id = $2
        AND tt.depends_on_task_code IS NOT NULL
        AND t.close_run_id = $1
        AND t.code = tt.code
        AND t.depends_on_task_id IS NULL`,
    [run.id, templateId],
  );

  return { added, template: { id: template.id, code: template.code, name: template.name } };
}

export interface GenerateChecklistInput {
  readonly closeRunId: string;
  /** Defaults to the run's own template. One of the two must resolve. */
  readonly templateId?: string | undefined;
}

export interface CompleteTaskInput {
  readonly evidence?: readonly Record<string, unknown>[] | undefined;
  readonly note?: string | undefined;
}

export class CloseChecklistService {
  constructor(private readonly pool: Pool) {}

  /** `generateCloseChecklist` — POST /close-checklists/generate. */
  async generate(principal: TenantPrincipal, input: GenerateChecklistInput) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const run = await loadCloseRun(client, input.closeRunId, 'FOR UPDATE');
      assertEntityPermission(principal, 'close.manage', run.legal_entity_id);

      if (run.status === 'COMPLETED' || run.status === 'REOPENED') {
        throw new AppError(
          'POSTED_IMMUTABLE',
          `Close run ${run.id} is ${run.status}; its checklist cannot change. Reopen the close to ` +
            `work it again (POST /close-runs/{id}/reopen).`,
        );
      }

      const templateId = input.templateId ?? run.template_id;
      if (!templateId) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Close run ${run.id} has no checklist template and none was given, so there is nothing to ` +
            `generate from. Pass template_id, or create the run with one — a close run with no ` +
            `checklist is complete the moment it starts, which proves nothing.`,
          {
            fieldErrors: [
              { field: 'template_id', code: 'REQUIRED', message: 'a template is required' },
            ],
          },
        );
      }

      const { added, template } = await materializeChecklist(client, run, templateId);

      if (run.template_id === null) {
        await client.query(`UPDATE close_runs SET template_id = $2 WHERE id = $1`, [
          run.id,
          templateId,
        ]);
      }

      const refreshed = await loadCloseRun(client, run.id);
      const checklist = await collectChecklist(client, refreshed);
      const persisted = await persistReadiness(client, refreshed, checklist.readiness);

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: run.legal_entity_id,
        action: 'close_run.checklist_generated',
        resourceType: 'close_run',
        resourceId: run.id,
        after: {
          template_code: template.code,
          tasks_added: added,
          required_total: checklist.readiness.requiredTotal,
        },
      });

      return {
        close_run_id: run.id,
        template_id: templateId,
        template_code: template.code,
        tasks_added: added,
        status: persisted.status,
        readiness_percent: checklist.readiness.readinessPercent,
        required_total: checklist.readiness.requiredTotal,
        data: await loadCloseTasks(client, run.id),
      };
    });
  }

  /** `listCloseTasks` — GET /close-runs/{id}/tasks. The close dashboard's detail. */
  async listTasks(principal: TenantPrincipal, closeRunId: string) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const run = await loadCloseRun(client, closeRunId);
      assertEntityPermission(principal, 'close.view', run.legal_entity_id);

      const checklist = await collectChecklist(client, run);
      return {
        data: checklist.tasks,
        close_run: {
          id: run.id,
          status: run.status,
          version: run.version,
          legal_entity_id: run.legal_entity_id,
          accounting_book_id: run.accounting_book_id,
          accounting_period_id: run.accounting_period_id,
        },
        // Derived now, not read from the stored column: the dashboard and the
        // finalize gate answer from the same computation or the dashboard is
        // decoration.
        readiness: {
          readiness_percent: checklist.readiness.readinessPercent,
          required_total: checklist.readiness.requiredTotal,
          required_satisfied: checklist.readiness.requiredSatisfied,
          configured: checklist.readiness.configured,
          complete: checklist.readiness.complete,
          waived_count: checklist.readiness.waivedCount,
          blocking: checklist.readiness.blocking,
        },
        reconciliations: checklist.reconciliations,
      };
    });
  }

  /** `completeCloseTask` — POST /close-tasks/{id}/complete. */
  async completeTask(principal: TenantPrincipal, taskId: string, input: CompleteTaskInput = {}) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows: tasks } = await client.query<{
        id: string;
        close_run_id: string;
        code: string;
        name: string;
        required: boolean;
        status: string;
        depends_on_task_id: string | null;
        completed_by: string | null;
        completed_at: string | null;
      }>(
        `SELECT id, close_run_id, code, name, required, status::text AS status,
                depends_on_task_id, completed_by, completed_at
           FROM close_tasks WHERE id = $1 FOR UPDATE`,
        [taskId],
      );
      const task = tasks[0];
      if (!task) throw notFound('Close task', taskId);

      const run = await loadCloseRun(client, task.close_run_id, 'FOR UPDATE');
      assertEntityPermission(principal, 'close.manage', run.legal_entity_id);

      if (run.status === 'COMPLETED' || run.status === 'REOPENED') {
        throw new AppError(
          'POSTED_IMMUTABLE',
          `Close run ${run.id} is ${run.status}; its tasks are history. Reopen the close before ` +
            `recording more work against it.`,
        );
      }
      if (task.status === 'COMPLETED' || task.status === 'WAIVED') {
        throw new AppError(
          'VALIDATION_FAILED',
          `Close task ${task.code} is already ${task.status}` +
            (task.completed_at ? ` (at ${task.completed_at})` : '') +
            `. Completing it twice would record a second sign-off that never happened.`,
        );
      }

      if (task.depends_on_task_id) {
        const { rows: blockers } = await client.query<{
          code: string;
          status: string;
          completed_by: string | null;
          waived_by: string | null;
          waived_reason: string | null;
        }>(
          `SELECT code, status::text AS status, completed_by, waived_by, waived_reason
             FROM close_tasks WHERE id = $1`,
          [task.depends_on_task_id],
        );
        const blocker = blockers[0];
        // A dependency row that has vanished is not permission to proceed.
        if (!blocker) {
          throw new AppError(
            'VALIDATION_FAILED',
            `Close task ${task.code} depends on a task that no longer exists; regenerate the ` +
              `checklist before completing it.`,
          );
        }
        const done =
          (blocker.status === 'COMPLETED' && blocker.completed_by !== null) ||
          (blocker.status === 'WAIVED' &&
            blocker.waived_by !== null &&
            (blocker.waived_reason ?? '').trim() !== '');
        if (!done) {
          throw new AppError(
            'VALIDATION_FAILED',
            `Close task ${task.code} depends on ${blocker.code}, which is ${blocker.status}. ` +
              `doc 12 sequences the checklist so a task is not signed off against work that has not ` +
              `happened yet.`,
            { details: { task: task.code, depends_on: blocker.code, state: blocker.status } },
          );
        }
      }

      const evidence = input.evidence ?? [];
      const { rows: updated } = await client.query<{
        id: string;
        code: string;
        status: string;
        completed_at: string;
        completed_by: string;
      }>(
        `UPDATE close_tasks
            SET status = 'COMPLETED', completed_by = $2, completed_at = now(),
                evidence = $3::jsonb
          WHERE id = $1
        RETURNING id, code, status::text AS status, completed_at, completed_by`,
        [taskId, principal.userId, JSON.stringify(evidence)],
      );

      const checklist = await collectChecklist(client, run);
      const persisted = await persistReadiness(client, run, checklist.readiness);

      await publish(client, context, {
        eventType: 'close.task_completed',
        aggregateType: 'close_run',
        aggregateId: run.id,
        tenantId: principal.tenantId,
        legalEntityId: run.legal_entity_id,
        accountingBookId: run.accounting_book_id,
        payload: {
          close_task_id: taskId,
          code: task.code,
          required: task.required,
          readiness_percent: checklist.readiness.readinessPercent,
        },
      });

      // doc 12's dashboard signal, emitted once the last required item lands
      // rather than on a stored flag nobody sets.
      if (checklist.readiness.complete) {
        await publish(client, context, {
          eventType: 'period.close_ready',
          aggregateType: 'close_run',
          aggregateId: run.id,
          tenantId: principal.tenantId,
          legalEntityId: run.legal_entity_id,
          accountingBookId: run.accounting_book_id,
          payload: {
            accounting_period_id: run.accounting_period_id,
            required_total: checklist.readiness.requiredTotal,
          },
        });
      }

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: run.legal_entity_id,
        action: 'close_run.task_completed',
        resourceType: 'close_task',
        resourceId: taskId,
        reason: input.note ?? null,
        before: { status: task.status },
        after: { status: 'COMPLETED', evidence_count: evidence.length },
      });

      return {
        ...updated[0]!,
        close_run_id: run.id,
        close_run_status: persisted.status,
        readiness_percent: checklist.readiness.readinessPercent,
        required_total: checklist.readiness.requiredTotal,
        required_satisfied: checklist.readiness.requiredSatisfied,
        blocking: checklist.readiness.blocking,
      };
    });
  }
}
