import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import {
  BankAccountsService,
  BankImportService,
  BankMatchingService,
  BankReconciliationService,
  TreasuryService,
} from '@acct/banking';
import { Operation } from '../common/operation';
import { decimalString, isoDate, parse, uuid } from '../common/validation';
import type { AuthenticatedRequest } from '../common/auth.guard';
import { tenantPrincipal } from '../common/request';

/**
 * doc 06's twenty-seven operations.
 *
 * One controller, because they share one subject — cash — and splitting them by
 * table would put `/cash-position` somewhere other than the accounts it sums.
 * Each handler declares only which contract operation it is; the permission,
 * the idempotency rule and the success status come from `contracts/openapi.yaml`
 * at request time.
 */

const Money = decimalString;

const ImportBody = z.object({
  format: z.enum(['API', 'CSV', 'OFX', 'QFX', 'QIF', 'MT940', 'CAMT053', 'PROCESSOR']),
  content: z.string().optional(),
  statement_ref: z.string().optional(),
  source_file_id: uuid.optional(),
  rows: z
    .array(
      z.object({
        provider_transaction_id: z.string().nullish(),
        date: isoDate,
        value_date: isoDate.nullish(),
        amount: Money,
        description: z.string().nullish(),
        counterparty: z.string().nullish(),
        reference: z.string().nullish(),
        balance: Money.nullish(),
      }),
    )
    .optional(),
});

@Controller()
export class BankingController {
  constructor(
    @Inject(BankAccountsService) private readonly accounts: BankAccountsService,
    @Inject(BankImportService) private readonly imports: BankImportService,
    @Inject(BankMatchingService) private readonly matching: BankMatchingService,
    @Inject(BankReconciliationService) private readonly reconciliations: BankReconciliationService,
    @Inject(TreasuryService) private readonly treasury: TreasuryService,
  ) {}

  // --- accounts and connections -------------------------------------------

  @Get('bank-accounts')
  @Operation('listBankAccounts')
  async listAccounts(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(z.object({ legal_entity_id: uuid.optional() }), query);
    return this.accounts.listAccounts(tenantPrincipal(req), { legalEntityId: q.legal_entity_id });
  }

  @Post('bank-accounts')
  @Operation('createBankAccount')
  async createAccount(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const b = parse(
      z.object({
        legal_entity_id: uuid,
        account_id: uuid,
        name: z.string().min(1),
        currency: z.string().length(3),
        kind: z.string().optional(),
        bank_connection_id: uuid.nullish(),
        branch_id: uuid.nullish(),
        bank_name: z.string().nullish(),
        masked_account_number: z.string().nullish(),
        iban: z.string().nullish(),
        swift_bic: z.string().nullish(),
        routing_number: z.string().nullish(),
      }),
      body,
    );
    return this.accounts.createAccount(tenantPrincipal(req), {
      legalEntityId: b.legal_entity_id,
      accountId: b.account_id,
      name: b.name,
      currency: b.currency,
      kind: b.kind,
      bankConnectionId: b.bank_connection_id,
      branchId: b.branch_id,
      bankName: b.bank_name,
      maskedAccountNumber: b.masked_account_number,
      iban: b.iban,
      swiftBic: b.swift_bic,
      routingNumber: b.routing_number,
    });
  }

  @Get('bank-connections')
  @Operation('listBankConnections')
  async listConnections(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(z.object({ legal_entity_id: uuid.optional() }), query);
    return this.accounts.listConnections(tenantPrincipal(req), {
      legalEntityId: q.legal_entity_id,
    });
  }

  @Post('bank-connections')
  @Operation('createBankConnection')
  async createConnection(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const b = parse(
      z.object({
        legal_entity_id: uuid,
        provider: z.string().min(1),
        external_id: z.string().nullish(),
        // A reference into a secret manager. There is deliberately no field here
        // that could carry a credential — doc 16, and the standing rule that no
        // connector receives database credentials.
        encrypted_config_ref: z.string().nullish(),
        consent_expires_at: z.string().nullish(),
      }),
      body,
    );
    return this.accounts.createConnection(tenantPrincipal(req), {
      legalEntityId: b.legal_entity_id,
      provider: b.provider,
      externalId: b.external_id,
      encryptedConfigRef: b.encrypted_config_ref,
      consentExpiresAt: b.consent_expires_at,
    });
  }

  // --- import and sync -----------------------------------------------------

  @Post('bank-accounts/:id/imports')
  @Operation('importBankTransactions')
  async importTransactions(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(ImportBody, body);
    return this.imports.import(tenantPrincipal(req), {
      bankAccountId: id,
      format: b.format,
      content: b.content,
      statementRef: b.statement_ref,
      sourceFileId: b.source_file_id,
      rows: b.rows?.map((r) => ({
        providerTransactionId: r.provider_transaction_id ?? null,
        date: r.date,
        valueDate: r.value_date ?? null,
        amount: r.amount,
        description: r.description ?? null,
        counterparty: r.counterparty ?? null,
        reference: r.reference ?? null,
        balance: r.balance ?? null,
      })),
    });
  }

  @Post('bank-accounts/:id/sync')
  @Operation('syncBankAccount')
  async sync(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: unknown) {
    // A live connector sync is the same ingestion path with the rows supplied by
    // the provider rather than by a file. The connector itself is a Phase 9
    // integration; what Phase 4 owns is what happens to the rows once they land.
    const b = parse(ImportBody.partial({ format: true }), body);
    return this.imports.import(tenantPrincipal(req), {
      bankAccountId: id,
      format: 'API',
      rows: b.rows?.map((r) => ({
        providerTransactionId: r.provider_transaction_id ?? null,
        date: r.date,
        valueDate: r.value_date ?? null,
        amount: r.amount,
        description: r.description ?? null,
        counterparty: r.counterparty ?? null,
        reference: r.reference ?? null,
        balance: r.balance ?? null,
      })),
    });
  }

  // --- transactions --------------------------------------------------------

  @Get('bank-transactions')
  @Operation('listBankTransactions')
  async listTransactions(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(
      z.object({
        bank_account_id: uuid.optional(),
        state: z.string().optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        limit: z.coerce.number().int().positive().optional(),
      }),
      query,
    );
    return this.imports.list(tenantPrincipal(req), {
      bankAccountId: q.bank_account_id,
      state: q.state,
      from: q.from,
      to: q.to,
      limit: q.limit,
    });
  }

  @Get('bank-transactions/:id/matches')
  @Operation('getMatchCandidates')
  async candidates(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.matching.candidates(tenantPrincipal(req), id);
  }

  @Post('bank-transactions/:id/match')
  @Operation('matchBankTransaction')
  async match(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(
      z.object({
        reconciliation_id: uuid.nullish(),
        targets: z
          .array(
            z.object({
              target_type: z.string().min(1),
              target_id: uuid,
              matched_amount: Money,
            }),
          )
          .min(1),
      }),
      body,
    );
    return this.matching.confirm(tenantPrincipal(req), id, {
      reconciliationId: b.reconciliation_id,
      targets: b.targets.map((t) => ({
        targetType: t.target_type,
        targetId: t.target_id,
        matchedAmount: t.matched_amount,
      })),
    });
  }

  @Post('bank-transactions/:id/categorize')
  @Operation('categorizeBankTransaction')
  async categorize(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(z.object({ account_id: uuid, description: z.string().optional() }), body);
    return this.matching.categorize(tenantPrincipal(req), id, {
      accountId: b.account_id,
      description: b.description,
    });
  }

  @Post('bank-transactions/:id/split')
  @Operation('splitBankTransaction')
  async split(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(
      z.object({
        parts: z.array(z.object({ amount: Money, description: z.string().optional() })).min(2),
      }),
      body,
    );
    return this.matching.split(tenantPrincipal(req), id, { parts: b.parts });
  }

  // --- rules ---------------------------------------------------------------

  @Get('bank-rules')
  @Operation('listBankRules')
  async listRules(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(z.object({ legal_entity_id: uuid.optional() }), query);
    return this.accounts.listRules(tenantPrincipal(req), { legalEntityId: q.legal_entity_id });
  }

  @Post('bank-rules')
  @Operation('createBankRule')
  async createRule(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const b = parse(
      z.object({
        legal_entity_id: uuid,
        name: z.string().min(1),
        conditions: z.record(z.unknown()),
        actions: z.record(z.unknown()),
        priority: z.number().int().optional(),
        bank_account_id: uuid.nullish(),
        auto_apply: z.boolean().optional(),
      }),
      body,
    );
    return this.accounts.createRule(tenantPrincipal(req), {
      legalEntityId: b.legal_entity_id,
      name: b.name,
      conditions: b.conditions,
      actions: b.actions,
      priority: b.priority,
      bankAccountId: b.bank_account_id,
      autoApply: b.auto_apply,
    });
  }

  @Patch('bank-rules/:id')
  @Operation('updateBankRule')
  async updateRule(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(
      z.object({
        name: z.string().optional(),
        priority: z.number().int().optional(),
        auto_apply: z.boolean().optional(),
        conditions: z.record(z.unknown()).optional(),
        actions: z.record(z.unknown()).optional(),
      }),
      body,
    );
    return this.accounts.updateRule(tenantPrincipal(req), id, {
      name: b.name,
      priority: b.priority,
      autoApply: b.auto_apply,
      conditions: b.conditions,
      actions: b.actions,
    });
  }

  @Delete('bank-rules/:id')
  @Operation('archiveBankRule')
  async archiveRule(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.accounts.archiveRule(tenantPrincipal(req), id);
  }

  // --- reconciliation ------------------------------------------------------

  @Get('bank-reconciliations')
  @Operation('listBankReconciliations')
  async listReconciliations(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(z.object({ bank_account_id: uuid.optional() }), query);
    return this.reconciliations.list(tenantPrincipal(req), { bankAccountId: q.bank_account_id });
  }

  @Post('bank-reconciliations')
  @Operation('createBankReconciliation')
  async createReconciliation(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const b = parse(
      z.object({
        bank_account_id: uuid,
        statement_start_date: isoDate,
        statement_end_date: isoDate,
        statement_opening_balance: Money,
        statement_closing_balance: Money,
      }),
      body,
    );
    return this.reconciliations.create(tenantPrincipal(req), {
      bankAccountId: b.bank_account_id,
      statementStartDate: b.statement_start_date,
      statementEndDate: b.statement_end_date,
      statementOpeningBalance: b.statement_opening_balance,
      statementClosingBalance: b.statement_closing_balance,
    });
  }

  /**
   * The working view — F-813.
   *
   * `BankReconciliationService.get` has always computed it and nothing could
   * reach it: the session's difference was observable only in the error body of
   * a completion the server refused. doc 06's reconciliation workspace is a
   * screen you *work* in, and a difference you can only see by failing is not a
   * working tool.
   */
  @Get('bank-reconciliations/:id')
  @Operation('getBankReconciliation')
  async getReconciliation(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.reconciliations.get(tenantPrincipal(req), id);
  }

  @Post('bank-reconciliations/:id/complete')
  @Operation('completeBankReconciliation')
  async completeReconciliation(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.reconciliations.complete(tenantPrincipal(req), id);
  }

  @Post('bank-reconciliations/:id/reopen')
  @Operation('reopenBankReconciliation')
  async reopenReconciliation(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(z.object({ reason: z.string().min(1) }), body);
    return this.reconciliations.reopen(tenantPrincipal(req), id, {
      reason: b.reason,
    });
  }

  // --- transfers, clearing, reports ---------------------------------------

  @Post('bank-transfers')
  @Operation('createBankTransfer')
  async createTransfer(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const b = parse(
      z.object({
        accounting_book_id: uuid,
        posting_date: isoDate,
        source_bank_account_id: uuid,
        target_bank_account_id: uuid,
        source_amount: Money,
        target_amount: Money.optional(),
        exchange_rate: decimalString.nullish(),
        fee_amount: Money.optional(),
        fee_account_id: uuid.nullish(),
        description: z.string().optional(),
      }),
      body,
    );
    return this.treasury.createTransfer(tenantPrincipal(req), {
      accountingBookId: b.accounting_book_id,
      postingDate: b.posting_date,
      sourceBankAccountId: b.source_bank_account_id,
      targetBankAccountId: b.target_bank_account_id,
      sourceAmount: b.source_amount,
      targetAmount: b.target_amount,
      exchangeRate: b.exchange_rate,
      feeAmount: b.fee_amount,
      feeAccountId: b.fee_account_id,
      description: b.description,
    });
  }

  @Get('settlement-batches')
  @Operation('listSettlementBatches')
  async listBatches(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(
      z.object({ legal_entity_id: uuid.optional(), status: z.string().optional() }),
      query,
    );
    return this.treasury.listSettlementBatches(tenantPrincipal(req), {
      legalEntityId: q.legal_entity_id,
      status: q.status,
    });
  }

  @Post('settlement-batches')
  @Operation('createSettlementBatch')
  async createBatch(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const b = parse(
      z.object({
        legal_entity_id: uuid,
        processor: z.string().min(1),
        external_batch_id: z.string().nullish(),
        settlement_date: isoDate,
        currency: z.string().length(3),
        gross_amount: Money,
        fee_amount: Money,
        adjustment_amount: Money.optional(),
        net_amount: Money,
        items: z
          .array(
            z.object({
              source_type: z.string().min(1),
              source_id: uuid,
              gross_amount: Money,
              fee_amount: Money.optional(),
            }),
          )
          .optional(),
      }),
      body,
    );
    return this.treasury.createSettlementBatch(tenantPrincipal(req), {
      legalEntityId: b.legal_entity_id,
      processor: b.processor,
      externalBatchId: b.external_batch_id,
      settlementDate: b.settlement_date,
      currency: b.currency,
      grossAmount: b.gross_amount,
      feeAmount: b.fee_amount,
      adjustmentAmount: b.adjustment_amount,
      netAmount: b.net_amount,
      items: b.items?.map((i) => ({
        sourceType: i.source_type,
        sourceId: i.source_id,
        grossAmount: i.gross_amount,
        ...(i.fee_amount === undefined ? {} : { feeAmount: i.fee_amount }),
      })),
    });
  }

  @Post('settlement-batches/:id/reconcile')
  @Operation('reconcileSettlementBatch')
  async reconcileBatch(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(
      z.object({ accounting_book_id: uuid, bank_account_id: uuid, fee_account_id: uuid }),
      body,
    );
    return this.treasury.reconcileSettlementBatch(tenantPrincipal(req), id, {
      accountingBookId: b.accounting_book_id,
      bankAccountId: b.bank_account_id,
      feeAccountId: b.fee_account_id,
    });
  }

  @Get('clearing-items')
  @Operation('listClearingItems')
  async listClearing(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(
      z.object({ legal_entity_id: uuid.optional(), status: z.string().optional() }),
      query,
    );
    return this.treasury.listClearingItems(tenantPrincipal(req), {
      legalEntityId: q.legal_entity_id,
      status: q.status,
    });
  }

  @Post('clearing-items/:id/chargeback')
  @Operation('chargebackClearingItem')
  async chargeback(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(
      z.object({ accounting_book_id: uuid, posting_date: isoDate, reason: z.string().min(1) }),
      body,
    );
    return this.treasury.chargeback(tenantPrincipal(req), id, {
      accountingBookId: b.accounting_book_id,
      postingDate: b.posting_date,
      reason: b.reason,
    });
  }

  @Get('cash-position')
  @Operation('getCashPosition')
  async cashPosition(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(
      z.object({ legal_entity_id: uuid.optional(), as_of: isoDate.optional() }),
      query,
    );
    return this.accounts.cashPosition(tenantPrincipal(req), {
      legalEntityId: q.legal_entity_id,
      asOf: q.as_of,
    });
  }

  @Get('reports/unreconciled')
  @Operation('getUnreconciledReport')
  async unreconciled(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(
      z.object({ legal_entity_id: uuid.optional(), as_of: isoDate.optional() }),
      query,
    );
    return this.reconciliations.unreconciled(tenantPrincipal(req), {
      legalEntityId: q.legal_entity_id,
      asOf: q.as_of,
    });
  }
}
