import { z } from 'zod';
import { timezone } from './common';
import { isoDate } from './people';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time such as 09:30');
const minutes = (max: number) => z.number().int().min(0).max(max);

export const shiftTemplateInput = z
  .object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{1,12}$/, 'Use up to 12 capital letters, digits, - or _'),
    name: z.string().trim().min(1).max(80),
    startTime: time,
    endTime: time,
    breakMinutes: minutes(240).default(0),
    graceLateMinutes: minutes(240).default(10),
    graceEarlyMinutes: minutes(240).default(10),
    halfDayMinutes: minutes(1440).default(240),
    fullDayMinutes: minutes(1440).default(480),
    overtimeEnabled: z.boolean().default(false),
    overtimeMinMinutes: minutes(600).default(30),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#0f766e'),
  })
  .refine((v) => v.startTime !== v.endTime, { message: 'A shift cannot start and end at the same time', path: ['endTime'] })
  .refine((v) => v.halfDayMinutes <= v.fullDayMinutes, { message: 'Half day cannot need more time than a full day', path: ['halfDayMinutes'] });
export type ShiftTemplateInput = z.infer<typeof shiftTemplateInput>;

export const GEOFENCE_MODES = ['off', 'warn', 'enforce'] as const;
export const attendancePolicyInput = z.object({
  /** null for the workspace default; a location's own policy overrides it. */
  locationId: z.uuid().nullable().default(null),
  webPunch: z.boolean().default(true),
  mobilePunch: z.boolean().default(true),
  qrPunch: z.boolean().default(true),
  geofenceMode: z.enum(GEOFENCE_MODES).default('warn'),
  defaultShiftId: z.uuid().nullable().default(null),
  overtimeRequiresApproval: z.boolean().default(true),
  earlyWindowMinutes: z.number().int().min(30).max(720).default(240),
  correctionWindowDays: z.number().int().min(0).max(366).default(30),
});
export type AttendancePolicyInput = z.infer<typeof attendancePolicyInput>;

export const punchInput = z.object({
  direction: z.enum(['in', 'out']).optional(),
  source: z.enum(['web', 'mobile']).default('web'),
  /** Client-generated id so a retried request (or an offline phone syncing later) records the punch once. */
  clientEventId: z.string().trim().min(8).max(80).regex(/^[A-Za-z0-9_.:-]+$/),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  accuracyM: z.number().min(0).max(100_000).optional(),
  note: z.string().trim().max(300).optional(),
}).refine((v) => (v.latitude === undefined) === (v.longitude === undefined), { message: 'Send both latitude and longitude', path: ['longitude'] });
export type PunchInput = z.infer<typeof punchInput>;

export const qrPunchInput = z.object({
  code: z.string().min(10).max(300),
  direction: z.enum(['in', 'out']).optional(),
});

const correctionPunch = z.object({ time, direction: z.enum(['in', 'out']), nextDay: z.boolean().default(false) });
export const correctionInput = z.object({
  employeeId: z.uuid().optional(),
  workDate: isoDate,
  punches: z
    .array(correctionPunch)
    .min(1)
    .max(6)
    .refine((ps) => new Set(ps.map((p) => `${p.time}|${p.direction}|${p.nextDay}`)).size === ps.length, { message: 'The same punch is listed twice' }),
  reason: z.string().trim().min(3).max(500),
});
export type CorrectionInput = z.infer<typeof correctionInput>;

export const overtimeClaimInput = z.object({
  employeeId: z.uuid().optional(),
  workDate: isoDate,
  minutes: z.number().int().min(1).max(1440),
  reason: z.string().trim().max(500).optional(),
});

export const shiftAssignmentsInput = z.object({
  rosterId: z.uuid().nullable().default(null),
  assignments: z
    .array(z.object({ employeeId: z.uuid(), workDate: isoDate, shiftTemplateId: z.uuid().nullable() }))
    .min(1)
    .max(1000),
});

export const rosterInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    startDate: isoDate,
    endDate: isoDate,
    departmentId: z.uuid().nullable().default(null),
    locationId: z.uuid().nullable().default(null),
  })
  .refine((v) => v.endDate >= v.startDate, { message: 'End date is before the start date', path: ['endDate'] })
  .refine((v) => (Date.parse(v.endDate) - Date.parse(v.startDate)) / 86_400_000 <= 62, { message: 'A roster can cover at most 63 days', path: ['endDate'] });

export const swapRequestInput = z.object({
  workDate: isoDate,
  counterpartEmployeeId: z.uuid(),
  reason: z.string().trim().max(500).optional(),
});

export const periodLockInput = z.object({
  legalEntityId: z.uuid().nullable().default(null),
  periodStart: isoDate,
  periodEnd: isoDate,
  note: z.string().trim().max(300).optional(),
}).refine((v) => v.periodEnd >= v.periodStart, { message: 'End is before start', path: ['periodEnd'] });

export const DEVICE_VENDORS = ['zkteco', 'essl', 'hikvision', 'matrix', 'realtime', 'suprema', 'generic'] as const;
export type DeviceVendor = (typeof DEVICE_VENDORS)[number];
/**
 * How a machine sends punches to CREW:
 *   push_http   the ZKTeco / eSSL "PUSH" (ADMS) protocol at /iclock/cdata, identified by serial number;
 *   device_api  CREW's own HTTPS device API (POST /api/v1/device-api/punches) with a per-machine token, for any
 *               machine, vendor bridge or middleware that can make an HTTPS call.
 */
export const DEVICE_PROTOCOLS = ['push_http', 'device_api'] as const;
export type DeviceProtocol = (typeof DEVICE_PROTOCOLS)[number];

/** Attendance machine integrations SAMPLEDGE can switch on or off per workspace (Console > a workspace > Devices). */
export const DEVICE_INTEGRATIONS: readonly { key: DeviceVendor; name: string; protocols: readonly DeviceProtocol[]; note: string }[] = [
  { key: 'zkteco', name: 'ZKTeco', protocols: ['push_http', 'device_api'], note: 'Cloud server (ADMS push) built into the machine, or the device API through a bridge.' },
  { key: 'essl', name: 'eSSL', protocols: ['push_http', 'device_api'], note: 'eSSL machines on ZKTeco firmware use the same ADMS push.' },
  { key: 'hikvision', name: 'Hikvision', protocols: ['device_api'], note: 'Through a bridge or middleware that forwards access events to the device API.' },
  { key: 'matrix', name: 'Matrix COSEC', protocols: ['device_api'], note: 'Through COSEC event forwarding or a bridge calling the device API.' },
  { key: 'realtime', name: 'Realtime', protocols: ['device_api'], note: 'Through a bridge or middleware calling the device API.' },
  { key: 'suprema', name: 'Suprema', protocols: ['device_api'], note: 'Through BioStar event forwarding or a bridge calling the device API.' },
  { key: 'generic', name: 'Other machine or middleware', protocols: ['device_api'], note: 'Any system that can make an HTTPS call with the machine token.' },
];
export const deviceProtocolFor = (vendor: DeviceVendor, asked?: DeviceProtocol): DeviceProtocol =>
  asked ?? (vendor === 'zkteco' || vendor === 'essl' ? 'push_http' : 'device_api');

export const deviceInput = z.object({
  name: z.string().trim().min(1).max(120),
  vendor: z.enum(DEVICE_VENDORS),
  /** Defaults to push_http for ZKTeco and eSSL, device_api for everything else. */
  protocol: z.enum(DEVICE_PROTOCOLS).optional(),
  model: z.string().trim().max(80).optional(),
  serialNumber: z.string().trim().regex(/^[A-Za-z0-9_-]{4,40}$/, 'Use the serial number shown on the device (letters and digits)'),
  locationId: z.uuid(),
  timeZone: timezone.optional(),
  /** Devices that only report punches; the direction is then worked out from the order of punches. */
  directionFromDevice: z.boolean().default(true),
  allowedIps: z.array(z.string().regex(/^[0-9a-fA-F:.]+(\/\d{1,3})?$/, 'Use an IP address or CIDR range')).max(20).default([]),
  simulated: z.boolean().default(false),
  expectedIntervalSeconds: z.number().int().min(30).max(86_400).default(300),
});
export type DeviceInput = z.infer<typeof deviceInput>;

const deviceLocalOrIso = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})?$/;
/** Body of POST /api/v1/device-api/punches. Times without an offset are the machine's local time in its time zone. */
export const deviceApiPunches = z.object({
  punches: z.array(z.object({
    userId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,32}$/, 'Use the enrolment number on the machine'),
    time: z.string().trim().regex(deviceLocalOrIso, 'Use YYYY-MM-DD HH:MM:SS, optionally with Z or an offset such as +05:30'),
    direction: z.enum(['in', 'out', 'unknown']).default('unknown'),
    verify: z.enum(['fingerprint', 'face', 'card', 'pin', 'palm', 'unknown']).default('unknown'),
    /** The machine's own record id, when it has one; repeats of the same id are one punch. */
    id: z.string().trim().max(80).optional(),
  }).strict()).min(1).max(500),
  device: z.object({ firmware: z.string().trim().max(80).optional(), users: z.number().int().min(0).optional(), records: z.number().int().min(0).optional() }).strict().optional(),
}).strict();
export type DeviceApiPunches = z.infer<typeof deviceApiPunches>;
export const deviceApiHeartbeat = z.object({ firmware: z.string().trim().max(80).optional(), users: z.number().int().min(0).optional(), records: z.number().int().min(0).optional() }).strict();

export const deviceMappingInput = z.object({
  deviceUserId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,32}$/),
  employeeId: z.uuid(),
  /** null maps the enrolment number on every device in the workspace. */
  deviceId: z.uuid().nullable().default(null),
});

export const kioskInput = z.object({ name: z.string().trim().min(1).max(120), locationId: z.uuid() });

export const simulateInput = z.object({
  date: isoDate.optional(),
  scenario: z.enum(['normal_day', 'late_and_missing_out', 'unknown_user', 'duplicates']).default('normal_day'),
});
