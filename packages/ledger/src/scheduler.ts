/**
 * Due work: scheduled reversals and recurring journals.
 *
 * doc 03 asks for two background behaviours and states the hard part of each:
 *
 *   "Scheduled reversal queues a future draft/post request and still obeys period
 *    status at execution."
 *   "Generated journal references template version and schedule occurrence;
 *    occurrence is idempotent."
 *
 * Both sentences are about what happens when the world has moved on since the
 * schedule was made. So neither of these functions posts anything itself — they
 * call `JournalService`, which takes the period lock, checks the permission,
 * allocates the number and runs the same balance assertion as a manual journal. A
 * reversal that arrives at a closed July fails, loudly, and stays PENDING for a
 * human to deal with. That is the behaviour doc 03 is asking for; a background job
 * that "just posts it" would be the bug.
 *
 * The service principal below is the other half. A worker has no session, but it
 * must not therefore have unlimited authority: it is given exactly the permissions
 * the two operations need, scoped to the tenant of the row it is acting on.
 */
import { Pool, PoolClient } from 'pg';
import {
  AppError,
  runWithContext,
  uuidv7,
  type Grant,
  type RequestContext,
  type TenantPrincipal,
} from '@acct/domain';
import { withTransaction, writeInTenant } from '@acct/database';
import { JournalService, type JournalLineInput } from './journal.service';

export interface SchedulerLogger {
  info(object: Record<string, unknown>, message: string): void;
  warn(object: Record<string, unknown>, message: string): void;
  error(object: Record<string, unknown>, message: string): void;
}

/**
 * The identity a background run acts as.
 *
 * Every grant is listed. A worker principal with `everything` would be the largest
 * privilege in the system and the only one nobody reviews, and the specific reason
 * it matters here is `journal.post_control`: a scheduled reversal of a journal that
 * touched a control account has to be able to reverse it, and an accrual reversal
 * never touches one. Granting it unconditionally would let a recurring template
 * post to AR every month with nobody having approved that.
 */
export interface ServicePrincipalOptions {
  readonly tenantId: string;
  readonly userId: string;
  readonly permissions: readonly string[];
}

export function servicePrincipal(options: ServicePrincipalOptions): TenantPrincipal {
  const grant: Grant = {
    membershipId: 'service',
    roleId: 'service',
    roleCode: 'service.scheduler',
    organizationId: null,
    legalEntityId: null,
    branchId: null,
    permissions: new Set(options.permissions),
  };
  return {
    userId: options.userId,
    sessionId: 'service',
    email: 'scheduler@service.internal',
    displayName: 'Scheduled job',
    tenantId: options.tenantId,
    grants: [grant],
    // A background job cannot satisfy an MFA challenge, and pretending otherwise
    // would make `mfaSatisfied` meaningless. Nothing the scheduler calls demands it;
    // if something ever does, it should fail here rather than be waved through.
    mfaSatisfied: false,
    mfaVerifiedAt: null,
    impersonatedBy: null,
  };
}

/**
 * The user row a scheduled posting is attributed to — migration 0031.
 *
 * A constant rather than configuration: `posted_by` is a foreign key, and an actor
 * id that varies per deployment would make "who posted this" unanswerable across a
 * restore into another environment.
 */
export const SYSTEM_ACTOR_ID = '00000000-0000-4000-8000-00000000005c';

const REVERSAL_PERMISSIONS = ['journal.view', 'journal.reverse', 'journal.post_control'];
const RECURRING_PERMISSIONS = ['journal.view', 'journal.create', 'journal.submit', 'journal.post'];

export interface DueWorkResult {
  readonly considered: number;
  readonly succeeded: number;
  readonly failed: number;
}

interface DueSchedule {
  id: string;
  tenant_id: string;
  legal_entity_id: string;
  journal_entry_id: string;
  scheduled_date: string;
  reason: string;
  attempts: number;
}

/**
 * Posts every scheduled reversal whose date has arrived.
 *
 * Claimed with `FOR UPDATE SKIP LOCKED` so two worker replicas never take the same
 * row, and each reversal runs in its own transaction so one failure does not roll
 * back the others — a closed period on one entity must not stop another entity's
 * accrual from reversing.
 */
export async function runDueReversals(
  pool: Pool,
  journals: JournalService,
  logger: SchedulerLogger,
  options: { today: string; limit?: number; actorId: string },
): Promise<DueWorkResult> {
  // F-620 / migration 0033: the claim is cross-tenant, so it goes through the
  // SECURITY DEFINER function. Everything below runs inside a tenant transaction.
  const due = await claim<DueSchedule>(
    pool,
    `SELECT id, tenant_id, legal_entity_id, journal_entry_id,
            scheduled_date::text AS scheduled_date, reason, attempts
       FROM ledger_claim_due_reversals($1::date, $2)`,
    [options.today, options.limit ?? 100],
  );

  let succeeded = 0;
  let failed = 0;

  for (const schedule of due) {
    const context: RequestContext = {
      correlationId: `scheduled-reversal:${schedule.id}`,
      tenantId: schedule.tenant_id,
      legalEntityId: schedule.legal_entity_id,
      actorKind: 'SERVICE',
      actorId: options.actorId,
    };
    const principal = servicePrincipal({
      tenantId: schedule.tenant_id,
      userId: options.actorId,
      permissions: REVERSAL_PERMISSIONS,
    });

    try {
      const reversal = await runWithContext(context, () =>
        journals.reverse(principal, schedule.journal_entry_id, {
          reason: schedule.reason,
          postingDate: schedule.scheduled_date,
        }),
      );
      await writeInTenant(pool, principal, async ({ client }) => {
        await client.query(
          `UPDATE scheduled_reversals
              SET status = 'EXECUTED', executed_at = now(), reversal_entry_id = $2,
                  attempts = attempts + 1, last_error = NULL
            WHERE id = $1`,
          [schedule.id, (reversal as { id: string }).id],
        );
      });
      succeeded++;
      logger.info(
        { scheduled_reversal_id: schedule.id, reversal_entry_id: (reversal as { id: string }).id },
        'scheduled reversal posted',
      );
    } catch (err) {
      failed++;
      // The row stays PENDING. doc 03's "still obeys period status at execution"
      // means a closed period is a legitimate outcome that a person resolves — by
      // reopening the period or cancelling the schedule — not something to retry
      // into oblivion at five-minute intervals. `last_error` is what they read.
      const message = err instanceof AppError ? err.message : 'unexpected error';
      await runWithContext(context, () =>
        writeInTenant(pool, principal, async ({ client }) => {
          await client.query(
            `UPDATE scheduled_reversals
                SET attempts = attempts + 1, last_error = $2,
                    status = CASE WHEN attempts + 1 >= 5 THEN 'FAILED' ELSE 'PENDING' END
              WHERE id = $1`,
            [schedule.id, message],
          );
        }),
      );
      logger.warn(
        { err, scheduled_reversal_id: schedule.id, attempts: schedule.attempts + 1 },
        'scheduled reversal could not be posted',
      );
    }
  }

  return { considered: due.length, succeeded, failed };
}

interface DueTemplate {
  id: string;
  tenant_id: string;
  legal_entity_id: string;
  accounting_book_id: string;
  journal_id: string;
  name: string;
  version: number;
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
  next_run_date: string;
  end_date: string | null;
  auto_post: boolean;
  requires_approval: boolean;
  line_template: { lines?: JournalLineInput[] } | null;
}

/**
 * Generates the journals whose recurrence date has arrived.
 *
 * doc 03: "occurrence is idempotent." `recurring_journal_occurrences` has
 * `UNIQUE (template_id, occurrence_date)`, so the second attempt at the same date
 * loses the insert rather than producing a second journal — the check is
 * structural, not a `SELECT` that another worker can interleave with.
 */
export async function runDueRecurringJournals(
  pool: Pool,
  journals: JournalService,
  logger: SchedulerLogger,
  options: { today: string; limit?: number; actorId: string },
): Promise<DueWorkResult> {
  const due = await claim<DueTemplate>(
    pool,
    `SELECT id, tenant_id, legal_entity_id, accounting_book_id, journal_id, name, version,
            frequency, next_run_date::text AS next_run_date, end_date::text AS end_date,
            auto_post, requires_approval, line_template
       FROM ledger_claim_due_recurring($1::date, $2)`,
    [options.today, options.limit ?? 100],
  );

  let succeeded = 0;
  let failed = 0;

  for (const template of due) {
    const occurrenceDate = template.next_run_date;
    const context: RequestContext = {
      correlationId: `recurring-journal:${template.id}:${occurrenceDate}`,
      tenantId: template.tenant_id,
      legalEntityId: template.legal_entity_id,
      actorKind: 'SERVICE',
      actorId: options.actorId,
    };
    const principal = servicePrincipal({
      tenantId: template.tenant_id,
      userId: options.actorId,
      permissions: RECURRING_PERMISSIONS,
    });

    try {
      await runWithContext(context, async () => {
        const claimed = await withTransaction(
          pool,
          async ({ client }) =>
            reserveOccurrence(client, template.id, occurrenceDate, template.version),
          { context },
        );
        if (!claimed) {
          logger.info(
            { template_id: template.id, occurrence_date: occurrenceDate },
            'recurring occurrence already generated; skipping',
          );
          return;
        }

        const lines = template.line_template?.lines ?? [];
        if (lines.length === 0) {
          throw new AppError(
            'VALIDATION_FAILED',
            `Recurring template "${template.name}" has no lines to generate.`,
          );
        }

        const draft = await journals.createDraft(principal, {
          accountingBookId: template.accounting_book_id,
          journalId: template.journal_id,
          postingDate: occurrenceDate,
          description: `${template.name} — ${occurrenceDate}`,
          sourceType: 'RECURRING_JOURNAL',
          sourceId: template.id,
          // The occurrence identity, so a redelivery of the same generation finds
          // the existing entry through journal_entries_source_event_uq rather than
          // making a second one.
          sourceEventId: deterministicOccurrenceId(template.id, occurrenceDate),
          lines,
        });
        const entryId = (draft as { id: string }).id;

        await writeInTenant(pool, principal, async ({ client }) => {
          await client.query(
            `UPDATE recurring_journal_occurrences SET journal_entry_id = $3
              WHERE template_id = $1 AND occurrence_date = $2::date`,
            [template.id, occurrenceDate, entryId],
          );
        });

        // doc 03 gives the template both `auto_post` and `requires_approval`, and
        // they can disagree. Approval wins: a template that says "someone must look
        // at this" is not overridden by a template that also says "post it".
        if (template.auto_post && !template.requires_approval) {
          await journals.post(principal, entryId, {});
        }
        logger.info(
          {
            template_id: template.id,
            occurrence_date: occurrenceDate,
            journal_entry_id: entryId,
            posted: template.auto_post && !template.requires_approval,
          },
          'recurring journal generated',
        );
      });

      await runWithContext(context, () =>
        writeInTenant(pool, principal, async ({ client }) => {
          await client.query(
            `UPDATE recurring_journal_templates SET next_run_date = $2::date WHERE id = $1`,
            [template.id, nextRunDate(occurrenceDate, template.frequency)],
          );
        }),
      );
      succeeded++;
    } catch (err) {
      failed++;
      // The template's next_run_date is NOT advanced. A generation that failed
      // should be retried once the cause is fixed, and skipping the month silently
      // is how an accrual goes missing from a period nobody re-examines.
      logger.error(
        { err, template_id: template.id, occurrence_date: occurrenceDate },
        'recurring journal generation failed; next_run_date left in place',
      );
    }
  }

  return { considered: due.length, succeeded, failed };
}

// ---------------------------------------------------------------------------

/**
 * Runs a claim function and returns its rows.
 *
 * The transaction ends when this returns, releasing the locks the function took —
 * the work itself then runs one row at a time in its own transaction. Holding the
 * claim across the whole batch would mean one slow posting blocks the row behind
 * it, and a crash mid-batch would leave every remaining row locked until the
 * connection died.
 */
async function claim<T extends { id: string }>(
  pool: Pool,
  sql: string,
  params: readonly unknown[],
): Promise<T[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<T>(sql, params as unknown[]);
    await client.query('COMMIT');
    return rows;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function reserveOccurrence(
  client: PoolClient,
  templateId: string,
  occurrenceDate: string,
  templateVersion: number,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `INSERT INTO recurring_journal_occurrences (id, tenant_id, template_id, occurrence_date,
                                                template_version)
     SELECT $1, t.tenant_id, $2, $3::date, $4
       FROM recurring_journal_templates t WHERE t.id = $2
     ON CONFLICT (template_id, occurrence_date) DO NOTHING`,
    [uuidv7(), templateId, occurrenceDate, templateVersion],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * A stable id per (template, date), so a regeneration of the same occurrence is
 * recognised by `journal_entries_source_event_uq` rather than producing a duplicate.
 *
 * Derived by hashing rather than by uuidv7, which encodes the current millisecond
 * and would therefore be different on every attempt — the exact defect that made
 * four Phase 0 tests non-repeatable.
 */
export function deterministicOccurrenceId(templateId: string, occurrenceDate: string): string {
  const hex = fnv1a128(`${templateId}:${occurrenceDate}`);
  // Version 5-shaped: name-based, so it reads as derived rather than random.
  const version = `5${hex.slice(13, 16)}`;
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${version}-${variant}-${hex.slice(20, 32)}`;
}

function fnv1a128(input: string): string {
  // Two independent 64-bit FNV-1a passes, forwards and backwards, concatenated.
  // Not a cryptographic hash and not used as one: the requirement is determinism
  // and a negligible collision rate across one tenant's template/date pairs.
  const pass = (text: string): bigint => {
    let hash = 0xcbf29ce484222325n;
    for (let i = 0; i < text.length; i++) {
      hash ^= BigInt(text.charCodeAt(i));
      hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    return hash;
  };
  const forward = pass(input).toString(16).padStart(16, '0');
  const backward = pass([...input].reverse().join(''))
    .toString(16)
    .padStart(16, '0');
  return forward + backward;
}

/** UTC calendar arithmetic on `YYYY-MM-DD`, for the reason in `generatePeriods`. */
export function nextRunDate(from: string, frequency: DueTemplate['frequency']): string {
  const year = Number(from.slice(0, 4));
  const month = Number(from.slice(5, 7)) - 1;
  const day = Number(from.slice(8, 10));

  const step: Record<DueTemplate['frequency'], [number, number]> = {
    DAILY: [0, 1],
    WEEKLY: [0, 7],
    MONTHLY: [1, 0],
    QUARTERLY: [3, 0],
    ANNUAL: [12, 0],
  };
  const [months, days] = step[frequency];

  if (days > 0) return new Date(Date.UTC(year, month, day + days)).toISOString().slice(0, 10);

  // Month arithmetic clamps rather than rolling over: a template that runs on the
  // 31st should recur on the 30th in April, not on the 1st of May. Date.UTC would
  // roll it over silently and the entry would land in the wrong period.
  const targetMonth = month + months;
  const lastDay = new Date(Date.UTC(year, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, targetMonth, Math.min(day, lastDay))).toISOString().slice(0, 10);
}
