import { Pool, PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import {
  AppError,
  notFound,
  uuidv7,
  assertEntityPermission,
  classifyIncoming,
  fingerprintTransaction,
  type TenantPrincipal,
  type CanonicalBankTransaction,
} from '@acct/domain';
import { writeInTenant, readInTenant, recordAudit } from '@acct/database';
import { parseStatement, type AdapterInput, type ImportFormat } from './adapters';

/**
 * Statement and feed import — doc 06 "Feed/import ingestion" and "Deduplication".
 *
 * Phase 4's first exit criterion is that "the same imported/feed transaction
 * cannot create a duplicate canonical transaction", and doc 06's acceptance is
 * "reimport same statement is idempotent". Those are two different statements
 * and this service has to satisfy both:
 *
 *   - the same *file*, re-uploaded, is refused by `bank_statements`'s unique
 *     (bank_account_id, file_hash) — no rows are read twice;
 *   - the same *transaction*, arriving through a different route (a CSV of a day
 *     already synced by API), is caught per-row by doc 06's two-tier rule.
 *
 * The two tiers are not interchangeable and F-028 is what happens when they are
 * conflated. `provider_transaction_id` is the bank telling us this is the same
 * transaction, and it refuses outright. The fingerprint is us inferring it from
 * shape, and it raises a review item — because two identical card payments on
 * one day are one fingerprint and two real movements.
 */

export interface ImportRequest {
  readonly bankAccountId: string;
  readonly format: ImportFormat;
  readonly content?: string | undefined;
  readonly rows?: AdapterInput['rows'];
  readonly statementRef?: string | null | undefined;
  readonly sourceFileId?: string | null | undefined;
}

export interface ImportResult {
  readonly statement_id: string;
  readonly imported: number;
  readonly duplicates: number;
  readonly suspected_duplicates: number;
  readonly replayed: boolean;
  readonly review: readonly {
    readonly existing_id: string;
    readonly reason: string;
    readonly transaction_date: string;
    readonly amount: string;
  }[];
}

interface BankAccountRow {
  readonly id: string;
  readonly legal_entity_id: string;
  readonly currency: string;
  readonly account_id: string;
  readonly status: string;
}

export class BankImportService {
  constructor(private readonly pool: Pool) {}

  async import(principal: TenantPrincipal, request: ImportRequest): Promise<ImportResult> {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const account = await loadBankAccount(client, request.bankAccountId);
      assertEntityPermission(principal, 'bank.import', account.legal_entity_id);

      if (account.status !== 'ACTIVE') {
        throw new AppError(
          'VALIDATION_FAILED',
          `Bank account ${account.id} is ${account.status}; only an ACTIVE account accepts imports.`,
        );
      }

      const parsed = parseStatement({
        format: request.format,
        currency: account.currency,
        content: request.content,
        rows: request.rows,
        statementRef: request.statementRef,
      });

      // doc 06 acceptance: "reimport same statement is idempotent". Hashed over
      // the content the adapter actually read rather than the raw upload, so the
      // same statement re-sent with a different trailing newline is still the
      // same statement.
      const fileHash = createHash('sha256')
        .update(
          JSON.stringify(
            parsed.transactions.map((t) => [
              t.providerTransactionId,
              t.transactionDate,
              t.amount.toString(),
              t.reference,
            ]),
          ),
        )
        .digest('hex');

      const { rows: existingStatement } = await client.query<{ id: string }>(
        `SELECT id FROM bank_statements WHERE bank_account_id = $1 AND file_hash = $2`,
        [account.id, fileHash],
      );
      if (existingStatement[0]) {
        // Not an error. Re-uploading a statement is a thing people do when a
        // browser tab is unclear about whether the first attempt worked, and
        // doc 06 requires it be idempotent rather than refused.
        return {
          statement_id: existingStatement[0].id,
          imported: 0,
          duplicates: parsed.transactions.length,
          suspected_duplicates: 0,
          replayed: true,
          review: [],
        };
      }

      const statementId = uuidv7();
      await client.query(
        `INSERT INTO bank_statements
           (id, tenant_id, legal_entity_id, bank_account_id, statement_ref, format,
            period_start, period_end, opening_balance, closing_balance, source_file_id,
            file_hash, imported_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          statementId,
          principal.tenantId,
          account.legal_entity_id,
          account.id,
          parsed.statementRef,
          parsed.format,
          parsed.periodStart,
          parsed.periodEnd,
          parsed.openingBalance,
          parsed.closingBalance,
          request.sourceFileId ?? null,
          fileHash,
          principal.userId,
        ],
      );

      const result = await this.ingest(
        client,
        principal,
        account,
        statementId,
        parsed.transactions,
      );

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        action: 'bank_statement.imported',
        resourceType: 'bank_statement',
        resourceId: statementId,
        after: {
          format: parsed.format,
          imported: result.imported,
          duplicates: result.duplicates,
          suspected_duplicates: result.suspected_duplicates,
        },
      });

      return { statement_id: statementId, replayed: false, ...result };
    });
  }

  /**
   * Writes the rows that are genuinely new and classifies the rest.
   *
   * Existing rows are read once for the whole batch rather than per transaction:
   * a 5,000-line statement would otherwise be 5,000 round trips, and the window
   * is bounded because doc 06's fingerprint includes the date.
   */
  private async ingest(
    client: PoolClient,
    principal: TenantPrincipal,
    account: BankAccountRow,
    statementId: string,
    transactions: readonly CanonicalBankTransaction[],
  ): Promise<Omit<ImportResult, 'statement_id' | 'replayed'>> {
    const dates = transactions.map((t) => t.transactionDate).sort();
    const { rows: existing } = await client.query<{
      id: string;
      provider_transaction_id: string | null;
      fingerprint: string;
    }>(
      `SELECT id, provider_transaction_id, fingerprint
         FROM bank_transactions
        WHERE bank_account_id = $1
          AND transaction_date BETWEEN $2::date - 7 AND $3::date + 7`,
      [account.id, dates[0], dates[dates.length - 1]],
    );

    const seen = existing.map((e) => ({
      id: e.id,
      providerTransactionId: e.provider_transaction_id,
      fingerprint: e.fingerprint,
    }));

    let imported = 0;
    let duplicates = 0;
    let suspected = 0;
    const review: ImportResult['review'] = [];

    for (const txn of transactions) {
      const fingerprint = fingerprintTransaction({
        bankAccountId: account.id,
        transactionDate: txn.transactionDate,
        valueDate: txn.valueDate,
        amount: txn.amount,
        reference: txn.reference,
        description: txn.description,
      });

      const verdict = classifyIncoming(
        { providerTransactionId: txn.providerTransactionId, fingerprint },
        seen,
      );

      if (verdict.kind === 'DUPLICATE') {
        duplicates++;
        continue;
      }

      // A fingerprint collision is written, not dropped (F-028), and reported so
      // a human can decide. The alternative — silently rejecting it — is how a
      // real second transaction disappears and a reconciliation stops balancing
      // for a reason nobody can find.
      if (verdict.kind === 'SUSPECTED') {
        suspected++;
        (review as ImportResult['review'][number][]).push({
          existing_id: verdict.existingId,
          reason:
            'Same account, date, amount and normalised reference as an existing transaction, ' +
            'and no provider transaction id to tell them apart. Imported for review.',
          transaction_date: txn.transactionDate,
          amount: txn.amount.toString(),
        });
      }

      const id = uuidv7();
      // `import_sequence` is what lets two legitimately identical same-day rows
      // coexist — the blueprint's unique fingerprint index could not (F-028).
      const sequence = seen.filter((s) => s.fingerprint === fingerprint).length + 1;

      await client.query(
        `INSERT INTO bank_transactions
           (id, tenant_id, legal_entity_id, bank_account_id, bank_statement_id,
            provider_transaction_id, transaction_date, value_date, currency, amount,
            description, counterparty_name, reference, running_balance, category_code,
            raw_payload, fingerprint, import_sequence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          id,
          principal.tenantId,
          account.legal_entity_id,
          account.id,
          statementId,
          txn.providerTransactionId,
          txn.transactionDate,
          txn.valueDate,
          txn.currency,
          txn.amount.toString(),
          txn.description,
          txn.counterpartyName,
          txn.reference,
          txn.runningBalance?.toString() ?? null,
          txn.categoryCode,
          JSON.stringify(txn.raw),
          fingerprint,
          sequence,
        ],
      );

      seen.push({ id, providerTransactionId: txn.providerTransactionId, fingerprint });
      imported++;
    }

    return { imported, duplicates, suspected_duplicates: suspected, review };
  }

  async list(
    principal: TenantPrincipal,
    query: {
      bankAccountId?: string | undefined;
      state?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
      limit?: number | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT t.id, t.bank_account_id, t.legal_entity_id, t.provider_transaction_id,
                t.transaction_date, t.value_date, t.currency, t.amount::text AS amount,
                t.description, t.counterparty_name, t.reference,
                t.running_balance::text AS running_balance, t.reconciliation_state,
                t.parent_transaction_id, t.import_sequence, t.created_at
           FROM bank_transactions t
          WHERE ($1::uuid IS NULL OR t.bank_account_id = $1)
            AND ($2::text IS NULL OR t.reconciliation_state::text = $2)
            AND ($3::date IS NULL OR t.transaction_date >= $3)
            AND ($4::date IS NULL OR t.transaction_date <= $4)
          ORDER BY t.transaction_date DESC, t.created_at DESC
          LIMIT $5`,
        [
          query.bankAccountId ?? null,
          query.state ?? null,
          query.from ?? null,
          query.to ?? null,
          Math.min(query.limit ?? 100, 500),
        ],
      );
      return { data: rows };
    });
  }
}

export async function loadBankAccount(
  client: PoolClient,
  bankAccountId: string,
): Promise<BankAccountRow> {
  const { rows } = await client.query<BankAccountRow>(
    `SELECT id, legal_entity_id, currency, account_id, status::text AS status
       FROM bank_accounts WHERE id = $1`,
    [bankAccountId],
  );
  const account = rows[0];
  if (!account) throw notFound('bank_account', bankAccountId);
  return account;
}
