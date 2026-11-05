import { Body, Controller, Delete, Get, Header, Headers, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import {
  attendancePolicyInput,
  type AttendancePolicyInput,
  correctionInput,
  type CorrectionInput,
  deviceInput,
  type DeviceInput,
  deviceMappingInput,
  isoDate,
  kioskInput,
  overtimeClaimInput,
  periodLockInput,
  punchInput,
  type PunchInput,
  qrPunchInput,
  rosterInput,
  shiftAssignmentsInput,
  shiftTemplateInput,
  type ShiftTemplateInput,
  simulateInput,
  swapRequestInput,
  DAY_STATUSES,
} from '@crew/contracts';
import { z } from 'zod';
import { Public, RequireFeature, RequirePermission, RootPath } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { AttendanceService } from './attendance.service';
import { DevicesService } from './devices.service';
import { ShiftsService } from './shifts.service';

const range = z
  .object({ employeeId: z.uuid().optional(), from: isoDate, to: isoDate })
  .refine((v) => v.to >= v.from, { message: 'to is before from', path: ['to'] })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 62, { message: 'Ask for at most 63 days at a time', path: ['to'] });
const teamQuery = z.object({ date: isoDate, status: z.enum(DAY_STATUSES).optional(), departmentId: z.uuid().optional(), locationId: z.uuid().optional() });
const listQuery = z.object({ scope: z.enum(['mine', 'visible']).default('mine'), status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional() });
const unlockInput = z.object({ reason: z.string().trim().min(3).max(300) });
const dateQuery = z.object({ date: isoDate });
const archivedQuery = z.object({ includeArchived: z.enum(['true', 'false']).optional() });
const devicePatch = deviceInput.partial().omit({ serialNumber: true, vendor: true, simulated: true });

@Controller('attendance')
@RequireFeature('attendance_basic')
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Post('punch')
  @RequirePermission('attendance:punch')
  @Doc({ summary: 'Punch in or out from the web or mobile app', description: 'Idempotent on clientEventId. Applies the location geofence and attendance policy.', body: punchInput })
  punch(@Body(new ZodPipe(punchInput)) body: PunchInput) {
    return this.attendance.punch(body);
  }

  @Post('qr-punch')
  @RequirePermission('attendance:punch')
  @Doc({ summary: 'Punch by scanning the rotating QR code on a site kiosk', body: qrPunchInput })
  qrPunch(@Body(new ZodPipe(qrPunchInput)) body: z.infer<typeof qrPunchInput>) {
    return this.attendance.qrPunch(body.code, body.direction);
  }

  @Get('today')
  @RequirePermission('attendance:read')
  @Doc({ summary: 'My attendance today: shift, punches, status and what I can do next' })
  today() {
    return this.attendance.today();
  }

  @Get('days')
  @RequirePermission('attendance:read')
  @Doc({ summary: 'Attendance days for me or an employee in a date range, with a summary', query: range })
  days(@Query(new ZodPipe(range)) q: z.infer<typeof range>) {
    return this.attendance.employeeDays(q.employeeId, q.from, q.to);
  }

  @Get('days/:employeeId/:date')
  @RequirePermission('attendance:read')
  @Doc({ summary: 'One day in detail: the computed result, its explanation and every raw punch' })
  day(@Param('employeeId', UuidPipe) employeeId: string, @Param('date', new ZodPipe(isoDate)) date: string) {
    return this.attendance.dayDetail(employeeId, date);
  }

  @Get('team')
  @RequirePermission('attendance:read')
  @Doc({ summary: 'Attendance of everyone I can see on a date, with counts by status', query: teamQuery })
  team(@Query(new ZodPipe(teamQuery)) q: z.infer<typeof teamQuery>) {
    return this.attendance.team(q);
  }

  @Post('corrections')
  @RequirePermission('attendance:correct')
  @Doc({ summary: 'Ask for missing punches to be added to a day (goes for approval)', body: correctionInput })
  correct(@Body(new ZodPipe(correctionInput)) body: CorrectionInput) {
    return this.attendance.requestCorrection(body);
  }

  @Get('corrections')
  @RequirePermission('attendance:read')
  @Doc({ summary: 'Correction requests', query: listQuery })
  corrections(@Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.attendance.listCorrections(q);
  }

  @Post('corrections/:id/cancel')
  @HttpCode(200)
  @RequirePermission('attendance:correct')
  @Doc({ summary: 'Withdraw a pending correction' })
  cancelCorrection(@Param('id', UuidPipe) id: string) {
    return this.attendance.cancelCorrection(id);
  }

  @Post('overtime')
  @RequirePermission('attendance:correct')
  @Doc({ summary: 'Claim overtime recorded on a day (goes for approval)', body: overtimeClaimInput })
  overtime(@Body(new ZodPipe(overtimeClaimInput)) body: z.infer<typeof overtimeClaimInput>) {
    return this.attendance.claimOvertime(body);
  }

  @Get('policies')
  @RequirePermission('attendance:read')
  @Doc({ summary: 'Attendance policies (workspace default and location overrides)' })
  policies() {
    return this.attendance.listPolicies();
  }

  @Put('policies')
  @RequirePermission('attendance:configure')
  @Doc({ summary: 'Create or replace the workspace or a location attendance policy', body: attendancePolicyInput })
  savePolicy(@Body(new ZodPipe(attendancePolicyInput)) body: AttendancePolicyInput) {
    return this.attendance.savePolicy(body);
  }

  @Delete('policies/:locationId')
  @HttpCode(204)
  @RequirePermission('attendance:configure')
  @Doc({ summary: 'Remove a location override (the workspace default applies again)' })
  removePolicy(@Param('locationId', UuidPipe) locationId: string) {
    return this.attendance.removePolicy(locationId);
  }

  @Get('locks')
  @RequirePermission('attendance:configure')
  @Doc({ summary: 'Locked and unlocked attendance periods' })
  locks() {
    return this.attendance.listLocks();
  }

  @Post('locks')
  @RequirePermission('attendance:configure')
  @Doc({ summary: 'Lock a period for payroll: days stop changing and new punches for it are kept but not applied', body: periodLockInput })
  lock(@Body(new ZodPipe(periodLockInput)) body: z.infer<typeof periodLockInput>) {
    return this.attendance.lock(body);
  }

  @Post('locks/:id/unlock')
  @HttpCode(204)
  @RequirePermission('attendance:configure')
  @Doc({ summary: 'Unlock a period (a reason is recorded)', body: unlockInput })
  unlock(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(unlockInput)) body: z.infer<typeof unlockInput>) {
    return this.attendance.unlock(id, body.reason);
  }

  @Post('recompute')
  @HttpCode(200)
  @RequirePermission('attendance:configure')
  @Doc({ summary: 'Recompute attendance days from raw punches for a date range', body: range })
  recompute(@Body(new ZodPipe(range)) body: z.infer<typeof range>) {
    return this.attendance.recomputeRange(body);
  }

  @Get('kiosks')
  @RequirePermission('attendance:configure')
  @RequireFeature('attendance_advanced')
  @Doc({ summary: 'QR kiosks' })
  kiosks() {
    return this.attendance.listKiosks();
  }

  @Post('kiosks')
  @RequirePermission('attendance:configure')
  @RequireFeature('attendance_advanced')
  @Doc({ summary: 'Create a QR kiosk. The returned token is shown once.', body: kioskInput })
  createKiosk(@Body(new ZodPipe(kioskInput)) body: z.infer<typeof kioskInput>) {
    return this.attendance.createKiosk(body);
  }

  @Post('kiosks/:id/revoke')
  @HttpCode(204)
  @RequirePermission('attendance:configure')
  @RequireFeature('attendance_advanced')
  @Doc({ summary: 'Revoke a kiosk' })
  revokeKiosk(@Param('id', UuidPipe) id: string) {
    return this.attendance.revokeKiosk(id);
  }
}

@Controller('kiosk')
export class KioskController {
  constructor(private readonly attendance: AttendanceService) {}

  @Get('qr')
  @Public()
  @Header('Cache-Control', 'no-store')
  @Doc({ summary: 'Current QR code for a kiosk screen', description: 'Authenticated by the kiosk token in the `X-Kiosk-Token` header. Codes rotate every 30 seconds.' })
  qr(@Headers('x-kiosk-token') token: string | undefined) {
    return this.attendance.kioskDisplay(String(token ?? '').slice(0, 100));
  }
}

@Controller('shifts')
@RequireFeature('shift_scheduling')
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  @Get('templates')
  @RequirePermission('shifts:read')
  @Doc({ summary: 'Shift templates', query: archivedQuery })
  templates(@Query(new ZodPipe(archivedQuery)) q: z.infer<typeof archivedQuery>) {
    return this.shifts.listTemplates(q.includeArchived === 'true');
  }

  @Post('templates')
  @RequirePermission('attendance:configure')
  @Doc({ summary: 'Create a shift template', body: shiftTemplateInput })
  createTemplate(@Body(new ZodPipe(shiftTemplateInput)) body: ShiftTemplateInput) {
    return this.shifts.createTemplate(body);
  }

  @Put('templates/:id')
  @RequirePermission('attendance:configure')
  @Doc({ summary: 'Replace a shift template', body: shiftTemplateInput })
  updateTemplate(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(shiftTemplateInput)) body: ShiftTemplateInput) {
    return this.shifts.updateTemplate(id, body);
  }

  @Delete('templates/:id')
  @HttpCode(204)
  @RequirePermission('attendance:configure')
  @Doc({ summary: 'Archive a shift template' })
  archiveTemplate(@Param('id', UuidPipe) id: string) {
    return this.shifts.archiveTemplate(id);
  }

  @Get('rosters')
  @RequirePermission('shifts:read')
  @Doc({ summary: 'Rosters' })
  rosters() {
    return this.shifts.listRosters();
  }

  @Post('rosters')
  @RequirePermission('shifts:manage')
  @Doc({ summary: 'Create a draft roster for a date range, optionally for one department or location', body: rosterInput })
  createRoster(@Body(new ZodPipe(rosterInput)) body: z.infer<typeof rosterInput>) {
    return this.shifts.createRoster(body);
  }

  @Get('rosters/:id')
  @RequirePermission('shifts:read')
  @Doc({ summary: 'A roster grid: people and their planned shift per day' })
  roster(@Param('id', UuidPipe) id: string) {
    return this.shifts.roster(id);
  }

  @Post('rosters/:id/publish')
  @HttpCode(200)
  @RequirePermission('shifts:manage')
  @Doc({ summary: 'Publish a roster: its shifts apply and the people on it are notified' })
  publish(@Param('id', UuidPipe) id: string) {
    return this.shifts.publish(id);
  }

  @Delete('rosters/:id')
  @HttpCode(204)
  @RequirePermission('shifts:manage')
  @Doc({ summary: 'Delete a draft roster' })
  deleteRoster(@Param('id', UuidPipe) id: string) {
    return this.shifts.deleteRoster(id);
  }

  @Put('assignments')
  @RequirePermission('shifts:manage')
  @Doc({ summary: 'Set shifts (or days off) for people and dates', body: shiftAssignmentsInput })
  assign(@Body(new ZodPipe(shiftAssignmentsInput)) body: z.infer<typeof shiftAssignmentsInput>) {
    return this.shifts.assign(body);
  }

  @Get('schedule')
  @RequirePermission('shifts:read')
  @Doc({ summary: 'Planned shift per day for me or an employee, plus my swap requests', query: range })
  schedule(@Query(new ZodPipe(range)) q: z.infer<typeof range>) {
    return this.shifts.schedule(q.employeeId, q.from, q.to);
  }

  @Get('swap-candidates')
  @RequirePermission('shifts:read')
  @Doc({ summary: 'Colleagues I could swap with on a date', query: dateQuery })
  candidates(@Query(new ZodPipe(dateQuery)) q: z.infer<typeof dateQuery>) {
    return this.shifts.swapCandidates(q.date);
  }

  @Post('swaps')
  @RequirePermission('shifts:read')
  @Doc({ summary: 'Ask a colleague to swap shifts on a date', body: swapRequestInput })
  requestSwap(@Body(new ZodPipe(swapRequestInput)) body: z.infer<typeof swapRequestInput>) {
    return this.shifts.requestSwap(body);
  }

  @Post('swaps/:id/accept')
  @HttpCode(200)
  @RequirePermission('shifts:read')
  @Doc({ summary: 'Accept a swap a colleague asked for (it then goes for approval)' })
  accept(@Param('id', UuidPipe) id: string) {
    return this.shifts.respondSwap(id, true);
  }

  @Post('swaps/:id/decline')
  @HttpCode(200)
  @RequirePermission('shifts:read')
  @Doc({ summary: 'Decline a swap a colleague asked for' })
  decline(@Param('id', UuidPipe) id: string) {
    return this.shifts.respondSwap(id, false);
  }

  @Post('swaps/:id/cancel')
  @HttpCode(200)
  @RequirePermission('shifts:read')
  @Doc({ summary: 'Withdraw my swap request' })
  cancel(@Param('id', UuidPipe) id: string) {
    return this.shifts.cancelSwap(id);
  }
}

@Controller('attendance/devices')
@RequireFeature('attendance_advanced')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  @RequirePermission('devices:manage')
  @Doc({ summary: 'Attendance devices with live status' })
  list() {
    return this.devices.list();
  }

  @Post()
  @RequirePermission('devices:manage')
  @Doc({ summary: 'Register a device by serial number', body: deviceInput })
  create(@Body(new ZodPipe(deviceInput)) body: DeviceInput) {
    return this.devices.create(body);
  }

  @Get('mappings')
  @RequirePermission('devices:manage')
  @Doc({ summary: 'Enrolment numbers mapped to employees' })
  mappings() {
    return this.devices.listMappings();
  }

  @Post('mappings')
  @RequirePermission('devices:manage')
  @Doc({ summary: 'Map an enrolment number to an employee; punches already received are applied', body: deviceMappingInput })
  map(@Body(new ZodPipe(deviceMappingInput)) body: z.infer<typeof deviceMappingInput>) {
    return this.devices.map(body);
  }

  @Delete('mappings/:id')
  @HttpCode(204)
  @RequirePermission('devices:manage')
  @Doc({ summary: 'Remove a mapping' })
  unmap(@Param('id', UuidPipe) id: string) {
    return this.devices.unmap(id);
  }

  @Get(':id')
  @RequirePermission('devices:manage')
  @Doc({ summary: 'Device detail: status, setup values, enrolment numbers seen, ingest log' })
  get(@Param('id', UuidPipe) id: string) {
    return this.devices.get(id);
  }

  @Patch(':id')
  @RequirePermission('devices:manage')
  @Doc({ summary: 'Update a device', body: devicePatch })
  update(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(devicePatch)) body: Partial<DeviceInput>) {
    return this.devices.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('devices:manage')
  @Doc({ summary: 'Archive a device (its punches are kept)' })
  archive(@Param('id', UuidPipe) id: string) {
    return this.devices.archive(id);
  }

  @Post(':id/simulate')
  @HttpCode(200)
  @RequirePermission('devices:manage')
  @Doc({ summary: 'Send test punches from a simulated device through the real ingest pipeline', body: simulateInput })
  simulate(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(simulateInput)) body: z.infer<typeof simulateInput>) {
    return this.devices.simulate(id, body);
  }
}

type PushRequest = { query: Record<string, string>; body: unknown; ip?: string };
const textBody = (req: PushRequest) => (typeof req.body === 'string' ? req.body : '').slice(0, 2_000_000);

/**
 * ZKTeco / eSSL push protocol. Served at the server root (/iclock/...) because devices are configured with
 * only a host and port. Devices are identified by registered serial number and, optionally, source address.
 */
@Controller('iclock')
@RootPath()
@Public()
export class ZkPushController {
  constructor(private readonly devices: DevicesService) {}

  @Get('cdata')
  @Header('Content-Type', 'text/plain')
  @Doc({ summary: 'Device handshake (ZKTeco / eSSL push protocol)', description: 'Called by the device with `SN=<serial>`. Answers with upload options.' })
  handshake(@Req() req: PushRequest) {
    return this.devices.handshake(req.query.SN, req.query, req.ip ?? null);
  }

  @Post('cdata')
  @HttpCode(200)
  @Header('Content-Type', 'text/plain')
  @Doc({ summary: 'Device upload of attendance records (table=ATTLOG)', description: 'Tab-separated records in the request body. Records are deduplicated, stored as received and applied.' })
  upload(@Req() req: PushRequest) {
    return this.devices.upload(req.query.SN, req.query, textBody(req), req.ip ?? null);
  }

  @Get('getrequest')
  @Header('Content-Type', 'text/plain')
  @Doc({ summary: 'Device command poll and heartbeat' })
  poll(@Req() req: PushRequest) {
    return this.devices.heartbeat(req.query.SN, req.query, req.ip ?? null);
  }

  @Post('devicecmd')
  @HttpCode(200)
  @Header('Content-Type', 'text/plain')
  @Doc({ summary: 'Device command results' })
  commandResult(@Req() req: PushRequest) {
    return this.devices.commandResult(req.query.SN, req.ip ?? null);
  }
}
