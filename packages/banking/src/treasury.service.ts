import { Pool, PoolClient } from 'pg';
import {
  AppError,
  notFound,
  uuidv7,
  D,
  assertEntityPermission,
  decomposeSettlement,
  type TenantPrincipal,
  type DraftLineInput,
} from '@acct/domain';
import { writeInTenant, readInTenant, recordAudit } from '@acct/database';
import { PostingService } from '@acct/ledger';
import { DocumentPostingService } from '@acct/subledger';
import { loadBankAccount } from './import.service';

/**
 * Internal transfers and processor clearing — doc 06 "Transfers" and "Payment
 * processor clearing".
 *
 * Two of Phase 4's exit criteria live here:
 *
 *   3. "Processor gross receipts, fees and net settlement reconcile through
 *      clearing accounts" — which had no route at all before F-805.
 *   4. "Internal transfer creates one coherent paired transaction without
 *      double-counting cash."
 *
 * Criterion 4's phrasing is the design constraint. A transfer is *one* business
 * object and *one* journal — Dr destination, Cr source. It is not two payments
 * that happen to net out, because two payments can be half-completed and a
 * transfer cannot. The two bank lines that later arrive for it are matched to
 * the transfer, and `bank_matches_bounded` keeps each within its own amount.
 */

export class TreasuryService {
  constructor(
    private readonly pool: Pool,
    private readonly posting: PostingService,
    private readonly documents: DocumentPostingService,
  ) {}

  /**
   * doc 06: "Internal transfer creates one business transfer object, paired
   * bank-side references and one journal: Dr destination bank, Cr source bank.
   * Foreign currency transfer includes rates, fees and realized FX where
   * required."
   */
  async createTransfer(
    principal: TenantPrincipal,
    input: {
      accountingBookId: string;
      postingDate: string;
      sourceBankAccountId: string;
      targetBankAccountId: string;
      sourceAmount: string;
      targetAmount?: string | undefined;
      exchangeRate?: string | null | undefined;
      feeAmount?: string | undefined;
      feeAccountId?: string | null | undefined;
      description?: string | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const book = await this.posting.loadBookContext(
        client,
        principal,
        input.accountingBookId,
        input.postingDate,
      );
      assertEntityPermission(principal, 'bank_transfer.create', book.legalEntityId);

      if (input.sourceBankAccountId === input.targetBankAccountId) {
        throw new AppError(
          'VALIDATION_FAILED',
          'A transfer needs two different accounts; the database refuses this one too.',
        );
      }

      const source = await loadBankAccount(client, input.sourceBankAccountId);
      const target = await loadBankAccount(client, input.targetBankAccountId);
      for (const account of [source, target]) {
        if (account.legal_entity_id !== book.legalEntityId) {
          throw new AppError(
            'VALIDATION_FAILED',
            `Bank account ${account.id} belongs to another legal entity. A movement between ` +
              `entities is an intercompany transaction, not an internal transfer (doc 17).`,
          );
        }
      }

      const sourceAmount = D(input.sourceAmount);
      if (!sourceAmount.isPositive()) {
        throw new AppError(
          'VALIDATION_FAILED',
          'A transfer amount is positive; the direction comes from which account is which.',
        );
      }

      const sameCurrency = source.currency === target.currency;
      const targetAmount = input.targetAmount ? D(input.targetAmount) : sourceAmount;
      if (sameCurrency && !targetAmount.equals(sourceAmount)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Both accounts are in ${source.currency}, so ${targetAmount.toString()} cannot arrive ` +
            `from ${sourceAmount.toString()}. Record the shortfall as a fee.`,
        );
      }
      if (!sameCurrency && !input.targetAmount) {
        throw new AppError(
          'VALIDATION_FAILED',
          `A ${source.currency} to ${target.currency} transfer must state what actually arrived. ` +
            `Deriving it from a rate would record an amount the bank did not.`,
        );
      }

      const fee = D(input.feeAmount ?? '0');
      if (fee.isPositive() && !input.feeAccountId) {
        throw new AppError(
          'VALIDATION_FAILED',
          'A transfer fee needs an expense account; it is a cost, not a rounding difference.',
        );
      }

      const transferId = uuidv7();

      // One journal, as doc 06 requires. Cr source for what left, Dr target for
      // what arrived, Dr fee for what the bank took. In a cross-currency
      // transfer the two legs differ in base terms, and the balancing difference
      // is realized FX — recognised here on the same entry, per ADR-0007.
      const lines: DraftLineInput[] = [
        {
          accountId: target.account_id,
          description: `Transfer in from ${source.id}`,
          transactionCurrency: target.currency,
          debit: targetAmount.toString(),
          ...(sameCurrency ? {} : { exchangeRate: input.exchangeRate ?? null }),
        },
        {
          accountId: source.account_id,
          description: `Transfer out to ${target.id}`,
          transactionCurrency: source.currency,
          credit: sourceAmount.toString(),
        },
      ];
      if (fee.isPositive()) {
        lines.push({
          accountId: input.feeAccountId!,
          description: 'Transfer fee',
          transactionCurrency: source.currency,
          debit: fee.toString(),
        });
        lines.push({
          accountId: source.account_id,
          description: 'Transfer fee charged to source account',
          transactionCurrency: source.currency,
          credit: fee.toString(),
        });
      }

      await client.query(
        `INSERT INTO bank_transfers
           (id, tenant_id, legal_entity_id, accounting_book_id, posting_date,
            source_bank_account_id, target_bank_account_id, source_currency, target_currency,
            source_amount, target_amount, exchange_rate, fee_amount, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'DRAFT')`,
        [
          transferId,
          principal.tenantId,
          book.legalEntityId,
          book.bookId,
          input.postingDate,
          source.id,
          target.id,
          source.currency,
          target.currency,
          sourceAmount.toString(),
          targetAmount.toString(),
          input.exchangeRate ?? null,
          fee.toString(),
        ],
      );

      const result = await this.documents.post(client, context, principal, book, {
        ruleCode: 'BANK_TRANSFER_POSTED',
        sourceType: 'bank_transfer',
        sourceId: transferId,
        sourceEventId: `bank_transfer.completed:${transferId}`,
        journalCode: 'BNK',
        postingDate: input.postingDate,
        documentDate: input.postingDate,
        description: input.description ?? `Transfer ${source.id} to ${target.id}`,
        branchId: null,
        contactId: null,
        lines,
      });

      const { rows } = await client.query(
        `UPDATE bank_transfers SET status = 'CONFIRMED', accounting_entry_id = $2
          WHERE id = $1
        RETURNING id, posting_date::text, source_bank_account_id, target_bank_account_id,
                  source_currency, target_currency, source_amount::text AS source_amount,
                  target_amount::text AS target_amount, fee_amount::text AS fee_amount,
                  status::text AS status, accounting_entry_id`,
        [transferId, result.entry.id],
      );

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        action: 'bank_transfer.completed',
        resourceType: 'bank_transfer',
        resourceId: transferId,
        after: rows[0] as Record<string, unknown>,
      });

      return { ...rows[0], journal_entry_id: result.entry.id };
    });
  }

  // -------------------------------------------------------------------------
  // Processor clearing — F-805. doc 06's worked example, with routes.
  // -------------------------------------------------------------------------

  /**
   * Records a settlement batch and the items it settles.
   *
   * doc 06: customer pays 100, processor settles 97, fee 3. The receipt side
   * (Dr Payment Clearing 100 / Cr AR 100) is an AR action and already exists;
   * this is the settlement side, and it is what empties the clearing account.
   */
  async createSettlementBatch(
    principal: TenantPrincipal,
    input: {
      legalEntityId: string;
      processor: string;
      externalBatchId?: string | null | undefined;
      settlementDate: string;
      currency: string;
      grossAmount: string;
      feeAmount: string;
      adjustmentAmount?: string | undefined;
      netAmount: string;
      items?: readonly {
        sourceType: string;
        sourceId: string;
        grossAmount: string;
        feeAmount?: string;
      }[];
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      assertEntityPermission(principal, 'settlement.manage', input.legalEntityId);

      // Refused here with the arithmetic spelled out, before
      // `settlement_decomposes` refuses it as a constraint violation.
      const decomposed = decomposeSettlement({
        gross: D(input.grossAmount),
        fee: D(input.feeAmount),
        adjustment: input.adjustmentAmount ? D(input.adjustmentAmount) : undefined,
        net: D(input.netAmount),
      });

      const batchId = uuidv7();
      const { rows } = await client.query(
        `INSERT INTO settlement_batches
           (id, tenant_id, legal_entity_id, processor, external_batch_id, settlement_date,
            currency, gross_amount, fee_amount, adjustment_amount, net_amount, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'OPEN')
         RETURNING id, processor, external_batch_id, settlement_date::text,
                   currency, gross_amount::text AS gross_amount, fee_amount::text AS fee_amount,
                   adjustment_amount::text AS adjustment_amount, net_amount::text AS net_amount,
                   status`,
        [
          batchId,
          principal.tenantId,
          input.legalEntityId,
          input.processor,
          input.externalBatchId ?? null,
          input.settlementDate,
          input.currency,
          decomposed.gross.toString(),
          decomposed.fee.toString(),
          decomposed.adjustment.toString(),
          decomposed.net.toString(),
        ],
      );

      const items: unknown[] = [];
      for (const item of input.items ?? []) {
        const { rows: created } = await client.query(
          `INSERT INTO payment_clearing_items
             (id, tenant_id, legal_entity_id, settlement_batch_id, source_type, source_id,
              currency, gross_amount, fee_amount, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING')
           RETURNING id, source_type, source_id, gross_amount::text AS gross_amount,
                     fee_amount::text AS fee_amount, status`,
          [
            uuidv7(),
            principal.tenantId,
            input.legalEntityId,
            batchId,
            item.sourceType,
            item.sourceId,
            input.currency,
            item.grossAmount,
            item.feeAmount ?? '0',
          ],
        );
        items.push(created[0]);
      }

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        action: 'processor_settlement.reconciled',
        resourceType: 'settlement_batch',
        resourceId: batchId,
        after: { ...(rows[0] as Record<string, unknown>), item_count: items.length },
      });

      return { ...rows[0], items };
    });
  }

  /**
   * Posts the settlement: Dr Bank net + Dr Processing Fee / Cr Payment Clearing gross.
   *
   * doc 06's acceptance is "payment processor fixture clears the clearing account
   * exactly", so the credit is the *gross* — the same amount the receipts
   * debited — and the fee is recognised as expense. Anything else leaves a
   * residue in a clearing account that nobody ever reconciles.
   */
  async reconcileSettlementBatch(
    principal: TenantPrincipal,
    batchId: string,
    input: { accountingBookId: string; bankAccountId: string; feeAccountId: string },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows: batches } = await client.query<{
        id: string;
        legal_entity_id: string;
        currency: string;
        gross_amount: string;
        fee_amount: string;
        adjustment_amount: string;
        net_amount: string;
        settlement_date: string;
        status: string;
        processor: string;
      }>(
        `SELECT id, legal_entity_id, currency, gross_amount::text, fee_amount::text,
                adjustment_amount::text, net_amount::text, settlement_date::text,
                status, processor
           FROM settlement_batches WHERE id = $1 FOR UPDATE`,
        [batchId],
      );
      const batch = batches[0];
      if (!batch) throw notFound('settlement_batch', batchId);
      assertEntityPermission(principal, 'settlement.manage', batch.legal_entity_id);

      if (batch.status === 'RECONCILED') {
        throw new AppError(
          'POSTED_IMMUTABLE',
          `Settlement batch ${batchId} is already reconciled. A correction is a reversal.`,
        );
      }

      const book = await this.posting.loadBookContext(
        client,
        principal,
        input.accountingBookId,
        batch.settlement_date,
      );
      const bank = await loadBankAccount(client, input.bankAccountId);
      const clearingAccountId = await loadClearingAccount(client, batch.legal_entity_id);

      const lines: DraftLineInput[] = [
        {
          accountId: bank.account_id,
          description: `${batch.processor} settlement`,
          transactionCurrency: batch.currency,
          debit: batch.net_amount,
        },
        {
          accountId: input.feeAccountId,
          description: `${batch.processor} processing fee`,
          transactionCurrency: batch.currency,
          debit: batch.fee_amount,
        },
        {
          // Gross, not net — this is what empties the clearing account the
          // receipts filled. doc 06's acceptance is exactly this line.
          accountId: clearingAccountId,
          description: `${batch.processor} clearing released`,
          transactionCurrency: batch.currency,
          credit: batch.gross_amount,
        },
      ];

      // An adjustment (chargeback, reserve release) is the fourth leg. Signed,
      // so a negative adjustment debits the clearing account back.
      const adjustment = D(batch.adjustment_amount);
      if (!adjustment.isZero()) {
        lines.push({
          accountId: clearingAccountId,
          description: `${batch.processor} settlement adjustment`,
          transactionCurrency: batch.currency,
          ...(adjustment.isPositive()
            ? { debit: adjustment.toString() }
            : { credit: adjustment.abs().toString() }),
        });
      }

      const result = await this.documents.post(client, context, principal, book, {
        ruleCode: 'PROCESSOR_SETTLEMENT_POSTED',
        sourceType: 'settlement_batch',
        sourceId: batchId,
        sourceEventId: `processor_settlement.reconciled:${batchId}`,
        journalCode: 'BNK',
        postingDate: batch.settlement_date,
        documentDate: batch.settlement_date,
        description: `${batch.processor} settlement ${batch.id}`,
        branchId: null,
        contactId: null,
        lines,
      });

      await client.query(
        `UPDATE payment_clearing_items SET status = 'SETTLED'
          WHERE settlement_batch_id = $1 AND status = 'PENDING'`,
        [batchId],
      );

      const { rows } = await client.query(
        `UPDATE settlement_batches SET status = 'RECONCILED', accounting_entry_id = $2
          WHERE id = $1
        RETURNING id, status, gross_amount::text AS gross_amount, fee_amount::text AS fee_amount,
                  net_amount::text AS net_amount, accounting_entry_id`,
        [batchId, result.entry.id],
      );

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        action: 'processor_settlement.reconciled',
        resourceType: 'settlement_batch',
        resourceId: batchId,
        after: rows[0] as Record<string, unknown>,
      });

      return { ...rows[0], journal_entry_id: result.entry.id };
    });
  }

  async listSettlementBatches(
    principal: TenantPrincipal,
    query: { legalEntityId?: string | undefined; status?: string | undefined },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT id, processor, external_batch_id, settlement_date::text, currency,
                gross_amount::text AS gross_amount, fee_amount::text AS fee_amount,
                adjustment_amount::text AS adjustment_amount, net_amount::text AS net_amount,
                status, accounting_entry_id
           FROM settlement_batches
          WHERE ($1::uuid IS NULL OR legal_entity_id = $1)
            AND ($2::text IS NULL OR status = $2)
          ORDER BY settlement_date DESC`,
        [query.legalEntityId ?? null, query.status ?? null],
      );
      return { data: rows };
    });
  }

  /** doc 06's Payment Clearing Aging: received by the processor, not yet settled. */
  async listClearingItems(
    principal: TenantPrincipal,
    query: { legalEntityId?: string | undefined; status?: string | undefined },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT c.id, c.settlement_batch_id, c.source_type, c.source_id, c.currency,
                c.gross_amount::text AS gross_amount, c.fee_amount::text AS fee_amount,
                c.status, c.created_at,
                (now()::date - c.created_at::date) AS days_outstanding
           FROM payment_clearing_items c
          WHERE ($1::uuid IS NULL OR c.legal_entity_id = $1)
            AND ($2::text IS NULL OR c.status = $2)
          ORDER BY c.created_at`,
        [query.legalEntityId ?? null, query.status ?? null],
      );
      return { data: rows };
    });
  }

  /**
   * F-808 — doc 06's chargebacks, which no route could reach.
   *
   * A chargeback reverses cash the entity has already recognised, so it posts:
   * Dr AR (the customer owes it again) / Cr Payment Clearing. Restating the row
   * alone would leave the ledger claiming money that has gone back.
   */
  async chargeback(
    principal: TenantPrincipal,
    itemId: string,
    input: { accountingBookId: string; postingDate: string; reason: string },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows: items } = await client.query<{
        id: string;
        legal_entity_id: string;
        currency: string;
        gross_amount: string;
        status: string;
        source_type: string;
        source_id: string;
      }>(
        `SELECT id, legal_entity_id, currency, gross_amount::text, status, source_type, source_id
           FROM payment_clearing_items WHERE id = $1 FOR UPDATE`,
        [itemId],
      );
      const item = items[0];
      if (!item) throw notFound('payment_clearing_item', itemId);
      assertEntityPermission(principal, 'settlement.manage', item.legal_entity_id);

      if (item.status === 'CHARGED_BACK') {
        throw new AppError('POSTED_IMMUTABLE', `Clearing item ${itemId} is already charged back.`);
      }
      if (!input.reason?.trim()) {
        throw new AppError('VALIDATION_FAILED', 'A chargeback needs a reason.');
      }

      const book = await this.posting.loadBookContext(
        client,
        principal,
        input.accountingBookId,
        input.postingDate,
      );
      const clearingAccountId = await loadClearingAccount(client, item.legal_entity_id);
      const arAccountId = await loadArControlAccount(client, item.legal_entity_id);

      const result = await this.documents.post(client, context, principal, book, {
        ruleCode: 'PROCESSOR_CHARGEBACK_POSTED',
        sourceType: 'payment_clearing_item',
        sourceId: itemId,
        sourceEventId: `processor_chargeback:${itemId}`,
        journalCode: 'BNK',
        postingDate: input.postingDate,
        documentDate: input.postingDate,
        description: `Chargeback: ${input.reason.trim()}`,
        branchId: null,
        contactId: null,
        lines: [
          {
            accountId: arAccountId,
            description: 'Chargeback reinstates the receivable',
            transactionCurrency: item.currency,
            debit: item.gross_amount,
          },
          {
            accountId: clearingAccountId,
            description: 'Chargeback removes cleared cash',
            transactionCurrency: item.currency,
            credit: item.gross_amount,
          },
        ],
      });

      const { rows } = await client.query(
        `UPDATE payment_clearing_items SET status = 'CHARGED_BACK' WHERE id = $1
        RETURNING id, status, gross_amount::text AS gross_amount`,
        [itemId],
      );

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        action: 'processor_settlement.reconciled',
        resourceType: 'payment_clearing_item',
        resourceId: itemId,
        after: { ...(rows[0] as Record<string, unknown>), reason: input.reason.trim() },
      });

      return { ...rows[0], journal_entry_id: result.entry.id };
    });
  }
}

async function loadClearingAccount(client: PoolClient, legalEntityId: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT payment_clearing_account_id AS id FROM accounting_policies
      WHERE legal_entity_id = $1 AND payment_clearing_account_id IS NOT NULL
      ORDER BY valid_from DESC LIMIT 1`,
    [legalEntityId],
  );
  const id = rows[0]?.id;
  if (!id) {
    throw new AppError(
      'VALIDATION_FAILED',
      `No payment clearing account is configured for entity ${legalEntityId}. doc 06's processor ` +
        `flow debits it on receipt and credits it on settlement; without it the two halves have ` +
        `nowhere to meet.`,
    );
  }
  return id;
}

async function loadArControlAccount(client: PoolClient, legalEntityId: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT ar_control_account_id AS id FROM accounting_policies
      WHERE legal_entity_id = $1 AND ar_control_account_id IS NOT NULL
      ORDER BY valid_from DESC LIMIT 1`,
    [legalEntityId],
  );
  const id = rows[0]?.id;
  if (!id) {
    throw new AppError(
      'VALIDATION_FAILED',
      `No AR control account is configured for entity ${legalEntityId}.`,
    );
  }
  return id;
}
