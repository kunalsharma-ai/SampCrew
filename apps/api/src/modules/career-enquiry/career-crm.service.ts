import { Injectable } from '@nestjs/common';
import type { CareerStage } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import type { TenantTx } from '../../platform/database/mongo.service';
import { NotificationService } from '../../platform/notify/notification.service';
import { recordActivity, crmSettings, stagesOf } from '../candidate-crm/crm-common';
import { careerEvent, careerSettings, careerStagesOf, type Doc } from './career-common';

/** The Candidate CRM stage for a Career Enquiry stage (custom stages go by their kind). */
const CRM_STAGE_FOR: Record<string, string> = {
  new_application: 'new', under_review: 'screening', shortlisted: 'shortlisted', contacted: 'contacted', interview_scheduled: 'interview_scheduled',
  interview_completed: 'interview_completed', selected: 'selected', offer_sent: 'offer_released', offer_accepted: 'offer_accepted', joined: 'joined',
  rejected: 'rejected', on_hold: 'on_hold',
};
const BY_KIND: Record<CareerStage['kind'], string> = { open: 'screening', won: 'selected', lost: 'rejected', paused: 'on_hold' };

/**
 * Move to Candidate CRM. The website applicant is already the company's one candidate record (hidden from the CRM
 * while career_only), so moving never copies: an existing CRM candidate gets the application linked; a new one is
 * shown in the CRM with the stage, owner and recruiter from the application, and the recruitment notes become CRM
 * remarks. The CV was stored once on the candidate when it arrived, so it is in the CRM's documents already.
 */
@Injectable()
export class CareerCrmService {
  constructor(private readonly audit: AuditService, private readonly notifications: NotificationService) {}

  async moveIn(tx: TenantTx, app: Doc, by: string | null) {
    const candidates = tx.collection('candidates');
    const c = await candidates.findOne({ id: app.candidate_id });
    if (!c) throw new Error('Candidate missing');
    const created = !!c.career_only;
    const crmStages = stagesOf(await crmSettings(tx));
    if (created) {
      const stage = careerStagesOf(await careerSettings(tx)).find((s) => s.key === app.stage);
      const wanted = CRM_STAGE_FOR[app.stage] ?? (stage ? BY_KIND[stage.kind] : 'new');
      const crmStage = crmStages.some((s) => s.key === wanted && s.active) ? wanted : 'new';
      await candidates.updateOne({ id: c.id }, { $set: {
        career_only: false, crm_stage: crmStage, crm_stage_entered_at: new Date(), crm_hr_workspace_id: app.hr_workspace_id ?? c.crm_hr_workspace_id ?? null,
        assigned_recruiter_membership_id: c.assigned_recruiter_membership_id ?? app.assigned_recruiter_membership_id ?? app.assigned_hr_membership_id ?? null,
        created_by_membership_id: c.created_by_membership_id ?? by, updated_by_membership_id: by,
      } });
      await recordActivity(tx, c.id, 'created', { detail: { code: c.candidate_code, source: 'company_website', stage: crmStage, via: 'career_enquiry', applicationCode: app.code }, hrWorkspaceId: app.hr_workspace_id ?? null });
    } else {
      await recordActivity(tx, c.id, 'career_event', { detail: { careerKind: 'linked', applicationId: app.id, code: app.code, position: app.position ?? null } });
    }
    await this.carryNotes(tx, app, c.id);
    await tx.collection('career_applications').updateOne({ id: app.id }, { $set: { moved_to_crm_at: new Date(), moved_to_crm_by_membership_id: by } });
    await careerEvent(tx, app.id, 'moved_to_crm', { detail: { created, candidateId: c.id, candidateCode: c.candidate_code }, actor: by });
    await this.audit.record(tx, { action: 'career_application.moved_to_crm', resourceType: 'career_application', resourceId: app.id, metadata: { code: app.code, candidateId: c.id, created } });
    const to = [app.assigned_hr_membership_id, app.assigned_recruiter_membership_id].filter((m) => m && m !== by) as string[];
    if (to.length) {
      await this.notifications.notify(tx, {
        membershipIds: to, kind: 'career.moved_to_crm', title: `${`${c.first_name ?? ''} ${c.last_name ?? ''}`.trim()} is now in Candidate CRM`,
        body: `${app.code}${c.candidate_code ? ` · ${c.candidate_code}` : ''}`, link: `/career-enquiry/applications/${app.id}`, resource: { type: 'career_application', id: app.id },
      });
    }
    return { candidateId: c.id as string, candidateCode: (c.candidate_code as string | null) ?? null, created };
  }

  /** Recruitment comments become CRM remarks, internal notes restricted remarks; each only once. */
  async carryNotes(tx: TenantTx, app: Doc, candidateId: string) {
    for (const n of await tx.collection('career_notes').find({ application_id: app.id, crm_note_id: null }, { sort: { created_at: 1 } })) {
      const row = await tx.collection('candidate_notes').insert({
        candidate_id: candidateId, body: `[${app.code}] ${n.body}`.slice(0, 10_000), category: 'general', restricted: n.kind === 'internal',
        author_membership_id: n.author_membership_id ?? null, created_at: n.created_at,
      });
      await tx.collection('career_notes').updateOne({ id: n.id }, { $set: { crm_note_id: row.id } });
    }
  }
}
