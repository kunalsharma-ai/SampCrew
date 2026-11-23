import {
  ATS_EVENT_CRM_STAGE, CRM_SOURCES_DEFAULT, DEFAULT_CRM_STAGES, experienceText, formatCandidateCode, noticeText, type CrmOption, type CrmStage,
} from '@crew/contracts';
import { requestContext } from '../../platform/context/request-context';
import type { TenantTx } from '../../platform/database/mongo.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Doc = Record<string, any>;

export const actorMembership = () => {
  const a = requestContext.get()?.actor;
  return a?.kind === 'user' ? a.membershipId : null;
};

/** The company's CRM settings document (created on first use). */
export async function crmSettings(tx: TenantTx): Promise<Doc> {
  const t = tx.collection('candidate_crm_settings');
  return (await t.findOne({})) ?? (await t.upsert({}, {}));
}

export function stagesOf(settings: Doc | null | undefined): CrmStage[] {
  const saved = (settings?.stages as CrmStage[] | undefined) ?? [];
  return (saved.length ? saved : DEFAULT_CRM_STAGES).map((s, i) => ({ ...s, position: i }));
}

export function sourcesOf(settings: Doc | null | undefined): CrmOption[] {
  const saved = (settings?.sources as CrmOption[] | undefined) ?? [];
  return saved.length ? saved : CRM_SOURCES_DEFAULT.map(([key, label]) => ({ key, label, active: true }));
}

/**
 * Gives candidates added before the CRM, or by another path (career site, ATS, demo data), their candidate number and
 * starting stage. Runs when the CRM reads candidates; cheap when there is nothing to do.
 */
export async function ensureCrmRecords(tx: TenantTx): Promise<void> {
  const candidates = tx.collection('candidates');
  if (!(await candidates.exists({ $or: [{ candidate_code: null }, { crm_stage: null }] }))) return;
  const missing = await candidates.find({ $or: [{ candidate_code: null }, { crm_stage: null }] }, { projection: { candidate_code: 1, crm_stage: 1, created_at: 1 }, sort: { created_at: 1 } });
  for (const c of missing) {
    const set: Doc = {};
    if (!c.candidate_code) set.candidate_code = await nextCandidateCode(tx);
    if (!c.crm_stage) {
      const apps = await tx.collection('applications').find({ candidate_id: c.id }, { projection: { status: 1 } });
      set.crm_stage = apps.some((a) => a.status === 'hired') ? 'joined' : apps.length && apps.every((a) => a.status === 'rejected') ? 'rejected' : 'new';
      set.crm_stage_entered_at = c.created_at ?? new Date();
    }
    await candidates.updateOne({ id: c.id }, { $set: set });
  }
}

/** The next CAN-000124 for this company. */
export async function nextCandidateCode(tx: TenantTx): Promise<string> {
  const settings = tx.collection('candidate_crm_settings');
  await settings.upsert({}, {});
  for (let i = 0; i < 1000; i++) {
    const s = (await settings.updateAndGet({}, { $inc: { next_number: 1 } }))!;
    const code = formatCandidateCode((s.next_number as number) - 1);
    if (!(await tx.collection('candidates').exists({ candidate_code: code }))) return code;
  }
  throw new Error('Could not allocate a candidate number');
}

export interface ActivityExtra {
  automatic?: boolean;
  detail?: Doc;
  remarks?: string | null;
  subject?: string | null;
  outcome?: string | null;
  durationMinutes?: number | null;
  occurredAt?: Date;
  hrWorkspaceId?: string | null;
}

/** Appends to the candidate's activity history and marks the candidate as active now. */
export async function recordActivity(tx: TenantTx, candidateId: string, kind: string, extra: ActivityExtra = {}) {
  const row = await tx.collection('candidate_activities').insert({
    candidate_id: candidateId, kind, automatic: extra.automatic ?? true, detail: extra.detail ?? {}, remarks: extra.remarks ?? null, subject: extra.subject ?? null,
    outcome: extra.outcome ?? null, duration_minutes: extra.durationMinutes ?? null, occurred_at: extra.occurredAt ?? new Date(),
    hr_workspace_id: extra.hrWorkspaceId ?? null, created_by_membership_id: actorMembership(),
  });
  await tx.collection('candidates').updateOne({ id: candidateId }, { $set: { last_activity_at: new Date() } });
  return row.id as string;
}

/** Keeps candidates.next_follow_up_at (used by the list, filters and sorting) equal to their earliest open follow-up. */
export async function refreshNextFollowUp(tx: TenantTx, candidateId: string) {
  const next = await tx.collection('candidate_follow_ups').findOne({ candidate_id: candidateId, status: { $in: ['pending', 'rescheduled'] } }, { sort: { due_at: 1 }, projection: { due_at: 1 } });
  await tx.collection('candidates').updateOne({ id: candidateId }, { $set: { next_follow_up_at: next?.due_at ?? null } });
}

/**
 * Keeps the CRM stage in step with the ATS: an interview booked, feedback given, an offer sent or accepted, or a hire
 * moves the candidate forward (never back, and never out of On Hold or a closed stage someone chose). Each move is
 * written to the CRM timeline like a manual one. Called from the ATS's own event recorder.
 */
export async function syncCrmFromAts(tx: TenantTx, applicationId: string, kind: string, detail: Doc = {}) {
  const app = await tx.collection('applications').findOne({ id: applicationId }, { projection: { candidate_id: 1, requisition_id: 1 } });
  if (!app) return;
  const req = await tx.collection('job_requisitions').findOne({ id: app.requisition_id }, { projection: { code: 1, title: 1 } });
  const job = req ? `${req.code} ${req.title}` : null;
  const SHOWN = new Set(['applied', 'stage_changed', 'rejected', 'withdrawn', 'reopened', 'interview_scheduled', 'interview_cancelled', 'feedback_submitted', 'offer_sent', 'offer_accepted', 'offer_declined', 'offer_withdrawn', 'hired']);
  if (SHOWN.has(kind)) {
    await tx.collection('candidate_activities').insert({
      candidate_id: app.candidate_id, kind: kind === 'applied' ? 'applied' : 'ats_event', automatic: true,
      detail: { atsKind: kind, applicationId, requisitionId: app.requisition_id, job, ...pick(detail, ['reason', 'source']) }, occurred_at: new Date(), created_by_membership_id: actorMembership(),
    });
  }
  const target = ATS_EVENT_CRM_STAGE[kind];
  if (!target) return;
  const c = await tx.collection('candidates').findOne({ id: app.candidate_id }, { projection: { crm_stage: 1, anonymized_at: 1 } });
  if (!c || c.anonymized_at) return;
  const stages = stagesOf(await tx.collection('candidate_crm_settings').findOne({}));
  const from = stages.find((s) => s.key === (c.crm_stage ?? 'new'));
  const to = stages.find((s) => s.key === target && s.active);
  if (!to || (from && (from.kind !== 'open' || from.position >= to.position))) return;
  await tx.collection('candidates').updateOne({ id: app.candidate_id }, { $set: { crm_stage: to.key, crm_stage_entered_at: new Date() } });
  await tx.collection('candidate_activities').insert({
    candidate_id: app.candidate_id, kind: 'stage_changed', automatic: true, detail: { from: from?.key ?? null, to: to.key, via: 'ats', atsKind: kind, job }, occurred_at: new Date(),
    created_by_membership_id: actorMembership(),
  });
}

const pick = (o: Doc, keys: string[]) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

/** Text cells for lists and exports. */
export const describe = {
  experience: (m: number | null | undefined) => experienceText(m),
  notice: (n: Doc | null | undefined) => noticeText(n as never),
};

/** The company's time zone (for "today" in follow-ups and the overview). */
export async function tenantZone(tx: TenantTx): Promise<string> {
  return ((await tx.collection('tenants').findOne({}, { projection: { timezone: 1 } }))?.timezone as string | undefined) ?? 'UTC';
}

function zoneOffsetMs(tz: string, at: Date) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(at).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - Math.floor(at.getTime() / 1000) * 1000;
  } catch {
    return 0;
  }
}

/** Start and end of the day `at` falls on, in the time zone, and that date as YYYY-MM-DD. */
export function dayBounds(tz: string, at = new Date()) {
  const offset = zoneOffsetMs(tz, at);
  const date = new Date(at.getTime() + offset).toISOString().slice(0, 10);
  const start = new Date(Date.parse(`${date}T00:00:00Z`) - offset);
  return { start, end: new Date(start.getTime() + 86_400_000), date };
}

/** A pattern matching a stored phone number that contains these digits, whatever spaces or dashes it was written with. */
export const phonePattern = (digits: string, anchored = true) => `${digits.split('').join('\\D*')}${anchored ? '\\D*$' : ''}`;
