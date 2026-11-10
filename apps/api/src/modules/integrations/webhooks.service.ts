import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  WEBHOOK_DISABLE_AFTER, WEBHOOK_EVENT_TYPES, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_DELAYS_S, WEBHOOK_TEST_EVENT, type WebhookEndpointInput, webhookBody,
} from '@crew/contracts';
import { createHmac, randomUUID } from 'node:crypto';
import { AuditService } from '../../platform/audit/audit.service';
import { decryptField, encryptField, randomToken } from '../../platform/auth/crypto';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx as Tx } from '../../platform/database/mongo.service';
import { type DomainEvent, OutboxService } from '../../platform/events/outbox.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { activeWorkflowUsing, membershipNames } from './common';
import { checkUrlShape, postJson } from './safe-http';

/** The signature header: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the endpoint's secret>. */
export function signWebhook(secret: string, timestamp: number, body: string) {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

async function endpointViews(tx: Tx, list: Doc[]) {
  const names = await membershipNames(tx, list.map((w) => w.created_by_membership_id));
  return list.map((w) => ({
    id: w.id, name: w.name, url: w.url, events: w.events, status: w.status, statusReason: w.status_reason ?? null, consecutiveFailures: w.consecutive_failures,
    createdAt: w.created_at, updatedAt: w.updated_at, createdBy: names.get(w.created_by_membership_id)?.name ?? null,
  }));
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
    return this.db.tenant(async (tx) => {
      const list = (await tx.collection('webhook_endpoints').find({})).sort((a, b) => String(a.name).localeCompare(String(b.name)));
      const ids = list.map((w) => w.id);
      const week = new Date(Date.now() - 7 * 86_400_000);
      const recent = await tx.collection('webhook_deliveries').find({ endpoint_id: { $in: ids }, created_at: { $gt: week } }, { projection: { endpoint_id: 1, status: 1 } });
      const last = await tx.collection('webhook_deliveries').aggregate<{ id: string; at: Date }>([
        { $match: { endpoint_id: { $in: ids }, delivered_at: { $ne: null } } }, { $group: { _id: '$endpoint_id', at: { $max: '$delivered_at' } } },
      ]);
      const lastAt = new Map(last.map((x) => [x.id, x.at]));
      return (await endpointViews(tx, list)).map(({ updatedAt: _u, ...w }) => ({
        ...w,
        deliveries7d: recent.filter((d) => d.endpoint_id === w.id).length,
        failed7d: recent.filter((d) => d.endpoint_id === w.id && d.status === 'failed').length,
        lastDeliveredAt: lastAt.get(w.id) ?? null,
      }));
    });
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      const w = await tx.collection('webhook_endpoints').findOne({ id });
      if (!w) throw Errors.notFound('Webhook endpoint');
      return (await endpointViews(tx, [w]))[0]!;
    });
  }

  async create(input: WebhookEndpointInput) {
    this.checkUrl(input.url);
    const secret = `whsec_${randomToken(24)}`;
    const id = await this.db.tenant(async (tx) => {
      const r = (await tx.collection('webhook_endpoints').insert({
        name: input.name, url: input.url, events: input.events, secret_enc: encryptField(secret, this.config.fieldKeys), created_by_membership_id: requestContext.tenantActor().membershipId,
      })) as { id: string };
      await this.audit.record(tx, { action: 'webhook.created', resourceType: 'webhook_endpoint', resourceId: r.id, metadata: { name: input.name, host: new URL(input.url).host, events: input.events } });
      return r.id;
    });
    // The signing secret is returned this once; it can be replaced later but never shown again.
    return { ...(await this.get(id)), secret };
  }

  async update(id: string, input: WebhookEndpointInput) {
    this.checkUrl(input.url);
    await this.db.tenant(async (tx) => {
      const w = await tx.collection('webhook_endpoints').findOne({ id });
      if (!w) throw Errors.notFound('Webhook endpoint');
      await tx.collection('webhook_endpoints').updateOne({ id }, { $set: { name: input.name, url: input.url, events: input.events, updated_at: new Date() } });
      await this.audit.record(tx, { action: 'webhook.updated', resourceType: 'webhook_endpoint', resourceId: id, metadata: { name: input.name, host: new URL(input.url).host, events: input.events, urlChanged: w.url !== input.url } });
    });
    return this.get(id);
  }

  async setStatus(id: string, status: 'active' | 'paused') {
    await this.db.tenant(async (tx) => {
      const w = await tx.collection('webhook_endpoints').findOne({ id });
      if (!w) throw Errors.notFound('Webhook endpoint');
      await tx.collection('webhook_endpoints').updateOne({ id }, { $set: { status, status_reason: null, updated_at: new Date(), ...(status === 'active' ? { consecutive_failures: 0 } : {}) } });
      // Deliveries that were waiting resume from now when the endpoint is switched back on.
      if (status === 'active') await tx.collection('webhook_deliveries').update({ endpoint_id: id, status: 'pending' }, { $set: { next_attempt_at: new Date() } });
      await this.audit.record(tx, { action: status === 'active' ? 'webhook.enabled' : 'webhook.paused', resourceType: 'webhook_endpoint', resourceId: id });
    });
    return this.get(id);
  }

  async rotateSecret(id: string) {
    const secret = `whsec_${randomToken(24)}`;
    await this.db.tenant(async (tx) => {
      const n = await tx.collection('webhook_endpoints').update({ id }, { $set: { secret_enc: encryptField(secret, this.config.fieldKeys), updated_at: new Date() } });
      if (!n) throw Errors.notFound('Webhook endpoint');
      await this.audit.record(tx, { action: 'webhook.secret_rotated', resourceType: 'webhook_endpoint', resourceId: id });
    });
    return { secret };
  }

  async remove(id: string) {
    await this.db.tenant(async (tx) => {
      const w = await tx.collection('webhook_endpoints').findOne({ id });
      if (!w) throw Errors.notFound('Webhook endpoint');
      const used = await activeWorkflowUsing(tx, 'endpointId', id);
      if (used) throw Errors.conflict('endpoint_in_use', `The active workflow "${used}" sends to this endpoint. Pause it or change that step first.`);
      await tx.collection('webhook_endpoints').deleteOne({ id });
      await this.audit.record(tx, { action: 'webhook.deleted', resourceType: 'webhook_endpoint', resourceId: id, metadata: { name: w.name } });
    });
    return { ok: true };
  }

  async test(id: string) {
    return this.db.tenant(async (tx) => {
      const w = await tx.collection('webhook_endpoints').findOne({ id });
      if (!w) throw Errors.notFound('Webhook endpoint');
      if (w.status !== 'active') throw Errors.conflict('endpoint_not_active', 'Switch the endpoint on before sending a test event.');
      const tenantId = requestContext.tenantActor().tenantId;
      const eventId = randomUUID();
      const deliveryId = await this.enqueue(tx, id, eventId, WEBHOOK_TEST_EVENT, webhookBody({ id: eventId, type: WEBHOOK_TEST_EVENT, occurredAt: new Date().toISOString(), tenantId, payload: { message: 'Test event from SampCrew' } }));
      return { deliveryId };
    });
  }

  // Deliveries -----------------------------------------------------------------------------------------------------

  async deliveries(endpointId: string, q: { status?: string }) {
    return this.db.tenant(async (tx) =>
      (await tx.collection('webhook_deliveries').find({ endpoint_id: endpointId, ...(q.status ? { status: q.status } : {}) }, { sort: { created_at: -1 }, limit: 200 })).map((d) => ({
        id: d.id, eventId: d.event_id, eventType: d.event_type, status: d.status, attempts: d.attempts, nextAttemptAt: d.next_attempt_at ?? null,
        lastStatusCode: d.last_status_code ?? null, lastError: d.last_error ?? null, lastDurationMs: d.last_duration_ms ?? null, deliveredAt: d.delivered_at ?? null, createdAt: d.created_at,
      })),
    );
  }

  async delivery(id: string) {
    return this.db.tenant(async (tx) => {
      const doc = await tx.collection('webhook_deliveries').findOne({ id });
      const w = doc && (await tx.collection('webhook_endpoints').findOne({ id: doc.endpoint_id }));
      if (!doc || !w) throw Errors.notFound('Delivery');
      const d = {
        id: doc.id, endpointId: doc.endpoint_id, endpointName: w.name, url: w.url, eventId: doc.event_id, eventType: doc.event_type, payload: doc.payload, status: doc.status,
        attempts: doc.attempts, nextAttemptAt: doc.next_attempt_at ?? null, deliveredAt: doc.delivered_at ?? null, createdAt: doc.created_at, lastError: doc.last_error ?? null,
      };
      const attemptLog = (await tx.collection('webhook_attempts').find({ delivery_id: id }, { sort: { attempt: 1 } })).map((a) => ({
        attempt: a.attempt, statusCode: a.status_code ?? null, ok: a.ok, error: a.error ?? null, response: a.response ?? null, durationMs: a.duration_ms ?? null, createdAt: a.created_at,
      }));
      return { ...d, attemptLog, maxAttempts: WEBHOOK_MAX_ATTEMPTS };
    });
  }

  async redeliver(id: string) {
    await this.db.tenant(async (tx) => {
      const d = await tx.collection('webhook_deliveries').findOne({ id });
      const w = d && (await tx.collection('webhook_endpoints').findOne({ id: d.endpoint_id }));
      if (!d || !w) throw Errors.notFound('Delivery');
      if (d.status === 'pending' || d.status === 'sending') throw Errors.conflict('delivery_pending', 'This delivery is still being tried.');
      if (w.status !== 'active') throw Errors.conflict('endpoint_not_active', 'Switch the endpoint on before sending again.');
      const now = new Date();
      await tx.collection('webhook_deliveries').updateOne({ id }, { $set: { status: 'pending', next_attempt_at: now, locked_until: null, updated_at: now } });
      await this.audit.record(tx, { action: 'webhook.redelivered', resourceType: 'webhook_delivery', resourceId: id });
    });
    return this.delivery(id);
  }

  /** Queues one delivery (once per endpoint and event). Used for catalogue events, tests and workflow steps. */
  async enqueue(tx: Tx, endpointId: string, eventId: string, type: string, payload: Record<string, unknown>): Promise<string | null> {
    const deliveries = tx.collection('webhook_deliveries');
    if (await deliveries.exists({ endpoint_id: endpointId, event_id: eventId })) return null;
    const r = await deliveries.insert({ endpoint_id: endpointId, event_id: eventId, event_type: type, payload: JSON.parse(JSON.stringify(payload)) });
    return r.id as string;
  }

  async onEvent(e: DomainEvent) {
    if (!e.tenantId) return;
    const tenantId = e.tenantId;
    await this.db.tenant(async (tx) => {
      // An endpoint only receives events that happened after it was created.
      const endpoints = await tx.collection('webhook_endpoints').find({ status: 'active', events: e.type, created_at: { $lte: new Date(e.occurredAt) } }, { projection: { _id: 1 } });
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
      const due = () => ({ $or: [{ status: 'pending', next_attempt_at: { $lte: new Date() } }, { status: 'sending', locked_until: { $lt: new Date() } }] });
      const candidates = await this.db.platform(async (tx) => {
        const list = await tx.collection('webhook_deliveries').find(due(), { sort: { next_attempt_at: 1 }, limit: limit * 5, projection: { endpoint_id: 1 } });
        const active = new Set(await tx.collection('webhook_endpoints').distinct<string>('id', { id: { $in: [...new Set(list.map((d) => d.endpoint_id as string))] }, status: 'active' }));
        return list.filter((d) => active.has(d.endpoint_id)).slice(0, limit);
      });
      // Each delivery is claimed on its own: one another worker took first no longer matches and is skipped.
      const claimed: Claimed[] = [];
      for (const c of candidates) {
        const got = await this.db.platform(async (tx) => {
          const d = await tx.collection('webhook_deliveries').updateAndGet(
            { id: c.id, ...due() },
            { $set: { status: 'sending', locked_until: new Date(Date.now() + 60_000), updated_at: new Date() }, $inc: { attempts: 1 } },
          );
          if (!d) return null;
          const w = (await tx.collection('webhook_endpoints').findOne({ id: d.endpoint_id }))!;
          return {
            id: d.id, tenant_id: d.tenant_id, endpoint_id: d.endpoint_id, event_type: d.event_type, payload: d.payload, attempts: d.attempts,
            url: w.url, secret_enc: w.secret_enc, name: w.name, created_by_membership_id: w.created_by_membership_id,
          } as Claimed;
        }).catch(() => null);
        if (got) claimed.push(got);
      }
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
      const secret = decryptField(c.secret_enc, this.config.fieldKeys);
      const r = await postJson(c.url, body, {
        'user-agent': 'SampCrew-Webhooks/1.0',
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
      if (!(await tx.collection('webhook_attempts').exists({ delivery_id: c.id, attempt: c.attempts }))) {
        await tx.collection('webhook_attempts').insert({ delivery_id: c.id, attempt: c.attempts, status_code: status, ok, error, response: response || null, duration_ms: durationMs });
      }
      const now = new Date();
      if (ok) {
        await tx.collection('webhook_deliveries').updateOne({ id: c.id }, { $set: {
          status: 'succeeded', delivered_at: now, locked_until: null, next_attempt_at: null, last_status_code: status, last_error: null,
          last_response: response || null, last_duration_ms: durationMs, updated_at: now,
        } });
        await tx.collection('webhook_endpoints').updateOne({ id: c.endpoint_id }, { $set: { consecutive_failures: 0 } });
        return;
      }
      const final = c.attempts >= WEBHOOK_MAX_ATTEMPTS;
      const delayS = WEBHOOK_RETRY_DELAYS_S[Math.min(c.attempts, WEBHOOK_RETRY_DELAYS_S.length) - 1] ?? 0;
      await tx.collection('webhook_deliveries').updateOne({ id: c.id }, { $set: {
        status: final ? 'failed' : 'pending', locked_until: null, next_attempt_at: final ? null : new Date(now.getTime() + delayS * 1000),
        last_status_code: status, last_error: error, last_response: response || null, last_duration_ms: durationMs, updated_at: now,
      } });
      const w = (await tx.collection('webhook_endpoints').updateAndGet({ id: c.endpoint_id }, { $inc: { consecutive_failures: 1 } }))! as { consecutive_failures: number; status: string };
      if (w.status === 'active' && w.consecutive_failures >= WEBHOOK_DISABLE_AFTER) {
        const reason = `Switched off after ${w.consecutive_failures} failed attempts in a row. Last error: ${error}`.slice(0, 500);
        await tx.collection('webhook_endpoints').updateOne({ id: c.endpoint_id }, { $set: { status: 'disabled', status_reason: reason, updated_at: new Date() } });
        await this.audit.record(tx, { action: 'webhook.disabled', resourceType: 'webhook_endpoint', resourceId: c.endpoint_id, metadata: { failures: w.consecutive_failures }, tenantId: c.tenant_id });
        await this.notifications.notify(tx, {
          membershipIds: [c.created_by_membership_id], kind: 'webhook.disabled', title: `Webhook "${c.name}" was switched off`,
          body: reason, link: `/settings/integrations/webhooks/${c.endpoint_id}`,
        });
      }
    }, { tenantId: c.tenant_id });
  }
}
