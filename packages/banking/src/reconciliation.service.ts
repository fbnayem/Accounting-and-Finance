import { Pool, PoolClient } from 'pg';
import {
  AppError,
  notFound,
  uuidv7,
  D,
  assertEntityPermission,
  reconcile,
  type TenantPrincipal,
} from '@acct/domain';
import { writeInTenant, readInTenant, recordAudit } from '@acct/database';
import { loadBankAccount } from './import.service';

/**
 * Reconciliation sessions — doc 06 "Reconciliation session".
 *
 * Phase 4's second exit criterion: "bank reconciliation statement ending balance
 * equals reconciled book balance after adjustments."
 *
 * The arithmetic lives in `@acct/domain`'s `reconcile`, and the *rule* — that a
 * session may only be completed at zero or within the configured tolerance —
 * lives in the database (F-801). Both, deliberately. The service computes the
 * book balance from posted journal lines and refuses early with a message that
 * names the number; the trigger refuses whatever reaches it, including anything
 * that never came through this service. A control enforced only here would be
 * bypassed by the next module that writes the table directly, which is exactly
 * what 0011's CHECK was trusted to prevent and did not.
 */

export interface ReconciliationCreateInput {
  readonly bankAccountId: string;
  readonly statementStartDate: string;
  readonly statementEndDate: string;
  readonly statementOpeningBalance: string;
  readonly statementClosingBalance: string;
}

export class BankReconciliationService {
  constructor(private readonly pool: Pool) {}

  async create(principal: TenantPrincipal, input: ReconciliationCreateInput) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const account = await loadBankAccount(client, input.bankAccountId);
      assertEntityPermission(principal, 'bank.reconcile', account.legal_entity_id);

      if (input.statementEndDate < input.statementStartDate) {
        throw new AppError(
          'VALIDATION_FAILED',
          `The statement ends (${input.statementEndDate}) before it starts (${input.statementStartDate}).`,
        );
      }

      // doc 06 requires an opening balance that continues the last session, so a
      // gap between statements is visible rather than silently absorbed into the
      // next difference.
      const { rows: previous } = await client.query<{
        id: string;
        statement_closing_balance: string;
        statement_end_date: string;
      }>(
        `SELECT id, statement_closing_balance::text, statement_end_date::text
           FROM bank_reconciliations
          WHERE bank_account_id = $1 AND status = 'COMPLETED'
          ORDER BY statement_end_date DESC LIMIT 1`,
        [account.id],
      );
      const prior = previous[0];
      if (prior && !D(prior.statement_closing_balance).equals(D(input.statementOpeningBalance))) {
        throw new AppError(
          'VALIDATION_FAILED',
          `This statement opens at ${input.statementOpeningBalance} but the last completed ` +
            `session (to ${prior.statement_end_date}) closed at ${prior.statement_closing_balance}. ` +
            `A gap between statements has to be explained, not carried into the difference.`,
          { details: { previous_reconciliation_id: prior.id } },
        );
      }

      const id = uuidv7();
      const { rows } = await client.query(
        `INSERT INTO bank_reconciliations
           (id, tenant_id, legal_entity_id, bank_account_id, statement_start_date,
            statement_end_date, statement_opening_balance, statement_closing_balance, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'IN_PROGRESS')
         RETURNING id, status::text AS status, statement_start_date::text AS statement_start_date,
                   statement_end_date::text AS statement_end_date,
                   statement_opening_balance::text AS statement_opening_balance,
                   statement_closing_balance::text AS statement_closing_balance`,
        [
          id,
          principal.tenantId,
          account.legal_entity_id,
          account.id,
          input.statementStartDate,
          input.statementEndDate,
          input.statementOpeningBalance,
          input.statementClosingBalance,
        ],
      );

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        action: 'bank_reconciliation.started',
        resourceType: 'bank_reconciliation',
        resourceId: id,
        after: rows[0] as Record<string, unknown>,
      });

      return { ...rows[0], ...(await this.workingView(client, id)) };
    });
  }

  /**
   * doc 06's session view: statement balance, book balance, cleared items,
   * outstanding payments, deposits in transit, unresolved lines and the
   * difference.
   *
   * The book balance is computed from posted journal lines on the bank account's
   * GL account, not from a cached figure. A reconciliation that trusts a
   * projection to prove the projection proves nothing — the same reason Phase
   * 3's aging criteria read `source: 'journal_lines'`.
   */
  private async workingView(client: PoolClient, reconciliationId: string) {
    const { rows: sessions } = await client.query<{
      bank_account_id: string;
      legal_entity_id: string;
      statement_start_date: string;
      statement_end_date: string;
      statement_opening_balance: string;
      statement_closing_balance: string;
    }>(
      `SELECT bank_account_id, legal_entity_id,
              statement_start_date::text, statement_end_date::text,
              statement_opening_balance::text, statement_closing_balance::text
         FROM bank_reconciliations WHERE id = $1`,
      [reconciliationId],
    );
    const session = sessions[0];
    if (!session) throw notFound('bank_reconciliation', reconciliationId);

    const { rows: accounts } = await client.query<{ account_id: string }>(
      `SELECT account_id FROM bank_accounts WHERE id = $1`,
      [session.bank_account_id],
    );
    const glAccountId = accounts[0]?.account_id;

    const { rows: bookRows } = await client.query<{ balance: string }>(
      `SELECT coalesce(sum(l.base_debit - l.base_credit), 0)::text AS balance
         FROM journal_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id
        WHERE l.account_id = $1
          AND l.posting_date <= $2::date
          AND e.status = 'POSTED'`,
      [glAccountId, session.statement_end_date],
    );

    // The three populations a difference decomposes into (doc 06, and F-807's
    // unreconciled report reads the same query).
    const { rows: unmatched } = await client.query<{ amount: string }>(
      `SELECT amount::text AS amount
         FROM bank_transactions
        WHERE bank_account_id = $1
          AND transaction_date <= $2::date
          AND reconciliation_state NOT IN ('RECONCILED','IGNORED','SPLIT')`,
      [session.bank_account_id, session.statement_end_date],
    );

    const result = reconcile(
      {
        statementOpeningBalance: D(session.statement_opening_balance),
        statementClosingBalance: D(session.statement_closing_balance),
        bookClosingBalance: D(bookRows[0]?.balance ?? '0'),
        outstandingPayments: [],
        depositsInTransit: [],
        unexplainedStatementLines: unmatched.map((u) => D(u.amount)),
      },
      D('0'),
    );

    return {
      book_closing_balance: result.bookClosingBalance.toString(),
      difference: result.difference.toString(),
      unexplained_total: result.unexplainedTotal.toString(),
      adjusted_difference: result.adjustedDifference.toString(),
      unresolved_count: unmatched.length,
    };
  }

  async get(principal: TenantPrincipal, id: string) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT id, bank_account_id, legal_entity_id, status::text AS status,
                statement_start_date::text, statement_end_date::text,
                statement_opening_balance::text, statement_closing_balance::text,
                book_closing_balance::text, difference::text,
                completed_at, completed_by, reopened_at, reopened_by, reopen_reason
           FROM bank_reconciliations WHERE id = $1`,
        [id],
      );
      if (!rows[0]) throw notFound('bank_reconciliation', id);
      return { ...rows[0], ...(await this.workingView(client, id)) };
    });
  }

  async list(principal: TenantPrincipal, query: { bankAccountId?: string | undefined }) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT id, bank_account_id, legal_entity_id, status::text AS status,
                statement_start_date::text, statement_end_date::text,
                statement_closing_balance::text, book_closing_balance::text, difference::text,
                completed_at
           FROM bank_reconciliations
          WHERE ($1::uuid IS NULL OR bank_account_id = $1)
          ORDER BY statement_end_date DESC`,
        [query.bankAccountId ?? null],
      );
      return { data: rows };
    });
  }

  /**
   * doc 06: "finalization allowed only when difference is zero/configured
   * tolerance". F-801 — the rule nothing enforced.
   *
   * Refused here with the numbers named, and refused again by
   * `guard_reconciliation_balanced` whatever reaches the table.
   */
  async complete(principal: TenantPrincipal, id: string) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows: sessions } = await client.query<{
        legal_entity_id: string;
        status: string;
        statement_end_date: string;
        statement_closing_balance: string;
      }>(
        `SELECT legal_entity_id, status::text AS status, statement_end_date::text,
                statement_closing_balance::text
           FROM bank_reconciliations WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const session = sessions[0];
      if (!session) throw notFound('bank_reconciliation', id);
      assertEntityPermission(principal, 'bank.reconcile', session.legal_entity_id);

      if (session.status === 'COMPLETED') {
        throw new AppError(
          'POSTED_IMMUTABLE',
          `Reconciliation ${id} is already completed. Reopen it if it needs correcting.`,
        );
      }

      const view = await this.workingView(client, id);
      const tolerance = await loadTolerance(
        client,
        session.legal_entity_id,
        session.statement_end_date,
      );
      const difference = D(view.difference);

      if (difference.abs().gt(tolerance)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Reconciliation ${id} has a difference of ${difference.toString()} against a tolerance ` +
            `of ${tolerance.toString()}. ${view.unresolved_count} bank transaction(s) are still ` +
            `unmatched. doc 06 permits finalization only at zero or within tolerance.`,
          {
            details: {
              difference: difference.toString(),
              tolerance: tolerance.toString(),
              unresolved_count: view.unresolved_count,
            },
          },
        );
      }

      const { rows } = await client.query(
        `UPDATE bank_reconciliations
            SET status = 'COMPLETED', book_closing_balance = $2, difference = $3,
                completed_at = now(), completed_by = $4
          WHERE id = $1
        RETURNING id, status::text AS status, book_closing_balance::text, difference::text,
                  completed_at`,
        [id, view.book_closing_balance, view.difference, principal.userId],
      );

      // Everything cleared by this session is now reconciled, which is what
      // stops it appearing in the next session's unresolved list.
      const { rowCount } = await client.query(
        `UPDATE bank_transactions t
            SET reconciliation_state = 'RECONCILED'
           FROM bank_matches m
          WHERE m.bank_transaction_id = t.id
            AND m.bank_reconciliation_id = $1
            AND m.status = 'CONFIRMED'`,
        [id],
      );

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        action: 'bank_reconciliation.completed',
        resourceType: 'bank_reconciliation',
        resourceId: id,
        after: { ...(rows[0] as Record<string, unknown>), cleared: rowCount },
      });

      return { ...rows[0], cleared: rowCount };
    });
  }

  /**
   * doc 06: "finalized session is locked; correction uses reopen permission".
   *
   * A separate high-risk permission and a mandatory reason, because reopening a
   * completed reconciliation is how a balanced period stops being balanced.
   */
  async reopen(principal: TenantPrincipal, id: string, input: { reason: string }) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows: sessions } = await client.query<{ legal_entity_id: string; status: string }>(
        `SELECT legal_entity_id, status::text AS status FROM bank_reconciliations
          WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const session = sessions[0];
      if (!session) throw notFound('bank_reconciliation', id);
      assertEntityPermission(principal, 'bank.reconcile_reopen', session.legal_entity_id);

      if (session.status !== 'COMPLETED') {
        throw new AppError(
          'VALIDATION_FAILED',
          `Reconciliation ${id} is ${session.status}; only a COMPLETED session can be reopened.`,
        );
      }
      if (!input.reason?.trim()) {
        throw new AppError(
          'VALIDATION_FAILED',
          'A reason is required. `recon_reopen_has_reason` refuses the row without one, and the ' +
            'reason is the whole audit value of the reopen workflow.',
        );
      }

      const { rows } = await client.query(
        `UPDATE bank_reconciliations
            SET status = 'REOPENED', reopened_at = now(), reopened_by = $2, reopen_reason = $3
          WHERE id = $1
        RETURNING id, status::text AS status, reopened_at, reopen_reason`,
        [id, principal.userId, input.reason.trim()],
      );

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        action: 'bank_reconciliation.reopened',
        resourceType: 'bank_reconciliation',
        resourceId: id,
        after: rows[0] as Record<string, unknown>,
      });

      return rows[0];
    });
  }

  /**
   * F-807 — doc 06's Unreconciled Transactions report and doc 21's
   * "unreconciled/uncleared reports", neither of which had a route.
   */
  async unreconciled(
    principal: TenantPrincipal,
    query: { legalEntityId?: string | undefined; asOf?: string | undefined },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT t.id, t.bank_account_id, a.name AS bank_account_name,
                t.transaction_date::text, t.currency, t.amount::text AS amount,
                t.description, t.counterparty_name, t.reference,
                t.reconciliation_state::text AS reconciliation_state,
                CASE WHEN t.amount > 0 THEN 'DEPOSIT_IN_TRANSIT' ELSE 'OUTSTANDING_PAYMENT' END
                  AS population
           FROM bank_transactions t
           JOIN bank_accounts a ON a.id = t.bank_account_id
          WHERE ($1::uuid IS NULL OR t.legal_entity_id = $1)
            AND ($2::date IS NULL OR t.transaction_date <= $2::date)
            AND t.reconciliation_state NOT IN ('RECONCILED','IGNORED','SPLIT')
          ORDER BY t.transaction_date, t.created_at`,
        [query.legalEntityId ?? null, query.asOf ?? null],
      );

      const total = rows.reduce((sum, r) => sum.add(D(r.amount as string)), D('0'));
      return {
        as_of: query.asOf ?? null,
        rows,
        outstanding_payments: rows.filter((r) => r.population === 'OUTSTANDING_PAYMENT').length,
        deposits_in_transit: rows.filter((r) => r.population === 'DEPOSIT_IN_TRANSIT').length,
        net_unreconciled: total.toString(),
      };
    });
  }
}

/**
 * `accounting_policies.bank_reconciliation_tolerance`, effective on the
 * statement end date.
 *
 * Absent policy is not permission to skip the rule; doc 06's default is zero,
 * and `guard_reconciliation_balanced` makes the same choice independently.
 */
export async function loadTolerance(
  client: PoolClient,
  legalEntityId: string,
  onDate: string,
): Promise<ReturnType<typeof D>> {
  const { rows } = await client.query<{ tolerance: string }>(
    `SELECT bank_reconciliation_tolerance::text AS tolerance
       FROM accounting_policies
      WHERE legal_entity_id = $1
        AND valid_from <= $2::date
        AND (valid_to IS NULL OR valid_to > $2::date)
      ORDER BY valid_from DESC LIMIT 1`,
    [legalEntityId, onDate],
  );
  return D(rows[0]?.tolerance ?? '0');
}
