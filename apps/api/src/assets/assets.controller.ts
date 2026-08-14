import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import {
  AssetCapitalizationService,
  AssetCategoriesService,
  AssetDisposalService,
  AssetRegisterService,
  AssetReportsService,
  AssetValuationService,
  DepreciationRunService,
} from '@acct/assets';
import { Operation } from '../common/operation';
import { decimalString, isoDate, parse, reason, uuid } from '../common/validation';
import type { AuthenticatedRequest } from '../common/auth.guard';
import { tenantPrincipal } from '../common/request';

/**
 * doc 09's sixteen operations.
 *
 * One controller, banking's precedent: they share one subject — the asset
 * register — and the two /reports routes belong beside the operations whose
 * postings they reconcile, not in a reports module that would have to reimport
 * half of @acct/assets to explain a difference. Each handler declares only
 * which contract operation it is; the permission, the idempotency rule and the
 * success status come from `contracts/openapi.yaml` at request time.
 */

const Money = decimalString;

/**
 * Shared by impair, reverse-impairment and revalue: doc 09 calls these
 * controlled transactions and requires reason, evidence, date and approval on
 * each — the shape is the same, only the sign conventions differ.
 */
const ValuationBody = z.object({
  accounting_book_id: uuid,
  amount: Money,
  posting_date: isoDate,
  reason,
  valuation_evidence_file_id: uuid.nullish(),
});

@Controller()
export class AssetsController {
  constructor(
    @Inject(AssetCategoriesService) private readonly categories: AssetCategoriesService,
    @Inject(AssetRegisterService) private readonly register: AssetRegisterService,
    @Inject(AssetCapitalizationService) private readonly capitalization: AssetCapitalizationService,
    @Inject(DepreciationRunService) private readonly depreciation: DepreciationRunService,
    @Inject(AssetValuationService) private readonly valuation: AssetValuationService,
    @Inject(AssetDisposalService) private readonly disposal: AssetDisposalService,
    @Inject(AssetReportsService) private readonly reports: AssetReportsService,
  ) {}

  // --- categories -----------------------------------------------------------

  @Get('asset-categories')
  @Operation('listAssetCategories')
  async listCategories(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(z.object({ legal_entity_id: uuid.optional() }), query);
    return this.categories.listCategories(tenantPrincipal(req), {
      legalEntityId: q.legal_entity_id,
    });
  }

  @Post('asset-categories')
  @Operation('createAssetCategory')
  async createCategory(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const b = parse(
      z.object({
        legal_entity_id: uuid,
        code: z.string().min(1),
        name: z.string().min(1),
        asset_account_id: uuid,
        accumulated_depreciation_account_id: uuid,
        depreciation_expense_account_id: uuid,
        impairment_loss_account_id: uuid.nullish(),
        accumulated_impairment_account_id: uuid.nullish(),
        revaluation_surplus_account_id: uuid.nullish(),
        gain_account_id: uuid.nullish(),
        loss_account_id: uuid.nullish(),
        cip_account_id: uuid.nullish(),
        // Method and proration stay strings here: the service validates them
        // against the schema's enums and answers with the allowed values, which
        // a zod enum would preempt with a less specific message.
        default_method: z.string().optional(),
        default_useful_life_months: z.number().int().nullish(),
        default_proration: z.string().optional(),
        residual_value_policy: z.string().nullish(),
        capitalization_threshold: Money.nullish(),
      }),
      body,
    );
    return this.categories.createCategory(tenantPrincipal(req), {
      legalEntityId: b.legal_entity_id,
      code: b.code,
      name: b.name,
      assetAccountId: b.asset_account_id,
      accumulatedDepreciationAccountId: b.accumulated_depreciation_account_id,
      depreciationExpenseAccountId: b.depreciation_expense_account_id,
      impairmentLossAccountId: b.impairment_loss_account_id,
      accumulatedImpairmentAccountId: b.accumulated_impairment_account_id,
      revaluationSurplusAccountId: b.revaluation_surplus_account_id,
      gainAccountId: b.gain_account_id,
      lossAccountId: b.loss_account_id,
      cipAccountId: b.cip_account_id,
      defaultMethod: b.default_method,
      defaultUsefulLifeMonths: b.default_useful_life_months,
      defaultProration: b.default_proration,
      residualValuePolicy: b.residual_value_policy,
      capitalizationThreshold: b.capitalization_threshold,
    });
  }

  // --- the register ---------------------------------------------------------

  @Get('assets')
  @Operation('listAssets')
  async listAssets(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(
      z.object({
        legal_entity_id: uuid.optional(),
        asset_category_id: uuid.optional(),
        status: z.string().optional(),
      }),
      query,
    );
    return this.register.listAssets(tenantPrincipal(req), {
      legalEntityId: q.legal_entity_id,
      assetCategoryId: q.asset_category_id,
      status: q.status,
    });
  }

  @Post('assets')
  @Operation('createAsset')
  async createAsset(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const b = parse(
      z.object({
        legal_entity_id: uuid,
        asset_category_id: uuid,
        asset_number: z.string().min(1),
        name: z.string().min(1),
        currency: z.string().length(3),
        acquisition_cost: Money,
        description: z.string().nullish(),
        acquisition_source: z.string().optional(),
        acquisition_date: isoDate.nullish(),
        in_service_date: isoDate.nullish(),
        branch_id: uuid.nullish(),
        serial_number: z.string().nullish(),
        asset_tag: z.string().nullish(),
        vendor_bill_line_id: uuid.nullish(),
      }),
      body,
    );
    return this.register.createAsset(tenantPrincipal(req), {
      legalEntityId: b.legal_entity_id,
      assetCategoryId: b.asset_category_id,
      assetNumber: b.asset_number,
      name: b.name,
      currency: b.currency,
      acquisitionCost: b.acquisition_cost,
      description: b.description,
      acquisitionSource: b.acquisition_source,
      acquisitionDate: b.acquisition_date,
      inServiceDate: b.in_service_date,
      branchId: b.branch_id,
      serialNumber: b.serial_number,
      assetTag: b.asset_tag,
      vendorBillLineId: b.vendor_bill_line_id,
    });
  }

  // --- the depreciation run -------------------------------------------------

  // Declared before the /assets/:id routes so the path can never be read as an
  // id — the run is a period-close job over many assets, not an action on one.
  @Post('assets/depreciation-runs')
  @Operation('createDepreciationRun')
  async createDepreciationRun(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const b = parse(z.object({ accounting_book_id: uuid, accounting_period_id: uuid }), body);
    return this.depreciation.createDepreciationRun(tenantPrincipal(req), {
      accountingBookId: b.accounting_book_id,
      accountingPeriodId: b.accounting_period_id,
    });
  }

  @Get('assets/:id')
  @Operation('getAsset')
  async getAsset(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.register.getAsset(tenantPrincipal(req), id);
  }

  @Post('assets/:id/books')
  @Operation('createAssetBook')
  async createAssetBook(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(
      z.object({
        accounting_book_id: uuid,
        method: z.string().optional(),
        proration: z.string().optional(),
        useful_life_months: z.number().int().optional(),
        residual_value: Money.optional(),
        depreciation_start_date: isoDate.optional(),
        cost_basis: Money.optional(),
      }),
      body,
    );
    return this.register.createAssetBook(tenantPrincipal(req), id, {
      accountingBookId: b.accounting_book_id,
      method: b.method,
      proration: b.proration,
      usefulLifeMonths: b.useful_life_months,
      residualValue: b.residual_value,
      depreciationStartDate: b.depreciation_start_date,
      costBasis: b.cost_basis,
    });
  }

  @Get('assets/:id/schedule')
  @Operation('getDepreciationSchedule')
  async getDepreciationSchedule(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Query() query: unknown,
  ) {
    const q = parse(z.object({ accounting_book_id: uuid.optional() }), query);
    return this.depreciation.getDepreciationSchedule(tenantPrincipal(req), id, {
      accountingBookId: q.accounting_book_id,
    });
  }

  // --- lifecycle ------------------------------------------------------------

  @Post('assets/:id/capitalize')
  @Operation('capitalizeAsset')
  async capitalizeAsset(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(
      z.object({
        posting_date: isoDate,
        // AP, bank or clearing. Optional because a CIP-sourced asset credits
        // the category's CIP account instead; the service knows which.
        credit_account_id: uuid.nullish(),
        in_service_date: isoDate.nullish(),
      }),
      body,
    );
    return this.capitalization.capitalizeAsset(tenantPrincipal(req), id, {
      postingDate: b.posting_date,
      creditAccountId: b.credit_account_id,
      inServiceDate: b.in_service_date,
    });
  }

  @Post('assets/:id/transfer')
  @Operation('transferAsset')
  async transferAsset(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(
      z.object({
        effective_date: isoDate,
        branch_id: uuid.nullish(),
        warehouse_location_id: uuid.nullish(),
        free_text_location: z.string().nullish(),
        custodian_user_id: uuid.nullish(),
        custodian_name: z.string().nullish(),
        reason: z.string().nullish(),
      }),
      body,
    );
    return this.register.transferAsset(tenantPrincipal(req), id, {
      effectiveDate: b.effective_date,
      branchId: b.branch_id,
      warehouseLocationId: b.warehouse_location_id,
      freeTextLocation: b.free_text_location,
      custodianUserId: b.custodian_user_id,
      custodianName: b.custodian_name,
      reason: b.reason,
    });
  }

  @Post('assets/:id/impair')
  @Operation('impairAsset')
  async impairAsset(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(ValuationBody, body);
    return this.valuation.impairAsset(tenantPrincipal(req), id, {
      accountingBookId: b.accounting_book_id,
      amount: b.amount,
      postingDate: b.posting_date,
      reason: b.reason,
      valuationEvidenceFileId: b.valuation_evidence_file_id,
    });
  }

  @Post('assets/:id/reverse-impairment')
  @Operation('reverseAssetImpairment')
  async reverseAssetImpairment(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(ValuationBody.extend({ impairment_transaction_id: uuid.nullish() }), body);
    return this.valuation.reverseAssetImpairment(tenantPrincipal(req), id, {
      accountingBookId: b.accounting_book_id,
      amount: b.amount,
      postingDate: b.posting_date,
      reason: b.reason,
      impairmentTransactionId: b.impairment_transaction_id,
      valuationEvidenceFileId: b.valuation_evidence_file_id,
    });
  }

  @Post('assets/:id/revalue')
  @Operation('revalueAsset')
  async revalueAsset(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    // `amount` is the SIGNED change in carrying amount — decimalString admits a
    // leading minus, and a downward revaluation arrives as a negative amount
    // rather than a separate direction field.
    const b = parse(ValuationBody, body);
    return this.valuation.revalueAsset(tenantPrincipal(req), id, {
      accountingBookId: b.accounting_book_id,
      amount: b.amount,
      postingDate: b.posting_date,
      reason: b.reason,
      valuationEvidenceFileId: b.valuation_evidence_file_id,
    });
  }

  @Post('assets/:id/dispose')
  @Operation('disposeAsset')
  async disposeAsset(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(
      z.object({
        kind: z.string().min(1),
        disposal_date: isoDate,
        proceeds_amount: Money.optional(),
        proceeds_account_id: uuid.nullish(),
        buyer_contact_id: uuid.nullish(),
        invoice_id: uuid.nullish(),
        reason: z.string().nullish(),
      }),
      body,
    );
    return this.disposal.disposeAsset(tenantPrincipal(req), id, {
      kind: b.kind,
      disposalDate: b.disposal_date,
      proceedsAmount: b.proceeds_amount,
      proceedsAccountId: b.proceeds_account_id,
      buyerContactId: b.buyer_contact_id,
      invoiceId: b.invoice_id,
      reason: b.reason,
    });
  }

  // --- reports --------------------------------------------------------------

  @Get('reports/fixed-assets')
  @Operation('getFixedAssetReport')
  async fixedAssetReport(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    // legal_entity_id is required: the register's category subtotals are what
    // gets held against that entity's GL controls, and a cross-entity mixture
    // would reconcile against nothing.
    const q = parse(
      z.object({
        legal_entity_id: uuid,
        accounting_book_id: uuid.optional(),
        asset_category_id: uuid.optional(),
        status: z.string().optional(),
      }),
      query,
    );
    return this.reports.getFixedAssetReport(tenantPrincipal(req), {
      legalEntityId: q.legal_entity_id,
      accountingBookId: q.accounting_book_id,
      assetCategoryId: q.asset_category_id,
      status: q.status,
    });
  }

  @Get('reports/asset-reconciliation')
  @Operation('getAssetReconciliation')
  async assetReconciliation(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    // accounting_book_id is required too: journal balances only mean something
    // within one book, so "the GL side" is undefined until the caller names it.
    const q = parse(
      z.object({
        legal_entity_id: uuid,
        accounting_book_id: uuid,
        from: isoDate.optional(),
        to: isoDate.optional(),
      }),
      query,
    );
    return this.reports.getAssetReconciliation(tenantPrincipal(req), {
      legalEntityId: q.legal_entity_id,
      accountingBookId: q.accounting_book_id,
      from: q.from,
      to: q.to,
    });
  }
}
