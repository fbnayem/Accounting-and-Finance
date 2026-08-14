import { Pool } from 'pg';
import {
  AppError,
  uuidv7,
  D,
  disposalResult,
  assertEntityPermission,
  type Decimal,
  type DisposalResult,
  type TenantPrincipal,
  type DraftLineInput,
} from '@acct/domain';
import { writeInTenant, recordAudit } from '@acct/database';
import { PostingService } from '@acct/ledger';
import { DocumentPostingService } from '@acct/subledger';
import {
  loadAssetBooks,
  loadAssetCategory,
  loadFixedAsset,
  revaluationTotal,
} from './register.service';

/**
 * Disposal — doc 09: carrying amount on the disposal date, proceeds, cost
 * removal, accumulated depreciation removal, gain/loss. Rule ASSET_DISPOSAL.
 *
 * The arithmetic lives in @acct/domain's `disposalResult`, whose `gainLoss` is
 * `proceeds − carrying` — the exact expression the database CHECK
 * `dr_gain_loss_derived` re-derives at COMMIT, so a disposal this accepts is
 * one the row-level constraint accepts too.
 */

const DISPOSAL_KINDS = new Set(['SALE', 'SCRAP', 'LOSS', 'WRITE_OFF', 'DONATION']);

/**
 * The disposal journal, doc 09's generic entry with the contra side split by
 * where it accumulated:
 *
 *   Dr Bank/AR                    proceeds
 *   Dr Accumulated Depreciation   what depreciation runs accumulated
 *   Dr Accumulated Impairment     what impairments accumulated (if any)
 *   Dr Loss / Cr Gain             the balancing result
 *   Cr Asset Cost                 cost basis + posted revaluations
 *
 * `result` must have been computed with cost = cost basis + revaluations and
 * accumulated = depreciation + impairment; the two split parameters exist so
 * each contra account is relieved of exactly what it holds — relieving the
 * whole of both from the depreciation account would leave the impairment
 * account carrying a balance for an asset that no longer exists.
 */
export function disposalJournalLines(input: {
  readonly result: DisposalResult;
  readonly accumulatedDepreciation: Decimal;
  readonly accumulatedImpairment: Decimal;
  readonly currency: string;
  readonly assetNumber: string;
  readonly assetAccountId: string;
  readonly accumulatedDepreciationAccountId: string;
  readonly accumulatedImpairmentAccountId: string | null;
  readonly proceedsAccountId: string | null;
  readonly gainAccountId: string | null;
  readonly lossAccountId: string | null;
}): DraftLineInput[] {
  const { result } = input;
  const currency = input.currency;
  const lines: DraftLineInput[] = [];

  if (result.proceeds.isPositive()) {
    if (!input.proceedsAccountId) {
      throw new AppError(
        'VALIDATION_FAILED',
        'Disposal proceeds need the account that received them — bank, AR or a clearing account.',
      );
    }
    lines.push({
      accountId: input.proceedsAccountId,
      description: `Disposal proceeds ${input.assetNumber}`,
      transactionCurrency: currency,
      debit: result.proceeds.toString(),
    });
  }

  if (input.accumulatedDepreciation.isPositive()) {
    lines.push({
      accountId: input.accumulatedDepreciationAccountId,
      description: `Accumulated depreciation removed ${input.assetNumber}`,
      transactionCurrency: currency,
      debit: input.accumulatedDepreciation.toString(),
    });
  }

  if (input.accumulatedImpairment.isPositive()) {
    if (!input.accumulatedImpairmentAccountId) {
      throw new AppError(
        'VALIDATION_FAILED',
        'The asset carries accumulated impairment and the category has no accumulated ' +
          'impairment account to relieve it from.',
      );
    }
    lines.push({
      accountId: input.accumulatedImpairmentAccountId,
      description: `Accumulated impairment removed ${input.assetNumber}`,
      transactionCurrency: currency,
      debit: input.accumulatedImpairment.toString(),
    });
  }

  if (result.gainLoss.isNegative()) {
    if (!input.lossAccountId) {
      throw new AppError(
        'VALIDATION_FAILED',
        `This disposal realises a loss of ${result.gainLoss.abs().toString()} and the category ` +
          `has no loss_account_id to post it to.`,
      );
    }
    lines.push({
      accountId: input.lossAccountId,
      description: `Loss on disposal ${input.assetNumber}`,
      transactionCurrency: currency,
      debit: result.gainLoss.abs().toString(),
    });
  }

  lines.push({
    accountId: input.assetAccountId,
    description: `Asset cost removed ${input.assetNumber}`,
    transactionCurrency: currency,
    credit: result.costRemoved.toString(),
  });

  if (result.gainLoss.isPositive()) {
    if (!input.gainAccountId) {
      throw new AppError(
        'VALIDATION_FAILED',
        `This disposal realises a gain of ${result.gainLoss.toString()} and the category has no ` +
          `gain_account_id to post it to.`,
      );
    }
    lines.push({
      accountId: input.gainAccountId,
      description: `Gain on disposal ${input.assetNumber}`,
      transactionCurrency: currency,
      credit: result.gainLoss.toString(),
    });
  }

  return lines;
}

export class AssetDisposalService {
  constructor(
    private readonly pool: Pool,
    private readonly posting: PostingService,
    private readonly documents: DocumentPostingService,
  ) {}

  /**
   * Disposes the asset across all of its active books — the disposal is one
   * physical event, and a book left behind would go on depreciating a machine
   * that has left the building. Each book posts its own journal with its own
   * carrying amount (doc 09's "independent schedule/journals"), against the
   * same real-world proceeds.
   */
  async disposeAsset(
    principal: TenantPrincipal,
    fixedAssetId: string,
    input: {
      kind: string;
      disposalDate: string;
      proceedsAmount?: string | undefined;
      /** Bank, AR or clearing — required when proceeds are non-zero. */
      proceedsAccountId?: string | null | undefined;
      buyerContactId?: string | null | undefined;
      invoiceId?: string | null | undefined;
      reason?: string | null | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const asset = await loadFixedAsset(client, fixedAssetId, { forUpdate: true });
      assertEntityPermission(principal, 'asset.dispose', asset.legal_entity_id);

      if (!DISPOSAL_KINDS.has(input.kind)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `"${input.kind}" is not a disposal type. doc 09 names: ${[...DISPOSAL_KINDS].join(', ')}.`,
        );
      }
      if (asset.status === 'DRAFT') {
        throw new AppError(
          'VALIDATION_FAILED',
          `Asset ${fixedAssetId} was never capitalized; there is nothing on the ledger to remove. ` +
            `Delete or amend the draft instead.`,
        );
      }
      if (asset.status === 'DISPOSED' || asset.status === 'WRITTEN_OFF') {
        throw new AppError(
          'POSTED_IMMUTABLE',
          `Asset ${fixedAssetId} is already ${asset.status}. A correction is a reversal of the ` +
            `disposal journal, not a second disposal.`,
          { details: { status: asset.status } },
        );
      }

      const proceeds = D(input.proceedsAmount ?? '0');
      if (proceeds.isNegative()) {
        throw new AppError(
          'VALIDATION_FAILED',
          'Proceeds cannot be negative; a cost of disposing is an expense, not negative proceeds.',
        );
      }

      const category = await loadAssetCategory(client, asset.asset_category_id);
      const books = (await loadAssetBooks(client, fixedAssetId, { forUpdate: true })).filter(
        (b) => b.status === 'ACTIVE',
      );
      if (books.length === 0) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Asset ${fixedAssetId} has no active book left to dispose.`,
        );
      }

      const records: Record<string, unknown>[] = [];
      for (const book of books) {
        const accumulatedDepreciation = D(book.accumulated_depreciation);
        const accumulatedImpairment = D(book.accumulated_impairment);
        // Cost as the GL holds it: basis plus posted revaluations — the
        // credit that empties the asset cost account must match what the
        // capitalization and revaluations put there, to the cent.
        const effectiveCost = D(book.cost_basis).add(D(await revaluationTotal(client, book.id)));
        const result = disposalResult({
          costBasis: effectiveCost,
          accumulatedDepreciation: accumulatedDepreciation.add(accumulatedImpairment),
          proceeds,
        });

        const bookContext = await this.posting.loadBookContext(
          client,
          principal,
          book.accounting_book_id,
          input.disposalDate,
        );
        const posted = await this.documents.post(client, context, principal, bookContext, {
          ruleCode: 'ASSET_DISPOSAL',
          sourceType: 'fixed_asset',
          sourceId: fixedAssetId,
          sourceEventId: `asset.disposed:${fixedAssetId}:${book.accounting_book_id}`,
          journalCode: 'GEN',
          postingDate: input.disposalDate,
          documentDate: input.disposalDate,
          description: `${input.kind} disposal of ${asset.asset_number} ${asset.name}`,
          branchId: asset.branch_id,
          contactId: input.buyerContactId ?? null,
          lines: disposalJournalLines({
            result,
            accumulatedDepreciation,
            accumulatedImpairment,
            currency: asset.currency,
            assetNumber: asset.asset_number,
            assetAccountId: category.asset_account_id,
            accumulatedDepreciationAccountId: category.accumulated_depreciation_account_id,
            accumulatedImpairmentAccountId: category.accumulated_impairment_account_id,
            proceedsAccountId: input.proceedsAccountId ?? null,
            gainAccountId: category.gain_account_id,
            lossAccountId: category.loss_account_id,
          }),
        });

        // accumulated_depreciation_removed is the WHOLE contra-asset balance
        // relieved — depreciation plus impairment — so cost removed stays
        // derivable from the record alone as carrying + removed. The journal
        // keeps the two legs distinct.
        const { rows: recorded } = await client.query(
          `INSERT INTO disposal_records
             (id, tenant_id, legal_entity_id, fixed_asset_id, asset_book_id, kind, disposal_date,
              proceeds_amount, carrying_amount, accumulated_depreciation_removed,
              gain_loss_amount, buyer_contact_id, invoice_id, journal_entry_id, approved_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING id, asset_book_id, kind::text AS kind, disposal_date::text AS disposal_date,
                     proceeds_amount::text AS proceeds_amount,
                     carrying_amount::text AS carrying_amount,
                     accumulated_depreciation_removed::text AS accumulated_depreciation_removed,
                     gain_loss_amount::text AS gain_loss_amount, journal_entry_id`,
          [
            uuidv7(),
            principal.tenantId,
            asset.legal_entity_id,
            fixedAssetId,
            book.id,
            input.kind,
            input.disposalDate,
            result.proceeds.toString(),
            result.carryingAmount.toString(),
            result.accumulatedDepreciationRemoved.toString(),
            result.gainLoss.toString(),
            input.buyerContactId ?? null,
            input.invoiceId ?? null,
            posted.entry.id,
          ],
        );
        records.push(recorded[0] as Record<string, unknown>);

        await client.query(
          `INSERT INTO asset_transactions
             (id, tenant_id, legal_entity_id, fixed_asset_id, asset_book_id, kind, posting_date,
              amount, currency, reason, journal_entry_id, approved_by, approved_at)
           VALUES ($1,$2,$3,$4,$5,'DISPOSAL',$6,$7,$8,$9,$10,$11,now())`,
          [
            uuidv7(),
            principal.tenantId,
            asset.legal_entity_id,
            fixedAssetId,
            book.id,
            input.disposalDate,
            result.carryingAmount.toString(),
            asset.currency,
            input.reason ?? null,
            posted.entry.id,
            principal.userId,
          ],
        );

        await client.query(`UPDATE asset_books SET status = 'DISPOSED' WHERE id = $1`, [book.id]);

        // The rest of the schedule will never post — the asset is gone, and a
        // later depreciation run must find nothing eligible for it. SKIPPED,
        // not deleted: the schedule remains the explanation of what was
        // expected before the disposal cut it short.
        await client.query(
          `UPDATE depreciation_schedule_lines SET status = 'SKIPPED'
            WHERE asset_book_id = $1 AND status = 'SCHEDULED'`,
          [book.id],
        );
      }

      const finalStatus = input.kind === 'WRITE_OFF' ? 'WRITTEN_OFF' : 'DISPOSED';
      const { rows } = await client.query(
        `UPDATE fixed_assets SET status = $2::asset_status WHERE id = $1
        RETURNING id, asset_number, name, status::text AS status`,
        [fixedAssetId, finalStatus],
      );

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: asset.legal_entity_id,
        action: 'asset.disposed',
        resourceType: 'fixed_asset',
        resourceId: fixedAssetId,
        reason: input.reason ?? null,
        after: { ...(rows[0] as Record<string, unknown>), disposals: records },
      });

      return { ...rows[0], disposals: records };
    });
  }
}
