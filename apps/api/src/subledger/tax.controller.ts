import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { LocalizationService, TaxReturnService, TaxService } from '@acct/subledger';
import { Operation } from '../common/operation';
import {
  code as codeField,
  decimalString,
  isoDate,
  name as nameField,
  parse,
  uuid,
} from '../common/validation';
import type { AuthenticatedRequest } from '../common/auth.guard';
import { tenantPrincipal } from '../common/request';

/**
 * doc 07 — tax codes, rates, periods, returns and the determination endpoint.
 *
 * `POST /tax/calculate` is the one route here that changes nothing and still
 * takes a body: it answers "what would this document be taxed" from the same
 * engine that will tax it. A preview computed by different code than the posting
 * would be a preview of something else.
 */

// The `tax_type` and `tax_treatment` enums, verbatim. Spelled out rather than
// passed through as text so a value the database will reject fails as a field
// error naming the choices, not as a 500 from a cast.
const TAX_KIND = z.enum([
  'VAT',
  'GST',
  'SALES_TAX',
  'WITHHOLDING',
  'EXCISE',
  'SUPPLEMENTARY',
  'OTHER',
]);
const TREATMENT = z.enum(['STANDARD', 'ZERO_RATED', 'EXEMPT', 'OUTSIDE_SCOPE', 'REVERSE_CHARGE']);

const CalculateBody = z.object({
  legal_entity_id: uuid,
  currency: z.string().trim().toUpperCase().length(3),
  document_date: isoDate,
  transaction_type: z.string().trim().max(40).optional(),
  lines: z
    .array(
      z.object({
        line_no: z.number().int().min(1).max(9999),
        description: z.string().trim().max(500).optional(),
        quantity: decimalString,
        unit_price: decimalString,
        discount_amount: decimalString.optional(),
        tax_code_id: uuid.optional(),
        inclusive: z.boolean().optional(),
        // doc 07's determination inputs: counterparty country, registration
        // status, item category. Free-form because a jurisdiction pack defines
        // which facts its rules read, and the engine matches on them by name.
        facts: z.record(z.unknown()).optional(),
      }),
    )
    .min(1)
    .max(500),
});

const TaxCodeBody = z.object({
  legal_entity_id: uuid,
  code: codeField,
  name: nameField,
  kind: TAX_KIND,
  treatment: TREATMENT.optional(),
  is_inclusive_default: z.boolean().optional(),
  payable_account_id: uuid.optional(),
  receivable_account_id: uuid.optional(),
  nonrecoverable_account_id: uuid.optional(),
  components: z
    .array(
      z.object({
        code: codeField,
        name: nameField,
        sequence: z.number().int().min(1).max(99).optional(),
        compound_on_previous: z.boolean().optional(),
        rounding_mode: z
          .enum(['HALF_UP', 'HALF_EVEN', 'HALF_DOWN', 'UP', 'DOWN', 'TRUNCATE'])
          .optional(),
      }),
    )
    .max(10)
    .optional(),
});

const TaxRateBody = z.object({
  tax_component_id: uuid,
  // A rate, not money: "0.20" is 20%. A percentage as a JSON number is how a
  // 7.25% rate becomes 7.249999999999999 in a filed return.
  rate: decimalString,
  recoverable_percent: decimalString.optional(),
  valid_from: isoDate,
  valid_to: isoDate.optional(),
});

@Controller()
export class TaxController {
  constructor(
    @Inject(TaxService) private readonly tax: TaxService,
    @Inject(TaxReturnService) private readonly returns: TaxReturnService,
    @Inject(LocalizationService) private readonly localization: LocalizationService,
  ) {}

  // -------------------------------------------------------------------------
  // Determination
  // -------------------------------------------------------------------------

  @Post('tax/calculate')
  @Operation('calculateTax')
  async calculate(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(CalculateBody, body);
    return this.tax.calculate(tenantPrincipal(request), {
      legalEntityId: input.legal_entity_id,
      currency: input.currency,
      documentDate: input.document_date,
      transactionType: input.transaction_type,
      lines: input.lines.map((l) => ({
        lineNo: l.line_no,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unit_price,
        discountAmount: l.discount_amount,
        taxCodeId: l.tax_code_id,
        inclusive: l.inclusive,
        facts: l.facts,
      })),
    });
  }

  // -------------------------------------------------------------------------
  // Codes and rates
  // -------------------------------------------------------------------------

  @Get('tax-codes')
  @Operation('listTaxCodes')
  async listCodes(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(z.object({ legal_entity_id: uuid.optional() }), query);
    return this.tax.listTaxCodes(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
    });
  }

  @Post('tax-codes')
  @Operation('createTaxCode')
  async createCode(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(TaxCodeBody, body);
    return this.tax.createTaxCode(tenantPrincipal(request), {
      legalEntityId: input.legal_entity_id,
      code: input.code,
      name: input.name,
      kind: input.kind,
      treatment: input.treatment,
      isInclusiveDefault: input.is_inclusive_default,
      payableAccountId: input.payable_account_id,
      receivableAccountId: input.receivable_account_id,
      nonrecoverableAccountId: input.nonrecoverable_account_id,
      components: input.components?.map((c) => ({
        code: c.code,
        name: c.name,
        sequence: c.sequence,
        compoundOnPrevious: c.compound_on_previous,
        roundingMode: c.rounding_mode,
      })),
    });
  }

  @Get('tax-rates')
  @Operation('listTaxRates')
  async listRates(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(z.object({ tax_code_id: uuid.optional() }), query);
    return this.tax.listTaxRates(tenantPrincipal(request), { taxCodeId: parsed.tax_code_id });
  }

  @Post('tax-rates')
  @Operation('createTaxRate')
  async createRate(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(TaxRateBody, body);
    return this.tax.createTaxRate(tenantPrincipal(request), {
      taxComponentId: input.tax_component_id,
      rate: input.rate,
      recoverablePercent: input.recoverable_percent,
      validFrom: input.valid_from,
      validTo: input.valid_to,
    });
  }

  @Get('tax-transactions')
  @Operation('listTaxTransactions')
  async listTransactions(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({
        legal_entity_id: uuid.optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        direction: z.enum(['OUTPUT', 'INPUT', 'WITHHOLDING']).optional(),
      }),
      query,
    );
    return this.tax.listTransactions(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
      from: parsed.from,
      to: parsed.to,
      direction: parsed.direction,
    });
  }

  // -------------------------------------------------------------------------
  // Periods
  // -------------------------------------------------------------------------

  @Get('tax-periods')
  @Operation('listTaxPeriods')
  async listPeriods(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(z.object({ legal_entity_id: uuid.optional() }), query);
    return this.tax.listPeriods(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
    });
  }

  @Post('tax-periods')
  @Operation('createTaxPeriod')
  async createPeriod(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(
      z.object({
        legal_entity_id: uuid,
        // Not a country code: a jurisdiction can be sub-national, and doc 07's
        // period key is (entity, jurisdiction, range).
        jurisdiction: z.string().trim().min(2).max(20),
        name: nameField,
        start_date: isoDate,
        end_date: isoDate,
      }),
      body,
    );
    return this.tax.createPeriod(tenantPrincipal(request), {
      legalEntityId: input.legal_entity_id,
      jurisdiction: input.jurisdiction,
      name: input.name,
      startDate: input.start_date,
      endDate: input.end_date,
    });
  }

  @Post('tax-periods/:id/close')
  @Operation('closeTaxPeriod')
  async closePeriod(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.tax.closePeriod(tenantPrincipal(request), parse(uuid, id));
  }

  // -------------------------------------------------------------------------
  // Returns
  // -------------------------------------------------------------------------

  @Get('tax-returns')
  @Operation('listTaxReturns')
  async listReturns(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({
        legal_entity_id: uuid.optional(),
        tax_period_id: uuid.optional(),
        status: z.enum(['OPEN', 'PREPARING', 'READY', 'FILED', 'AMENDED', 'CLOSED']).optional(),
      }),
      query,
    );
    return this.returns.listTaxReturns(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
      taxPeriodId: parsed.tax_period_id,
      status: parsed.status,
    });
  }

  @Post('tax-returns')
  @Operation('createTaxReturn')
  async createReturn(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(
      z.object({
        tax_period_id: uuid,
        form_code: codeField,
        amends_return_id: uuid.optional(),
      }),
      body,
    );
    return this.returns.createTaxReturn(tenantPrincipal(request), {
      taxPeriodId: input.tax_period_id,
      formCode: input.form_code,
      amendsReturnId: input.amends_return_id,
    });
  }

  @Post('tax-returns/:id/prepare')
  @Operation('prepareTaxReturn')
  async prepareReturn(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.returns.prepareTaxReturn(tenantPrincipal(request), parse(uuid, id));
  }

  @Post('tax-returns/:id/approve')
  @Operation('approveTaxReturn')
  async approveReturn(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.returns.approveTaxReturn(tenantPrincipal(request), parse(uuid, id));
  }

  @Post('tax-returns/:id/mark-filed')
  @Operation('markTaxReturnFiled')
  async markFiled(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(
      z.object({
        // Required: a filed return with no authority reference cannot be traced
        // back to the filing, and `tax_returns_filed_has_evidence` refuses it at
        // the database anyway.
        filing_reference: z.string().trim().min(1).max(120),
        filing_evidence_file_id: uuid.optional(),
      }),
      body,
    );
    return this.returns.markTaxReturnFiled(tenantPrincipal(request), parse(uuid, id), {
      filingReference: input.filing_reference,
      filingEvidenceFileId: input.filing_evidence_file_id,
    });
  }

  // -------------------------------------------------------------------------
  // Localization
  // -------------------------------------------------------------------------

  @Get('localizations')
  @Operation('listLocalizations')
  async listLocalizations(@Req() request: AuthenticatedRequest) {
    return this.localization.listLocalizations(tenantPrincipal(request));
  }

  @Post('legal-entities/:id/localization/install')
  @Operation('installLocalization')
  async install(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(
      z.object({
        package_code: codeField,
        // doc 07 and doc 20: a historical transaction retains the rule version in
        // force when it was posted, so the version installed is recorded rather
        // than resolved to "latest" at read time.
        version: z.string().trim().min(1).max(40),
      }),
      body,
    );
    return this.localization.installLocalization(tenantPrincipal(request), parse(uuid, id), {
      packageCode: input.package_code,
      version: input.version,
    });
  }
}
