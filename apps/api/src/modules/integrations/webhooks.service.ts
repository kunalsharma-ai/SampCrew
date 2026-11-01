import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  WEBHOOK_DISABLE_AFTER, WEBHOOK_EVENT_TYPES, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_DELAYS_S, WEBHOOK_TEST_EVENT, type WebhookEndpointInput, webhookBody,
} from '@crew/contracts';
import { createHmac, randomUUID } from 'node:crypto';
import { AuditService } from '../../platform/audit/audit.service';
import { decryptField, encryptField, randomToken } from '../../platform/auth/crypto';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { type DomainEvent, OutboxService } from '../../platform/events/outbox.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { BY, WHO } from './common';
import { checkUrlShape, postJson } from './safe-http';

/** The signature header: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the endpoint's secret>. */
export function signWebhook(secret: string, timestamp: number, body: string) {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

interface Claimed {
  id: string;
  tenant_id: string;
  endpoint_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  url: string;
  secret_enc: string;
  name: string;
  created_by_membership_id: string;
}

/**
 * Outgoing webhooks. Each workspace event in the public catalogue becomes one delivery per subscribed endpoint
 * (idempotent per event). A loop claims due deliveries, signs and posts them outside any transaction, and records
 * each attempt. Failures are retried on a fixed back-off (about 13 hours in all); an endpoint failing many times in
 * a row is disabled and its creator told. Payloads carry ids only.
 */
@Injectable()
export class WebhooksService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Webhooks');
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private get allowPrivate() {
    return this.config.INTEGRATIONS_ALLOW_PRIVATE_URLS === 'true';
  }

  onModuleInit() {
    for (const type of WEBHOOK_EVENT_TYPES) if (type !== 'workflow.webhook') this.outbox.subscribe(type, async (e) => { await this.onEvent(e); });
  }

  onApplicationBootstrap() {
    if (this.config.CREW_DISABLE_DISPATCHER === 'true' || this.config.CREW_ENV === 'test') return;
    this.timer = setInterval(() => void this.runDue().catch((err: Error) => this.logger.error(`Webhook tick failed: ${err.message}`)), 2000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // Endpoints ------------------------------------------------------------------------------------------------------

  private checkUrl(url: string) {
    const problem = checkUrlShape(url, this.allowPrivate);
    if (problem) throw Errors.validation([{ path: 'url', message: problem }]);
  }

  async list() {
    return this.db.tenant((tx) =>
      many(
        tx,
        `select w.id, w.name, w.url, w.events, w.status, w.status_reason as "statusReason", w.consecutive_failures as "consecutiveFailures",
                w.created_at as "createdAt", ${WHO('cu', 'ce')} as "createdBy",
                (select count(*) from webhook_deliveries d where d.endpoint_id = w.id and d.created_at > now() - interval '7 days')::int as "deliveries7d",
                (select count(*) from webhook_deliveries d where d.endpoint_id = w.id and d.status = 'failed' and d.created_at > now() - interval '7 days')::int as "failed7d",
                (select max(d.delivered_at) from webhook_deliveries d where d.endpoint_id = w.id) as "lastDeliveredAt"
           from webhook_endpoints w ${BY('w.created_by_membership_id', 'c')} order by w.name`,
      ),
    );
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      const w = await one(
        tx,
        `select w.id, w.name, w.url, w.events, w.status, w.status_reason as "statusReason", w.consecutive_failures as "consecutiveFailures",
                w.created_at as "createdAt", w.updated_at as "updatedAt", ${WHO('cu', 'ce')} as "createdBy"
           from webhook_endpoints w ${BY('w.created_by_membership_id', 'c')} where w.id = $1`,
        [id],
      );
      if (!w) throw Errors.notFound('Webhook endpoint');
      return w;
    });
  }

  async create(input: WebhookEndpointInput) {
    this.checkUrl(input.url);
    const secret = `whsec_${randomToken(24)}`;
    const id = await this.db.tenant(async (tx) => {
      const r = (await one<{ id: string }>(
        tx,
        `insert into webhook_endpoints (tenant_id, name, url, events, secret_enc, created_by_membership_id) values (app_tenant_id(), $1, $2, $3, $4, $5) returning id`,
        [input.name, input.url, input.events, encryptField(secret, this.config.FIELD_ENCRYPTION_KEY), requestContext.tenantActor().membershipId],
      ))!;
      await this.audit.record(tx, { action: 'webhook.created', resourceType: 'webhook_endpoint', resourceId: r.id, metadata: { name: input.name, host: new URL(input.url).host, events: input.events } });
      return r.id;
    });
    // The signing secret is returned this once; it can be replaced later but never shown again.
    return { ...(await this.get(id)), secret };
  }

  async update(id: string, input: WebhookEndpointInput) {
    this.checkUrl(input.url);
    await this.db.tenant(async (tx) => {
      const w = await one<{ url: string }>(tx, 'select url from webhook_endpoints where id = $1', [id]);
      if (!w) throw Errors.notFound('Webhook endpoint');
      await tx.query('update webhook_endpoints set name = $2, url = $3, events = $4, updated_at = now() where id = $1', [id, input.name, input.url, input.events]);
      await this.audit.record(tx, { action: 'webhook.updated', resourceType: 'webhook_endpoint', resourceId: id, metadata: { name: input.name, host: new URL(input.url).host, events: input.events, urlChanged: w.url !== input.url } });
    });
    return this.get(id);
  }

  async setStatus(id: string, status: 'active' | 'paused') {
    await this.db.tenant(async (tx) => {
      const w = await one<{ status: string }>(tx, 'select status from webhook_endpoints where id = $1', [id]);
      if (!w) throw Errors.notFound('Webhook endpoint');
      await tx.query(`update webhook_endpoints set status = $2, status_reason = null, consecutive_failures = case when $2 = 'active' then 0 else consecutive_failures end, updated_at = now() where id = $1`, [id, status]);
      // Deliveries that were waiting resume from now when the endpoint is switched back on.
      if (status === 'active') await tx.query(`update webhook_deliveries set next_attempt_at = now() where endpoint_id = $1 and status = 'pending'`, [id]);
      await this.audit.record(tx, { action: status === 'active' ? 'webhook.enabled' : 'webhook.paused', resourceType: 'webhook_endpoint', resourceId: id });
    });
    return this.get(id);
  }

  async rotateSecret(id: string) {
    const secret = `whsec_${randomToken(24)}`;
    await this.db.tenant(async (tx) => {
      const r = await tx.query('update webhook_endpoints set secret_enc = $2, updated_at = now() where id = $1', [id, encryptField(secret, this.config.FIELD_ENCRYPTION_KEY)]);
      if (!r.rowCount) throw Errors.notFound('Webhook endpoint');
      await this.audit.record(tx, { action: 'webhook.secret_rotated', resourceType: 'webhook_endpoint', resourceId: id });
    });
    return { secret };
  }

  async remove(id: string) {
    await this.db.tenant(async (tx) => {
      const w = await one<{ name: string }>(tx, 'select name from webhook_endpoints where id = $1', [id]);
      if (!w) throw Errors.notFound('Webhook endpoint');
      const used = await one<{ name: string }>(
        tx,
        `select w.name from workflows w join workflow_versions v on v.id = w.active_version_id
          where w.status = 'active' and exists (select 1 from jsonb_array_elements(v.definition->'steps') s where s->>'endpointId' = $1::text) limit 1`,
        [id],
      );
      if (used) throw Errors.conflict('endpoint_in_use', `The active workflow "${used.name}" sends to this endpoint. Pause it or change that step first.`);
      await tx.query('delete from webhook_endpoints where id = $1', [id]);
      await this.audit.record(tx, { action: 'webhook.deleted', resourceType: 'webhook_endpoint', resourceId: id, metadata: { name: w.name } });
    });
    return { ok: true };
  }

  async test(id: string) {
    return this.db.tenant(async (tx) => {
      const w = await one<{ status: string }>(tx, 'select status from webhook_endpoints where id = $1', [id]);
      if (!w) throw Errors.notFound('Webhook endpoint');
      if (w.status !== 'active') throw Errors.conflict('endpoint_not_active', 'Switch the endpoint on before sending a test event.');
      const tenantId = requestContext.tenantActor().tenantId;
      const eventId = randomUUID();
      const deliveryId = await this.enqueue(tx, id, eventId, WEBHOOK_TEST_EVENT, webhookBody({ id: eventId, type: WEBHOOK_TEST_EVENT, occurredAt: new Date().toISOString(), tenantId, payload: { message: 'Test event from CREW' } }));
      return { deliveryId };
    });
  }

  // Deliveries -----------------------------------------------------------------------------------------------------

  async deliveries(endpointId: string, q: { status?: string }) {
    return this.db.tenant((tx) =>
      many(
        tx,
        `select id, event_id as "eventId", event_type as "eventType", status, attempts, next_attempt_at as "nextAttemptAt", last_status_code as "lastStatusCode",
                last_error as "lastError", last_duration_ms as "lastDurationMs", delivered_at as "deliveredAt", created_at as "createdAt"
           from webhook_deliveries where endpoint_id = $1 and ($2::text is null or status = $2) order by created_at desc limit 200`,
        [endpointId, q.status ?? null],
      ),
    );
  }

  async delivery(id: string) {
    return this.db.tenant(async (tx) => {
      const d = await one(
        tx,
        `select d.id, d.endpoint_id as "endpointId", w.name as "endpointName", w.url, d.event_id as "eventId", d.event_type as "eventType", d.payload, d.status, d.attempts,
                d.next_attempt_at as "nextAttemptAt", d.delivered_at as "deliveredAt", d.created_at as "createdAt", d.last_error as "lastError"
           from webhook_deliveries d join webhook_endpoints w on w.id = d.endpoint_id where d.id = $1`,
        [id],
      );
      if (!d) throw Errors.notFound('Delivery');
      const attemptLog = await many(
        tx,
        `select attempt, status_code as "statusCode", ok, error, response, duration_ms as "durationMs", created_at as "createdAt" from webhook_attempts where delivery_id = $1 order by attempt`,
        [id],
      );
      return { ...d, attemptLog, maxAttempts: WEBHOOK_MAX_ATTEMPTS };
    });
  }

  async redeliver(id: string) {
    await this.db.tenant(async (tx) => {
      const d = await one<{ status: string; endpoint_status: string }>(tx, `select d.status, w.status as endpoint_status from webhook_deliveries d join webhook_endpoints w on w.id = d.endpoint_id where d.id = $1`, [id]);
      if (!d) throw Errors.notFound('Delivery');
      if (d.status === 'pending' || d.status === 'sending') throw Errors.conflict('delivery_pending', 'This delivery is still being tried.');
      if (d.endpoint_status !== 'active') throw Errors.conflict('endpoint_not_active', 'Switch the endpoint on before sending again.');
      await tx.query(`update webhook_deliveries set status = 'pending', next_attempt_at = now(), locked_until = null, updated_at = now() where id = $1`, [id]);
      await this.audit.record(tx, { action: 'webhook.redelivered', resourceType: 'webhook_delivery', resourceId: id });
    });
    return this.delivery(id);
  }

  /** Queues one delivery (once per endpoint and event). Used for catalogue events, tests and workflow steps. */
  async enqueue(tx: Tx, endpointId: string, eventId: string, type: string, payload: Record<string, unknown>): Promise<string | null> {
    const r = await one<{ id: string }>(
      tx,
      `insert into webhook_deliveries (tenant_id, endpoint_id, event_id, event_type, payload) values (app_tenant_id(), $1, $2, $3, $4)
       on conflict (endpoint_id, event_id) do nothing returning id`,
      [endpointId, eventId, type, JSON.stringify(payload)],
    );
    return r?.id ?? null;
  }

  async onEvent(e: DomainEvent) {
    if (!e.tenantId) return;
    const tenantId = e.tenantId;
    await this.db.tenant(async (tx) => {
      const endpoints = await many<{ id: string }>(
        tx,
        // An endpoint only receives events that happened after it was created.
        `select id from webhook_endpoints where status = 'active' and $1 = any(events) and created_at <= $2::timestamptz`,
        [e.type, e.occurredAt],
      );
      if (!endpoints.length) return;
      const body = webhookBody({ ...e, tenantId });
      for (const w of endpoints) await this.enqueue(tx, w.id, e.id, e.type, body);
    }, { tenantId });
  }

  /** Claims due deliveries across workspaces and sends them. Exposed for tests. */
  async runDue(limit = 20): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const claimed = await this.db.platform((tx) =>
        many<Claimed>(
          tx,
          `update webhook_deliveries d set status = 'sending', locked_until = now() + interval '60 seconds', attempts = d.attempts + 1, updated_at = now()
             from webhook_endpoints w
            where d.id in (select x.id from webhook_deliveries x join webhook_endpoints y on y.id = x.endpoint_id
                            where y.status = 'active' and ((x.status = 'pending' and x.next_attempt_at <= now()) or (x.status = 'sending' and x.locked_until < now()))
                            order by x.next_attempt_at limit $1 for update of x skip locked)
              and w.id = d.endpoint_id
          returning d.id, d.tenant_id, d.endpoint_id, d.event_type, d.payload, d.attempts, w.url, w.secret_enc, w.name, w.created_by_membership_id`,
          [limit],
        ),
      );
      await Promise.all(claimed.map((c) => this.send(c)));
      return claimed.length;
    } finally {
      this.ticking = false;
    }
  }

  private async send(c: Claimed) {
    const body = JSON.stringify(c.payload);
    const ts = Math.floor(Date.now() / 1000);
    let status: number | null = null;
    let response = '';
    let error: string | null = null;
    let durationMs = 0;
    const started = Date.now();
    try {
      const secret = decryptField(c.secret_enc, this.config.FIELD_ENCRYPTION_KEY);
      const r = await postJson(c.url, body, {
        'user-agent': 'CREW-Webhooks/1.0',
        'crew-event': c.event_type,
        'crew-delivery': c.id,
        'crew-signature': signWebhook(secret, ts, body),
      }, { allowPrivate: this.allowPrivate });
      status = r.status;
      response = r.body;
      durationMs = r.durationMs;
      if (status < 200 || status >= 300) error = `The endpoint answered ${status}`;
    } catch (err) {
      durationMs = Date.now() - started;
      error = (err as Error).message.slice(0, 500) || 'Could not connect';
    }
    const ok = error === null;
    await this.db.tenant(async (tx) => {
      await tx.query(
        `insert into webhook_attempts (tenant_id, delivery_id, attempt, status_code, ok, error, response, duration_ms) values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7)
         on conflict (delivery_id, attempt) do nothing`,
        [c.id, c.attempts, status, ok, error, response || null, durationMs],
      );
      if (ok) {
        await tx.query(
          `update webhook_deliveries set status = 'succeeded', delivered_at = now(), locked_until = null, next_attempt_at = null, last_status_code = $2, last_error = null,
                  last_response = $3, last_duration_ms = $4, updated_at = now() where id = $1`,
          [c.id, status, response || null, durationMs],
        );
        await tx.query('update webhook_endpoints set consecutive_failures = 0 where id = $1', [c.endpoint_id]);
        return;
      }
      const final = c.attempts >= WEBHOOK_MAX_ATTEMPTS;
      await tx.query(
        `update webhook_deliveries set status = $2, locked_until = null, next_attempt_at = case when $2 = 'pending' then now() + make_interval(secs => $3) end,
                last_status_code = $4, last_error = $5, last_response = $6, last_duration_ms = $7, updated_at = now() where id = $1`,
        [c.id, final ? 'failed' : 'pending', WEBHOOK_RETRY_DELAYS_S[Math.min(c.attempts, WEBHOOK_RETRY_DELAYS_S.length) - 1] ?? 0, status, error, response || null, durationMs],
      );
      const w = (await one<{ consecutive_failures: number; status: string }>(
        tx, 'update webhook_endpoints set consecutive_failures = consecutive_failures + 1 where id = $1 returning consecutive_failures, status', [c.endpoint_id],
      ))!;
      if (w.status === 'active' && w.consecutive_failures >= WEBHOOK_DISABLE_AFTER) {
        const reason = `Switched off after ${w.consecutive_failures} failed attempts in a row. Last error: ${error}`.slice(0, 500);
        await tx.query(`update webhook_endpoints set status = 'disabled', status_reason = $2, updated_at = now() where id = $1`, [c.endpoint_id, reason]);
        await this.audit.record(tx, { action: 'webhook.disabled', resourceType: 'webhook_endpoint', resourceId: c.endpoint_id, metadata: { failures: w.consecutive_failures }, tenantId: c.tenant_id });
        await this.notifications.notify(tx, {
          membershipIds: [c.created_by_membership_id], kind: 'webhook.disabled', title: `Webhook "${c.name}" was switched off`,
          body: reason, link: `/settings/integrations/webhooks/${c.endpoint_id}`,
        });
      }
    }, { tenantId: c.tenant_id });
  }
}
