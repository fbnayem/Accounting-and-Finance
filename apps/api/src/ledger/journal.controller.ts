import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import { Operation } from '../common/operation';
import {
  code as codeField,
  isoDate,
  name as nameField,
  parse,
  reason as reasonField,
  uuid,
} from '../common/validation';
import type { AuthenticatedRequest } from '../common/auth.guard';
import { tenantPrincipal } from '../common/request';
import { JournalService } from '@acct/ledger';
import { LineBody, toLine } from './line.schema';

const JOURNAL_TYPES = z.enum([
  'GENERAL',
  'SALES',
  'PURCHASE',
  'BANK',
  'CASH',
  'INVENTORY',
  'ASSET',
  'TAX',
  'PAYROLL',
  'CONSOLIDATION',
  'OPENING',
]);

const CreateDraftBody = z.object({
  accounting_book_id: uuid,
  journal_id: uuid,
  posting_date: isoDate,
  document_date: isoDate.optional(),
  accounting_period_id: uuid.optional(),
  description: z.string().trim().max(500).optional(),
  branch_id: uuid.optional(),
  source_type: z.string().trim().max(40).optional(),
  source_id: uuid.optional(),
  source_event_id: uuid.optional(),
  lines: z.array(LineBody).min(1).max(1000),
});

const UpdateDraftBody = z.object({
  posting_date: isoDate.optional(),
  document_date: isoDate.optional(),
  accounting_period_id: uuid.optional(),
  description: z.string().trim().max(500).optional(),
  lines: z.array(LineBody).min(1).max(1000).optional(),
});

@Controller()
export class JournalController {
  constructor(@Inject(JournalService) private readonly journals: JournalService) {}

  // ---- journal definitions (F-608) ----------------------------------------

  @Get('journal-definitions')
  @Operation('listJournalDefinitions')
  async listDefinitions(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({ legal_entity_id: uuid.optional(), accounting_book_id: uuid.optional() }),
      query,
    );
    return this.journals.listJournalDefinitions(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
      accountingBookId: parsed.accounting_book_id,
    });
  }

  @Post('journal-definitions')
  @Operation('createJournalDefinition')
  async createDefinition(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(
      z.object({
        accounting_book_id: uuid,
        code: codeField,
        name: nameField,
        journal_type: JOURNAL_TYPES,
      }),
      body,
    );
    return this.journals.createJournalDefinition(tenantPrincipal(request), {
      accountingBookId: input.accounting_book_id,
      code: input.code,
      name: input.name,
      journalType: input.journal_type,
    });
  }

  // ---- journal entries ----------------------------------------------------

  @Get('journals')
  @Operation('listJournalEntries')
  async list(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({
        legal_entity_id: uuid.optional(),
        accounting_book_id: uuid.optional(),
        accounting_period_id: uuid.optional(),
        status: z.enum(['DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED', 'REVERSED']).optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      }),
      query,
    );
    return this.journals.listJournalEntries(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
      accountingBookId: parsed.accounting_book_id,
      accountingPeriodId: parsed.accounting_period_id,
      status: parsed.status,
      from: parsed.from,
      to: parsed.to,
      limit: parsed.limit,
    });
  }

  @Post('journals')
  @Operation('createJournalDraft')
  async createDraft(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(CreateDraftBody, body);
    return this.journals.createDraft(tenantPrincipal(request), {
      accountingBookId: input.accounting_book_id,
      journalId: input.journal_id,
      postingDate: input.posting_date,
      documentDate: input.document_date,
      accountingPeriodId: input.accounting_period_id,
      description: input.description,
      branchId: input.branch_id,
      sourceType: input.source_type,
      sourceId: input.source_id,
      sourceEventId: input.source_event_id,
      lines: input.lines.map(toLine),
    });
  }

  @Get('journals/:id')
  @Operation('getJournalEntry')
  async get(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.journals.getJournalEntry(tenantPrincipal(request), parse(uuid, id));
  }

  @Patch('journals/:id')
  @Operation('updateJournalDraft')
  async update(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string,
    @Body() body: unknown,
  ) {
    const input = parse(UpdateDraftBody, body);
    return this.journals.updateDraft(tenantPrincipal(request), parse(uuid, id), ifMatch ?? '', {
      postingDate: input.posting_date,
      documentDate: input.document_date,
      accountingPeriodId: input.accounting_period_id,
      description: input.description,
      lines: input.lines?.map(toLine),
    });
  }

  @Delete('journals/:id')
  @Operation('discardJournalDraft')
  async discard(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.journals.discardDraft(tenantPrincipal(request), parse(uuid, id));
  }

  @Post('journals/:id/submit')
  @Operation('submitJournal')
  async submit(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.journals.submit(tenantPrincipal(request), parse(uuid, id));
  }

  @Post('journals/:id/approve')
  @Operation('approveJournal')
  async approve(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.journals.approve(tenantPrincipal(request), parse(uuid, id));
  }

  @Post('journals/:id/post')
  @Operation('postJournal')
  async post(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(z.object({ accounting_period_id: uuid.optional() }), body ?? {});
    return this.journals.post(tenantPrincipal(request), parse(uuid, id), {
      accountingPeriodId: input.accounting_period_id,
    });
  }

  @Post('journals/:id/reverse')
  @Operation('reverseJournal')
  async reverse(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(
      z.object({ reason: reasonField, posting_date: isoDate.optional() }),
      body ?? {},
    );
    return this.journals.reverse(tenantPrincipal(request), parse(uuid, id), {
      reason: input.reason,
      postingDate: input.posting_date,
    });
  }

  // ---- scheduled reversals (F-612) ----------------------------------------

  @Post('journals/:id/schedule-reversal')
  @Operation('scheduleJournalReversal')
  async schedule(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(z.object({ scheduled_date: isoDate, reason: reasonField }), body);
    return this.journals.scheduleReversal(tenantPrincipal(request), parse(uuid, id), {
      scheduledDate: input.scheduled_date,
      reason: input.reason,
    });
  }

  @Get('scheduled-reversals')
  @Operation('listScheduledReversals')
  async listSchedules(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({
        legal_entity_id: uuid.optional(),
        status: z.enum(['PENDING', 'EXECUTED', 'CANCELLED', 'FAILED']).optional(),
      }),
      query,
    );
    return this.journals.listScheduledReversals(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
      status: parsed.status,
    });
  }

  @Post('scheduled-reversals/:id/cancel')
  @Operation('cancelScheduledReversal')
  async cancelSchedule(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(z.object({ reason: reasonField }), body);
    return this.journals.cancelScheduledReversal(tenantPrincipal(request), parse(uuid, id), {
      reason: input.reason,
    });
  }
}
