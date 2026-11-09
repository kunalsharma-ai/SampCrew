import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { PostingInput, RequisitionInput, requisitionStatusInput } from '@crew/contracts';
import type { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { countBy, ilike, membershipUserNames, MongoService as DatabaseService, type TenantTx, usersTable } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { uniqueAs } from '../employees/employees.service';
import { employeeOfMember, loadRequisition, moneyText, REQ_FIELDS, reqAttrs, type RequisitionRow } from './recruitment-common';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

const isLive = (p: Doc | undefined) => !!p && !!p.published_at && !p.unpublished_at;

/** Names of the documents of `table` with the given ids. */
async function namesOf(tx: TenantTx, table: string, ids: unknown[]) {
  const wanted = [...new Set(ids.filter((x): x is string => typeof x === 'string'))];
  if (!wanted.length) return new Map<string, string>();
  return new Map((await tx.collection(table).find({ id: { $in: wanted } }, { projection: { name: 1 } })).map((d) => [d.id as string, d.name as string]));
}

/** Requisitions as the API returns them (the SQL REQ_COLUMNS), in the order given. */
async function requisitionViews(tx: TenantTx, reqs: Doc[]) {
  if (!reqs.length) return [];
  const ids = reqs.map((r) => r.id as string);
  const [entities, depts, locs, desigs, people] = await Promise.all([
    namesOf(tx, 'legal_entities', reqs.map((r) => r.legal_entity_id)),
    namesOf(tx, 'departments', reqs.map((r) => r.department_id)),
    namesOf(tx, 'locations', reqs.map((r) => r.location_id)),
    namesOf(tx, 'designations', reqs.map((r) => r.designation_id)),
    membershipUserNames(tx, reqs.flatMap((r) => [r.hiring_manager_membership_id, r.created_by_membership_id])),
  ]);
  const postings = new Map((await tx.collection('job_postings').find({ requisition_id: { $in: ids } })).map((p) => [p.requisition_id as string, p]));
  const active = await countBy(tx, 'applications', 'requisition_id', ids, { status: 'active' });
  const total = await countBy(tx, 'applications', 'requisition_id', ids);
  return reqs.map((r) => {
    const p = postings.get(r.id);
    return {
      id: r.id, code: r.code, title: r.title, status: r.status, statusReason: r.status_reason ?? null, legalEntityId: r.legal_entity_id, legalEntityName: entities.get(r.legal_entity_id) ?? null,
      departmentId: r.department_id, departmentName: depts.get(r.department_id) ?? null, locationId: r.location_id ?? null, locationName: locs.get(r.location_id) ?? null,
      designationId: r.designation_id ?? null, designationName: desigs.get(r.designation_id) ?? null, hiringManagerMembershipId: r.hiring_manager_membership_id,
      hiringManagerName: people.get(r.hiring_manager_membership_id) ?? null, employmentType: r.employment_type, workMode: r.work_mode, headcount: r.headcount, hiredCount: r.hired_count,
      reason: r.reason, replacingEmployeeId: r.replacing_employee_id ?? null, salaryMin: r.salary_min ?? null, salaryMax: r.salary_max ?? null, currency: r.currency,
      targetStartDate: r.target_start_date ?? null, justification: r.justification ?? null, description: r.description ?? null, scorecard: r.scorecard ?? [],
      approvalRequestId: r.approval_request_id ?? null, createdByMembershipId: r.created_by_membership_id ?? null, createdByName: people.get(r.created_by_membership_id) ?? null,
      approvedAt: r.approved_at ?? null, openedAt: r.opened_at ?? null, closedAt: r.closed_at ?? null, createdAt: r.created_at,
      postingId: p?.id ?? null, postingSlug: p?.slug ?? null, published: isLive(p),
      activeApplications: active.get(r.id) ?? 0, totalApplications: total.get(r.id) ?? 0,
    };
  });
}

async function requisitionView(tx: TenantTx, id: string) {
  const r = await tx.collection('job_requisitions').findOne({ id });
  return r ? (await requisitionViews(tx, [r]))[0]! : null;
}

const postingView = (p: Doc | undefined) =>
  p
    ? {
        id: p.id, requisitionId: p.requisition_id, publicTitle: p.public_title, slug: p.slug, summary: p.summary ?? null, description: p.description ?? null,
        locationText: p.location_text ?? null, showSalary: p.show_salary, publishedAt: p.published_at ?? null, unpublishedAt: p.unpublished_at ?? null, published: isLive(p),
      }
    : null;

const STATUS_RANK: Record<string, number> = { open: 0, pending_approval: 1, approved: 2, draft: 3, on_hold: 4 };

async function careerSite(tx: TenantTx) {
  const site = await tx.collection('career_sites').findOne({}, { projection: { slug: 1, enabled: 1 } });
  return site ? { slug: site.slug as string, enabled: site.enabled as boolean } : null;
}

/** Takes down a requisition's live posting. */
async function unpublish(tx: TenantTx, requisitionId: string) {
  await tx.collection('job_postings').update({ requisition_id: requisitionId, published_at: { $ne: null }, unpublished_at: null }, { $set: { unpublished_at: new Date() } });
}

const FIELD_COLUMNS: Record<keyof RequisitionInput, string> = {
  title: 'title', legalEntityId: 'legal_entity_id', departmentId: 'department_id', locationId: 'location_id', designationId: 'designation_id',
  hiringManagerMembershipId: 'hiring_manager_membership_id', employmentType: 'employment_type', workMode: 'work_mode', headcount: 'headcount',
  reason: 'reason', replacingEmployeeId: 'replacing_employee_id', salaryMin: 'salary_min', salaryMax: 'salary_max', currency: 'currency',
  targetStartDate: 'target_start_date', justification: 'justification', description: 'description', scorecard: 'scorecard',
};
/** Once approved, the budget and the shape of the role are fixed; wording and the scorecard can still change. */
const EDITABLE_AFTER_APPROVAL: (keyof RequisitionInput)[] = ['title', 'description', 'scorecard', 'targetStartDate', 'hiringManagerMembershipId'];

/** Job requisitions: raise, approve, open, hold, close; and the public posting for each. */
@Injectable()
export class RequisitionsService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly approvals: ApprovalsService,
  ) {}

  onModuleInit() {
    this.approvals.register('job_requisition', {
      permission: 'requisitions:approve',
      configurePermission: 'recruitment:configure',
      defaultSteps: [{ type: 'role', role: 'hr_admin' }],
      fallbackRole: 'tenant_owner',
      label: 'Job requisition',
      link: (id) => `/recruitment/jobs/${id}`,
      attributes: async (tx, id) => reqAttrs(await loadRequisition(tx, id)),
      onApproved: async (tx, req) => {
        const r = await tx.collection('job_requisitions').updateAndGet({ id: req.resource_id, status: 'pending_approval' }, { $set: { status: 'approved', approved_at: new Date(), status_reason: null } });
        if (!r) return;
        await this.audit.record(tx, { action: 'requisition.approved', resourceType: 'job_requisition', resourceId: req.resource_id });
        await this.notifications.notify(tx, {
          membershipIds: [r.created_by_membership_id, r.hiring_manager_membership_id],
          kind: 'requisition.approved',
          title: `${r.code} ${r.title} is approved. Open it to start hiring.`,
          link: `/recruitment/jobs/${req.resource_id}`,
        });
      },
      onRejected: async (tx, req) => {
        await tx.collection('job_requisitions').updateOne({ id: req.resource_id, status: 'pending_approval' }, { $set: { status: 'rejected' } });
        await this.audit.record(tx, { action: 'requisition.rejected', resourceType: 'job_requisition', resourceId: req.resource_id });
      },
    });
  }

  async list(q: { status?: string; scope?: 'all' | 'mine' }) {
    return this.db.tenant(async (tx) => {
      const and: Doc[] = [await this.authz.filter('requisitions:read', REQ_FIELDS, tx)];
      if (q.status) and.push({ status: q.status });
      if (q.scope === 'mine') {
        const me = requestContext.tenantActor().membershipId;
        and.push({ $or: [{ hiring_manager_membership_id: me }, { created_by_membership_id: me }] });
      }
      const rows = await tx.collection('job_requisitions').find({ $and: and });
      rows.sort((a, b) => (STATUS_RANK[a.status] ?? 5) - (STATUS_RANK[b.status] ?? 5) || new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      return requisitionViews(tx, rows.slice(0, 500));
    });
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await loadRequisition(tx, id);
      const attrs = reqAttrs(r);
      await this.authz.require('requisitions:read', attrs, tx);
      const row = await requisitionView(tx, id);
      const posting = postingView(await tx.collection('job_postings').findOne({ requisition_id: id }));
      const s = await this.authz.subject(tx);
      return {
        ...row,
        posting,
        careerSite: await careerSite(tx),
        can: {
          edit: can(s, 'requisitions:create', attrs).allowed,
          manageCandidates: can(s, 'candidates:manage', attrs).allowed,
          readCandidates: can(s, 'candidates:read', attrs).allowed,
          manageOffers: can(s, 'offers:manage', attrs).allowed,
        },
      };
    });
  }

  private async checkPlacement(tx: TenantTx, input: Partial<RequisitionInput>) {
    if (input.departmentId) {
      const d = await tx.collection('departments').findOne({ id: input.departmentId }, { projection: { legal_entity_id: 1 } });
      if (!d) throw Errors.badRequest('invalid_department', 'Choose a department in this workspace');
      if (d.legal_entity_id && input.legalEntityId && d.legal_entity_id !== input.legalEntityId) {
        throw Errors.badRequest('department_entity_mismatch', 'That department belongs to a different legal entity');
      }
    }
    if (input.hiringManagerMembershipId) {
      const m = await tx.collection('memberships').exists({ id: input.hiringManagerMembershipId, status: 'active' });
      if (!m) throw Errors.badRequest('invalid_hiring_manager', 'The hiring manager must be an active member of the workspace');
    }
  }

  private async nextCode(tx: TenantTx) {
    const series = tx.collection('requisition_number_series');
    await series.upsert({}, {});
    for (let i = 0; i < 1000; i++) {
      const s = (await series.updateAndGet({}, { $inc: { next_value: 1 } }))!;
      const code = `${s.prefix}${String(s.next_value - 1).padStart(s.padding, '0')}`;
      if (!(await tx.collection('job_requisitions').exists({ code }))) return code;
    }
    throw Errors.conflict('requisition_code_exhausted', 'Could not allocate a requisition number');
  }

  async create(input: RequisitionInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      await this.authz.require('requisitions:create', { legalEntityId: input.legalEntityId, departmentId: input.departmentId, locationId: input.locationId, membershipId: input.hiringManagerMembershipId }, tx);
      await this.checkPlacement(tx, input);
      const code = await this.nextCode(tx);
      const cols = Object.keys(FIELD_COLUMNS) as (keyof RequisitionInput)[];
      const row = await tx.collection('job_requisitions').insert({ code, created_by_membership_id: actor.membershipId, ...Object.fromEntries(cols.map((c) => [FIELD_COLUMNS[c], input[c] ?? null])) });
      await this.audit.record(tx, { action: 'requisition.created', resourceType: 'job_requisition', resourceId: row.id, changes: { code, ...input } });
      return requisitionView(tx, row.id);
    });
  }

  async update(id: string, input: Partial<RequisitionInput>) {
    return this.db.tenant(async (tx) => {
      const r = await loadRequisition(tx, id, true);
      await this.authz.require('requisitions:create', reqAttrs(r), tx);
      const entries = Object.entries(input).filter(([, v]) => v !== undefined) as [keyof RequisitionInput, unknown][];
      if (['pending_approval', 'filled', 'closed', 'cancelled'].includes(r.status)) {
        throw Errors.conflict('requisition_locked', `A requisition that is ${r.status.replace('_', ' ')} cannot be changed`);
      }
      if (!['draft', 'rejected'].includes(r.status)) {
        const blocked = entries.filter(([k]) => !EDITABLE_AFTER_APPROVAL.includes(k)).map(([k]) => k);
        if (blocked.length) throw Errors.conflict('requisition_approved', `After approval only the title, description, scorecard, start date and hiring manager can change. To change ${blocked.join(', ')}, raise a new requisition.`);
      }
      if (!entries.length) return null;
      const merged = { legalEntityId: r.legal_entity_id, departmentId: r.department_id, ...input } as Partial<RequisitionInput>;
      await this.checkPlacement(tx, merged);
      // The new placement must also be inside what the editor may raise.
      await this.authz.require('requisitions:create', {
        legalEntityId: merged.legalEntityId, departmentId: merged.departmentId, locationId: input.locationId === undefined ? r.location_id : input.locationId,
        membershipId: input.hiringManagerMembershipId ?? r.hiring_manager_membership_id,
      }, tx);
      await tx.collection('job_requisitions').updateOne({ id }, { $set: Object.fromEntries(entries.map(([k, v]) => [FIELD_COLUMNS[k], v])) });
      await this.audit.record(tx, { action: 'requisition.updated', resourceType: 'job_requisition', resourceId: id, changes: Object.fromEntries(entries) });
      return null;
    }).then((res) => res ?? this.get(id));
  }

  async submit(id: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const r = await loadRequisition(tx, id, true);
      await this.authz.require('requisitions:create', reqAttrs(r), tx);
      if (!['draft', 'rejected'].includes(r.status)) throw Errors.conflict('invalid_state', `This requisition is already ${r.status.replace('_', ' ')}`);
      const dept = (await tx.collection('departments').findOne({ id: r.department_id }, { projection: { name: 1 } }))!.name as string;
      const range = r.salary_min || r.salary_max ? `, budget ${[moneyText(r.salary_min, r.currency), moneyText(r.salary_max, r.currency)].filter(Boolean).join(' to ')}` : '';
      const summary = `${r.code} ${r.title}: ${r.headcount} ${r.headcount === 1 ? 'hire' : 'hires'} in ${dept} (${r.employment_type.replace('_', ' ')})${range}`;
      const approvalId = await this.approvals.start(tx, {
        resourceType: 'job_requisition', resourceId: id, subjectEmployeeId: await employeeOfMember(tx, actor.membershipId), summary,
      });
      await tx.collection('job_requisitions').updateOne({ id }, { $set: { status: 'pending_approval', approval_request_id: approvalId, status_reason: null } });
      await this.audit.record(tx, { action: 'requisition.submitted', resourceType: 'job_requisition', resourceId: id });
      return { status: 'pending_approval', approvalRequestId: approvalId };
    });
  }

  async setStatus(id: string, input: z.infer<typeof requisitionStatusInput>) {
    return this.db.tenant(async (tx) => {
      const r = await loadRequisition(tx, id, true);
      await this.authz.require('requisitions:create', reqAttrs(r), tx);
      const moves: Record<string, { from: string[]; to: string }> = {
        open: { from: ['approved'], to: 'open' },
        hold: { from: ['open'], to: 'on_hold' },
        reopen: { from: ['on_hold'], to: 'open' },
        close: { from: ['approved', 'open', 'on_hold'], to: 'closed' },
        cancel: { from: ['draft', 'pending_approval', 'rejected'], to: 'cancelled' },
      };
      const m = moves[input.action]!;
      const verb: Record<string, string> = { open: 'opened', hold: 'put on hold', reopen: 'reopened', close: 'closed', cancel: 'cancelled' };
      if (!m.from.includes(r.status)) throw Errors.conflict('invalid_state', `A requisition that is ${r.status.replace('_', ' ')} cannot be ${verb[input.action]}`);
      if (input.action === 'cancel' && r.status === 'pending_approval') {
        const ar = await tx.collection('job_requisitions').findOne({ id }, { projection: { approval_request_id: 1 } });
        if (ar?.approval_request_id) await this.approvals.cancel(tx, ar.approval_request_id);
      }
      const current = (await tx.collection('job_requisitions').findOne({ id }, { projection: { opened_at: 1 } }))!;
      await tx.collection('job_requisitions').updateOne({ id }, {
        $set: {
          status: m.to, status_reason: input.reason ?? null,
          ...(m.to === 'open' && !current.opened_at ? { opened_at: new Date() } : {}),
          ...(m.to === 'closed' || m.to === 'cancelled' ? { closed_at: new Date() } : {}),
        },
      });
      // A posting is only live while the requisition is open.
      if (m.to !== 'open') await unpublish(tx, id);
      await this.audit.record(tx, { action: `requisition.${input.action}`, resourceType: 'job_requisition', resourceId: id, metadata: { from: r.status, to: m.to, reason: input.reason } });
      return { status: m.to };
    });
  }

  /**
   * Active members to choose as hiring manager or interviewer. Available to anyone who raises requisitions or
   * runs a pipeline, even without access to the member directory.
   */
  async people(q?: string) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      if (!s.grants.some((g) => ['requisitions:create', 'candidates:manage', 'recruitment:configure'].includes(g.permission))) throw Errors.forbidden();
      const members = await tx.collection('memberships').find({ status: 'active' }, { projection: { user_id: 1, title: 1, department_id: 1 } });
      const users = await usersTable(tx);
      const userFilter: Doc = { id: { $in: members.map((m) => m.user_id) } };
      if (q) userFilter.$or = [{ full_name: ilike(q) }, { email: ilike(q) }];
      const found = new Map((await users.find(userFilter, { projection: { full_name: 1 } })).map((u) => [u.id as string, u.full_name as string]));
      const depts = await namesOf(tx, 'departments', members.map((m) => m.department_id));
      return members
        .filter((m) => found.has(m.user_id))
        .map((m) => ({ membershipId: m.id as string, name: found.get(m.user_id)!, title: m.title ?? null, departmentName: depts.get(m.department_id) ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 300);
    });
  }

  // Posting -----------------------------------------------------------------------------------------------

  async savePosting(id: string, input: PostingInput) {
    return this.db.tenant(async (tx) => {
      const r = await loadRequisition(tx, id);
      await this.authz.require('candidates:manage', reqAttrs(r), tx);
      if (['cancelled', 'rejected'].includes(r.status)) throw Errors.conflict('invalid_state', 'This requisition is not going ahead');
      const fields = { public_title: input.publicTitle, slug: input.slug, summary: input.summary, description: input.description, location_text: input.locationText, show_salary: input.showSalary };
      await tx.collection('job_postings').upsert({ requisition_id: id }, { requisition_id: id, ...fields }, { $set: fields })
        .catch(uniqueAs('slug_taken', 'Another job already uses this web address. Choose a different one.'));
      await this.audit.record(tx, { action: 'posting.saved', resourceType: 'job_requisition', resourceId: id, changes: { ...input, description: undefined } });
      return postingView(await tx.collection('job_postings').findOne({ requisition_id: id }));
    });
  }

  async publish(id: string, publish: boolean) {
    return this.db.tenant(async (tx) => {
      const r = await loadRequisition(tx, id);
      await this.authz.require('candidates:manage', reqAttrs(r), tx);
      const postings = tx.collection('job_postings');
      const p = await postings.findOne({ requisition_id: id }, { projection: { _id: 1 } });
      if (!p) throw Errors.badRequest('no_posting', 'Write the job posting first');
      if (publish && r.status !== 'open') throw Errors.conflict('requisition_not_open', 'Open the requisition before publishing its job posting');
      if (publish) await postings.updateOne({ id: p.id }, { $set: { published_at: new Date(), unpublished_at: null } });
      else await unpublish(tx, id);
      await this.audit.record(tx, { action: publish ? 'posting.published' : 'posting.unpublished', resourceType: 'job_requisition', resourceId: id });
      return { published: publish, careerSite: await careerSite(tx) };
    });
  }

  /** Called when someone is hired: counts the hire and closes the opening when every seat is filled. */
  async countHire(tx: TenantTx, r: RequisitionRow) {
    const filled = r.hired_count + 1 >= r.headcount;
    await tx.collection('job_requisitions').updateOne({ id: r.id }, { $inc: { hired_count: 1 }, ...(filled ? { $set: { status: 'filled', closed_at: new Date() } } : {}) });
    if (filled) {
      await unpublish(tx, r.id);
      await this.audit.record(tx, { action: 'requisition.filled', resourceType: 'job_requisition', resourceId: r.id, metadata: { headcount: r.headcount } });
    }
    return filled;
  }
}
