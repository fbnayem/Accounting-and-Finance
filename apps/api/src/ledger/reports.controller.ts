import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { Operation } from '../common/operation';
import { isoDate, parse, uuid } from '../common/validation';
import type { AuthenticatedRequest } from '../common/auth.guard';
import { tenantPrincipal } from '../common/request';
import { LedgerReportsService } from '@acct/ledger';

@Controller()
export class LedgerReportsController {
  constructor(@Inject(LedgerReportsService) private readonly reports: LedgerReportsService) {}

  @Get('reports/trial-balance')
  @Operation('getTrialBalance')
  async trialBalance(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({
        book_id: uuid,
        period_from: isoDate.optional(),
        period_to: isoDate.optional(),
        // doc 03's acceptance criterion, as a parameter: "Rebuilding trial balance
        // from raw journal lines equals cached balance model."
        source: z.enum(['projection', 'journal_lines']).optional(),
        include_zero: z.coerce.boolean().optional(),
      }),
      query,
    );
    return this.reports.trialBalance(tenantPrincipal(request), {
      accountingBookId: parsed.book_id,
      periodFrom: parsed.period_from,
      periodTo: parsed.period_to,
      source: parsed.source,
      includeZero: parsed.include_zero,
    });
  }

  @Get('reports/general-ledger')
  @Operation('getGeneralLedger')
  async generalLedger(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({
        book_id: uuid,
        account_id: uuid.optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        limit: z.coerce.number().int().min(1).max(5000).optional(),
      }),
      query,
    );
    return this.reports.generalLedger(tenantPrincipal(request), {
      accountingBookId: parsed.book_id,
      accountId: parsed.account_id,
      from: parsed.from,
      to: parsed.to,
      limit: parsed.limit,
    });
  }

  @Get('reports/journal-register')
  @Operation('getJournalRegister')
  async journalRegister(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({
        book_id: uuid,
        journal_id: uuid.optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        limit: z.coerce.number().int().min(1).max(2000).optional(),
      }),
      query,
    );
    return this.reports.journalRegister(tenantPrincipal(request), {
      accountingBookId: parsed.book_id,
      journalId: parsed.journal_id,
      from: parsed.from,
      to: parsed.to,
      limit: parsed.limit,
    });
  }

  @Get('ledger/accounts/:id/activity')
  @Operation('getAccountActivity')
  async accountActivity(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Query() query: unknown,
  ) {
    const parsed = parse(
      z.object({ period_from: isoDate.optional(), period_to: isoDate.optional() }),
      query,
    );
    return this.reports.accountActivity(tenantPrincipal(request), parse(uuid, id), {
      periodFrom: parsed.period_from,
      periodTo: parsed.period_to,
    });
  }

  @Post('ledger/projections/rebuild')
  @Operation('rebuildLedgerProjections')
  async rebuild(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(z.object({ accounting_book_id: uuid }), body);
    return this.reports.rebuildProjections(tenantPrincipal(request), input.accounting_book_id);
  }
}
