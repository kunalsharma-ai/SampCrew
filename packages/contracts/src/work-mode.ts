import { z } from 'zod';
import { distanceMetres } from './attendance-engine';
import { fmtHhmm, toLocal } from './zoned-time';

/**
 * Where people work: every attendance day is classified automatically as Work From Office, Work From Home or
 * Work From Office + Home (hybrid), from the location checked at check-in and check-out (and any location update the
 * person records in between). Location is read only at those moments, never tracked through the day. A reading that
 * fails, is refused or is too vague makes the day "Pending verification" for HR to review; it never counts as home.
 *
 * The API, the screens, the phone app and the Excel export all use these definitions, so a day is classified and
 * named the same way everywhere. Display names are the company's own (Super Workspace can rename the three); the
 * stored values (office, remote, hybrid) never change, so renaming does not touch history or reports.
 */

export const ATTENDANCE_WORK_MODES = ['office', 'remote', 'hybrid'] as const;
export type WorkMode = (typeof ATTENDANCE_WORK_MODES)[number];
/** What a day is stored as: one of the three, or waiting for HR because a location could not be verified. */
export const WORK_MODE_STATES = [...ATTENDANCE_WORK_MODES, 'pending_verification'] as const;
export type WorkModeState = (typeof WORK_MODE_STATES)[number];

export const DEFAULT_WORK_MODE_LABELS: Record<WorkMode, string> = {
  office: 'Work From Office',
  remote: 'Work From Home',
  hybrid: 'Work From Office + Home',
};
export const PENDING_VERIFICATION_LABEL = 'Pending verification';
export type WorkModeLabels = Record<WorkMode, string>;

/** The name to show for a stored state, with the company's own labels. */
export function workModeLabel(state: WorkModeState | null | undefined, labels: WorkModeLabels = DEFAULT_WORK_MODE_LABELS): string {
  if (!state) return 'Not classified';
  if (state === 'pending_verification') return PENDING_VERIFICATION_LABEL;
  return labels[state] || DEFAULT_WORK_MODE_LABELS[state];
}

/** "You're working from office today" style sentences for the status card. */
export function workModeSentence(state: WorkModeState | null | undefined, labels: WorkModeLabels, provisional: boolean): string {
  if (!state) return 'You have not checked in yet today';
  if (state === 'pending_verification') return 'Your location could not be verified, so HR will review today';
  const name = labels[state] || DEFAULT_WORK_MODE_LABELS[state];
  return provisional ? `You're on ${name} today` : `Today was ${name}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Where a punch was
// ---------------------------------------------------------------------------------------------------------------

/**
 * Where one check-in, check-out or location update was:
 *  - office: inside the geofence of an office the person may use (or an approved site that counts as office).
 *  - remote: a verified reading outside every office and approved site.
 *  - unverified: no reading (location off, refused, timed out), a mock location, or one too vague to decide.
 *  - neutral: a punch with no location by nature (an approved correction, an import): it takes the zone of the
 *    other end of its working interval.
 * Kiosk and biometric punches are office: the machine is installed at a location.
 */
export const PUNCH_ZONES = ['office', 'remote', 'unverified', 'neutral'] as const;
export type PunchZone = (typeof PUNCH_ZONES)[number];

/** Why a reading is or is not trusted. */
export const LOCATION_VERIFICATIONS = ['verified', 'device', 'no_location', 'denied', 'unavailable', 'poor_accuracy', 'mock_location', 'not_needed'] as const;
export type LocationVerification = (typeof LOCATION_VERIFICATIONS)[number];

export const LOCATION_VERIFICATION_LABEL: Record<LocationVerification, string> = {
  verified: 'Verified',
  device: 'Verified by kiosk or device',
  no_location: 'No location sent',
  denied: 'Location permission refused',
  unavailable: 'Location not available',
  poor_accuracy: 'Location too vague',
  mock_location: 'Mock location detected',
  not_needed: 'No location needed',
};

/** What the browser or phone says when it has no coordinates. */
export const LOCATION_STATUSES = ['ok', 'denied', 'unavailable', 'timeout'] as const;
export type LocationStatus = (typeof LOCATION_STATUSES)[number];

export interface WorkPlace {
  id: string;
  name: string;
  kind: 'office' | 'site';
  lat: number;
  lon: number;
  radiusM: number;
  /** Counts as office for classification (approved sites may count as remote, a client visit for instance). */
  countsAs: 'office' | 'remote';
}

export interface ZoneResult {
  zone: PunchZone;
  verification: LocationVerification;
  place: { id: string; name: string; kind: 'office' | 'site' } | null;
  /** Metres to the nearest place (rounded), when there was a reading. */
  distanceM: number | null;
}

/**
 * Where a reading was, given the places the person may use. Accuracy is used both ways: a reading certainly inside a
 * geofence (distance plus accuracy within the radius) or certainly outside every one (distance minus accuracy beyond
 * each radius) is decided even when vague; otherwise it must be no vaguer than maxAccuracyM.
 */
export function resolveZone(
  fix: { lat: number; lon: number; accuracyM?: number | null; mock?: boolean } | null,
  places: WorkPlace[],
  opts: { maxAccuracyM: number; status?: LocationStatus },
): ZoneResult {
  if (!fix) {
    const verification: LocationVerification = opts.status === 'denied' ? 'denied' : opts.status === 'unavailable' || opts.status === 'timeout' ? 'unavailable' : 'no_location';
    return { zone: 'unverified', verification, place: null, distanceM: null };
  }
  if (fix.mock) return { zone: 'unverified', verification: 'mock_location', place: null, distanceM: null };
  const acc = Math.max(0, fix.accuracyM ?? 0);
  const ranked = places
    .map((p) => ({ p, d: distanceMetres(p.lat, p.lon, fix.lat, fix.lon) }))
    .sort((a, b) => (a.d - a.p.radiusM) - (b.d - b.p.radiusM));
  const nearest = ranked[0];
  const distanceM = nearest ? Math.round(nearest.d) : null;
  const surelyInside = ranked.find((x) => x.d + acc <= x.p.radiusM);
  const insideWithin = acc <= opts.maxAccuracyM ? ranked.find((x) => x.d - Math.min(acc, x.p.radiusM) <= x.p.radiusM) : undefined;
  const hit = surelyInside ?? insideWithin;
  if (hit) {
    return { zone: hit.p.countsAs === 'office' ? 'office' : 'remote', verification: 'verified', place: { id: hit.p.id, name: hit.p.name, kind: hit.p.kind }, distanceM: Math.round(hit.d) };
  }
  const surelyOutside = ranked.every((x) => x.d - acc > x.p.radiusM);
  if (surelyOutside || acc <= opts.maxAccuracyM) return { zone: 'remote', verification: 'verified', place: null, distanceM };
  return { zone: 'unverified', verification: 'poor_accuracy', place: null, distanceM };
}

// ---------------------------------------------------------------------------------------------------------------
// The classification engine
// ---------------------------------------------------------------------------------------------------------------

/** How time between a check-in and a check-out in different places is split when nothing was recorded in between. */
export const TRANSITION_RULES = ['split', 'check_in', 'check_out'] as const;
export type TransitionRule = (typeof TRANSITION_RULES)[number];
export const TRANSITION_RULE_LABEL: Record<TransitionRule, string> = {
  split: 'Half in each place',
  check_in: 'All where the person checked in',
  check_out: 'All where the person checked out',
};

export interface ClassifyRules {
  /** Hybrid needs at least this much verified office time... */
  minOfficeMinutes: number;
  /** ...and at least this much verified remote time. Shorter stays elsewhere (a lunch break) do not make a day hybrid. */
  minRemoteMinutes: number;
  transition: TransitionRule;
}

export interface ModePunch {
  at: number;
  direction: 'in' | 'out' | 'unknown';
  zone: PunchZone;
  place?: string | null;
}

export interface ModeCheckpoint {
  at: number;
  zone: Exclude<PunchZone, 'neutral'>;
  place?: string | null;
}

export interface ClassifyInput {
  timeZone: string;
  punches: ModePunch[];
  /** Location updates the person recorded during the day (optional, never automatic). */
  checkpoints?: ModeCheckpoint[];
  /** Instant now; an interval still open counts up to now and the result is provisional. */
  now: number;
  /** True while the day's window is open (the person may still check out). */
  dayOpen: boolean;
  /** Approved work from home covering the whole day or a half (counts as remote without punches). */
  approvedRemote?: 'full' | 'first_half' | 'second_half' | null;
  rules: ClassifyRules;
  duplicateWindowSeconds?: number;
}

export const WORK_MODE_ISSUES = ['missing_check_in', 'missing_check_out', 'location_unverified', 'mock_location', 'poor_accuracy', 'short_office_stay', 'short_remote_stay'] as const;
export type WorkModeIssue = (typeof WORK_MODE_ISSUES)[number];
export const WORK_MODE_ISSUE_LABEL: Record<WorkModeIssue, string> = {
  missing_check_in: 'Check-in missing',
  missing_check_out: 'Check-out missing',
  location_unverified: 'Location not verified',
  mock_location: 'Mock location',
  poor_accuracy: 'Location too vague',
  short_office_stay: 'Short office stay',
  short_remote_stay: 'Short time away from office',
};

export interface ClassifyResult {
  /** null: nothing to classify (no punches and no approved work from home). */
  state: WorkModeState | null;
  /** The best answer from the verified part of the day, kept while the day waits for HR. */
  guess: WorkMode | null;
  provisional: boolean;
  officeMinutes: number;
  remoteMinutes: number;
  unverifiedMinutes: number;
  /** Office and site names seen in the day, in order. */
  places: string[];
  /** Moves between office and elsewhere, as recorded. */
  transitions: { at: number; from: Exclude<PunchZone, 'neutral'>; to: Exclude<PunchZone, 'neutral'> }[];
  issues: WorkModeIssue[];
  explanation: string[];
}

type Zone = Exclude<PunchZone, 'neutral'>;
const mins = (ms: number) => Math.max(0, Math.floor(ms / 60_000));

/**
 * Classifies one work day from its punches. A pure function, like the attendance engine: same inputs, same answer,
 * and the explanation shown to people comes from the same code that decided.
 *
 *  1. Punches are paired into working intervals the way the attendance engine pairs them (double taps dropped).
 *  2. Each interval runs from the check-in's place to the check-out's place, through any location updates in between.
 *     Between two points in the same place the time is that place's; between two different places it follows the
 *     transition rule (half each by default), since nobody is tracked in between.
 *  3. Any unverified time makes the day Pending verification (with the best guess kept for HR).
 *  4. Office and remote time both at least their minimums: hybrid. Otherwise the place with more time wins.
 */
export function classifyWorkMode(input: ClassifyInput): ClassifyResult {
  const clock = (ms: number) => fmtHhmm(toLocal(ms, input.timeZone).minutes);
  const explanation: string[] = [];
  const issues = new Set<WorkModeIssue>();
  const dupMs = (input.duplicateWindowSeconds ?? 120) * 1000;
  const sorted = [...input.punches].sort((a, b) => a.at - b.at);
  const punches: ModePunch[] = [];
  for (const p of sorted) {
    const prev = punches[punches.length - 1];
    if (prev && p.at - prev.at < dupMs && (p.direction === prev.direction || p.direction === 'unknown' || prev.direction === 'unknown')) continue;
    punches.push(p);
  }
  // Pair into intervals: [in punch, out punch | null while open].
  const intervals: { a: ModePunch; b: ModePunch | null }[] = [];
  let open: ModePunch | null = null;
  for (const p of punches) {
    const dir = p.direction === 'unknown' ? (open ? 'out' : 'in') : p.direction;
    if (dir === 'in') {
      if (open) {
        issues.add('missing_check_out');
        explanation.push(`Check-in at ${clock(open.at)} has no check-out before the next check-in, so its time is not counted.`);
      }
      open = p;
    } else if (!open) {
      issues.add('missing_check_in');
      explanation.push(`Check-out at ${clock(p.at)} has no check-in.`);
    } else {
      intervals.push({ a: open, b: p });
      open = null;
    }
  }
  let provisional = false;
  if (open) {
    if (input.dayOpen) {
      intervals.push({ a: open, b: null });
      provisional = true;
    } else {
      issues.add('missing_check_out');
      explanation.push(`Check-in at ${clock(open.at)} has no check-out, so its time is not counted until it is corrected.`);
    }
  }

  const checkpoints = [...(input.checkpoints ?? [])].sort((a, b) => a.at - b.at);
  const time: Record<Zone, number> = { office: 0, remote: 0, unverified: 0 };
  const places: string[] = [];
  const addPlace = (p?: string | null) => {
    if (p && !places.includes(p)) places.push(p);
  };
  const transitions: ClassifyResult['transitions'] = [];
  let lastZone: Zone | null = null;
  const seen = (z: Zone, at: number) => {
    if (lastZone && lastZone !== z) transitions.push({ at, from: lastZone, to: z });
    lastZone = z;
  };

  for (const iv of intervals) {
    const end = iv.b ? iv.b.at : Math.max(iv.a.at, input.now);
    const inner = checkpoints.filter((c) => c.at > iv.a.at && c.at < end);
    // The zone of each end; a neutral end takes the other end's zone (or the nearest update's).
    const za: PunchZone = iv.a.zone;
    const zb: PunchZone = iv.b ? iv.b.zone : (inner[inner.length - 1]?.zone ?? za);
    const startZone: Zone = za !== 'neutral' ? za : zb !== 'neutral' ? zb : (inner[0]?.zone ?? 'unverified');
    const endZone: Zone = zb !== 'neutral' ? zb : (inner[inner.length - 1]?.zone ?? startZone);
    if (za === 'neutral' && zb === 'neutral' && !inner.length) {
      explanation.push(`Time from ${clock(iv.a.at)} to ${clock(end)} comes from a correction with no location, so where it was worked is not known.`);
    }
    const points: { at: number; zone: Zone; place?: string | null }[] = [
      { at: iv.a.at, zone: startZone, place: iv.a.place },
      ...inner.map((c) => ({ at: c.at, zone: c.zone, place: c.place })),
      { at: end, zone: endZone, place: iv.b?.place },
    ];
    for (const p of points) {
      addPlace(p.place);
      seen(p.zone, p.at);
    }
    for (let i = 0; i + 1 < points.length; i++) {
      const p = points[i]!;
      const q = points[i + 1]!;
      const span = mins(q.at - p.at);
      if (p.zone === q.zone) time[p.zone] += span;
      else if (input.rules.transition === 'check_in') time[p.zone] += span;
      else if (input.rules.transition === 'check_out') time[q.zone] += span;
      else {
        const half = Math.floor(span / 2);
        time[p.zone] += half;
        time[q.zone] += span - half;
      }
    }
  }

  const remoteApproved = input.approvedRemote ?? null;
  const worked = time.office + time.remote + time.unverified;
  if (!intervals.length && !remoteApproved) {
    if (punches.length) explanation.push('No complete working time to classify yet.');
    return { state: null, guess: null, provisional: false, officeMinutes: 0, remoteMinutes: 0, unverifiedMinutes: 0, places, transitions, issues: [...issues], explanation };
  }
  if (time.office) explanation.push(`${hours(time.office)} at the office${places.length ? ` (${places.join(', ')})` : ''}.`);
  if (time.remote) explanation.push(`${hours(time.remote)} away from the office.`);
  if (time.unverified) {
    issues.add('location_unverified');
    explanation.push(`${hours(time.unverified)} where the location could not be verified.`);
  }

  const lz = lastZone as Zone | null;
  // The best answer from verified time (and approved work from home).
  let guess: WorkMode | null;
  const { minOfficeMinutes, minRemoteMinutes } = input.rules;
  if (remoteApproved && !worked) {
    guess = 'remote';
    explanation.push(remoteApproved === 'full' ? 'Approved work from home for the day.' : 'Approved work from home for half the day.');
  } else if (remoteApproved && time.office >= minOfficeMinutes) {
    guess = 'hybrid';
    explanation.push('Office time plus approved work from home for part of the day.');
  } else if (time.office >= minOfficeMinutes && time.remote >= minRemoteMinutes) {
    guess = 'hybrid';
    explanation.push(`Both at least the minimums for hybrid (${minOfficeMinutes} min at the office, ${minRemoteMinutes} min elsewhere).`);
  } else if (time.office === 0 && time.remote === 0) {
    // Just checked in: the day so far is where the check-in was.
    guess = remoteApproved ? 'remote' : provisional && (lz === 'office' || lz === 'remote') ? lz : null;
  } else if (time.office >= time.remote) {
    guess = 'office';
    if (time.remote > 0) {
      issues.add('short_remote_stay');
      explanation.push(`${hours(time.remote)} away is under the ${minRemoteMinutes} min needed for hybrid, so the day counts as office.`);
    }
  } else {
    guess = 'remote';
    if (time.office > 0) {
      issues.add('short_office_stay');
      explanation.push(`${hours(time.office)} at the office is under the ${minOfficeMinutes} min needed for hybrid, so the day counts as away from the office.`);
    }
  }

  const state: WorkModeState | null = time.unverified > 0 || (provisional && worked === 0 && lz === 'unverified') ? 'pending_verification' : guess;
  if (state === 'pending_verification') explanation.push('Pending verification: HR reviews days with a location that could not be verified. It is never assumed to be home.');
  if (provisional) explanation.push('Provisional until you check out.');
  return {
    state, guess, provisional,
    officeMinutes: time.office, remoteMinutes: time.remote, unverifiedMinutes: time.unverified,
    places, transitions, issues: WORK_MODE_ISSUES.filter((i) => issues.has(i)), explanation,
  };
}

function hours(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

// ---------------------------------------------------------------------------------------------------------------
// Settings, places, people
// ---------------------------------------------------------------------------------------------------------------

export const OFFICE_REQUIREMENTS = ['none', 'check_in', 'check_in_out'] as const;
export type OfficeRequirement = (typeof OFFICE_REQUIREMENTS)[number];
export const OFFICE_REQUIREMENT_LABEL: Record<OfficeRequirement, string> = {
  none: 'Anywhere (classified automatically)',
  check_in: 'Check-in must be at an office',
  check_in_out: 'Check-in and check-out must be at an office',
};

export const OTHER_OFFICE_RULES = ['office', 'remote'] as const;
export const OTHER_OFFICE_LABEL: Record<(typeof OTHER_OFFICE_RULES)[number], string> = {
  office: 'Counts as office (any company office)',
  remote: 'Counts as away from office (only assigned offices count)',
};

/** The attendance notices a person can switch on or off for themselves. */
export const ATTENDANCE_NOTICES = [
  { key: 'check_in', label: 'Check-in recorded', description: 'A notice each time your check-in is recorded.', default: false, levels: ['super', 'hr', 'employee'] },
  { key: 'check_out', label: 'Check-out recorded', description: 'A notice each time your check-out is recorded.', default: false, levels: ['super', 'hr', 'employee'] },
  { key: 'mode_changed', label: 'Work arrangement changed', description: 'When your day changes between office, home and hybrid.', default: true, levels: ['super', 'hr', 'employee'] },
  { key: 'verification_failed', label: 'Location not verified', description: 'When your location could not be verified at a check-in or check-out.', default: true, levels: ['super', 'hr', 'employee'] },
  { key: 'missing_check_out', label: 'Missing check-out', description: 'The next morning, when you forgot to check out.', default: true, levels: ['super', 'hr', 'employee'] },
  { key: 'team_pending', label: 'Days waiting for verification', description: 'When someone you look after has a day waiting for location verification.', default: false, levels: ['super', 'hr'] },
] as const;
export type AttendanceNoticeKey = (typeof ATTENDANCE_NOTICES)[number]['key'];

const label = z.string().trim().min(2, 'At least 2 characters').max(40, 'At most 40 characters');
export const workModeSettingsInput = z.object({
  enabled: z.boolean(),
  /** Super Workspace only. */
  labels: z.object({ office: label, remote: label, hybrid: label }).optional(),
  minOfficeMinutes: z.number().int().min(0).max(720),
  minRemoteMinutes: z.number().int().min(0).max(720),
  transition: z.enum(TRANSITION_RULES),
  /** Readings vaguer than this are not trusted (unless certainly inside or outside). */
  maxAccuracyM: z.number().int().min(10).max(5000),
  otherOffices: z.enum(OTHER_OFFICE_RULES),
  officeRequirement: z.enum(OFFICE_REQUIREMENTS),
  /** Coordinates are removed after this many days (the office or home result stays). 0 keeps them. */
  locationRetentionDays: z.number().int().min(0).max(3650),
  /** Who may ask for a correction of the classification: the person themselves, or HR only. */
  employeeCanRequestCorrection: z.boolean(),
  /** Standard day for reports (hours worked against it). */
  standardHours: z.number().min(1).max(24),
}).strict();
export type WorkModeSettingsInput = z.infer<typeof workModeSettingsInput>;

export const DEFAULT_WORK_MODE_SETTINGS: Omit<WorkModeSettingsInput, 'labels'> & { labels: WorkModeLabels } = {
  enabled: true,
  labels: { ...DEFAULT_WORK_MODE_LABELS },
  minOfficeMinutes: 60,
  minRemoteMinutes: 60,
  transition: 'split',
  maxAccuracyM: 150,
  otherOffices: 'office',
  officeRequirement: 'none',
  locationRetentionDays: 90,
  employeeCanRequestCorrection: true,
  standardHours: 8,
};

const coord = { latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) };
export const officeGeofenceInput = z.object({
  ...coord,
  radiusM: z.number().int().min(25).max(5000),
  addressLine: z.string().trim().max(300).nullable().optional(),
  /** Off: the location stays in the company but is not an office geofence for attendance. */
  active: z.boolean().default(true),
}).strict();

export const newOfficeInput = z.object({
  name: z.string().trim().min(1).max(160),
  legalEntityId: z.uuid(),
  city: z.string().trim().max(120).nullable().optional(),
  ...coord,
  radiusM: z.number().int().min(25).max(5000),
  addressLine: z.string().trim().max(300).nullable().optional(),
}).strict();

export const SITE_KINDS = ['client_site', 'project_office', 'coworking', 'other'] as const;
export const SITE_KIND_LABEL: Record<(typeof SITE_KINDS)[number], string> = {
  client_site: 'Client site', project_office: 'Temporary project office', coworking: 'Co-working space', other: 'Other approved place',
};
export const workSiteInput = z.object({
  name: z.string().trim().min(1).max(160),
  kind: z.enum(SITE_KINDS),
  addressLine: z.string().trim().max(300).nullable().optional(),
  ...coord,
  radiusM: z.number().int().min(25).max(5000),
  countsAs: z.enum(['office', 'remote']),
  /** null: everyone may use it; otherwise only the people assigned to it. */
  everyone: z.boolean().default(false),
  active: z.boolean().default(true),
}).strict();
export type WorkSiteInput = z.infer<typeof workSiteInput>;

/** One person's attendance places and rules (anything left null follows the company setting). */
export const workAssignmentInput = z.object({
  employeeIds: z.array(z.uuid()).min(1).max(500),
  /** Offices (locations) they may check in at, besides their own work location. */
  officeIds: z.array(z.uuid()).max(50).optional(),
  siteIds: z.array(z.uuid()).max(50).optional(),
  /** add: these are added to what each person has; set: replace it. */
  mode: z.enum(['add', 'set', 'remove']).default('set'),
  officeRequirement: z.enum(OFFICE_REQUIREMENTS).nullable().optional(),
  minOfficeMinutes: z.number().int().min(0).max(720).nullable().optional(),
  minRemoteMinutes: z.number().int().min(0).max(720).nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
}).strict();
export type WorkAssignmentInput = z.infer<typeof workAssignmentInput>;

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date (YYYY-MM-DD)');

/** HR verifies or corrects the classification of one day; a reason is always recorded. */
export const workModeOverrideInput = z.object({
  employeeId: z.uuid(),
  workDate: isoDay,
  /** null removes the correction, so the automatic result applies again. */
  mode: z.enum(ATTENDANCE_WORK_MODES).nullable(),
  reason: z.string().trim().min(3, 'Give a reason').max(500),
}).strict();

export const workModeCheckpointInput = z.object({
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  accuracyM: z.number().min(0).max(100_000).optional(),
  locationStatus: z.enum(LOCATION_STATUSES).optional(),
  mockLocation: z.boolean().optional(),
}).refine((v) => (v.latitude === undefined) === (v.longitude === undefined), { message: 'Send both latitude and longitude', path: ['longitude'] });

export const attendanceNoticePrefsInput = z.record(z.string().max(40), z.boolean()).refine(
  (p) => Object.keys(p).every((k) => ATTENDANCE_NOTICES.some((n) => n.key === k)),
  { message: 'Unknown notice' },
);

// ---------------------------------------------------------------------------------------------------------------
// Dashboard, register and reports
// ---------------------------------------------------------------------------------------------------------------

/** The categories the dashboard cards and lists open. */
export const WORKFORCE_CATEGORIES = ['all', 'present', 'office', 'remote', 'hybrid', 'pending', 'not_checked_in', 'on_leave', 'incomplete', 'irregular', 'absent'] as const;
export type WorkforceCategory = (typeof WORKFORCE_CATEGORIES)[number];

const csvIds = z.preprocess(
  (v) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : v),
  z.array(z.uuid()).max(1000).optional(),
);
const csvModes = z.preprocess(
  (v) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : v),
  z.array(z.enum(WORK_MODE_STATES)).max(4).optional(),
);

export const workforceFilters = {
  departmentId: z.uuid().optional(),
  designationId: z.uuid().optional(),
  locationId: z.uuid().optional(),
  hrWorkspaceId: z.union([z.literal('central'), z.uuid()]).optional(),
  employeeId: z.uuid().optional(),
  managerId: z.uuid().optional(),
  level: z.enum(['super', 'hr', 'employee']).optional(),
  q: z.string().trim().max(100).optional(),
};

export const workforceDashboardQuery = z.object({
  date: isoDay.optional(),
  /** The trend runs over this range (default: the 14 days up to the date). */
  from: isoDay.optional(),
  to: isoDay.optional(),
  ...workforceFilters,
});

export const workforcePeopleQuery = z.object({
  date: isoDay.optional(),
  category: z.enum(WORKFORCE_CATEGORIES).default('all'),
  ...workforceFilters,
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(5).max(200).default(25),
});

export const workRegisterQuery = z.object({
  from: isoDay,
  to: isoDay,
  ...workforceFilters,
  modes: csvModes,
  status: z.enum(['present', 'absent', 'leave', 'incomplete', 'late', 'early_leave', 'irregular', 'pending']).optional(),
  verification: z.enum(['verified', 'unverified']).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(5).max(200).default(50),
}).refine((v) => v.to >= v.from, { message: 'to is before from', path: ['to'] });

export const REPORT_SHEETS = ['summary', 'register', 'office', 'remote', 'hybrid', 'events', 'exceptions', 'employees'] as const;
export type ReportSheet = (typeof REPORT_SHEETS)[number];
export const REPORT_SHEET_LABEL: Record<ReportSheet, string> = {
  summary: 'Attendance Summary',
  register: 'Detailed Register',
  office: 'Office Attendance',
  remote: 'Work From Home',
  hybrid: 'Hybrid Attendance',
  events: 'Check-In and Check-Out Log',
  exceptions: 'Exceptions & Corrections',
  employees: 'Employee Summary',
};

/** At most this many day rows in one report file; narrow the filters for more. */
export const WORK_REPORT_MAX_DAYS = 250_000;

export const workReportQuery = z.object({
  from: isoDay,
  to: isoDay,
  ...workforceFilters,
  format: z.enum(['xlsx', 'csv']).default('xlsx'),
  /** all: everything the person may see; selected: only the chosen people / departments. */
  scope: z.enum(['all', 'current', 'selected']).default('all'),
  employeeIds: csvIds,
  departmentIds: csvIds,
  modes: csvModes,
  status: z.enum(['present', 'absent', 'leave', 'incomplete', 'late', 'early_leave', 'irregular', 'pending']).optional(),
  verification: z.enum(['verified', 'unverified']).optional(),
  sheets: z.preprocess(
    (v) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : v),
    z.array(z.enum(REPORT_SHEETS)).min(1).max(REPORT_SHEETS.length).optional(),
  ),
  /** The screen the export was started from, kept in the audit trail. */
  section: z.string().trim().max(60).optional(),
}).refine((v) => v.to >= v.from, { message: 'to is before from', path: ['to'] })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 3660, { message: 'Ask for at most ten years at a time', path: ['to'] });
export type WorkReportQuery = z.infer<typeof workReportQuery>;

export const savedReportInput = z.object({
  name: z.string().trim().min(1).max(80),
  filters: z.record(z.string().max(40), z.union([z.string().max(2000), z.array(z.string().max(80)).max(1000)])),
}).strict();

export interface WorkModeTotals {
  office: number;
  remote: number;
  hybrid: number;
  pending: number;
}

export interface WorkforceDashboard {
  date: string;
  from: string;
  to: string;
  labels: WorkModeLabels;
  /** Org-wide numbers (true) or only the people the viewer may see (false). */
  orgWide: boolean;
  /** People the viewer can open in the lists. */
  visiblePeople: number;
  cards: {
    total: number;
    present: number;
    office: number;
    remote: number;
    hybrid: number;
    pending: number;
    notCheckedIn: number;
    onLeave: number;
    incomplete: number;
    irregular: number;
    absent: number;
    off: number;
    workingNow: number;
  };
  byDepartment: { id: string | null; name: string; total: number; present: number; office: number; remote: number; hybrid: number; pending: number }[];
  byLocation: { id: string | null; name: string; total: number; present: number; office: number; remote: number; hybrid: number; pending: number }[];
  byLevel: { level: 'super' | 'hr' | 'employee'; label: string; total: number; present: number; office: number; remote: number; hybrid: number; pending: number }[];
  trend: { date: string; office: number; remote: number; hybrid: number; pending: number; absent: number; leave: number }[];
  hours: { office: number; remote: number };
}

export interface WorkforcePersonRow {
  employeeId: string;
  name: string;
  code: string;
  level: 'super' | 'hr' | 'employee';
  department: string | null;
  designation: string | null;
  location: string | null;
  status: string;
  mode: WorkModeState | null;
  provisional: boolean;
  checkIn: string | null;
  checkOut: string | null;
  checkInPlace: string | null;
  checkOutPlace: string | null;
  officeMinutes: number;
  remoteMinutes: number;
  workedMinutes: number;
  issues: string[];
}
