import { createHash, createHmac } from 'node:crypto';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import {
  CAREER_TARGET_FIELDS, CRM_DOCUMENT_MAX_BYTES, CRM_PHOTO_TYPES, DEFAULT_CAREER_MAPPING, phoneKey, websiteStageWord, type CareerStage, type CareerTargetField,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { decryptField, safeEqual, sha256 } from '../../platform/auth/crypto';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { EntitlementsService } from '../../platform/entitlements/entitlements.service';
import { AppError, Errors } from '../../platform/http/errors';
import { safeFileName } from '../../platform/http/content-disposition';
import { NotificationService } from '../../platform/notify/notification.service';
import { sniffMatches, StorageService } from '../../platform/storage/storage.service';
import { nextCandidateCode, phonePattern } from '../candidate-crm/crm-common';
import { postJson, safeDownload } from '../integrations/safe-http';
import { CareerAccessService } from './career-access.service';
import { careerEvent, careerSettings, careerStagesOf, crmTimeline, type Doc, nextCareerCode, splitFullName } from './career-common';
import { CareerCrmService } from './career-crm.service';

/** Seconds to wait before each retry; after the last one the job is marked failed and people are told. */
export const CAREER_RETRY_DELAYS_S = [30, 120, 600, 3600, 21_600];
export const CAREER_MAX_ATTEMPTS = CAREER_RETRY_DELAYS_S.length + 1;

const FILE_TYPES: [string, (b: Buffer) => boolean, string][] = [
  ['application/pdf', (b) => sniffMatches('application/pdf', b), '.pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', (b) => sniffMatches('application/vnd.openxmlformats-officedocument.wordprocessingml.document', b), '.docx'],
  ['application/msword', (b) => sniffMatches('application/msword', b), '.doc'],
  ['image/jpeg', (b) => sniffMatches('image/jpeg', b), '.jpg'],
  ['image/png', (b) => sniffMatches('image/png', b), '.png'],
  ['image/webp', (b) => sniffMatches('image/webp', b), '.webp'],
];
/** The real type of a file from its first bytes (never from what the sender says). */
export const sniffType = (b: Buffer) => FILE_TYPES.find(([, test]) => test(b.subarray(0, 512)));

/** The value at a dotted path of the website's payload, as text (null when missing or empty). */
export function pick(payload: Doc, path: string): unknown {
  if (!path) return undefined;
  let v: unknown = payload;
  for (const part of path.split('.')) {
    if (v === null || typeof v !== 'object') return undefined;
    v = (v as Doc)[part];
  }
  return v;
}
const text = (v: unknown, max = 500): string | null => {
  if (v === null || v === undefined) return null;
  const s = (Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? '' : String(v)).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

export interface MappedApplication {
  values: Partial<Record<CareerTargetField, string>>;
  documents: { name: string; url: string }[];
  /** Fields the website sent that are not mapped, as they came (label = the website's field name). */
  extra: { key: string; label: string; value: string }[];
}

const SKIP_EXTRA = new Set(['cv', 'consent', 'website', 'page', 'source', 'documents', 'ua', 'ip']);

/** Applies the field mapping to one payload. Only what the website actually sent is kept. */
export function mapPayload(payload: Doc, mapping: Partial<Record<CareerTargetField, string>>): MappedApplication {
  const m = { ...DEFAULT_CAREER_MAPPING, ...mapping };
  const values: MappedApplication['values'] = {};
  const used = new Set<string>();
  for (const f of CAREER_TARGET_FIELDS) {
    if (f.key === 'documents') continue;
    const path = m[f.key];
    const v = text(pick(payload, path), f.key === 'cvBase64' ? 15_000_000 : f.key === 'message' ? 5000 : 500);
    if (v) { values[f.key] = v; used.add(path); }
  }
  const docsRaw = pick(payload, m.documents);
  const documents = Array.isArray(docsRaw)
    ? docsRaw.flatMap((d) => (d && typeof d === 'object' && typeof (d as Doc).url === 'string' ? [{ name: text((d as Doc).name, 160) ?? 'Document', url: String((d as Doc).url).slice(0, 1000) }] : [])).slice(0, 10)
    : [];
  const extra: MappedApplication['extra'] = [];
  const walk = (obj: Doc, prefix: string) => {
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (used.has(path) || (!prefix && SKIP_EXTRA.has(k))) continue;
      if (v && typeof v === 'object' && !Array.isArray(v)) { if (!prefix) walk(v as Doc, path); continue; }
      const t = text(v, 2000);
      if (t && extra.length < 40) extra.push({ key: path, label: k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), value: t });
    }
  };
  walk(payload, '');
  return { values, documents, extra };
}

/** Field names in a payload (never values), for the mapping screen. */
export function fieldNames(payload: Doc): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(payload)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const k2 of Object.keys(v)) out.push(`${k}.${k2}`);
    else out.push(k);
  }
  return out.slice(0, 80);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The website connection at work: receiving applications (with duplicate checks and the one candidate record),
 * fetching CVs from the website's signed links, sending status updates back, and the retry queue behind all three.
 * A failure never loses an application: what the website sent is kept on the job and processed again.
 */
@Injectable()
export class CareerSyncService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('CareerSync');
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly access: CareerAccessService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly storage: StorageService,
    private readonly entitlements: EntitlementsService,
    private readonly crm: CareerCrmService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private get allowPrivate() {
    return this.config.INTEGRATIONS_ALLOW_PRIVATE_URLS === 'true';
  }

  onApplicationBootstrap() {
    if (this.config.CREW_DISABLE_DISPATCHER === 'true' || this.config.CREW_ENV === 'test') return;
    this.timer = setInterval(() => void this.runDue().catch((err: Error) => this.logger.error(`Career sync tick failed: ${err.message}`)), 10_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // ------------------------------------------------------------------------------------------------------------
  // Receiving an application
  // ------------------------------------------------------------------------------------------------------------

  /** Checks the website's key. Same answer for an unknown connection and a wrong key. */
  private async authenticate(integrationId: string, authorization: string | undefined) {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    const row = /^[0-9a-f-]{36}$/i.test(integrationId)
      ? await this.db.platform((tx) => tx.collection('career_integrations').findOne({ id: integrationId }, { projection: { tenant_id: 1, api_key_hash: 1, enabled: 1 } }))
      : null;
    const ok = safeEqual(sha256(token || '-'), (row?.api_key_hash as string | undefined) ?? '0'.repeat(64));
    if (!row || !token || !ok) throw Errors.unauthorized('The API key is not valid for this SampCrew address. Copy both again from Settings > Career Integration.');
    const tenant = await this.db.platform((tx) => tx.collection('tenants').findOne({ id: row.tenant_id }, { projection: { status: 1 } }));
    if (tenant?.status !== 'active') throw Errors.forbiddenCode('workspace_inactive', 'This SampCrew workspace is not active.');
    if (!row.enabled) throw Errors.forbiddenCode('integration_paused', 'Receiving applications is paused in SampCrew (Settings > Career Integration).');
    return { tenantId: row.tenant_id as string, integrationId };
  }

  /** POST /public/career-intake/:id/candidates: the website sends one application. */
  async receive(integrationId: string, authorization: string | undefined, body: unknown) {
    const { tenantId } = await this.authenticate(integrationId, authorization);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw Errors.badRequest('invalid_body', 'Send the application as a JSON object');
    const payload = body as Doc;
    await this.db.tenant(async (tx) => {
      const e = await this.entitlements.current(tx);
      if (!e.features.has('recruitment')) throw Errors.forbiddenCode('feature_not_in_plan', 'The SampCrew plan of this company does not include Recruitment.');
    }, { tenantId });
    const externalId = text(pick(payload, DEFAULT_CAREER_MAPPING.externalId), 120);
    // The job is written first, in its own transaction, so the application is kept even if processing fails.
    const jobId = await this.db.tenant(async (tx) => {
      await tx.collection('career_integrations').updateOne({ id: integrationId }, { $set: { last_received_at: new Date(), last_fields: fieldNames(payload) } });
      return (await tx.collection('career_sync_jobs').insert({ direction: 'inbound', integration_id: integrationId, external_id: externalId, payload, status: 'running', attempts: 1, locked_until: new Date(Date.now() + 60_000) })).id as string;
    }, { tenantId });
    try {
      const result = await this.db.tenant((tx) => this.process(tx, tenantId, integrationId, payload, jobId), { tenantId });
      await this.afterReceive(tenantId, result.applicationId);
      return { ok: true, id: result.code, applicationId: result.applicationId, candidateId: result.candidateCode, stage: 'applied', duplicate: result.duplicate };
    } catch (err) {
      const permanent = err instanceof AppError && err.getStatus() < 500;
      await this.failJob(tenantId, jobId, err as Error, permanent);
      throw err;
    }
  }

  /** Processes what the website sent: inside one transaction, so a half-saved application never exists. */
  async process(tx: TenantTx, tenantId: string, integrationId: string, payload: Doc, jobId: string | null) {
    const integ = await tx.collection('career_integrations').findOne({ id: integrationId });
    if (!integ) throw Errors.notFound('Career integration');
    const mapped = mapPayload(payload, integ.mapping ?? {});
    const v = mapped.values;
    const email = v.email && EMAIL.test(v.email) ? v.email.toLowerCase().slice(0, 254) : null;
    let phone = v.phone ? v.phone.slice(0, 40) : null;
    if (phone && v.countryCode && !phone.startsWith('+')) phone = `${v.countryCode.startsWith('+') ? v.countryCode : `+${v.countryCode}`} ${phone}`.slice(0, 40);
    const name = v.fullName ? splitFullName(v.fullName) : v.firstName ? { first: v.firstName, last: v.lastName ?? '' } : null;
    const problems: { path: string; message: string }[] = [];
    if (!name) problems.push({ path: integ.mapping?.fullName || DEFAULT_CAREER_MAPPING.fullName, message: 'The application has no candidate name' });
    if (!email && !phoneKey(phone)) problems.push({ path: integ.mapping?.email || DEFAULT_CAREER_MAPPING.email, message: 'The application has neither a valid email address nor a phone number' });
    if (problems.length) throw new AppError(422, 'application_incomplete', problems.map((p) => p.message).join('. '), problems);
    const externalId = v.externalId ?? null;
    const apps = tx.collection('career_applications');

    // The same website application sent again (the website's "send again"): answer with the one already received.
    if (externalId) {
      const same = await apps.findOne({ integration_id: integrationId, external_id: externalId });
      if (same) {
        const c = await tx.collection('candidates').findOne({ id: same.candidate_id }, { projection: { candidate_code: 1 } });
        if (jobId) await this.succeedJob(tx, jobId, same.id);
        return { applicationId: same.id as string, code: same.code as string, candidateCode: (c?.candidate_code as string | undefined) ?? null, duplicate: true, fresh: false };
      }
    }

    // One candidate per person: by email, then by phone number.
    const candidates = tx.collection('candidates');
    let cand: Doc | null = email ? (await candidates.findOne({ email, anonymized_at: null })) ?? null : null;
    const key = phoneKey(phone);
    if (!cand && key) cand = await candidates.findOne({ phone: { $regex: phonePattern(key) }, anonymized_at: null }) ?? null;
    const now = new Date();
    if (cand) {
      // Fill only what the record does not have yet; never overwrite what HR or the candidate gave before.
      const fill: Doc = {};
      if (!cand.email && email) fill.email = email;
      if (!cand.phone && phone) fill.phone = phone;
      if (!cand.location_text && v.location) fill.location_text = v.location;
      if (!cand.profile_url && v.linkedin) fill.profile_url = v.linkedin;
      if (!cand.current_title && v.currentDesignation) fill.current_title = v.currentDesignation;
      if (Object.keys(fill).length) await candidates.updateOne({ id: cand.id }, { $set: fill });
    } else {
      cand = await candidates.insert({
        first_name: name!.first.slice(0, 100), last_name: name!.last.slice(0, 100) || null, email, phone, location_text: v.location ?? null, profile_url: v.linkedin ?? null,
        current_title: v.currentDesignation ?? null, source: 'career_site', source_detail: String(integ.website_name).slice(0, 120), consent_basis: 'candidate_consent', consent_at: now,
        candidate_code: await nextCandidateCode(tx), crm_stage: 'new', crm_stage_entered_at: now, crm_source: 'company_website', crm_hr_workspace_id: integ.default_hr_workspace_id ?? null,
        crm_shared_hr_workspace_ids: [], career_only: true, links: { ...(v.linkedin ? { linkedin: v.linkedin } : {}), ...(v.portfolio ? { portfolio: v.portfolio } : {}) },
      });
    }
    const candidateId = cand!.id as string;

    // A second submission for the same open position: kept on the first application, not a new one.
    const position = v.position ?? null;
    const stages = careerStagesOf(await careerSettings(tx));
    const closed = stages.filter((s) => s.kind === 'lost' || s.key === 'joined').map((s) => s.key);
    if (position) {
      const open = await apps.findOne({ candidate_id: candidateId, position: { $regex: `^${position.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' }, stage: { $nin: closed } });
      if (open) {
        await apps.updateOne({ id: open.id }, { $inc: { resubmissions: 1 }, $set: { last_activity_at: now } });
        await careerEvent(tx, open.id, 'resubmitted', { detail: { externalId, website: integ.website_name }, actor: null });
        await this.queueFiles(tx, tenantId, open, candidateId, v, mapped.documents, integrationId);
        if (jobId) await this.succeedJob(tx, jobId, open.id);
        return { applicationId: open.id as string, code: open.code as string, candidateCode: cand!.candidate_code as string, duplicate: true, fresh: false };
      }
    }

    const kindWord = (v.kind ?? '').toLowerCase();
    const kind = /enquir|inquir/.test(kindWord) || (!position && !v.cvUrl && !v.cvBase64 && !/applic/.test(kindWord)) ? 'enquiry' : 'application';
    const submitted = v.appliedAt && !Number.isNaN(Date.parse(v.appliedAt)) ? new Date(v.appliedAt) : now;
    const fields: Doc = Object.fromEntries(Object.entries(v).filter(([k]) => !['cvBase64', 'cvUrl'].includes(k)));
    const app = await apps.insert({
      code: await nextCareerCode(tx), integration_id: integrationId, external_id: externalId, candidate_id: candidateId, kind, position, department: v.department ?? null,
      fields, extra: mapped.extra, hr_workspace_id: integ.default_hr_workspace_id ?? null, assigned_hr_membership_id: integ.default_hr_membership_id ?? null,
      assigned_recruiter_membership_id: integ.default_recruiter_membership_id ?? null, submitted_at: submitted > now ? now : submitted, source: 'website', stage: 'new_application',
      cv_state: v.cvUrl || v.cvBase64 ? 'pending' : 'none',
    });
    await careerEvent(tx, app.id, 'received', { to: 'new_application', detail: { website: integ.website_name, externalId, kind, candidateLinked: !cand!.career_only }, actor: null });
    await crmTimeline(tx, candidateId, { careerKind: 'received', applicationId: app.id, code: app.code, position, website: integ.website_name });
    await this.queueFiles(tx, tenantId, app, candidateId, v, mapped.documents, integrationId);
    await tx.collection('career_integrations').updateOne({ id: integrationId }, { $set: { last_success_at: now, last_error: null }, $inc: { received_count: 1 } });
    await this.audit.record(tx, { tenantId, action: 'career_application.received', resourceType: 'career_application', resourceId: app.id, metadata: { code: app.code, website: integ.website_name, externalId, kind } });
    if (jobId) await this.succeedJob(tx, jobId, app.id);
    return { applicationId: app.id as string, code: app.code as string, candidateCode: cand!.candidate_code as string, duplicate: false, fresh: true };
  }

  /** Notices, the candidate's acknowledgement, files and the CRM move, once the application itself is saved. */
  private async afterReceive(tenantId: string, applicationId: string) {
    const jobs = await this.db.tenant(async (tx) => {
      const app = (await tx.collection('career_applications').findOne({ id: applicationId }))!;
      const integ = await tx.collection('career_integrations').findOne({ id: app.integration_id });
      const fresh = !(await tx.collection('career_application_events').exists({ application_id: applicationId, kind: 'notified' }));
      if (fresh && integ) {
        const c = (await tx.collection('candidates').findOne({ id: app.candidate_id }))!;
        const who = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim();
        if (integ.notify_on_new) {
          const to = await this.access.audience(tx, app, { superWorkspace: !!integ.notify_super_workspace });
          await this.notifications.notify(tx, {
            membershipIds: to, kind: app.kind === 'enquiry' ? 'career.enquiry_received' : 'career.application_received', priority: 'high', email: true,
            title: app.kind === 'enquiry' ? `New career enquiry from ${who}` : `New career application: ${who}${app.position ? ` for ${app.position}` : ''}`,
            body: [app.code, integ.website_name, app.department].filter(Boolean).join(' · '), link: `/career-enquiry/applications/${app.id}`,
            resource: { type: 'career_application', id: app.id }, dedupeKey: `career.received:${app.id}`,
          });
        }
        if (integ.candidate_acknowledgement && c.email) {
          const org = String((await tx.collection('tenants').findOne({}, { projection: { name: 1 } }))?.name ?? '').replace(/\s*\(Demo\)$/, '');
          await this.notifications.queueEmail(tx, tenantId, c.email, `We received your ${app.kind === 'enquiry' ? 'enquiry' : 'application'}${app.position ? `: ${app.position}` : ''}`,
            `Dear ${who},\n\nThank you for your interest in ${org}. We have your ${app.kind === 'enquiry' ? 'career enquiry' : 'application'} (reference ${app.code}) and our hiring team will be in touch.\n\n${org}`,
            'career.received');
        }
        await careerEvent(tx, app.id, 'notified', { actor: null });
        if (integ.auto_move_to_crm) await this.crm.moveIn(tx, app, null);
      }
      return (await tx.collection('career_sync_jobs').find({ application_id: applicationId, direction: 'cv', status: 'pending' }, { projection: { _id: 1 } })).map((j) => j.id as string);
    }, { tenantId });
    // Fetch files now so the CV is usually there when HR opens the application; failures are retried later.
    for (const id of jobs) await this.runJob(tenantId, id).catch(() => undefined);
  }

  /** Queues the CV, the photo and supporting documents (or stores a CV the website sent inside the JSON). */
  private async queueFiles(tx: TenantTx, tenantId: string, app: Doc, candidateId: string, v: MappedApplication['values'], documents: { name: string; url: string }[], integrationId: string) {
    const jobs = tx.collection('career_sync_jobs');
    if (v.cvBase64) {
      const buf = Buffer.from(v.cvBase64.replace(/^data:[^,]*,/, ''), 'base64');
      await this.storeFile(tx, tenantId, app.id, candidateId, buf, v.cvName ?? null, 'cv');
    } else if (v.cvUrl) {
      await jobs.insert({ direction: 'cv', integration_id: integrationId, application_id: app.id, external_id: app.external_id ?? null, payload: { url: v.cvUrl, name: v.cvName ?? null, as: 'cv' }, status: 'pending', next_attempt_at: new Date() });
      await tx.collection('career_applications').updateOne({ id: app.id }, { $set: { cv_state: 'pending' } });
    }
    if (v.photoUrl) await jobs.insert({ direction: 'cv', integration_id: integrationId, application_id: app.id, payload: { url: v.photoUrl, name: 'photo', as: 'photo' }, status: 'pending', next_attempt_at: new Date() });
    for (const d of documents) await jobs.insert({ direction: 'cv', integration_id: integrationId, application_id: app.id, payload: { url: d.url, name: d.name, as: 'document' }, status: 'pending', next_attempt_at: new Date() });
  }

  /** Stores a CV or document on the candidate (once: the same file again is not stored twice). */
  async storeFile(tx: TenantTx, tenantId: string, applicationId: string, candidateId: string, buf: Buffer, name: string | null, as: 'cv' | 'document' | 'photo') {
    if (!buf.length) throw Errors.badRequest('empty_file', 'The file is empty');
    if (buf.length > CRM_DOCUMENT_MAX_BYTES) throw Errors.badRequest('file_too_large', 'The file is larger than 10 MB');
    const type = sniffType(buf);
    if (as === 'photo') {
      if (!type || !(CRM_PHOTO_TYPES as readonly string[]).includes(type[0])) throw Errors.badRequest('unsupported_type', 'The photo is not a JPEG, PNG or WebP image');
      const c = await tx.collection('candidates').findOne({ id: candidateId }, { projection: { photo_storage_key: 1, personal: 1 } });
      if (c?.photo_storage_key) return null;
      const key = this.storage.newKey(tenantId);
      await this.storage.put(key, buf, { upload: true });
      await tx.collection('candidates').updateOne({ id: candidateId }, { $set: { photo_storage_key: key, personal: { ...(c?.personal ?? {}), photoType: type[0] } } });
      await careerEvent(tx, applicationId, 'photo_stored', { actor: null });
      return null;
    }
    if (!type || type[0].startsWith('image/') && as === 'cv') throw Errors.badRequest('unsupported_type', 'The CV is not a PDF or Word file');
    const sha = createHash('sha256').update(buf).digest('hex');
    const files = tx.collection('candidate_files');
    let file = await files.findOne({ candidate_id: candidateId, sha256: sha, deleted_at: null });
    const fileName = safeFileName((name && /\.[a-z0-9]{2,5}$/i.test(name) ? name : `${name || (as === 'cv' ? 'CV' : 'Document')}${type[2]}`).slice(0, 150), 'cv');
    if (!file) {
      const key = this.storage.newKey(tenantId);
      await this.storage.put(key, buf, { upload: true });
      file = await files.insert({
        candidate_id: candidateId, file_name: fileName, content_type: type[0], size_bytes: buf.length, sha256: sha, storage_key: key, kind: as === 'cv' ? 'resume' : 'other',
        name: as === 'cv' ? 'CV from the website' : fileName.replace(/\.[a-z0-9]{2,5}$/i, ''), notes: 'Received through Career Enquiry', version: 1,
      });
    }
    const apps = tx.collection('career_applications');
    if (as === 'cv') await apps.updateOne({ id: applicationId }, { $set: { cv_file_id: file.id, cv_state: 'stored' } });
    else await apps.updateOne({ id: applicationId }, { $addToSet: { document_file_ids: file.id } });
    await careerEvent(tx, applicationId, as === 'cv' ? 'cv_stored' : 'document_stored', { detail: { fileId: file.id, fileName: file.file_name, size: file.size_bytes }, actor: null });
    return file.id as string;
  }

  // ------------------------------------------------------------------------------------------------------------
  // Status back to the website
  // ------------------------------------------------------------------------------------------------------------

  /** Queues a status update for the website (when the application came from it and updates are on). */
  async queueStatus(tx: TenantTx, app: Doc, stage: CareerStage, note: string | null, interviewAt?: Date | null) {
    if (!app.integration_id || !app.external_id) return;
    const integ = await tx.collection('career_integrations').findOne({ id: app.integration_id }, { projection: { send_status_updates: 1, status_webhook_url: 1, webhook_secret_enc: 1, enabled: 1 } });
    if (!integ?.send_status_updates || !integ.status_webhook_url || !integ.webhook_secret_enc) return;
    const word = websiteStageWord(stage);
    const body: Doc = { externalId: app.external_id, stage: word, status: word, note: [stage.label, note].filter(Boolean).join(': ').slice(0, 1000), sampcrewId: app.code };
    if (interviewAt) body.interviewAt = interviewAt.toISOString();
    await tx.collection('career_sync_jobs').insert({ direction: 'outbound', integration_id: app.integration_id, application_id: app.id, external_id: app.external_id, payload: body, status: 'pending', next_attempt_at: new Date() });
  }

  /** Sends one signed request to the website's SampCrew webhook. */
  async postToWebsite(url: string, secretEnc: string, body: Doc) {
    const raw = JSON.stringify(body);
    const secret = decryptField(secretEnc, this.config.fieldKeys);
    const sig = createHmac('sha256', secret).update(raw).digest('hex');
    return postJson(url, raw, { 'user-agent': 'SampCrew-CareerEnquiry/1.0', 'x-sampcrew-signature': sig }, { allowPrivate: this.allowPrivate, timeoutMs: 15_000 });
  }

  // ------------------------------------------------------------------------------------------------------------
  // The queue
  // ------------------------------------------------------------------------------------------------------------

  private due() {
    return { $or: [{ status: 'pending', next_attempt_at: { $lte: new Date() } }, { status: 'running', locked_until: { $lt: new Date() } }] };
  }

  /** Claims due jobs across companies and runs them. Exposed for tests. */
  async runDue(limit = 20): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const list = await this.db.platform((tx) => tx.collection('career_sync_jobs').find(this.due(), { sort: { next_attempt_at: 1 }, limit, projection: { tenant_id: 1 } }));
      for (const j of list) await this.runJob(j.tenant_id as string, j.id as string).catch((err: Error) => this.logger.warn(`Career job ${j.id} failed: ${err.message}`));
      return list.length;
    } finally {
      this.ticking = false;
    }
  }

  /** Runs one job now: claims it, does the work outside a transaction, records the result. */
  async runJob(tenantId: string, jobId: string) {
    const job = await this.db.tenant((tx) => tx.collection('career_sync_jobs').updateAndGet(
      { id: jobId, ...this.due() },
      { $set: { status: 'running', locked_until: new Date(Date.now() + 90_000) }, $inc: { attempts: 1 } },
    ), { tenantId });
    if (!job) return;
    try {
      if (job.direction === 'inbound') {
        const r = await this.db.tenant((tx) => this.process(tx, tenantId, job.integration_id, job.payload ?? {}, job.id), { tenantId });
        await this.afterReceive(tenantId, r.applicationId);
      } else if (job.direction === 'cv') {
        await this.fetchFile(tenantId, job);
      } else {
        await this.sendStatus(tenantId, job);
      }
    } catch (err) {
      const permanent = err instanceof AppError && err.getStatus() < 500 && job.direction === 'inbound';
      await this.failJob(tenantId, jobId, err as Error, permanent);
    }
  }

  private async fetchFile(tenantId: string, job: Doc) {
    const p = job.payload as { url: string; name: string | null; as: 'cv' | 'document' | 'photo' };
    const r = await safeDownload(p.url, { allowPrivate: this.allowPrivate, maxBytes: CRM_DOCUMENT_MAX_BYTES, timeoutMs: 30_000 });
    if (r.status === 403 || r.status === 410) throw Object.assign(new Error(`The website's file link has expired (${r.status}). Send the application again from the website's super admin.`), { statusCode: r.status });
    if (r.status < 200 || r.status >= 300) throw Object.assign(new Error(`The website answered ${r.status} for the file`), { statusCode: r.status });
    await this.db.tenant(async (tx) => {
      const app = await tx.collection('career_applications').findOne({ id: job.application_id }, { projection: { candidate_id: 1 } });
      if (!app) throw Errors.notFound('Application');
      await this.storeFile(tx, tenantId, job.application_id, app.candidate_id, r.body, p.name || r.fileName, p.as);
      await this.succeedJob(tx, job.id, job.application_id, r.status);
    }, { tenantId });
  }

  private async sendStatus(tenantId: string, job: Doc) {
    const integ = await this.db.tenant((tx) => tx.collection('career_integrations').findOne({ id: job.integration_id }), { tenantId });
    if (!integ?.status_webhook_url || !integ.webhook_secret_enc) throw new Error('The website status address or webhook secret is not set');
    const r = await this.postToWebsite(integ.status_webhook_url, integ.webhook_secret_enc, job.payload);
    if (r.status === 401) throw Object.assign(new Error('The website refused SampCrew’s signature (401). Paste the webhook secret again in the website’s Connections & keys.'), { statusCode: 401 });
    if (r.status < 200 || r.status >= 300) throw Object.assign(new Error(`The website answered ${r.status}`), { statusCode: r.status });
    await this.db.tenant(async (tx) => {
      await this.succeedJob(tx, job.id, job.application_id, r.status);
      await tx.collection('career_applications').updateOne({ id: job.application_id }, { $set: { website_stage: job.payload.stage, website_synced_at: new Date() } });
      await careerEvent(tx, job.application_id, 'website_synced', { detail: { stage: job.payload.stage }, actor: null });
      await tx.collection('career_integrations').updateOne({ id: job.integration_id }, { $set: { last_success_at: new Date() } });
    }, { tenantId });
  }

  private async succeedJob(tx: TenantTx, jobId: string, applicationId: string | null, statusCode?: number) {
    const job = await tx.collection('career_sync_jobs').findOne({ id: jobId }, { projection: { direction: 1 } });
    // A received application keeps only the field names once it is saved: the values live on the application now.
    const set: Doc = { status: 'succeeded', done_at: new Date(), locked_until: null, next_attempt_at: null, last_error: null, application_id: applicationId, last_status_code: statusCode ?? null };
    if (job?.direction !== 'outbound') set.payload = { stored: true };
    await tx.collection('career_sync_jobs').updateOne({ id: jobId }, { $set: set });
  }

  /** Records a failure: retried later on the back-off, or marked failed (and people told) after the last try. */
  private async failJob(tenantId: string, jobId: string, err: Error, permanent: boolean) {
    await this.db.tenant(async (tx) => {
      const job = await tx.collection('career_sync_jobs').findOne({ id: jobId });
      if (!job) return;
      const final = permanent || job.attempts >= CAREER_MAX_ATTEMPTS;
      const delay = CAREER_RETRY_DELAYS_S[Math.min(job.attempts, CAREER_RETRY_DELAYS_S.length) - 1] ?? 60;
      const message = (err.message || 'Failed').slice(0, 500);
      const now = new Date();
      await tx.collection('career_sync_jobs').updateOne({ id: jobId }, { $set: {
        status: final ? 'failed' : 'pending', locked_until: null, next_attempt_at: final ? null : new Date(now.getTime() + delay * 1000), last_error: message,
        last_status_code: (err as { statusCode?: number }).statusCode ?? (err instanceof AppError ? err.getStatus() : null),
      } });
      await tx.collection('career_integrations').updateOne({ id: job.integration_id }, { $set: { last_error: message, last_error_at: now } });
      if (job.direction === 'cv' && final && job.payload?.as === 'cv') await tx.collection('career_applications').updateOne({ id: job.application_id }, { $set: { cv_state: 'failed' } });
      if (job.application_id) await careerEvent(tx, job.application_id, 'sync_failed', { detail: { direction: job.direction, error: message, final }, actor: null });
      if (final) {
        const integ = await tx.collection('career_integrations').findOne({ id: job.integration_id }, { projection: { default_hr_membership_id: 1 } });
        const supers = await this.superMembers(tx);
        await this.notifications.notify(tx, {
          membershipIds: [...supers, integ?.default_hr_membership_id].filter(Boolean) as string[], kind: 'career.sync_failed', priority: 'high',
          title: job.direction === 'inbound' ? 'A website application could not be saved' : job.direction === 'cv' ? 'A CV could not be fetched from the website' : 'A status update could not reach the website',
          body: message, link: job.application_id ? `/career-enquiry/applications/${job.application_id}` : '/settings/career-integration?tab=log', dedupeKey: `career.sync_failed:${jobId}`,
        });
      }
    }, { tenantId }).catch((e: Error) => this.logger.error(`Could not record career job failure: ${e.message}`));
  }

  async superMembers(tx: TenantTx): Promise<string[]> {
    const role = await tx.collection('roles').findOne({ is_system: true, key: 'super_workspace' }, { projection: { _id: 1 } });
    if (!role) return [];
    const held = await tx.collection('role_assignments').distinct<string>('membership_id', { role_id: role.id });
    return tx.collection('memberships').distinct<string>('id', { id: { $in: held }, status: 'active' });
  }

  /** Puts failed jobs back in the queue (all, or the ones given) and runs them now. */
  async retry(tenantId: string, jobIds?: string[]) {
    const ids = await this.db.tenant(async (tx) => {
      const filter: Doc = { status: 'failed', ...(jobIds?.length ? { id: { $in: jobIds } } : {}) };
      const list = await tx.collection('career_sync_jobs').distinct<string>('id', filter);
      if (list.length) await tx.collection('career_sync_jobs').update({ id: { $in: list } }, { $set: { status: 'pending', attempts: 0, next_attempt_at: new Date(), locked_until: null } });
      await tx.collection('career_applications').update({ cv_state: 'failed', id: { $in: await tx.collection('career_sync_jobs').distinct<string>('application_id', { id: { $in: list }, direction: 'cv' }) } }, { $set: { cv_state: 'pending' } });
      return list;
    }, { tenantId });
    for (const id of ids) await this.runJob(tenantId, id);
    const left = await this.db.tenant((tx) => tx.collection('career_sync_jobs').count({ id: { $in: ids }, status: { $ne: 'succeeded' } }), { tenantId });
    return { retried: ids.length, succeeded: ids.length - left, stillFailing: left };
  }
}
