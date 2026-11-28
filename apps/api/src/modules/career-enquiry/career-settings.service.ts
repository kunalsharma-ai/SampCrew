import { Inject, Injectable } from '@nestjs/common';
import {
  CAREER_TARGET_FIELDS, DEFAULT_CAREER_MAPPING, normaliseCareerStages, type CareerIntegrationInput, type careerMappingInput, type careerStagesInput,
} from '@crew/contracts';
import type { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { encryptField, randomToken, sha256 } from '../../platform/auth/crypto';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { checkUrlShape } from '../integrations/safe-http';
import { CareerAccessService } from './career-access.service';
import { careerSettings, careerStagesOf, type Doc } from './career-common';
import { CareerSyncService } from './career-sync.service';

const TEST_EXTERNAL_ID = 'sampcrew-connection-test';

/**
 * Settings > Career Integration (Super Workspace only): the website connection, its keys, the field mapping, the
 * recruitment pipeline and defaults, and the sync log. Keys are shown once, when they are made; after that only a
 * hint. The intake address is derived from this installation's public API address.
 */
@Injectable()
export class CareerSettingsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: CareerAccessService,
    private readonly audit: AuditService,
    private readonly sync: CareerSyncService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private intakeUrl(id: string) {
    return `${this.config.API_PUBLIC_URL.replace(/\/+$/, '')}/api/v1/public/career-intake/${id}`;
  }

  private async superActor(tx: TenantTx) {
    const a = await this.access.actor(tx);
    this.access.requireSuper(a);
    return a;
  }

  private view(i: Doc | null) {
    if (!i) return null;
    return {
      id: i.id as string, websiteName: i.website_name as string, websiteUrl: i.website_url as string, statusWebhookUrl: i.status_webhook_url ?? null, enabled: !!i.enabled,
      sendStatusUpdates: !!i.send_status_updates, defaultHrWorkspaceId: i.default_hr_workspace_id ?? null, defaultHrMembershipId: i.default_hr_membership_id ?? null,
      defaultRecruiterMembershipId: i.default_recruiter_membership_id ?? null, autoMoveToCrm: !!i.auto_move_to_crm, candidateAcknowledgement: !!i.candidate_acknowledgement,
      notifyOnNew: !!i.notify_on_new, notifySuperWorkspace: !!i.notify_super_workspace,
      /** What the website puts in SAMPCREW_API_URL (it adds /candidates itself). */
      apiUrl: this.intakeUrl(i.id), endpoint: `${this.intakeUrl(i.id)}/candidates`,
      hasApiKey: !!i.api_key_hash, apiKeyHint: i.api_key_hint ?? null, apiKeyCreatedAt: i.api_key_created_at ?? null, hasWebhookSecret: !!i.webhook_secret_enc,
      lastReceivedAt: i.last_received_at ?? null, lastSuccessAt: i.last_success_at ?? null, lastError: i.last_error ?? null, lastErrorAt: i.last_error_at ?? null,
      receivedCount: i.received_count ?? 0, lastFields: (i.last_fields ?? []) as string[], lastTest: i.last_test ?? null,
      mapping: { ...DEFAULT_CAREER_MAPPING, ...(i.mapping ?? {}) },
      status: !i.api_key_hash ? 'not_connected' : !i.enabled ? 'paused' : i.last_error_at && (!i.last_success_at || i.last_error_at > i.last_success_at) ? 'error' : i.last_received_at ? 'connected' : 'waiting',
    };
  }

  async get() {
    return this.db.tenant(async (tx) => {
      await this.superActor(tx);
      const i = await tx.collection('career_integrations').findOne({});
      const jobs = tx.collection('career_sync_jobs');
      return {
        integration: this.view(i ?? null),
        fields: CAREER_TARGET_FIELDS,
        stages: careerStagesOf(await careerSettings(tx)),
        counts: { failed: await jobs.count({ status: 'failed' }), pending: await jobs.count({ status: { $in: ['pending', 'running'] } }), succeeded7d: await jobs.count({ status: 'succeeded', created_at: { $gt: new Date(Date.now() - 7 * 86_400_000) } }) },
      };
    });
  }

  private checkUrl(path: string, url: string | null) {
    if (!url) return;
    const problem = checkUrlShape(url, this.config.INTEGRATIONS_ALLOW_PRIVATE_URLS === 'true');
    if (problem) throw Errors.validation([{ path, message: problem }]);
  }

  async save(input: CareerIntegrationInput) {
    this.checkUrl('websiteUrl', input.websiteUrl);
    this.checkUrl('statusWebhookUrl', input.statusWebhookUrl);
    return this.db.tenant(async (tx) => {
      const a = await this.superActor(tx);
      if (input.defaultHrWorkspaceId && !(await tx.collection('hr_workspaces').exists({ id: input.defaultHrWorkspaceId, status: 'active' }))) throw Errors.validation([{ path: 'defaultHrWorkspaceId', message: 'Choose an active HR Workspace' }]);
      const people = new Set((await this.access.assignees(tx, a)).map((p) => p.membershipId));
      for (const [k, v] of [['defaultHrMembershipId', input.defaultHrMembershipId], ['defaultRecruiterMembershipId', input.defaultRecruiterMembershipId]] as const) {
        if (v && !people.has(v)) throw Errors.validation([{ path: k, message: 'Choose a Super Workspace or HR Workspace person' }]);
      }
      const fields = {
        website_name: input.websiteName, website_url: input.websiteUrl.replace(/\/+$/, ''),
        status_webhook_url: input.statusWebhookUrl ?? `${input.websiteUrl.replace(/\/+$/, '')}/api/v1/integrations/sampcrew/webhook`,
        enabled: input.enabled, send_status_updates: input.sendStatusUpdates, default_hr_workspace_id: input.defaultHrWorkspaceId, default_hr_membership_id: input.defaultHrMembershipId,
        default_recruiter_membership_id: input.defaultRecruiterMembershipId, auto_move_to_crm: input.autoMoveToCrm, candidate_acknowledgement: input.candidateAcknowledgement,
        notify_on_new: input.notifyOnNew, notify_super_workspace: input.notifySuperWorkspace, updated_by_membership_id: a.membershipId,
      };
      const table = tx.collection('career_integrations');
      const before = await table.findOne({});
      if (before) await table.updateOne({ id: before.id }, { $set: fields });
      else await table.insert({ ...fields, mapping: {} });
      await this.audit.record(tx, { action: before ? 'career_integration.updated' : 'career_integration.created', resourceType: 'career_integration', resourceId: before?.id ?? null, changes: { ...fields, updated_by_membership_id: undefined } });
      return this.view((await table.findOne({})) ?? null);
    });
  }

  /**
   * Makes a new API key and webhook secret (the old ones stop working at once) and returns them this one time, with
   * exactly what to paste into the website's super admin.
   */
  async generateKeys() {
    return this.db.tenant(async (tx) => {
      await this.superActor(tx);
      const table = tx.collection('career_integrations');
      const i = await table.findOne({});
      if (!i) throw Errors.conflict('integration_missing', 'Save the website details first');
      const apiKey = `scce_${randomToken(32)}`;
      const secret = `scwh_${randomToken(32)}`;
      await table.updateOne({ id: i.id }, { $set: {
        api_key_hash: sha256(apiKey), api_key_hint: `…${apiKey.slice(-4)}`, api_key_created_at: new Date(), webhook_secret_enc: encryptField(secret, this.config.fieldKeys),
      } });
      await this.audit.record(tx, { action: i.api_key_hash ? 'career_integration.keys_rotated' : 'career_integration.keys_created', resourceType: 'career_integration', resourceId: i.id });
      return {
        apiUrl: this.intakeUrl(i.id), apiKey, webhookSecret: secret,
        websiteKeys: [
          { name: 'SAMPCREW_API_URL', value: this.intakeUrl(i.id) },
          { name: 'SAMPCREW_API_KEY', value: apiKey },
          { name: 'SAMPCREW_WEBHOOK_SECRET', value: secret },
        ],
      };
    });
  }

  /**
   * Tests both directions without touching any real application: a signed status update for an application id that
   * does not exist on the website (the website answers but changes nothing), and whether anything has arrived.
   */
  async test() {
    const i = await this.db.tenant(async (tx) => {
      await this.superActor(tx);
      const row = await tx.collection('career_integrations').findOne({});
      if (!row) throw Errors.conflict('integration_missing', 'Save the website details first');
      return row;
    });
    let ok = false;
    let message: string;
    let statusCode: number | null = null;
    if (!i.webhook_secret_enc) message = 'Generate the keys first, and paste them into the website’s super admin.';
    else if (!i.status_webhook_url) message = 'Add the website’s status address.';
    else {
      try {
        const r = await this.sync.postToWebsite(i.status_webhook_url, i.webhook_secret_enc, { externalId: TEST_EXTERNAL_ID, stage: 'test', status: 'test', note: 'SampCrew connection test' });
        statusCode = r.status;
        if (r.status >= 200 && r.status < 300) { ok = true; message = 'Connected. The website accepted SampCrew’s signed status update.'; }
        else if (r.status === 401) message = 'The website refused the signature. Paste SAMPCREW_WEBHOOK_SECRET again in the website’s Connections & keys.';
        else if (r.status === 404) message = 'The website has no SAMPCREW_WEBHOOK_SECRET saved yet (it answered 404). Paste the keys into its Connections & keys.';
        else message = `The website answered ${r.status}.`;
      } catch (err) {
        message = `Could not reach the website: ${(err as Error).message}`;
      }
    }
    const inbound = i.last_received_at ? `Last application received ${new Date(i.last_received_at).toISOString()}.` : 'No application has arrived yet. Submit a test application on the website’s careers page, or use “Send again” on one in its super admin.';
    const result = { ok, message, inbound, statusCode, at: new Date().toISOString() };
    await this.db.tenant(async (tx) => {
      await tx.collection('career_integrations').updateOne({ id: i.id }, { $set: { last_test: result } });
      await this.audit.record(tx, { action: 'career_integration.tested', resourceType: 'career_integration', resourceId: i.id, metadata: { ok, statusCode } });
    });
    return result;
  }

  async saveMapping(input: z.infer<typeof careerMappingInput>) {
    return this.db.tenant(async (tx) => {
      await this.superActor(tx);
      const table = tx.collection('career_integrations');
      const i = await table.findOne({});
      if (!i) throw Errors.conflict('integration_missing', 'Save the website details first');
      const mapping = Object.fromEntries(Object.entries(input.mapping).filter(([k, v]) => v !== DEFAULT_CAREER_MAPPING[k as keyof typeof DEFAULT_CAREER_MAPPING]));
      if (!(input.mapping.email ?? DEFAULT_CAREER_MAPPING.email) && !(input.mapping.phone ?? DEFAULT_CAREER_MAPPING.phone)) throw Errors.validation([{ path: 'mapping.email', message: 'Map the email or the phone number' }]);
      await table.updateOne({ id: i.id }, { $set: { mapping } });
      await this.audit.record(tx, { action: 'career_integration.mapping_saved', resourceType: 'career_integration', resourceId: i.id, changes: { mapping } });
      return { mapping: { ...DEFAULT_CAREER_MAPPING, ...mapping } };
    });
  }

  async saveStages(input: z.infer<typeof careerStagesInput>) {
    return this.db.tenant(async (tx) => {
      await this.superActor(tx);
      let stages;
      try {
        stages = normaliseCareerStages(input.stages);
      } catch (e) {
        throw Errors.validation([{ path: 'stages', message: (e as Error).message }]);
      }
      const before = careerStagesOf(await careerSettings(tx));
      for (const s of before) {
        const now = stages.find((x) => x.key === s.key);
        if ((!now || !now.active) && (await tx.collection('career_applications').exists({ stage: s.key }))) {
          const n = await tx.collection('career_applications').count({ stage: s.key });
          throw Errors.conflict('stage_in_use', `${n} application(s) are in ${s.label}. Move them before removing or switching off the stage.`);
        }
      }
      await tx.collection('career_settings').updateOne({}, { $set: { stages } });
      await this.audit.record(tx, { action: 'career_enquiry.stages_saved', resourceType: 'career_settings', changes: { stages: { from: before.map((s) => s.label), to: stages.map((s) => s.label) } } });
      return { stages };
    });
  }

  async log(q: { status?: string; direction?: string }) {
    return this.db.tenant(async (tx) => {
      await this.superActor(tx);
      const rows = await tx.collection('career_sync_jobs').find({ ...(q.status ? { status: q.status } : {}), ...(q.direction ? { direction: q.direction } : {}) }, { sort: { created_at: -1 }, limit: 200 });
      const codes = new Map((await tx.collection('career_applications').find({ id: { $in: rows.map((r) => r.application_id).filter(Boolean) } }, { projection: { code: 1 } })).map((a) => [a.id as string, a.code as string]));
      return { rows: rows.map((r) => ({
        id: r.id as string, direction: r.direction as string, status: r.status as string, attempts: r.attempts as number, externalId: r.external_id ?? null, applicationId: r.application_id ?? null,
        applicationCode: r.application_id ? codes.get(r.application_id) ?? null : null, lastError: r.last_error ?? null, lastStatusCode: r.last_status_code ?? null,
        nextAttemptAt: r.next_attempt_at ?? null, createdAt: r.created_at, doneAt: r.done_at ?? null, what: r.direction === 'outbound' ? `Status “${r.payload?.stage ?? ''}” to the website` : r.direction === 'cv' ? `${r.payload?.as === 'photo' ? 'Photo' : r.payload?.as === 'document' ? 'Document' : 'CV'} from the website` : 'Application from the website',
      })) };
    });
  }

  async retry(jobIds?: string[]) {
    const tenantId = await this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx);
      if (a.level !== 'super') throw Errors.forbiddenCode('career_super_only', 'Only Super Workspace retries the website sync');
      return requestContext.tenantActor().tenantId;
    });
    const r = await this.sync.retry(tenantId, jobIds);
    await this.db.tenant((tx) => this.audit.record(tx, { action: 'career_integration.retried', resourceType: 'career_integration', metadata: r }));
    return r;
  }
}
