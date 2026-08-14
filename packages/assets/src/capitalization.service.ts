import { Pool, PoolClient } from 'pg';
import {
  AppError,
  uuidv7,
  D,
  accountingDate,
  buildSchedule,
  assertEntityPermission,
  type TenantPrincipal,
  type DepreciationMethod,
  type ProrationConvention,
  type DepreciationScheduleLine,
} from '@acct/domain';
import { writeInTenant, recordAudit } from '@acct/database';
import { PostingService } from '@acct/ledger';
import { DocumentPostingService } from '@acct/subledger';
import {
  loadAssetBooks,
  loadAssetCategory,
  loadFixedAsset,
  type AssetBookRow,
} from './register.service';

/**
 * Capitalization — doc 09: "Posting: Dr Fixed Asset / Cr AP, Bank or clearing
 * as applicable", and "Generate schedule from in-service date through useful
 * life, respecting residual value."
 *
 * One call does both, in one transaction, because they are two halves of one
 * accounting event: an asset whose cost is on the GL but whose schedule was
 * never written silently never depreciates, and the asset-to-GL reconciliation
 * (exit criterion 4) discovers it months later as an unexplainable difference.
 */
export class AssetCapitalizationService {
  constructor(
    private readonly pool: Pool,
    private readonly posting: PostingService,
    private readonly documents: DocumentPostingService,
  ) {}

  async capitalizeAsset(
    principal: TenantPrincipal,
    fixedAssetId: string,
    input: {
      postingDate: string;
      /** AP, bank or clearing — required unless the asset comes from CIP. */
      creditAccountId?: string | null | undefined;
      inServiceDate?: string | null | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const asset = await loadFixedAsset(client, fixedAssetId, { forUpdate: true });
      assertEntityPermission(principal, 'asset.capitalize', asset.legal_entity_id);

      if (asset.status !== 'DRAFT') {
        // Capitalizing twice would post the cost twice. The idempotency layer
        // handles the retried request; this handles the genuinely second one.
        throw new AppError(
          'POSTED_IMMUTABLE',
          `Asset ${fixedAssetId} is ${asset.status}; it has already been capitalized. A ` +
            `correction is a reversal, never a re-capitalization.`,
          { details: { status: asset.status } },
        );
      }

      const category = await loadAssetCategory(client, asset.asset_category_id);

      // doc 09: an asset acquired through CIP capitalizes OUT of the CIP
      // account (ASSET_CAPITALIZED_FROM_CIP); anything else credits the
      // AP/bank/clearing account the caller names (ASSET_ACQUIRED).
      const fromCip = asset.acquisition_source === 'CIP';
      const creditAccountId = fromCip ? category.cip_account_id : (input.creditAccountId ?? null);
      if (!creditAccountId) {
        throw new AppError(
          'VALIDATION_FAILED',
          fromCip
            ? `Asset ${fixedAssetId} was acquired through CIP but category ${category.code} has ` +
                `no CIP account to relieve. Set cip_account_id on the category.`
            : 'A capitalization needs the account it credits — AP, bank or a clearing account.',
        );
      }

      const books = (await loadAssetBooks(client, fixedAssetId, { forUpdate: true })).filter(
        (b) => b.status === 'ACTIVE',
      );
      if (books.length === 0) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Asset ${fixedAssetId} has no asset book. Without one there is no schedule and no ` +
            `depreciation (F-904) — create the book first.`,
        );
      }

      const inServiceDate = input.inServiceDate ?? asset.in_service_date ?? input.postingDate;

      const { rows: currencies } = await client.query<{ minor_unit: number }>(
        `SELECT minor_unit FROM currencies WHERE code = $1`,
        [asset.currency],
      );
      const minorUnit = currencies[0]?.minor_unit;
      if (minorUnit === undefined) {
        throw new AppError('VALIDATION_FAILED', `Currency ${asset.currency} is not configured.`);
      }

      const entries: { accounting_book_id: string; journal_entry_id: string }[] = [];
      let scheduleLineCount = 0;

      for (const book of books) {
        const schedule = buildSchedule({
          method: book.method as DepreciationMethod,
          proration: book.proration as ProrationConvention,
          costBasis: D(book.cost_basis),
          residualValue: D(book.residual_value),
          usefulLifeMonths: book.useful_life_months,
          inServiceDate: accountingDate(book.depreciation_start_date),
          minorUnit,
        });
        scheduleLineCount += await this.persistSchedule(client, principal, book, schedule);

        // One journal per accounting book — doc 09's "each book has independent
        // schedule/journals". The event id carries the book so a parallel
        // book's posting can never replay-return the primary's entry.
        const bookContext = await this.posting.loadBookContext(
          client,
          principal,
          book.accounting_book_id,
          input.postingDate,
        );
        const result = await this.documents.post(client, context, principal, bookContext, {
          ruleCode: fromCip ? 'ASSET_CAPITALIZED_FROM_CIP' : 'ASSET_ACQUIRED',
          sourceType: 'fixed_asset',
          sourceId: fixedAssetId,
          sourceEventId: `asset.capitalized:${fixedAssetId}:${book.accounting_book_id}`,
          journalCode: 'GEN',
          postingDate: input.postingDate,
          documentDate: asset.acquisition_date ?? input.postingDate,
          description: `Capitalize ${asset.asset_number} ${asset.name}`,
          branchId: asset.branch_id,
          contactId: null,
          lines: [
            {
              accountId: category.asset_account_id,
              description: `Asset cost ${asset.asset_number}`,
              transactionCurrency: asset.currency,
              debit: book.cost_basis,
            },
            {
              accountId: creditAccountId,
              description: fromCip ? 'Capitalized from CIP' : 'Capitalization credit',
              transactionCurrency: asset.currency,
              credit: book.cost_basis,
            },
          ],
        });
        entries.push({
          accounting_book_id: book.accounting_book_id,
          journal_entry_id: result.entry.id,
        });

        await client.query(
          `INSERT INTO asset_transactions
             (id, tenant_id, legal_entity_id, fixed_asset_id, asset_book_id, kind, posting_date,
              amount, currency, journal_entry_id)
           VALUES ($1,$2,$3,$4,$5,'CAPITALIZATION',$6,$7,$8,$9)`,
          [
            uuidv7(),
            principal.tenantId,
            asset.legal_entity_id,
            fixedAssetId,
            book.id,
            input.postingDate,
            book.cost_basis,
            asset.currency,
            result.entry.id,
          ],
        );
      }

      const { rows } = await client.query(
        `UPDATE fixed_assets SET status = 'ACTIVE', in_service_date = $2
          WHERE id = $1
        RETURNING id, asset_number, name, status::text AS status,
                  in_service_date::text AS in_service_date,
                  acquisition_cost::text AS acquisition_cost`,
        [fixedAssetId, inServiceDate],
      );

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: asset.legal_entity_id,
        action: 'asset.capitalized',
        resourceType: 'fixed_asset',
        resourceId: fixedAssetId,
        after: {
          ...(rows[0] as Record<string, unknown>),
          entries,
          schedule_lines: scheduleLineCount,
        },
      });

      return { ...rows[0], entries, schedule_lines: scheduleLineCount };
    });
  }

  /**
   * Persists the engine's schedule as `depreciation_schedule_lines`, one per
   * accounting period.
   *
   * Every schedule month must resolve to a configured period: the line's period
   * id is NOT NULL, and a month silently skipped here would be a month that
   * never depreciates and an asset whose accumulated depreciation never reaches
   * cost − residual. So a missing period refuses the whole capitalization and
   * names the month, rather than persisting a schedule with a hole in it.
   */
  private async persistSchedule(
    client: PoolClient,
    principal: TenantPrincipal,
    book: AssetBookRow,
    schedule: readonly DepreciationScheduleLine[],
  ): Promise<number> {
    if (schedule.length === 0) return 0; // cost entirely residual: nothing to depreciate

    const months = schedule.map((line) => line.period);
    const { rows: periods } = await client.query<{ id: string; month: string }>(
      `SELECT p.id, m.month::text AS month
         FROM unnest($1::date[]) AS m(month)
         JOIN accounting_periods p
           ON p.legal_entity_id = $2
          AND NOT p.is_adjustment
          AND m.month BETWEEN p.start_date AND p.end_date`,
      [months, book.legal_entity_id],
    );
    const periodByMonth = new Map(periods.map((p) => [p.month, p.id]));

    for (const line of schedule) {
      const periodId = periodByMonth.get(line.period);
      if (!periodId) {
        throw new AppError(
          'NO_PERIOD_FOR_DATE',
          `The depreciation schedule reaches ${line.period} and no accounting period covers it. ` +
            `Create the fiscal years through the end of the asset's useful life, then capitalize.`,
          { details: { month: line.period, asset_book_id: book.id } },
        );
      }
      await client.query(
        `INSERT INTO depreciation_schedule_lines
           (id, tenant_id, asset_book_id, legal_entity_id, accounting_period_id, revision,
            scheduled_amount, status)
         VALUES ($1,$2,$3,$4,$5,1,$6,'SCHEDULED')`,
        [
          uuidv7(),
          principal.tenantId,
          book.id,
          book.legal_entity_id,
          periodId,
          line.amount.toString(),
        ],
      );
    }
    return schedule.length;
  }
}
