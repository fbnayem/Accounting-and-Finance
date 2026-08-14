import { Pool, PoolClient } from 'pg';
import {
  AppError,
  notFound,
  uuidv7,
  D,
  assertEntityPermission,
  type TenantPrincipal,
} from '@acct/domain';
import { writeInTenant, readInTenant, recordAudit } from '@acct/database';

/**
 * The asset register — doc 09 "Asset creation", "Multiple books", "Transfers".
 *
 * Nothing in this file posts. An asset is created DRAFT and stays a record
 * until capitalization turns it into an accounting fact; a transfer moves the
 * asset's location/custodian assignments, which doc 09 keeps as dated history
 * precisely so "who had this asset in March" remains answerable in December.
 */

export interface FixedAssetRow {
  id: string;
  tenant_id: string;
  legal_entity_id: string;
  asset_category_id: string;
  branch_id: string | null;
  asset_number: string;
  name: string;
  acquisition_source: string | null;
  acquisition_date: string | null;
  in_service_date: string | null;
  currency: string;
  acquisition_cost: string;
  status: string;
}

export interface AssetCategoryRow {
  id: string;
  legal_entity_id: string;
  code: string;
  name: string;
  asset_account_id: string;
  accumulated_depreciation_account_id: string;
  depreciation_expense_account_id: string;
  impairment_loss_account_id: string | null;
  accumulated_impairment_account_id: string | null;
  revaluation_surplus_account_id: string | null;
  gain_account_id: string | null;
  loss_account_id: string | null;
  cip_account_id: string | null;
  default_method: string;
  default_useful_life_months: number | null;
  default_proration: string;
}

export interface AssetBookRow {
  id: string;
  fixed_asset_id: string;
  accounting_book_id: string;
  legal_entity_id: string;
  method: string;
  proration: string;
  useful_life_months: number;
  residual_value: string;
  depreciation_start_date: string;
  cost_basis: string;
  accumulated_depreciation: string;
  accumulated_impairment: string;
  revaluation_surplus: string;
  status: string;
}

export async function loadFixedAsset(
  client: PoolClient,
  id: string,
  opts: { forUpdate?: boolean } = {},
): Promise<FixedAssetRow> {
  const { rows } = await client.query<FixedAssetRow>(
    `SELECT id, tenant_id, legal_entity_id, asset_category_id, branch_id, asset_number, name,
            acquisition_source, acquisition_date::text AS acquisition_date,
            in_service_date::text AS in_service_date, currency,
            acquisition_cost::text AS acquisition_cost, status::text AS status
       FROM fixed_assets WHERE id = $1${opts.forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
  const asset = rows[0];
  if (!asset) throw notFound('fixed_asset', id);
  return asset;
}

export async function loadAssetCategory(client: PoolClient, id: string): Promise<AssetCategoryRow> {
  const { rows } = await client.query<AssetCategoryRow>(
    `SELECT id, legal_entity_id, code, name, asset_account_id,
            accumulated_depreciation_account_id, depreciation_expense_account_id,
            impairment_loss_account_id, accumulated_impairment_account_id,
            revaluation_surplus_account_id, gain_account_id, loss_account_id, cip_account_id,
            default_method::text AS default_method, default_useful_life_months,
            default_proration::text AS default_proration
       FROM asset_categories WHERE id = $1`,
    [id],
  );
  const category = rows[0];
  if (!category) throw notFound('asset_category', id);
  return category;
}

const ASSET_BOOK_COLUMNS = `id, fixed_asset_id, accounting_book_id, legal_entity_id,
            method::text AS method, proration::text AS proration, useful_life_months,
            residual_value::text AS residual_value,
            depreciation_start_date::text AS depreciation_start_date,
            cost_basis::text AS cost_basis,
            accumulated_depreciation::text AS accumulated_depreciation,
            accumulated_impairment::text AS accumulated_impairment,
            revaluation_surplus::text AS revaluation_surplus, status::text AS status`;

/** The asset's book for one accounting book — how every valuation route names its target. */
export async function loadAssetBook(
  client: PoolClient,
  fixedAssetId: string,
  accountingBookId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<AssetBookRow> {
  const { rows } = await client.query<AssetBookRow>(
    `SELECT ${ASSET_BOOK_COLUMNS}
       FROM asset_books WHERE fixed_asset_id = $1 AND accounting_book_id = $2
       ${opts.forUpdate ? 'FOR UPDATE' : ''}`,
    [fixedAssetId, accountingBookId],
  );
  const book = rows[0];
  if (!book) throw notFound('asset_book', `${fixedAssetId}/${accountingBookId}`);
  return book;
}

export async function loadAssetBooks(
  client: PoolClient,
  fixedAssetId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<AssetBookRow[]> {
  const { rows } = await client.query<AssetBookRow>(
    `SELECT ${ASSET_BOOK_COLUMNS}
       FROM asset_books WHERE fixed_asset_id = $1 ORDER BY id
       ${opts.forUpdate ? 'FOR UPDATE' : ''}`,
    [fixedAssetId],
  );
  return rows;
}

/**
 * Net effect of posted revaluations on one asset book.
 *
 * doc 09: "never overwrite historical cost/accumulated values." A revaluation
 * writes an `asset_transactions` row instead of touching `cost_basis`, so the
 * GL asset account holds cost + this sum, and every carrying amount in this
 * package derives from the same expression.
 */
export async function revaluationTotal(client: PoolClient, assetBookId: string): Promise<string> {
  const { rows } = await client.query<{ total: string }>(
    `SELECT coalesce(sum(amount), 0)::text AS total
       FROM asset_transactions WHERE asset_book_id = $1 AND kind = 'REVALUATION'`,
    [assetBookId],
  );
  return rows[0]!.total;
}

const ACQUISITION_SOURCES = new Set(['PURCHASE', 'MANUAL', 'MIGRATION', 'CIP', 'DONATION']);

export class AssetRegisterService {
  constructor(private readonly pool: Pool) {}

  async createAsset(
    principal: TenantPrincipal,
    input: {
      legalEntityId: string;
      assetCategoryId: string;
      assetNumber: string;
      name: string;
      currency: string;
      acquisitionCost: string;
      description?: string | null | undefined;
      acquisitionSource?: string | undefined;
      acquisitionDate?: string | null | undefined;
      inServiceDate?: string | null | undefined;
      branchId?: string | null | undefined;
      serialNumber?: string | null | undefined;
      assetTag?: string | null | undefined;
      vendorBillLineId?: string | null | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      assertEntityPermission(principal, 'asset.create', input.legalEntityId);

      const category = await loadAssetCategory(client, input.assetCategoryId);
      if (category.legal_entity_id !== input.legalEntityId) {
        throw new AppError(
          'CROSS_ENTITY_REFERENCE',
          `Category ${input.assetCategoryId} belongs to another legal entity.`,
          { details: { asset_category_id: input.assetCategoryId } },
        );
      }

      const source = input.acquisitionSource ?? 'MANUAL';
      if (!ACQUISITION_SOURCES.has(source)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `"${source}" is not an acquisition source. The schema names: ${[...ACQUISITION_SOURCES].join(', ')}.`,
        );
      }

      const cost = D(input.acquisitionCost);
      if (cost.isNegative()) {
        throw new AppError(
          'VALIDATION_FAILED',
          `An acquisition cost of ${cost.toString()} is negative; there is no such purchase.`,
        );
      }

      const { rows: duplicate } = await client.query(
        `SELECT id FROM fixed_assets WHERE legal_entity_id = $1 AND asset_number = $2`,
        [input.legalEntityId, input.assetNumber],
      );
      if (duplicate[0]) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Asset number "${input.assetNumber}" already exists in this legal entity.`,
          { details: { asset_number: input.assetNumber } },
        );
      }

      const id = uuidv7();
      const { rows } = await client.query(
        `INSERT INTO fixed_assets
           (id, tenant_id, legal_entity_id, asset_category_id, branch_id, asset_number, name,
            description, serial_number, asset_tag, acquisition_source, vendor_bill_line_id,
            acquisition_date, in_service_date, currency, acquisition_cost, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'DRAFT')
         RETURNING id, legal_entity_id, asset_category_id, branch_id, asset_number, name,
                   description, serial_number, asset_tag, acquisition_source,
                   acquisition_date::text AS acquisition_date,
                   in_service_date::text AS in_service_date, currency,
                   acquisition_cost::text AS acquisition_cost, status::text AS status, created_at`,
        [
          id,
          principal.tenantId,
          input.legalEntityId,
          input.assetCategoryId,
          input.branchId ?? null,
          input.assetNumber,
          input.name,
          input.description ?? null,
          input.serialNumber ?? null,
          input.assetTag ?? null,
          source,
          input.vendorBillLineId ?? null,
          input.acquisitionDate ?? null,
          input.inServiceDate ?? null,
          input.currency,
          cost.toString(),
        ],
      );

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: input.legalEntityId,
        action: 'asset.created',
        resourceType: 'fixed_asset',
        resourceId: id,
        after: rows[0] as Record<string, unknown>,
      });

      return rows[0];
    });
  }

  async listAssets(
    principal: TenantPrincipal,
    query: {
      legalEntityId?: string | undefined;
      assetCategoryId?: string | undefined;
      status?: string | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT a.id, a.legal_entity_id, a.asset_category_id, c.code AS category_code,
                a.branch_id, a.asset_number, a.name, a.serial_number, a.asset_tag,
                a.acquisition_source, a.acquisition_date::text AS acquisition_date,
                a.in_service_date::text AS in_service_date, a.currency,
                a.acquisition_cost::text AS acquisition_cost, a.status::text AS status, a.created_at
           FROM fixed_assets a
           JOIN asset_categories c ON c.id = a.asset_category_id
          WHERE ($1::uuid IS NULL OR a.legal_entity_id = $1)
            AND ($2::uuid IS NULL OR a.asset_category_id = $2)
            AND ($3::text IS NULL OR a.status::text = $3)
          ORDER BY a.asset_number`,
        [query.legalEntityId ?? null, query.assetCategoryId ?? null, query.status ?? null],
      );
      return { data: rows };
    });
  }

  /**
   * F-910: the drill behind a register row — the asset with its books, its
   * transaction history and its current carrying amount per book.
   *
   * Carrying amount is DERIVED here, never stored: cost basis plus posted
   * revaluations, less accumulated depreciation and impairment. doc 09 forbids
   * overwriting historical cost, so a stored carrying amount would only ever be
   * a second copy waiting to disagree.
   */
  async getAsset(principal: TenantPrincipal, id: string) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const asset = await loadFixedAsset(client, id);
      assertEntityPermission(principal, 'asset.view', asset.legal_entity_id);

      const { rows: books } = await client.query(
        `SELECT b.id, b.accounting_book_id, b.method::text AS method,
                b.proration::text AS proration, b.useful_life_months,
                b.residual_value::text AS residual_value,
                b.depreciation_start_date::text AS depreciation_start_date,
                b.cost_basis::text AS cost_basis,
                b.accumulated_depreciation::text AS accumulated_depreciation,
                b.accumulated_impairment::text AS accumulated_impairment,
                b.revaluation_surplus::text AS revaluation_surplus,
                r.total::text AS revaluation_total,
                (b.cost_basis + r.total - b.accumulated_depreciation - b.accumulated_impairment)::text
                  AS carrying_amount,
                b.status::text AS status
           FROM asset_books b
           CROSS JOIN LATERAL (
             SELECT coalesce(sum(t.amount), 0) AS total
               FROM asset_transactions t
              WHERE t.asset_book_id = b.id AND t.kind = 'REVALUATION'
           ) r
          WHERE b.fixed_asset_id = $1
          ORDER BY b.id`,
        [id],
      );

      const { rows: transactions } = await client.query(
        `SELECT id, asset_book_id, kind::text AS kind, posting_date::text AS posting_date,
                amount::text AS amount, currency, reason, valuation_evidence_file_id,
                approved_by, approved_at, journal_entry_id, reverses_transaction_id, created_at
           FROM asset_transactions
          WHERE fixed_asset_id = $1
          ORDER BY posting_date, created_at`,
        [id],
      );

      const { rows: disposals } = await client.query(
        `SELECT id, asset_book_id, kind::text AS kind, disposal_date::text AS disposal_date,
                proceeds_amount::text AS proceeds_amount, carrying_amount::text AS carrying_amount,
                accumulated_depreciation_removed::text AS accumulated_depreciation_removed,
                gain_loss_amount::text AS gain_loss_amount, buyer_contact_id, invoice_id,
                journal_entry_id, created_at
           FROM disposal_records
          WHERE fixed_asset_id = $1
          ORDER BY disposal_date`,
        [id],
      );

      return { ...asset, books, transactions, disposals };
    });
  }

  /**
   * F-904: without an asset book there is no schedule and no depreciation —
   * `depreciation_schedule_lines.asset_book_id` is NOT NULL.
   *
   * Books are added while the asset is DRAFT. Capitalization is the moment the
   * schedule is generated and the cost posted per book, and a book added after
   * that would silently have neither — so the window closes there.
   */
  async createAssetBook(
    principal: TenantPrincipal,
    fixedAssetId: string,
    input: {
      accountingBookId: string;
      method?: string | undefined;
      proration?: string | undefined;
      usefulLifeMonths?: number | undefined;
      residualValue?: string | undefined;
      depreciationStartDate?: string | undefined;
      costBasis?: string | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const asset = await loadFixedAsset(client, fixedAssetId, { forUpdate: true });
      assertEntityPermission(principal, 'asset.create', asset.legal_entity_id);

      if (asset.status !== 'DRAFT') {
        throw new AppError(
          'VALIDATION_FAILED',
          `Asset ${fixedAssetId} is ${asset.status}. Books are added before capitalization: the ` +
            `schedule is generated and the cost posted per book at that moment, and a book added ` +
            `later would have neither.`,
          { details: { status: asset.status } },
        );
      }

      const { rows: accountingBooks } = await client.query<{
        id: string;
        legal_entity_id: string;
        base_currency: string;
        status: string;
      }>(
        `SELECT id, legal_entity_id, base_currency, status::text AS status
           FROM accounting_books WHERE id = $1`,
        [input.accountingBookId],
      );
      const accountingBook = accountingBooks[0];
      if (!accountingBook) throw notFound('accounting_book', input.accountingBookId);
      if (accountingBook.legal_entity_id !== asset.legal_entity_id) {
        throw new AppError(
          'CROSS_ENTITY_REFERENCE',
          `Accounting book ${input.accountingBookId} belongs to another legal entity.`,
          { details: { accounting_book_id: input.accountingBookId } },
        );
      }
      if (accountingBook.base_currency !== asset.currency) {
        // The book's schedule amounts become journal lines in the book's base
        // currency. A cross-currency asset book would need a rate per period and
        // a translation policy neither doc 09 nor this phase defines, so it is
        // refused rather than guessed at.
        throw new AppError(
          'BOOK_MISMATCH',
          `Asset ${fixedAssetId} is in ${asset.currency} but book ${input.accountingBookId} posts ` +
            `in ${accountingBook.base_currency}. Record the asset in the book's base currency.`,
          {
            details: {
              asset_currency: asset.currency,
              base_currency: accountingBook.base_currency,
            },
          },
        );
      }

      const { rows: existing } = await client.query(
        `SELECT id FROM asset_books WHERE fixed_asset_id = $1 AND accounting_book_id = $2`,
        [fixedAssetId, input.accountingBookId],
      );
      if (existing[0]) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Asset ${fixedAssetId} already has a book for accounting book ${input.accountingBookId}.`,
        );
      }

      const category = await loadAssetCategory(client, asset.asset_category_id);
      const method = input.method ?? category.default_method;
      const proration = input.proration ?? category.default_proration;
      const usefulLifeMonths = input.usefulLifeMonths ?? category.default_useful_life_months;
      if (
        usefulLifeMonths == null ||
        !Number.isInteger(usefulLifeMonths) ||
        usefulLifeMonths <= 0
      ) {
        throw new AppError(
          'VALIDATION_FAILED',
          `A useful life is required and category ${category.code} has no default. ` +
            `Pass usefulLifeMonths or set the category default.`,
          { details: { useful_life_months: usefulLifeMonths } },
        );
      }
      if (method === 'DECLINING_BALANCE') {
        // buildSchedule supports the method, but it needs an annual rate and
        // `asset_books` has no column to keep one — a rate accepted here would
        // have nowhere to live that survives to the depreciation run. Refused
        // until the schema carries it; see the package's integration notes.
        throw new AppError(
          'NOT_IMPLEMENTED',
          'DECLINING_BALANCE needs an annual rate stored per asset book, and asset_books has no ' +
            'column for one yet. Use STRAIGHT_LINE, or add the column first.',
          { details: { method } },
        );
      }
      if (method === 'UNITS_OF_PRODUCTION' || method === 'CUSTOM') {
        throw new AppError(
          'NOT_IMPLEMENTED',
          `DEPRECIATION_METHOD_NOT_IMPLEMENTED: ${method} is deferred by doc 09.`,
          { details: { method } },
        );
      }

      const startDate = input.depreciationStartDate ?? asset.in_service_date;
      if (!startDate) {
        throw new AppError(
          'VALIDATION_FAILED',
          "A depreciation start date is required: pass depreciationStartDate or set the asset's " +
            'in-service date.',
        );
      }

      const costBasis = D(input.costBasis ?? asset.acquisition_cost);
      const residual = D(input.residualValue ?? '0');
      if (costBasis.isNegative() || residual.isNegative()) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Cost basis ${costBasis.toString()} and residual ${residual.toString()} must both be >= 0.`,
        );
      }
      if (residual.gt(costBasis)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `RESIDUAL_EXCEEDS_COST: residual ${residual.toString()} exceeds cost ` +
            `${costBasis.toString()}; depreciation cannot raise a carrying amount.`,
          { details: { cost_basis: costBasis.toString(), residual_value: residual.toString() } },
        );
      }

      const id = uuidv7();
      const { rows } = await client.query(
        `INSERT INTO asset_books
           (id, tenant_id, fixed_asset_id, accounting_book_id, legal_entity_id, method, proration,
            useful_life_months, residual_value, depreciation_start_date, cost_basis, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ACTIVE')
         RETURNING id, fixed_asset_id, accounting_book_id, method::text AS method,
                   proration::text AS proration, useful_life_months,
                   residual_value::text AS residual_value,
                   depreciation_start_date::text AS depreciation_start_date,
                   cost_basis::text AS cost_basis, status::text AS status`,
        [
          id,
          principal.tenantId,
          fixedAssetId,
          input.accountingBookId,
          asset.legal_entity_id,
          method,
          proration,
          usefulLifeMonths,
          residual.toString(),
          startDate,
          costBasis.toString(),
        ],
      );

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: asset.legal_entity_id,
        action: 'asset.created',
        resourceType: 'asset_book',
        resourceId: id,
        after: rows[0] as Record<string, unknown>,
      });

      return rows[0];
    });
  }

  /**
   * doc 09 "Transfers": location, branch or custodian with effective date and
   * complete assignment history. No journal — a transfer inside one legal
   * entity moves no value; between entities it would be an intercompany
   * transaction (doc 17), which this route refuses by construction because the
   * asset's entity never changes.
   */
  async transferAsset(
    principal: TenantPrincipal,
    fixedAssetId: string,
    input: {
      effectiveDate: string;
      branchId?: string | null | undefined;
      warehouseLocationId?: string | null | undefined;
      freeTextLocation?: string | null | undefined;
      custodianUserId?: string | null | undefined;
      custodianName?: string | null | undefined;
      reason?: string | null | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const asset = await loadFixedAsset(client, fixedAssetId, { forUpdate: true });
      assertEntityPermission(principal, 'asset.transfer', asset.legal_entity_id);

      if (asset.status === 'DISPOSED' || asset.status === 'WRITTEN_OFF') {
        throw new AppError(
          'VALIDATION_FAILED',
          `Asset ${fixedAssetId} is ${asset.status}; there is nothing left to transfer.`,
          { details: { status: asset.status } },
        );
      }

      const movesLocation =
        input.branchId != null ||
        input.warehouseLocationId != null ||
        input.freeTextLocation != null;
      const movesCustodian = input.custodianUserId != null || input.custodianName != null;
      if (!movesLocation && !movesCustodian) {
        throw new AppError(
          'VALIDATION_FAILED',
          'A transfer names a new location (branch, warehouse location or free text) or a new ' +
            'custodian; this one names neither.',
        );
      }

      if (movesLocation) {
        await this.closeOpenAssignment(
          client,
          'asset_location_assignments',
          fixedAssetId,
          input.effectiveDate,
        );
        await client.query(
          `INSERT INTO asset_location_assignments
             (id, tenant_id, legal_entity_id, fixed_asset_id, branch_id, warehouse_location_id,
              free_text_location, valid_from)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            uuidv7(),
            principal.tenantId,
            asset.legal_entity_id,
            fixedAssetId,
            input.branchId ?? null,
            input.warehouseLocationId ?? null,
            input.freeTextLocation ?? null,
            input.effectiveDate,
          ],
        );
        if (input.branchId != null) {
          await client.query(`UPDATE fixed_assets SET branch_id = $2 WHERE id = $1`, [
            fixedAssetId,
            input.branchId,
          ]);
        }
      }

      if (movesCustodian) {
        await this.closeOpenAssignment(
          client,
          'asset_custodian_assignments',
          fixedAssetId,
          input.effectiveDate,
        );
        await client.query(
          `INSERT INTO asset_custodian_assignments
             (id, tenant_id, legal_entity_id, fixed_asset_id, custodian_user_id, custodian_name,
              valid_from)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            uuidv7(),
            principal.tenantId,
            asset.legal_entity_id,
            fixedAssetId,
            input.custodianUserId ?? null,
            input.custodianName ?? null,
            input.effectiveDate,
          ],
        );
      }

      // The transaction history row — doc 09/F-201: a transfer is an asset
      // event even though it moves no value, so amount is zero, not null.
      const transactionId = uuidv7();
      await client.query(
        `INSERT INTO asset_transactions
           (id, tenant_id, legal_entity_id, fixed_asset_id, kind, posting_date, amount, currency,
            reason)
         VALUES ($1,$2,$3,$4,'TRANSFER',$5,0,$6,$7)`,
        [
          transactionId,
          principal.tenantId,
          asset.legal_entity_id,
          fixedAssetId,
          input.effectiveDate,
          asset.currency,
          input.reason ?? null,
        ],
      );

      const after = {
        effective_date: input.effectiveDate,
        branch_id: input.branchId ?? null,
        warehouse_location_id: input.warehouseLocationId ?? null,
        free_text_location: input.freeTextLocation ?? null,
        custodian_user_id: input.custodianUserId ?? null,
        custodian_name: input.custodianName ?? null,
      };
      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: asset.legal_entity_id,
        action: 'asset.transferred',
        resourceType: 'fixed_asset',
        resourceId: fixedAssetId,
        after,
      });

      return { fixed_asset_id: fixedAssetId, asset_transaction_id: transactionId, ...after };
    });
  }

  /**
   * History is closed, never rewritten: the open assignment gets a valid_to of
   * the new effective date, which is exactly the half-open range the exclusion
   * constraints (`ala_no_overlap`, `aca_no_overlap`) verify.
   */
  private async closeOpenAssignment(
    client: PoolClient,
    table: 'asset_location_assignments' | 'asset_custodian_assignments',
    fixedAssetId: string,
    effectiveDate: string,
  ): Promise<void> {
    const { rows } = await client.query<{ id: string; valid_from: string }>(
      `SELECT id, valid_from::text AS valid_from FROM ${table}
        WHERE fixed_asset_id = $1 AND valid_to IS NULL FOR UPDATE`,
      [fixedAssetId],
    );
    const open = rows[0];
    if (!open) return;
    if (open.valid_from >= effectiveDate) {
      throw new AppError(
        'VALIDATION_FAILED',
        `The current assignment began ${open.valid_from}; a transfer effective ${effectiveDate} ` +
          `would rewrite that history rather than extend it. Use a later effective date.`,
        { details: { valid_from: open.valid_from, effective_date: effectiveDate } },
      );
    }
    await client.query(`UPDATE ${table} SET valid_to = $2 WHERE id = $1`, [open.id, effectiveDate]);
  }
}
