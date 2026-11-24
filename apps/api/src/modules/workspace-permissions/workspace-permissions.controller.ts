import { Body, Controller, Delete, Get, Param, Put, Query } from '@nestjs/common';
import { permissionTemplateInput, WORKSPACE_PERMISSION_LEVELS, workspacePermissionsInput, type WorkspacePermissionsInput } from '@crew/contracts';
import { z } from 'zod';
import { RequirePermission } from '../../platform/authz/decorators';
import { ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { WorkspacePermissionsService } from './workspace-permissions.service';

const viewQuery = z.object({ level: z.enum(WORKSPACE_PERMISSION_LEVELS).default('hr'), groupId: z.string().trim().max(40).optional() });
const templateKey = z.enum(['hr_default', 'employee_default']);

/** Settings > Workspace Permissions: categories, Select all, templates. Enforced by the API on every request. */
@Controller('workspace-permissions')
export class WorkspacePermissionsController {
  constructor(private readonly perms: WorkspacePermissionsService) {}

  @Get()
  @RequirePermission('hierarchy:read')
  @Doc({ summary: 'The permission switches of one level for one group (an HR Workspace, central, or all Employee Workspaces), by category, with the templates', query: viewQuery })
  view(@Query(new ZodPipe(viewQuery)) q: z.infer<typeof viewQuery>) {
    return this.perms.view(q.level, q.groupId);
  }

  @Put()
  @RequirePermission('hierarchy:manage')
  @Doc({ summary: 'Save the switches of one level for one group (Super Workspace). Switches only take away: a level never gets more than its access gives', body: workspacePermissionsInput })
  save(@Body(new ZodPipe(workspacePermissionsInput)) body: WorkspacePermissionsInput) {
    return this.perms.save(body);
  }

  @Put('templates/:key')
  @RequirePermission('hierarchy:manage')
  @Doc({ summary: 'Change the Default HR or Default Employee template (applies to workspaces created from now on)', body: permissionTemplateInput })
  saveTemplate(@Param('key', new ZodPipe(templateKey)) key: z.infer<typeof templateKey>, @Body(new ZodPipe(permissionTemplateInput)) body: z.infer<typeof permissionTemplateInput>) {
    return this.perms.saveTemplate(key, body.permissions);
  }

  @Delete('templates/:key')
  @RequirePermission('hierarchy:manage')
  @Doc({ summary: 'Reset a default template to the SampCrew defaults' })
  resetTemplate(@Param('key', new ZodPipe(templateKey)) key: z.infer<typeof templateKey>) {
    return this.perms.saveTemplate(key, null);
  }
}
