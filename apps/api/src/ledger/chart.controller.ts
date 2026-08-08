import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import { Operation } from '../common/operation';
import { code as codeField, name as nameField, isoDate, parse, uuid } from '../common/validation';
import type { AuthenticatedRequest } from '../common/auth.guard';
import { tenantPrincipal } from '../common/request';
import { ChartService } from '@acct/ledger';

const ACCOUNT_TYPE = z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']);
const NORMAL_BALANCE = z.enum(['DEBIT', 'CREDIT']);
const CASH_FLOW = z.enum(['OPERATING', 'INVESTING', 'FINANCING', 'NONE']);

const CreateAccountBody = z.object({
  legal_entity_id: uuid,
  code: codeField,
  name: nameField,
  account_type: ACCOUNT_TYPE,
  normal_balance: NORMAL_BALANCE.optional(),
  subtype: z.string().trim().max(60).optional(),
  group_id: uuid.optional(),
  parent_id: uuid.optional(),
  is_posting: z.boolean().optional(),
  is_control: z.boolean().optional(),
  cash_flow_classification: CASH_FLOW.optional(),
});

const UpdateAccountBody = z.object({
  name: nameField.optional(),
  subtype: z.string().trim().max(60).optional(),
  group_id: uuid.nullable().optional(),
  account_type: ACCOUNT_TYPE.optional(),
  normal_balance: NORMAL_BALANCE.optional(),
  is_posting: z.boolean().optional(),
  is_control: z.boolean().optional(),
  cash_flow_classification: CASH_FLOW.nullable().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']).optional(),
});

const DimensionRulesBody = z.object({
  rules: z
    .array(
      z.object({
        dimension_id: uuid,
        rule: z.enum(['REQUIRED', 'OPTIONAL', 'PROHIBITED', 'DEFAULTED']),
        default_value_id: uuid.optional(),
      }),
    )
    .max(50),
});

@Controller()
export class ChartController {
  constructor(@Inject(ChartService) private readonly chart: ChartService) {}

  @Get('account-groups')
  @Operation('listAccountGroups')
  async listGroups(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(z.object({ legal_entity_id: uuid.optional() }), query);
    return this.chart.listAccountGroups(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
    });
  }

  @Post('account-groups')
  @Operation('createAccountGroup')
  async createGroup(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(
      z.object({
        legal_entity_id: uuid,
        code: codeField,
        name: nameField,
        parent_id: uuid.optional(),
        sort_order: z.number().int().min(0).max(9999).optional(),
      }),
      body,
    );
    return this.chart.createAccountGroup(tenantPrincipal(request), {
      legalEntityId: input.legal_entity_id,
      code: input.code,
      name: input.name,
      parentId: input.parent_id,
      sortOrder: input.sort_order,
    });
  }

  @Get('accounts')
  @Operation('listAccounts')
  async listAccounts(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({
        legal_entity_id: uuid.optional(),
        account_type: ACCOUNT_TYPE.optional(),
        status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']).optional(),
        posting_only: z.coerce.boolean().optional(),
        search: z.string().trim().max(80).optional(),
      }),
      query,
    );
    return this.chart.listAccounts(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
      accountType: parsed.account_type,
      status: parsed.status,
      postingOnly: parsed.posting_only,
      search: parsed.search,
    });
  }

  @Post('accounts')
  @Operation('createAccount')
  async createAccount(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(CreateAccountBody, body);
    return this.chart.createAccount(tenantPrincipal(request), {
      legalEntityId: input.legal_entity_id,
      code: input.code,
      name: input.name,
      accountType: input.account_type,
      normalBalance: input.normal_balance,
      subtype: input.subtype,
      groupId: input.group_id,
      parentId: input.parent_id,
      isPosting: input.is_posting,
      isControl: input.is_control,
      cashFlowClassification: input.cash_flow_classification,
    });
  }

  @Patch('accounts/:id')
  @Operation('updateAccount')
  async updateAccount(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string,
    @Body() body: unknown,
  ) {
    const input = parse(UpdateAccountBody, body);
    return this.chart.updateAccount(tenantPrincipal(request), parse(uuid, id), ifMatch ?? '', {
      name: input.name,
      subtype: input.subtype,
      groupId: input.group_id,
      accountType: input.account_type,
      normalBalance: input.normal_balance,
      isPosting: input.is_posting,
      isControl: input.is_control,
      cashFlowClassification: input.cash_flow_classification,
      status: input.status,
    });
  }

  @Get('accounts/:id/dimension-rules')
  @Operation('getAccountDimensionRules')
  async getRules(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.chart.getAccountDimensionRules(tenantPrincipal(request), parse(uuid, id));
  }

  @Put('accounts/:id/dimension-rules')
  @Operation('setAccountDimensionRules')
  async setRules(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(DimensionRulesBody, body);
    return this.chart.setAccountDimensionRules(
      tenantPrincipal(request),
      parse(uuid, id),
      input.rules.map((r) => ({
        dimensionId: r.dimension_id,
        rule: r.rule,
        defaultValueId: r.default_value_id,
      })),
    );
  }

  @Get('dimensions')
  @Operation('listDimensions')
  async listDimensions(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(z.object({ legal_entity_id: uuid.optional() }), query);
    return this.chart.listDimensions(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
    });
  }

  @Post('dimensions')
  @Operation('createDimension')
  async createDimension(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(
      z.object({
        legal_entity_id: uuid,
        code: codeField,
        name: nameField,
        hierarchy_enabled: z.boolean().optional(),
      }),
      body,
    );
    return this.chart.createDimension(tenantPrincipal(request), {
      legalEntityId: input.legal_entity_id,
      code: input.code,
      name: input.name,
      hierarchyEnabled: input.hierarchy_enabled,
    });
  }

  @Get('dimension-values')
  @Operation('listDimensionValues')
  async listValues(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({ legal_entity_id: uuid.optional(), dimension_id: uuid.optional() }),
      query,
    );
    return this.chart.listDimensionValues(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
      dimensionId: parsed.dimension_id,
    });
  }

  @Post('dimension-values')
  @Operation('createDimensionValue')
  async createValue(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(
      z.object({
        dimension_id: uuid,
        code: codeField,
        name: nameField,
        parent_id: uuid.optional(),
        valid_from: isoDate.optional(),
        valid_to: isoDate.optional(),
      }),
      body,
    );
    return this.chart.createDimensionValue(tenantPrincipal(request), {
      dimensionId: input.dimension_id,
      code: input.code,
      name: input.name,
      parentId: input.parent_id,
      validFrom: input.valid_from,
      validTo: input.valid_to,
    });
  }
}
