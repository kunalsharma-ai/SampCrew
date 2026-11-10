import { Injectable } from '@nestjs/common';
import type { CareerSiteInput, PublicApplyInput, stageInput } from '@crew/contracts';
import type { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { countBy, MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { EntitlementsService } from '../../platform/entitlements/entitlements.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import type { UploadedFile } from '../documents/documents.service';
import { uniqueAs } from '../employees/employees.service';
import { CandidatesService } from './candidates.service';
import { CANDIDATE_FOOTER, recordEvent } from './recruitment-common';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

/** Postings that are live: published, not taken down, for an open requisition. Returns postings with their requisition. */
async function livePostings(tx: TenantTx, filter: Doc = {}) {
  const postings = await tx.collection('job_postings').find({ ...filter, published_at: { $ne: null }, unpublished_at: null }, { sort: { published_at: -1 } });
  if (!postings.length) return [];
  const reqs = new Map((await tx.collection('job_requisitions').find({ id: { $in: postings.map((p) => p.requisition_id) }, status: 'open' })).map((r) => [r.id as string, r]));
  return postings.filter((p) => reqs.has(p.requisition_id)).map((p) => ({ p, r: reqs.get(p.requisition_id)! }));
}

/** A posting as the public career site shows it (salary only when the posting chooses to show it). */
async function publicJobs(tx: TenantTx, live: Array<{ p: Doc; r: Doc }>) {
  const depts = new Map((await tx.collection('departments').find({ id: { $in: [...new Set(live.map((x) => x.r.department_id))] } }, { projection: { name: 1 } })).map((d) => [d.id as string, d.name as string]));
  return live.map(({ p, r }) => ({
    slug: p.slug, title: p.public_title, summary: p.summary ?? null, locationText: p.location_text ?? null, workMode: r.work_mode, employmentType: r.employment_type,
    department: depts.get(r.department_id) ?? null, postedAt: p.published_at,
    salaryMin: p.show_salary ? (r.salary_min ?? null) : null, salaryMax: p.show_salary ? (r.salary_max ?? null) : null, currency: p.show_salary ? r.currency : null,
  }));
}

const siteView = (s: Doc) => ({
  enabled: s.enabled, slug: s.slug, headline: s.headline, intro: s.intro, privacyNotice: s.privacy_notice, privacyNoticeVersion: s.privacy_notice_version, retentionDays: s.retention_days,
});

/** Pipeline stages, the career site's settings, and the public career site itself. */
@Injectable()
export class CareersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly entitlements: EntitlementsService,
    private readonly candidates: CandidatesService,
  ) {}

  // Stages ------------------------------------------------------------------------------------------------

  async stages() {
    return this.db.tenant(async (tx) => {
      await this.authz.require('candidates:read', undefined, tx).catch(async () => this.authz.require('recruitment:configure', undefined, tx));
      const stages = await tx.collection('recruitment_stages').find({ archived_at: null }, { sort: { position: 1 } });
      const active = await countBy(tx, 'applications', 'stage_id', stages.map((s) => s.id), { status: 'active' });
      return stages.map((s) => ({ id: s.id, name: s.name, kind: s.kind, position: s.position, activeApplications: active.get(s.id) ?? 0 }));
    });
  }

  async addStage(input: z.infer<typeof stageInput>) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('recruitment:configure', undefined, tx);
      if (input.kind === 'new' || input.kind === 'hired') throw Errors.badRequest('fixed_stage', 'There is always exactly one Applied and one Hired stage. Add screening, interview or offer stages.');
      // New stages go just before Hired.
      const stages = tx.collection('recruitment_stages');
      const hired = await stages.findOne({ kind: 'hired', archived_at: null }, { projection: { position: 1 } });
      const pos = (hired?.position as number | undefined) ?? 100;
      await stages.update({ archived_at: null, position: { $gte: pos } }, { $inc: { position: 1 } });
      const row = await stages.insert({ name: input.name, kind: input.kind, position: pos }).catch(uniqueAs('stage_exists', 'A stage with this name already exists'));
      await this.audit.record(tx, { action: 'recruitment_stage.created', resourceType: 'recruitment_stage', resourceId: row.id, changes: input });
      return { id: row.id as string };
    });
  }

  async renameStage(id: string, name: string) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('recruitment:configure', undefined, tx);
      const n = await tx.collection('recruitment_stages').updateOne({ id, archived_at: null }, { $set: { name } }).catch(uniqueAs('stage_exists', 'A stage with this name already exists'));
      if (!n) throw Errors.notFound('Stage');
      await this.audit.record(tx, { action: 'recruitment_stage.renamed', resourceType: 'recruitment_stage', resourceId: id, changes: { name } });
      return { id };
    });
  }

  async reorderStages(ids: string[]) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('recruitment:configure', undefined, tx);
      const stages = tx.collection('recruitment_stages');
      const live = await stages.find({ archived_at: null }, { projection: { kind: 1 } });
      if (live.length !== ids.length || live.some((s) => !ids.includes(s.id))) throw Errors.badRequest('stage_list_mismatch', 'Send every current stage exactly once');
      const kindOf = new Map(live.map((s) => [s.id as string, s.kind as string]));
      if (kindOf.get(ids[0]!) !== 'new' || kindOf.get(ids.at(-1)!) !== 'hired') throw Errors.badRequest('stage_order', 'Applied must stay first and Hired last');
      for (const [i, id] of ids.entries()) await stages.updateOne({ id }, { $set: { position: i + 1 } });
      await this.audit.record(tx, { action: 'recruitment_stage.reordered', resourceType: 'recruitment_stage', metadata: { order: ids } });
      return { ok: true };
    });
  }

  async archiveStage(id: string) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('recruitment:configure', undefined, tx);
      const stages = tx.collection('recruitment_stages');
      const s = await stages.findOne({ id, archived_at: null }, { projection: { kind: 1 } });
      if (!s) throw Errors.notFound('Stage');
      if (s.kind === 'new' || s.kind === 'hired') throw Errors.badRequest('fixed_stage', 'The Applied and Hired stages cannot be removed');
      const n = await tx.collection('applications').count({ stage_id: id, status: 'active' });
      if (n) throw Errors.conflict('stage_in_use', `${n} candidate(s) are in this stage. Move them first.`);
      await stages.updateOne({ id }, { $set: { archived_at: new Date() } });
      await this.audit.record(tx, { action: 'recruitment_stage.archived', resourceType: 'recruitment_stage', resourceId: id });
    });
  }

  // Career site settings ----------------------------------------------------------------------------------

  async site() {
    return this.db.tenant(async (tx) => {
      await this.authz.require('recruitment:configure', undefined, tx);
      const s = await tx.collection('career_sites').findOne({});
      if (s) return { configured: true, ...siteView(s), updatedAt: s.updated_at };
      const t = (await tx.collection('tenants').findOne({}, { projection: { slug: 1, name: 1 } }))!;
      return { configured: false, enabled: false, slug: t.slug, headline: `Careers at ${String(t.name).replace(/\s*\(Demo\)$/, '')}`, intro: '', privacyNotice: '', privacyNoticeVersion: 0, retentionDays: 365 };
    });
  }

  async saveSite(input: CareerSiteInput) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('recruitment:configure', undefined, tx);
      const sites = tx.collection('career_sites');
      const before = await sites.findOne({});
      const fields = { enabled: input.enabled, slug: input.slug, headline: input.headline, intro: input.intro, privacy_notice: input.privacyNotice, retention_days: input.retentionDays };
      const save = before
        ? sites.updateOne({ id: before.id }, { $set: fields, ...(before.privacy_notice !== input.privacyNotice ? { $inc: { privacy_notice_version: 1 } } : {}) })
        : sites.insert(fields);
      await (save as Promise<unknown>).catch(uniqueAs('slug_taken', 'Another organisation already uses this career site address'));
      await this.audit.record(tx, {
        action: 'career_site.saved', resourceType: 'career_site',
        changes: { enabled: input.enabled, slug: input.slug, headline: input.headline, retentionDays: input.retentionDays, privacyNoticeChanged: before ? before.privacy_notice !== input.privacyNotice : true },
      });
      return siteView((await sites.findOne({}))!);
    });
  }

  // Public ------------------------------------------------------------------------------------------------

  /** Resolves a public career site to its workspace, or 404 when it is off, unknown, or the plan has no recruitment. */
  private async resolve(slug: string) {
    const t = await this.db.platform(async (tx) => {
      const cs = await tx.collection('career_sites').findOne({ slug, enabled: true }, { projection: { tenant_id: 1 } });
      if (!cs) return undefined;
      const tenant = await tx.collection('tenants').findOne({ id: cs.tenant_id, status: 'active' }, { projection: { name: 1 } });
      return tenant ? { tenant_id: cs.tenant_id as string, name: tenant.name as string } : undefined;
    });
    if (!t) throw Errors.notFound('Career site');
    return { tenantId: t.tenant_id, name: t.name.replace(/\s*\(Demo\)$/, '') };
  }

  private async withSite<T>(slug: string, fn: (tx: TenantTx, site: { tenantId: string; name: string }) => Promise<T>) {
    const site = await this.resolve(slug);
    return this.db.tenant(async (tx) => {
      const e = await this.entitlements.current(tx);
      if (!e.features.has('recruitment')) throw Errors.notFound('Career site');
      return fn(tx, site);
    }, { tenantId: site.tenantId });
  }

  async publicSite(slug: string) {
    return this.withSite(slug, async (tx, site) => {
      const s = (await tx.collection('career_sites').findOne({}))!;
      const jobs = await publicJobs(tx, await livePostings(tx));
      return { organisation: site.name, headline: s.headline, intro: s.intro, jobs };
    });
  }

  async publicJob(slug: string, jobSlug: string) {
    return this.withSite(slug, async (tx, site) => {
      const live = await livePostings(tx, { slug: jobSlug });
      if (!live.length) throw Errors.notFound('Job');
      const [job] = await publicJobs(tx, live);
      const s = (await tx.collection('career_sites').findOne({}))!;
      return { organisation: site.name, job: { ...job, description: live[0]!.p.description ?? null }, privacyNotice: s.privacy_notice };
    });
  }

  /**
   * A public application. The response is the same whether the person is new, already a candidate, or has already
   * applied for this job, so the form cannot be used to find out who has applied.
   */
  async apply(slug: string, jobSlug: string, input: PublicApplyInput, file: UploadedFile | undefined) {
    if (input.website) return { received: true }; // honeypot: a bot filled the hidden field
    CandidatesService.checkResume(file);
    return this.withSite(slug, async (tx, site) => {
      const [live] = await livePostings(tx, { slug: jobSlug });
      if (!live) throw Errors.notFound('Job');
      const job = { requisition_id: live.r.id as string, title: live.p.public_title as string, hiring_manager_membership_id: live.r.hiring_manager_membership_id as string, created_by_membership_id: (live.r.created_by_membership_id as string | null) ?? null };
      const notice = (await tx.collection('career_sites').findOne({}))!.privacy_notice_version as number;
      const candidates = tx.collection('candidates');
      const existing = await candidates.findOne({ email: input.email, anonymized_at: null }, { projection: { _id: 1 } });
      let candidateId: string;
      if (existing) {
        candidateId = existing.id;
        await candidates.updateOne({ id: candidateId }, { $set: { consent_basis: 'candidate_consent', consent_at: new Date(), privacy_notice_version: notice, last_activity_at: new Date() } });
      } else {
        candidateId = (await candidates.insert({
          first_name: input.firstName, last_name: input.lastName, email: input.email, phone: input.phone ?? null, location_text: input.locationText ?? null,
          profile_url: input.profileUrl ?? null, source: 'career_site', consent_basis: 'candidate_consent', privacy_notice_version: notice,
        })).id;
      }
      if (await tx.collection('applications').exists({ candidate_id: candidateId, requisition_id: job.requisition_id })) return { received: true };
      await this.candidates.storeResume(tx, site.tenantId, candidateId, file!, null);
      const { applicationId } = await this.candidates.applyIn(tx, candidateId, job.requisition_id, 'career_site', input.coverNote ?? null);
      await this.notifications.queueEmail(
        tx, site.tenantId, input.email, `We received your application: ${job.title}`,
        `Dear ${`${input.firstName} ${input.lastName}`.trim()},\n\nThank you for applying for ${job.title} at ${site.name}. We have your application and CV, and the team will be in touch.\n\n${site.name}`,
        'candidate.received', CANDIDATE_FOOTER,
      );
      await recordEvent(tx, applicationId, 'email_queued', { detail: { template: 'candidate.received' } });
      await this.notifications.notify(tx, {
        membershipIds: [job.hiring_manager_membership_id, job.created_by_membership_id], kind: 'application.received',
        title: `New application for ${job.title}`, link: `/recruitment/jobs/${job.requisition_id}`,
      });
      await this.audit.record(tx, { action: 'application.received', resourceType: 'application', resourceId: applicationId, metadata: { source: 'career_site', privacyNoticeVersion: notice }, tenantId: site.tenantId });
      return { received: true };
    });
  }
}
