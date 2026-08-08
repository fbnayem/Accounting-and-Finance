import { Body, Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { Post } from '@nestjs/common';
import { z } from 'zod';
import { Operation } from '../common/operation';
import { decimalString, isoDate, parse, uuid } from '../common/validation';
import type { AuthenticatedRequest } from '../common/auth.guard';
import { tenantPrincipal } from '../common/request';
import { ConfigurationService } from './configuration.service';

const accountId = uuid.nullable().optional();

/**
 * The policy body is explicit rather than a pass-through record.
 *
 * `accounting_policies` is the table every posting rule resolves its accounts
 * through (F-203, the S1 finding), so an unvalidated blob here would put a typo'd
 * account mapping one request away from a posting rule that silently resolves to
 * nothing in Phase 2.
 */
const PolicyBody = z.object({
  legal_entity_id: uuid,
  accounting_book_id: uuid.optional(),
  valid_from: isoDate,
  ar_control_account_id: accountId,
  ap_control_account_id: accountId,
  cash_clearing_account_id: accountId,
  payment_clearing_account_id: accountId,
  retained_earnings_account_id: accountId,
  current_year_earnings_account_id: accountId,
  rounding_account_id: accountId,
  realized_fx_gain_account_id: accountId,
  realized_fx_loss_account_id: accountId,
  unrealized_fx_gain_account_id: accountId,
  unrealized_fx_loss_account_id: accountId,
  bad_debt_account_id: accountId,
  customer_advance_account_id: accountId,
  vendor_advance_account_id: accountId,
  grni_account_id: accountId,
  suspense_account_id: accountId,
  // ADR-0001 §2: the tenant chooses. Both methods are supported and the choice is
  // immutable once a year has been closed under it.
  retained_earnings_method: z.enum(['DERIVED', 'CLOSING_JOURNAL']).optional(),
  rounding_mode: z.enum(['HALF_UP', 'HALF_EVEN', 'HALF_DOWN', 'UP', 'DOWN', 'TRUNCATE']).optional(),
  // ADR-0006 §1: decimal strings on the wire. A JSON number here would be a double
  // before it ever reached the database.
  rounding_tolerance: decimalString.optional(),
  capitalization_threshold: decimalString.optional(),
  write_off_approval_threshold: decimalString.optional(),
  payment_dual_approval_threshold: decimalString.optional(),
  journal_approval_threshold: decimalString.optional(),
  three_way_match_tolerance_pct: decimalString.optional(),
  three_way_match_tolerance_abs: decimalString.optional(),
  bank_reconciliation_tolerance: decimalString.optional(),
  ar_aging_buckets: z.array(z.number().int().positive()).max(8).optional(),
  ap_aging_buckets: z.array(z.number().int().positive()).max(8).optional(),
  default_inventory_valuation: z
    .enum(['FIFO', 'WEIGHTED_AVERAGE', 'STANDARD', 'SPECIFIC'])
    .optional(),
  allow_negative_stock: z.boolean().optional(),
  closed_period_behaviour: z.enum(['REJECT', 'ALLOW_WITH_APPROVAL']).optional(),
  ai_automation_enabled: z.boolean().optional(),
});

const NumberSequenceBody = z.object({
  legal_entity_id: uuid,
  document_type: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[A-Z][A-Z0-9_]*$/, 'upper snake case, e.g. SALES_INVOICE'),
  branch_id: uuid.optional(),
  fiscal_year_id: uuid.optional(),
  // doc 02: "Configurable pattern: prefix, year/month tokens, branch, counter,
  // padding, reset cycle." {YYYY}, {YY}, {MM} and {DD} expand at allocation.
  prefix: z.string().max(40).optional(),
  suffix: z.string().max(40).optional(),
  padding: z.number().int().min(0).max(20).optional(),
  next_number: z.number().int().positive().optional(),
  reset_rule: z.enum(['NEVER', 'ANNUAL', 'MONTHLY']).optional(),
});

@Controller()
export class ConfigurationController {
  constructor(@Inject(ConfigurationService) private readonly configuration: ConfigurationService) {}

  @Get('accounting-policies')
  @Operation('listAccountingPolicies')
  async listPolicies(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(z.object({ legal_entity_id: uuid.optional() }), query);
    return this.configuration.listAccountingPolicies(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
    });
  }

  @Post('accounting-policies')
  @Operation('createAccountingPolicyVersion')
  async createPolicyVersion(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(PolicyBody, body);
    const { legal_entity_id, accounting_book_id, valid_from, ...policy } = input;
    return this.configuration.createPolicyVersion(tenantPrincipal(request), {
      legalEntityId: legal_entity_id,
      accountingBookId: accounting_book_id,
      validFrom: valid_from,
      policy,
    });
  }

  @Get('number-sequences')
  @Operation('listNumberSequences')
  async listSequences(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(z.object({ legal_entity_id: uuid.optional() }), query);
    return this.configuration.listNumberSequences(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
    });
  }

  @Post('number-sequences')
  @Operation('createNumberSequence')
  async createSequence(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(NumberSequenceBody, body);
    return this.configuration.createNumberSequence(tenantPrincipal(request), {
      legalEntityId: input.legal_entity_id,
      documentType: input.document_type,
      branchId: input.branch_id,
      fiscalYearId: input.fiscal_year_id,
      prefix: input.prefix,
      suffix: input.suffix,
      padding: input.padding,
      nextNumber: input.next_number,
      resetRule: input.reset_rule,
    });
  }
}
