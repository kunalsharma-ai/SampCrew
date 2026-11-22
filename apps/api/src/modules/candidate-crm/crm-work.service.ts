import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  CALL_OUTCOMES, CRM_DOCUMENT_MAX_BYTES, FOLLOW_UP_TYPES, CRM_DOCUMENT_TYPES, crmLabel, type CrmActivityInput, type CrmActivityQuery, type CrmFollowUpQuery, type FollowUpInput,
  type followUpUpdate, INTERVIEW_OUTCOMES, type crmDocumentMeta, type crmNoteInput, type ReferenceInput, type referencePatch,
} from '@crew/contracts';
import type { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { membershipUserNames, MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { safeFileName } from '../../platform/http/content-disposition';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { requestContext } from '../../platform/context/request-context';
import { sniffMatches, StorageService } from '../../platform/storage/storage.service';
import type { UploadedFile } from '../documents/documents.service';
import { candidateName } from '../recruitment/recruitment-common';
import { type CrmActor, CrmAccessService } from './crm-access.service';
import { crmSettings, dayBounds, type Doc, recordActivity, refreshNextFollowUp, stagesOf, tenantZone } from './crm-common';
import { CrmService, describeDetail, followUpView } from './crm.service';

/**
 * The day-to-day work on a candidate: recruiter remarks, references, logged activities (calls, emails, meetings),
 * follow-ups and documents. Each one is written to the candidate's activity history, which is the timeline.
 */
@Injectable()
export class CrmWorkService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: CrmAccessService,
    private readonly crm: CrmService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly storage: StorageService,
  ) {}

  private async open(tx: TenantTx, id: string, need: 'read' | 'manage' = 'manage') {
    const a = await this.access.actor(tx, need);
    const c = await this.access.candidate(tx, a, id);
    if (need === 'manage' && c.anonymized_at) throw Errors.conflict('candidate_erased', 'This candidate’s details were erased');
    return { a, c };
  }

  // Remarks ----------------------------------------------------------------------------------------------------

  /** A dated recruiter remark. Remarks are never overwritten: each new one is added to the history. */
  async addRemark(candidateId: string, input: z.infer<typeof crmNoteInput>) {
    return this.db.tenant(async (tx) => {
      const { a, c } = await this.open(tx, candidateId);
      if (input.activityId && !(await tx.collection('candidate_activities').exists({ id: input.activityId, candidate_id: candidateId }))) throw Errors.notFound('Activity');
      const row = await this.crm.addRemark(tx, a, c, input);
      await recordActivity(tx, candidateId, 'note_added', { detail: { noteId: row.id, category: input.category, restricted: input.restricted } });
      return { id: row.id as string, createdAt: row.created_at as Date };
    });
  }

  // References -------------------------------------------------------------------------------------------------

  private async refreshReferenceTypes(tx: TenantTx, candidateId: string) {
    const types = await tx.collection('candidate_references').distinct<string>('type', { candidate_id: candidateId });
    await tx.collection('candidates').updateOne({ id: candidateId }, { $set: { reference_types: types } });
  }

  async addReference(candidateId: string, input: ReferenceInput) {
    return this.db.tenant(async (tx) => {
      const { a } = await this.open(tx, candidateId);
      if (await tx.collection('candidate_references').count({ candidate_id: candidateId }) >= 20) throw Errors.badRequest('too_many_references', 'A candidate can have up to 20 references');
      const row = await tx.collection('candidate_references').insert({ candidate_id: candidateId, ...input, created_by_membership_id: a.membershipId });
      await this.refreshReferenceTypes(tx, candidateId);
      await recordActivity(tx, candidateId, 'reference_added', { detail: { referenceId: row.id, type: input.type, name: input.name } });
      return { id: row.id as string };
    });
  }

  async updateReference(referenceId: string, input: z.infer<typeof referencePatch>) {
    return this.db.tenant(async (tx) => {
      const r = await tx.collection('candidate_references').findOne({ id: referenceId });
      if (!r) throw Errors.notFound('Reference');
      await this.open(tx, r.candidate_id);
      const set = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
      if (Object.keys(set).length) await tx.collection('candidate_references').updateOne({ id: referenceId }, { $set: set });
      await this.refreshReferenceTypes(tx, r.candidate_id);
      return { id: referenceId };
    });
  }

  async removeReference(referenceId: string) {
    return this.db.tenant(async (tx) => {
      const r = await tx.collection('candidate_references').findOne({ id: referenceId });
      if (!r) throw Errors.notFound('Reference');
      await this.open(tx, r.candidate_id);
      await tx.collection('candidate_references').delete({ id: referenceId });
      await this.refreshReferenceTypes(tx, r.candidate_id);
      await recordActivity(tx, r.candidate_id, 'updated', { detail: { fields: ['references'], removed: r.name ?? r.type } });
      return { removed: true };
    });
  }

  // Activities -------------------------------------------------------------------------------------------------

  /** Logs a call, email, message, meeting or interview, optionally scheduling the next follow-up in the same step. */
  async logActivity(candidateId: string, input: CrmActivityInput) {
    return this.db.tenant(async (tx) => {
      const { a, c } = await this.open(tx, candidateId);
      const at = input.occurredAt ? new Date(input.occurredAt) : new Date();
      if (at.getTime() > Date.now() + 10 * 60_000) throw Errors.validation([{ path: 'occurredAt', message: 'An activity is logged after it happened. Schedule a follow-up for something still to come.' }]);
      if (input.outcome) {
        const allowed = input.type === 'call' ? CALL_OUTCOMES : input.type === 'interview' ? INTERVIEW_OUTCOMES : null;
        if (allowed && !allowed.some((o) => o[0] === input.outcome)) throw Errors.validation([{ path: 'outcome', message: 'Choose an outcome from the list' }]);
      }
      if (input.type === 'call' && !input.outcome) throw Errors.validation([{ path: 'outcome', message: 'Choose how the call went' }]);
      const key = this.access.keysFor(a, c).find((k) => k !== 'central') ?? null;
      const id = await recordActivity(tx, candidateId, input.type, {
        automatic: false, subject: input.subject, outcome: input.outcome, remarks: input.remarks, durationMinutes: input.durationMinutes, occurredAt: at,
        hrWorkspaceId: a.level === 'hr' ? key : null, detail: { ...(input.interviewer ? { interviewer: input.interviewer } : {}), ...(input.mode ? { mode: input.mode } : {}) },
      });
      let followUpId: string | null = null;
      if (input.nextFollowUpAt) {
        followUpId = (await this.followUpIn(tx, a, c, {
          type: (input.nextFollowUpType as FollowUpInput['type']) ?? 'general', dueAt: input.nextFollowUpAt, priority: 'medium', reason: input.subject ?? `After ${input.type}`,
          notes: null, reminderMinutes: 15, assignedMembershipId: undefined,
        })).id;
      }
      return { id, followUpId };
    });
  }

  /** Logged activities across every candidate the person can see (the Activities page). */
  async activities(q: CrmActivityQuery) {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx);
      const visible = await tx.collection('candidates').distinct<string>('id', { $and: [this.access.filter(a), { anonymized_at: null }] });
      const filter: Doc = { candidate_id: q.candidateId ? { $in: visible.includes(q.candidateId) ? [q.candidateId] : [] } : { $in: visible } };
      if (q.include === 'manual') filter.automatic = false;
      if (q.type) filter.kind = q.type;
      if (q.outcome) filter.outcome = q.outcome;
      if (q.by) filter.created_by_membership_id = q.by === 'me' ? a.membershipId : q.by;
      const tz = await tenantZone(tx);
      const range: Doc = {};
      if (q.from) range.$gte = dayBounds(tz, new Date(`${q.from}T12:00:00Z`)).start;
      if (q.to) range.$lt = dayBounds(tz, new Date(`${q.to}T12:00:00Z`)).end;
      if (Object.keys(range).length) filter.occurred_at = range;
      const rows = await tx.collection('candidate_activities').find(filter, { sort: { occurred_at: -1 }, limit: q.limit });
      const total = await tx.collection('candidate_activities').count(filter);
      const names = await membershipUserNames(tx, rows.map((r) => r.created_by_membership_id));
      const cands = new Map((await tx.collection('candidates').find({ id: { $in: [...new Set(rows.map((r) => r.candidate_id))] } }, { projection: { first_name: 1, last_name: 1, candidate_code: 1 } })).map((c) => [c.id as string, c]));
      const stageLabel = new Map(stagesOf(await crmSettings(tx)).map((s) => [s.key, s.label]));
      // Call outcomes over the same filter, for the summary at the top of the page.
      const outcomes = await tx.collection('candidate_activities').aggregate<{ id: string | null; n: number }>([{ $match: { ...filter, kind: 'call' } }, { $group: { _id: '$outcome', n: { $sum: 1 } } }]);
      return {
        total,
        calls: outcomes.map((o) => ({ outcome: o.id, label: crmLabel(CALL_OUTCOMES, o.id), count: o.n })).sort((x, y) => y.count - x.count),
        rows: rows.map((r) => ({
          id: r.id, candidateId: r.candidate_id, candidateName: candidateName(cands.get(r.candidate_id) ?? {}), candidateCode: cands.get(r.candidate_id)?.candidate_code ?? null,
          kind: r.kind, automatic: !!r.automatic, subject: r.subject ?? null, outcome: r.outcome ?? null,
          outcomeLabel: r.kind === 'call' ? crmLabel(CALL_OUTCOMES, r.outcome) : r.kind === 'interview' ? crmLabel(INTERVIEW_OUTCOMES, r.outcome) : r.outcome ?? null,
          remarks: r.remarks ?? null, durationMinutes: r.duration_minutes ?? null, detail: r.detail ?? {}, text: describeDetail(r, stageLabel), occurredAt: r.occurred_at,
          by: r.created_by_membership_id ? names.get(r.created_by_membership_id) ?? null : null,
        })),
      };
    });
  }

  // Follow-ups -------------------------------------------------------------------------------------------------

  async addFollowUp(candidateId: string, input: FollowUpInput) {
    return this.db.tenant(async (tx) => {
      const { a, c } = await this.open(tx, candidateId);
      if (c.crm_archived_at) throw Errors.conflict('candidate_archived', 'Restore the candidate from the archive first');
      return this.followUpIn(tx, a, c, input);
    });
  }

  private async followUpIn(tx: TenantTx, a: CrmActor, c: Doc, input: FollowUpInput) {
    const due = new Date(input.dueAt);
    if (due.getTime() < Date.now() - 5 * 60_000) throw Errors.validation([{ path: 'dueAt', message: 'Choose a time from now on' }]);
    const assignee = input.assignedMembershipId === undefined ? (c.assigned_recruiter_membership_id ?? a.membershipId) : input.assignedMembershipId;
    if (assignee && assignee !== a.membershipId && !(await this.access.recruiters(tx, a)).some((r) => r.membershipId === assignee)) {
      throw Errors.validation([{ path: 'assignedMembershipId', message: 'Choose someone from your HR Workspace' }]);
    }
    if (await tx.collection('candidate_follow_ups').count({ candidate_id: c.id, status: { $in: ['pending', 'rescheduled'] } }) >= 30) {
      throw Errors.badRequest('too_many_follow_ups', 'This candidate already has 30 open follow-ups. Complete or cancel some first.');
    }
    const key = this.access.keysFor(a, c).find((k) => k !== 'central') ?? null;
    const row = await tx.collection('candidate_follow_ups').insert({
      candidate_id: c.id, type: input.type, due_at: due, priority: input.priority, reason: input.reason ?? null, notes: input.notes ?? null,
      reminder_minutes: input.reminderMinutes, assigned_membership_id: assignee ?? null, created_by_membership_id: a.membershipId, hr_workspace_id: a.level === 'hr' ? key : null,
    });
    await refreshNextFollowUp(tx, c.id);
    await recordActivity(tx, c.id, 'follow_up_scheduled', { detail: { followUpId: row.id, type: input.type, dueAt: due.toISOString(), priority: input.priority } });
    if (assignee && assignee !== a.membershipId) {
      await this.notifications.notify(tx, {
        membershipIds: [assignee], kind: 'candidate.follow_up_assigned', title: `Follow-up with ${candidateName(c)}`,
        body: [crmLabel(FOLLOW_UP_TYPES, input.type), input.reason].filter(Boolean).join(' · '), link: `/recruitment/crm/candidates/${c.id}?tab=follow-ups`,
        resource: { type: 'candidate', id: c.id },
      });
    }
    return { id: row.id as string, dueAt: due };
  }

  async updateFollowUp(followUpId: string, input: z.infer<typeof followUpUpdate>) {
    return this.db.tenant(async (tx) => {
      const f = await tx.collection('candidate_follow_ups').findOne({ id: followUpId });
      if (!f) throw Errors.notFound('Follow-up');
      const { a } = await this.open(tx, f.candidate_id);
      const set: Doc = {};
      const status = input.status ?? (input.dueAt && new Date(input.dueAt).getTime() !== new Date(f.due_at).getTime() ? 'rescheduled' : undefined);
      if (status && status !== f.status) {
        if (['completed', 'cancelled', 'missed'].includes(f.status) && status !== 'pending') throw Errors.conflict('follow_up_closed', `This follow-up is already ${f.status}`);
        set.status = status;
        if (status === 'completed') { set.completed_at = new Date(); set.completed_by_membership_id = a.membershipId; }
        if (status === 'rescheduled' && !input.dueAt) throw Errors.validation([{ path: 'dueAt', message: 'Choose the new date and time' }]);
      }
      if (input.dueAt) {
        const due = new Date(input.dueAt);
        if (due.getTime() < Date.now() - 5 * 60_000 && (set.status ?? f.status) !== 'completed') throw Errors.validation([{ path: 'dueAt', message: 'Choose a time from now on' }]);
        set.due_at = due;
        set.reminded_at = null; set.due_notified_at = null; set.overdue_notified_at = null;
      }
      if (input.priority) set.priority = input.priority;
      if (input.notes !== undefined) set.notes = input.notes;
      if (input.outcome !== undefined) set.outcome = input.outcome;
      if (input.reminderMinutes !== undefined) { set.reminder_minutes = input.reminderMinutes; set.reminded_at = null; }
      if (input.assignedMembershipId !== undefined) {
        if (input.assignedMembershipId && !(await this.access.recruiters(tx, a)).some((r) => r.membershipId === input.assignedMembershipId)) {
          throw Errors.validation([{ path: 'assignedMembershipId', message: 'Choose someone from your HR Workspace' }]);
        }
        set.assigned_membership_id = input.assignedMembershipId;
      }
      if (!Object.keys(set).length) return { id: followUpId, status: f.status };
      await tx.collection('candidate_follow_ups').updateOne({ id: followUpId }, { $set: set });
      await refreshNextFollowUp(tx, f.candidate_id);
      const kind = set.status === 'completed' ? 'follow_up_completed' : 'follow_up_changed';
      await recordActivity(tx, f.candidate_id, kind, {
        automatic: set.status !== 'completed', remarks: input.outcome ?? null,
        detail: { followUpId, type: f.type, status: set.status ?? f.status, ...(set.due_at ? { dueAt: (set.due_at as Date).toISOString() } : {}) },
      });
      return { id: followUpId, status: (set.status as string | undefined) ?? f.status };
    });
  }

  /** Follow-ups across the candidates the person can see, in buckets, with the counts for each bucket. */
  async followUps(q: CrmFollowUpQuery) {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx);
      const visible = await tx.collection('candidates').distinct<string>('id', { $and: [this.access.filter(a), { anonymized_at: null }] });
      const base: Doc = { candidate_id: { $in: visible } };
      if (q.assigned === 'me') base.assigned_membership_id = a.membershipId;
      else if (q.assigned !== 'all') base.assigned_membership_id = q.assigned;
      if (q.type) base.type = q.type;
      if (q.priority) base.priority = q.priority;
      const { start, end } = dayBounds(await tenantZone(tx));
      const now = new Date();
      const open = { status: { $in: ['pending', 'rescheduled'] } };
      const buckets: Record<string, Doc> = {
        overdue: { ...open, due_at: { $lt: now } },
        today: { ...open, due_at: { $gte: now, $lt: end } },
        upcoming: { ...open, due_at: { $gte: end } },
        completed: { status: 'completed' },
        missed: { status: 'missed' },
        open,
        all: {},
      };
      const counts: Record<string, number> = {};
      for (const [k, f] of Object.entries(buckets)) if (k !== 'all') counts[k] = await tx.collection('candidate_follow_ups').count({ ...base, ...f });
      counts.completedToday = await tx.collection('candidate_follow_ups').count({ ...base, status: 'completed', completed_at: { $gte: start, $lt: end } });
      const sort: Doc = ['completed', 'missed'].includes(q.bucket) ? { updated_at: -1 } : { due_at: 1 };
      const rows = await tx.collection('candidate_follow_ups').find({ ...base, ...buckets[q.bucket] }, { sort, limit: q.limit });
      const names = await membershipUserNames(tx, rows.flatMap((f) => [f.assigned_membership_id, f.created_by_membership_id, f.completed_by_membership_id]));
      const name = (m: string | null | undefined) => (m ? names.get(m) ?? 'Someone' : null);
      const cands = new Map((await tx.collection('candidates').find({ id: { $in: [...new Set(rows.map((r) => r.candidate_id))] } }, { projection: { first_name: 1, last_name: 1, candidate_code: 1, crm_stage: 1, phone: 1, current_title: 1, current_company: 1 } })).map((c) => [c.id as string, c]));
      const stageLabel = new Map(stagesOf(await crmSettings(tx)).map((s) => [s.key, s.label]));
      return {
        counts,
        rows: rows.map((f) => {
          const c = cands.get(f.candidate_id) ?? {};
          return {
            ...followUpView(f, name, now), candidateName: candidateName(c), candidateCode: c.candidate_code ?? null, candidatePhone: c.phone ?? null,
            candidateStage: stageLabel.get(c.crm_stage ?? 'new') ?? c.crm_stage ?? null, candidateTitle: [c.current_title, c.current_company].filter(Boolean).join(' at ') || null,
          };
        }),
      };
    });
  }

  // Documents --------------------------------------------------------------------------------------------------

  private checkDocument(file: UploadedFile | undefined) {
    if (!file?.buffer?.length) throw Errors.badRequest('file_required', 'Choose a file');
    if (!(CRM_DOCUMENT_TYPES as readonly string[]).includes(file.mimetype)) throw Errors.badRequest('unsupported_type', 'Upload a PDF, Word document (DOC or DOCX), image (JPEG, PNG, WebP) or text file');
    if (file.size <= 0 || file.size > CRM_DOCUMENT_MAX_BYTES) throw Errors.badRequest('file_too_large', 'A document can be up to 10 MB');
    if (!sniffMatches(file.mimetype, file.buffer.subarray(0, 512))) throw Errors.badRequest('content_mismatch', 'The file content does not match its type');
  }

  private async store(tx: TenantTx, a: CrmActor, candidateId: string, file: UploadedFile, row: Doc) {
    const key = this.storage.newKey(requestContext.tenantActor().tenantId);
    await this.storage.put(key, file.buffer, { upload: true });
    return tx.collection('candidate_files').insert({
      candidate_id: candidateId, file_name: safeFileName(file.originalname, 'document'), content_type: file.mimetype, size_bytes: file.size,
      sha256: createHash('sha256').update(file.buffer).digest('hex'), storage_key: key, uploaded_by_membership_id: a.membershipId, ...row,
    });
  }

  async uploadDocument(candidateId: string, file: UploadedFile | undefined, meta: z.infer<typeof crmDocumentMeta>) {
    this.checkDocument(file);
    return this.db.tenant(async (tx) => {
      const { a } = await this.open(tx, candidateId);
      if (await tx.collection('candidate_files').count({ candidate_id: candidateId, deleted_at: null, superseded_at: null }) >= 50) throw Errors.badRequest('too_many_documents', 'A candidate can have up to 50 documents');
      const name = meta.name || file!.originalname.replace(/\.[a-z0-9]{1,5}$/i, '').slice(0, 160) || 'Document';
      const row = await this.store(tx, a, candidateId, file!, { kind: meta.kind, name, notes: meta.notes || null, version: 1 });
      await recordActivity(tx, candidateId, 'document_uploaded', { detail: { fileId: row.id, kind: meta.kind, name } });
      await this.audit.record(tx, { action: 'candidate_file.uploaded', resourceType: 'candidate', resourceId: candidateId, metadata: { fileId: row.id, kind: meta.kind, via: 'candidate_crm' } });
      return { id: row.id as string };
    });
  }

  /** A new version of a document. The earlier file is kept as a previous version. */
  async replaceDocument(fileId: string, file: UploadedFile | undefined, notes?: string) {
    this.checkDocument(file);
    return this.db.tenant(async (tx) => {
      const old = await tx.collection('candidate_files').findOne({ id: fileId, deleted_at: null });
      if (!old) throw Errors.notFound('Document');
      const { a } = await this.open(tx, old.candidate_id);
      if (old.superseded_at) throw Errors.conflict('not_latest', 'Replace the latest version of this document');
      const version = ((old.version as number) ?? 1) + 1;
      const row = await this.store(tx, a, old.candidate_id, file!, { kind: old.kind, name: old.name ?? old.file_name, notes: notes || old.notes || null, version, replaces_file_id: old.id });
      await tx.collection('candidate_files').updateOne({ id: old.id }, { $set: { superseded_at: new Date() } });
      await recordActivity(tx, old.candidate_id, 'document_replaced', { detail: { fileId: row.id, previousId: old.id, name: old.name ?? old.file_name, version } });
      await this.audit.record(tx, { action: 'candidate_file.replaced', resourceType: 'candidate', resourceId: old.candidate_id, metadata: { fileId: row.id, previousId: old.id, version } });
      return { id: row.id as string, version };
    });
  }

  /** Deletes a document and its earlier versions (needs the archive and delete power). The files are removed. */
  async deleteDocument(fileId: string) {
    return this.db.tenant(async (tx) => {
      const f = await tx.collection('candidate_files').findOne({ id: fileId, deleted_at: null });
      if (!f) throw Errors.notFound('Document');
      const { a, c } = await this.open(tx, f.candidate_id);
      this.access.require(a, 'archive', c);
      const chain: Doc[] = [f];
      let prev = f.replaces_file_id as string | null;
      while (prev && chain.length < 60) {
        const p = await tx.collection('candidate_files').findOne({ id: prev, deleted_at: null });
        if (!p) break;
        chain.push(p);
        prev = p.replaces_file_id ?? null;
      }
      for (const x of chain) {
        await tx.collection('candidate_files').updateOne({ id: x.id }, { $set: { deleted_at: new Date(), deleted_by_membership_id: a.membershipId } });
        await this.storage.remove(x.storage_key);
      }
      await recordActivity(tx, f.candidate_id, 'document_deleted', { detail: { fileId, name: f.name ?? f.file_name, versions: chain.length } });
      await this.audit.record(tx, { action: 'candidate_file.deleted', resourceType: 'candidate', resourceId: f.candidate_id, metadata: { fileId, versions: chain.length } });
      return { deleted: chain.length };
    });
  }

  /** Opens a document for the person (download, or shown in the browser for PDFs, images and text). Audited. */
  async openDocument(fileId: string) {
    const f = await this.db.tenant(async (tx) => {
      const doc = await tx.collection('candidate_files').findOne({ id: fileId, deleted_at: null });
      if (!doc) throw Errors.notFound('Document');
      await this.open(tx, doc.candidate_id, 'read');
      await this.audit.record(tx, { action: 'candidate_file.downloaded', resourceType: 'candidate', resourceId: doc.candidate_id, metadata: { fileId, via: 'candidate_crm' } });
      return doc;
    });
    return { ...(await this.storage.open(f.storage_key)), fileName: f.file_name as string, contentType: f.content_type as string };
  }
}
