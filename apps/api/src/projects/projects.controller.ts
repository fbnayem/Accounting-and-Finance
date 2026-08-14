import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import {
  BudgetControlService,
  BudgetsService,
  ForecastsService,
  ProjectsService,
} from '@acct/projects';
import { Operation } from '../common/operation';
import {
  code as codeField,
  currencyCode,
  decimalString,
  isoDate,
  name as nameField,
  parse,
  uuid,
} from '../common/validation';
import type { AuthenticatedRequest } from '../common/auth.guard';
import { tenantPrincipal } from '../common/request';

/**
 * doc 10's twelve operations: projects, project billing, budgets, budget
 * control and forecasts.
 *
 * One controller, because they share one subject — plans measured against the
 * posted ledger — and splitting them by table would put `/budget-control/check`
 * somewhere other than the budgets it enforces. `/reports/budget-vs-actual` is
 * here too rather than in a reports controller: it is the variance computation
 * with the budget resolved by filter instead of by id, and BudgetsService owns
 * both forms. Each handler declares only which contract operation it is; the
 * permission, the idempotency rule and the success status come from
 * `contracts/openapi.yaml` at request time.
 */

const Money = decimalString;

/**
 * Budgets and forecasts share one line shape by design (0014): a (period,
 * account, amount) cell, with the currency taken from the header so a per-line
 * override cannot make the header total meaningless.
 */
const PlanLine = z.object({
  accounting_period_id: uuid,
  account_id: uuid,
  amount: Money,
});

@Controller()
export class ProjectsController {
  constructor(
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(BudgetsService) private readonly budgets: BudgetsService,
    @Inject(BudgetControlService) private readonly budgetControl: BudgetControlService,
    @Inject(ForecastsService) private readonly forecasts: ForecastsService,
  ) {}

  // --- projects and billing ------------------------------------------------

  @Get('projects')
  @Operation('listProjects')
  async listProjects(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(
      z.object({
        legal_entity_id: uuid.optional(),
        customer_id: uuid.optional(),
        // Free string here: the service validates against the project_status
        // enum with an error that names the valid values.
        status: z.string().optional(),
      }),
      query,
    );
    return this.projects.listProjects(tenantPrincipal(req), {
      legalEntityId: q.legal_entity_id,
      customerId: q.customer_id,
      status: q.status,
    });
  }

  @Post('projects')
  @Operation('createProject')
  async createProject(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const b = parse(
      z.object({
        organization_id: uuid,
        code: codeField,
        name: nameField,
        // Nullable by design (0014): a project may span an organization and
        // belong to no single legal entity.
        legal_entity_id: uuid.nullish(),
        customer_id: uuid.nullish(),
        manager_user_id: uuid.nullish(),
        start_date: isoDate.nullish(),
        end_date: isoDate.nullish(),
        contract_value: Money.nullish(),
        currency: currencyCode.nullish(),
        billing_method: z.string().nullish(),
        settings: z.record(z.unknown()).optional(),
      }),
      body,
    );
    return this.projects.createProject(tenantPrincipal(req), {
      organizationId: b.organization_id,
      code: b.code,
      name: b.name,
      legalEntityId: b.legal_entity_id,
      customerId: b.customer_id,
      managerUserId: b.manager_user_id,
      startDate: b.start_date,
      endDate: b.end_date,
      contractValue: b.contract_value,
      currency: b.currency,
      billingMethod: b.billing_method,
      settings: b.settings,
    });
  }

  @Post('projects/:id/billing-proposals')
  @Operation('createBillingProposal')
  async createBillingProposal(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(
      z.object({
        accounting_book_id: uuid,
        revenue_account_id: uuid,
        posting_date: isoDate,
        document_date: isoDate.optional(),
        period_start: isoDate.optional(),
        period_end: isoDate.optional(),
        due_date: isoDate.optional(),
        tax_code_id: uuid.optional(),
        notes: z.string().optional(),
      }),
      body,
    );
    return this.projects.createBillingProposal(tenantPrincipal(req), id, {
      accountingBookId: b.accounting_book_id,
      revenueAccountId: b.revenue_account_id,
      postingDate: b.posting_date,
      documentDate: b.document_date,
      periodStart: b.period_start,
      periodEnd: b.period_end,
      dueDate: b.due_date,
      taxCodeId: b.tax_code_id,
      notes: b.notes,
    });
  }

  // --- budgets --------------------------------------------------------------

  @Get('budgets')
  @Operation('listBudgets')
  async listBudgets(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(
      z.object({
        legal_entity_id: uuid.optional(),
        accounting_book_id: uuid.optional(),
        fiscal_year_id: uuid.optional(),
        status: z.string().optional(),
      }),
      query,
    );
    return this.budgets.listBudgets(tenantPrincipal(req), {
      legalEntityId: q.legal_entity_id,
      accountingBookId: q.accounting_book_id,
      fiscalYearId: q.fiscal_year_id,
      status: q.status,
    });
  }

  @Post('budgets')
  @Operation('createBudget')
  async createBudget(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const b = parse(
      z.object({
        legal_entity_id: uuid,
        accounting_book_id: uuid,
        fiscal_year_id: uuid,
        name: nameField,
        currency: currencyCode,
        scenario: z.string().optional(),
        control_policy: z.string().optional(),
        control_threshold_pct: decimalString.nullish(),
        owner_user_id: uuid.nullish(),
        // Lines arrive with the header because there is no add-line route and
        // approval freezes them; emptiness is the service's refusal to make, so
        // its explanation of why is the one the caller sees.
        lines: z.array(PlanLine),
      }),
      body,
    );
    return this.budgets.createBudget(tenantPrincipal(req), {
      legalEntityId: b.legal_entity_id,
      accountingBookId: b.accounting_book_id,
      fiscalYearId: b.fiscal_year_id,
      name: b.name,
      currency: b.currency,
      scenario: b.scenario,
      controlPolicy: b.control_policy,
      controlThresholdPct: b.control_threshold_pct,
      ownerUserId: b.owner_user_id,
      lines: b.lines.map((l) => ({
        accountingPeriodId: l.accounting_period_id,
        accountId: l.account_id,
        amount: l.amount,
      })),
    });
  }

  @Post('budgets/:id/approve')
  @Operation('approveBudget')
  async approveBudget(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.budgets.approveBudget(tenantPrincipal(req), id);
  }

  @Post('budgets/:id/revise')
  @Operation('reviseBudget')
  async reviseBudget(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(
      z.object({
        scenario: z.string().optional(),
        control_policy: z.string().optional(),
        // Omitted keeps the old threshold, explicit null clears it — the two
        // mean different things, so `.nullish()` and the distinction is passed
        // through to the service untouched.
        control_threshold_pct: decimalString.nullish(),
        owner_user_id: uuid.optional(),
        // Omitted copies the approved lines to the new version; given, it
        // replaces the set entirely.
        lines: z.array(PlanLine).optional(),
      }),
      body,
    );
    return this.budgets.reviseBudget(tenantPrincipal(req), id, {
      scenario: b.scenario,
      controlPolicy: b.control_policy,
      controlThresholdPct: b.control_threshold_pct,
      ownerUserId: b.owner_user_id,
      lines: b.lines?.map((l) => ({
        accountingPeriodId: l.accounting_period_id,
        accountId: l.account_id,
        amount: l.amount,
      })),
    });
  }

  @Get('budgets/:id/variance')
  @Operation('getBudgetVariance')
  async getBudgetVariance(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.budgets.getBudgetVariance(tenantPrincipal(req), id);
  }

  // --- budget control -------------------------------------------------------

  /**
   * The GET form of the evaluation the spending mutations run in-transaction
   * (F-106): same arithmetic, advisory by construction here because a GET
   * cannot hold the lock under which a purchase order is approved.
   */
  @Get('budget-control/check')
  @Operation('checkBudgetControl')
  async checkBudgetControl(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(
      z.object({
        legal_entity_id: uuid,
        accounting_book_id: uuid,
        accounting_period_id: uuid,
        account_id: uuid,
        amount: Money,
        budget_id: uuid.optional(),
      }),
      query,
    );
    return this.budgetControl.check(tenantPrincipal(req), {
      legalEntityId: q.legal_entity_id,
      accountingBookId: q.accounting_book_id,
      accountingPeriodId: q.accounting_period_id,
      accountId: q.account_id,
      amount: q.amount,
      budgetId: q.budget_id,
    });
  }

  // --- forecasts ------------------------------------------------------------

  @Get('forecasts')
  @Operation('listForecasts')
  async listForecasts(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(
      z.object({
        legal_entity_id: uuid.optional(),
        accounting_book_id: uuid.optional(),
        fiscal_year_id: uuid.optional(),
        name: z.string().optional(),
      }),
      query,
    );
    return this.forecasts.listForecasts(tenantPrincipal(req), {
      legalEntityId: q.legal_entity_id,
      accountingBookId: q.accounting_book_id,
      fiscalYearId: q.fiscal_year_id,
      name: q.name,
    });
  }

  @Post('forecasts')
  @Operation('createForecast')
  async createForecast(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const b = parse(
      z.object({
        legal_entity_id: uuid,
        accounting_book_id: uuid,
        fiscal_year_id: uuid,
        name: nameField,
        as_of_date: isoDate,
        currency: currencyCode,
        scenario: z.string().optional(),
        lines: z.array(PlanLine),
      }),
      body,
    );
    return this.forecasts.createForecast(tenantPrincipal(req), {
      legalEntityId: b.legal_entity_id,
      accountingBookId: b.accounting_book_id,
      fiscalYearId: b.fiscal_year_id,
      name: b.name,
      asOfDate: b.as_of_date,
      currency: b.currency,
      scenario: b.scenario,
      lines: b.lines.map((l) => ({
        accountingPeriodId: l.accounting_period_id,
        accountId: l.account_id,
        amount: l.amount,
      })),
    });
  }

  // --- reports --------------------------------------------------------------

  @Get('reports/budget-vs-actual')
  @Operation('getBudgetVsActual')
  async getBudgetVsActual(@Req() req: AuthenticatedRequest, @Query() query: unknown) {
    const q = parse(
      z.object({
        // Required, unlike the other list filters: the report resolves "the
        // Current Approved Budget" and that phrase is only meaningful within
        // one entity and one book.
        legal_entity_id: uuid,
        accounting_book_id: uuid,
        budget_id: uuid.optional(),
        fiscal_year_id: uuid.optional(),
        name: z.string().optional(),
      }),
      query,
    );
    return this.budgets.getBudgetVsActual(tenantPrincipal(req), {
      legalEntityId: q.legal_entity_id,
      accountingBookId: q.accounting_book_id,
      budgetId: q.budget_id,
      fiscalYearId: q.fiscal_year_id,
      name: q.name,
    });
  }
}
