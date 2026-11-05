import { Injectable } from '@nestjs/common';
import type { CareerSiteInput, PublicApplyInput, stageInput } from '@crew/contracts';
import type { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { EntitlementsService } from '../../platform/entitlements/entitlements.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import type { UploadedFile } from '../documents/documents.service';
import { uniqueAs } from '../employees/employees.service';
import { CandidatesService } from './candidates.service';
import { CANDIDATE_FOOTER, recordEvent } from './recruitment-common';

const PUBLIC_JOB_COLUMNS = `p.slug, p.public_title as title, p.summary, p.location_text as "locationText", r.work_mode as "workMode", r.employment_type as "employmentType",
  d.name as department, p.published_at as "postedAt",
  case when p.show_salary then r.salary_min::text end as "salaryMin", case when p.show_salary then r.salary_max::text end as "salaryMax",
  case when p.show_salary then r.currency end as currency`;
const LIVE = `p.published_at is not null and p.unpublished_at is null and r.status = 'open'`;

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
      return many(tx, `select s.id, s.name, s.kind, s.position, (select count(*)::int from applications a where a.stage_id = s.id and a.status = 'active') as "activeApplications"
                         from recruitment_stages s where s.archived_at is null order by s.position`);
    });
  }

  async addStage(input: z.infer<typeof stageInput>) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('recruitment:configure', undefined, tx);
      if (input.kind === 'new' || input.kind === 'hired') throw Errors.badRequest('fixed_stage', 'There is always exactly one Applied and one Hired stage. Add screening, interview or offer stages.');
      // New stages go just before Hired.
      const hired = await one<{ position: number }>(tx, `select position from recruitment_stages where kind = 'hired' and archived_at is null`);
      const pos = hired?.position ?? 100;
      await tx.query(`update recruitment_stages set position = position + 1 where archived_at is null and position >= $1`, [pos]);
      const row = await one<{ id: string }>(tx, `insert into recruitment_stages (tenant_id, name, kind, position) values (app_tenant_id(), $1, $2, $3) returning id`, [input.name, input.kind, pos])
        .catch(uniqueAs('stage_exists', 'A stage with this name already exists'));
      await this.audit.record(tx, { action: 'recruitment_stage.created', resourceType: 'recruitment_stage', resourceId: row!.id, changes: input });
      return row;
    });
  }

  async renameStage(id: string, name: string) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('recruitment:configure', undefined, tx);
      const r = await one(tx, `update recruitment_stages set name = $2 where id = $1 and archived_at is null returning id`, [id, name]).catch(uniqueAs('stage_exists', 'A stage with this name already exists'));
      if (!r) throw Errors.notFound('Stage');
      await this.audit.record(tx, { action: 'recruitment_stage.renamed', resourceType: 'recruitment_stage', resourceId: id, changes: { name } });
      return r;
    });
  }

  async reorderStages(ids: string[]) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('recruitment:configure', undefined, tx);
      const live = await many<{ id: string; kind: string }>(tx, `select id, kind from recruitment_stages where archived_at is null`);
      if (live.length !== ids.length || live.some((s) => !ids.includes(s.id))) throw Errors.badRequest('stage_list_mismatch', 'Send every current stage exactly once');
      const kindOf = new Map(live.map((s) => [s.id, s.kind]));
      if (kindOf.get(ids[0]!) !== 'new' || kindOf.get(ids.at(-1)!) !== 'hired') throw Errors.badRequest('stage_order', 'Applied must stay first and Hired last');
      for (const [i, id] of ids.entries()) await tx.query(`update recruitment_stages set position = $2 where id = $1`, [id, i + 1]);
      await this.audit.record(tx, { action: 'recruitment_stage.reordered', resourceType: 'recruitment_stage', metadata: { order: ids } });
      return { ok: true };
    });
  }

  async archiveStage(id: string) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('recruitment:configure', undefined, tx);
      const s = await one<{ kind: string }>(tx, `select kind from recruitment_stages where id = $1 and archived_at is null`, [id]);
      if (!s) throw Errors.notFound('Stage');
      if (s.kind === 'new' || s.kind === 'hired') throw Errors.badRequest('fixed_stage', 'The Applied and Hired stages cannot be removed');
      const n = (await one<{ n: number }>(tx, `select count(*)::int as n from applications where stage_id = $1 and status = 'active'`, [id]))!.n;
      if (n) throw Errors.conflict('stage_in_use', `${n} candidate(s) are in this stage. Move them first.`);
      await tx.query(`update recruitment_stages set archived_at = now() where id = $1`, [id]);
      await this.audit.record(tx, { action: 'recruitment_stage.archived', resourceType: 'recruitment_stage', resourceId: id });
    });
  }

  // Career site settings ----------------------------------------------------------------------------------

  async site() {
    return this.db.tenant(async (tx) => {
      await this.authz.require('recruitment:configure', undefined, tx);
      const s = await one(tx, `select enabled, slug, headline, intro, privacy_notice as "privacyNotice", privacy_notice_version as "privacyNoticeVersion", retention_days as "retentionDays", updated_at as "updatedAt" from career_sites`);
      if (s) return { configured: true, ...s };
      const t = (await one<{ slug: string; name: string }>(tx, 'select slug, name from tenants where id = app_tenant_id()'))!;
      return { configured: false, enabled: false, slug: t.slug, headline: `Careers at ${t.name.replace(/\s*\(Demo\)$/, '')}`, intro: '', privacyNotice: '', privacyNoticeVersion: 0, retentionDays: 365 };
    });
  }

  async saveSite(input: CareerSiteInput) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('recruitment:configure', undefined, tx);
      const before = await one<{ privacy_notice: string }>(tx, 'select privacy_notice from career_sites');
      await tx.query(
        `insert into career_sites (tenant_id, enabled, slug, headline, intro, privacy_notice, retention_days) values (app_tenant_id(), $1, $2, $3, $4, $5, $6)
         on conflict (tenant_id) do update set enabled = excluded.enabled, slug = excluded.slug, headline = excluded.headline, intro = excluded.intro,
           privacy_notice = excluded.privacy_notice, retention_days = excluded.retention_days,
           privacy_notice_version = career_sites.privacy_notice_version + case when career_sites.privacy_notice <> excluded.privacy_notice then 1 else 0 end`,
        [input.enabled, input.slug, input.headline, input.intro, input.privacyNotice, input.retentionDays],
      ).catch(uniqueAs('slug_taken', 'Another organisation already uses this career site address'));
      await this.audit.record(tx, {
        action: 'career_site.saved', resourceType: 'career_site',
        changes: { enabled: input.enabled, slug: input.slug, headline: input.headline, retentionDays: input.retentionDays, privacyNoticeChanged: before ? before.privacy_notice !== input.privacyNotice : true },
      });
      return this.siteIn(tx);
    });
  }

  private siteIn(tx: Tx) {
    return one(tx, `select enabled, slug, headline, intro, privacy_notice as "privacyNotice", privacy_notice_version as "privacyNoticeVersion", retention_days as "retentionDays" from career_sites`);
  }

  // Public ------------------------------------------------------------------------------------------------

  /** Resolves a public career site to its workspace, or 404 when it is off, unknown, or the plan has no recruitment. */
  private async resolve(slug: string) {
    const t = await this.db.platform((tx) =>
      one<{ tenant_id: string; name: string }>(
        tx,
        `select cs.tenant_id, t.name from career_sites cs join tenants t on t.id = cs.tenant_id where cs.slug = $1 and cs.enabled and t.status = 'active'`,
        [slug],
      ),
    );
    if (!t) throw Errors.notFound('Career site');
    return { tenantId: t.tenant_id, name: t.name.replace(/\s*\(Demo\)$/, '') };
  }

  private async withSite<T>(slug: string, fn: (tx: Tx, site: { tenantId: string; name: string }) => Promise<T>) {
    const site = await this.resolve(slug);
    return this.db.tenant(async (tx) => {
      const e = await this.entitlements.current(tx);
      if (!e.features.has('recruitment')) throw Errors.notFound('Career site');
      return fn(tx, site);
    }, { tenantId: site.tenantId });
  }

  async publicSite(slug: string) {
    return this.withSite(slug, async (tx, site) => {
      const s = (await one<{ headline: string; intro: string }>(tx, 'select headline, intro from career_sites'))!;
      const jobs = await many(tx, `select ${PUBLIC_JOB_COLUMNS} from job_postings p join job_requisitions r on r.id = p.requisition_id join departments d on d.id = r.department_id
                                    where ${LIVE} order by p.published_at desc`);
      return { organisation: site.name, headline: s.headline, intro: s.intro, jobs };
    });
  }

  async publicJob(slug: string, jobSlug: string) {
    return this.withSite(slug, async (tx, site) => {
      const job = await one(tx, `select ${PUBLIC_JOB_COLUMNS}, p.description from job_postings p join job_requisitions r on r.id = p.requisition_id join departments d on d.id = r.department_id
                                  where p.slug = $1 and ${LIVE}`, [jobSlug]);
      if (!job) throw Errors.notFound('Job');
      const s = (await one<{ privacy_notice: string; headline: string }>(tx, 'select privacy_notice, headline from career_sites'))!;
      return { organisation: site.name, job, privacyNotice: s.privacy_notice };
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
      const job = await one<{ requisition_id: string; title: string; hiring_manager_membership_id: string; created_by_membership_id: string | null }>(
        tx,
        `select p.requisition_id, p.public_title as title, r.hiring_manager_membership_id, r.created_by_membership_id from job_postings p join job_requisitions r on r.id = p.requisition_id where p.slug = $1 and ${LIVE}`,
        [jobSlug],
      );
      if (!job) throw Errors.notFound('Job');
      const notice = (await one<{ v: number }>(tx, 'select privacy_notice_version as v from career_sites'))!.v;
      let candidate = await one<{ id: string }>(tx, `select id from candidates where email = $1 and anonymized_at is null`, [input.email]);
      if (candidate) {
        await tx.query(`update candidates set consent_basis = 'candidate_consent', consent_at = now(), privacy_notice_version = $2, last_activity_at = now() where id = $1`, [candidate.id, notice]);
      } else {
        candidate = (await one<{ id: string }>(
          tx,
          `insert into candidates (tenant_id, first_name, last_name, email, phone, location_text, profile_url, source, consent_basis, privacy_notice_version)
           values (app_tenant_id(), $1, $2, $3, $4, $5, $6, 'career_site', 'candidate_consent', $7) returning id`,
          [input.firstName, input.lastName, input.email, input.phone ?? null, input.locationText ?? null, input.profileUrl ?? null, notice],
        ))!;
      }
      const already = await one(tx, `select 1 from applications where candidate_id = $1 and requisition_id = $2`, [candidate.id, job.requisition_id]);
      if (already) return { received: true };
      await this.candidates.storeResume(tx, site.tenantId, candidate.id, file!, null);
      const { applicationId } = await this.candidates.applyIn(tx, candidate.id, job.requisition_id, 'career_site', input.coverNote ?? null);
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
