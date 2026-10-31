import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { customRoleInput } from '@crew/contracts';
import type { z } from 'zod';
import { RequireFeature, RequirePermission } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { RolesService } from './roles.service';

const updateRole = customRoleInput.omit({ key: true });

@Controller()
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get('permissions')
  @RequirePermission('roles:read')
  @Doc({ summary: 'Permission catalogue with allowed scopes, MFA and sensitivity flags' })
  catalogue() {
    return this.roles.catalogue();
  }

  @Get('roles')
  @RequirePermission('roles:read')
  @Doc({ summary: 'List system and custom roles with their grants' })
  list() {
    return this.roles.list();
  }

  @Post('roles')
  @RequirePermission('roles:manage')
  @RequireFeature('custom_roles')
  @Doc({ summary: 'Create a custom role', body: customRoleInput })
  create(@Body(new ZodPipe(customRoleInput)) body: z.infer<typeof customRoleInput>) {
    return this.roles.create(body);
  }

  @Put('roles/:id')
  @RequirePermission('roles:manage')
  @RequireFeature('custom_roles')
  @Doc({ summary: 'Replace a custom role\'s name and grants', body: updateRole })
  update(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(updateRole)) body: z.infer<typeof updateRole>) {
    return this.roles.update(id, body);
  }

  @Delete('roles/:id')
  @RequirePermission('roles:manage')
  @HttpCode(204)
  @Doc({ summary: 'Delete an unused custom role' })
  async remove(@Param('id', UuidPipe) id: string) {
    await this.roles.remove(id);
  }
}
