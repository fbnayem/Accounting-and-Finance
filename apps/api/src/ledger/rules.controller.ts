import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { Operation } from '../common/operation';
import { isoDate, name as nameField, parse, uuid } from '../common/validation';
import type { AuthenticatedRequest } from '../common/auth.guard';
import { tenantPrincipal } from '../common/request';
import { LedgerRulesService } from '@acct/ledger';
import { LineBody, toLine } from './line.schema';

/** UPPER_SNAKE, matching the posting rule catalog's own naming. */
const eventType = z
  .string()
  .trim()
  .max(60)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'UPPER_SNAKE_CASE, e.g. SALES_INVOICE_POSTED');

@Controller()
export class LedgerRulesController {
  constructor(@Inject(LedgerRulesService) private readonly rules: LedgerRulesService) {}

  @Get('posting-rules')
  @Operation('listPostingRuleVersions')
  async listRules(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({
        legal_entity_id: uuid.optional(),
        accounting_book_id: uuid.optional(),
        event_type: eventType.optional(),
        on: isoDate.optional(),
      }),
      query,
    );
    return this.rules.listPostingRuleVersions(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
      accountingBookId: parsed.accounting_book_id,
      eventType: parsed.event_type,
      on: parsed.on,
    });
  }

  @Post('posting-rules')
  @Operation('createPostingRuleVersion')
  async createRule(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(
      z.object({
        accounting_book_id: uuid,
        event_type: eventType,
        valid_from: z.string().trim().min(10).max(40),
        rule_definition: z.unknown(),
        framework: z.string().trim().max(20).optional(),
        supersede: z.boolean().optional(),
      }),
      body,
    );
    return this.rules.createPostingRuleVersion(tenantPrincipal(request), {
      accountingBookId: input.accounting_book_id,
      eventType: input.event_type,
      validFrom: input.valid_from,
      ruleDefinition: input.rule_definition,
      framework: input.framework,
      supersede: input.supersede,
    });
  }

  @Post('accounting-events/simulate')
  @Operation('simulatePosting')
  async simulate(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(
      z.object({
        accounting_book_id: uuid,
        event_type: eventType,
        posting_date: isoDate,
        payload: z.record(z.unknown()),
      }),
      body,
    );
    return this.rules.simulate(tenantPrincipal(request), {
      accountingBookId: input.accounting_book_id,
      eventType: input.event_type,
      postingDate: input.posting_date,
      payload: input.payload,
    });
  }

  @Get('recurring-journals')
  @Operation('listRecurringJournals')
  async listRecurring(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(z.object({ legal_entity_id: uuid.optional() }), query);
    return this.rules.listRecurringJournals(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
    });
  }

  @Post('recurring-journals')
  @Operation('createRecurringJournal')
  async createRecurring(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(
      z.object({
        accounting_book_id: uuid,
        journal_id: uuid,
        name: nameField,
        frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL']),
        start_date: isoDate,
        end_date: isoDate.optional(),
        auto_post: z.boolean().optional(),
        requires_approval: z.boolean().optional(),
        lines: z.array(LineBody).min(1).max(500),
      }),
      body,
    );
    return this.rules.createRecurringJournal(tenantPrincipal(request), {
      accountingBookId: input.accounting_book_id,
      journalId: input.journal_id,
      name: input.name,
      frequency: input.frequency,
      startDate: input.start_date,
      endDate: input.end_date,
      autoPost: input.auto_post,
      requiresApproval: input.requires_approval,
      lines: input.lines.map(toLine),
    });
  }

  @Get('opening-balances')
  @Operation('listOpeningBalanceSets')
  async listOpening(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(z.object({ legal_entity_id: uuid.optional() }), query);
    return this.rules.listOpeningBalanceSets(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
    });
  }

  @Post('opening-balances')
  @Operation('createOpeningBalanceSet')
  async createOpening(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(
      z.object({
        accounting_book_id: uuid,
        journal_id: uuid,
        as_of_date: isoDate,
        lines: z.array(LineBody).min(2).max(5000),
      }),
      body,
    );
    return this.rules.createOpeningBalanceSet(tenantPrincipal(request), {
      accountingBookId: input.accounting_book_id,
      journalId: input.journal_id,
      asOfDate: input.as_of_date,
      lines: input.lines.map(toLine),
    });
  }

  @Post('opening-balances/:id/post')
  @Operation('postOpeningBalanceSet')
  async postOpening(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.rules.postOpeningBalanceSet(tenantPrincipal(request), parse(uuid, id));
  }
}
