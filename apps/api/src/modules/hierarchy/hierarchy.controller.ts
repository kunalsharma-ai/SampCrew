import { Body, Controller, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  employeeTransferInput,
  hrWorkspaceAdminsInput,
  hrWorkspaceAssignInput,
  hrWorkspaceInput,
  hrWorkspaceListQuery,
  hrWorkspaceMembersQuery,
  hrWorkspaceStatusInput,
  hrWorkspaceUpdate,
  memberModulesInput,
  employeeFeaturesInput,
  employeeFeaturesQuery,
} from '@crew/contracts';
import { z } from 'zod';
import { RequirePermission } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { FeatureLevelsService } from './feature-levels.service';
import { HierarchyService } from './hierarchy.service';

const historyQuery = z.object({ hrWorkspaceId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) });
const transfersQuery = z.object({ employeeId: z.uuid().optional(), hrWorkspaceId: z.uuid().optional() });
const centralAssign = hrWorkspaceAssignInput;

/**
 * Super Workspace > HR Workspace > Employee. Creating and changing HR Workspaces is the Super Workspace's
 * (hierarchy:manage); HR Workspace admins read their own HR Workspaces and choose which modules each of their
 * employees gets (modules:assign, limited to their people). Every rule is enforced in HierarchyService.
 */
@Controller('hr-workspaces')
export class HierarchyController {
  constructor(private readonly hierarchy: HierarchyService, private readonly levels: FeatureLevelsService) {}

  @Get('overview')
  @RequirePermission('hierarchy:read')
  @Doc({ summary: 'The company, its central group and its HR Workspaces, with what each may use' })
  overview() {
    return this.hierarchy.overview();
  }

  @Get()
  @RequirePermission('hierarchy:read')
  @Doc({ summary: 'HR Workspaces (an HR Workspace admin sees only theirs)', query: hrWorkspaceListQuery })
  list(@Query(new ZodPipe(hrWorkspaceListQuery)) q: z.infer<typeof hrWorkspaceListQuery>) {
    return this.hierarchy.list(q);
  }

  @Post()
  @RequirePermission('hierarchy:manage')
  @Doc({ summary: 'Create an HR Workspace with a subset of the company’s delegable modules', body: hrWorkspaceInput })
  create(@Body(new ZodPipe(hrWorkspaceInput)) body: z.infer<typeof hrWorkspaceInput>) {
    return this.hierarchy.create(body);
  }

  @Get('history')
  @RequirePermission('hierarchy:read')
  @Doc({ summary: 'Versioned change history of the delegation chain', query: historyQuery })
  history(@Query(new ZodPipe(historyQuery)) q: z.infer<typeof historyQuery>) {
    return this.hierarchy.history(q);
  }

  @Get('transfers')
  @RequirePermission('employees:read')
  @Doc({ summary: 'Moves of employees between HR Workspaces', query: transfersQuery })
  transfers(@Query(new ZodPipe(transfersQuery)) q: z.infer<typeof transfersQuery>) {
    return this.hierarchy.transfers(q);
  }

  @Post('transfers')
  @RequirePermission('employees:transfer')
  @Doc({ summary: 'Move an employee to another HR Workspace or to the central group; history is kept', body: employeeTransferInput })
  transfer(@Body(new ZodPipe(employeeTransferInput)) body: z.infer<typeof employeeTransferInput>) {
    return this.hierarchy.transfer(body);
  }

  @Get('central/members')
  @RequirePermission('hierarchy:read')
  @Doc({ summary: 'Employees in the company’s central group (run by the Super Workspace)', query: hrWorkspaceMembersQuery })
  centralMembers(@Query(new ZodPipe(hrWorkspaceMembersQuery)) q: z.infer<typeof hrWorkspaceMembersQuery>) {
    return this.hierarchy.members('central', q);
  }

  @Post('central/members')
  @RequirePermission('employees:transfer')
  @Doc({ summary: 'Move employees back to the central group', body: centralAssign })
  toCentral(@Body(new ZodPipe(centralAssign)) body: z.infer<typeof centralAssign>) {
    return this.hierarchy.assign(null, body.employeeIds, body.reason);
  }

  @Put('employees/:employeeId/modules')
  @RequirePermission('modules:assign')
  @Doc({ summary: 'Choose which of their HR Workspace’s modules one employee gets', body: memberModulesInput })
  memberModules(@Param('employeeId', UuidPipe) employeeId: string, @Body(new ZodPipe(memberModulesInput)) body: z.infer<typeof memberModulesInput>) {
    return this.hierarchy.setMemberModules(employeeId, body.modules, body.version);
  }

  @Get('employee-features')
  @RequirePermission('modules:assign')
  @Doc({ summary: 'Employee Workspace features of the central group or one HR Workspace, with what the Super Workspace allows' })
  employeeFeatures(@Query(new ZodPipe(employeeFeaturesQuery)) q: z.infer<typeof employeeFeaturesQuery>) {
    return this.levels.employeeFeatures(q.scope);
  }

  @Put('employee-features')
  @RequirePermission('modules:assign')
  @Doc({ summary: 'Switch Employee Workspace features on or off for the central group or one HR Workspace (within what the Super Workspace allows)', body: employeeFeaturesInput })
  setEmployeeFeatures(@Body(new ZodPipe(employeeFeaturesInput)) body: z.infer<typeof employeeFeaturesInput>) {
    return this.levels.setEmployeeFeatures(body.scope, body.changes);
  }

  @Get(':id')
  @RequirePermission('hierarchy:read')
  @Doc({ summary: 'One HR Workspace: its modules against the company’s, admins, limits and usage' })
  get(@Param('id', UuidPipe) id: string) {
    return this.hierarchy.get(id);
  }

  @Patch(':id')
  @RequirePermission('hierarchy:manage')
  @Doc({ summary: 'Change an HR Workspace (name, modules, limits); refused when made on an older version', body: hrWorkspaceUpdate })
  update(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(hrWorkspaceUpdate)) body: z.infer<typeof hrWorkspaceUpdate>) {
    return this.hierarchy.update(id, body);
  }

  @Post(':id/status')
  @RequirePermission('hierarchy:manage')
  @Doc({ summary: 'Suspend, reactivate or archive an HR Workspace (archiving moves its people to the central group)', body: hrWorkspaceStatusInput })
  status(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(hrWorkspaceStatusInput)) body: z.infer<typeof hrWorkspaceStatusInput>) {
    return this.hierarchy.setStatus(id, body.status, body.reason);
  }

  @Put(':id/admins')
  @RequirePermission('hierarchy:manage')
  @Doc({ summary: 'Name the people who run an HR Workspace', body: hrWorkspaceAdminsInput })
  admins(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(hrWorkspaceAdminsInput)) body: z.infer<typeof hrWorkspaceAdminsInput>) {
    return this.hierarchy.setAdmins(id, body.membershipIds);
  }

  @Get(':id/members')
  @RequirePermission('hierarchy:read')
  @Doc({ summary: 'Employees of an HR Workspace with the modules each one gets', query: hrWorkspaceMembersQuery })
  members(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(hrWorkspaceMembersQuery)) q: z.infer<typeof hrWorkspaceMembersQuery>) {
    return this.hierarchy.members(id, q);
  }

  @Post(':id/members')
  @RequirePermission('employees:transfer')
  @Doc({ summary: 'Move employees into this HR Workspace', body: hrWorkspaceAssignInput })
  assign(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(hrWorkspaceAssignInput)) body: z.infer<typeof hrWorkspaceAssignInput>) {
    return this.hierarchy.assign(id, body.employeeIds, body.reason);
  }
}
