import { Body, Controller, Delete, Get, Param, Post, Put, Query, Res } from '@nestjs/common';
import {
  attendanceNoticePrefsInput,
  isoDate,
  newOfficeInput,
  officeGeofenceInput,
  savedReportInput,
  workAssignmentInput,
  workforceDashboardQuery,
  workforcePeopleQuery,
  workModeCheckpointInput,
  workModeOverrideInput,
  workModeSettingsInput,
  workRegisterQuery,
  workReportQuery,
  workSiteInput,
  type WorkAssignmentInput,
  type WorkModeSettingsInput,
  type WorkReportQuery,
  type WorkSiteInput,
} from '@crew/contracts';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { RequireFeature, RequirePermission } from '../../platform/authz/decorators';
import { contentDisposition } from '../../platform/http/content-disposition';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { WorkModeService } from './work-mode.service';
import { WorkforceService } from './workforce.service';

const assignmentsQuery = z.object({ placeId: z.uuid().optional(), q: z.string().trim().max(120).optional() });

/**
 * Work From Office / Work From Home / hybrid attendance: the rules and labels, office geofences, approved sites and who
 * works where, the location update and day detail behind each classification, HR verification, notice choices, the
 * Super Workspace and HR Workspace dashboards, the register and the 8-sheet report. Every answer is limited to the people
 * the caller may see (AttendanceAccessService); HR Workspace totals may count the whole organisation (attendance.org_totals).
 */
@Controller('attendance/work-mode')
@RequireFeature('attendance_basic')
export class WorkModeController {
  constructor(
    private readonly workMode: WorkModeService,
    private readonly workforce: WorkforceService,
  ) {}

  // ------------------------------------------------------------------------------------------------ rules and labels

  @Get('settings')
  @RequirePermission('attendance:read')
  @Doc({ summary: 'Work-mode rules and the names shown for office, home and hybrid attendance' })
  settings() {
    return this.workMode.settingsView();
  }

  @Put('settings')
  @RequirePermission('attendance:configure')
  @Doc({ summary: 'Save the work-mode rules; only the Super Workspace can rename the three attendance names (audited)', body: workModeSettingsInput })
  saveSettings(@Body(new ZodPipe(workModeSettingsInput)) body: WorkModeSettingsInput) {
    return this.workMode.saveSettings(body);
  }

  @Get('labels')
  @RequirePermission('attendance:read')
  @Doc({ summary: 'The names shown for office, home and hybrid attendance' })
  labels() {
    return this.workMode.labels();
  }

  // ------------------------------------------------------------------------------------------------ places

  @Get('places')
  @RequirePermission('attendance:read')
  @Doc({ summary: 'Offices with their geofence, approved work sites and how many people each covers' })
  places() {
    return this.workMode.places();
  }

  @Post('offices')
  @RequirePermission('attendance:configure')
  @Doc({ summary: 'Add an office with its address and geofence (audited)', body: newOfficeInput })
  createOffice(@Body(new ZodPipe(newOfficeInput)) body: z.infer<typeof newOfficeInput>) {
    return this.workMode.createOffice(body);
  }

  @Put('offices/:id')
  @RequirePermission('attendance:configure')
  @Doc({ summary: 'Set an office geofence: latitude, longitude, radius and whether it is used (audited)', body: officeGeofenceInput })
  saveOffice(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(officeGeofenceInput)) body: z.infer<typeof officeGeofenceInput>) {
    return this.workMode.saveOfficeGeofence(id, body);
  }

  @Post('sites')
  @RequirePermission('attendance:configure')
  @Doc({ summary: 'Add an approved work site (client site, branch, event) and whether it counts as office or remote', body: workSiteInput })
  createSite(@Body(new ZodPipe(workSiteInput)) body: WorkSiteInput) {
    return this.workMode.saveSite(null, body);
  }

  @Put('sites/:id')
  @RequirePermission('attendance:configure')
  @Doc({ summary: 'Change an approved work site', body: workSiteInput })
  saveSite(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(workSiteInput)) body: WorkSiteInput) {
    return this.workMode.saveSite(id, body);
  }

  @Delete('sites/:id')
  @RequirePermission('attendance:configure')
  @Doc({ summary: 'Archive an approved work site; past days keep its name' })
  archiveSite(@Param('id', UuidPipe) id: string) {
    return this.workMode.archiveSite(id);
  }

  @Get('assignments')
  @RequirePermission('attendance:read')
  @Doc({ summary: 'Which offices and sites each visible person may work from, and their own office rule', query: assignmentsQuery })
  assignments(@Query(new ZodPipe(assignmentsQuery)) q: z.infer<typeof assignmentsQuery>) {
    return this.workMode.assignments(q);
  }

  @Put('assignments')
  @RequirePermission('attendance:configure')
  @Doc({ summary: 'Add, set or remove the offices and sites of chosen people, or set their office rule (audited)', body: workAssignmentInput })
  saveAssignments(@Body(new ZodPipe(workAssignmentInput)) body: WorkAssignmentInput) {
    return this.workMode.saveAssignments(body);
  }

  // ------------------------------------------------------------------------------------------------ days

  @Post('checkpoint')
  @RequirePermission('attendance:punch')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Doc({ summary: 'Share where you are now during an open day, so the office and home split is exact (read once, never tracked)', body: workModeCheckpointInput })
  checkpoint(@Body(new ZodPipe(workModeCheckpointInput)) body: z.infer<typeof workModeCheckpointInput>) {
    return this.workMode.checkpoint(body);
  }

  @Get('days/:employeeId/:date')
  @RequirePermission('attendance:read')
  @Doc({ summary: 'One day in full: classification, the place of each punch, location updates and every change' })
  day(@Param('employeeId', UuidPipe) employeeId: string, @Param('date', new ZodPipe(isoDate)) date: string) {
    return this.workMode.dayDetail(employeeId, date);
  }

  @Post('override')
  @RequirePermission('attendance:approve')
  @Doc({ summary: 'Verify or correct the office, home or hybrid classification of a day, with a reason (audited; not your own)', body: workModeOverrideInput })
  override(@Body(new ZodPipe(workModeOverrideInput)) body: z.infer<typeof workModeOverrideInput>) {
    return this.workMode.override(body);
  }

  // ------------------------------------------------------------------------------------------------ notices

  @Get('notices')
  @RequirePermission('attendance:read')
  @Doc({ summary: 'Which attendance notices you get' })
  notices() {
    return this.workMode.noticesView();
  }

  @Put('notices')
  @RequirePermission('attendance:read')
  @Doc({ summary: 'Choose which attendance notices you get', body: attendanceNoticePrefsInput })
  saveNotices(@Body(new ZodPipe(attendanceNoticePrefsInput)) body: Record<string, boolean>) {
    return this.workMode.saveNotices(body);
  }

  // ------------------------------------------------------------------------------------------------ workforce

  @Get('dashboard')
  @RequirePermission('attendance:read')
  @Doc({ summary: 'Workforce visibility: present, office, home, hybrid, not checked in, on leave, incomplete and irregular, with breakdowns and trend', query: workforceDashboardQuery })
  dashboard(@Query(new ZodPipe(workforceDashboardQuery)) q: z.infer<typeof workforceDashboardQuery>) {
    return this.workforce.dashboard(q);
  }

  @Get('people')
  @RequirePermission('attendance:read')
  @Doc({ summary: 'The people behind one dashboard card on a date (only people the caller may see)', query: workforcePeopleQuery })
  people(@Query(new ZodPipe(workforcePeopleQuery)) q: z.infer<typeof workforcePeopleQuery>) {
    return this.workforce.peopleList(q);
  }

  @Get('register')
  @RequirePermission('attendance:read')
  @Doc({ summary: 'Work-mode register: one row per person and day with office and home hours, places and issues', query: workRegisterQuery })
  register(@Query(new ZodPipe(workRegisterQuery)) q: z.infer<typeof workRegisterQuery>) {
    return this.workforce.register(q);
  }

  @Get('report')
  @RequirePermission('attendance:read')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Doc({ summary: 'Attendance report: 8-sheet Excel workbook or CSV, every record matching the filters (audited)', query: workReportQuery })
  async report(@Query(new ZodPipe(workReportQuery)) q: WorkReportQuery, @Res() res: Response) {
    const file = await this.workforce.report(q);
    res.setHeader('content-type', file.contentType);
    res.setHeader('content-disposition', contentDisposition('attachment', file.fileName));
    res.setHeader('cache-control', 'private, no-store');
    res.setHeader('x-report-rows', String(file.rows));
    res.send(file.content);
  }

  @Get('saved-reports')
  @RequirePermission('attendance:read')
  @Doc({ summary: 'Your saved attendance filters' })
  savedReports() {
    return this.workforce.savedReports();
  }

  @Post('saved-reports')
  @RequirePermission('attendance:read')
  @Doc({ summary: 'Save the current attendance filters under a name (same name replaces)', body: savedReportInput })
  saveReport(@Body(new ZodPipe(savedReportInput)) body: z.infer<typeof savedReportInput>) {
    return this.workforce.saveReport(body);
  }

  @Delete('saved-reports/:id')
  @RequirePermission('attendance:read')
  @Doc({ summary: 'Delete one of your saved attendance filters' })
  deleteReport(@Param('id', UuidPipe) id: string) {
    return this.workforce.deleteReport(id);
  }
}
