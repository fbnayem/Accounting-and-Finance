/**
 * Account reconciliation — the artifact Gate D asserts on: "any difference is
 * either zero or represented by an explicit, explainable reconciliation item."
 *
 * Two decisions here are worth stating plainly, because both were defects in the
 * shape the audit found:
 *
 *   - **The GL balance is computed, never accepted.** A reconciliation whose GL
 *     side is whatever the caller said it was proves that the caller can type. It
 *     is summed from journal lines, in the same period ordering
 *     `LedgerProjectionService` uses — by (fiscal year start, period_no) and not by
 *     date, because an adjustment period shares period 12's end date by design
 *     (F-011) and a date filter would include or exclude it arbitrarily.
 *   - **Certification is NULL-safe.** `recon_sod` is `approved_by IS NULL OR
 *     approved_by <> prepared_by`, and against a NULL preparer that comparison is
 *     NULL — which satisfies a CHECK. So a reconciliation prepared by nobody could
 *     be certified by anybody and the constraint would agree. It is refused here by
 *     name, and `reconciliationSatisfaction` refuses to count such a row towards a
 *     close even if one exists.
 */
import { Pool, PoolClient } from 'pg';
import {
  AppError,
  D,
  assertEntityPermission,
  entityScope,
  notFound,
  uuidv7,
  type TenantPrincipal,
} from '@acct/domain';
import { publish, readInTenant, recordAudit, writeInTenant } from '@acct/database';
import {
  assertSameEntity,
  assertSameTenant,
  collectChecklist,
  loadBook,
  loadCloseRun,
  loadPeriod,
  persistReadiness,
} from './internals';

export interface CreateReconciliationInput {
  readonly legalEntityId: string;
  readonly accountingBookId: string;
  readonly accountingPeriodId: string;
  readonly accountId: string;
  /**
   * The subledger / supporting schedule total, as an exact decimal string in the
   * ledger's own convention: debits positive, credits negative.
   */
  readonly supportingBalance: string;
  readonly closeRunId?: string | undefined;
}

export interface ListReconciliationsQuery {
  readonly legalEntityId?: string | undefined;
  readonly accountingBookId?: string | undefined;
  readonly accountingPeriodId?: string | undefined;
  readonly closeRunId?: string | undefined;
  readonly status?: string | undefined;
}

/**
 * The closing GL balance of an account on a book, as at the end of a period.
 *
 * Debit-positive. REVERSED entries are included for the reason
 * `LedgerProjectionService` documents: 0006 permits POSTED -> REVERSED on the
 * original entry and never deletes its lines, so excluding them would count one
 * half of every matched pair.
 */
export async function glBalanceAsAt(
  client: PoolClient,
  input: { accountingBookId: string; accountId: string; accountingPeriodId: string },
): Promise<string> {
  const { rows } = await client.query<{ balance: string }>(
    `SELECT coalesce(sum(l.base_debit - l.base_credit), 0)::text AS balance
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.journal_entry_id
       JOIN accounting_periods p ON p.id = l.accounting_period_id
       JOIN fiscal_years fy ON fy.id = p.fiscal_year_id
      WHERE l.accounting_book_id = $1
        AND l.account_id = $2
        AND e.status IN ('POSTED', 'REVERSED')
        AND (fy.start_date, p.period_no) <= (
              SELECT fy2.start_date, p2.period_no
                FROM accounting_periods p2
                JOIN fiscal_years fy2 ON fy2.id = p2.fiscal_year_id
               WHERE p2.id = $3
            )`,
    [input.accountingBookId, input.accountId, input.accountingPeriodId],
  );
  return rows[0]?.balance ?? '0';
}

/** The sum of the explanations offered for a difference. */
export async function reconcilingItemsTotal(
  client: PoolClient,
  reconciliationId: string,
): Promise<{ total: string; count: number }> {
  const { rows } = await client.query<{ total: string; count: string }>(
    `SELECT coalesce(sum(amount), 0)::text AS total, count(*)::text AS count
       FROM reconciling_items WHERE account_reconciliation_id = $1`,
    [reconciliationId],
  );
  return { total: rows[0]?.total ?? '0', count: Number(rows[0]?.count ?? '0') };
}

export class AccountReconciliationService {
  constructor(private readonly pool: Pool) {}

  /** `createAccountReconciliation` — POST /account-reconciliations. */
  async create(principal: TenantPrincipal, input: CreateReconciliationInput) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      assertEntityPermission(principal, 'reconciliation.manage', input.legalEntityId);

      const book = await loadBook(client, input.accountingBookId);
      assertSameTenant('Accounting book', principal.tenantId, book.tenant_id);
      assertSameEntity('Accounting book', input.legalEntityId, book.legal_entity_id);

      const period = await loadPeriod(client, input.accountingPeriodId);
      assertSameTenant('Accounting period', principal.tenantId, period.tenant_id);
      assertSameEntity('Accounting period', input.legalEntityId, period.legal_entity_id);

      const { rows: accounts } = await client.query<{
        id: string;
        tenant_id: string;
        legal_entity_id: string;
        code: string;
        name: string;
        normal_balance: string;
        is_control: boolean;
      }>(
        `SELECT id, tenant_id, legal_entity_id, code, name, normal_balance::text AS normal_balance,
                is_control
           FROM accounts WHERE id = $1`,
        [input.accountId],
      );
      const account = accounts[0];
      if (!account) throw notFound('Account', input.accountId);
      assertSameTenant('Account', principal.tenantId, account.tenant_id);
      assertSameEntity('Account', input.legalEntityId, account.legal_entity_id, {
        account_id: account.id,
      });

      if (input.closeRunId) {
        const run = await loadCloseRun(client, input.closeRunId);
        assertSameEntity('Close run', input.legalEntityId, run.legal_entity_id);
        if (run.accounting_book_id !== book.id || run.accounting_period_id !== period.id) {
          throw new AppError(
            'VALIDATION_FAILED',
            `Close run ${run.id} is for a different book or period, so this reconciliation would be ` +
              `counted towards a close it does not belong to.`,
          );
        }
      }

      // Exact decimal throughout (ADR-0006 §1). `recon_difference_derived` will
      // reject any difference that is not gl - supporting, so it is computed here
      // and never taken from the caller.
      const glBalance = await glBalanceAsAt(client, {
        accountingBookId: book.id,
        accountId: account.id,
        accountingPeriodId: period.id,
      });
      const supporting = D(input.supportingBalance);
      const difference = D(glBalance).sub(supporting);

      const { rows: existingRows } = await client.query<{
        id: string;
        status: string;
        prepared_by: string | null;
      }>(
        `SELECT id, status::text AS status, prepared_by
           FROM account_reconciliations
          WHERE accounting_book_id = $1 AND accounting_period_id = $2 AND account_id = $3
          FOR UPDATE`,
        [book.id, period.id, account.id],
      );
      const existing = existingRows[0];

      let id: string;
      let before: Record<string, unknown> | undefined;
      if (existing) {
        if (existing.status === 'CERTIFIED' || existing.status === 'APPROVED') {
          throw new AppError(
            'POSTED_IMMUTABLE',
            `Account ${account.code} is already reconciled and certified for ${period.name}. ` +
              `doc 12: an approved reconciliation is immutable unless formally reopened with a ` +
              `reason (POST /account-reconciliations/{id}/reopen).`,
            { details: { account_reconciliation_id: existing.id } },
          );
        }
        id = existing.id;
        before = { status: existing.status };
        await client.query(
          `UPDATE account_reconciliations
              SET gl_balance = $2::numeric, supporting_balance = $3::numeric,
                  difference = $4::numeric, status = 'PREPARED',
                  prepared_by = $5, prepared_at = now(),
                  close_run_id = coalesce($6, close_run_id)
            WHERE id = $1`,
          [
            id,
            glBalance,
            supporting.toString(),
            difference.toString(),
            principal.userId,
            input.closeRunId ?? null,
          ],
        );
      } else {
        id = uuidv7();
        await client.query(
          `INSERT INTO account_reconciliations
             (id, tenant_id, legal_entity_id, accounting_book_id, accounting_period_id, account_id,
              close_run_id, gl_balance, supporting_balance, difference, currency, status,
              prepared_by, prepared_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9::numeric,$10::numeric,$11,'PREPARED',$12,now())`,
          [
            id,
            principal.tenantId,
            input.legalEntityId,
            book.id,
            period.id,
            account.id,
            input.closeRunId ?? null,
            glBalance,
            supporting.toString(),
            difference.toString(),
            book.base_currency,
            principal.userId,
          ],
        );
      }

      const items = await reconcilingItemsTotal(client, id);
      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: input.legalEntityId,
        action: 'account_reconciliation.prepared',
        resourceType: 'account_reconciliation',
        resourceId: id,
        before,
        after: {
          account_code: account.code,
          gl_balance: glBalance,
          supporting_balance: supporting.toString(),
          difference: difference.toString(),
          status: 'PREPARED',
        },
      });

      return {
        id,
        legal_entity_id: input.legalEntityId,
        accounting_book_id: book.id,
        accounting_period_id: period.id,
        account_id: account.id,
        account_code: account.code,
        account_name: account.name,
        normal_balance: account.normal_balance,
        is_control: account.is_control,
        close_run_id: input.closeRunId ?? null,
        currency: book.base_currency,
        gl_balance: glBalance,
        supporting_balance: supporting.toString(),
        difference: difference.toString(),
        reconciling_items_total: items.total,
        reconciling_items_count: items.count,
        explained: D(items.total).equals(difference),
        status: 'PREPARED',
        prepared_by: principal.userId,
      };
    });
  }

  /** `listAccountReconciliations` — GET /account-reconciliations. Gate D's read. */
  async list(principal: TenantPrincipal, query: ListReconciliationsQuery = {}) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const where = ['r.tenant_id = $1'];
      const params: unknown[] = [principal.tenantId];

      if (query.legalEntityId) {
        assertEntityPermission(principal, 'reconciliation.view', query.legalEntityId);
        params.push(query.legalEntityId);
        where.push(`r.legal_entity_id = $${params.length}`);
      } else {
        const scope = entityScope(principal);
        if (scope.kind === 'ENTITIES') {
          params.push(scope.legalEntityIds);
          where.push(`r.legal_entity_id = ANY($${params.length}::uuid[])`);
        }
      }
      if (query.accountingBookId) {
        params.push(query.accountingBookId);
        where.push(`r.accounting_book_id = $${params.length}`);
      }
      if (query.accountingPeriodId) {
        params.push(query.accountingPeriodId);
        where.push(`r.accounting_period_id = $${params.length}`);
      }
      if (query.closeRunId) {
        params.push(query.closeRunId);
        where.push(`r.close_run_id = $${params.length}`);
      }
      if (query.status) {
        params.push(query.status);
        where.push(`r.status = $${params.length}::recon_cert_status`);
      }

      const { rows } = await client.query(
        `SELECT r.id, r.legal_entity_id, r.accounting_book_id, r.accounting_period_id,
                p.name AS period_name, r.account_id, a.code AS account_code, a.name AS account_name,
                a.is_control, a.normal_balance::text AS normal_balance,
                r.close_run_id, r.currency,
                r.gl_balance::text AS gl_balance,
                r.supporting_balance::text AS supporting_balance,
                r.difference::text AS difference,
                r.status::text AS status, r.prepared_by, r.prepared_at,
                r.approved_by, r.approved_at, r.reopened_reason, r.created_at,
                coalesce(i.total, 0)::text AS reconciling_items_total,
                coalesce(i.count, 0)::int  AS reconciling_items_count,
                coalesce(i.unresolved, 0)::int AS reconciling_items_unresolved
           FROM account_reconciliations r
           JOIN accounts a ON a.id = r.account_id
           JOIN accounting_periods p ON p.id = r.accounting_period_id
           LEFT JOIN LATERAL (
             SELECT sum(ri.amount) AS total, count(*) AS count,
                    count(*) FILTER (WHERE ri.resolved_at IS NULL) AS unresolved
               FROM reconciling_items ri
              WHERE ri.account_reconciliation_id = r.id
           ) i ON true
          WHERE ${where.join(' AND ')}
          ORDER BY p.start_date DESC, a.code
          LIMIT 500`,
        params,
      );

      // `explained` is Gate D's question, answered per row: the difference is zero
      // or the items account for it exactly.
      const data = rows.map((row) => ({
        ...row,
        explained: D(row.reconciling_items_total as string).equals(D(row.difference as string)),
      }));
      return { data };
    });
  }

  /** `certifyAccountReconciliation` — POST /account-reconciliations/{id}/certify. */
  async certify(principal: TenantPrincipal, id: string, input: { note?: string | undefined } = {}) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows } = await client.query<{
        id: string;
        legal_entity_id: string;
        accounting_book_id: string;
        accounting_period_id: string;
        account_id: string;
        status: string;
        difference: string;
        prepared_by: string | null;
        approved_by: string | null;
        close_run_id: string | null;
      }>(
        `SELECT id, legal_entity_id, accounting_book_id, accounting_period_id, account_id,
                status::text AS status, difference::text AS difference,
                prepared_by, approved_by, close_run_id
           FROM account_reconciliations WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const recon = rows[0];
      if (!recon) throw notFound('Account reconciliation', id);
      assertEntityPermission(principal, 'reconciliation.certify', recon.legal_entity_id);

      if (recon.status === 'CERTIFIED' || recon.status === 'APPROVED') {
        throw new AppError(
          'POSTED_IMMUTABLE',
          `Reconciliation ${id} is already ${recon.status}. doc 12: a certified reconciliation is ` +
            `immutable unless formally reopened with a reason.`,
        );
      }

      // The NULL case, refused explicitly. `recon_sod` cannot catch it: a
      // comparison against a NULL preparer is NULL, and a CHECK accepts NULL.
      if (recon.prepared_by === null) {
        throw new AppError(
          'SEGREGATION_OF_DUTIES',
          `Reconciliation ${id} records no preparer, so nothing can show that the person certifying ` +
            `it and the person who prepared it are different people. Prepare it first ` +
            `(POST /account-reconciliations), then certify.`,
          { details: { account_reconciliation_id: id } },
        );
      }
      if (recon.prepared_by === principal.userId) {
        throw new AppError(
          'SEGREGATION_OF_DUTIES',
          `Reconciliation ${id} was prepared by you. doc 12 requires the preparer and the certifier ` +
            `to be different people, and \`recon_sod\` refuses the row.`,
          { details: { account_reconciliation_id: id, user_id: principal.userId } },
        );
      }

      // Gate D, refused here as well as by `account_reconciliations_explained` at
      // COMMIT: the deferred trigger's message is not currently mapped to an error
      // code, so without this the caller would receive a 500 for a correct refusal.
      const items = await reconcilingItemsTotal(client, id);
      const difference = D(recon.difference);
      if (!D(items.total).equals(difference)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Reconciliation ${id} has a difference of ${difference.toString()} and reconciling items ` +
            `totalling ${items.total} (${items.count} item(s)). Gate D requires the difference to be ` +
            `zero or explained exactly: add or correct the reconciling items ` +
            `(POST /account-reconciliations/{id}/reconciling-items) so they sum to the difference.`,
          {
            details: {
              account_reconciliation_id: id,
              difference: difference.toString(),
              items_total: items.total,
            },
          },
        );
      }

      const { rows: updated } = await client.query<{
        id: string;
        status: string;
        approved_at: string;
        approved_by: string;
      }>(
        `UPDATE account_reconciliations
            SET status = 'CERTIFIED', approved_by = $2, approved_at = now()
          WHERE id = $1
        RETURNING id, status::text AS status, approved_at, approved_by`,
        [id, principal.userId],
      );

      // The close dashboard's number moves when the work does, not when somebody
      // remembers to refresh it.
      const runId = recon.close_run_id ?? (await liveCloseRunId(client, recon));
      if (runId) {
        const run = await loadCloseRun(client, runId);
        const checklist = await collectChecklist(client, run);
        await persistReadiness(client, run, checklist.readiness);
      }

      await publish(client, context, {
        eventType: 'account_reconciliation.certified',
        aggregateType: 'account_reconciliation',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: recon.legal_entity_id,
        accountingBookId: recon.accounting_book_id,
        payload: {
          account_id: recon.account_id,
          accounting_period_id: recon.accounting_period_id,
          difference: difference.toString(),
          reconciling_items: items.count,
          prepared_by: recon.prepared_by,
          certified_by: principal.userId,
        },
      });
      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: recon.legal_entity_id,
        action: 'account_reconciliation.certified',
        resourceType: 'account_reconciliation',
        resourceId: id,
        reason: input.note ?? null,
        before: { status: recon.status },
        after: {
          status: 'CERTIFIED',
          difference: difference.toString(),
          items_total: items.total,
          prepared_by: recon.prepared_by,
          certified_by: principal.userId,
        },
      });

      return {
        ...updated[0]!,
        close_run_id: runId,
        difference: difference.toString(),
        reconciling_items_total: items.total,
        reconciling_items_count: items.count,
        prepared_by: recon.prepared_by,
      };
    });
  }

  /**
   * `reopenAccountReconciliation` — POST /account-reconciliations/{id}/reopen.
   *
   * doc 12: "Approved reconciliation is immutable unless formally reopened with
   * reason." The banking twin (`reopenBankReconciliation`) has existed since
   * Phase 4 and this is the same act on the Gate D artifact: a separate
   * high-risk permission (`reconciliation.reopen`, so ADR-0005 §3 forces
   * re-authentication), a mandatory reason, an audit row and the
   * `account_reconciliation.reopened` event. Without it, a certified
   * reconciliation whose items turned out to be wrong had no lawful correction
   * path — which is the condition under which somebody reaches for the DELETE
   * privilege on reconciling_items instead.
   *
   * The withdrawn approval is NULLed rather than left in place: after the
   * reopen the row must not claim an approval it no longer has, and the
   * certification that follows re-preparation records its own.
   */
  async reopen(principal: TenantPrincipal, id: string, input: { reason: string }) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows } = await client.query<{
        id: string;
        legal_entity_id: string;
        accounting_book_id: string;
        accounting_period_id: string;
        account_id: string;
        status: string;
        difference: string;
        prepared_by: string | null;
        approved_by: string | null;
        close_run_id: string | null;
      }>(
        `SELECT id, legal_entity_id, accounting_book_id, accounting_period_id, account_id,
                status::text AS status, difference::text AS difference,
                prepared_by, approved_by, close_run_id
           FROM account_reconciliations WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const recon = rows[0];
      if (!recon) throw notFound('Account reconciliation', id);
      assertEntityPermission(principal, 'reconciliation.reopen', recon.legal_entity_id);

      if (recon.status !== 'CERTIFIED' && recon.status !== 'APPROVED') {
        throw new AppError(
          'VALIDATION_FAILED',
          `Reconciliation ${id} is ${recon.status}; only a CERTIFIED or APPROVED reconciliation ` +
            `can be reopened. One that has not been certified is still open to correction ` +
            `directly (POST /account-reconciliations).`,
        );
      }
      const reason = (input.reason ?? '').trim();
      if (!reason) {
        throw new AppError(
          'VALIDATION_FAILED',
          'A reason is required to reopen a certified reconciliation. doc 12: "immutable unless ' +
            'formally reopened with reason" — the reason is the whole audit value of the reopen.',
          { fieldErrors: [{ field: 'reason', code: 'REQUIRED', message: 'a reason is required' }] },
        );
      }

      const { rows: updated } = await client.query<{ id: string; status: string }>(
        `UPDATE account_reconciliations
            SET status = 'REOPENED', reopened_reason = $2, approved_by = NULL, approved_at = NULL
          WHERE id = $1
        RETURNING id, status::text AS status`,
        [id, reason],
      );

      // The close this reconciliation counted towards is no longer ready, and
      // the dashboard's number must move now — the same recomputation certify
      // performs, in the other direction. `persistReadiness` never touches a
      // COMPLETED run; superseding a completed close is reopenCloseRun's job.
      const runId = recon.close_run_id ?? (await liveCloseRunId(client, recon));
      if (runId) {
        const run = await loadCloseRun(client, runId);
        const checklist = await collectChecklist(client, run);
        await persistReadiness(client, run, checklist.readiness);
      }

      await publish(client, context, {
        eventType: 'account_reconciliation.reopened',
        aggregateType: 'account_reconciliation',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: recon.legal_entity_id,
        accountingBookId: recon.accounting_book_id,
        payload: {
          account_id: recon.account_id,
          accounting_period_id: recon.accounting_period_id,
          previous_status: recon.status,
          withdrawn_certifier: recon.approved_by,
          reopened_by: principal.userId,
          reason,
        },
      });
      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: recon.legal_entity_id,
        action: 'account_reconciliation.reopened',
        resourceType: 'account_reconciliation',
        resourceId: id,
        reason,
        before: { status: recon.status, approved_by: recon.approved_by },
        after: { status: 'REOPENED', reopened_reason: reason, reopened_by: principal.userId },
      });

      return {
        ...updated[0]!,
        previous_status: recon.status,
        reopened_reason: reason,
        reopened_by: principal.userId,
        close_run_id: runId,
        difference: recon.difference,
        prepared_by: recon.prepared_by,
      };
    });
  }
}

/** The close run this reconciliation counts towards, when it was not linked at creation. */
async function liveCloseRunId(
  client: PoolClient,
  recon: { accounting_book_id: string; accounting_period_id: string },
): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM close_runs
      WHERE accounting_book_id = $1 AND accounting_period_id = $2 AND status <> 'REOPENED'
      ORDER BY version DESC LIMIT 1`,
    [recon.accounting_book_id, recon.accounting_period_id],
  );
  return rows[0]?.id ?? null;
}
