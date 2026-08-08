import {
  Body,
  Controller,
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
  countryCode,
  currencyCode,
  isoDate,
  name as nameField,
  pageQuery,
  parse,
  timezone,
  uuid,
} from '../common/validation';
import { pageResponse } from '../common/list';
import type { AuthenticatedRequest } from '../common/auth.guard';
import { tenantPrincipal } from '../common/request';
import { OrganizationService } from './organization.service';

const settings = z.record(z.unknown()).optional();

const CreateOrganizationBody = z.object({
  name: nameField,
  display_name: nameField.optional(),
  settings,
});
const UpdateOrganizationBody = z.object({
  name: nameField.optional(),
  display_name: nameField.nullable().optional(),
  settings,
});
const CreateLegalEntityBody = z.object({
  organization_id: uuid,
  code: codeField,
  legal_name: nameField,
  display_name: nameField.optional(),
  registration_number: z.string().trim().max(80).optional(),
  tax_identifier: z.string().trim().max(80).optional(),
  country_code: countryCode,
  functional_currency: currencyCode,
  timezone,
});
const UpdateLegalEntityBody = z.object({
  legal_name: nameField.optional(),
  display_name: nameField.nullable().optional(),
  registration_number: z.string().trim().max(80).nullable().optional(),
  tax_identifier: z.string().trim().max(80).nullable().optional(),
  timezone: timezone.optional(),
  functional_currency: currencyCode.optional(),
  settings,
});
const CreateBranchBody = z.object({
  legal_entity_id: uuid,
  code: codeField,
  name: nameField,
  country_code: countryCode.optional(),
  address: z.record(z.unknown()).optional(),
  manager_user_id: uuid.optional(),
  valid_from: isoDate.optional(),
  valid_to: isoDate.optional(),
});

/** Every route below needs a tenant; the guard has already required the permission. */
@Controller()
export class OrganizationController {
  constructor(@Inject(OrganizationService) private readonly organizations: OrganizationService) {}

  @Get('organizations')
  @Operation('listOrganizations')
  async listOrganizations(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const page = parse(pageQuery, query);
    const result = await this.organizations.listOrganizations(tenantPrincipal(request), page);
    return pageResponse(result, (row) => ({
      id: row.id,
      name: row.name,
      display_name: row.display_name,
      status: row.status,
      version: row.version,
      created_at: row.created_at,
    }));
  }

  @Post('organizations')
  @Operation('createOrganization')
  async createOrganization(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(CreateOrganizationBody, body);
    const row = await this.organizations.createOrganization(tenantPrincipal(request), {
      name: input.name,
      displayName: input.display_name,
      settings: input.settings ?? {},
    });
    return { id: row.id, name: row.name, display_name: row.display_name, version: row.version };
  }

  @Get('organizations/:id')
  @Operation('getOrganization')
  async getOrganization(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    const row = await this.organizations.getOrganization(tenantPrincipal(request), parse(uuid, id));
    return {
      id: row.id,
      name: row.name,
      display_name: row.display_name,
      status: row.status,
      settings: row.settings,
      version: row.version,
      created_at: row.created_at,
    };
  }

  @Patch('organizations/:id')
  @Operation('updateOrganization')
  async updateOrganization(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
  ) {
    const input = parse(UpdateOrganizationBody, body);
    const row = await this.organizations.updateOrganization(
      tenantPrincipal(request),
      parse(uuid, id),
      ifMatch ?? '',
      {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.display_name !== undefined ? { displayName: input.display_name } : {}),
        ...(input.settings !== undefined ? { settings: input.settings } : {}),
      },
    );
    return {
      id: row.id,
      name: row.name,
      display_name: row.display_name,
      settings: row.settings,
      version: row.version,
    };
  }

  @Get('legal-entities')
  @Operation('listLegalEntities')
  async listLegalEntities(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const page = parse(pageQuery, query);
    const result = await this.organizations.listLegalEntities(tenantPrincipal(request), page);
    return pageResponse(result, legalEntityView);
  }

  @Post('legal-entities')
  @Operation('createLegalEntity')
  async createLegalEntity(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(CreateLegalEntityBody, body);
    const row = await this.organizations.createLegalEntity(tenantPrincipal(request), {
      organizationId: input.organization_id,
      code: input.code,
      legalName: input.legal_name,
      displayName: input.display_name,
      registrationNumber: input.registration_number,
      taxIdentifier: input.tax_identifier,
      countryCode: input.country_code,
      functionalCurrency: input.functional_currency,
      timezone: input.timezone,
    });
    return legalEntityView(row);
  }

  @Get('legal-entities/:id')
  @Operation('getLegalEntity')
  async getLegalEntity(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    const row = await this.organizations.getLegalEntity(tenantPrincipal(request), parse(uuid, id));
    return legalEntityView(row);
  }

  @Patch('legal-entities/:id')
  @Operation('updateLegalEntity')
  async updateLegalEntity(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
  ) {
    const input = parse(UpdateLegalEntityBody, body);
    const row = await this.organizations.updateLegalEntity(
      tenantPrincipal(request),
      parse(uuid, id),
      ifMatch ?? '',
      {
        ...(input.legal_name !== undefined ? { legalName: input.legal_name } : {}),
        ...(input.display_name !== undefined ? { displayName: input.display_name } : {}),
        ...(input.registration_number !== undefined
          ? { registrationNumber: input.registration_number }
          : {}),
        ...(input.tax_identifier !== undefined ? { taxIdentifier: input.tax_identifier } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.functional_currency !== undefined
          ? { functionalCurrency: input.functional_currency }
          : {}),
        ...(input.settings !== undefined ? { settings: input.settings } : {}),
      },
    );
    return legalEntityView(row);
  }

  @Post('legal-entities/:id/activate')
  @Operation('activateLegalEntity')
  async activateLegalEntity(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    const result = await this.organizations.activateLegalEntity(
      tenantPrincipal(request),
      parse(uuid, id),
    );
    return { ...legalEntityView(result.entity), readiness: result.checks };
  }

  @Get('branches')
  @Operation('listBranches')
  async listBranches(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(pageQuery.extend({ legal_entity_id: uuid.optional() }), query);
    const result = await this.organizations.listBranches(tenantPrincipal(request), parsed, {
      legalEntityId: parsed.legal_entity_id,
    });
    return pageResponse(result, (row) => ({ ...row, cursor_key: undefined }));
  }

  @Post('branches')
  @Operation('createBranch')
  async createBranch(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(CreateBranchBody, body);
    return this.organizations.createBranch(tenantPrincipal(request), {
      legalEntityId: input.legal_entity_id,
      code: input.code,
      name: input.name,
      countryCode: input.country_code,
      address: input.address,
      managerUserId: input.manager_user_id,
      validFrom: input.valid_from,
      validTo: input.valid_to,
    });
  }

  @Get('settings/effective')
  @Operation('getEffectiveSettings')
  async effectiveSettings(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(
      z.object({ legal_entity_id: uuid.optional(), branch_id: uuid.optional() }),
      query,
    );
    return this.organizations.effectiveSettings(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
      branchId: parsed.branch_id,
    });
  }
}

function legalEntityView(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    organization_id: row.organization_id,
    code: row.code,
    legal_name: row.legal_name,
    display_name: row.display_name,
    registration_number: row.registration_number,
    tax_identifier: row.tax_identifier,
    country_code: row.country_code,
    functional_currency: row.functional_currency,
    timezone: row.timezone,
    status: row.status,
    activated_at: row.activated_at,
    posting_enabled: row.posting_enabled,
    settings: row.settings,
    version: row.version,
  };
}
