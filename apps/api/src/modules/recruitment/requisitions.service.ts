import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { PostingInput, RequisitionInput, requisitionStatusInput } from '@crew/contracts';
import type { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { uniqueAs } from '../employees/employees.service';
import { employeeOfMember, loadRequisition, moneyText, REQ_SCOPE, reqAttrs, type RequisitionRow } from './recruitment-common';

const REQ_COLUMNS = `r.id, r.code, r.title, r.status, r.status_reason as "statusReason", r.legal_entity_id as "legalEntityId", le.name as "legalEntityName",
  r.department_id as "departmentId", d.name as "departmentName", r.location_id as "locationId", l.name as "locationName",
  r.designation_id as "designationId", dg.name as "designationName", r.hiring_manager_membership_id as "hiringManagerMembershipId",
  hm.full_name as "hiringManagerName", r.employment_type as "employmentType", r.work_mode as "workMode", r.headcount, r.hired_count as "hiredCount",
  r.reason, r.replacing_employee_id as "replacingEmployeeId", r.salary_min::text as "salaryMin", r.salary_max::text as "salaryMax", r.currency,
  to_char(r.target_start_date, 'YYYY-MM-DD') as "targetStartDate", r.justification, r.description, r.scorecard,
  r.approval_request_id as "approvalRequestId", r.created_by_membership_id as "createdByMembershipId", cb.full_name as "createdByName",
  r.approved_at as "approvedAt", r.opened_at as "openedAt", r.closed_at as "closedAt", r.created_at as "createdAt",
  p.id as "postingId", p.slug as "postingSlug", (p.published_at is not null and p.unpublished_at is null) as "published",
  (select count(*)::int from applications a where a.requisition_id = r.id and a.status = 'active') as "activeApplications",
  (select count(*)::int from applications a where a.requisition_id = r.id) as "totalApplications"`;
const REQ_FROM = `job_requisitions r
  join legal_entities le on le.id = r.legal_entity_id
  join departments d on d.id = r.department_id
  left join locations l on l.id = r.location_id
  left join designations dg on dg.id = r.designation_id
  join memberships hmm on hmm.id = r.hiring_manager_membership_id join users hm on hm.id = hmm.user_id
  left join memberships cbm on cbm.id = r.created_by_membership_id left join users cb on cb.id = cbm.user_id
  left join job_postings p on p.requisition_id = r.id`;

const FIELD_COLUMNS: Record<keyof RequisitionInput, string> = {
  title: 'title', legalEntityId: 'legal_entity_id', departmentId: 'department_id', locationId: 'location_id', designationId: 'designation_id',
  hiringManagerMembershipId: 'hiring_manager_membership_id', employmentType: 'employment_type', workMode: 'work_mode', headcount: 'headcount',
  reason: 'reason', replacingEmployeeId: 'replacing_employee_id', salaryMin: 'salary_min', salaryMax: 'salary_max', currency: 'currency',
  targetStartDate: 'target_start_date', justification: 'justification', description: 'description', scorecard: 'scorecard',
};
/** Once approved, the budget and the shape of the role are fixed; wording and the scorecard can still change. */
const EDITABLE_AFTER_APPROVAL: (keyof RequisitionInput)[] = ['title', 'description', 'scorecard', 'targetStartDate', 'hiringManagerMembershipId'];

const POSTING_COLUMNS = `p.id, p.requisition_id as "requisitionId", p.public_title as "publicTitle", p.slug, p.summary, p.description,
  p.location_text as "locationText", p.show_salary as "showSalary", p.published_at as "publishedAt", p.unpublished_at as "unpublishedAt",
  (p.published_at is not null and p.unpublished_at is null) as "published"`;

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
        const r = await one<{ code: string; title: string; created_by_membership_id: string | null; hiring_manager_membership_id: string }>(
          tx,
          `update job_requisitions set status = 'approved', approved_at = now(), status_reason = null where id = $1 and status = 'pending_approval'
           returning code, title, created_by_membership_id, hiring_manager_membership_id`,
          [req.resource_id],
        );
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
        await tx.query(`update job_requisitions set status = 'rejected' where id = $1 and status = 'pending_approval'`, [req.resource_id]);
        await this.audit.record(tx, { action: 'requisition.rejected', resourceType: 'job_requisition', resourceId: req.resource_id });
      },
    });
  }

  async list(q: { status?: string; scope?: 'all' | 'mine' }) {
    return this.db.tenant(async (tx) => {
      const params: unknown[] = [];
      const where = [await this.authz.predicate('requisitions:read', REQ_SCOPE, params, tx)];
      if (q.status) {
        params.push(q.status);
        where.push(`r.status = $${params.length}`);
      }
      if (q.scope === 'mine') {
        params.push(requestContext.tenantActor().membershipId);
        where.push(`(r.hiring_manager_membership_id = $${params.length} or r.created_by_membership_id = $${params.length})`);
      }
      return many(tx, `select ${REQ_COLUMNS} from ${REQ_FROM} where ${where.join(' and ')}
                        order by case r.status when 'open' then 0 when 'pending_approval' then 1 when 'approved' then 2 when 'draft' then 3 when 'on_hold' then 4 else 5 end, r.created_at desc
                        limit 500`, params);
    });
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await loadRequisition(tx, id);
      const attrs = reqAttrs(r);
      await this.authz.require('requisitions:read', attrs, tx);
      const row = await one(tx, `select ${REQ_COLUMNS} from ${REQ_FROM} where r.id = $1`, [id]);
      const posting = await one(tx, `select ${POSTING_COLUMNS} from job_postings p where p.requisition_id = $1`, [id]);
      const s = await this.authz.subject(tx);
      const site = await one<{ slug: string; enabled: boolean }>(tx, 'select slug, enabled from career_sites');
      return {
        ...row,
        posting,
        careerSite: site ?? null,
        can: {
          edit: can(s, 'requisitions:create', attrs).allowed,
          manageCandidates: can(s, 'candidates:manage', attrs).allowed,
          readCandidates: can(s, 'candidates:read', attrs).allowed,
          manageOffers: can(s, 'offers:manage', attrs).allowed,
        },
      };
    });
  }

  private async checkPlacement(tx: Tx, input: Partial<RequisitionInput>) {
    if (input.departmentId) {
      const d = await one<{ legal_entity_id: string | null }>(tx, 'select legal_entity_id from departments where id = $1', [input.departmentId]);
      if (!d) throw Errors.badRequest('invalid_department', 'Choose a department in this workspace');
      if (d.legal_entity_id && input.legalEntityId && d.legal_entity_id !== input.legalEntityId) {
        throw Errors.badRequest('department_entity_mismatch', 'That department belongs to a different legal entity');
      }
    }
    if (input.hiringManagerMembershipId) {
      const m = await one(tx, `select 1 from memberships where id = $1 and status = 'active'`, [input.hiringManagerMembershipId]);
      if (!m) throw Errors.badRequest('invalid_hiring_manager', 'The hiring manager must be an active member of the workspace');
    }
  }

  private async nextCode(tx: Tx) {
    await tx.query(`insert into requisition_number_series (tenant_id) values (app_tenant_id()) on conflict do nothing`);
    for (let i = 0; i < 1000; i++) {
      const s = (await one<{ prefix: string; padding: number; n: number }>(
        tx, `update requisition_number_series set next_value = next_value + 1 where tenant_id = app_tenant_id() returning prefix, padding, next_value - 1 as n`,
      ))!;
      const code = `${s.prefix}${String(s.n).padStart(s.padding, '0')}`;
      if (!(await one(tx, 'select 1 from job_requisitions where code = $1', [code]))) return code;
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
      const row = (await one<{ id: string }>(
        tx,
        `insert into job_requisitions (tenant_id, code, created_by_membership_id, ${cols.map((c) => FIELD_COLUMNS[c]).join(', ')})
         values (app_tenant_id(), $1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}) returning id`,
        [code, actor.membershipId, ...cols.map((c) => input[c])],
      ))!;
      await this.audit.record(tx, { action: 'requisition.created', resourceType: 'job_requisition', resourceId: row.id, changes: { code, ...input } });
      return one(tx, `select ${REQ_COLUMNS} from ${REQ_FROM} where r.id = $1`, [row.id]);
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
      const params: unknown[] = [id];
      const sets = entries.map(([k, v]) => {
        params.push(v);
        return `${FIELD_COLUMNS[k]} = $${params.length}`;
      });
      await tx.query(`update job_requisitions set ${sets.join(', ')} where id = $1`, params);
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
      const dept = (await one<{ name: string }>(tx, 'select name from departments where id = $1', [r.department_id]))!.name;
      const range = r.salary_min || r.salary_max ? `, budget ${[moneyText(r.salary_min, r.currency), moneyText(r.salary_max, r.currency)].filter(Boolean).join(' to ')}` : '';
      const summary = `${r.code} ${r.title}: ${r.headcount} ${r.headcount === 1 ? 'hire' : 'hires'} in ${dept} (${r.employment_type.replace('_', ' ')})${range}`;
      const approvalId = await this.approvals.start(tx, {
        resourceType: 'job_requisition', resourceId: id, subjectEmployeeId: await employeeOfMember(tx, actor.membershipId), summary,
      });
      await tx.query(`update job_requisitions set status = 'pending_approval', approval_request_id = $2, status_reason = null where id = $1`, [id, approvalId]);
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
        const ar = await one<{ approval_request_id: string | null }>(tx, 'select approval_request_id from job_requisitions where id = $1', [id]);
        if (ar?.approval_request_id) await this.approvals.cancel(tx, ar.approval_request_id);
      }
      await tx.query(
        `update job_requisitions set status = $2, status_reason = $3,
                opened_at = case when $2 = 'open' and opened_at is null then now() else opened_at end,
                closed_at = case when $2 in ('closed', 'cancelled') then now() else closed_at end
          where id = $1`,
        [id, m.to, input.reason ?? null],
      );
      // A posting is only live while the requisition is open.
      if (m.to !== 'open') await tx.query(`update job_postings set unpublished_at = now() where requisition_id = $1 and published_at is not null and unpublished_at is null`, [id]);
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
      const params: unknown[] = [];
      let where = `m.status = 'active'`;
      if (q) {
        params.push(`%${q.toLowerCase()}%`);
        where += ` and (lower(u.full_name) like $1 or lower(u.email::text) like $1)`;
      }
      return many(tx, `select m.id as "membershipId", u.full_name as name, m.title, d.name as "departmentName" from memberships m join users u on u.id = m.user_id
                         left join departments d on d.id = m.department_id where ${where} order by u.full_name limit 300`, params);
    });
  }

  // Posting -----------------------------------------------------------------------------------------------

  async savePosting(id: string, input: PostingInput) {
    return this.db.tenant(async (tx) => {
      const r = await loadRequisition(tx, id);
      await this.authz.require('candidates:manage', reqAttrs(r), tx);
      if (['cancelled', 'rejected'].includes(r.status)) throw Errors.conflict('invalid_state', 'This requisition is not going ahead');
      await tx.query(
        `insert into job_postings (tenant_id, requisition_id, public_title, slug, summary, description, location_text, show_salary)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7)
         on conflict (tenant_id, requisition_id) do update set public_title = excluded.public_title, slug = excluded.slug, summary = excluded.summary,
           description = excluded.description, location_text = excluded.location_text, show_salary = excluded.show_salary`,
        [id, input.publicTitle, input.slug, input.summary, input.description, input.locationText, input.showSalary],
      ).catch(uniqueAs('slug_taken', 'Another job already uses this web address. Choose a different one.'));
      await this.audit.record(tx, { action: 'posting.saved', resourceType: 'job_requisition', resourceId: id, changes: { ...input, description: undefined } });
      return one(tx, `select ${POSTING_COLUMNS} from job_postings p where p.requisition_id = $1`, [id]);
    });
  }

  async publish(id: string, publish: boolean) {
    return this.db.tenant(async (tx) => {
      const r = await loadRequisition(tx, id);
      await this.authz.require('candidates:manage', reqAttrs(r), tx);
      const p = await one<{ id: string }>(tx, 'select id from job_postings where requisition_id = $1', [id]);
      if (!p) throw Errors.badRequest('no_posting', 'Write the job posting first');
      if (publish && r.status !== 'open') throw Errors.conflict('requisition_not_open', 'Open the requisition before publishing its job posting');
      await tx.query(
        publish
          ? `update job_postings set published_at = now(), unpublished_at = null where id = $1`
          : `update job_postings set unpublished_at = now() where id = $1 and published_at is not null and unpublished_at is null`,
        [p.id],
      );
      await this.audit.record(tx, { action: publish ? 'posting.published' : 'posting.unpublished', resourceType: 'job_requisition', resourceId: id });
      const site = await one<{ slug: string; enabled: boolean }>(tx, 'select slug, enabled from career_sites');
      return { published: publish, careerSite: site ?? null };
    });
  }

  /** Called when someone is hired: counts the hire and closes the opening when every seat is filled. */
  async countHire(tx: Tx, r: RequisitionRow) {
    const filled = r.hired_count + 1 >= r.headcount;
    await tx.query(
      `update job_requisitions set hired_count = hired_count + 1, status = case when $2 then 'filled' else status end, closed_at = case when $2 then now() else closed_at end where id = $1`,
      [r.id, filled],
    );
    if (filled) {
      await tx.query(`update job_postings set unpublished_at = now() where requisition_id = $1 and published_at is not null and unpublished_at is null`, [r.id]);
      await this.audit.record(tx, { action: 'requisition.filled', resourceType: 'job_requisition', resourceId: r.id, metadata: { headcount: r.headcount } });
    }
    return filled;
  }
}
