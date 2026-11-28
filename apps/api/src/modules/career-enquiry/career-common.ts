import { CAREER_CENTRAL, DEFAULT_CAREER_STAGES, formatCareerCode, type CareerStage } from '@crew/contracts';
import { requestContext } from '../../platform/context/request-context';
import { membershipUserNames, type TenantTx } from '../../platform/database/mongo.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Doc = Record<string, any>;

export const actorMembership = () => {
  const a = requestContext.get()?.actor;
  return a?.kind === 'user' ? a.membershipId : null;
};

/** The company's Career Enquiry settings (created on first use). */
export async function careerSettings(tx: TenantTx): Promise<Doc> {
  const t = tx.collection('career_settings');
  return (await t.findOne({})) ?? (await t.upsert({}, {}));
}

export function careerStagesOf(settings: Doc | null | undefined): CareerStage[] {
  const saved = (settings?.stages as CareerStage[] | undefined) ?? [];
  return (saved.length ? saved : DEFAULT_CAREER_STAGES).map((s, i) => ({ ...s, position: i }));
}

/** The next CE-000124 for this company. */
export async function nextCareerCode(tx: TenantTx): Promise<string> {
  const settings = tx.collection('career_settings');
  await settings.upsert({}, {});
  for (let i = 0; i < 1000; i++) {
    const s = (await settings.updateAndGet({}, { $inc: { next_number: 1 } }))!;
    const code = formatCareerCode((s.next_number as number) - 1);
    if (!(await tx.collection('career_applications').exists({ code }))) return code;
  }
  throw new Error('Could not allocate an application number');
}

/** Appends to an application's history and marks it active now. */
export async function careerEvent(
  tx: TenantTx,
  applicationId: string,
  kind: string,
  extra: { from?: string | null; to?: string | null; comment?: string | null; detail?: Doc; actor?: string | null } = {},
) {
  await tx.collection('career_application_events').insert({
    application_id: applicationId, kind, from_stage: extra.from ?? null, to_stage: extra.to ?? null, comment: extra.comment ?? null,
    detail: extra.detail ?? {}, actor_membership_id: extra.actor === undefined ? actorMembership() : extra.actor,
  });
  await tx.collection('career_applications').updateOne({ id: applicationId }, { $set: { last_activity_at: new Date() } });
}

/**
 * Writes a Career Enquiry event into the candidate's Candidate CRM timeline too, so the history is complete from both
 * places. Kept to facts (no free text a later erasure would have to find).
 */
export async function crmTimeline(tx: TenantTx, candidateId: string, detail: Doc) {
  await tx.collection('candidate_activities').insert({
    candidate_id: candidateId, kind: 'career_event', automatic: true, detail, occurred_at: new Date(), created_by_membership_id: actorMembership(),
  });
  await tx.collection('candidates').updateOne({ id: candidateId }, { $set: { last_activity_at: new Date() } });
}

/** People's names by membership id. */
export async function namesOf(tx: TenantTx, ids: (string | null | undefined)[]) {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return new Map<string, string>();
  const names = await membershipUserNames(tx, list);
  return new Map(list.map((id) => [id, names.get(id) ?? 'Someone']));
}

/** Splits "Kunal Sharma" into first and last name; one word is a first name. */
export function splitFullName(full: string): { first: string; last: string } {
  const parts = full.trim().replace(/\s+/g, ' ').split(' ');
  if (parts.length === 1) return { first: parts[0]!, last: '' };
  return { first: parts.slice(0, -1).join(' '), last: parts.at(-1)! };
}

export const accessKeyOf = (hrWorkspaceId: string | null | undefined) => hrWorkspaceId ?? CAREER_CENTRAL;
