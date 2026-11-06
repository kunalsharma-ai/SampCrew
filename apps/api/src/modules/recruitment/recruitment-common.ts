import type { ResourceAttributes } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { many, one, type Tx } from '../../platform/database/database.service';
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

export async function loadRequisition(tx: Tx, id: string, lock = false): Promise<RequisitionRow> {
  const r = await one<RequisitionRow>(
    tx,
    `select id, code, title, status, legal_entity_id, department_id, location_id, designation_id, hiring_manager_membership_id, created_by_membership_id,
            employment_type, headcount, hired_count, salary_min::text, salary_max::text, currency, scorecard
       from job_requisitions where id = $1${lock ? ' for update' : ''}`,
    [id],
  );
  if (!r) throw Errors.notFound('Requisition');
  return r;
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

export async function loadApplication(tx: Tx, id: string, lock = false): Promise<ApplicationRow> {
  const a = await one<Omit<ApplicationRow, 'req'>>(
    tx,
    `select a.id, a.candidate_id, a.requisition_id, a.stage_id, s.kind as stage_kind, a.status,
            trim(c.first_name || ' ' || c.last_name) as candidate_name, c.email as candidate_email, c.anonymized_at is not null as anonymized
       from applications a join candidates c on c.id = a.candidate_id join recruitment_stages s on s.id = a.stage_id
      where a.id = $1${lock ? ' for update of a' : ''}`,
    [id],
  );
  if (!a) throw Errors.notFound('Application');
  return { ...a, req: await loadRequisition(tx, a.requisition_id) };
}

/** Appends to the pipeline history. Kept free of personal free text so erasure never has to rewrite it. */
export async function recordEvent(
  tx: Tx,
  applicationId: string,
  kind: string,
  extra: { fromStageId?: string | null; toStageId?: string | null; detail?: Record<string, unknown> } = {},
) {
  const actor = requestContext.get()?.actor;
  await tx.query(
    `insert into application_events (tenant_id, application_id, kind, from_stage_id, to_stage_id, detail, actor_membership_id) values (app_tenant_id(), $1, $2, $3, $4, $5, $6)`,
    [applicationId, kind, extra.fromStageId ?? null, extra.toStageId ?? null, JSON.stringify(extra.detail ?? {}), actor?.kind === 'user' ? actor.membershipId : null],
  );
  await tx.query(`update candidates set last_activity_at = now() where id = (select candidate_id from applications where id = $1)`, [applicationId]);
}

export async function stageOfKind(tx: Tx, kind: 'new' | 'hired') {
  const s = await one<{ id: string }>(tx, `select id from recruitment_stages where kind = $1 and archived_at is null`, [kind]);
  if (!s) throw Errors.conflict('pipeline_incomplete', `The pipeline has no "${kind}" stage. Add one under Recruitment settings.`);
  return s.id;
}

/** Name of a workspace member, for summaries and emails. */
export async function memberName(tx: Tx, membershipId: string | null) {
  if (!membershipId) return null;
  return (await one<{ name: string }>(tx, `select u.full_name as name from memberships m join users u on u.id = m.user_id where m.id = $1`, [membershipId]))?.name ?? null;
}

/** The employee record of a member (for approvals and for setting the new hire's manager). */
export async function employeeOfMember(tx: Tx, membershipId: string | null) {
  if (!membershipId) return null;
  return (await one<{ id: string }>(tx, `select id from employees where membership_id = $1 and status <> 'exited'`, [membershipId]))?.id ?? null;
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
export async function withdrawOpenOffers(tx: Tx, applicationId: string, includeAccepted = false) {
  const statuses = ['draft', 'pending_approval', 'approved', 'sent', ...(includeAccepted ? ['accepted'] : [])];
  const rows = await many<{ id: string; approval_request_id: string | null; status: string }>(
    tx,
    `update offers o set status = 'withdrawn' from offers prev where prev.id = o.id and o.application_id = $1 and o.status = any($2::text[])
     returning o.id, o.approval_request_id, prev.status`,
    [applicationId, statuses],
  );
  for (const r of rows.filter((x) => x.status === 'pending_approval' && x.approval_request_id)) {
    await tx.query(`update approval_steps set status = 'cancelled' where request_id = $1 and status in ('pending', 'waiting')`, [r.approval_request_id]);
    await tx.query(`update approval_requests set status = 'cancelled', decided_at = now() where id = $1 and status = 'pending'`, [r.approval_request_id]);
  }
  for (const r of rows) await recordEvent(tx, applicationId, 'offer_withdrawn', { detail: { offerId: r.id } });
  return rows.length;
}
