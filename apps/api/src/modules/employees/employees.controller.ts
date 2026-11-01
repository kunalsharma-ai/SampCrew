import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  confirmInput,
  createEmployeeInput,
  type CreateEmployeeInput,
  designationInput,
  duplicateCheckInput,
  employeeDraftInput,
  employeeExportQuery,
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

  @Get('export.csv')
  @RequirePermission('employees:read')
  @Doc({ summary: 'The directory as CSV with chosen columns (same scope and filters as the list; audited)', query: employeeExportQuery })
  async exportCsv(@Query(new ZodPipe(employeeExportQuery)) q: z.infer<typeof employeeExportQuery>, @Res() res: Response) {
    const f = await this.employees.exportCsv(q);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${f.fileName}"`);
    res.setHeader('cache-control', 'private, no-store');
    res.send(f.content);
  }

  @Post('duplicate-check')
  @HttpCode(200)
  @RequirePermission('employees:create')
  @Doc({ summary: 'Existing records that may be the same person (by email, phone, or name and date of birth)', body: duplicateCheckInput })
  duplicateCheck(@Body(new ZodPipe(duplicateCheckInput)) body: z.infer<typeof duplicateCheckInput>) {
    return this.employees.duplicates(body);
  }

  @Get('drafts')
  @RequirePermission('employees:create')
  @Doc({ summary: 'Your unfinished hires' })
  drafts() {
    return this.employees.drafts();
  }

  @Post('drafts')
  @RequirePermission('employees:create')
  @Doc({ summary: 'Save an unfinished hire to resume later', body: employeeDraftInput })
  createDraft(@Body(new ZodPipe(employeeDraftInput)) body: z.infer<typeof employeeDraftInput>) {
    return this.employees.saveDraft(null, body);
  }

  @Put('drafts/:id')
  @RequirePermission('employees:create')
  @Doc({ summary: 'Update an unfinished hire', body: employeeDraftInput })
  updateDraft(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(employeeDraftInput)) body: z.infer<typeof employeeDraftInput>) {
    return this.employees.saveDraft(id, body);
  }

  @Delete('drafts/:id')
  @HttpCode(204)
  @RequirePermission('employees:create')
  @Doc({ summary: 'Discard an unfinished hire' })
  async deleteDraft(@Param('id', UuidPipe) id: string) {
    await this.employees.deleteDraft(id);
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

  @Get(':id/360')
  @RequirePermission('employees:read')
  @Doc({ summary: 'Employee 360: attendance, leave, pay, performance, learning, recognition, requests and documents at a glance, each only when your access covers it, with an activity timeline' })
  summary360(@Param('id', UuidPipe) id: string) {
    return this.employees.summary360(id);
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
