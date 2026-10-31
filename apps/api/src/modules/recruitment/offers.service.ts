import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { hireInput, OfferInput, offerResponseInput } from '@crew/contracts';
import type { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, one, type Tx } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { EmployeesService } from '../employees/employees.service';
import { CandidatesService } from './candidates.service';
import { CANDIDATE_FOOTER, employeeOfMember, loadApplication, moneyText, recordEvent, reqAttrs, stageOfKind } from './recruitment-common';
import { RequisitionsService } from './requisitions.service';

interface OfferRow {
  id: string;
  application_id: string;
  status: string;
  job_title: string;
  designation_id: string | null;
  base_salary: string;
  currency: string;
  pay_period: string;
  variable_pay: string | null;
  joining_date: string;
  expires_on: string;
  above_range: boolean;
  created_by_membership_id: string | null;
}

const PERIOD: Record<string, string> = { annual: 'per year', monthly: 'per month', hourly: 'per hour' };

/** Offers (drafted, approved, sent, answered) and turning an accepted offer into a hire. */
@Injectable()
export class OffersService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly approvals: ApprovalsService,
    private readonly employees: EmployeesService,
    private readonly requisitions: RequisitionsService,
    private readonly candidates: CandidatesService,
  ) {}

  onModuleInit() {
    this.approvals.register('offer', {
      permission: 'offers:approve',
      configurePermission: 'recruitment:configure',
      defaultSteps: [{ type: 'role', role: 'hr_admin' }],
      fallbackRole: 'tenant_owner',
      label: 'Offer',
      link: () => '/recruitment',
      attributes: async (tx, id) => reqAttrs((await loadApplication(tx, (await this.load(tx, id)).application_id)).req),
      onApproved: async (tx, req) => {
        const o = await one<{ application_id: string; created_by_membership_id: string | null }>(
          tx, `update offers set status = 'approved' where id = $1 and status = 'pending_approval' returning application_id, created_by_membership_id`, [req.resource_id],
        );
        if (!o) return;
        await recordEvent(tx, o.application_id, 'offer_approved', { detail: { offerId: req.resource_id } });
        await this.audit.record(tx, { action: 'offer.approved', resourceType: 'offer', resourceId: req.resource_id });
        const a = await loadApplication(tx, o.application_id);
        await this.notifications.notify(tx, {
          membershipIds: [o.created_by_membership_id], kind: 'offer.approved',
          title: `Offer for ${a.candidate_name} approved. You can send it now.`, link: `/recruitment/candidates/${a.candidate_id}`,
        });
      },
      onRejected: async (tx, req) => {
        const o = await one<{ application_id: string }>(tx, `update offers set status = 'rejected' where id = $1 and status = 'pending_approval' returning application_id`, [req.resource_id]);
        if (!o) return;
        await recordEvent(tx, o.application_id, 'offer_rejected', { detail: { offerId: req.resource_id } });
        await this.audit.record(tx, { action: 'offer.rejected', resourceType: 'offer', resourceId: req.resource_id });
      },
    });
  }

  private async load(tx: Tx, id: string, lock = false) {
    const o = await one<OfferRow>(
      tx,
      `select id, application_id, status, job_title, designation_id, base_salary::text, currency, pay_period, variable_pay, to_char(joining_date, 'YYYY-MM-DD') as joining_date,
              to_char(expires_on, 'YYYY-MM-DD') as expires_on, above_range, created_by_membership_id from offers where id = $1${lock ? ' for update' : ''}`,
      [id],
    );
    if (!o) throw Errors.notFound('Offer');
    return o;
  }

  /** Is the offer above the requisition's approved range? Only comparable for annual pay in the same currency. */
  private aboveRange(input: Pick<OfferInput, 'baseSalary' | 'currency' | 'payPeriod'>, req: { salary_max: string | null; currency: string }) {
    if (req.salary_max === null) return false;
    if (input.currency !== req.currency) return true;
    const annual = input.payPeriod === 'annual' ? Number(input.baseSalary) : input.payPeriod === 'monthly' ? Number(input.baseSalary) * 12 : null;
    return annual === null ? true : annual > Number(req.salary_max);
  }

  private checkDates(input: Pick<OfferInput, 'joiningDate' | 'expiresOn'>) {
    const today = new Date().toISOString().slice(0, 10);
    if (input.expiresOn < today) throw Errors.badRequest('expires_in_past', 'The offer must be open until today or later');
    if (input.joiningDate < today) throw Errors.badRequest('joining_in_past', 'The joining date is in the past');
  }

  async create(applicationId: string, input: OfferInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const a = await loadApplication(tx, applicationId, true);
      await this.authz.require('offers:manage', reqAttrs(a.req), tx);
      if (a.status !== 'active') throw Errors.conflict('application_closed', `This application is ${a.status}`);
      this.checkDates(input);
      const live = await one(tx, `select 1 from offers where application_id = $1 and status in ('draft', 'pending_approval', 'approved', 'sent', 'accepted')`, [applicationId]);
      if (live) throw Errors.conflict('offer_exists', 'This candidate already has an offer in progress');
      const row = (await one<{ id: string }>(
        tx,
        `insert into offers (tenant_id, application_id, job_title, designation_id, base_salary, currency, pay_period, variable_pay, joining_date, expires_on, notes, above_range, created_by_membership_id)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
        [applicationId, input.jobTitle, input.designationId ?? a.req.designation_id, input.baseSalary, input.currency, input.payPeriod, input.variablePay ?? null,
          input.joiningDate, input.expiresOn, input.notes ?? null, this.aboveRange(input, a.req), actor.membershipId],
      ))!;
      // Moving to the offer stage is what a recruiter does next anyway.
      if (a.stage_kind !== 'offer') {
        const stage = await one<{ id: string }>(tx, `select id from recruitment_stages where kind = 'offer' and archived_at is null order by position limit 1`);
        if (stage) {
          await tx.query(`update applications set stage_id = $2, stage_entered_at = now() where id = $1`, [applicationId, stage.id]);
          await recordEvent(tx, applicationId, 'stage_changed', { fromStageId: a.stage_id, toStageId: stage.id });
        }
      }
      await recordEvent(tx, applicationId, 'offer_drafted', { detail: { offerId: row.id } });
      await this.audit.record(tx, { action: 'offer.created', resourceType: 'offer', resourceId: row.id, changes: { ...input, notes: undefined } });
      return { id: row.id };
    });
  }

  async update(id: string, input: OfferInput) {
    return this.db.tenant(async (tx) => {
      const o = await this.load(tx, id, true);
      const a = await loadApplication(tx, o.application_id);
      await this.authz.require('offers:manage', reqAttrs(a.req), tx);
      if (!['draft', 'rejected'].includes(o.status)) throw Errors.conflict('offer_locked', 'Only a draft or a rejected offer can be changed. Withdraw it and draft a new one.');
      this.checkDates(input);
      await tx.query(
        `update offers set job_title = $2, designation_id = $3, base_salary = $4, currency = $5, pay_period = $6, variable_pay = $7, joining_date = $8, expires_on = $9,
                notes = $10, above_range = $11, status = 'draft' where id = $1`,
        [id, input.jobTitle, input.designationId ?? a.req.designation_id, input.baseSalary, input.currency, input.payPeriod, input.variablePay ?? null, input.joiningDate,
          input.expiresOn, input.notes ?? null, this.aboveRange(input, a.req)],
      );
      await this.audit.record(tx, { action: 'offer.updated', resourceType: 'offer', resourceId: id, changes: { ...input, notes: undefined } });
      return { id };
    });
  }

  async submit(id: string) {
    return this.db.tenant(async (tx) => {
      const o = await this.load(tx, id, true);
      const a = await loadApplication(tx, o.application_id);
      await this.authz.require('offers:manage', reqAttrs(a.req), tx);
      if (!['draft', 'rejected'].includes(o.status)) throw Errors.conflict('invalid_state', `This offer is ${o.status.replace('_', ' ')}`);
      if (o.expires_on < new Date().toISOString().slice(0, 10)) throw Errors.badRequest('expires_in_past', 'Move the offer’s expiry date forward first');
      const pay = `${moneyText(o.base_salary, o.currency)} ${PERIOD[o.pay_period]}`;
      const range = a.req.salary_min || a.req.salary_max ? ` Approved range: ${[moneyText(a.req.salary_min, a.req.currency), moneyText(a.req.salary_max, a.req.currency)].filter(Boolean).join(' to ')}.` : '';
      const summary = `${a.candidate_name}: offer for ${o.job_title} (${a.req.code}), ${pay}${o.variable_pay ? ` plus ${o.variable_pay}` : ''}, joining ${o.joining_date}.${o.above_range ? ' ABOVE the approved range.' : ''}${range}`;
      const approvalId = await this.approvals.start(tx, { resourceType: 'offer', resourceId: id, subjectEmployeeId: null, summary });
      await tx.query(`update offers set status = 'pending_approval', approval_request_id = $2 where id = $1`, [id, approvalId]);
      await recordEvent(tx, o.application_id, 'offer_submitted', { detail: { offerId: id } });
      await this.audit.record(tx, { action: 'offer.submitted', resourceType: 'offer', resourceId: id });
      return { status: 'pending_approval' };
    });
  }

  /**
   * Marks an approved offer as sent and emails the candidate its main terms. The formal offer letter is the
   * recruiter's to attach or send; CREW records the terms the candidate was given.
   */
  async send(id: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const o = await this.load(tx, id, true);
      const a = await loadApplication(tx, o.application_id);
      await this.authz.require('offers:manage', reqAttrs(a.req), tx);
      if (o.status !== 'approved') throw Errors.conflict('invalid_state', o.status === 'pending_approval' ? 'This offer is still waiting for approval' : `This offer is ${o.status}`);
      if (!a.candidate_email) throw Errors.conflict('no_email', 'The candidate has no email address');
      await tx.query(`update offers set status = 'sent', sent_at = now() where id = $1`, [id]);
      const org = await this.candidates.orgName(tx);
      await this.notifications.queueEmail(
        tx, actor.tenantId, a.candidate_email, `Your offer from ${org}`,
        `Dear ${a.candidate_name},\n\nWe are delighted to offer you the role of ${o.job_title}.\n\nBase pay: ${moneyText(o.base_salary, o.currency)} ${PERIOD[o.pay_period]}${o.variable_pay ? `\nVariable pay: ${o.variable_pay}` : ''}\nJoining date: ${o.joining_date}\nThis offer is open until: ${o.expires_on}\n\nYour recruiter will share the formal offer letter. Please reply to them with your decision.\n\n${org}`,
        'candidate.offer', CANDIDATE_FOOTER,
      );
      await recordEvent(tx, o.application_id, 'offer_sent', { detail: { offerId: id } });
      await this.audit.record(tx, { action: 'offer.sent', resourceType: 'offer', resourceId: id });
      return { status: 'sent' };
    });
  }

  /** Records the candidate's answer, as told to the recruiter. */
  async respond(id: string, input: z.infer<typeof offerResponseInput>) {
    return this.db.tenant(async (tx) => {
      const o = await this.load(tx, id, true);
      const a = await loadApplication(tx, o.application_id);
      await this.authz.require('offers:manage', reqAttrs(a.req), tx);
      if (o.status !== 'sent') throw Errors.conflict('invalid_state', o.status === 'approved' ? 'Send the offer first' : `This offer is ${o.status}`);
      await tx.query(`update offers set status = $2, responded_at = now(), response_note = $3 where id = $1`, [id, input.response, input.note ?? null]);
      await recordEvent(tx, o.application_id, input.response === 'accepted' ? 'offer_accepted' : 'offer_declined', { detail: { offerId: id } });
      await this.audit.record(tx, { action: `offer.${input.response}`, resourceType: 'offer', resourceId: id });
      await this.notifications.notify(tx, {
        membershipIds: [a.req.hiring_manager_membership_id, o.created_by_membership_id], kind: `offer.${input.response}`,
        title: `${a.candidate_name} ${input.response} the offer for ${o.job_title}`, link: `/recruitment/candidates/${a.candidate_id}`,
      });
      return { status: input.response };
    });
  }

  async withdraw(id: string) {
    return this.db.tenant(async (tx) => {
      const o = await this.load(tx, id, true);
      const a = await loadApplication(tx, o.application_id);
      await this.authz.require('offers:manage', reqAttrs(a.req), tx);
      if (!['draft', 'pending_approval', 'approved', 'sent', 'accepted'].includes(o.status)) throw Errors.conflict('invalid_state', `This offer is already ${o.status}`);
      if (a.status === 'hired') throw Errors.conflict('already_hired', 'The candidate has been hired; manage the employment from their employee record');
      if (o.status === 'pending_approval') {
        const ar = await one<{ approval_request_id: string | null }>(tx, 'select approval_request_id from offers where id = $1', [id]);
        if (ar?.approval_request_id) await this.approvals.cancel(tx, ar.approval_request_id);
      }
      await tx.query(`update offers set status = 'withdrawn' where id = $1`, [id]);
      await recordEvent(tx, o.application_id, 'offer_withdrawn', { detail: { offerId: id } });
      await this.audit.record(tx, { action: 'offer.withdrawn', resourceType: 'offer', resourceId: id });
      return { status: 'withdrawn' };
    });
  }

  /**
   * Creates the employee record from an accepted offer, through the same hiring path HR uses (employee code,
   * job record, onboarding checklist, leave accruals, optional CREW invitation), and in the same transaction
   * marks the application hired and counts the hire against the requisition.
   */
  async hire(applicationId: string, input: z.infer<typeof hireInput>) {
    const plan = await this.db.tenant(async (tx) => {
      const a = await loadApplication(tx, applicationId);
      // Recruiters run the pipeline; whoever may create employees (usually HR) completes the hire. The employee
      // create path checks employees:create for the legal entity.
      await this.authz.require('candidates:read', reqAttrs(a.req), tx);
      await this.authz.require('employees:create', { legalEntityId: a.req.legal_entity_id }, tx);
      if (a.status !== 'active') throw Errors.conflict('application_closed', `This application is ${a.status}`);
      if (a.anonymized) throw Errors.conflict('candidate_erased', 'This candidate’s details were erased');
      const offer = await one<OfferRow>(tx, `select id, job_title, designation_id, to_char(joining_date, 'YYYY-MM-DD') as joining_date from offers where application_id = $1 and status = 'accepted'`, [applicationId]);
      if (!offer) throw Errors.conflict('no_accepted_offer', 'Record the candidate’s acceptance of an offer first');
      if (!['open', 'approved', 'on_hold'].includes(a.req.status) || a.req.hired_count >= a.req.headcount) throw Errors.conflict('no_openings', 'This requisition has no open positions left');
      const c = (await one<{ first_name: string; last_name: string; email: string | null; phone: string | null }>(tx, 'select first_name, last_name, email, phone from candidates where id = $1', [a.candidate_id]))!;
      return { a, offer, c, managerEmployeeId: await employeeOfMember(tx, a.req.hiring_manager_membership_id) };
    });
    const { a, offer, c } = plan;
    const phone = c.phone && /^\+?[0-9 ()-]{6,20}$/.test(c.phone) ? c.phone : undefined;
    return this.employees.create(
      {
        firstName: c.first_name, lastName: c.last_name, personalEmail: c.email ?? undefined, workEmail: input.workEmail, phone,
        dateOfJoining: input.dateOfJoining ?? offer.joining_date, probationMonths: input.probationMonths, inviteToCrew: input.inviteToCrew,
        legalEntityId: a.req.legal_entity_id, departmentId: a.req.department_id, locationId: a.req.location_id,
        designationId: offer.designation_id ?? a.req.designation_id, managerEmployeeId: plan.managerEmployeeId,
        employmentType: a.req.employment_type as 'full_time',
      },
      async (tx, employeeId) => {
        // Re-check under lock inside the hiring transaction: two people hiring for the last seat at once.
        const app = await loadApplication(tx, applicationId, true);
        const req = await one<{ hired_count: number; headcount: number; status: string }>(tx, 'select hired_count, headcount, status from job_requisitions where id = $1 for update', [app.requisition_id]);
        if (app.status !== 'active') throw Errors.conflict('application_closed', `This application is ${app.status}`);
        if (!req || req.hired_count >= req.headcount || !['open', 'approved', 'on_hold'].includes(req.status)) throw Errors.conflict('no_openings', 'This requisition has no open positions left');
        const hired = await stageOfKind(tx, 'hired');
        await tx.query(`update applications set status = 'hired', stage_id = $2, stage_entered_at = now(), employee_id = $3, hired_at = now(), decided_at = now() where id = $1`, [applicationId, hired, employeeId]);
        await recordEvent(tx, applicationId, 'hired', { fromStageId: app.stage_id, toStageId: hired, detail: { employeeId } });
        const filled = await this.requisitions.countHire(tx, { ...app.req, hired_count: req.hired_count });
        await this.audit.record(tx, { action: 'candidate.hired', resourceType: 'application', resourceId: applicationId, metadata: { employeeId, offerId: offer.id, requisitionFilled: filled } });
      },
    );
  }
}
