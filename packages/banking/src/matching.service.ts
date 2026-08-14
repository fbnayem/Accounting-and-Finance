import { Pool, PoolClient } from 'pg';
import {
  AppError,
  notFound,
  uuidv7,
  D,
  assertEntityPermission,
  scoreCandidate,
  AUTO_MATCH_THRESHOLD,
  CANDIDATE_FLOOR,
  accountingDate,
  type TenantPrincipal,
} from '@acct/domain';
import { writeInTenant, readInTenant, recordAudit } from '@acct/database';
import { loadBankAccount } from './import.service';

/**
 * Candidate matching and categorization — doc 06 "Matching engine", "Bank rules",
 * "Categorization".
 *
 * Phase 4's fifth exit criterion is the one that shapes this file: "matching
 * suggestions never post without configured automation/approval policy." So a
 * suggestion is inert by construction. `bank_matches.status` starts SUGGESTED,
 * nothing is posted from a suggestion, and the only path to CONFIRMED is either
 * an explicit human confirm or a rule whose `auto_apply` the tenant switched on
 * *and* a deterministic exact match. Two conditions, both required — a high
 * score alone is never enough, which is why `scoreCandidate` reports `exact`
 * separately from `score`.
 */

export interface MatchTarget {
  readonly targetType: string;
  readonly targetId: string;
  readonly matchedAmount: string;
}

const TARGET_TYPES = new Set([
  'CUSTOMER_RECEIPT',
  'VENDOR_PAYMENT',
  'INVOICE',
  'VENDOR_BILL',
  'JOURNAL_ENTRY',
  'BANK_TRANSFER',
  'SETTLEMENT_BATCH',
  'CUSTOMER_REFUND',
]);

export class BankMatchingService {
  constructor(private readonly pool: Pool) {}

  /**
   * doc 06's candidate sources, scored by `@acct/domain`'s weighted model.
   *
   * Open invoices and bills are the two that matter for a first release; the
   * remaining sources doc 06 lists (transfers, manual journals, clearing
   * batches, payroll) are reachable through the same shape and are queried here
   * as they become populated by their own phases.
   */
  async candidates(principal: TenantPrincipal, bankTransactionId: string) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const txn = await loadTransaction(client, bankTransactionId);
      assertEntityPermission(principal, 'bank.view', txn.legal_entity_id);

      const incoming = D(txn.amount).isPositive();
      const rows = incoming
        ? await client.query(
            `SELECT i.id AS target_id, 'INVOICE' AS target_type, i.invoice_number AS reference,
                    i.amount_due::text AS amount, i.currency, i.due_date::text AS date,
                    c.legal_name AS counterparty
               FROM invoices i JOIN contacts c ON c.id = i.customer_id
              WHERE i.legal_entity_id = $1 AND i.amount_due > 0
                AND i.status IN ('POSTED','PARTIALLY_PAID')
              ORDER BY abs(i.amount_due - $2::numeric) LIMIT 50`,
            [txn.legal_entity_id, D(txn.amount).abs().toString()],
          )
        : await client.query(
            `SELECT b.id AS target_id, 'VENDOR_BILL' AS target_type,
                    b.vendor_invoice_number AS reference, b.amount_due::text AS amount,
                    b.currency, b.due_date::text AS date, c.legal_name AS counterparty
               FROM vendor_bills b JOIN contacts c ON c.id = b.vendor_id
              WHERE b.legal_entity_id = $1 AND b.amount_due > 0
                AND b.status IN ('POSTED','PARTIALLY_PAID')
              ORDER BY abs(b.amount_due - $2::numeric) LIMIT 50`,
            [txn.legal_entity_id, D(txn.amount).abs().toString()],
          );

      const transaction = {
        amount: D(txn.amount),
        currency: txn.currency,
        date: accountingDate(txn.transaction_date),
        counterpartyName: txn.counterparty_name,
        reference: [txn.reference, txn.description].filter(Boolean).join(' ') || null,
      };

      const scored = rows.rows
        .map((r) => {
          const score = scoreCandidate(transaction, {
            amount: D(r.amount as string),
            currency: r.currency as string,
            date: accountingDate(r.date as string),
            counterpartyName: (r.counterparty as string) ?? null,
            reference: (r.reference as string) ?? null,
          });
          return {
            target_type: r.target_type,
            target_id: r.target_id,
            reference: r.reference,
            counterparty: r.counterparty,
            amount: r.amount,
            currency: r.currency,
            date: r.date,
            score: score.score,
            factors: score.factors,
            exact: score.exact,
            // Stated per candidate rather than inferred by the caller: whether
            // this one *could* be auto-confirmed is a property of the match, and
            // whether it *will* be is a property of policy.
            auto_matchable: score.exact && score.score >= AUTO_MATCH_THRESHOLD,
          };
        })
        .filter((c) => c.score >= CANDIDATE_FLOOR)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);

      return {
        bank_transaction_id: bankTransactionId,
        amount: txn.amount,
        direction: incoming ? 'INCOMING' : 'OUTGOING',
        candidates: scored,
        // Never posted from here. doc 06: AI ranking and deterministic scoring
        // both produce suggestions; accounting validation is not theirs to skip.
        note: 'Suggestions only. Confirming a match is a separate, permissioned action.',
      };
    });
  }

  /**
   * Confirms a match — the human half of exit criterion 5.
   *
   * doc 21's dependency rule: "Phase 4 banking consumes AR/AP payment allocation
   * services instead of editing customer/vendor balances." So this records the
   * link and marks the bank line matched; it does not touch `amount_due`. The
   * settlement that moves it is an AR/AP action with its own posting, and having
   * two places that decide what settling an invoice means is precisely the
   * second-posting-path problem `@acct/ledger` exists to prevent.
   */
  async confirm(
    principal: TenantPrincipal,
    bankTransactionId: string,
    input: { targets: readonly MatchTarget[]; reconciliationId?: string | null | undefined },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const txn = await loadTransaction(client, bankTransactionId);
      assertEntityPermission(principal, 'bank.reconcile', txn.legal_entity_id);

      if (input.targets.length === 0) {
        throw new AppError('VALIDATION_FAILED', 'A match must name at least one target.');
      }
      for (const t of input.targets) {
        if (!TARGET_TYPES.has(t.targetType)) {
          throw new AppError(
            'VALIDATION_FAILED',
            `"${t.targetType}" is not a match target. Accepted: ${[...TARGET_TYPES].join(', ')}.`,
          );
        }
      }

      // Bounded here with the numbers named; `bank_matches_bounded` asserts it
      // again at COMMIT, and `assert_split_parent_unmatched` refuses a parent.
      const total = input.targets.reduce((sum, t) => sum.add(D(t.matchedAmount)), D('0'));
      if (total.abs().gt(D(txn.amount).abs())) {
        throw new AppError(
          'OVER_ALLOCATION',
          `The matches total ${total.toString()} against a bank transaction of ${txn.amount}.`,
        );
      }

      const created: unknown[] = [];
      for (const t of input.targets) {
        const { rows } = await client.query(
          `INSERT INTO bank_matches
             (id, tenant_id, legal_entity_id, bank_transaction_id, bank_reconciliation_id,
              target_type, target_id, matched_amount, match_method, status, approved_by, approved_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'MANUAL','CONFIRMED',$9, now())
           ON CONFLICT (bank_transaction_id, target_type, target_id)
             WHERE status = 'CONFIRMED' DO NOTHING
           RETURNING id, target_type, target_id, matched_amount::text AS matched_amount,
                     status::text AS status`,
          [
            uuidv7(),
            principal.tenantId,
            txn.legal_entity_id,
            bankTransactionId,
            input.reconciliationId ?? null,
            t.targetType,
            t.targetId,
            t.matchedAmount,
            principal.userId,
          ],
        );
        if (rows[0]) created.push(rows[0]);
      }

      const fullyMatched = total.abs().equals(D(txn.amount).abs());
      await client.query(`UPDATE bank_transactions SET reconciliation_state = $2 WHERE id = $1`, [
        bankTransactionId,
        fullyMatched ? 'MATCHED' : 'SUGGESTED',
      ]);

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        action: 'bank_transaction.matched',
        resourceType: 'bank_transaction',
        resourceId: bankTransactionId,
        after: { matches: created, fully_matched: fullyMatched },
      });

      return {
        bank_transaction_id: bankTransactionId,
        matches: created,
        fully_matched: fullyMatched,
      };
    });
  }

  /**
   * doc 06 "Categorization": an unmatched line becomes a draft transaction on an
   * account the user picks, and "posting follows normal journal/event path".
   *
   * Recorded as a JOURNAL_ENTRY-targeted match against a draft the caller posts
   * through the ledger, rather than posting here — the same rule as everywhere
   * else in this phase.
   */
  async categorize(
    principal: TenantPrincipal,
    bankTransactionId: string,
    input: { accountId: string; description?: string | undefined },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const txn = await loadTransaction(client, bankTransactionId);
      assertEntityPermission(principal, 'bank.categorize', txn.legal_entity_id);

      const { rows: accounts } = await client.query<{ id: string; is_posting: boolean }>(
        `SELECT id, is_posting FROM accounts WHERE id = $1 AND legal_entity_id = $2`,
        [input.accountId, txn.legal_entity_id],
      );
      const account = accounts[0];
      if (!account) throw notFound('account', input.accountId);
      if (!account.is_posting) {
        throw new AppError(
          'ACCOUNT_NOT_POSTABLE',
          `Account ${input.accountId} is a heading; a categorised transaction must reach a posting account.`,
        );
      }

      await client.query(`UPDATE bank_transactions SET category_code = $2 WHERE id = $1`, [
        bankTransactionId,
        input.accountId,
      ]);

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        action: 'bank_transaction.categorized',
        resourceType: 'bank_transaction',
        resourceId: bankTransactionId,
        after: { account_id: input.accountId, description: input.description ?? null },
      });

      return {
        bank_transaction_id: bankTransactionId,
        account_id: input.accountId,
        posted: false,
        note: 'Categorised. Posting follows the normal journal path and is a separate action.',
      };
    });
  }

  /**
   * doc 06 split handling.
   *
   * The parts must sum to the whole — asserted here with the numbers, and again
   * at COMMIT by `assert_split_children_sum` (F-803). The parent moves to SPLIT
   * and becomes unmatchable, which is the other half of not double-counting cash.
   */
  async split(
    principal: TenantPrincipal,
    bankTransactionId: string,
    input: { parts: readonly { amount: string; description?: string | undefined }[] },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const txn = await loadTransaction(client, bankTransactionId);
      assertEntityPermission(principal, 'bank.categorize', txn.legal_entity_id);

      if (input.parts.length < 2) {
        throw new AppError('VALIDATION_FAILED', 'A split needs at least two parts.');
      }
      if (txn.parent_transaction_id) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Bank transaction ${bankTransactionId} is already part of a split; split the parent instead.`,
        );
      }

      const total = input.parts.reduce((sum, p) => sum.add(D(p.amount)), D('0'));
      if (!total.equals(D(txn.amount))) {
        throw new AppError(
          'VALIDATION_FAILED',
          `The parts sum to ${total.toString()} but the transaction is ${txn.amount}. ` +
            `A split divides a bank line; it does not change what the bank said.`,
        );
      }

      const children: unknown[] = [];
      for (const [i, part] of input.parts.entries()) {
        const { rows } = await client.query(
          `INSERT INTO bank_transactions
             (id, tenant_id, legal_entity_id, bank_account_id, bank_statement_id,
              transaction_date, value_date, currency, amount, description,
              counterparty_name, reference, fingerprint, import_sequence, parent_transaction_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING id, amount::text AS amount, description`,
          [
            uuidv7(),
            principal.tenantId,
            txn.legal_entity_id,
            txn.bank_account_id,
            txn.bank_statement_id,
            txn.transaction_date,
            txn.value_date,
            txn.currency,
            part.amount,
            part.description ?? txn.description,
            txn.counterparty_name,
            txn.reference,
            `${txn.fingerprint}:split:${i + 1}`,
            i + 1,
            bankTransactionId,
          ],
        );
        children.push(rows[0]);
      }

      await client.query(
        `UPDATE bank_transactions SET reconciliation_state = 'SPLIT' WHERE id = $1`,
        [bankTransactionId],
      );

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        action: 'bank_transaction.categorized',
        resourceType: 'bank_transaction',
        resourceId: bankTransactionId,
        after: { split_into: children.length },
      });

      return { bank_transaction_id: bankTransactionId, parts: children };
    });
  }
}

interface TransactionRow {
  readonly id: string;
  readonly legal_entity_id: string;
  readonly bank_account_id: string;
  readonly bank_statement_id: string | null;
  readonly transaction_date: string;
  readonly value_date: string | null;
  readonly currency: string;
  readonly amount: string;
  readonly description: string | null;
  readonly counterparty_name: string | null;
  readonly reference: string | null;
  readonly fingerprint: string;
  readonly parent_transaction_id: string | null;
  readonly reconciliation_state: string;
}

export async function loadTransaction(client: PoolClient, id: string): Promise<TransactionRow> {
  const { rows } = await client.query<TransactionRow>(
    `SELECT id, legal_entity_id, bank_account_id, bank_statement_id,
            transaction_date::text, value_date::text, currency, amount::text AS amount,
            description, counterparty_name, reference, fingerprint, parent_transaction_id,
            reconciliation_state::text AS reconciliation_state
       FROM bank_transactions WHERE id = $1`,
    [id],
  );
  const txn = rows[0];
  if (!txn) throw notFound('bank_transaction', id);
  return txn;
}

export { loadBankAccount };
