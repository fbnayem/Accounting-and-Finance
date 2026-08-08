import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { Operation } from '../common/operation';
import {
  currencyCode,
  decimalString,
  isoDate,
  name as nameField,
  parse,
  reason as reasonField,
  uuid,
} from '../common/validation';
import type { AuthenticatedRequest } from '../common/auth.guard';
import { tenantPrincipal } from '../common/request';
import { FinanceSetupService } from './finance-setup.service';

const CreateFiscalYearBody = z.object({
  legal_entity_id: uuid,
  name: nameField,
  start_date: isoDate,
  end_date: isoDate,
  period_length: z.enum(['MONTHLY', 'QUARTERLY']).optional(),
  // doc 02: "monthly standard periods and optional adjustment periods".
  adjustment_periods: z.number().int().min(0).max(4).optional(),
});

const TransitionBody = z.object({ reason: reasonField.optional() });

const CreateExchangeRateBody = z
  .object({
    rate_date: isoDate,
    from_currency: currencyCode,
    to_currency: currencyCode,
    rate_type: z.enum(['SPOT', 'AVERAGE', 'CLOSING', 'HISTORICAL']).default('SPOT'),
    // ADR-0006 §1: a rate is numeric(28,12). As a JSON number it would already be
    // a double by the time it reached this line.
    rate: decimalString,
    source: z.string().trim().min(1).max(80),
    is_manual_override: z.boolean().optional(),
    override_reason: reasonField.optional(),
  })
  .refine((b) => !b.is_manual_override || Boolean(b.override_reason), {
    message: 'a manual override requires a reason (doc 11)',
    path: ['override_reason'],
  })
  .refine((b) => b.from_currency !== b.to_currency, {
    message: 'from_currency and to_currency must differ',
    path: ['to_currency'],
  });

@Controller()
export class FinanceSetupController {
  constructor(@Inject(FinanceSetupService) private readonly finance: FinanceSetupService) {}

  @Get('currencies')
  @Operation('listCurrencies')
  async listCurrencies(@Req() request: AuthenticatedRequest) {
    return this.finance.listCurrencies(tenantPrincipal(request));
  }

  @Get('accounting-books')
  @Operation('listAccountingBooks')
  async listBooks(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(z.object({ legal_entity_id: uuid.optional() }), query);
    return this.finance.listAccountingBooks(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
    });
  }

  @Get('fiscal-years')
  @Operation('listFiscalYears')
  async listFiscalYears(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(z.object({ legal_entity_id: uuid.optional() }), query);
    return this.finance.listFiscalYears(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
    });
  }

  @Post('fiscal-years')
  @Operation('createFiscalYear')
  async createFiscalYear(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(CreateFiscalYearBody, body);
    return this.finance.createFiscalYear(tenantPrincipal(request), {
      legalEntityId: input.legal_entity_id,
      name: input.name,
      startDate: input.start_date,
      endDate: input.end_date,
      ...(input.period_length ? { periodLength: input.period_length } : {}),
      ...(input.adjustment_periods !== undefined
        ? { adjustmentPeriods: input.adjustment_periods }
        : {}),
    });
  }

  @Get('accounting-periods')
  @Operation('listAccountingPeriods')
  async listPeriods(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({ legal_entity_id: uuid.optional(), fiscal_year_id: uuid.optional() }),
      query,
    );
    return this.finance.listPeriods(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
      fiscalYearId: parsed.fiscal_year_id,
    });
  }

  @Post('accounting-periods/:id/soft-close')
  @Operation('softClosePeriod')
  async softClose(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(TransitionBody, body ?? {});
    return this.finance.transitionPeriod(
      tenantPrincipal(request),
      parse(uuid, id),
      'SOFT_CLOSED',
      input,
    );
  }

  @Post('accounting-periods/:id/hard-close')
  @Operation('hardClosePeriod')
  async hardClose(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(TransitionBody, body ?? {});
    return this.finance.transitionPeriod(
      tenantPrincipal(request),
      parse(uuid, id),
      'HARD_CLOSED',
      input,
    );
  }

  @Post('accounting-periods/:id/reopen')
  @Operation('reopenPeriod')
  async reopen(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(TransitionBody, body ?? {});
    return this.finance.transitionPeriod(tenantPrincipal(request), parse(uuid, id), 'OPEN', input);
  }

  @Get('exchange-rates')
  @Operation('listExchangeRates')
  async listRates(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({
        from_currency: currencyCode.optional(),
        to_currency: currencyCode.optional(),
        on: isoDate.optional(),
      }),
      query,
    );
    return this.finance.listExchangeRates(tenantPrincipal(request), {
      from: parsed.from_currency,
      to: parsed.to_currency,
      on: parsed.on,
    });
  }

  @Post('exchange-rates')
  @Operation('createExchangeRate')
  async createRate(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(CreateExchangeRateBody, body);
    return this.finance.createExchangeRate(tenantPrincipal(request), {
      rateDate: input.rate_date,
      fromCurrency: input.from_currency,
      toCurrency: input.to_currency,
      rateType: input.rate_type,
      rate: input.rate,
      source: input.source,
      ...(input.is_manual_override !== undefined
        ? { isManualOverride: input.is_manual_override }
        : {}),
      ...(input.override_reason !== undefined ? { overrideReason: input.override_reason } : {}),
    });
  }
}
