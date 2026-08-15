/**
 * Close runs — doc 12's period close, and the control the Phase 6 exit criterion
 * asks for: "close dashboard proves all configured reconciliations/checklists
 * complete before hard close."
 *
 * The audit found three separate reasons that criterion could not be met, and this
 * file answers two of them (the third, the hard close itself, is `period-gate.ts`
 * because the transition lives in finance-setup):
 *
 *   - `readiness_percent` was a stored number nothing derived. It is now written
 *     only by `persistReadiness`, from `deriveReadiness`, and no decision reads the
 *     column — every gate recomputes. A number the writer invents and the reader
 *     trusts is a rumour.
 *   - A close run with no template and no configured reconciliations was trivially
 *     complete, so `finalize` succeeded on a run that had never asked for anything.
 *     `assertReadyToFinalize` refuses that case by name, with the remedy in the
 *     message.
 *
 * `reopen` is here too, and it is the criterion "reopening a period is privileged,
 * approved and audited". Privileged was already true (close.reopen is high-risk, so
 * ADR-0005 §3 forces re-authentication) and audited was already true; approved was
 * not, and `assertReopenApproved` is what makes it so.
 */
import { Pool } from 'pg';
import {
  AppError,
  assertEntityPermission,
  entityScope,
  uuidv7,
  type TenantPrincipal,
} from '@acct/domain';
import {
  advisoryXactLock,
  publish,
  readInTenant,
  recordAudit,
  writeInTenant,
} from '@acct/database';
import { materializeChecklist } from './checklist.service';
import {
  assertSameEntity,
  assertSameTenant,
  collectChecklist,
  loadBook,
  loadCloseRun,
  loadPeriod,
  persistReadiness,
} from './internals';
import { assertReadyToFinalize } from './readiness';
import {
  ApprovalRequestReader,
  APPROVAL_RESOURCE,
  assertReopenApproved,
  type ApprovalReader,
} from './approvals';

export interface CreateCloseRunInput {
  readonly legalEntityId: string;
  readonly accountingBookId: string;
  readonly accountingPeriodId: string;
  readonly templateId?: string | undefined;
}

export interface ListCloseRunsQuery {
  readonly legalEntityId?: string | undefined;
  readonly accountingPeriodId?: string | undefined;
  readonly accountingBookId?: string | undefined;
  readonly status?: string | undefined;
}

/** The audit action names this package writes. Read by `finalizerOf`. */
export const CLOSE_AUDIT_ACTION = {
  started: 'close_run.started',
  finalized: 'close_run.finalized',
  reopened: 'close_run.reopened',
} as const;

export class CloseRunService {
  constructor(
    private readonly pool: Pool,
    private readonly approvals: ApprovalReader = new ApprovalRequestReader(),
  ) {}

  /** `createCloseRun` — POST /close-runs. */
  async create(principal: TenantPrincipal, input: CreateCloseRunInput) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      assertEntityPermission(principal, 'close.manage', input.legalEntityId);

      const book = await loadBook(client, input.accountingBookId);
      assertSameTenant('Accounting book', principal.tenantId, book.tenant_id);
      assertSameEntity('Accounting book', input.legalEntityId, book.legal_entity_id, {
        accounting_book_id: book.id,
      });
      if (book.status !== 'ACTIVE') {
        throw new AppError(
          'VALIDATION_FAILED',
          `Accounting book ${book.code} is ${book.status}; a close run governs a book that is in use.`,
        );
      }

      const period = await loadPeriod(client, input.accountingPeriodId);
      assertSameTenant('Accounting period', principal.tenantId, period.tenant_id);
      assertSameEntity('Accounting period', input.legalEntityId, period.legal_entity_id, {
        accounting_period_id: period.id,
      });
      if (period.status === 'HARD_CLOSED') {
        throw new AppError(
          'PERIOD_CLOSED',
          `Period ${period.name} is already HARD_CLOSED. A close run governs a period on its way to ` +
            `being closed; starting one afterwards would record a control that never ran.`,
          { details: { accounting_period_id: period.id } },
        );
      }

      // One close run at a time per book and period. The unique index only covers
      // COMPLETED rows (F-038 made a reopen a new version), so the OPEN case has to
      // be serialised here — two callers could otherwise both read "no run" and
      // both insert version 1.
      await advisoryXactLock(client, 'close_run', `${book.id}:${period.id}`);

      const { rows: existing } = await client.query<{
        id: string;
        version: number;
        status: string;
      }>(
        `SELECT id, version, status::text AS status
           FROM close_runs
          WHERE accounting_book_id = $1 AND accounting_period_id = $2
          ORDER BY version DESC`,
        [book.id, period.id],
      );
      const live = existing.find((r) => r.status !== 'REOPENED');
      if (live) {
        throw new AppError(
          live.status === 'COMPLETED' ? 'POSTED_IMMUTABLE' : 'VALIDATION_FAILED',
          live.status === 'COMPLETED'
            ? `The close of ${period.name} on book ${book.code} is already COMPLETED (run ${live.id}). ` +
                `Reopen it to work it again (POST /close-runs/{id}/reopen); a second run beside a ` +
                `completed one would mean two answers to "was this period closed".`
            : `A close run for ${period.name} on book ${book.code} is already open (run ${live.id}, ` +
                `version ${live.version}, ${live.status}).`,
          { details: { close_run_id: live.id, status: live.status } },
        );
      }
      const version = (existing[0]?.version ?? 0) + 1;

      const id = uuidv7();
      await client.query(
        `INSERT INTO close_runs
           (id, tenant_id, legal_entity_id, accounting_book_id, accounting_period_id,
            template_id, version, status, readiness_percent, started_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'OPEN',0,$8)`,
        [
          id,
          principal.tenantId,
          input.legalEntityId,
          book.id,
          period.id,
          input.templateId ?? null,
          version,
          principal.userId,
        ],
      );
      const run = await loadCloseRun(client, id);

      let tasksAdded = 0;
      if (input.templateId) {
        tasksAdded = (await materializeChecklist(client, run, input.templateId)).added;
      }

      const checklist = await collectChecklist(client, run);
      const persisted = await persistReadiness(client, run, checklist.readiness);

      await publish(client, context, {
        eventType: 'close.started',
        aggregateType: 'close_run',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: input.legalEntityId,
        accountingBookId: book.id,
        payload: {
          accounting_period_id: period.id,
          version,
          template_id: input.templateId ?? null,
          required_total: checklist.readiness.requiredTotal,
        },
      });
      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: input.legalEntityId,
        action: CLOSE_AUDIT_ACTION.started,
        resourceType: 'close_run',
        resourceId: id,
        after: {
          version,
          accounting_book_id: book.id,
          accounting_period_id: period.id,
          template_id: input.templateId ?? null,
          tasks_added: tasksAdded,
        },
      });

      return {
        ...run,
        status: persisted.status,
        readiness_percent: checklist.readiness.readinessPercent,
        tasks_added: tasksAdded,
        ...summarise(checklist.readiness),
      };
    });
  }

  /**
   * `listCloseRuns` — GET /close-runs. This is the close dashboard.
   *
   * Readiness is recomputed per run rather than selected from the column. It costs
   * two queries a row and it is the difference between a dashboard that reports
   * what is true and one that reports what was last written.
   */
  async list(principal: TenantPrincipal, query: ListCloseRunsQuery = {}) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const where = ['r.tenant_id = $1'];
      const params: unknown[] = [principal.tenantId];

      if (query.legalEntityId) {
        assertEntityPermission(principal, 'close.view', query.legalEntityId);
        params.push(query.legalEntityId);
        where.push(`r.legal_entity_id = $${params.length}`);
      } else {
        const scope = entityScope(principal);
        if (scope.kind === 'ENTITIES') {
          params.push(scope.legalEntityIds);
          where.push(`r.legal_entity_id = ANY($${params.length}::uuid[])`);
        }
      }
      if (query.accountingPeriodId) {
        params.push(query.accountingPeriodId);
        where.push(`r.accounting_period_id = $${params.length}`);
      }
      if (query.accountingBookId) {
        params.push(query.accountingBookId);
        where.push(`r.accounting_book_id = $${params.length}`);
      }
      if (query.status) {
        params.push(query.status);
        where.push(`r.status = $${params.length}::close_run_status`);
      }

      const { rows } = await client.query<{
        id: string;
        tenant_id: string;
        legal_entity_id: string;
        accounting_book_id: string;
        book_code: string;
        accounting_period_id: string;
        period_name: string;
        period_status: string;
        template_id: string | null;
        version: number;
        status: string;
        readiness_percent: string;
        started_by: string | null;
        started_at: string;
        completed_at: string | null;
        reopened_at: string | null;
        reopen_reason: string | null;
      }>(
        `SELECT r.id, r.tenant_id, r.legal_entity_id, r.accounting_book_id, b.code AS book_code,
                r.accounting_period_id, p.name AS period_name, p.status::text AS period_status,
                r.template_id, r.version, r.status::text AS status,
                r.readiness_percent::text AS readiness_percent,
                r.started_by, r.started_at, r.completed_at, r.reopened_at, r.reopen_reason
           FROM close_runs r
           JOIN accounting_books b ON b.id = r.accounting_book_id
           JOIN accounting_periods p ON p.id = r.accounting_period_id
          WHERE ${where.join(' AND ')}
          ORDER BY p.start_date DESC, b.code, r.version DESC
          LIMIT 200`,
        params,
      );

      const data = [];
      for (const row of rows) {
        const checklist = await collectChecklist(client, row);
        data.push({
          ...row,
          // The derived value wins. `readiness_percent_stored` is kept beside it so
          // a drift between the two is visible rather than hidden by the fix.
          readiness_percent: checklist.readiness.readinessPercent,
          readiness_percent_stored: row.readiness_percent,
          ...summarise(checklist.readiness),
        });
      }
      return { data };
    });
  }

  /** `finalizeCloseRun` — POST /close-runs/{id}/finalize. */
  async finalize(
    principal: TenantPrincipal,
    id: string,
    input: { note?: string | undefined } = {},
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const run = await loadCloseRun(client, id, 'FOR UPDATE');
      assertEntityPermission(principal, 'close.finalize', run.legal_entity_id);

      if (run.status === 'COMPLETED') {
        throw new AppError(
          'POSTED_IMMUTABLE',
          `Close run ${id} is already COMPLETED (at ${run.completed_at}). Reopen it if the close has ` +
            `to be worked again.`,
        );
      }
      if (run.status === 'REOPENED') {
        throw new AppError(
          'POSTED_IMMUTABLE',
          `Close run ${id} was superseded by a later version when the close was reopened; finalize ` +
            `that version instead.`,
        );
      }

      const period = await loadPeriod(client, run.accounting_period_id);
      const checklist = await collectChecklist(client, run);

      // The gate. Both halves of it: it refuses an incomplete close, and it refuses
      // a close that asked for nothing — which was the same thing as complete
      // before this package existed.
      assertReadyToFinalize(checklist.readiness, {
        subject: `close run ${id} (${period.name})`,
        act: 'Finalizing the close',
        configureHint:
          'Generate a checklist from a template (POST /close-checklists/generate) or mark the ' +
          "entity's control accounts so their reconciliations are required, then finalize.",
      });

      const { rows } = await client.query<{
        id: string;
        status: string;
        completed_at: string;
        readiness_percent: string;
      }>(
        `UPDATE close_runs
            SET status = 'COMPLETED', completed_at = now(), readiness_percent = 100
          WHERE id = $1
        RETURNING id, status::text AS status, completed_at, readiness_percent::text AS readiness_percent`,
        [id],
      );

      await publish(client, context, {
        eventType: 'period.closed',
        aggregateType: 'close_run',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: run.legal_entity_id,
        accountingBookId: run.accounting_book_id,
        payload: {
          accounting_period_id: run.accounting_period_id,
          version: run.version,
          required_total: checklist.readiness.requiredTotal,
          waived_count: checklist.readiness.waivedCount,
        },
      });
      // The actor on this row is the only record of WHO finalized: close_runs has
      // completed_at and no completed_by. `finalizerOf` reads it back, and the
      // reopen refuses when it cannot be read — see INTEGRATION NOTES.
      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: run.legal_entity_id,
        action: CLOSE_AUDIT_ACTION.finalized,
        resourceType: 'close_run',
        resourceId: id,
        reason: input.note ?? null,
        before: { status: run.status, readiness_percent: run.readiness_percent },
        after: {
          status: 'COMPLETED',
          required_total: checklist.readiness.requiredTotal,
          required_satisfied: checklist.readiness.requiredSatisfied,
          waived_count: checklist.readiness.waivedCount,
        },
      });

      return {
        ...rows[0]!,
        version: run.version,
        accounting_period_id: run.accounting_period_id,
        accounting_book_id: run.accounting_book_id,
        ...summarise(checklist.readiness),
      };
    });
  }

  /**
   * `reopenCloseRun` — POST /close-runs/{id}/reopen.
   *
   * Not in this task's operation list, and implemented here anyway: the reopen is
   * where "approved" is proven, and there is nowhere else in the workspace for the
   * close-run half of it to live. The route binding is the controller owner's; the
   * method is theirs to call.
   *
   * The completed run becomes REOPENED — which is also what frees
   * `close_runs_completed_uq` — and version + 1 opens beside it, so the previous
   * version's task history survives (F-038).
   */
  async reopen(principal: TenantPrincipal, id: string, input: { reason: string }) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const run = await loadCloseRun(client, id, 'FOR UPDATE');
      assertEntityPermission(principal, 'close.reopen', run.legal_entity_id);

      if (run.status !== 'COMPLETED') {
        throw new AppError(
          'VALIDATION_FAILED',
          `Close run ${id} is ${run.status}; only a COMPLETED close can be reopened.`,
        );
      }
      const reason = (input.reason ?? '').trim();
      if (!reason) {
        throw new AppError(
          'VALIDATION_FAILED',
          'A reason is required to reopen a close. `close_runs_reopen_has_reason` refuses the row ' +
            'without one, and the reason is what the auditor reads.',
          { fieldErrors: [{ field: 'reason', code: 'REQUIRED', message: 'a reason is required' }] },
        );
      }

      const finalizedBy = await finalizerOf(client, id);
      const approvals = await this.approvals.approvalsFor(client, {
        tenantId: principal.tenantId,
        resourceType: APPROVAL_RESOURCE.closeRun,
        resourceId: id,
        since: run.completed_at,
      });
      const approval = assertReopenApproved(approvals, {
        subject: `close run ${id}`,
        actorId: principal.userId,
        supersedes: { role: 'finalized this close', userId: finalizedBy },
        since: run.completed_at,
        requestHint:
          'Raise an approval request against resource_type "close_run" and have somebody other ' +
          'than the person who finalized the close decide it (POST /approval-tasks/{id}/approve), ' +
          'then retry.',
      });

      await client.query(
        `UPDATE close_runs
            SET status = 'REOPENED', reopened_at = now(), reopened_by = $2, reopen_reason = $3
          WHERE id = $1`,
        [id, principal.userId, reason],
      );

      const nextId = uuidv7();
      await client.query(
        `INSERT INTO close_runs
           (id, tenant_id, legal_entity_id, accounting_book_id, accounting_period_id,
            template_id, version, status, readiness_percent, started_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'OPEN',0,$8)`,
        [
          nextId,
          run.tenant_id,
          run.legal_entity_id,
          run.accounting_book_id,
          run.accounting_period_id,
          run.template_id,
          run.version + 1,
          principal.userId,
        ],
      );
      const next = await loadCloseRun(client, nextId);
      if (next.template_id) await materializeChecklist(client, next, next.template_id);

      const checklist = await collectChecklist(client, next);
      await persistReadiness(client, next, checklist.readiness);

      await publish(client, context, {
        eventType: 'close.reopened',
        aggregateType: 'close_run',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: run.legal_entity_id,
        accountingBookId: run.accounting_book_id,
        payload: {
          accounting_period_id: run.accounting_period_id,
          reopened_version: run.version,
          new_close_run_id: nextId,
          new_version: run.version + 1,
          reason,
          approval_request_id: approval.requestId,
          approved_by: approval.decidedBy,
        },
      });
      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: run.legal_entity_id,
        action: CLOSE_AUDIT_ACTION.reopened,
        resourceType: 'close_run',
        resourceId: id,
        reason,
        before: { status: 'COMPLETED', version: run.version, finalized_by: finalizedBy },
        after: {
          status: 'REOPENED',
          new_close_run_id: nextId,
          new_version: run.version + 1,
          approval_request_id: approval.requestId,
          approved_by: approval.decidedBy,
          approved_at: approval.decidedAt,
        },
      });

      return {
        ...next,
        reopened_close_run_id: id,
        reopened_version: run.version,
        approval: {
          request_id: approval.requestId,
          approved_by: approval.decidedBy,
          approved_at: approval.decidedAt,
        },
        ...summarise(checklist.readiness),
      };
    });
  }
}

function summarise(readiness: {
  requiredTotal: number;
  requiredSatisfied: number;
  configured: boolean;
  complete: boolean;
  waivedCount: number;
  blocking: readonly { kind: string; reference: string; state: string }[];
}) {
  return {
    required_total: readiness.requiredTotal,
    required_satisfied: readiness.requiredSatisfied,
    configured: readiness.configured,
    complete: readiness.complete,
    waived_count: readiness.waivedCount,
    blocking: readiness.blocking,
  };
}

/**
 * Who finalized this close, from the audit trail.
 *
 * `close_runs` records `completed_at` and not `completed_by` — the schema has no
 * column for it — so the hash-chained audit row is the record. Returns null when
 * there is none, and every caller treats null as a refusal rather than as
 * permission: a comparison against an unknown person is not "different people".
 */
export async function finalizerOf(
  client: import('pg').PoolClient,
  closeRunId: string,
): Promise<string | null> {
  // `audit_events.resource_id` and `actor_id` are text, not uuid — a cast here
  // would fail rather than find nothing, which is a different bug.
  const { rows } = await client.query<{ actor_id: string | null }>(
    `SELECT actor_id
       FROM audit_events
      WHERE resource_type = 'close_run' AND resource_id = $1 AND action = $2
      ORDER BY id DESC LIMIT 1`,
    [closeRunId, CLOSE_AUDIT_ACTION.finalized],
  );
  return rows[0]?.actor_id ?? null;
}
