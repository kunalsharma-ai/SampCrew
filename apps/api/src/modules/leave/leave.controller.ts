import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import {
  holidayCalendarInput,
  holidayInput,
  isoDate,
  leaveAdjustmentInput,
  leaveCancelInput,
  leavePolicyInput,
  leaveRequestInput,
  type LeaveRequestInput,
  leaveRunInput,
  leaveTypeInput,
  yearEndInput,
} from '@crew/contracts';
import { z } from 'zod';
import { RequirePermission } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { LeaveService } from './leave.service';

const typePatch = leaveTypeInput.partial();
const balanceQuery = z.object({ employeeId: z.uuid().optional(), year: z.coerce.number().int().min(2000).max(2200).optional() });
const ledgerQuery = z.object({ employeeId: z.uuid(), leaveTypeId: z.uuid(), year: z.coerce.number().int().min(2000).max(2200) });
const requestQuery = z.object({
  scope: z.enum(['mine', 'visible']).optional(),
  employeeId: z.uuid().optional(),
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
const rangeQuery = z.object({ from: isoDate, to: isoDate }).refine((v) => v.to >= v.from, { message: 'to is before from', path: ['to'] });

@Controller('leave')
export class LeaveController {
  constructor(private readonly leave: LeaveService) {}

  @Get('types')
  @RequirePermission('leave:read')
  @Doc({ summary: 'Leave types' })
  types(@Query(new ZodPipe(z.object({ includeArchived: z.enum(['true', 'false']).optional() }))) q: { includeArchived?: string }) {
    return this.leave.listTypes(q.includeArchived === 'true');
  }

  @Post('types')
  @RequirePermission('leave:configure')
  @Doc({ summary: 'Create a leave type', body: leaveTypeInput })
  createType(@Body(new ZodPipe(leaveTypeInput)) body: z.infer<typeof leaveTypeInput>) {
    return this.leave.createType(body);
  }

  @Patch('types/:id')
  @RequirePermission('leave:configure')
  @Doc({ summary: 'Update a leave type', body: typePatch })
  updateType(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(typePatch)) body: z.infer<typeof typePatch>) {
    return this.leave.updateType(id, body);
  }

  @Delete('types/:id')
  @RequirePermission('leave:configure')
  @HttpCode(204)
  @Doc({ summary: 'Archive a leave type and deactivate its policies (history is kept)' })
  async archiveType(@Param('id', UuidPipe) id: string) {
    await this.leave.archiveType(id);
  }

  @Get('policies')
  @RequirePermission('leave:read')
  @Doc({ summary: 'Active leave policies' })
  policies() {
    return this.leave.listPolicies();
  }

  @Post('policies')
  @RequirePermission('leave:configure')
  @Doc({ summary: 'Save the policy for a leave type and legal entity (replaces the active one)', body: leavePolicyInput })
  setPolicy(@Body(new ZodPipe(leavePolicyInput)) body: z.infer<typeof leavePolicyInput>) {
    return this.leave.setPolicy(body);
  }

  @Delete('policies/:id')
  @RequirePermission('leave:configure')
  @HttpCode(204)
  @Doc({ summary: 'Deactivate a leave policy' })
  async removePolicy(@Param('id', UuidPipe) id: string) {
    await this.leave.removePolicy(id);
  }

  @Get('calendars')
  @RequirePermission('leave:read')
  @Doc({ summary: 'Holiday calendars with their holidays' })
  calendars() {
    return this.leave.listCalendars();
  }

  @Post('calendars')
  @RequirePermission('leave:configure')
  @Doc({ summary: 'Create a holiday calendar', body: holidayCalendarInput })
  createCalendar(@Body(new ZodPipe(holidayCalendarInput)) body: z.infer<typeof holidayCalendarInput>) {
    return this.leave.saveCalendar(null, body);
  }

  @Put('calendars/:id')
  @RequirePermission('leave:configure')
  @Doc({ summary: 'Update a holiday calendar', body: holidayCalendarInput })
  updateCalendar(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(holidayCalendarInput)) body: z.infer<typeof holidayCalendarInput>) {
    return this.leave.saveCalendar(id, body);
  }

  @Delete('calendars/:id')
  @RequirePermission('leave:configure')
  @HttpCode(204)
  @Doc({ summary: 'Delete a holiday calendar' })
  async deleteCalendar(@Param('id', UuidPipe) id: string) {
    await this.leave.deleteCalendar(id);
  }

  @Post('calendars/:id/holidays')
  @RequirePermission('leave:configure')
  @Doc({ summary: 'Add a holiday', body: holidayInput })
  addHoliday(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(holidayInput)) body: z.infer<typeof holidayInput>) {
    return this.leave.addHoliday(id, body);
  }

  @Delete('calendars/:id/holidays/:holidayId')
  @RequirePermission('leave:configure')
  @HttpCode(204)
  @Doc({ summary: 'Remove a holiday' })
  async removeHoliday(@Param('id', UuidPipe) id: string, @Param('holidayId', UuidPipe) holidayId: string) {
    await this.leave.removeHoliday(id, holidayId);
  }

  @Get('balances')
  @RequirePermission('leave:read')
  @Doc({ summary: 'Leave balances for a year (yours when employeeId is omitted)', query: balanceQuery })
  balances(@Query(new ZodPipe(balanceQuery)) q: z.infer<typeof balanceQuery>) {
    return this.leave.balances(q.employeeId, q.year);
  }

  @Get('ledger')
  @RequirePermission('leave:read')
  @Doc({ summary: 'Ledger lines behind one balance', query: ledgerQuery })
  ledger(@Query(new ZodPipe(ledgerQuery)) q: z.infer<typeof ledgerQuery>) {
    return this.leave.ledger(q.employeeId, q.leaveTypeId, q.year);
  }

  @Post('requests/preview')
  @Doc({ summary: 'Working days and balance impact of a draft request (nothing is saved)', body: leaveRequestInput })
  preview(@Body(new ZodPipe(leaveRequestInput)) body: LeaveRequestInput) {
    return this.leave.preview(body);
  }

  @Post('requests')
  @Doc({ summary: 'Apply for leave (for yourself, or on behalf of someone you approve leave for)', body: leaveRequestInput })
  request(@Body(new ZodPipe(leaveRequestInput)) body: LeaveRequestInput) {
    return this.leave.request(body);
  }

  @Get('requests')
  @RequirePermission('leave:read')
  @Doc({ summary: 'Leave requests: yours by default, or every request you can see with scope=visible', query: requestQuery })
  list(@Query(new ZodPipe(requestQuery)) q: z.infer<typeof requestQuery>) {
    return this.leave.listRequests(q);
  }

  @Get('requests/:id')
  @RequirePermission('leave:read')
  @Doc({ summary: 'One leave request with its approval trail' })
  get(@Param('id', UuidPipe) id: string) {
    return this.leave.getRequest(id);
  }

  @Post('requests/:id/cancel')
  @Doc({ summary: 'Cancel a pending or approved request (approved days are returned to the balance)', body: leaveCancelInput })
  cancel(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(leaveCancelInput)) body: z.infer<typeof leaveCancelInput>) {
    return this.leave.cancel(id, body.reason);
  }

  @Get('away')
  @RequirePermission('leave:read')
  @Doc({ summary: 'Who is on (or has requested) leave in a date range', query: rangeQuery })
  away(@Query(new ZodPipe(rangeQuery)) q: z.infer<typeof rangeQuery>) {
    return this.leave.whoIsAway(q.from, q.to);
  }

  @Post('adjustments')
  @RequirePermission('leave:approve')
  @Doc({ summary: 'Add or deduct days with a note (recorded as a ledger adjustment)', body: leaveAdjustmentInput })
  adjust(@Body(new ZodPipe(leaveAdjustmentInput)) body: z.infer<typeof leaveAdjustmentInput>) {
    return this.leave.adjust(body);
  }

  @Post('accruals/run')
  @RequirePermission('leave:configure')
  @Doc({ summary: 'Post accruals due up to a date now (also runs automatically every hour; never double-credits)', body: leaveRunInput })
  run(@Body(new ZodPipe(leaveRunInput)) body: z.infer<typeof leaveRunInput>) {
    return this.leave.runAccrualsNow(body.asOf);
  }

  @Post('year-end')
  @RequirePermission('leave:configure')
  @Doc({ summary: 'Close a past leave year: carry forward up to each cap, lapse the rest', body: yearEndInput })
  yearEnd(@Body(new ZodPipe(yearEndInput)) body: z.infer<typeof yearEndInput>) {
    return this.leave.closeYear(body.year);
  }
}
