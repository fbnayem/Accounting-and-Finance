import { Body, Controller, Get, Headers, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Operation } from '../common/operation';
import {
  code as codeField,
  email as emailField,
  name as nameField,
  parse,
  uuid,
} from '../common/validation';
import type { AuthenticatedRequest } from '../common/auth.guard';
import { tenantPrincipal } from '../common/request';
import { IamService, roleEtag } from './iam.service';

const InviteUserBody = z.object({
  email: emailField,
  role_id: uuid,
  organization_id: uuid.optional(),
  legal_entity_id: uuid.optional(),
  branch_id: uuid.optional(),
  expires_in_days: z.number().int().min(1).max(90).optional(),
});

const CreateRoleBody = z.object({
  code: codeField,
  name: nameField,
  description: z.string().trim().max(500).optional(),
  permissions: z.array(z.string().trim().min(1)).max(300).default([]),
});

const UpdateRoleBody = z.object({
  name: nameField.optional(),
  description: z.string().trim().max(500).nullable().optional(),
  permissions: z.array(z.string().trim().min(1)).max(300).optional(),
});

const CreateMembershipBody = z.object({
  user_id: uuid,
  role_id: uuid,
  organization_id: uuid.optional(),
  legal_entity_id: uuid.optional(),
  branch_id: uuid.optional(),
});

@Controller()
export class IamController {
  constructor(@Inject(IamService) private readonly iam: IamService) {}

  @Get('users')
  @Operation('listUsers')
  async listUsers(@Req() request: AuthenticatedRequest) {
    return this.iam.listUsers(tenantPrincipal(request));
  }

  @Post('users/invite')
  @Operation('inviteUser')
  async inviteUser(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(InviteUserBody, body);
    return this.iam.inviteUser(tenantPrincipal(request), {
      email: input.email,
      roleId: input.role_id,
      organizationId: input.organization_id,
      legalEntityId: input.legal_entity_id,
      branchId: input.branch_id,
      expiresInDays: input.expires_in_days,
    });
  }

  @Post('users/:id/suspend')
  @Operation('suspendUser')
  async suspendUser(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.iam.setUserSuspension(tenantPrincipal(request), parse(uuid, id), true);
  }

  @Post('users/:id/reactivate')
  @Operation('reactivateUser')
  async reactivateUser(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.iam.setUserSuspension(tenantPrincipal(request), parse(uuid, id), false);
  }

  @Get('permissions')
  @Operation('listPermissions')
  listPermissions() {
    return this.iam.listPermissions();
  }

  @Get('roles')
  @Operation('listRoles')
  async listRoles(@Req() request: AuthenticatedRequest) {
    const result = await this.iam.listRoles(tenantPrincipal(request));
    // The ETag the PATCH route expects, returned with the row that produced it, so
    // a client never has to guess what to send back in If-Match.
    return {
      data: result.data.map((role) => ({
        ...(role as Record<string, unknown>),
        etag: roleEtag(role as never),
      })),
    };
  }

  @Post('roles')
  @Operation('createRole')
  async createRole(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(CreateRoleBody, body);
    return this.iam.createRole(tenantPrincipal(request), {
      code: input.code,
      name: input.name,
      description: input.description,
      permissions: input.permissions,
    });
  }

  @Patch('roles/:id')
  @Operation('updateRole')
  async updateRole(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: unknown,
  ) {
    const input = parse(UpdateRoleBody, body);
    return this.iam.updateRole(tenantPrincipal(request), parse(uuid, id), ifMatch ?? '', {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.permissions !== undefined ? { permissions: input.permissions } : {}),
    });
  }

  @Get('memberships')
  @Operation('listMemberships')
  async listMemberships(@Req() request: AuthenticatedRequest) {
    return this.iam.listMemberships(tenantPrincipal(request));
  }

  @Post('memberships')
  @Operation('createMembership')
  async createMembership(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    const input = parse(CreateMembershipBody, body);
    return this.iam.createMembership(tenantPrincipal(request), {
      userId: input.user_id,
      roleId: input.role_id,
      organizationId: input.organization_id,
      legalEntityId: input.legal_entity_id,
      branchId: input.branch_id,
    });
  }
}
