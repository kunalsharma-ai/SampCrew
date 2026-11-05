import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  confirmInput,
  createEmployeeInput,
  type CreateEmployeeInput,
  designationInput,
  employeeListQuery,
  exitInput,
  extendProbationInput,
  sensitiveInput,
  transferInput,
  updateEmployeeInput,
} from '@crew/contracts';
import { z } from 'zod';
import { RequirePermission } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { EmployeesService } from './employees.service';

const linkInput = z.object({ membershipId: z.uuid() });
const designationPatch = designationInput.partial();

@Controller('designations')
export class DesignationsController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  @RequirePermission('org:read')
  @Doc({ summary: 'List designations (job titles) with headcount' })
  list() {
    return this.employees.listDesignations();
  }

  @Post()
  @RequirePermission('org:manage')
  @Doc({ summary: 'Create a designation', body: designationInput })
  create(@Body(new ZodPipe(designationInput)) body: z.infer<typeof designationInput>) {
    return this.employees.createDesignation(body);
  }

  @Patch(':id')
  @RequirePermission('org:manage')
  @Doc({ summary: 'Rename or re-level a designation', body: designationPatch })
  update(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(designationPatch)) body: z.infer<typeof designationPatch>) {
    return this.employees.updateDesignation(id, body);
  }

  @Delete(':id')
  @RequirePermission('org:manage')
  @HttpCode(204)
  @Doc({ summary: 'Archive a designation no current employee holds' })
  async archive(@Param('id', UuidPipe) id: string) {
    await this.employees.archiveDesignation(id);
  }
}

@Controller('employees')
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  @RequirePermission('employees:read')
  @Doc({ summary: 'Employee directory, limited to the records your roles cover', query: employeeListQuery })
  list(@Query(new ZodPipe(employeeListQuery)) q: z.infer<typeof employeeListQuery>) {
    return this.employees.list(q);
  }

  @Get('me')
  @Doc({ summary: 'Your own employee record, if your login is linked to one' })
  me() {
    return this.employees.me();
  }

  @Post()
  @RequirePermission('employees:create')
  @Doc({ summary: 'Hire: create the employee, job record, onboarding checklist and (optionally) a CREW invitation', body: createEmployeeInput })
  create(@Body(new ZodPipe(createEmployeeInput)) body: CreateEmployeeInput) {
    return this.employees.create(body);
  }

  @Get(':id')
  @RequirePermission('employees:read')
  @Doc({ summary: 'Employee profile with the actions you may take on it' })
  get(@Param('id', UuidPipe) id: string) {
    return this.employees.get(id);
  }

  @Patch(':id')
  @RequirePermission('employees:update')
  @Doc({ summary: 'Update profile fields. Employees may change only their preferred name, personal email and phone.', body: updateEmployeeInput })
  update(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(updateEmployeeInput)) body: z.infer<typeof updateEmployeeInput>) {
    return this.employees.update(id, body);
  }

  @Get(':id/history')
  @RequirePermission('employees:read')
  @Doc({ summary: 'Effective-dated job history and lifecycle events' })
  history(@Param('id', UuidPipe) id: string) {
    return this.employees.history(id);
  }

  @Get(':id/reports')
  @RequirePermission('employees:read')
  @Doc({ summary: 'Direct reports' })
  reports(@Param('id', UuidPipe) id: string) {
    return this.employees.reports(id);
  }

  @Get(':id/sensitive')
  @RequirePermission('employees:sensitive:read')
  @Doc({ summary: 'Bank, tax and national ID details (MFA required; every view is audited)' })
  sensitive(@Param('id', UuidPipe) id: string) {
    return this.employees.getSensitive(id);
  }

  @Put(':id/sensitive')
  @RequirePermission('employees:update')
  @Doc({ summary: 'Set bank, tax and national ID details (stored encrypted)', body: sensitiveInput })
  putSensitive(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(sensitiveInput)) body: z.infer<typeof sensitiveInput>) {
    return this.employees.putSensitive(id, body);
  }

  @Post(':id/link-login')
  @RequirePermission('employees:update')
  @Doc({ summary: 'Link an existing workspace member to this employee record', body: linkInput })
  link(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(linkInput)) body: z.infer<typeof linkInput>) {
    return this.employees.link(id, body.membershipId);
  }

  @Post(':id/job-changes')
  @RequirePermission('employees:lifecycle')
  @Doc({ summary: 'Transfer, promote or change manager, effective on a date (future dates take effect automatically)', body: transferInput })
  changeJob(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(transferInput)) body: z.infer<typeof transferInput>) {
    return this.employees.changeJob(id, body);
  }

  @Post(':id/confirm')
  @RequirePermission('employees:lifecycle')
  @Doc({ summary: 'Confirm after probation', body: confirmInput })
  confirm(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(confirmInput)) body: z.infer<typeof confirmInput>) {
    return this.employees.confirm(id, body);
  }

  @Post(':id/extend-probation')
  @RequirePermission('employees:lifecycle')
  @Doc({ summary: 'Extend probation', body: extendProbationInput })
  extend(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(extendProbationInput)) body: z.infer<typeof extendProbationInput>) {
    return this.employees.extendProbation(id, body);
  }

  @Post(':id/exit')
  @RequirePermission('employees:lifecycle')
  @Doc({ summary: 'Record a resignation or termination; access ends after the last working day', body: exitInput })
  exit(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(exitInput)) body: z.infer<typeof exitInput>) {
    return this.employees.scheduleExit(id, body);
  }

  @Post(':id/withdraw-exit')
  @RequirePermission('employees:lifecycle')
  @Doc({ summary: 'Withdraw a scheduled exit' })
  withdraw(@Param('id', UuidPipe) id: string) {
    return this.employees.withdrawExit(id);
  }
}
