import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import {
  AccountReconciliationService,
  CloseChecklistService,
  CloseRunService,
  FinancialSnapshotService,
  PeriodEndEntryService,
  RECONCILING_ITEM_TYPES,
  ReconcilingItemService,
} from '@acct/close';
import { Operation } from '../common/operation';
import {
  decimalString,
  isoDate,
  pageQuery,
  parse,
  reason as reasonText,
  uuid,
} from '../common/validation';
import type { AuthenticatedRequest } from '../common/auth.guard';
import { tenantPrincipal } from '../common/request';

/**
 * The close-management routes of doc 12 — the close run, its checklist, the
 * account reconciliations that close depends on, and the statement snapshot that
 * comes out of it.
 *
 * One controller because they are one subject: a close run is not complete until
 * its tasks and its reconciliations are, and a statement snapshot is what a
 * completed close issues. Splitting them by table would put the dashboard's
 * readiness in one place and the two things it is derived from in two others.
 *
 * As everywhere else, a handler declares only WHICH contract operation it is. The
 * permission (`close.finalize` is not `close.manage`), whether an Idempotency-Key
 * is required, and the success status all come from `contracts/openapi.yaml` at
 * request time, so a route here cannot claim a permission the contract did not
 * give it.
 *
 * Nothing in this file decides anything. Every rule — what "complete" means, that a
 * certifier is a different person from the preparer, that a reopen has been
 * approved by a third party — lives in `@acct/close`, because the period gate in
 * finance-setup and the close worker read the same rules and a second copy here is
 * how a dashboard and a gate come to disagree.
 */

/**
 * `z.coerce.boolean()` is wrong for a query string and is used elsewhere in this
 * app: `Boolean('false')` is `true`, so `?include_payload=false` would return every
 * statement payload in the tenant. Parsed explicitly instead, and an unrecognised
 * value is a validation error rather than a silent `true`.
 */
const boolQuery = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

/** doc 02 wants a note on the acts an auditor will later ask about. Never mandatory here. */
const note = z.string().trim().min(1).max(1000);

const CLOSE_RUN_STATUS = ['OPEN', 'IN_PROGRESS', 'READY', 'COMPLETED', 'REOPENED'] as const;
const RECON_STATUS = ['DRAFT', 'PREPARED', 'CERTIFIED', 'APPROVED', 'REOPENED'] as const;
/**
 * `fs_snapshot_type_known` (0053) is the authority; this is the same list so the
 * caller gets a field error naming the five, rather than a check violation. A type
 * added to the constraint and not here fails closed and visibly — which is the
 * right direction for a list that decides what a statement claims to be.
 */
const SNAPSHOT_TYPE = [
  'PROFIT_LOSS',
  'BALANCE_SHEET',
  'CASH_FLOW',
  'TRIAL_BALANCE',
  'CUSTOM',
] as const;

@Controller()
export class CloseController {
  constructor(
    @Inject(CloseRunService) private readonly runs: CloseRunService,
    @Inject(CloseChecklistService) private readonly checklists: CloseChecklistService,
    @Inject(AccountReconciliationService)
    private readonly reconciliations: AccountReconciliationService,
    @Inject(ReconcilingItemService) private readonly reconcilingItems: ReconcilingItemService,
    @Inject(PeriodEndEntryService) private readonly periodEndEntries: PeriodEndEntryService,
    @Inject(FinancialSnapshotService) private readonly snapshots: FinancialSnapshotService,
  ) {}

  // --- close runs ----------------------------------------------------------

  /**
   * The close dashboard — GET /close-runs.
   *
   * `status` is checked against the `close_run_status` enum here rather than being
   * passed through to a `::close_run_status` cast: an unknown value is the caller's
   * typo and deserves a field error, not a database error mapped to something else.
   */
  @Get('close-runs')
  @Operation('listCloseRuns')
  async listRuns(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(
      z.object({
        legal_entity_id: uuid.optional(),
        accounting_period_id: uuid.optional(),
        accounting_book_id: uuid.optional(),
        status: z.enum(CLOSE_RUN_STATUS).optional(),
      }),
      query,
    );
    return this.runs.list(tenantPrincipal(req), {
      legalEntityId: q.legal_entity_id,
      accountingPeriodId: q.accounting_period_id,
      accountingBookId: q.accounting_book_id,
      status: q.status,
    });
  }

  @Post('close-runs')
  @Operation('createCloseRun')
  async createRun(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const b = parse(
      z.object({
        legal_entity_id: uuid,
        accounting_book_id: uuid,
        accounting_period_id: uuid,
        template_id: uuid.nullish(),
      }),
      body,
    );
    return this.runs.create(tenantPrincipal(req), {
      legalEntityId: b.legal_entity_id,
      accountingBookId: b.accounting_book_id,
      accountingPeriodId: b.accounting_period_id,
      templateId: b.template_id ?? undefined,
    });
  }

  @Get('close-runs/:id/tasks')
  @Operation('listCloseTasks')
  async listTasks(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.checklists.listTasks(tenantPrincipal(req), id);
  }

  /**
   * The gate — POST /close-runs/{id}/finalize.
   *
   * Three Phase 6 exit criteria rest on this refusal, so the one thing this handler
   * must not do is stand between `assertReadyToFinalize` and the caller. There is no
   * try/catch here on purpose: `AppError.details` is log-only and `toResponse()`
   * emits only {code, message, correlation_id, field_errors}, so the MESSAGE the
   * service composed — "3 of 7 required items ... Outstanding: task BANK_REC
   * (OPEN); reconciliation 1200 (PREPARED — prepared and certified by the same
   * person)" — is the entire refusal as far as a caller is concerned. Catching it to
   * add context, or re-throwing it as a generic 422, would delete the only part of
   * the control anybody outside the log can act on.
   *
   * `note` is optional and goes to the audit row as the reason. It is not a waiver:
   * nothing a caller can put in the body relaxes the check.
   */
  @Post('close-runs/:id/finalize')
  @Operation('finalizeCloseRun')
  async finalizeRun(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(z.object({ note: note.optional() }), body ?? {});
    return this.runs.finalize(tenantPrincipal(req), id, { note: b.note });
  }

  /**
   * POST /close-runs/{id}/reopen — 201, because a reopen opens the next version of
   * the close rather than editing the completed one (F-038).
   *
   * The reason is required by the contract's description, by
   * `close_runs_reopen_has_reason` in the database and by the service; it is
   * validated here as well so the caller gets a field error rather than a
   * constraint violation.
   */
  @Post('close-runs/:id/reopen')
  @Operation('reopenCloseRun')
  async reopenRun(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(z.object({ reason: reasonText }), body);
    return this.runs.reopen(tenantPrincipal(req), id, { reason: b.reason });
  }

  // --- checklist -----------------------------------------------------------

  @Post('close-checklists/generate')
  @Operation('generateCloseChecklist')
  async generateChecklist(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const b = parse(z.object({ close_run_id: uuid, template_id: uuid.nullish() }), body);
    return this.checklists.generate(tenantPrincipal(req), {
      closeRunId: b.close_run_id,
      templateId: b.template_id ?? undefined,
    });
  }

  /**
   * POST /close-tasks/{id}/complete.
   *
   * `evidence` is free-form JSON on purpose — a task's evidence is a link to a bank
   * statement, a reconciliation id, a file id — and it is passed through untouched.
   * Nothing here reads a number out of it: a monetary value that arrived as a JSON
   * number would already have lost precision, and coercing one here would hide that
   * (ADR-0006 §1).
   */
  @Post('close-tasks/:id/complete')
  @Operation('completeCloseTask')
  async completeTask(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(
      z.object({
        evidence: z.array(z.record(z.unknown())).max(100).optional(),
        note: note.optional(),
      }),
      body ?? {},
    );
    return this.checklists.completeTask(tenantPrincipal(req), id, {
      evidence: b.evidence,
      note: b.note,
    });
  }

  // --- account reconciliations ---------------------------------------------

  @Get('account-reconciliations')
  @Operation('listAccountReconciliations')
  async listReconciliations(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(
      z.object({
        legal_entity_id: uuid.optional(),
        accounting_book_id: uuid.optional(),
        accounting_period_id: uuid.optional(),
        close_run_id: uuid.optional(),
        status: z.enum(RECON_STATUS).optional(),
      }),
      query,
    );
    return this.reconciliations.list(tenantPrincipal(req), {
      legalEntityId: q.legal_entity_id,
      accountingBookId: q.accounting_book_id,
      accountingPeriodId: q.accounting_period_id,
      closeRunId: q.close_run_id,
      status: q.status,
    });
  }

  /**
   * POST /account-reconciliations.
   *
   * `supporting_balance` is the only number the caller supplies, and it is a decimal
   * string (ADR-0006 §1). The GL side is never accepted from the body — the service
   * sums it from journal lines — because a reconciliation whose both sides came from
   * the caller proves only that the caller can type.
   */
  @Post('account-reconciliations')
  @Operation('createAccountReconciliation')
  async createReconciliation(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const b = parse(
      z.object({
        legal_entity_id: uuid,
        accounting_book_id: uuid,
        accounting_period_id: uuid,
        account_id: uuid,
        supporting_balance: decimalString,
        close_run_id: uuid.nullish(),
      }),
      body,
    );
    return this.reconciliations.create(tenantPrincipal(req), {
      legalEntityId: b.legal_entity_id,
      accountingBookId: b.accounting_book_id,
      accountingPeriodId: b.accounting_period_id,
      accountId: b.account_id,
      supportingBalance: b.supporting_balance,
      closeRunId: b.close_run_id ?? undefined,
    });
  }

  @Post('account-reconciliations/:id/certify')
  @Operation('certifyAccountReconciliation')
  async certifyReconciliation(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(z.object({ note: note.optional() }), body ?? {});
    return this.reconciliations.certify(tenantPrincipal(req), id, { note: b.note });
  }

  /**
   * POST /account-reconciliations/{id}/reopen — doc 12's "immutable unless
   * formally reopened with reason". reconciliation.reopen is high-risk, so the
   * guard demands re-authentication before this handler runs; the reason is
   * validated here as well so the caller gets a field error rather than the
   * service's refusal for the trivially missing case.
   */
  @Post('account-reconciliations/:id/reopen')
  @Operation('reopenAccountReconciliation')
  async reopenReconciliation(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(z.object({ reason: reasonText }), body);
    return this.reconciliations.reopen(tenantPrincipal(req), id, { reason: b.reason });
  }

  // --- reconciling items -----------------------------------------------------

  /**
   * POST /account-reconciliations/{id}/reconciling-items — the write half of
   * Gate D's artifact. `amount` is a signed decimal string (the items sum to the
   * difference, which can be negative); everything else is evidence about it.
   * A certified parent is refused by the service — the refusal names the reopen
   * route, and `AppError.details` being log-only means the message carries it.
   */
  @Post('account-reconciliations/:id/reconciling-items')
  @Operation('createReconcilingItem')
  async createReconcilingItem(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(
      z.object({
        item_type: z.enum(RECONCILING_ITEM_TYPES),
        description: z.string().trim().min(1).max(1000),
        amount: decimalString,
        expected_clear_date: isoDate.nullish(),
        source_type: z.string().trim().min(1).max(60).nullish(),
        source_id: uuid.nullish(),
        evidence_file_id: uuid.nullish(),
      }),
      body,
    );
    return this.reconcilingItems.create(tenantPrincipal(req), id, {
      itemType: b.item_type,
      description: b.description,
      amount: b.amount,
      expectedClearDate: b.expected_clear_date ?? undefined,
      sourceType: b.source_type ?? undefined,
      sourceId: b.source_id ?? undefined,
      evidenceFileId: b.evidence_file_id ?? undefined,
    });
  }

  @Get('account-reconciliations/:id/reconciling-items')
  @Operation('listReconcilingItems')
  async listReconcilingItems(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Query() query: unknown,
  ) {
    const q = parse(pageQuery, query);
    return this.reconcilingItems.list(tenantPrincipal(req), id, {
      cursor: q.cursor,
      limit: q.limit,
    });
  }

  @Post('reconciling-items/:id/resolve')
  @Operation('resolveReconcilingItem')
  async resolveReconcilingItem(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(z.object({ note: note.optional() }), body ?? {});
    return this.reconcilingItems.resolve(tenantPrincipal(req), id, { note: b.note });
  }

  // --- period-end entries ----------------------------------------------------

  /**
   * POST /period-end-entries — F-1004, doc 21 Phase 6's "accrual/prepaid/
   * deferred entries". `total_amount` is a decimal string (ADR-0006 §1). Which
   * fields the shape requires — reversal_date for an ACCRUAL, the recognition
   * schedule for the other two — is the service's decision, because it is an
   * accounting rule rather than a request-shape rule and the period gate reads
   * the same service.
   */
  @Post('period-end-entries')
  @Operation('createPeriodEndEntry')
  async createPeriodEndEntry(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const b = parse(
      z.object({
        accounting_book_id: uuid,
        posting_date: isoDate,
        entry_type: z.enum(['ACCRUAL', 'PREPAID', 'DEFERRAL']),
        description: z.string().trim().min(1).max(500),
        total_amount: decimalString,
        balance_account_id: uuid,
        pl_account_id: uuid,
        settlement_account_id: uuid.nullish(),
        reversal_date: isoDate.nullish(),
        recognition_start_date: isoDate.nullish(),
        recognition_periods: z.number().int().min(1).max(120).nullish(),
      }),
      body,
    );
    return this.periodEndEntries.create(tenantPrincipal(req), {
      accountingBookId: b.accounting_book_id,
      postingDate: b.posting_date,
      entryType: b.entry_type,
      description: b.description,
      totalAmount: b.total_amount,
      balanceAccountId: b.balance_account_id,
      plAccountId: b.pl_account_id,
      settlementAccountId: b.settlement_account_id ?? undefined,
      reversalDate: b.reversal_date ?? undefined,
      recognitionStartDate: b.recognition_start_date ?? undefined,
      recognitionPeriods: b.recognition_periods ?? undefined,
    });
  }

  @Get('period-end-entries')
  @Operation('listPeriodEndEntries')
  async listPeriodEndEntries(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(
      pageQuery.extend({
        accounting_book_id: uuid.optional(),
        period_from: isoDate.optional(),
        period_to: isoDate.optional(),
      }),
      query,
    );
    return this.periodEndEntries.list(tenantPrincipal(req), {
      accountingBookId: q.accounting_book_id,
      periodFrom: q.period_from,
      periodTo: q.period_to,
      cursor: q.cursor,
      limit: q.limit,
    });
  }

  @Get('period-end-entries/:id')
  @Operation('getPeriodEndEntry')
  async getPeriodEndEntry(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.periodEndEntries.get(tenantPrincipal(req), id);
  }

  /**
   * POST /period-end-entries/{id}/recognize — releases one period's portion.
   * `amount` is optional: absent, the service computes the straight-line portion
   * and the final tranche absorbs the rounding, so the releases sum to the total
   * exactly. Idempotent per entry and period — a rerun posts nothing.
   */
  @Post('period-end-entries/:id/recognize')
  @Operation('recognizePeriodEndEntry')
  async recognizePeriodEndEntry(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(
      z.object({ accounting_period_id: uuid, amount: decimalString.optional() }),
      body,
    );
    return this.periodEndEntries.recognize(tenantPrincipal(req), id, {
      accountingPeriodId: b.accounting_period_id,
      amount: b.amount,
    });
  }

  // --- financial statement snapshots ---------------------------------------

  @Get('financial-statement-snapshots')
  @Operation('listFinancialSnapshots')
  async listSnapshots(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(
      z.object({
        legal_entity_id: uuid.optional(),
        accounting_period_id: uuid.optional(),
        snapshot_type: z.enum(SNAPSHOT_TYPE).optional(),
        include_payload: boolQuery.optional(),
      }),
      query,
    );
    return this.snapshots.list(tenantPrincipal(req), {
      legalEntityId: q.legal_entity_id,
      accountingPeriodId: q.accounting_period_id,
      snapshotType: q.snapshot_type,
      includePayload: q.include_payload,
    });
  }

  /**
   * POST /financial-statement-snapshots.
   *
   * `payload` is the statement, and it crosses this boundary untouched: the content
   * hash is computed by `financial_snapshot_content_hash` in the database, so any
   * normalisation here — reordering keys, re-encoding a decimal string as a number —
   * would change the hash of the thing that was issued. The optional `approval`
   * block is the one moment the 0016 immutability trigger permits an approval to be
   * written, and the service refuses it NULL-safely when the approver is the issuer
   * or when either of them is unknown.
   */
  @Post('financial-statement-snapshots')
  @Operation('createFinancialSnapshot')
  async createSnapshot(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const b = parse(
      z.object({
        legal_entity_id: uuid.nullish(),
        consolidation_group_id: uuid.nullish(),
        accounting_book_id: uuid.nullish(),
        accounting_period_id: uuid,
        // Left optional here and required by `assert_statement_snapshot_complete`
        // (0053) for PROFIT_LOSS, BALANCE_SHEET and CASH_FLOW: the database knows
        // which types have to name the definition they were rendered from, and a
        // second copy of that rule here would be one more thing to keep in step.
        report_definition_id: uuid.nullish(),
        snapshot_type: z.enum(SNAPSHOT_TYPE),
        parameters: z.record(z.unknown()).optional(),
        payload: z.record(z.unknown()),
        output_file_id: uuid.nullish(),
        approval: z.object({ approved_by: uuid, reason: note.optional() }).optional(),
      }),
      body,
    );
    return this.snapshots.create(tenantPrincipal(req), {
      legalEntityId: b.legal_entity_id ?? undefined,
      consolidationGroupId: b.consolidation_group_id ?? undefined,
      accountingBookId: b.accounting_book_id ?? undefined,
      accountingPeriodId: b.accounting_period_id,
      reportDefinitionId: b.report_definition_id ?? undefined,
      snapshotType: b.snapshot_type,
      parameters: b.parameters,
      payload: b.payload,
      outputFileId: b.output_file_id ?? undefined,
      ...(b.approval
        ? { approval: { approvedBy: b.approval.approved_by, reason: b.approval.reason } }
        : {}),
    });
  }

  /**
   * POST /financial-statement-snapshots/{id}/approve — 201, and it writes no UPDATE.
   *
   * The approval of an already-issued statement is a new append-only fact, because
   * the snapshot row is immutable by trigger (0016) and by revoked privilege (Gate
   * C), and neither control is relaxed to make this route work.
   */
  @Post('financial-statement-snapshots/:id/approve')
  @Operation('approveFinancialSnapshot')
  async approveSnapshot(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(z.object({ reason: note.optional() }), body ?? {});
    return this.snapshots.recordApproval(tenantPrincipal(req), id, { reason: b.reason });
  }
}
