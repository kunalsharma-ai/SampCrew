import { z } from 'zod';

/**
 * Feedback of 25 November 2026 (issue #86), the registered company:
 *  - At registration the company says how attendance reads location (GPS): not at all, at check-in and check-out, or
 *    in real time while SampCrew is open and the person is checked in. The IP address the company registered from is
 *    recorded once and shown locked; it starts the list of office network addresses.
 *  - Once company setup is finished, the registered information is locked: a field that holds a value can no longer
 *    be changed from the Web Portal (only SAMPLEDGE, from the Console, corrects it). A field still empty can be filled in.
 *  - Only the Super Workspace registers another company (legal entity); HR Workspace people see the registered company.
 */

export const LOCATION_TRACKING = ['off', 'punch', 'real_time'] as const;
export type LocationTracking = (typeof LOCATION_TRACKING)[number];
export const LOCATION_TRACKING_LABELS: Record<LocationTracking, { label: string; help: string }> = {
  off: { label: 'Off', help: 'Attendance never asks for the location. Work From Office and Work From Home come from the network (IP) only.' },
  punch: { label: 'At check-in and check-out', help: 'The location is read when someone checks in, checks out or presses Update my location.' },
  real_time: { label: 'Real-time tracking', help: 'Also every 15 minutes while SampCrew is open and the person is checked in, after they allow it in the browser or phone.' },
};
/** How often real-time tracking sends a reading while the app is open and the person is checked in. */
export const REAL_TIME_TRACKING_MINUTES = 15;

/** An IPv4 or IPv6 address, or an IPv4 range in CIDR form (203.0.113.0/24). */
const ipOrCidr = z.string().trim().max(45).refine((s) => isIp(s) || isCidr4(s), 'Use an IP address such as 203.0.113.10, or a range such as 203.0.113.0/24');
export const officeIpsInput = z.array(ipOrCidr).max(50).refine((a) => new Set(a).size === a.length, 'Each address once');

export function isIp(s: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) return v4.slice(1).every((n) => Number(n) <= 255);
  return /^[0-9a-fA-F:]{2,45}$/.test(s) && s.includes(':') && (s.match(/::/g) ?? []).length <= 1;
}
function isCidr4(s: string): boolean {
  const [ip, bits] = s.split('/');
  return !!ip && bits !== undefined && /^\d{1,2}$/.test(bits) && Number(bits) <= 32 && /^\d+\.\d+\.\d+\.\d+$/.test(ip) && isIp(ip);
}
const v4num = (ip: string) => ip.split('.').reduce((n, x) => n * 256 + Number(x), 0);
/** Strips the IPv4-mapped IPv6 prefix (::ffff:1.2.3.4) Node reports for IPv4 clients on a dual-stack socket. */
export const normaliseIp = (ip: string | null | undefined) => (ip ?? '').trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');

/** Whether an address is one of the office networks (exact address, or inside an IPv4 CIDR range). */
export function ipInOffice(ip: string | null | undefined, offices: readonly string[]): boolean {
  const a = normaliseIp(ip);
  if (!a || !offices.length) return false;
  for (const o of offices) {
    if (!o.includes('/')) { if (normaliseIp(o).toLowerCase() === a.toLowerCase()) return true; continue; }
    const [net, bitsText] = o.split('/');
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(a) || !net) continue;
    const bits = Number(bitsText);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if (((v4num(a) & mask) >>> 0) === ((v4num(net) & mask) >>> 0)) return true;
  }
  return false;
}

/** The registered company's fields that lock once they hold a value (setup company step and the main legal entity). */
export const COMPANY_LOCKED_FIELDS = [
  'name', 'legalName', 'industry', 'companySize', 'website', 'contactEmail', 'contactPhone', 'countryCode', 'currency', 'timezone',
  'fiscalYearStartMonth', 'registrationNumber', 'taxId', 'address',
] as const;
/** The same rule for a legal entity edited from Organization (field names of legalEntityInput). */
export const ENTITY_LOCKED_FIELDS = ['name', 'legalName', 'countryCode', 'currency', 'timezone', 'fiscalYearStartMonth', 'registrationNumber', 'taxId', 'address'] as const;

export const LOCKED_FIELD_MESSAGE = 'Registered information is locked. Ask SAMPLEDGE support to correct it.';

const empty = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const same = (a: unknown, b: unknown) => (empty(a) && empty(b)) || String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/**
 * Fields an update would change although they are locked: they already hold a value and the new one differs.
 * Only fields present in `input` count (a field left out keeps its value).
 */
export function lockedFieldChanges(before: Record<string, unknown>, input: Record<string, unknown>, fields: readonly string[]): string[] {
  return fields.filter((f) => f in input && input[f] !== undefined && !empty(before[f]) && !same(before[f], input[f]));
}

/** The registered company as the Web Portal shows it: what is locked and where it registered from. */
export interface CompanyRegistration {
  /** When the registered information was locked (setup finished); null while it can still be edited. */
  lockedAt: string | null;
  /** Fields that hold a value and so cannot be changed any more (empty while not locked). */
  lockedFields: string[];
  /** The IP address the company registered from (null for companies registered before it was recorded). */
  registrationIp: string | null;
  locationTracking: LocationTracking;
  officeIps: string[];
}

// ---------------------------------------------------------------------------------------------------------------
// Activity log (issue #86): each sign-in with IP address, device, GPS position and what was done in it
// ---------------------------------------------------------------------------------------------------------------

/** Sent once by the browser or app after sign-in: the position, or that it was not shared. */
export const sessionLocationInput = z.union([
  z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(100_000).nullable().optional() }).strict(),
  z.object({ status: z.enum(['denied', 'unavailable']) }).strict(),
]);
export type SessionLocationInput = z.infer<typeof sessionLocationInput>;

export interface ActivitySession {
  id: string;
  client: 'web' | 'mobile' | 'api';
  ip: string | null;
  userAgent: string | null;
  startedAt: string;
  lastActiveAt: string;
  endedAt: string | null;
  status: 'active' | 'signed_out' | 'expired';
  current: boolean;
  location: { status: 'shared' | 'denied' | 'unavailable' | 'not_asked'; latitude: number | null; longitude: number | null; accuracyM: number | null };
  /** What was done in this session, newest first (from the audit trail). */
  actions: { action: string; resourceType: string | null; resourceId: string | null; at: string }[];
}

export interface ActivityLog {
  person: { membershipId: string; name: string; email: string };
  self: boolean;
  /** Whether this viewer may open other people's activity (audit:read). */
  canViewOthers: boolean;
  /** Everyone whose activity this viewer may open (empty unless canViewOthers). */
  people: { membershipId: string; name: string }[];
  sessions: ActivitySession[];
}
