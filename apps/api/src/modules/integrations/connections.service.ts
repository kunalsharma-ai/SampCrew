import { Inject, Injectable } from '@nestjs/common';
import type { SlackConnectionInput } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { decryptField, encryptField } from '../../platform/auth/crypto';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { activeWorkflowUsing, membershipNames } from './common';
import { postJson } from './safe-http';

/** A Slack post that did not go through. `retryable` is false when trying again will not help (bad or removed webhook). */
export class ConnectorError extends Error {
  constructor(message: string, public readonly retryable: boolean) {
    super(message);
  }
}

/**
 * Connections to outside services. Slack is connected with an incoming webhook URL that the customer creates in
 * their own Slack workspace (Slack's documented way to post to one channel). The URL is a secret: it is
 * encrypted at rest and only its last characters are ever shown. Saving a connection posts a confirmation
 * message to the channel, so a connection is only shown as working once Slack has accepted a message.
 */
@Injectable()
export class ConnectionsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Tests may point Slack calls at a local stub; the config refuses that outside development and tests. */
  private slackUrl(url: string) {
    const base = this.config.SLACK_WEBHOOK_BASE_URL;
    return base ? url.replace('https://hooks.slack.com', base.replace(/\/$/, '')) : url;
  }

  private async postToSlack(url: string, text: string) {
    let r;
    try {
      r = await postJson(this.slackUrl(url), JSON.stringify({ text }), { 'user-agent': 'SampCrew/1.0' }, { allowPrivate: Boolean(this.config.SLACK_WEBHOOK_BASE_URL) || this.config.INTEGRATIONS_ALLOW_PRIVATE_URLS === 'true' });
    } catch (err) {
      throw new ConnectorError(`Could not reach Slack: ${(err as Error).message}`, true);
    }
    if (r.status >= 200 && r.status < 300) return r;
    // Slack answers 4xx with a short reason (for example no_service when the webhook was removed).
    const reason = r.body.trim().slice(0, 100) || `status ${r.status}`;
    throw new ConnectorError(`Slack refused the message (${reason})`, r.status === 429 || r.status >= 500);
  }

  async list() {
    return this.db.tenant(async (tx) => {
      const list = (await tx.collection('integration_connections').find({ status: { $ne: 'disconnected' } })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
      const names = await membershipNames(tx, list.map((c) => c.created_by_membership_id));
      return list.map((c) => ({
        id: c.id, provider: c.provider, name: c.name, display: c.display, status: c.status, statusReason: c.status_reason ?? null, verifiedAt: c.verified_at ?? null,
        lastUsedAt: c.last_used_at ?? null, createdAt: c.created_at, createdBy: names.get(c.created_by_membership_id)?.name ?? null,
      }));
    });
  }

  async logs(id: string) {
    return this.db.tenant(async (tx) => {
      if (!(await tx.collection('integration_connections').exists({ id }))) throw Errors.notFound('Connection');
      return (await tx.collection('integration_logs').find({ connection_id: id }, { sort: { created_at: -1 }, limit: 100 }))
        .map((l) => ({ action: l.action, ok: l.ok, detail: l.detail ?? null, durationMs: l.duration_ms ?? null, createdAt: l.created_at }));
    });
  }

  async connectSlack(input: SlackConnectionInput) {
    const workspace = await this.db.tenant((tx) => tx.collection('tenants').findOne({}, { projection: { name: 1 } }));
    const started = Date.now();
    try {
      await this.postToSlack(input.webhookUrl, `SampCrew is now connected to this channel as "${input.name}" for ${workspace!.name}. Workflows can post here.`);
    } catch (err) {
      throw Errors.badRequest('slack_not_verified', `${(err as Error).message}. Check the webhook URL in Slack and try again; nothing was saved.`);
    }
    return this.db.tenant(async (tx) => {
      const c = (await tx.collection('integration_connections').insert({
        provider: 'slack', name: input.name, credentials_enc: encryptField(JSON.stringify({ webhookUrl: input.webhookUrl }), this.config.fieldKeys),
        display: { webhook: `…${input.webhookUrl.slice(-6)}` }, verified_at: new Date(), created_by_membership_id: requestContext.tenantActor().membershipId,
      })) as { id: string };
      await tx.collection('integration_logs').insert({ connection_id: c.id, action: 'connect', ok: true, detail: 'Confirmation message accepted by Slack', duration_ms: Date.now() - started });
      await this.audit.record(tx, { action: 'integration.connected', resourceType: 'integration_connection', resourceId: c.id, metadata: { provider: 'slack', name: input.name } });
      return { id: c.id };
    });
  }

  async testSlack(id: string) {
    const r = await this.post(id, 'Test message from SampCrew. If you can read this, the connection works.', 'test');
    return { ok: true, durationMs: r.durationMs };
  }

  async disconnect(id: string) {
    await this.db.tenant(async (tx) => {
      const c = await tx.collection('integration_connections').findOne({ id });
      if (!c || c.status === 'disconnected') throw Errors.notFound('Connection');
      const used = await activeWorkflowUsing(tx, 'connectionId', id);
      if (used) throw Errors.conflict('connection_in_use', `The active workflow "${used}" posts through this connection. Pause it or change that step first.`);
      // The credentials are wiped, not just hidden.
      await tx.collection('integration_connections').updateOne({ id }, { $set: { status: 'disconnected', credentials_enc: '', updated_at: new Date() } });
      await this.audit.record(tx, { action: 'integration.disconnected', resourceType: 'integration_connection', resourceId: id, metadata: { name: c.name } });
    });
    return { ok: true };
  }

  /**
   * Posts a message through a Slack connection and logs the outcome. Used by "Send test message" and by workflow
   * steps (which run as the workflow's owner, inside their workspace).
   */
  async post(id: string, text: string, action = 'post'): Promise<{ durationMs: number }> {
    const c = (await this.db.tenant((tx) => tx.collection('integration_connections').findOne({ id }))) as { credentials_enc: string; status: string; provider: string } | undefined;
    if (!c || c.status === 'disconnected') throw new ConnectorError('The Slack connection no longer exists', false);
    const { webhookUrl } = JSON.parse(decryptField(c.credentials_enc, this.config.fieldKeys)) as { webhookUrl: string };
    const started = Date.now();
    try {
      await this.postToSlack(webhookUrl, text.slice(0, 3000));
      await this.db.tenant(async (tx) => {
        const now = new Date();
        await tx.collection('integration_connections').updateOne({ id }, { $set: { status: 'active', status_reason: null, last_used_at: now, updated_at: now } });
        await tx.collection('integration_logs').insert({ connection_id: id, action, ok: true, duration_ms: Date.now() - started });
      });
      return { durationMs: Date.now() - started };
    } catch (err) {
      const e = err as ConnectorError;
      await this.db.tenant(async (tx) => {
        await tx.collection('integration_logs').insert({ connection_id: id, action, ok: false, detail: e.message.slice(0, 1000), duration_ms: Date.now() - started });
        if (!e.retryable) await tx.collection('integration_connections').updateOne({ id }, { $set: { status: 'error', status_reason: e.message.slice(0, 500), updated_at: new Date() } });
      });
      if (action === 'test') throw Errors.badRequest('slack_failed', e.message);
      throw e;
    }
  }
}
