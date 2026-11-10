import { Injectable, type OnModuleInit } from '@nestjs/common';
import { money, type hireInput, type OfferInput, type offerResponseInput } from '@crew/contracts';
import type { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
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
      link: (id) => `/recruitment/offers/${id}`,
      attributes: async (tx, id) => reqAttrs((await loadApplication(tx, (await this.load(tx, id)).application_id)).req),
      onApproved: async (tx, req) => {
        const o = await tx.collection('offers').updateAndGet({ id: req.resource_id, status: 'pending_approval' }, { $set: { status: 'approved' } });
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
        const o = await tx.collection('offers').updateAndGet({ id: req.resource_id, status: 'pending_approval' }, { $set: { status: 'rejected' } });
        if (!o) return;
        await recordEvent(tx, o.application_id, 'offer_rejected', { detail: { offerId: req.resource_id } });
        await this.audit.record(tx, { action: 'offer.rejected', resourceType: 'offer', resourceId: req.resource_id });
      },
    });
  }

  private async load(tx: TenantTx, id: string, lock = false): Promise<OfferRow & { approval_request_id: string | null }> {
    const offers = tx.collection('offers');
    if (lock) await offers.lock({ id });
    const o = await offers.findOne({ id });
    if (!o) throw Errors.notFound('Offer');
    return {
      id: o.id, application_id: o.application_id, status: o.status, job_title: o.job_title, designation_id: o.designation_id ?? null, base_salary: o.base_salary,
      currency: o.currency, pay_period: o.pay_period, variable_pay: o.variable_pay ?? null, joining_date: o.joining_date, expires_on: o.expires_on,
      above_range: o.above_range, created_by_membership_id: o.created_by_membership_id ?? null, approval_request_id: o.approval_request_id ?? null,
    };
  }

  /** Is the offer above the requisition's approved range? Only comparable for annual pay in the same currency. */
  private aboveRange(input: Pick<OfferInput, 'baseSalary' | 'currency' | 'payPeriod'>, req: { salary_max: string | null; currency: string }) {
    if (req.salary_max === null) return false;
    if (input.currency !== req.currency || input.payPeriod === 'hourly') return true; // not comparable, so an approver should look
    // Exact decimal comparison in minor units, never floating point.
    return money.toMinor(input.baseSalary) * (input.payPeriod === 'monthly' ? 12n : 1n) > money.toMinor(req.salary_max);
  }

  private checkDates(input: Pick<OfferInput, 'joiningDate' | 'expiresOn'>) {
    const today = new Date().toISOString().slice(0, 10);
    if (input.expiresOn < today) throw Errors.badRequest('expires_in_past', 'The offer must be open until today or later');
    if (input.joiningDate < today) throw Errors.badRequest('joining_in_past', 'The joining date is in the past');
  }

  /** Where an offer lives: its candidate and application. Used by approval links. */
  async locate(id: string) {
    return this.db.tenant(async (tx) => {
      const o = await this.load(tx, id);
      const a = await loadApplication(tx, o.application_id);
      await this.authz.require('candidates:read', reqAttrs(a.req), tx);
      return { id, status: o.status, applicationId: o.application_id, candidateId: a.candidate_id };
    });
  }

  async create(applicationId: string, input: OfferInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const a = await loadApplication(tx, applicationId, true);
      await this.authz.require('offers:manage', reqAttrs(a.req), tx);
      if (a.status !== 'active') throw Errors.conflict('application_closed', `This application is ${a.status}`);
      this.checkDates(input);
      const live = await tx.collection('offers').exists({ application_id: applicationId, status: { $in: ['draft', 'pending_approval', 'approved', 'sent', 'accepted'] } });
      if (live) throw Errors.conflict('offer_exists', 'This candidate already has an offer in progress');
      const row = await tx.collection('offers').insert({
        application_id: applicationId, job_title: input.jobTitle, designation_id: input.designationId ?? a.req.designation_id, base_salary: input.baseSalary, currency: input.currency,
        pay_period: input.payPeriod, variable_pay: input.variablePay ?? null, joining_date: input.joiningDate, expires_on: input.expiresOn, notes: input.notes ?? null,
        above_range: this.aboveRange(input, a.req), created_by_membership_id: actor.membershipId,
      });
      // Moving to the offer stage is what a recruiter does next anyway.
      if (a.stage_kind !== 'offer') {
        const stage = await tx.collection('recruitment_stages').findOne({ kind: 'offer', archived_at: null }, { sort: { position: 1 } });
        if (stage) {
          await tx.collection('applications').updateOne({ id: applicationId }, { $set: { stage_id: stage.id, stage_entered_at: new Date() } });
          await recordEvent(tx, applicationId, 'stage_changed', { fromStageId: a.stage_id, toStageId: stage.id });
        }
      }
      await recordEvent(tx, applicationId, 'offer_drafted', { detail: { offerId: row.id } });
      await this.audit.record(tx, { action: 'offer.created', resourceType: 'offer', resourceId: row.id, changes: { ...input, notes: undefined } });
      return { id: row.id as string };
    });
  }

  async update(id: string, input: OfferInput) {
    return this.db.tenant(async (tx) => {
      const o = await this.load(tx, id, true);
      const a = await loadApplication(tx, o.application_id);
      await this.authz.require('offers:manage', reqAttrs(a.req), tx);
      if (!['draft', 'rejected'].includes(o.status)) throw Errors.conflict('offer_locked', 'Only a draft or a rejected offer can be changed. Withdraw it and draft a new one.');
      this.checkDates(input);
      await tx.collection('offers').updateOne({ id }, {
        $set: {
          job_title: input.jobTitle, designation_id: input.designationId ?? a.req.designation_id, base_salary: input.baseSalary, currency: input.currency, pay_period: input.payPeriod,
          variable_pay: input.variablePay ?? null, joining_date: input.joiningDate, expires_on: input.expiresOn, notes: input.notes ?? null,
          above_range: this.aboveRange(input, a.req), status: 'draft',
        },
      });
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
      await tx.collection('offers').updateOne({ id }, { $set: { status: 'pending_approval', approval_request_id: approvalId } });
      await recordEvent(tx, o.application_id, 'offer_submitted', { detail: { offerId: id } });
      await this.audit.record(tx, { action: 'offer.submitted', resourceType: 'offer', resourceId: id });
      return { status: 'pending_approval' };
    });
  }

  /**
   * Marks an approved offer as sent and emails the candidate its main terms. The formal offer letter is the
   * recruiter's to attach or send; SampCrew records the terms the candidate was given.
   */
  async send(id: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const o = await this.load(tx, id, true);
      const a = await loadApplication(tx, o.application_id);
      await this.authz.require('offers:manage', reqAttrs(a.req), tx);
      if (o.status !== 'approved') throw Errors.conflict('invalid_state', o.status === 'pending_approval' ? 'This offer is still waiting for approval' : `This offer is ${o.status}`);
      if (!a.candidate_email) throw Errors.conflict('no_email', 'The candidate has no email address');
      await tx.collection('offers').updateOne({ id }, { $set: { status: 'sent', sent_at: new Date() } });
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
      await tx.collection('offers').updateOne({ id }, { $set: { status: input.response, responded_at: new Date(), response_note: input.note ?? null } });
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
        if (o.approval_request_id) await this.approvals.cancel(tx, o.approval_request_id);
      }
      await tx.collection('offers').updateOne({ id }, { $set: { status: 'withdrawn' } });
      await recordEvent(tx, o.application_id, 'offer_withdrawn', { detail: { offerId: id } });
      await this.audit.record(tx, { action: 'offer.withdrawn', resourceType: 'offer', resourceId: id });
      return { status: 'withdrawn' };
    });
  }

  /**
   * Creates the employee record from an accepted offer, through the same hiring path HR uses (employee code,
   * job record, onboarding checklist, leave accruals, optional SampCrew invitation), and in the same transaction
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
      const found = await tx.collection('offers').findOne({ application_id: applicationId, status: 'accepted' }, { projection: { job_title: 1, designation_id: 1, joining_date: 1 } });
      const offer = found && { id: found.id as string, job_title: found.job_title as string, designation_id: (found.designation_id as string | null) ?? null, joining_date: found.joining_date as string };
      if (!offer) throw Errors.conflict('no_accepted_offer', 'Record the candidate’s acceptance of an offer first');
      if (!['open', 'approved', 'on_hold'].includes(a.req.status) || a.req.hired_count >= a.req.headcount) throw Errors.conflict('no_openings', 'This requisition has no open positions left');
      const cd = (await tx.collection('candidates').findOne({ id: a.candidate_id }))!;
      const c = { first_name: cd.first_name as string, last_name: cd.last_name as string, email: (cd.email as string | null) ?? null, phone: (cd.phone as string | null) ?? null };
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
        const reqs = tx.collection('job_requisitions');
        await reqs.lock({ id: app.requisition_id });
        const req = await reqs.findOne({ id: app.requisition_id }, { projection: { hired_count: 1, headcount: 1, status: 1 } });
        if (app.status !== 'active') throw Errors.conflict('application_closed', `This application is ${app.status}`);
        if (!req || req.hired_count >= req.headcount || !['open', 'approved', 'on_hold'].includes(req.status)) throw Errors.conflict('no_openings', 'This requisition has no open positions left');
        const hired = await stageOfKind(tx, 'hired');
        const now = new Date();
        await tx.collection('applications').updateOne({ id: applicationId }, { $set: { status: 'hired', stage_id: hired, stage_entered_at: now, employee_id: employeeId, hired_at: now, decided_at: now } });
        await recordEvent(tx, applicationId, 'hired', { fromStageId: app.stage_id, toStageId: hired, detail: { employeeId } });
        const filled = await this.requisitions.countHire(tx, { ...app.req, hired_count: req.hired_count });
        await this.audit.record(tx, { action: 'candidate.hired', resourceType: 'application', resourceId: applicationId, metadata: { employeeId, offerId: offer.id, requisitionFilled: filled } });
      },
    );
  }
}
