import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, UploadedFile as File, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  COMM_FILE_MAX_BYTES,
  holidayCalendarInput,
  holidayInput,
  isoDate,
  leaveAdjustmentInput,
  leaveAdjustmentsQuery,
  leaveBalanceOverviewQuery,
  leaveCancelInput,
  leaveHistoryQuery,
  leaveModifyInput,
  type LeaveModifyInput,
  leaveReportQuery,
  leaveRequestInput,
  type LeaveRequestInput,
  leaveQuantityInput,
  type LeaveQuantityInput,
  leaveTypeInput,
  type LeaveTypeInput,
  leaveTypeSimpleInput,
  leaveTypeStatusInput,
  leaveTypeUpdate,
  type LeaveTypeUpdate,
  type LeaveTypeSimpleInput,
  leaveVisibilityInput,
} from '@crew/contracts';
import { z } from 'zod';
import { RequireFeature, RequirePermission } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import type { UploadedFile } from '../documents/documents.service';
import { LeaveService } from './leave.service';

const balanceQuery = z.object({ employeeId: z.uuid().optional(), year: z.coerce.number().int().min(2000).max(2200).optional() });
const yearQuery = z.object({ year: z.coerce.number().int().min(2000).max(2200).optional() });
const ledgerQuery = z.object({ employeeId: z.uuid(), leaveTypeId: z.uuid(), year: z.coerce.number().int().min(2000).max(2200) });
const typesQuery = z.object({ includeArchived: z.enum(['true', 'false']).optional() });
/** The simple form, or the full settings (Super Workspace); the simple form may name the HR Workspace it is for. */
const createTypeBody = z.union([leaveTypeSimpleInput.extend({ hrWorkspaceId: z.uuid().nullable().optional() }).strict(), leaveTypeInput]);
const quantitiesQuery = z.object({
  year: z.coerce.number().int().min(2000).max(2200).optional(), leaveTypeId: z.uuid().optional(),
  hrWorkspaceId: z.union([z.literal('central'), z.uuid()]).optional(), q: z.string().trim().max(100).optional(),
});
const requestQuery = z.object({
  scope: z.enum(['mine', 'visible', 'review']).optional(),
  employeeId: z.uuid().optional(),
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  leaveTypeId: z.uuid().optional(),
  hrWorkspaceId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
const rangeQuery = z.object({ from: isoDate, to: isoDate }).refine((v) => v.to >= v.from, { message: 'to is before from', path: ['to'] });

@Controller('leave')
export class LeaveController {
  constructor(private readonly leave: LeaveService) {}

  // Leave types (Super Workspace) ------------------------------------------------------------------------

  @Get('types')
  @RequireFeature('leave')
  @RequirePermission('leave:read')
  @Doc({ summary: 'Leave types you can see: all (Super Workspace), those available to your HR Workspace, or those you hold', query: typesQuery })
  types(@Query(new ZodPipe(typesQuery)) q: z.infer<typeof typesQuery>) {
    return this.leave.listTypes(q.includeArchived === 'true');
  }

  @Get('types/:id')
  @RequireFeature('leave')
  @RequirePermission('leave:read')
  @Doc({ summary: 'One leave type with its policy, approval rules, allocations, creator and change history' })
  type(@Param('id', UuidPipe) id: string) {
    return this.leave.getType(id);
  }

  @Post('types')
  @RequireFeature('leave')
  @RequirePermission('leavetypes:create')
  @Doc({ summary: 'Create New Leave Type: name, description, optional code, visibility (HR Workspace, Employee Workspace or both) and status. An HR Workspace only when the Super Workspace allows it', body: createTypeBody })
  createType(@Body(new ZodPipe(createTypeBody)) body: LeaveTypeInput | (LeaveTypeSimpleInput & { hrWorkspaceId?: string | null })) {
    return this.leave.createType(body);
  }

  @Put('types/:id/visibility')
  @RequireFeature('leave')
  @RequirePermission('leavetypes:visibility')
  @Doc({ summary: 'Choose where a leave type appears: HR Workspace, Employee Workspace or both (applications already made stay)', body: leaveVisibilityInput })
  setVisibility(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(leaveVisibilityInput)) body: z.infer<typeof leaveVisibilityInput>) {
    return this.leave.setVisibility(id, body.visibility);
  }

  @Patch('types/:id')
  @RequireFeature('leave')
  @RequirePermission('leavetypes:edit')
  @Doc({ summary: 'Change a leave type (applies to new applications; refused when made on an older version)', body: leaveTypeUpdate })
  updateType(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(leaveTypeUpdate)) body: LeaveTypeUpdate) {
    return this.leave.updateType(id, body);
  }

  @Post('types/:id/status')
  @RequireFeature('leave')
  @RequirePermission('leavetypes:disable')
  @Doc({ summary: 'Deactivate or reactivate a leave type, with a reason (records and balances are kept)', body: leaveTypeStatusInput })
  setTypeStatus(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(leaveTypeStatusInput)) body: z.infer<typeof leaveTypeStatusInput>) {
    return this.leave.setTypeStatus(id, body.active, body.reason);
  }

  @Delete('types/:id')
  @RequireFeature('leave')
  @RequirePermission('leave:configure')
  @HttpCode(204)
  @Doc({ summary: 'Remove a leave type that was never used (a used type can only be deactivated)' })
  async deleteType(@Param('id', UuidPipe) id: string) {
    await this.leave.deleteType(id);
  }

  @Get('history')
  @RequireFeature('leave')
  @RequirePermission('leave:allocate')
  @Doc({ summary: 'Who created, changed, deactivated or allocated leave types, and when', query: leaveHistoryQuery })
  history(@Query(new ZodPipe(leaveHistoryQuery)) q: z.infer<typeof leaveHistoryQuery>) {
    return this.leave.history(q);
  }

  // Allocation (Super Workspace and HR Workspace) --------------------------------------------------------

  @Get('options')
  @RequireFeature('leave')
  @RequirePermission('leave:allocate')
  @Doc({ summary: 'What leave management chooses from, within your scope: departments, designations, locations, legal entities, groups, HR Workspaces, Super Workspace administrators and people' })
  options() {
    return this.leave.options();
  }

  // Manual leave quantities -----------------------------------------------------------------------------

  @Get('quantities')
  @RequireFeature('leave')
  @RequirePermission('leave:assign')
  @Doc({ summary: 'Assign Leave Quantities: people in your scope with the quantity entered by hand for each leave type they can apply for (null: Not Assigned)', query: quantitiesQuery })
  quantities(@Query(new ZodPipe(quantitiesQuery)) q: z.infer<typeof quantitiesQuery>) {
    return this.leave.quantities(q);
  }

  @Put('quantities')
  @RequireFeature('leave')
  @RequirePermission('leave:assign')
  @Doc({ summary: 'Set the quantity of a leave type an employee has for a year (typed by hand; nothing is ever calculated)', body: leaveQuantityInput })
  assignQuantity(@Body(new ZodPipe(leaveQuantityInput)) body: LeaveQuantityInput) {
    return this.leave.assignQuantity(body);
  }

  // Dashboards and reports -------------------------------------------------------------------------------

  @Get('dashboard')
  @RequireFeature('leave')
  @RequirePermission('leave:allocate')
  @Doc({ summary: 'Leave dashboard for the Super Workspace or an HR Workspace, within your scope', query: leaveReportQuery })
  dashboard(@Query(new ZodPipe(leaveReportQuery)) q: z.infer<typeof leaveReportQuery>) {
    return this.leave.dashboard(q);
  }

  @Get('reports')
  @RequireFeature('leave')
  @RequirePermission('leave:allocate')
  @Doc({ summary: 'Leave usage per person and type for a year, within your scope', query: leaveReportQuery })
  report(@Query(new ZodPipe(leaveReportQuery)) q: z.infer<typeof leaveReportQuery>) {
    return this.leave.report(q);
  }

  @Get('mine')
  @RequireFeature('leave')
  @RequirePermission('leave:read')
  @Doc({ summary: 'Your leave dashboard: the types you hold with their rules, balances, upcoming and pending leave', query: yearQuery })
  mine(@Query(new ZodPipe(yearQuery)) q: z.infer<typeof yearQuery>) {
    return this.leave.mine(q.year);
  }

  // Documents --------------------------------------------------------------------------------------------

  @Post('documents')
  @RequireFeature('leave')
  @RequirePermission('leave:request')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: COMM_FILE_MAX_BYTES, files: 1 } }))
  @Doc({ summary: 'Upload a supporting document for a leave application (multipart/form-data: file). Up to 10 MB.' })
  uploadDocument(@File() file?: UploadedFile) {
    return this.leave.uploadDocument(file);
  }

  @Post('requests/:id/documents/:fileId/link')
  @RequireFeature('leave')
  @RequirePermission('leave:read')
  @Doc({ summary: 'A short-lived download link for a document on a leave request you can see' })
  documentLink(@Param('id', UuidPipe) id: string, @Param('fileId', UuidPipe) fileId: string) {
    return this.leave.documentLink(id, fileId);
  }

  @Post('escalations/run')
  @RequireFeature('leave')
  @RequirePermission('leave:configure')
  @Doc({ summary: 'Escalate overdue leave approvals now (also runs automatically every hour)' })
  escalate() {
    return this.leave.escalateNow();
  }

  @Get('calendars')
  @RequirePermission('leave:read')
  @Doc({ summary: 'Holiday calendars with their holidays' })
  calendars() {
    return this.leave.listCalendars();
  }

  @Post('calendars')
  @RequirePermission('leave:allocate')
  @Doc({ summary: 'Create a holiday calendar', body: holidayCalendarInput })
  createCalendar(@Body(new ZodPipe(holidayCalendarInput)) body: z.infer<typeof holidayCalendarInput>) {
    return this.leave.saveCalendar(null, body);
  }

  @Put('calendars/:id')
  @RequirePermission('leave:allocate')
  @Doc({ summary: 'Update a holiday calendar', body: holidayCalendarInput })
  updateCalendar(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(holidayCalendarInput)) body: z.infer<typeof holidayCalendarInput>) {
    return this.leave.saveCalendar(id, body);
  }

  @Delete('calendars/:id')
  @RequirePermission('leave:allocate')
  @HttpCode(204)
  @Doc({ summary: 'Delete a holiday calendar' })
  async deleteCalendar(@Param('id', UuidPipe) id: string) {
    await this.leave.deleteCalendar(id);
  }

  @Post('calendars/:id/holidays')
  @RequirePermission('leave:allocate')
  @Doc({ summary: 'Add a holiday', body: holidayInput })
  addHoliday(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(holidayInput)) body: z.infer<typeof holidayInput>) {
    return this.leave.addHoliday(id, body);
  }

  @Delete('calendars/:id/holidays/:holidayId')
  @RequirePermission('leave:allocate')
  @HttpCode(204)
  @Doc({ summary: 'Remove a holiday' })
  async removeHoliday(@Param('id', UuidPipe) id: string, @Param('holidayId', UuidPipe) holidayId: string) {
    await this.leave.removeHoliday(id, holidayId);
  }

  @Get('balances')
  @RequireFeature('leave')
  @RequirePermission('leave:read')
  @Doc({ summary: 'Leave balances for a year (yours when employeeId is omitted)', query: balanceQuery })
  balances(@Query(new ZodPipe(balanceQuery)) q: z.infer<typeof balanceQuery>) {
    return this.leave.balances(q.employeeId, q.year);
  }

  @Get('balances/overview')
  @RequireFeature('leave')
  @RequirePermission('leave:read')
  @Doc({ summary: 'Balances of everyone you can see, per leave type, for a year (HR and managers)', query: leaveBalanceOverviewQuery })
  overview(@Query(new ZodPipe(leaveBalanceOverviewQuery)) q: z.infer<typeof leaveBalanceOverviewQuery>) {
    return this.leave.balanceOverview(q);
  }

  @Get('ledger')
  @RequireFeature('leave')
  @RequirePermission('leave:read')
  @Doc({ summary: 'Ledger lines behind one balance', query: ledgerQuery })
  ledger(@Query(new ZodPipe(ledgerQuery)) q: z.infer<typeof ledgerQuery>) {
    return this.leave.ledger(q.employeeId, q.leaveTypeId, q.year);
  }

  @Post('requests/preview')
  @RequireFeature('leave')
  @Doc({ summary: 'Working days and balance impact of a draft request (nothing is saved)', body: leaveRequestInput })
  preview(@Body(new ZodPipe(leaveRequestInput)) body: LeaveRequestInput) {
    return this.leave.preview(body);
  }

  @Post('requests')
  @RequireFeature('leave')
  @Doc({ summary: 'Apply for leave (for yourself, or on behalf of someone you approve leave for)', body: leaveRequestInput })
  request(@Body(new ZodPipe(leaveRequestInput)) body: LeaveRequestInput) {
    return this.leave.request(body);
  }

  @Get('requests')
  @RequireFeature('leave')
  @RequirePermission('leave:read')
  @Doc({ summary: 'Leave requests: yours by default, every request you can see with scope=visible, or those waiting on you with scope=review', query: requestQuery })
  list(@Query(new ZodPipe(requestQuery)) q: z.infer<typeof requestQuery>) {
    return this.leave.listRequests(q);
  }

  @Get('requests/:id')
  @RequireFeature('leave')
  @RequirePermission('leave:read')
  @Doc({ summary: 'One leave request with its approval trail' })
  get(@Param('id', UuidPipe) id: string) {
    return this.leave.getRequest(id);
  }

  @Post('requests/:id/cancel')
  @RequireFeature('leave')
  @Doc({ summary: 'Cancel a pending or approved request (approved days are returned to the balance)', body: leaveCancelInput })
  cancel(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(leaveCancelInput)) body: z.infer<typeof leaveCancelInput>) {
    return this.leave.cancel(id, body.reason);
  }

  @Post('requests/:id/modify/preview')
  @RequireFeature('leave')
  @Doc({ summary: 'Working days and balance impact of a change to a request (nothing is saved)', body: leaveModifyInput })
  previewModify(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(leaveModifyInput)) body: LeaveModifyInput) {
    return this.leave.previewModify(id, body);
  }

  @Post('requests/:id/modify')
  @RequireFeature('leave')
  @Doc({ summary: 'Change a request: a pending one is changed and its approval restarts; a change to approved leave is approved on its own and then replaces it', body: leaveModifyInput })
  modify(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(leaveModifyInput)) body: LeaveModifyInput) {
    return this.leave.modify(id, body);
  }

  @Get('calendar')
  @RequireFeature('leave')
  @RequirePermission('leave:read')
  @Doc({ summary: 'My leave calendar for a date range: working week, public holidays, and my pending and approved leave', query: rangeQuery })
  calendar(@Query(new ZodPipe(rangeQuery)) q: z.infer<typeof rangeQuery>) {
    return this.leave.myCalendar(q.from, q.to);
  }

  @Get('away')
  @RequireFeature('leave')
  @RequirePermission('leave:read')
  @Doc({ summary: 'Who is on (or has requested) leave in a date range', query: rangeQuery })
  away(@Query(new ZodPipe(rangeQuery)) q: z.infer<typeof rangeQuery>) {
    return this.leave.whoIsAway(q.from, q.to);
  }

  @Get('adjustments')
  @RequireFeature('leave')
  @RequirePermission('leave:read')
  @Doc({ summary: 'History of balance adjustments with their remarks, for the people you can see', query: leaveAdjustmentsQuery })
  adjustments(@Query(new ZodPipe(leaveAdjustmentsQuery)) q: z.infer<typeof leaveAdjustmentsQuery>) {
    return this.leave.adjustments(q);
  }

  @Post('adjustments')
  @RequireFeature('leave')
  @RequirePermission('leave:approve')
  @Doc({ summary: 'Add or deduct days with a note (recorded as a ledger adjustment)', body: leaveAdjustmentInput })
  adjust(@Body(new ZodPipe(leaveAdjustmentInput)) body: z.infer<typeof leaveAdjustmentInput>) {
    return this.leave.adjust(body);
  }
}
