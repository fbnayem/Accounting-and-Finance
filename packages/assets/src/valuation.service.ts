import { Pool, PoolClient } from 'pg';
import {
  AppError,
  uuidv7,
  D,
  assertEntityPermission,
  type Decimal,
  type TenantPrincipal,
  type DraftLineInput,
  type RequestContext,
} from '@acct/domain';
import { writeInTenant, recordAudit } from '@acct/database';
import { PostingService } from '@acct/ledger';
import { DocumentPostingService } from '@acct/subledger';
import {
  loadAssetBook,
  loadAssetCategory,
  loadFixedAsset,
  revaluationTotal,
  type AssetBookRow,
  type AssetCategoryRow,
  type FixedAssetRow,
} from './register.service';

/**
 * Impairment, impairment reversal and revaluation — doc 09 "Revaluation and
 * impairment": controlled transactions that store reason, evidence, date and
 * approval, create an explicit journal, and "never overwrite historical
 * cost/accumulated values".
 *
 * That last clause is the design of this file: every operation here writes an
 * `asset_transactions` row and posts a journal. None of them touches
 * `fixed_assets.acquisition_cost` or `asset_books.cost_basis` — carrying amount
 * is derived, cost + revaluations − accumulated depreciation − accumulated
 * impairment, and the running accumulators on `asset_books` move only by the
 * amount each posted transaction says they moved.
 */

// ---------------------------------------------------------------------------
// The arithmetic, pure so the tests can hold it down without a database
// ---------------------------------------------------------------------------

export interface BookValuation {
  readonly costBasis: Decimal;
  /** Net effect of posted REVALUATION transactions on this book. */
  readonly revaluationTotal: Decimal;
  readonly accumulatedDepreciation: Decimal;
  readonly accumulatedImpairment: Decimal;
}

export function carryingAmount(v: BookValuation): Decimal {
  return v.costBasis
    .add(v.revaluationTotal)
    .sub(v.accumulatedDepreciation)
    .sub(v.accumulatedImpairment);
}

export function assertImpairmentAllowed(v: BookValuation, amount: Decimal): void {
  if (!amount.isPositive()) {
    throw new AppError(
      'VALIDATION_FAILED',
      `An impairment of ${amount.toString()} impairs nothing. The amount is positive; a recovery ` +
        `in value is an impairment reversal.`,
      { details: { amount: amount.toString() } },
    );
  }
  const carrying = carryingAmount(v);
  if (amount.gt(carrying)) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Impairing ${amount.toString()} would drive the carrying amount of ${carrying.toString()} ` +
        `below zero. IAS 36 writes an asset down to its recoverable amount, which is never negative.`,
      { details: { amount: amount.toString(), carrying_amount: carrying.toString() } },
    );
  }
}

/**
 * The IAS 36 cap (ADR-0001): a reversal is limited to the carrying amount that
 * would have applied had the original impairment never been recognised.
 *
 * In this module that cap equals `accumulatedImpairment` EXACTLY, and only
 * because of a property this package maintains: the depreciation schedule is
 * generated once, at capitalization, from the un-impaired cost basis, and an
 * impairment never revises it. Recorded accumulated depreciation is therefore
 * the same accumulated depreciation the no-impairment history would have
 * produced, so
 *
 *   carrying without impairment = cost + revaluations − accumulated depreciation
 *   carrying now                = the same − accumulated impairment
 *   cap = the difference        = accumulated impairment.
 *
 * If prospective schedule revision after impairment is ever added, this cap
 * must be recomputed from the hypothetical schedule, not read off the column.
 */
export function assertImpairmentReversalAllowed(v: BookValuation, amount: Decimal): void {
  if (!amount.isPositive()) {
    throw new AppError(
      'VALIDATION_FAILED',
      `An impairment reversal of ${amount.toString()} reverses nothing.`,
      { details: { amount: amount.toString() } },
    );
  }
  if (amount.gt(v.accumulatedImpairment)) {
    const carrying = carryingAmount(v);
    const withoutImpairment = carrying.add(v.accumulatedImpairment);
    throw new AppError(
      'VALIDATION_FAILED',
      `IAS 36 caps this reversal at ${v.accumulatedImpairment.toString()} (ADR-0001): carrying ` +
        `amount is ${carrying.toString()} now and would have been ` +
        `${withoutImpairment.toString()} had the impairment never happened, so reversing ` +
        `${amount.toString()} would value the asset above its never-impaired history.`,
      {
        details: {
          amount: amount.toString(),
          accumulated_impairment: v.accumulatedImpairment.toString(),
          carrying_amount: carrying.toString(),
          carrying_amount_without_impairment: withoutImpairment.toString(),
        },
      },
    );
  }
}

/**
 * ADR-0001's IAS 16 split for a revaluation delta.
 *
 * An increase goes to Revaluation Surplus (OCI) — except to the extent it
 * reverses a decrease previously recognised in P&L, which returns through P&L
 * first. A decrease consumes the existing surplus first and only the remainder
 * hits P&L. The cumulative P&L position is derivable, not stored:
 * Σ(P&L portions) = priorRevaluationTotal − surplusBalance, so the unreversed
 * P&L loss is max(0, surplusBalance − priorRevaluationTotal).
 */
export function revaluationSplit(input: {
  readonly amount: Decimal;
  readonly surplusBalance: Decimal;
  readonly priorRevaluationTotal: Decimal;
}): { surplus: Decimal; profitAndLoss: Decimal } {
  const { amount, surplusBalance, priorRevaluationTotal } = input;
  if (amount.isPositive()) {
    const unreversedPnlLoss = surplusBalance.sub(priorRevaluationTotal);
    const toPnl = unreversedPnlLoss.isPositive()
      ? amount.lt(unreversedPnlLoss)
        ? amount
        : unreversedPnlLoss
      : D('0');
    return { surplus: amount.sub(toPnl), profitAndLoss: toPnl };
  }
  const decrease = amount.abs();
  const fromSurplus = decrease.lt(surplusBalance) ? decrease : surplusBalance;
  return {
    surplus: fromSurplus.negate(),
    profitAndLoss: decrease.sub(fromSurplus).negate(),
  };
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class AssetValuationService {
  constructor(
    private readonly pool: Pool,
    private readonly posting: PostingService,
    private readonly documents: DocumentPostingService,
  ) {}

  private async loadTarget(
    client: PoolClient,
    fixedAssetId: string,
    accountingBookId: string,
  ): Promise<{
    asset: FixedAssetRow;
    book: AssetBookRow;
    category: AssetCategoryRow;
    valuation: BookValuation;
  }> {
    const asset = await loadFixedAsset(client, fixedAssetId, { forUpdate: true });
    const book = await loadAssetBook(client, fixedAssetId, accountingBookId, { forUpdate: true });
    if (book.status !== 'ACTIVE') {
      throw new AppError(
        'VALIDATION_FAILED',
        `Asset book ${book.id} is ${book.status}; only an active book carries a value to adjust.`,
        { details: { asset_book_id: book.id, status: book.status } },
      );
    }
    const category = await loadAssetCategory(client, asset.asset_category_id);
    const valuation: BookValuation = {
      costBasis: D(book.cost_basis),
      revaluationTotal: D(await revaluationTotal(client, book.id)),
      accumulatedDepreciation: D(book.accumulated_depreciation),
      accumulatedImpairment: D(book.accumulated_impairment),
    };
    return { asset, book, category, valuation };
  }

  /** Dr Impairment Loss / Cr Accumulated Impairment (posting rule ASSET_IMPAIRMENT). */
  async impairAsset(
    principal: TenantPrincipal,
    fixedAssetId: string,
    input: {
      accountingBookId: string;
      amount: string;
      postingDate: string;
      reason: string;
      valuationEvidenceFileId?: string | null | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { asset, book, category, valuation } = await this.loadTarget(
        client,
        fixedAssetId,
        input.accountingBookId,
      );
      assertEntityPermission(principal, 'asset.impair', asset.legal_entity_id);
      requireReason(input.reason, 'impairment');

      const amount = D(input.amount);
      assertImpairmentAllowed(valuation, amount);

      const accounts = impairmentAccounts(category);
      const transactionId = await this.postValuationTransaction(client, context, principal, {
        asset,
        book,
        kind: 'IMPAIRMENT',
        ruleCode: 'ASSET_IMPAIRMENT',
        eventName: 'asset.impaired',
        postingDate: input.postingDate,
        amount,
        reason: input.reason,
        valuationEvidenceFileId: input.valuationEvidenceFileId ?? null,
        reversesTransactionId: null,
        lines: [
          {
            accountId: accounts.loss,
            description: `Impairment loss ${asset.asset_number}`,
            transactionCurrency: asset.currency,
            debit: amount.toString(),
          },
          {
            accountId: accounts.accumulated,
            description: `Accumulated impairment ${asset.asset_number}`,
            transactionCurrency: asset.currency,
            credit: amount.toString(),
          },
        ],
      });

      await client.query(
        `UPDATE asset_books SET accumulated_impairment = accumulated_impairment + $2 WHERE id = $1`,
        [book.id, amount.toString()],
      );
      await this.refreshImpairedStatus(client, fixedAssetId);

      return this.transactionResult(client, transactionId);
    });
  }

  /**
   * ADR-0001: IAS 36 permits reversal for non-goodwill assets — capped at the
   * carrying amount that would have applied without the original impairment.
   * Dr Accumulated Impairment / Cr Impairment Loss (ASSET_IMPAIRMENT_REVERSAL).
   */
  async reverseAssetImpairment(
    principal: TenantPrincipal,
    fixedAssetId: string,
    input: {
      accountingBookId: string;
      amount: string;
      postingDate: string;
      reason: string;
      /** The IMPAIRMENT transaction being reversed, when the caller can name it. */
      impairmentTransactionId?: string | null | undefined;
      valuationEvidenceFileId?: string | null | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { asset, book, category, valuation } = await this.loadTarget(
        client,
        fixedAssetId,
        input.accountingBookId,
      );
      assertEntityPermission(principal, 'asset.impair', asset.legal_entity_id);
      requireReason(input.reason, 'impairment reversal');

      const amount = D(input.amount);
      assertImpairmentReversalAllowed(valuation, amount);

      let reversesTransactionId: string | null = null;
      if (input.impairmentTransactionId) {
        const { rows } = await client.query<{ id: string }>(
          `SELECT id FROM asset_transactions
            WHERE id = $1 AND fixed_asset_id = $2 AND asset_book_id = $3 AND kind = 'IMPAIRMENT'`,
          [input.impairmentTransactionId, fixedAssetId, book.id],
        );
        if (!rows[0]) {
          throw new AppError(
            'VALIDATION_FAILED',
            `Transaction ${input.impairmentTransactionId} is not an impairment of this asset ` +
              `book, so this reversal cannot claim to reverse it.`,
            { details: { impairment_transaction_id: input.impairmentTransactionId } },
          );
        }
        reversesTransactionId = rows[0].id;
      }

      const accounts = impairmentAccounts(category);
      const transactionId = await this.postValuationTransaction(client, context, principal, {
        asset,
        book,
        kind: 'IMPAIRMENT_REVERSAL',
        ruleCode: 'ASSET_IMPAIRMENT_REVERSAL',
        eventName: 'asset.impairment_reversed',
        postingDate: input.postingDate,
        amount,
        reason: input.reason,
        valuationEvidenceFileId: input.valuationEvidenceFileId ?? null,
        reversesTransactionId,
        lines: [
          {
            accountId: accounts.accumulated,
            description: `Impairment reversed ${asset.asset_number}`,
            transactionCurrency: asset.currency,
            debit: amount.toString(),
          },
          {
            accountId: accounts.loss,
            description: `Impairment reversal ${asset.asset_number}`,
            transactionCurrency: asset.currency,
            credit: amount.toString(),
          },
        ],
      });

      await client.query(
        `UPDATE asset_books SET accumulated_impairment = accumulated_impairment - $2 WHERE id = $1`,
        [book.id, amount.toString()],
      );
      await this.refreshImpairedStatus(client, fixedAssetId);

      return this.transactionResult(client, transactionId);
    });
  }

  /**
   * IAS 16 revaluation model (ADR-0001). The asset-side leg posts to the
   * category's asset cost account, so the GL keeps agreeing with the derived
   * cost (cost basis + revaluations) that the reconciliation report computes.
   */
  async revalueAsset(
    principal: TenantPrincipal,
    fixedAssetId: string,
    input: {
      accountingBookId: string;
      /** Signed change in carrying amount: positive revalues up. */
      amount: string;
      postingDate: string;
      reason: string;
      valuationEvidenceFileId?: string | null | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { asset, book, category, valuation } = await this.loadTarget(
        client,
        fixedAssetId,
        input.accountingBookId,
      );
      assertEntityPermission(principal, 'asset.revalue', asset.legal_entity_id);
      requireReason(input.reason, 'revaluation');

      const amount = D(input.amount);
      if (amount.isZero()) {
        throw new AppError('VALIDATION_FAILED', 'A revaluation of zero revalues nothing.');
      }
      const carrying = carryingAmount(valuation);
      if (amount.isNegative() && amount.abs().gt(carrying)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Revaluing down by ${amount.abs().toString()} would drive the carrying amount of ` +
            `${carrying.toString()} below zero.`,
          { details: { amount: amount.toString(), carrying_amount: carrying.toString() } },
        );
      }

      const split = revaluationSplit({
        amount,
        surplusBalance: D(book.revaluation_surplus),
        priorRevaluationTotal: valuation.revaluationTotal,
      });

      const lines: DraftLineInput[] = [];
      if (amount.isPositive()) {
        lines.push({
          accountId: category.asset_account_id,
          description: `Revaluation ${asset.asset_number}`,
          transactionCurrency: asset.currency,
          debit: amount.toString(),
        });
        if (split.profitAndLoss.isPositive()) {
          lines.push({
            accountId: requireAccount(
              category.gain_account_id,
              category.code,
              'gain_account_id',
              'the portion of an upward revaluation that reverses a decrease previously ' +
                'recognised in P&L returns through P&L (IAS 16, ADR-0001)',
            ),
            description: 'Revaluation gain (reverses prior P&L decrease)',
            transactionCurrency: asset.currency,
            credit: split.profitAndLoss.toString(),
          });
        }
        if (split.surplus.isPositive()) {
          lines.push({
            accountId: requireAccount(
              category.revaluation_surplus_account_id,
              category.code,
              'revaluation_surplus_account_id',
              'an upward revaluation credits Revaluation Surplus in OCI (IAS 16, ADR-0001)',
            ),
            description: 'Revaluation surplus',
            transactionCurrency: asset.currency,
            credit: split.surplus.toString(),
          });
        }
      } else {
        if (!split.surplus.isZero()) {
          lines.push({
            accountId: requireAccount(
              category.revaluation_surplus_account_id,
              category.code,
              'revaluation_surplus_account_id',
              'a downward revaluation consumes the existing surplus before touching P&L ' +
                '(IAS 16, ADR-0001)',
            ),
            description: 'Revaluation surplus consumed',
            transactionCurrency: asset.currency,
            debit: split.surplus.abs().toString(),
          });
        }
        if (!split.profitAndLoss.isZero()) {
          lines.push({
            accountId: requireAccount(
              category.loss_account_id,
              category.code,
              'loss_account_id',
              'the decrease beyond the surplus is a P&L loss (IAS 16, ADR-0001)',
            ),
            description: 'Revaluation loss',
            transactionCurrency: asset.currency,
            debit: split.profitAndLoss.abs().toString(),
          });
        }
        lines.push({
          accountId: category.asset_account_id,
          description: `Revaluation ${asset.asset_number}`,
          transactionCurrency: asset.currency,
          credit: amount.abs().toString(),
        });
      }

      const transactionId = await this.postValuationTransaction(client, context, principal, {
        asset,
        book,
        kind: 'REVALUATION',
        ruleCode: 'ASSET_REVALUATION',
        eventName: 'asset.revalued',
        postingDate: input.postingDate,
        amount,
        reason: input.reason,
        valuationEvidenceFileId: input.valuationEvidenceFileId ?? null,
        reversesTransactionId: null,
        lines,
      });

      await client.query(
        `UPDATE asset_books SET revaluation_surplus = revaluation_surplus + $2 WHERE id = $1`,
        [book.id, split.surplus.toString()],
      );

      return this.transactionResult(client, transactionId);
    });
  }

  /**
   * The shared tail of every valuation transaction: post the journal, then
   * record the transaction row that carries doc 09's required evidence —
   * reason, valuation evidence, date and approval — pointing at the journal it
   * explains.
   */
  private async postValuationTransaction(
    client: PoolClient,
    context: RequestContext,
    principal: TenantPrincipal,
    args: {
      asset: FixedAssetRow;
      book: AssetBookRow;
      kind: 'IMPAIRMENT' | 'IMPAIRMENT_REVERSAL' | 'REVALUATION';
      ruleCode: string;
      eventName: string;
      postingDate: string;
      amount: Decimal;
      reason: string;
      valuationEvidenceFileId: string | null;
      reversesTransactionId: string | null;
      lines: DraftLineInput[];
    },
  ): Promise<string> {
    const bookContext = await this.posting.loadBookContext(
      client,
      principal,
      args.book.accounting_book_id,
      args.postingDate,
    );

    const transactionId = uuidv7();
    const result = await this.documents.post(client, context, principal, bookContext, {
      ruleCode: args.ruleCode,
      sourceType: 'asset_transaction',
      sourceId: transactionId,
      sourceEventId: `${args.eventName}:${transactionId}`,
      journalCode: 'GEN',
      postingDate: args.postingDate,
      documentDate: args.postingDate,
      description: `${args.kind} ${args.asset.asset_number}: ${args.reason}`,
      branchId: args.asset.branch_id,
      contactId: null,
      lines: args.lines,
    });

    await client.query(
      `INSERT INTO asset_transactions
         (id, tenant_id, legal_entity_id, fixed_asset_id, asset_book_id, kind, posting_date,
          amount, currency, reason, valuation_evidence_file_id, approved_by, approved_at,
          journal_entry_id, reverses_transaction_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),$13,$14)`,
      [
        transactionId,
        principal.tenantId,
        args.asset.legal_entity_id,
        args.asset.id,
        args.book.id,
        args.kind,
        args.postingDate,
        args.amount.toString(),
        args.asset.currency,
        args.reason,
        args.valuationEvidenceFileId,
        principal.userId,
        result.entry.id,
        args.reversesTransactionId,
      ],
    );

    await recordAudit(client, context, {
      tenantId: principal.tenantId,
      legalEntityId: args.asset.legal_entity_id,
      action: args.eventName,
      resourceType: 'asset_transaction',
      resourceId: transactionId,
      reason: args.reason,
      after: {
        fixed_asset_id: args.asset.id,
        asset_book_id: args.book.id,
        kind: args.kind,
        amount: args.amount.toString(),
        journal_entry_id: result.entry.id,
      },
    });

    return transactionId;
  }

  /**
   * `asset_status` distinguishes IMPAIRED from ACTIVE, and the flag must follow
   * the facts in both directions: an asset whose impairment has been fully
   * reversed is not impaired, whatever it once was. Only the ACTIVE/IMPAIRED
   * pair is touched — DISPOSED and friends are terminal.
   */
  private async refreshImpairedStatus(client: PoolClient, fixedAssetId: string): Promise<void> {
    await client.query(
      `UPDATE fixed_assets a
          SET status = CASE
                WHEN EXISTS (SELECT 1 FROM asset_books b
                              WHERE b.fixed_asset_id = a.id AND b.accumulated_impairment > 0)
                THEN 'IMPAIRED'::asset_status ELSE 'ACTIVE'::asset_status END
        WHERE a.id = $1 AND a.status IN ('ACTIVE','IMPAIRED')`,
      [fixedAssetId],
    );
  }

  private async transactionResult(client: PoolClient, transactionId: string) {
    const { rows } = await client.query(
      `SELECT t.id, t.fixed_asset_id, t.asset_book_id, t.kind::text AS kind,
              t.posting_date::text AS posting_date, t.amount::text AS amount, t.currency,
              t.reason, t.valuation_evidence_file_id, t.approved_by, t.approved_at,
              t.journal_entry_id, t.reverses_transaction_id,
              (b.cost_basis + r.total - b.accumulated_depreciation - b.accumulated_impairment)::text
                AS carrying_amount
         FROM asset_transactions t
         JOIN asset_books b ON b.id = t.asset_book_id
         CROSS JOIN LATERAL (
           SELECT coalesce(sum(x.amount), 0) AS total
             FROM asset_transactions x
            WHERE x.asset_book_id = b.id AND x.kind = 'REVALUATION'
         ) r
        WHERE t.id = $1`,
      [transactionId],
    );
    return rows[0];
  }
}

function requireReason(reason: string, what: string): void {
  if (!reason?.trim()) {
    // Also a database CHECK (at_controlled_needs_approval); refused here with
    // doc 09's words instead of a constraint violation.
    throw new AppError(
      'VALIDATION_FAILED',
      `A ${what} is a controlled transaction and doc 09 requires its reason be stored.`,
    );
  }
}

function impairmentAccounts(category: AssetCategoryRow): { loss: string; accumulated: string } {
  return {
    loss: requireAccount(
      category.impairment_loss_account_id,
      category.code,
      'impairment_loss_account_id',
      'the impairment loss has nowhere to post',
    ),
    accumulated: requireAccount(
      category.accumulated_impairment_account_id,
      category.code,
      'accumulated_impairment_account_id',
      'the write-down must sit in a contra account, not overwrite historical cost (doc 09)',
    ),
  };
}

function requireAccount(
  accountId: string | null,
  categoryCode: string,
  column: string,
  why: string,
): string {
  if (!accountId) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Category ${categoryCode} has no ${column}: ${why}. Set it on the category first.`,
      { details: { category_code: categoryCode, missing: column } },
    );
  }
  return accountId;
}
