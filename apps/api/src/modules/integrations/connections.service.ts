import { Inject, Injectable } from '@nestjs/common';
import type { SlackConnectionInput } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { decryptField, encryptField } from '../../platform/auth/crypto';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import { BY, WHO } from './common';
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
      r = await postJson(this.slackUrl(url), JSON.stringify({ text }), { 'user-agent': 'CREW/1.0' }, { allowPrivate: Boolean(this.config.SLACK_WEBHOOK_BASE_URL) || this.config.INTEGRATIONS_ALLOW_PRIVATE_URLS === 'true' });
    } catch (err) {
      throw new ConnectorError(`Could not reach Slack: ${(err as Error).message}`, true);
    }
    if (r.status >= 200 && r.status < 300) return r;
    // Slack answers 4xx with a short reason (for example no_service when the webhook was removed).
    const reason = r.body.trim().slice(0, 100) || `status ${r.status}`;
    throw new ConnectorError(`Slack refused the message (${reason})`, r.status === 429 || r.status >= 500);
  }

  async list() {
    return this.db.tenant((tx) =>
      many(
        tx,
        `select c.id, c.provider, c.name, c.display, c.status, c.status_reason as "statusReason", c.verified_at as "verifiedAt", c.last_used_at as "lastUsedAt",
                c.created_at as "createdAt", ${WHO('cu', 'ce')} as "createdBy"
           from integration_connections c ${BY('c.created_by_membership_id', 'c')} where c.status <> 'disconnected' order by c.name`,
      ),
    );
  }

  async logs(id: string) {
    return this.db.tenant(async (tx) => {
      if (!(await one(tx, 'select 1 from integration_connections where id = $1', [id]))) throw Errors.notFound('Connection');
      return many(tx, `select action, ok, detail, duration_ms as "durationMs", created_at as "createdAt" from integration_logs where connection_id = $1 order by created_at desc limit 100`, [id]);
    });
  }

  async connectSlack(input: SlackConnectionInput) {
    const workspace = await this.db.tenant((tx) => one<{ name: string }>(tx, 'select name from tenants where id = app_tenant_id()'));
    const started = Date.now();
    try {
      await this.postToSlack(input.webhookUrl, `CREW is now connected to this channel as "${input.name}" for ${workspace!.name}. Workflows can post here.`);
    } catch (err) {
      throw Errors.badRequest('slack_not_verified', `${(err as Error).message}. Check the webhook URL in Slack and try again; nothing was saved.`);
    }
    return this.db.tenant(async (tx) => {
      const c = (await one<{ id: string }>(
        tx,
        `insert into integration_connections (tenant_id, provider, name, credentials_enc, display, verified_at, created_by_membership_id)
         values (app_tenant_id(), 'slack', $1, $2, $3, now(), $4) returning id`,
        [input.name, encryptField(JSON.stringify({ webhookUrl: input.webhookUrl }), this.config.fieldKeys), JSON.stringify({ webhook: `…${input.webhookUrl.slice(-6)}` }), requestContext.tenantActor().membershipId],
      ))!;
      await tx.query(`insert into integration_logs (tenant_id, connection_id, action, ok, detail, duration_ms) values (app_tenant_id(), $1, 'connect', true, 'Confirmation message accepted by Slack', $2)`, [c.id, Date.now() - started]);
      await this.audit.record(tx, { action: 'integration.connected', resourceType: 'integration_connection', resourceId: c.id, metadata: { provider: 'slack', name: input.name } });
      return { id: c.id };
    });
  }

  async testSlack(id: string) {
    const r = await this.post(id, 'Test message from CREW. If you can read this, the connection works.', 'test');
    return { ok: true, durationMs: r.durationMs };
  }

  async disconnect(id: string) {
    await this.db.tenant(async (tx) => {
      const c = await one<{ name: string; status: string }>(tx, 'select name, status from integration_connections where id = $1', [id]);
      if (!c || c.status === 'disconnected') throw Errors.notFound('Connection');
      const used = await one<{ name: string }>(
        tx,
        `select w.name from workflows w join workflow_versions v on v.id = w.active_version_id
          where w.status = 'active' and exists (select 1 from jsonb_array_elements(v.definition->'steps') s where s->>'connectionId' = $1::text) limit 1`,
        [id],
      );
      if (used) throw Errors.conflict('connection_in_use', `The active workflow "${used.name}" posts through this connection. Pause it or change that step first.`);
      // The credentials are wiped, not just hidden.
      await tx.query(`update integration_connections set status = 'disconnected', credentials_enc = '', updated_at = now() where id = $1`, [id]);
      await this.audit.record(tx, { action: 'integration.disconnected', resourceType: 'integration_connection', resourceId: id, metadata: { name: c.name } });
    });
    return { ok: true };
  }

  /**
   * Posts a message through a Slack connection and logs the outcome. Used by "Send test message" and by workflow
   * steps (which run as the workflow's owner, inside their workspace).
   */
  async post(id: string, text: string, action = 'post'): Promise<{ durationMs: number }> {
    const c = await this.db.tenant((tx) => one<{ credentials_enc: string; status: string; provider: string }>(tx, 'select credentials_enc, status, provider from integration_connections where id = $1', [id]));
    if (!c || c.status === 'disconnected') throw new ConnectorError('The Slack connection no longer exists', false);
    const { webhookUrl } = JSON.parse(decryptField(c.credentials_enc, this.config.fieldKeys)) as { webhookUrl: string };
    const started = Date.now();
    try {
      await this.postToSlack(webhookUrl, text.slice(0, 3000));
      await this.db.tenant(async (tx) => {
        await tx.query(`update integration_connections set status = 'active', status_reason = null, last_used_at = now(), updated_at = now() where id = $1`, [id]);
        await tx.query(`insert into integration_logs (tenant_id, connection_id, action, ok, duration_ms) values (app_tenant_id(), $1, $2, true, $3)`, [id, action, Date.now() - started]);
      });
      return { durationMs: Date.now() - started };
    } catch (err) {
      const e = err as ConnectorError;
      await this.db.tenant(async (tx) => {
        await tx.query(`insert into integration_logs (tenant_id, connection_id, action, ok, detail, duration_ms) values (app_tenant_id(), $1, $2, false, $3, $4)`, [id, action, e.message.slice(0, 1000), Date.now() - started]);
        if (!e.retryable) await tx.query(`update integration_connections set status = 'error', status_reason = $2, updated_at = now() where id = $1`, [id, e.message.slice(0, 500)]);
      });
      if (action === 'test') throw Errors.badRequest('slack_failed', e.message);
      throw e;
    }
  }
}
