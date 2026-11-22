import { HttpStatus, Injectable } from '@nestjs/common';
import {
  atsSourceOf, CRM_CENTRAL, CRM_EXPORT_COLUMNS, crmLabel, type CrmBulkInput, type CrmCandidateInput, type CrmCandidatePatch, type CrmExportInput, type CrmListQuery,
  type CrmSettingsInput, CRM_PHOTO_MAX_BYTES, CRM_PHOTO_TYPES, crmListQuery, DEFAULT_CRM_STAGES, DOCUMENT_KINDS, experienceText, FOLLOW_UP_TYPES, noticeText, phoneKey,
  REFERENCE_TYPES, REMARK_CATEGORIES,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { ilike, membershipUserNames, MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { type Cell, toXlsx } from '../../platform/export/tabular';
import { AppError, Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { sniffMatches, StorageService } from '../../platform/storage/storage.service';
import { requestContext } from '../../platform/context/request-context';
import type { UploadedFile } from '../documents/documents.service';
import { uniqueAs } from '../employees/employees.service';
import { CandidatesService } from '../recruitment/candidates.service';
import { candidateName, loadRequisition, reqAttrs } from '../recruitment/recruitment-common';
import { type CrmActor, CrmAccessService } from './crm-access.service';
import {
  crmSettings, dayBounds, type Doc, ensureCrmRecords, nextCandidateCode, phonePattern, recordActivity, refreshNextFollowUp, sourcesOf, stagesOf, tenantZone,
} from './crm-common';
import { CrmFieldsService } from './crm-fields.service';
import { docFields, moneyCell, profileView, touchesSensitive } from './crm-mapping';

const LIST_PROJECTION = {
  candidate_code: 1, first_name: 1, middle_name: 1, last_name: 1, email: 1, phone: 1, profession: 1, current_title: 1, current_company: 1, total_experience_months: 1,
  relevant_experience_months: 1, current_ctc: 1, expected_ctc: 1, comp_currency: 1, comp_basis: 1, notice: 1, notice_days: 1, city: 1, state: 1, country_code: 1, location_text: 1,
  crm_stage: 1, crm_stage_entered_at: 1, assigned_recruiter_membership_id: 1, next_follow_up_at: 1, last_activity_at: 1, crm_source: 1, source: 1, industry: 1, department_name: 1,
  job_role: 1, crm_hr_workspace_id: 1, crm_shared_hr_workspace_ids: 1, tags: 1, photo_storage_key: 1, crm_archived_at: 1, created_at: 1, updated_at: 1, reference_types: 1, skills: 1,
  created_by_membership_id: 1, personal: 1, professional: 1, links: 1,
};

const SORT: Record<string, Doc> = {
  recent: { created_at: -1 }, updated: { updated_at: -1 }, name: { first_name: 1, last_name: 1 }, experience: { total_experience_months: -1 },
  expected_ctc: { expected_ctc: -1 }, follow_up: { next_follow_up_at: 1 },
};

/**
 * Candidate CRM: the company's one candidate database, worked like a CRM. Every read and write goes through the
 * person's CRM access (CrmAccessService), so an HR Workspace only ever sees its own candidates and those Super
 * Workspace shared with it; job applications stay the ATS's, linked from the profile.
 */
@Injectable()
export class CrmService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: CrmAccessService,
    private readonly fields: CrmFieldsService,
    private readonly audit: AuditService,
    private readonly authz: AuthzService,
    private readonly notifications: NotificationService,
    private readonly storage: StorageService,
    private readonly candidates: CandidatesService,
  ) {}

  // ------------------------------------------------------------------------------------------------------------
  // Finding candidates
  // ------------------------------------------------------------------------------------------------------------

  /** The filter for a list query, inside what the person may see. */
  async filterFor(tx: TenantTx, a: CrmActor, q: Partial<CrmListQuery>): Promise<Doc> {
    const and: Doc[] = [this.access.filter(a), { anonymized_at: null }];
    if (q.archived === 'only') and.push({ crm_archived_at: { $ne: null } });
    else if (q.archived !== 'include') and.push({ crm_archived_at: null });
    if (q.q) {
      const m = ilike(q.q);
      const digits = q.q.replace(/\D/g, '');
      and.push({
        $or: [
          { $expr: { $regexMatch: { input: { $concat: ['$first_name', ' ', { $ifNull: ['$last_name', ''] }] }, regex: m.$regex, options: 'i' } } },
          { email: m }, { candidate_code: m }, { current_company: m }, { current_title: m }, { profession: m }, { skills: m },
          ...(digits.length >= 5 ? [{ phone: { $regex: phonePattern(digits, false) } }] : []),
        ],
      });
    }
    if (q.stage?.length) and.push({ crm_stage: { $in: q.stage } });
    if (q.source?.length) and.push({ crm_source: { $in: q.source } });
    if (q.recruiter) {
      if (q.recruiter === 'me') and.push({ assigned_recruiter_membership_id: a.membershipId });
      else if (q.recruiter === 'none') and.push({ assigned_recruiter_membership_id: null });
      else and.push({ assigned_recruiter_membership_id: q.recruiter });
    }
    if (q.hrWorkspace) and.push(q.hrWorkspace === CRM_CENTRAL ? { crm_hr_workspace_id: null } : { $or: [{ crm_hr_workspace_id: q.hrWorkspace }, { crm_shared_hr_workspace_ids: q.hrWorkspace }] });
    if (q.industry) and.push({ industry: ilike(q.industry) });
    if (q.department) and.push({ department_name: ilike(q.department) });
    if (q.jobRole) and.push({ $or: [{ job_role: ilike(q.jobRole) }, { current_title: ilike(q.jobRole) }] });
    if (q.location) and.push({ $or: [{ city: ilike(q.location) }, { state: ilike(q.location) }, { location_text: ilike(q.location) }] });
    if (q.skills?.length) and.push({ skills: { $all: q.skills.map((s) => s.toLowerCase()) } });
    if (q.referenceType) and.push({ reference_types: q.referenceType });
    if (q.tag) and.push({ tags: q.tag });
    const range = (col: string, min?: number, max?: number, scale = 1) => {
      const r: Doc = {};
      if (min !== undefined) r.$gte = min * scale;
      if (max !== undefined) r.$lte = max * scale;
      if (Object.keys(r).length) and.push({ [col]: r });
    };
    range('total_experience_months', q.minExp, q.maxExp, 12);
    range('current_ctc', q.minCtc, q.maxCtc);
    range('expected_ctc', q.minExpected, q.maxExpected);
    if (q.maxNotice !== undefined) and.push({ notice_days: { $lte: q.maxNotice } });
    if (q.followUp) {
      const { start, end } = dayBounds(await tenantZone(tx));
      if (q.followUp === 'none') and.push({ next_follow_up_at: null });
      else if (q.followUp === 'any') and.push({ next_follow_up_at: { $ne: null } });
      else if (q.followUp === 'overdue') and.push({ next_follow_up_at: { $lt: new Date() } });
      else if (q.followUp === 'today') and.push({ next_follow_up_at: { $gte: start, $lt: end } });
      else and.push({ next_follow_up_at: { $lt: end } });
    }
    if (q.createdFrom) and.push({ created_at: { $gte: new Date(`${q.createdFrom}T00:00:00Z`) } });
    if (q.createdTo) and.push({ created_at: { $lt: new Date(Date.parse(`${q.createdTo}T00:00:00Z`) + 86_400_000) } });
    if (q.ids?.length) and.push({ id: { $in: q.ids } });
    if (q.cf && Object.keys(q.cf).length) {
      const defs = new Map((await this.fields.definitionsForActor(tx, a, 'filter')).map((d) => [d.key as string, d]));
      for (const [key, raw] of Object.entries(q.cf)) {
        const d = defs.get(key);
        if (!d || raw === '') continue;
        const value = ['short_text', 'long_text', 'email', 'url', 'phone'].includes(d.type) ? ilike(raw)
          : ['number', 'decimal', 'currency'].includes(d.type) ? Number(raw)
            : ['checkbox', 'yes_no'].includes(d.type) ? raw === 'true' || raw === 'yes'
              : raw;
        const ids = await tx.collection('custom_field_values').distinct<string>('record_id', { field_id: d.id, value });
        and.push({ id: { $in: ids } });
      }
    }
    return { $and: and };
  }

  /** Candidates as the list shows them, with the count of all that match. */
  async list(q: CrmListQuery) {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx);
      await ensureCrmRecords(tx);
      const filter = await this.filterFor(tx, a, q);
      const table = tx.collection('candidates');
      const total = await table.count(filter);
      let docs: Doc[];
      if (q.sort === 'stage') {
        const order = new Map(stagesOf(await crmSettings(tx)).map((s) => [s.key, s.position]));
        const keys = await table.find(filter, { projection: { crm_stage: 1, created_at: 1 } });
        keys.sort((x, y) => ((order.get(x.crm_stage) ?? 99) - (order.get(y.crm_stage) ?? 99)) * (q.dir === 'desc' ? -1 : 1) || +new Date(y.created_at) - +new Date(x.created_at));
        const page = keys.slice(q.offset, q.offset + q.limit).map((k) => k.id as string);
        const byId = new Map((await table.find({ id: { $in: page } }, { projection: LIST_PROJECTION })).map((c) => [c.id as string, c]));
        docs = page.map((id) => byId.get(id)!).filter(Boolean);
      } else {
        const base = SORT[q.sort] ?? SORT.recent!;
        const sort = q.dir ? Object.fromEntries(Object.keys(base).map((k) => [k, q.dir === 'asc' ? 1 : -1])) : base;
        docs = await table.find(filter, { projection: LIST_PROJECTION, sort: { ...sort, _id: 1 }, skip: q.offset, limit: q.limit });
      }
      const rows = await this.rowViews(tx, a, docs);
      return { total, offset: q.offset, limit: q.limit, rows };
    });
  }

  /** List rows: the columns the list and the pipeline cards show, and custom field texts. */
  async rowViews(tx: TenantTx, a: CrmActor, docs: Doc[]) {
    if (!docs.length) return [];
    const settings = await crmSettings(tx);
    const stages = new Map(stagesOf(settings).map((s) => [s.key, s]));
    const sources = new Map(sourcesOf(settings).map((s) => [s.key, s.label]));
    const ids = docs.map((c) => c.id as string);
    const names = await membershipUserNames(tx, docs.map((c) => c.assigned_recruiter_membership_id));
    const spaces = new Map((await tx.collection('hr_workspaces').find({}, { projection: { name: 1 } })).map((w) => [w.id as string, w.name as string]));
    const refs = new Map<string, Doc>();
    for (const r of await tx.collection('candidate_references').find({ candidate_id: { $in: ids } }, { sort: { created_at: 1 } })) if (!refs.has(r.candidate_id)) refs.set(r.candidate_id, r);
    const defs = await this.fields.definitionsForActor(tx, a);
    const values = await this.fields.values(tx, ids, defs);
    const apps = new Map<string, number>();
    for (const x of await tx.collection('applications').aggregate<{ id: string; n: number }>([{ $match: { candidate_id: { $in: ids }, status: 'active' } }, { $group: { _id: '$candidate_id', n: { $sum: 1 } } }])) apps.set(x.id, x.n);
    return docs.map((c) => {
      const ref = refs.get(c.id);
      const stage = stages.get(c.crm_stage ?? 'new');
      const custom: Record<string, string> = {};
      for (const [k, v] of Object.entries(values.get(c.id) ?? {})) custom[k] = v.text;
      return {
        id: c.id as string, candidateCode: c.candidate_code ?? null, name: candidateName(c), email: c.email ?? null, phone: c.phone ?? null,
        profession: c.profession ?? null, currentTitle: c.current_title ?? null, currentCompany: c.current_company ?? null,
        experienceMonths: c.total_experience_months ?? null, experience: experienceText(c.total_experience_months),
        currency: c.comp_currency ?? 'INR', basis: c.comp_basis ?? 'annual', currentCtc: c.current_ctc ?? null, expectedCtc: c.expected_ctc ?? null,
        currentCtcText: moneyCell(c.current_ctc, c.comp_currency), expectedCtcText: moneyCell(c.expected_ctc, c.comp_currency),
        notice: noticeText(c.notice), noticeDays: c.notice_days ?? null,
        location: [c.city, c.state].filter(Boolean).join(', ') || c.location_text || null,
        reference: ref ? [ref.name, crmLabel(REFERENCE_TYPES, ref.type)].filter(Boolean).join(' · ') : null,
        referenceTypes: (c.reference_types ?? []) as string[],
        stage: (c.crm_stage as string | null) ?? 'new', stageLabel: stage?.label ?? c.crm_stage ?? 'New Candidate', stageKind: stage?.kind ?? 'open', stageEnteredAt: c.crm_stage_entered_at ?? null,
        recruiterId: c.assigned_recruiter_membership_id ?? null, recruiter: c.assigned_recruiter_membership_id ? names.get(c.assigned_recruiter_membership_id) ?? null : null,
        nextFollowUpAt: c.next_follow_up_at ?? null, lastActivityAt: c.last_activity_at ?? null,
        source: c.crm_source ?? null, sourceLabel: c.crm_source ? sources.get(c.crm_source) ?? c.crm_source : crmLabel([['career_site', 'Career site'], ['referral', 'Referral'], ['agency', 'Agency'], ['sourced', 'Sourced'], ['manual', 'Added by hand']] as const, c.source),
        industry: c.industry ?? null, department: c.department_name ?? null, jobRole: c.job_role ?? null,
        hrWorkspaceId: c.crm_hr_workspace_id ?? null, hrWorkspace: c.crm_hr_workspace_id ? spaces.get(c.crm_hr_workspace_id) ?? 'HR Workspace' : 'Super Workspace',
        tags: (c.tags ?? []) as string[], hasPhoto: !!c.photo_storage_key, archivedAt: c.crm_archived_at ?? null, createdAt: c.created_at, updatedAt: c.updated_at,
        activeApplications: apps.get(c.id) ?? 0, custom,
      };
    });
  }

  /** The pipeline: each stage with its candidates (up to 60 shown per stage) and how many are in it. */
  async pipeline(q: CrmListQuery) {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx);
      await ensureCrmRecords(tx);
      const settings = await crmSettings(tx);
      const stages = stagesOf(settings);
      const filter = await this.filterFor(tx, a, q);
      const all = await tx.collection('candidates').find(filter, { projection: { crm_stage: 1, crm_stage_entered_at: 1 }, sort: { crm_stage_entered_at: -1, _id: 1 } });
      const byStage = new Map<string, string[]>();
      for (const c of all) {
        const k = stages.some((s) => s.key === c.crm_stage) ? (c.crm_stage as string) : 'new';
        byStage.set(k, [...(byStage.get(k) ?? []), c.id as string]);
      }
      const shown = [...byStage.values()].flatMap((ids) => ids.slice(0, 60));
      const docs = await tx.collection('candidates').find({ id: { $in: shown } }, { projection: LIST_PROJECTION });
      const views = new Map((await this.rowViews(tx, a, docs)).map((r) => [r.id, r]));
      return {
        total: all.length,
        stages: stages.filter((s) => s.active || byStage.has(s.key)).map((s) => ({
          ...s, count: byStage.get(s.key)?.length ?? 0, candidates: (byStage.get(s.key) ?? []).slice(0, 60).map((id) => views.get(id)!).filter(Boolean),
        })),
      };
    });
  }

  // ------------------------------------------------------------------------------------------------------------
  // Overview
  // ------------------------------------------------------------------------------------------------------------

  async overview() {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx);
      await ensureCrmRecords(tx);
      const settings = await crmSettings(tx);
      const stages = stagesOf(settings);
      const sources = new Map(sourcesOf(settings).map((s) => [s.key, s.label]));
      const tz = await tenantZone(tx);
      const { start, end, date } = dayBounds(tz);
      const monthStart = new Date(Date.parse(`${date.slice(0, 8)}01T00:00:00Z`) - (Date.parse(`${date}T00:00:00Z`) - start.getTime()));
      const visible = { $and: [this.access.filter(a), { anonymized_at: null, crm_archived_at: null }] };
      const cands = await tx.collection('candidates').find(visible, {
        projection: { crm_stage: 1, crm_source: 1, source: 1, created_at: 1, assigned_recruiter_membership_id: 1, crm_stage_entered_at: 1, crm_hr_workspace_id: 1 },
      });
      const ids = cands.map((c) => c.id as string);
      const kindOf = new Map(stages.map((s) => [s.key, s.kind]));
      const count = <K extends string>(xs: K[]) => xs.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<K, number>());
      const stageCounts = count(cands.map((c) => (c.crm_stage as string) ?? 'new'));
      const kinds = count(cands.map((c) => kindOf.get(c.crm_stage ?? 'new') ?? 'open'));
      const sourceCounts = count(cands.map((c) => (c.crm_source as string) ?? `ats:${c.source}`));

      const ups = await tx.collection('candidate_follow_ups').find({ candidate_id: { $in: ids }, status: { $in: ['pending', 'rescheduled'] } }, { projection: { due_at: 1, assigned_membership_id: 1, candidate_id: 1, type: 1, priority: 1 } });
      const now = new Date();
      const overdue = ups.filter((f) => new Date(f.due_at) < now);
      const today = ups.filter((f) => new Date(f.due_at) >= now && new Date(f.due_at) < end);
      const upcoming = ups.filter((f) => new Date(f.due_at) >= end && new Date(f.due_at) < new Date(end.getTime() + 7 * 86_400_000));
      const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
      const doneWeek = await tx.collection('candidate_follow_ups').count({ candidate_id: { $in: ids }, status: 'completed', completed_at: { $gte: weekAgo } });
      const missedWeek = await tx.collection('candidate_follow_ups').count({ candidate_id: { $in: ids }, status: 'missed', updated_at: { $gte: weekAgo } });

      // Candidates added per week, the last 12 weeks.
      const weeks: { week: string; added: number; joined: number }[] = [];
      const joinedAt = await tx.collection('candidate_activities').find({ candidate_id: { $in: ids }, kind: 'stage_changed', 'detail.to': 'joined', occurred_at: { $gte: new Date(start.getTime() - 84 * 86_400_000) } }, { projection: { occurred_at: 1 } });
      for (let w = 11; w >= 0; w--) {
        const from = new Date(start.getTime() - (w * 7 + 6) * 86_400_000);
        const to = new Date(start.getTime() - (w * 7 - 1) * 86_400_000);
        weeks.push({
          week: from.toISOString().slice(0, 10),
          added: cands.filter((c) => new Date(c.created_at) >= from && new Date(c.created_at) < to).length,
          joined: joinedAt.filter((x) => new Date(x.occurred_at) >= from && new Date(x.occurred_at) < to).length,
        });
      }

      // Recruiter-wise view.
      const thirty = new Date(now.getTime() - 30 * 86_400_000);
      const acts = await tx.collection('candidate_activities').find({ candidate_id: { $in: ids }, occurred_at: { $gte: thirty }, automatic: false }, { projection: { created_by_membership_id: 1, kind: 1, outcome: 1 } });
      const recruiterIds = [...new Set([...cands.map((c) => c.assigned_recruiter_membership_id), ...acts.map((x) => x.created_by_membership_id)].filter(Boolean))] as string[];
      const names = await membershipUserNames(tx, recruiterIds);
      const recruiters = recruiterIds.map((m) => {
        const mine = cands.filter((c) => c.assigned_recruiter_membership_id === m);
        return {
          membershipId: m, name: names.get(m) ?? 'Someone', assigned: mine.length,
          open: mine.filter((c) => (kindOf.get(c.crm_stage ?? 'new') ?? 'open') === 'open').length,
          joined: mine.filter((c) => kindOf.get(c.crm_stage) === 'won').length,
          pendingFollowUps: ups.filter((f) => f.assigned_membership_id === m).length,
          overdueFollowUps: overdue.filter((f) => f.assigned_membership_id === m).length,
          activities30: acts.filter((x) => x.created_by_membership_id === m).length,
          calls30: acts.filter((x) => x.created_by_membership_id === m && x.kind === 'call').length,
        };
      }).sort((x, y) => y.assigned - x.assigned || x.name.localeCompare(y.name));

      const recent = await tx.collection('candidate_activities').find({ candidate_id: { $in: ids } }, { sort: { occurred_at: -1 }, limit: 12 });
      const recentNames = await membershipUserNames(tx, recent.map((r) => r.created_by_membership_id));
      const candNames = new Map((await tx.collection('candidates').find({ id: { $in: [...new Set(recent.map((r) => r.candidate_id))] } }, { projection: { first_name: 1, last_name: 1, candidate_code: 1 } })).map((c) => [c.id as string, c]));
      const stageLabel = new Map(stages.map((s) => [s.key, s.label]));
      const mineDue = [...overdue, ...today].filter((f) => f.assigned_membership_id === a.membershipId);
      const dueCands = new Map((await tx.collection('candidates').find({ id: { $in: mineDue.map((f) => f.candidate_id) } }, { projection: { first_name: 1, last_name: 1, candidate_code: 1 } })).map((c) => [c.id as string, c]));

      const total = cands.length;
      const reachedInterview = cands.filter((c) => {
        const pos = stages.find((s) => s.key === c.crm_stage);
        const iv = stages.find((s) => s.key === 'interview_scheduled');
        return pos && iv && (pos.kind === 'won' || (pos.kind === 'open' && pos.position >= iv.position));
      }).length;
      return {
        totals: {
          candidates: total,
          addedThisMonth: cands.filter((c) => new Date(c.created_at) >= monthStart).length,
          addedToday: cands.filter((c) => new Date(c.created_at) >= start).length,
          inProgress: kinds.get('open') ?? 0, joined: kinds.get('won') ?? 0, closed: kinds.get('lost') ?? 0, onHold: kinds.get('paused') ?? 0,
          archived: await tx.collection('candidates').count({ $and: [this.access.filter(a), { anonymized_at: null, crm_archived_at: { $ne: null } }] }),
          unassigned: cands.filter((c) => !c.assigned_recruiter_membership_id).length,
        },
        conversion: {
          interviewRate: total ? Math.round((reachedInterview / total) * 100) : 0,
          joinRate: total ? Math.round(((kinds.get('won') ?? 0) / total) * 100) : 0,
        },
        followUps: { overdue: overdue.length, today: today.length, upcoming: upcoming.length, completedThisWeek: doneWeek, missedThisWeek: missedWeek },
        myDay: mineDue.sort((x, y) => +new Date(x.due_at) - +new Date(y.due_at)).slice(0, 10).map((f) => ({
          id: f.id, candidateId: f.candidate_id, candidateName: candidateName(dueCands.get(f.candidate_id) ?? {}), candidateCode: dueCands.get(f.candidate_id)?.candidate_code ?? null,
          dueAt: f.due_at, type: crmLabel(FOLLOW_UP_TYPES, f.type), priority: f.priority, overdue: new Date(f.due_at) < now,
        })),
        stages: stages.map((s) => ({ key: s.key, label: s.label, kind: s.kind, count: stageCounts.get(s.key) ?? 0 })).filter((s) => s.count || stages.find((x) => x.key === s.key)?.active),
        sources: [...sourceCounts.entries()].map(([k, n]) => ({ key: k, label: k.startsWith('ats:') ? ({ 'ats:career_site': 'Career site', 'ats:referral': 'Referral', 'ats:agency': 'Agency', 'ats:sourced': 'Sourced', 'ats:manual': 'Added by hand' } as Record<string, string>)[k] ?? 'Other' : sources.get(k) ?? k, count: n })).sort((x, y) => y.count - x.count),
        weeks,
        recruiters,
        recent: recent.map((r) => ({
          id: r.id, candidateId: r.candidate_id, candidateName: candidateName(candNames.get(r.candidate_id) ?? {}), candidateCode: candNames.get(r.candidate_id)?.candidate_code ?? null,
          kind: r.kind, automatic: r.automatic, outcome: r.outcome ?? null, subject: r.subject ?? null, detail: describeDetail(r, stageLabel), occurredAt: r.occurred_at,
          by: r.created_by_membership_id ? recentNames.get(r.created_by_membership_id) ?? null : null,
        })),
      };
    });
  }

  // ------------------------------------------------------------------------------------------------------------
  // The 360° profile
  // ------------------------------------------------------------------------------------------------------------

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx);
      await ensureCrmRecords(tx);
      const c = await this.access.candidate(tx, a, id);
      const sensitive = this.access.has(a, 'sensitive', c);
      const settings = await crmSettings(tx);
      const stages = stagesOf(settings);
      const stageLabel = new Map(stages.map((s) => [s.key, s.label]));
      const refs = await tx.collection('candidate_references').find({ candidate_id: id }, { sort: { created_at: 1 } });
      const notes = await tx.collection('candidate_notes').find({ candidate_id: id, ...(sensitive ? {} : { restricted: false }) }, { sort: { created_at: -1 } });
      const files = await tx.collection('candidate_files').find({ candidate_id: id, deleted_at: null }, { sort: { created_at: -1 } });
      const ups = await tx.collection('candidate_follow_ups').find({ candidate_id: id }, { sort: { due_at: -1 } });
      const acts = await tx.collection('candidate_activities').find({ candidate_id: id }, { sort: { occurred_at: -1, created_at: -1 }, limit: 300 });
      const apps = await tx.collection('applications').find({ candidate_id: id }, { sort: { applied_at: -1 } });
      const reqs = new Map((await tx.collection('job_requisitions').find({ id: { $in: apps.map((x) => x.requisition_id) } }, { projection: { code: 1, title: 1, status: 1 } })).map((r) => [r.id as string, r]));
      const atsStages = new Map((await tx.collection('recruitment_stages').find({ id: { $in: apps.map((x) => x.stage_id) } }, { projection: { name: 1 } })).map((s) => [s.id as string, s.name as string]));
      const interviews = apps.length ? await tx.collection('interviews').find({ application_id: { $in: apps.map((x) => x.id) } }, { sort: { starts_at: -1 } }) : [];
      const offers = apps.length ? await tx.collection('offers').find({ application_id: { $in: apps.map((x) => x.id) } }, { projection: { application_id: 1, status: 1, job_title: 1, created_at: 1 }, sort: { created_at: -1 } }) : [];
      const people = await membershipUserNames(tx, [
        c.assigned_recruiter_membership_id, c.created_by_membership_id, c.updated_by_membership_id, ...notes.map((n) => n.author_membership_id), ...files.map((f) => f.uploaded_by_membership_id),
        ...ups.flatMap((f) => [f.assigned_membership_id, f.created_by_membership_id, f.completed_by_membership_id]), ...acts.map((x) => x.created_by_membership_id), ...refs.map((r) => r.created_by_membership_id),
      ]);
      const name = (m: string | null | undefined) => (m ? people.get(m) ?? 'Someone' : null);
      const spaces = new Map((await tx.collection('hr_workspaces').find({}, { projection: { name: 1 } })).map((w) => [w.id as string, w.name as string]));
      const defs = (await this.fields.definitionsFor(tx, c.crm_hr_workspace_id ?? null)).filter((d) => ['profile', 'form'].some((f) => (d.config?.flags ?? ['profile']).includes(f)));
      const vals = (await this.fields.values(tx, [id], defs)).get(id) ?? {};
      const current = files.filter((f) => !f.superseded_at);
      const now = new Date();
      return {
        candidate: {
          ...profileView(c, sensitive),
          recruiterName: name(c.assigned_recruiter_membership_id), createdByName: name(c.created_by_membership_id), updatedByName: name(c.updated_by_membership_id),
          hrWorkspaceName: c.crm_hr_workspace_id ? spaces.get(c.crm_hr_workspace_id) ?? 'HR Workspace' : 'Super Workspace',
          sharedWith: ((c.crm_shared_hr_workspace_ids ?? []) as string[]).map((w) => ({ id: w, name: spaces.get(w) ?? 'HR Workspace' })),
          stageLabel: stageLabel.get(c.crm_stage ?? 'new') ?? c.crm_stage,
        },
        references: refs.map((r) => ({ id: r.id, type: r.type, typeLabel: crmLabel(REFERENCE_TYPES, r.type), name: r.name ?? null, phone: r.phone ?? null, email: r.email ?? null, company: r.company ?? null, relationship: r.relationship ?? null, details: r.details ?? null, createdAt: r.created_at, createdBy: name(r.created_by_membership_id) })),
        remarks: notes.map((n) => ({
          id: n.id, body: n.body, category: n.category ?? 'general', categoryLabel: crmLabel(REMARK_CATEGORIES, n.category ?? 'general'), restricted: !!n.restricted, applicationId: n.application_id ?? null,
          activityId: n.activity_id ?? null, createdAt: n.created_at, author: name(n.author_membership_id), authorLevel: n.author_level ?? null,
          authorHrWorkspace: n.author_hr_workspace_id ? spaces.get(n.author_hr_workspace_id) ?? null : null,
        })),
        documents: current.map((f) => ({
          ...fileView(f, name), kindLabel: crmLabel(DOCUMENT_KINDS, f.kind),
          versions: versionsOf(f, files).map((v) => fileView(v, name)),
        })),
        followUps: ups.map((f) => followUpView(f, name, now)),
        activities: acts.map((x) => ({
          id: x.id, kind: x.kind, automatic: !!x.automatic, subject: x.subject ?? null, outcome: x.outcome ?? null, remarks: x.remarks ?? null, durationMinutes: x.duration_minutes ?? null,
          detail: x.detail ?? {}, text: describeDetail(x, stageLabel), occurredAt: x.occurred_at, by: name(x.created_by_membership_id),
        })),
        applications: apps.map((x) => ({
          id: x.id, requisitionId: x.requisition_id, requisitionCode: reqs.get(x.requisition_id)?.code ?? null, requisitionTitle: reqs.get(x.requisition_id)?.title ?? null,
          stage: atsStages.get(x.stage_id) ?? null, status: x.status, appliedAt: x.applied_at, offerStatus: offers.find((o) => o.application_id === x.id)?.status ?? null,
          interviews: interviews.filter((i) => i.application_id === x.id).map((i) => ({ id: i.id, title: i.title, startsAt: i.starts_at, status: i.status, mode: i.mode })),
        })),
        customFields: defs.map((d) => ({ key: d.key, label: d.label, type: d.type, group: d.section ?? null, value: vals[d.key]?.value ?? null, text: vals[d.key]?.text ?? '' })),
        can: {
          edit: a.canManage && !c.anonymized_at,
          archive: a.canManage && this.access.has(a, 'archive', c),
          share: a.level === 'super' && a.canManage,
          sensitive,
          export: this.access.has(a, 'export', c),
          openAts: apps.length > 0,
        },
      };
    });
  }

  // ------------------------------------------------------------------------------------------------------------
  // Adding and changing candidates
  // ------------------------------------------------------------------------------------------------------------

  /** Refuses a duplicate: the same email, or (unless allowed) the same phone number, as a record in the company. */
  async checkDuplicates(tx: TenantTx, a: CrmActor, p: { email?: string | null; phone?: string | null }, opts: { exceptId?: string; allowPhone?: boolean } = {}) {
    const settings = await crmSettings(tx);
    const match = new Set((settings.match_fields as string[] | undefined) ?? ['email', 'phone', 'candidate_code']);
    const not = opts.exceptId ? { id: { $ne: opts.exceptId } } : {};
    const found = async (filter: Doc, what: 'email' | 'phone') => {
      const other = await tx.collection('candidates').findOne({ ...filter, anonymized_at: null, ...not }, { projection: { candidate_code: 1, first_name: 1, last_name: 1, crm_hr_workspace_id: 1, crm_shared_hr_workspace_ids: 1 } });
      if (!other) return;
      const mine = (await tx.collection('candidates').count({ $and: [{ id: other.id }, this.access.filter(a)] })) > 0;
      if (mine) {
        throw new AppError(HttpStatus.CONFLICT, what === 'email' ? 'candidate_exists' : 'possible_duplicate',
          what === 'email' ? `${candidateName(other)} (${other.candidate_code ?? 'no ID yet'}) already has this email address.` : `${candidateName(other)} (${other.candidate_code ?? 'no ID yet'}) has the same phone number. Open their record, or add this person anyway if they are someone else.`,
          { candidateId: other.id, candidateCode: other.candidate_code ?? null, name: candidateName(other), field: what });
      }
      throw new AppError(HttpStatus.CONFLICT, 'candidate_exists_elsewhere', `This candidate is already in the company’s candidate database under another HR Workspace. Ask your Super Workspace to share the record with you.`, { field: what });
    };
    if (p.email && match.has('email')) await found({ email: p.email }, 'email');
    const key = phoneKey(p.phone);
    if (key && match.has('phone') && !opts.allowPhone) await found({ phone: { $regex: phonePattern(key) } }, 'phone');
  }

  private async checkChoices(tx: TenantTx, a: CrmActor, p: { stage?: string; source?: string | null; assignedRecruiterMembershipId?: string | null }) {
    const settings = await crmSettings(tx);
    if (p.stage !== undefined && !stagesOf(settings).some((s) => s.key === p.stage && s.active)) throw Errors.validation([{ path: 'stage', message: 'Choose a stage from the pipeline' }]);
    if (p.source && !sourcesOf(settings).some((s) => s.key === p.source)) throw Errors.validation([{ path: 'source', message: 'Choose a source from the list' }]);
    if (p.assignedRecruiterMembershipId) {
      const ok = (await this.access.recruiters(tx, a)).some((r) => r.membershipId === p.assignedRecruiterMembershipId);
      if (!ok) throw Errors.validation([{ path: 'assignedRecruiterMembershipId', message: 'Choose someone from your HR Workspace' }]);
    }
  }

  async create(input: CrmCandidateInput) {
    return this.db.tenant(async (tx) => this.createIn(tx, await this.access.actor(tx, 'manage'), input));
  }

  /** Adds a candidate (the form and each imported row). `via` says where it came from, for the history. */
  async createIn(tx: TenantTx, a: CrmActor, input: CrmCandidateInput, via: { importId?: string; fileName?: string } = {}) {
      const owner = this.access.ownerFor(a, input.hrWorkspaceId);
      const probe = { crm_hr_workspace_id: owner, crm_shared_hr_workspace_ids: [] };
      if (touchesSensitive(input) && !this.access.has(a, 'sensitive', probe)) this.access.require(a, 'sensitive', probe);
      await this.checkChoices(tx, a, { stage: input.stage, source: input.source, assignedRecruiterMembershipId: input.assignedRecruiterMembershipId });
      await this.checkDuplicates(tx, a, input, { allowPhone: input.allowPhoneDuplicate });
      const cf = await this.fields.check(tx, owner, input.customFields, { creating: true, flag: 'form' });
      if (cf.problems.length) throw Errors.validation(cf.problems);
      if (input.requisitionId) {
        const r = await loadRequisition(tx, input.requisitionId);
        await this.authz.require('candidates:manage', reqAttrs(r), tx);
      }
      const now = new Date();
      const row = await tx.collection('candidates').insert({
        ...docFields(input),
        source: atsSourceOf(input.source),
        candidate_code: await nextCandidateCode(tx),
        crm_stage: input.stage ?? 'new', crm_stage_entered_at: now,
        crm_hr_workspace_id: owner, crm_shared_hr_workspace_ids: [],
        assigned_recruiter_membership_id: input.assignedRecruiterMembershipId ?? null,
        reference_types: [...new Set(input.references.map((r) => r.type))],
        consent_basis: 'recruiter_confirmed', created_by_membership_id: a.membershipId, updated_by_membership_id: a.membershipId,
      }).catch(uniqueAs('candidate_exists', 'A candidate with this email already exists'));
      const id = row.id as string;
      for (const r of input.references) await tx.collection('candidate_references').insert({ candidate_id: id, ...r, created_by_membership_id: a.membershipId });
      if (input.remark) await this.addRemark(tx, a, row, { body: input.remark, category: 'general', restricted: false });
      await this.fields.write(tx, id, cf.writes);
      await recordActivity(tx, id, via.importId ? 'imported' : 'created', { detail: { code: row.candidate_code, source: input.source ?? null, stage: input.stage ?? 'new', ...(via.importId ? { importId: via.importId, fileName: via.fileName } : {}) }, hrWorkspaceId: owner });
      if (input.assignedRecruiterMembershipId && input.assignedRecruiterMembershipId !== a.membershipId) await this.notifyAssigned(tx, row, input.assignedRecruiterMembershipId);
      await this.audit.record(tx, { action: 'candidate.created', resourceType: 'candidate', resourceId: id, metadata: { via: via.importId ? 'candidate_crm_import' : 'candidate_crm', code: row.candidate_code, hrWorkspaceId: owner, basis: 'recruiter_confirmed', ...(via.importId ? { importId: via.importId } : {}) } });
      if (input.requisitionId) await this.candidates.applyIn(tx, id, input.requisitionId, atsSourceOf(input.source));
      return { id, candidateCode: row.candidate_code as string };
  }

  async update(id: string, patch: CrmCandidatePatch) {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx, 'manage');
      const c = await this.access.candidate(tx, a, id);
      if (c.anonymized_at) throw Errors.conflict('candidate_erased', 'This candidate’s details were erased');
      if (touchesSensitive(patch)) this.access.require(a, 'sensitive', c);
      const { customFields, hrWorkspaceId, ...rest } = patch;
      if (hrWorkspaceId !== undefined && hrWorkspaceId !== (c.crm_hr_workspace_id ?? null)) {
        if (a.level !== 'super') throw Errors.forbidden('Only Super Workspace moves a candidate to another HR Workspace');
      }
      await this.checkChoices(tx, a, { source: rest.source, assignedRecruiterMembershipId: rest.assignedRecruiterMembershipId });
      const email = rest.email !== undefined ? rest.email : c.email;
      const phone = rest.phone !== undefined ? rest.phone : c.phone;
      if (!email && !phone) throw Errors.validation([{ path: 'email', message: 'Keep an email address or a phone number' }]);
      if ((rest.email && rest.email !== c.email) || (rest.phone && phoneKey(rest.phone) !== phoneKey(c.phone))) {
        await this.checkDuplicates(tx, a, { email: rest.email && rest.email !== c.email ? rest.email : null, phone: rest.phone && phoneKey(rest.phone) !== phoneKey(c.phone) ? rest.phone : null }, { exceptId: id });
      }
      const set = docFields(rest, c);
      if (hrWorkspaceId !== undefined) set.crm_hr_workspace_id = hrWorkspaceId;
      const owner = hrWorkspaceId !== undefined ? hrWorkspaceId : (c.crm_hr_workspace_id ?? null);
      let cfChanges: Doc = {};
      if (customFields && Object.keys(customFields).length) {
        const existing = new Map(((await tx.collection('custom_field_values').find({ record_id: id })) as Doc[]).map((v) => [v.field_id as string, v.value]));
        const cf = await this.fields.check(tx, owner, customFields, { existing });
        if (cf.problems.length) throw Errors.validation(cf.problems);
        cfChanges = await this.fields.write(tx, id, cf.writes);
      }
      const changed: Doc = {};
      for (const [k, v] of Object.entries(set)) if (JSON.stringify(v ?? null) !== JSON.stringify(c[k] ?? null)) changed[k] = v;
      if (!Object.keys(changed).length && !Object.keys(cfChanges).length) return { id, changed: [] as string[] };
      changed.updated_by_membership_id = a.membershipId;
      await tx.collection('candidates').updateOne({ id }, { $set: changed }).catch(uniqueAs('candidate_exists', 'Another candidate already uses this email'));
      const fieldsChanged = [...Object.keys(changed).filter((k) => k !== 'updated_by_membership_id'), ...Object.keys(cfChanges).map((k) => `cf:${k}`)];
      await recordActivity(tx, id, 'updated', { detail: { fields: fieldsChanged } });
      if (rest.assignedRecruiterMembershipId && rest.assignedRecruiterMembershipId !== c.assigned_recruiter_membership_id) {
        await recordActivity(tx, id, 'assigned', { detail: { to: rest.assignedRecruiterMembershipId, from: c.assigned_recruiter_membership_id ?? null } });
        if (rest.assignedRecruiterMembershipId !== a.membershipId) await this.notifyAssigned(tx, c, rest.assignedRecruiterMembershipId);
      }
      await this.audit.record(tx, { action: 'candidate.updated', resourceType: 'candidate', resourceId: id, changes: { fields: fieldsChanged }, metadata: { via: 'candidate_crm' } });
      return { id, changed: fieldsChanged };
    });
  }

  async setStage(id: string, stage: string, note?: string) {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx, 'manage');
      const c = await this.access.candidate(tx, a, id);
      return this.stageIn(tx, a, c, stage, note);
    });
  }

  async stageIn(tx: TenantTx, a: CrmActor, c: Doc, stage: string, note?: string) {
    if (c.anonymized_at) throw Errors.conflict('candidate_erased', 'This candidate’s details were erased');
    const stages = stagesOf(await crmSettings(tx));
    const to = stages.find((s) => s.key === stage && s.active);
    if (!to) throw Errors.badRequest('invalid_stage', 'Choose a stage from the pipeline');
    const from = (c.crm_stage as string | null) ?? 'new';
    if (from === stage) return { stage, changed: false };
    await tx.collection('candidates').updateOne({ id: c.id }, { $set: { crm_stage: stage, crm_stage_entered_at: new Date(), updated_by_membership_id: a.membershipId } });
    const activityId = await recordActivity(tx, c.id, 'stage_changed', { automatic: false, detail: { from, to: stage }, remarks: note ?? null });
    if (note) await this.addRemark(tx, a, c, { body: note, category: 'general', restricted: false, activityId });
    if (c.assigned_recruiter_membership_id && c.assigned_recruiter_membership_id !== a.membershipId) {
      await this.notifications.notify(tx, {
        membershipIds: [c.assigned_recruiter_membership_id], kind: 'candidate.updated', title: `${candidateName(c)} moved to ${to.label}`,
        body: `${c.candidate_code ?? ''} · from ${stages.find((s) => s.key === from)?.label ?? from}`.trim(), link: `/recruitment/crm/candidates/${c.id}`,
        resource: { type: 'candidate', id: c.id },
      });
    }
    return { stage, changed: true };
  }

  async assign(id: string, membershipId: string | null) {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx, 'manage');
      const c = await this.access.candidate(tx, a, id);
      return this.assignIn(tx, a, c, membershipId);
    });
  }

  private async assignIn(tx: TenantTx, a: CrmActor, c: Doc, membershipId: string | null) {
    if (c.anonymized_at) throw Errors.conflict('candidate_erased', 'This candidate’s details were erased');
    await this.checkChoices(tx, a, { assignedRecruiterMembershipId: membershipId });
    if ((c.assigned_recruiter_membership_id ?? null) === membershipId) return { changed: false };
    await tx.collection('candidates').updateOne({ id: c.id }, { $set: { assigned_recruiter_membership_id: membershipId, updated_by_membership_id: a.membershipId } });
    const names = await membershipUserNames(tx, [membershipId, c.assigned_recruiter_membership_id]);
    await recordActivity(tx, c.id, 'assigned', { detail: { from: c.assigned_recruiter_membership_id ?? null, to: membershipId, fromName: names.get(c.assigned_recruiter_membership_id) ?? null, toName: membershipId ? names.get(membershipId) ?? null : null } });
    if (membershipId && membershipId !== a.membershipId) await this.notifyAssigned(tx, c, membershipId);
    return { changed: true };
  }

  private async notifyAssigned(tx: TenantTx, c: Doc, membershipId: string) {
    await this.notifications.notify(tx, {
      membershipIds: [membershipId], kind: 'candidate.assigned', title: `${candidateName(c)} was assigned to you`,
      body: [c.candidate_code, c.current_title ?? c.profession, c.current_company].filter(Boolean).join(' · ') || undefined,
      link: `/recruitment/crm/candidates/${c.id}`, resource: { type: 'candidate', id: c.id },
    });
  }

  /** Super Workspace shares a record with other HR Workspaces (they then see and work on it too). */
  async share(id: string, hrWorkspaceIds: string[]) {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx, 'manage');
      if (a.level !== 'super') throw Errors.forbidden('Only Super Workspace shares candidates between HR Workspaces');
      const c = await this.access.candidate(tx, a, id);
      const known = new Set(await tx.collection('hr_workspaces').distinct<string>('id', { id: { $in: hrWorkspaceIds }, status: { $ne: 'archived' } }));
      if (known.size !== hrWorkspaceIds.length) throw Errors.badRequest('unknown_hr_workspace', 'One of these HR Workspaces no longer exists');
      const ids = hrWorkspaceIds.filter((w) => w !== c.crm_hr_workspace_id);
      await tx.collection('candidates').updateOne({ id }, { $set: { crm_shared_hr_workspace_ids: ids, updated_by_membership_id: a.membershipId } });
      await recordActivity(tx, id, 'shared', { detail: { hrWorkspaceIds: ids, before: c.crm_shared_hr_workspace_ids ?? [] } });
      await this.audit.record(tx, { action: 'candidate_crm.shared', resourceType: 'candidate', resourceId: id, changes: { from: c.crm_shared_hr_workspace_ids ?? [], to: ids } });
      return { sharedWith: ids };
    });
  }

  async archive(id: string, archived: boolean) {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx, 'manage');
      const c = await this.access.candidate(tx, a, id);
      return this.archiveIn(tx, a, c, archived);
    });
  }

  private async archiveIn(tx: TenantTx, a: CrmActor, c: Doc, archived: boolean) {
    this.access.require(a, 'archive', c);
    if (!!c.crm_archived_at === archived) return { archived };
    await tx.collection('candidates').updateOne({ id: c.id }, { $set: { crm_archived_at: archived ? new Date() : null, updated_by_membership_id: a.membershipId } });
    if (archived) {
      await tx.collection('candidate_follow_ups').update({ candidate_id: c.id, status: { $in: ['pending', 'rescheduled'] } }, { $set: { status: 'cancelled', outcome: 'Candidate archived' } });
      await refreshNextFollowUp(tx, c.id);
    }
    await recordActivity(tx, c.id, archived ? 'archived' : 'restored');
    await this.audit.record(tx, { action: archived ? 'candidate_crm.archived' : 'candidate_crm.restored', resourceType: 'candidate', resourceId: c.id });
    return { archived };
  }

  /** Erases the candidate's personal data (on their request). Needs the archive and delete power. Cannot be undone. */
  async erase(id: string, reason: string) {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx, 'manage');
      const c = await this.access.candidate(tx, a, id);
      this.access.require(a, 'archive', c);
      if (c.anonymized_at) return { erased: false };
      await this.candidates.anonymize(tx, id, 'request');
      await this.audit.record(tx, { action: 'candidate.erased', resourceType: 'candidate', resourceId: id, metadata: { reason, via: 'candidate_crm' } });
      return { erased: true };
    });
  }

  /** One action on up to 200 candidates. Each is checked on its own; the result lists any skipped and why. */
  async bulk(input: CrmBulkInput) {
    const results: { id: string; ok: boolean; message?: string }[] = [];
    await this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx, 'manage');
      for (const id of [...new Set(input.ids)]) {
        try {
          const c = await this.access.candidate(tx, a, id);
          if (c.anonymized_at) throw Errors.conflict('candidate_erased', 'Details were erased');
          if (input.action === 'stage') await this.stageIn(tx, a, c, input.stage);
          else if (input.action === 'assign') await this.assignIn(tx, a, c, input.membershipId);
          else if (input.action === 'archive') await this.archiveIn(tx, a, c, true);
          else if (!((c.tags ?? []) as string[]).includes(input.tag)) {
            await tx.collection('candidates').updateOne({ id }, { $set: { tags: [...((c.tags ?? []) as string[]), input.tag].slice(0, 20), updated_by_membership_id: a.membershipId } });
            await recordActivity(tx, id, 'updated', { detail: { fields: ['tags'], tag: input.tag } });
          }
          results.push({ id, ok: true });
        } catch (e) {
          if (!(e instanceof AppError) || e.getStatus() >= 500) throw e;
          results.push({ id, ok: false, message: (e.getResponse() as { message: string }).message });
        }
      }
      const done = results.filter((r) => r.ok).length;
      await this.audit.record(tx, { action: `candidate_crm.bulk_${input.action}`, resourceType: 'candidate', resourceId: null, changes: { done, skipped: results.length - done } });
    });
    const done = results.filter((r) => r.ok).length;
    return { done, skipped: results.length - done, results };
  }

  // ------------------------------------------------------------------------------------------------------------
  // Remarks (shared with the work service)
  // ------------------------------------------------------------------------------------------------------------

  async addRemark(tx: TenantTx, a: CrmActor, c: Doc, n: { body: string; category: string; restricted: boolean; activityId?: string }) {
    if (n.restricted) this.access.require(a, 'sensitive', c);
    const key = this.access.keysFor(a, c).find((k) => k !== CRM_CENTRAL) ?? null;
    const row = await tx.collection('candidate_notes').insert({
      candidate_id: c.id, body: n.body, category: n.category, restricted: n.restricted, activity_id: n.activityId ?? null,
      author_membership_id: a.membershipId, author_level: a.level, author_hr_workspace_id: a.level === 'hr' ? key : null,
    });
    return row;
  }

  // ------------------------------------------------------------------------------------------------------------
  // Photo
  // ------------------------------------------------------------------------------------------------------------

  async setPhoto(id: string, file: UploadedFile | undefined) {
    if (!file?.buffer?.length) throw Errors.badRequest('file_required', 'Choose a photo');
    if (!(CRM_PHOTO_TYPES as readonly string[]).includes(file.mimetype)) throw Errors.badRequest('unsupported_type', 'Use a JPEG, PNG or WebP photo');
    if (file.size > CRM_PHOTO_MAX_BYTES) throw Errors.badRequest('file_too_large', 'The photo can be up to 3 MB');
    if (!sniffMatches(file.mimetype, file.buffer.subarray(0, 512))) throw Errors.badRequest('content_mismatch', 'The file content does not match its type');
    const tenantId = requestContext.tenantActor().tenantId;
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx, 'manage');
      const c = await this.access.candidate(tx, a, id);
      if (c.anonymized_at) throw Errors.conflict('candidate_erased', 'This candidate’s details were erased');
      const key = this.storage.newKey(tenantId);
      await this.storage.put(key, file.buffer, { upload: true });
      await tx.collection('candidates').updateOne({ id }, { $set: { photo_storage_key: key, personal: { ...(c.personal ?? {}), photoType: file.mimetype }, updated_by_membership_id: a.membershipId } });
      if (c.photo_storage_key) await this.storage.remove(c.photo_storage_key);
      await recordActivity(tx, id, 'updated', { detail: { fields: ['photo'] } });
      return { ok: true };
    });
  }

  async removePhoto(id: string) {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx, 'manage');
      const c = await this.access.candidate(tx, a, id);
      if (!c.photo_storage_key) return { ok: true };
      await tx.collection('candidates').updateOne({ id }, { $set: { photo_storage_key: null } });
      await this.storage.remove(c.photo_storage_key);
      await recordActivity(tx, id, 'updated', { detail: { fields: ['photo'], removed: true } });
      return { ok: true };
    });
  }

  async openPhoto(id: string) {
    const c = await this.db.tenant(async (tx) => this.access.candidate(tx, await this.access.actor(tx), id));
    if (!c.photo_storage_key) throw Errors.notFound('Photo');
    return { ...(await this.storage.open(c.photo_storage_key)), contentType: (c.personal?.photoType as string | undefined) ?? 'image/jpeg' };
  }

  // ------------------------------------------------------------------------------------------------------------
  // Export
  // ------------------------------------------------------------------------------------------------------------

  /** The columns the person may export, with custom fields marked for export. */
  async exportColumns() {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx);
      this.access.require(a, 'export');
      const sensitive = this.access.has(a, 'sensitive');
      const defs = await this.fields.definitionsForActor(tx, a, 'export');
      return {
        columns: [
          ...CRM_EXPORT_COLUMNS.filter((c) => sensitive || !c.sensitive).map((c) => ({ key: c.key, label: c.label, group: 'Candidate' })),
          ...defs.map((d) => ({ key: `cf:${d.key}`, label: d.label as string, group: 'Custom fields' })),
        ],
        history: await this.exportHistoryIn(tx, a),
      };
    });
  }

  private async exportHistoryIn(tx: TenantTx, a: CrmActor) {
    const filter = a.level === 'super' ? {} : { $or: [{ created_by_membership_id: a.membershipId }, { hr_workspace_ids: { $in: a.keys } }] };
    const rows = await tx.collection('candidate_exports').find(filter, { sort: { created_at: -1 }, limit: 30 });
    const names = await membershipUserNames(tx, rows.map((r) => r.created_by_membership_id));
    return rows.map((r) => ({ id: r.id, scope: r.scope, format: r.format, rows: r.rows, columns: (r.columns as string[]).length, createdAt: r.created_at, by: names.get(r.created_by_membership_id) ?? null }));
  }

  async export(input: CrmExportInput) {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx);
      this.access.require(a, 'export');
      const sensitive = this.access.has(a, 'sensitive');
      const defs = new Map((await this.fields.definitionsForActor(tx, a, 'export')).map((d) => [`cf:${d.key}`, d]));
      const known = new Map(CRM_EXPORT_COLUMNS.map((c) => [c.key, c]));
      for (const col of input.columns) {
        const k = known.get(col);
        if (!k && !defs.has(col)) throw Errors.validation([{ path: 'columns', message: `Unknown column ${col}` }]);
        if (k?.sensitive && !sensitive) throw Errors.forbiddenCode('crm_cap_missing', 'Your HR Workspace cannot export personal details such as gender and date of birth.');
      }
      const q = input.scope === 'all' ? {} : input.scope === 'selected' ? { ids: input.ids.join(',') } : input.filters;
      if (input.scope === 'selected' && !input.ids.length) throw Errors.badRequest('nothing_selected', 'Select the candidates to export');
      const parsed = crmListQuery.parse({ ...q, limit: 1, offset: 0 });
      if (input.scope === 'selected') parsed.ids = input.ids;
      const filter = await this.filterFor(tx, a, parsed);
      const docs = await tx.collection('candidates').find(filter, { sort: { created_at: 1, _id: 1 }, limit: 20_001 });
      if (docs.length > 20_000) throw Errors.badRequest('export_too_large', 'More than 20,000 candidates match. Narrow the filters and export again.');
      const views = new Map((await this.rowViews(tx, a, docs)).map((r) => [r.id, r]));
      const ids = docs.map((d) => d.id as string);
      const cfVals = await this.fields.values(tx, ids, [...defs.values()]);
      const jobs = new Map<string, string[]>();
      const apps = await tx.collection('applications').find({ candidate_id: { $in: ids } }, { projection: { candidate_id: 1, requisition_id: 1, status: 1 } });
      const reqs = new Map((await tx.collection('job_requisitions').find({ id: { $in: apps.map((x) => x.requisition_id) } }, { projection: { code: 1, title: 1 } })).map((r) => [r.id as string, r]));
      for (const x of apps) jobs.set(x.candidate_id, [...(jobs.get(x.candidate_id) ?? []), `${reqs.get(x.requisition_id)?.code ?? ''} ${reqs.get(x.requisition_id)?.title ?? ''} (${x.status})`.trim()]);
      const creators = await membershipUserNames(tx, docs.map((d) => d.created_by_membership_id));
      const date = (v: unknown) => (v ? new Date(v as string).toISOString().slice(0, 10) : '');
      const cell = (c: Doc, col: string): Cell => {
        const v = views.get(c.id)!;
        const per = (c.personal ?? {}) as Doc;
        if (col.startsWith('cf:')) return cfVals.get(c.id)?.[col.slice(3)]?.text ?? '';
        switch (col) {
          case 'candidateCode': return c.candidate_code; case 'name': return v.name; case 'email': return c.email; case 'phone': return c.phone;
          case 'alternatePhone': return per.alternatePhone; case 'whatsapp': return per.whatsapp; case 'gender': return per.gender; case 'dateOfBirth': return per.dateOfBirth;
          case 'nationality': return per.nationality; case 'city': return c.city; case 'state': return c.state; case 'country': return c.country_code; case 'currentLocation': return c.location_text;
          case 'profession': return c.profession; case 'currentTitle': return c.current_title; case 'currentCompany': return c.current_company; case 'industry': return c.industry;
          case 'department': return c.department_name; case 'jobRole': return c.job_role; case 'experience': return v.experience; case 'relevantExperience': return experienceText(c.relevant_experience_months);
          case 'skills': return ['primarySkills', 'secondarySkills', 'technicalSkills', 'softSkills'].flatMap((k) => (c.professional?.[k] ?? []) as string[]).join(', ');
          case 'qualification': return c.professional?.highestQualification; case 'currency': return c.comp_currency ?? 'INR';
          case 'currentCtc': return c.current_ctc === null || c.current_ctc === undefined ? '' : Number(c.current_ctc);
          case 'expectedCtc': return c.expected_ctc === null || c.expected_ctc === undefined ? '' : Number(c.expected_ctc);
          case 'notice': return v.notice; case 'availableFrom': return c.notice?.availableFrom ?? ''; case 'linkedin': return c.links?.linkedin; case 'portfolio': return c.links?.portfolio;
          case 'source': return v.sourceLabel; case 'reference': return v.reference; case 'stage': return v.stageLabel; case 'recruiter': return v.recruiter; case 'hrWorkspace': return v.hrWorkspace;
          case 'nextFollowUp': return date(c.next_follow_up_at); case 'lastActivity': return date(c.last_activity_at); case 'tags': return ((c.tags ?? []) as string[]).join(', ');
          case 'jobs': return (jobs.get(c.id) ?? []).join('; '); case 'createdAt': return date(c.created_at); case 'createdBy': return creators.get(c.created_by_membership_id) ?? '';
          case 'updatedAt': return date(c.updated_at); default: return '';
        }
      };
      const header = input.columns.map((col) => known.get(col)?.label ?? defs.get(col)?.label ?? col);
      const body = docs.map((c) => input.columns.map((col) => cell(c, col)));
      await tx.collection('candidate_exports').insert({
        scope: input.scope, filters: input.scope === 'filtered' ? input.filters : input.scope === 'selected' ? { ids: input.ids.length } : {}, columns: input.columns, format: input.format,
        rows: docs.length, hr_workspace_ids: a.level === 'super' ? [] : a.keys, created_by_membership_id: a.membershipId,
      });
      await this.audit.record(tx, { action: 'candidate_crm.exported', resourceType: 'candidate', resourceId: null, changes: { scope: input.scope, rows: docs.length, columns: input.columns, format: input.format } });
      const stamp = new Date().toISOString().slice(0, 10);
      if (input.format === 'xlsx') return { fileName: `candidates-${stamp}.xlsx`, content: toXlsx('Candidates', [header, ...body]) };
      const esc = (v: Cell) => {
        let t = v === null || v === undefined ? '' : String(v);
        if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
        return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
      };
      return { fileName: `candidates-${stamp}.csv`, content: `﻿${[header, ...body].map((r) => r.map(esc).join(',')).join('\r\n')}\r\n` };
    });
  }

  // ------------------------------------------------------------------------------------------------------------
  // Settings (Super Workspace)
  // ------------------------------------------------------------------------------------------------------------

  async settings() {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx);
      const s = await crmSettings(tx);
      const inUse = new Map((await tx.collection('candidates').aggregate<{ id: string; n: number }>([{ $match: { anonymized_at: null } }, { $group: { _id: '$crm_stage', n: { $sum: 1 } } }])).map((x) => [x.id ?? 'new', x.n]));
      return {
        stages: stagesOf(s).map((st) => ({ ...st, candidates: inUse.get(st.key) ?? 0 })),
        sources: sourcesOf(s),
        retentionDays: (s.retention_days as number | null) ?? null,
        matchFields: (s.match_fields as string[]) ?? ['email', 'phone', 'candidate_code'],
        canEdit: a.level === 'super',
      };
    });
  }

  async saveSettings(input: CrmSettingsInput) {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx, 'manage');
      if (a.level !== 'super') throw Errors.forbidden('Only Super Workspace changes Candidate CRM settings');
      const before = await crmSettings(tx);
      const set: Doc = {};
      if (input.stages) {
        const keys = input.stages.map((s) => s.key);
        if (new Set(keys).size !== keys.length) throw Errors.validation([{ path: 'stages', message: 'Two stages have the same key' }]);
        const prev = stagesOf(before);
        for (const p of prev) {
          if (keys.includes(p.key)) continue;
          if (p.system) throw Errors.validation([{ path: 'stages', message: `${p.label} is a built-in stage. Switch it off instead of removing it.` }]);
          const n = await tx.collection('candidates').count({ crm_stage: p.key, anonymized_at: null });
          if (n) throw Errors.validation([{ path: 'stages', message: `${n} candidate${n === 1 ? ' is' : 's are'} in ${p.label}. Move them first, or switch the stage off.` }]);
        }
        const first = input.stages.find((s) => s.key === 'new');
        if (!first?.active) throw Errors.validation([{ path: 'stages', message: 'New Candidate must stay switched on: new records start there.' }]);
        const builtIn = new Map(DEFAULT_CRM_STAGES.map((s) => [s.key, s]));
        set.stages = input.stages.map((s, i) => ({ ...s, position: i, system: builtIn.has(s.key), kind: builtIn.get(s.key)?.kind ?? s.kind }));
      }
      if (input.sources) {
        const keys = input.sources.map((s) => s.key);
        if (new Set(keys).size !== keys.length) throw Errors.validation([{ path: 'sources', message: 'Two sources have the same key' }]);
        set.sources = input.sources;
      }
      if (input.retentionDays !== undefined) set.retention_days = input.retentionDays;
      if (input.matchFields) set.match_fields = [...new Set(input.matchFields)];
      if (!Object.keys(set).length) return { saved: false };
      set.updated_by_membership_id = a.membershipId;
      await tx.collection('candidate_crm_settings').updateOne({ id: before.id }, { $set: set });
      await this.audit.record(tx, { action: 'candidate_crm.settings_changed', resourceType: 'candidate_crm_settings', resourceId: before.id, changes: { fields: Object.keys(set).filter((k) => k !== 'updated_by_membership_id') } });
      return { saved: true };
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------

function fileView(f: Doc, name: (m: string | null | undefined) => string | null) {
  return {
    id: f.id as string, kind: f.kind as string, name: (f.name as string | null) ?? f.file_name, fileName: f.file_name as string, contentType: f.content_type as string, sizeBytes: f.size_bytes as number,
    version: (f.version as number) ?? 1, notes: f.notes ?? null, uploadedAt: f.created_at, uploadedBy: name(f.uploaded_by_membership_id),
    previewable: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/plain'].includes(f.content_type), supersededAt: f.superseded_at ?? null,
  };
}

/** Earlier versions of a document: the chain of files it replaced. */
function versionsOf(f: Doc, all: Doc[]) {
  const out: Doc[] = [];
  let prev = f.replaces_file_id ? all.find((x) => x.id === f.replaces_file_id) : undefined;
  while (prev && out.length < 50) {
    out.push(prev);
    prev = prev.replaces_file_id ? all.find((x) => x.id === prev!.replaces_file_id) : undefined;
  }
  return out;
}

export function followUpView(f: Doc, name: (m: string | null | undefined) => string | null, now = new Date()) {
  const open = ['pending', 'rescheduled'].includes(f.status);
  return {
    id: f.id as string, candidateId: f.candidate_id as string, type: f.type as string, typeLabel: crmLabel(FOLLOW_UP_TYPES, f.type), dueAt: f.due_at, status: f.status as string,
    priority: f.priority as string, reason: f.reason ?? null, notes: f.notes ?? null, outcome: f.outcome ?? null, reminderMinutes: f.reminder_minutes ?? null,
    assignedMembershipId: f.assigned_membership_id ?? null, assignedTo: name(f.assigned_membership_id), createdBy: name(f.created_by_membership_id), createdAt: f.created_at,
    completedAt: f.completed_at ?? null, completedBy: name(f.completed_by_membership_id), overdue: open && new Date(f.due_at) < now,
  };
}

/** One line describing what an activity recorded, for the timeline. */
export function describeDetail(x: Doc, stageLabel: Map<string, string>): string {
  const d = (x.detail ?? {}) as Doc;
  const st = (k: string | null | undefined) => (k ? stageLabel.get(k) ?? k : 'none');
  switch (x.kind) {
    case 'created': return `Candidate record created${d.code ? ` as ${d.code}` : ''}`;
    case 'updated': return d.fields?.includes?.('photo') ? (d.removed ? 'Photo removed' : 'Photo updated') : `Profile updated${d.fields?.length ? ` (${(d.fields as string[]).length} field${d.fields.length === 1 ? '' : 's'})` : ''}`;
    case 'stage_changed': return `Moved from ${st(d.from)} to ${st(d.to)}${d.via === 'ats' ? ` (from the job${d.job ? ` ${d.job}` : ''})` : ''}`;
    case 'assigned': return d.toName ? `Assigned to ${d.toName}` : d.to ? 'Assigned to a recruiter' : 'Recruiter removed';
    case 'note_added': return 'Recruiter remark added';
    case 'reference_added': return `Reference added${d.name ? `: ${d.name}` : ''}`;
    case 'document_uploaded': return `Document uploaded: ${d.name ?? 'file'}`;
    case 'document_replaced': return `New version of ${d.name ?? 'a document'} (v${d.version ?? 2})`;
    case 'document_deleted': return `Document deleted: ${d.name ?? 'file'}`;
    case 'follow_up_scheduled': return `Follow-up scheduled: ${d.type ? crmLabel(FOLLOW_UP_TYPES, d.type) : 'follow-up'}`;
    case 'follow_up_completed': return `Follow-up completed: ${d.type ? crmLabel(FOLLOW_UP_TYPES, d.type) : 'follow-up'}`;
    case 'follow_up_changed': return `Follow-up ${d.status ?? 'changed'}`;
    case 'imported': return `Imported from ${d.fileName ?? 'a file'}${d.updated ? ' (updated)' : ''}`;
    case 'applied': return `Added to job ${d.job ?? ''}`.trim();
    case 'ats_event': return `${String(d.atsKind ?? 'update').replace(/_/g, ' ').replace(/^./, (m) => m.toUpperCase())}${d.job ? ` · ${d.job}` : ''}`;
    case 'shared': return `Shared with ${(d.hrWorkspaceIds as string[] | undefined)?.length ?? 0} HR Workspace${(d.hrWorkspaceIds as string[] | undefined)?.length === 1 ? '' : 's'}`;
    case 'archived': return 'Archived';
    case 'restored': return 'Restored from the archive';
    default: return x.subject ?? '';
  }
}
