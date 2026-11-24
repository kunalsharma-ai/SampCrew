import { Body, Controller, Get, Param, Put, Query, Res } from '@nestjs/common';
import {
  attendanceExportQuery,
  attendanceOverviewQuery,
  attendancePeopleQuery,
  attendanceRecordsQuery,
  employeeAttendanceAccessInput,
  hrAttendanceAccessInput,
  CENTRAL_GROUP,
  type AttendanceExportQuery,
  type AttendancePeopleQuery,
  type AttendanceRecordsQuery,
  type HrAttendanceAccessInput,
} from '@crew/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { RequireFeature, RequirePermission } from '../../platform/authz/decorators';
import { sendFile } from '../../platform/export/tabular';
import { contentDisposition } from '../../platform/http/content-disposition';
import { ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { AttendanceAccessService } from './attendance-access.service';
import { AttendanceOverviewService } from './attendance-overview.service';

const groupParam = z.union([z.literal(CENTRAL_GROUP), z.uuid()]);

/**
 * The Attendance overview for Super Workspace, HR Workspace and Employee Workspace, the Excel export and the
 * attendance permissions the Super Workspace sets for each HR Workspace. Each answer holds only the people the caller
 * may see (AttendanceAccessService), whatever the request asks for.
 */
@Controller('attendance')
@RequireFeature('attendance_basic')
export class AttendanceOverviewController {
  constructor(
    private readonly overviews: AttendanceOverviewService,
    private readonly access: AttendanceAccessService,
  ) {}

  @Get('overview')
  @RequirePermission('attendance:read')
  @Doc({ summary: 'What the caller can see about attendance, the summary cards and the daily trend for a period', query: attendanceOverviewQuery })
  overview(@Query(new ZodPipe(attendanceOverviewQuery)) q: z.infer<typeof attendanceOverviewQuery>) {
    return this.overviews.overview(q);
  }

  @Get('overview/hr-workspaces')
  @RequirePermission('attendance:read')
  @Doc({ summary: 'HR Workspace attendance: every HR Workspace the caller may see, with today and period totals', query: attendanceOverviewQuery })
  hrWorkspaces(@Query(new ZodPipe(attendanceOverviewQuery)) q: z.infer<typeof attendanceOverviewQuery>) {
    return this.overviews.hrWorkspaces(q);
  }

  @Get('overview/hr-workspaces/:id')
  @RequirePermission('attendance:read')
  @Doc({ summary: 'One HR Workspace (or "central"): totals, daily trend and each person in it the caller may see', query: attendanceOverviewQuery })
  hrWorkspace(@Param('id', new ZodPipe(groupParam)) id: string, @Query(new ZodPipe(attendanceOverviewQuery)) q: z.infer<typeof attendanceOverviewQuery>) {
    return this.overviews.hrWorkspace(id, q);
  }

  @Get('overview/people')
  @RequirePermission('attendance:read')
  @Doc({ summary: 'Employee Workspace attendance: one row per visible person with period totals (filters, search, pages)', query: attendancePeopleQuery })
  people(@Query(new ZodPipe(attendancePeopleQuery)) q: AttendancePeopleQuery) {
    return this.overviews.peopleList(q);
  }

  @Get('overview/records')
  @RequirePermission('attendance:read')
  @Doc({ summary: 'Date-wise attendance rows for the visible people (Employee Workspace: their own only)', query: attendanceRecordsQuery })
  records(@Query(new ZodPipe(attendanceRecordsQuery)) q: AttendanceRecordsQuery) {
    return this.overviews.records(q);
  }

  @Get('export.xlsx')
  @RequirePermission('attendance:read')
  @Doc({ summary: 'Attendance as an Excel workbook, with the filters applied and only what the caller may see (audited)', query: attendanceExportQuery })
  async export(@Query(new ZodPipe(attendanceExportQuery)) q: AttendanceExportQuery, @Res() res: Response) {
    const file = await this.overviews.export({ ...q, format: 'xlsx' });
    sendFile(res, file as { fileName: string; content: Buffer }, 'xlsx');
  }

  @Get('export')
  @RequirePermission('attendance:read')
  @Doc({ summary: 'Attendance report as Excel, CSV, Word or PDF (format), for everyone visible or chosen employees, with the filters applied (audited)', query: attendanceExportQuery })
  async exportAs(@Query(new ZodPipe(attendanceExportQuery)) q: AttendanceExportQuery, @Res() res: Response) {
    const file = await this.overviews.export(q);
    res.setHeader('content-type', file.contentType);
    res.setHeader('content-disposition', contentDisposition('attachment', file.fileName));
    res.setHeader('cache-control', 'private, no-store');
    res.send(file.content);
  }

  @Get('access')
  @RequirePermission('hierarchy:manage')
  @Doc({ summary: 'Attendance permissions of each HR Workspace and of Employee Workspace (Super Workspace)' })
  settings() {
    return this.access.settings();
  }

  @Put('access/hr-workspace')
  @RequirePermission('hierarchy:manage')
  @Doc({ summary: 'Set the attendance permissions of one HR Workspace, or "central" for company-wide HR (Super Workspace)', body: hrAttendanceAccessInput })
  saveHr(@Body(new ZodPipe(hrAttendanceAccessInput)) body: HrAttendanceAccessInput) {
    return this.access.saveHr(body);
  }

  @Put('access/employee-workspace')
  @RequirePermission('hierarchy:manage')
  @Doc({ summary: 'Set the attendance permissions of every Employee Workspace (Super Workspace)', body: employeeAttendanceAccessInput })
  saveEmployee(@Body(new ZodPipe(employeeAttendanceAccessInput)) body: z.infer<typeof employeeAttendanceAccessInput>) {
    return this.access.saveEmployee(body.permissions);
  }
}
