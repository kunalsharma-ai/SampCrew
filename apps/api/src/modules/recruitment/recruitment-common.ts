import type { ResourceAttributes } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { membershipUserNames, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';

/**
 * Access model. A requisition, and everything hanging off it (applications, interviews, offers), is placed in the
 * organisation by its department, legal entity and location; "own" means the requisition's hiring manager.
 * A candidate is visible to whoever can see one of their applications, or to anyone with workspace-wide access.
 */
export const REQ_SCOPE = {
  membershipId: 'r.hiring_manager_membership_id',
  legalEntityId: 'r.legal_entity_id',
  departmentId: 'r.department_id',
  locationId: 'r.location_id',
};

/** MongoDB fields of a requisition document, for AuthzService.filter. */
export const REQ_FIELDS = {
  membershipId: 'hiring_manager_membership_id',
  legalEntityId: 'legal_entity_id',
  departmentId: 'department_id',
  locationId: 'location_id',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

/** A candidate's display name, as the SQL `trim(first_name || ' ' || last_name)`. */
export const candidateName = (c: { first_name?: string | null; last_name?: string | null }) => `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim();

/** Requisition ids the member may see with `permission`, or null when they may see every requisition. */
export async function visibleRequisitionIds(tx: TenantTx, scope: Record<string, unknown>): Promise<string[] | null> {
  if (!Object.keys(scope).length) return null;
  return tx.collection('job_requisitions').distinct<string>('id', scope);
}

export interface RequisitionRow {
  id: string;
  code: string;
  title: string;
  status: string;
  legal_entity_id: string;
  department_id: string;
  location_id: string | null;
  designation_id: string | null;
  hiring_manager_membership_id: string;
  created_by_membership_id: string | null;
  employment_type: string;
  headcount: number;
  hired_count: number;
  salary_min: string | null;
  salary_max: string | null;
  currency: string;
  scorecard: string[];
}

export const reqAttrs = (r: Pick<RequisitionRow, 'hiring_manager_membership_id' | 'legal_entity_id' | 'department_id' | 'location_id'>): ResourceAttributes => ({
  membershipId: r.hiring_manager_membership_id,
  legalEntityId: r.legal_entity_id,
  departmentId: r.department_id,
  locationId: r.location_id,
});

export async function loadRequisition(tx: TenantTx, id: string, lock = false): Promise<RequisitionRow> {
  const reqs = tx.collection('job_requisitions');
  if (lock) await reqs.lock({ id });
  const r = await reqs.findOne({ id });
  if (!r) throw Errors.notFound('Requisition');
  return {
    id: r.id, code: r.code, title: r.title, status: r.status, legal_entity_id: r.legal_entity_id, department_id: r.department_id, location_id: r.location_id ?? null,
    designation_id: r.designation_id ?? null, hiring_manager_membership_id: r.hiring_manager_membership_id, created_by_membership_id: r.created_by_membership_id ?? null,
    employment_type: r.employment_type, headcount: r.headcount, hired_count: r.hired_count, salary_min: r.salary_min ?? null, salary_max: r.salary_max ?? null,
    currency: r.currency, scorecard: r.scorecard ?? [],
  };
}

export interface ApplicationRow {
  id: string;
  candidate_id: string;
  requisition_id: string;
  stage_id: string;
  stage_kind: string;
  status: string;
  candidate_name: string;
  candidate_email: string | null;
  anonymized: boolean;
  req: RequisitionRow;
}

export async function loadApplication(tx: TenantTx, id: string, lock = false): Promise<ApplicationRow> {
  const apps = tx.collection('applications');
  if (lock) await apps.lock({ id });
  const a = await apps.findOne({ id });
  if (!a) throw Errors.notFound('Application');
  const c = (await tx.collection('candidates').findOne({ id: a.candidate_id }))!;
  const stage = (await tx.collection('recruitment_stages').findOne({ id: a.stage_id }))!;
  return {
    id: a.id, candidate_id: a.candidate_id, requisition_id: a.requisition_id, stage_id: a.stage_id, stage_kind: stage.kind, status: a.status,
    candidate_name: candidateName(c), candidate_email: c.email ?? null, anonymized: !!c.anonymized_at,
    req: await loadRequisition(tx, a.requisition_id),
  };
}

/** Appends to the pipeline history. Kept free of personal free text so erasure never has to rewrite it. */
export async function recordEvent(
  tx: TenantTx,
  applicationId: string,
  kind: string,
  extra: { fromStageId?: string | null; toStageId?: string | null; detail?: Record<string, unknown> } = {},
) {
  const actor = requestContext.get()?.actor;
  await tx.collection('application_events').insert({
    application_id: applicationId, kind, from_stage_id: extra.fromStageId ?? null, to_stage_id: extra.toStageId ?? null, detail: extra.detail ?? {},
    actor_membership_id: actor?.kind === 'user' ? actor.membershipId : null,
  });
  const app = await tx.collection('applications').findOne({ id: applicationId }, { projection: { candidate_id: 1 } });
  if (app) await tx.collection('candidates').updateOne({ id: app.candidate_id }, { $set: { last_activity_at: new Date() } });
}

export async function stageOfKind(tx: TenantTx, kind: 'new' | 'hired') {
  const s = await tx.collection('recruitment_stages').findOne({ kind, archived_at: null });
  if (!s) throw Errors.conflict('pipeline_incomplete', `The pipeline has no "${kind}" stage. Add one under Recruitment settings.`);
  return s.id as string;
}

/** Name of a workspace member, for summaries and emails. */
export async function memberName(tx: TenantTx, membershipId: string | null) {
  if (!membershipId) return null;
  return (await membershipUserNames(tx, [membershipId])).get(membershipId) ?? null;
}

/** The employee record of a member (for approvals and for setting the new hire's manager). */
export async function employeeOfMember(tx: TenantTx, membershipId: string | null) {
  if (!membershipId) return null;
  return ((await tx.collection('employees').findOne({ membership_id: membershipId, status: { $ne: 'exited' } }, { projection: { id: 1 } }))?.id as string | undefined) ?? null;
}

export const CANDIDATE_FOOTER = 'Sent by SampCrew by SAMPLEDGE on behalf of the hiring organisation named above. You received this because you applied for a role or were put forward for one.';

/** Formats a decimal string exactly (no floating point), with Indian digit grouping for INR. */
export function moneyText(amount: string | null, currency: string) {
  if (amount === null) return null;
  const [whole = '0', frac = ''] = amount.split('.');
  const grouped = currency === 'INR' ? whole.replace(/(\d)(?=(\d\d)+\d$)/g, '$1,') : whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = /[1-9]/.test(frac) ? `.${frac.padEnd(2, '0').slice(0, 2)}` : '';
  return `${currency} ${grouped}${cents}`;
}

/**
 * Withdraws an application's open offers when the application closes, cancelling any approval still waiting
 * so approvers are not asked to sign off an offer for someone who is no longer in the process.
 */
export async function withdrawOpenOffers(tx: TenantTx, applicationId: string, includeAccepted = false) {
  const statuses = ['draft', 'pending_approval', 'approved', 'sent', ...(includeAccepted ? ['accepted'] : [])];
  const offers = tx.collection('offers');
  const rows = (await offers.find({ application_id: applicationId, status: { $in: statuses } }, { projection: { id: 1, approval_request_id: 1, status: 1 } })) as Doc[];
  if (rows.length) await offers.update({ id: { $in: rows.map((r) => r.id) } }, { $set: { status: 'withdrawn' } });
  for (const r of rows.filter((x) => x.status === 'pending_approval' && x.approval_request_id)) {
    await tx.collection('approval_steps').update({ request_id: r.approval_request_id, status: { $in: ['pending', 'waiting'] } }, { $set: { status: 'cancelled' } });
    await tx.collection('approval_requests').updateOne({ id: r.approval_request_id, status: 'pending' }, { $set: { status: 'cancelled', decided_at: new Date() } });
  }
  for (const r of rows) await recordEvent(tx, applicationId, 'offer_withdrawn', { detail: { offerId: r.id } });
  return rows.length;
}
