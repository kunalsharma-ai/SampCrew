import { Body, Controller, Get, Param, Post, Put, Query, Res, UploadedFile as File, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { featureLevelsInput, roleGrantsInput, workspaceModulesInput } from '@crew/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../../platform/authz/decorators';
import { sendFile } from '../../platform/export/tabular';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import type { UploadedFile } from '../../platform/storage/uploads';
import { EmployeeImportService } from './employee-import.service';
import { FeatureLevelsService } from '../hierarchy/feature-levels.service';
import { HrAdminService } from './hr-admin.service';

const importQuery = z.object({ dryRun: z.enum(['true', 'false']).default('true').transform((v) => v === 'true') });

/** HR Workspace Admin: module access and the role and permission matrix. */
@Controller('hr-admin')
export class HrAdminController {
  constructor(private readonly admin: HrAdminService, private readonly levels: FeatureLevelsService) {}

  @Get('features')
  @RequirePermission('tenant:read')
  @Doc({ summary: 'Feature management: every module and page for the company, the HR Workspace level and the Employee Workspace level' })
  features() {
    return this.levels.matrix();
  }

  @Put('features')
  @RequirePermission('modules:manage')
  @Doc({ summary: 'Switch modules or pages on or off for the company, the HR Workspace level or the Employee Workspace level', body: featureLevelsInput })
  setFeatures(@Body(new ZodPipe(featureLevelsInput)) body: z.infer<typeof featureLevelsInput>) {
    return this.levels.setLevels(body.changes);
  }

  @Get('modules')
  @RequirePermission('tenant:read')
  @Doc({ summary: 'Modules the plan includes and whether this workspace has them switched on' })
  modules() {
    return this.admin.modules();
  }

  @Put('modules')
  @RequirePermission('modules:manage')
  @Doc({ summary: 'Switch modules off for everyone in the workspace, or back on (within the plan)', body: workspaceModulesInput })
  setModules(@Body(new ZodPipe(workspaceModulesInput)) body: z.infer<typeof workspaceModulesInput>) {
    return this.admin.setModules(body);
  }

  @Get('permissions')
  @RequirePermission('roles:read')
  @Doc({ summary: 'Every role against every permission, by module and action (View, Create, Edit, Delete, Approve, Export, Manage)' })
  matrix() {
    return this.admin.matrix();
  }

  @Put('roles/:id/permissions')
  @RequirePermission('roles:manage')
  @Doc({ summary: 'Replace a role’s permissions (built-in roles too, except Workspace Owner)', body: roleGrantsInput })
  setGrants(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(roleGrantsInput)) body: z.infer<typeof roleGrantsInput>) {
    return this.admin.setRoleGrants(id, body);
  }

  @Post('roles/:id/reset')
  @RequirePermission('roles:manage')
  @Doc({ summary: 'Put a built-in role back to the permissions it ships with' })
  reset(@Param('id', UuidPipe) id: string) {
    return this.admin.resetRole(id);
  }
}

/** Bulk import of existing employees from the CSV or Excel template. */
@Controller('employees/import')
export class EmployeeImportController {
  constructor(private readonly importer: EmployeeImportService) {}

  @Get('template.xlsx')
  @RequirePermission('employees:create')
  @Doc({ summary: 'The import template as an Excel workbook (with a column per leave type)' })
  async template(@Res() res: Response) {
    sendFile(res, { fileName: 'existing-employees-template.xlsx', content: await this.importer.template() }, 'xlsx');
  }

  @Post()
  @RequirePermission('employees:create')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }))
  @Doc({ summary: 'Check (dryRun=true, the default) or import a filled-in template of existing employees. Multipart: file.', query: importQuery })
  run(@Query(new ZodPipe(importQuery)) q: z.infer<typeof importQuery>, @File() file?: UploadedFile) {
    return this.importer.run(file, q.dryRun);
  }
}
