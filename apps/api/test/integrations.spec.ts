import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkflowRunnerService } from '../src/modules/automation/workflow-runner.service';
import { checkUrlShape, isPrivateAddress, postJson, safeLookup, UnsafeUrlError } from '../src/modules/integrations/safe-http';
import { WebhooksService } from '../src/modules/integrations/webhooks.service';
import { OutboxService } from '../src/platform/events/outbox.service';
import { addMember, adminPool, api, createApp, createTenant, login, loginWithMfa, type TestDb, type TestTenant } from './helpers';

/** A local HTTP receiver that answers with whatever the test sets, and keeps every request. */
function receiver() {
  const got: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];
  let answer = { status: 200, body: 'ok' };
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      got.push({ url: req.url ?? '', headers: req.headers, body: raw });
      const slackGone = req.url?.includes('/services/T000/B000/gone');
      res.statusCode = slackGone ? 404 : answer.status;
      res.end(slackGone ? 'no_service' : answer.body);
    });
  });
  return { server, got, set: (status: number, body = 'x') => { answer = { status, body }; }, base: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const verify = (secret: string, header: string, body: string) => {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!m) return false;
  return createHmac('sha256', secret).update(`${m[1]}.${body}`).digest('hex') === m[2];
};

describe('Integrations: API keys, webhooks and Slack', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let other: TestTenant;
  let pro: TestTenant;
  let hook: ReturnType<typeof receiver>;
  let slack: ReturnType<typeof receiver>;
  let outbox: OutboxService;
  let webhooks: WebhooksService;
  let runner: WorkflowRunnerService;
  const tokens: Record<string, string> = {};
  const people: Record<string, { email: string; membershipId: string }> = {};
  const ids: Record<string, string> = {};
  const as = (who: string) => api(app, tokens[who]);
  const ok = (res: { status: number; body: unknown }, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as Record<string, any>;
  };
  const fails = (res: { status: number; body: any }, status: number, code?: string) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    if (code) expect(res.body.error.code).toBe(code);
    return res.body;
  };
  const hire = async (first: string) =>
    ok(await as('owner').post('/employees').send({ legalEntityId: t.legalEntityId, firstName: first, lastName: 'Test', dateOfJoining: '2024-01-01', probationMonths: 0, onboardingTemplateId: null }), 201).employee.id as string;

  beforeAll(async () => {
    hook = receiver();
    slack = receiver();
    await new Promise<void>((r) => hook.server.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => slack.server.listen(0, '127.0.0.1', r));
    process.env.SLACK_WEBHOOK_BASE_URL = slack.base();
    app = await createApp();
    pool = adminPool();
    outbox = app.get(OutboxService);
    webhooks = app.get(WebhooksService);
    runner = app.get(WorkflowRunnerService);
    t = await createTenant(pool);
    other = await createTenant(pool);
    pro = await createTenant(pool, { plan: 'professional' });
    people.hr = await addMember(pool, t, { roles: ['hr_admin'], name: 'Hana HR' });
    tokens.owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    tokens.otherOwner = (await loginWithMfa(app, pool, other.ownerEmail)).accessToken;
    tokens.proOwner = (await loginWithMfa(app, pool, pro.ownerEmail)).accessToken;
    tokens.hr = (await loginWithMfa(app, pool, people.hr.email)).accessToken;
    tokens.ownerNoMfa = (await login(app, t.ownerEmail)).accessToken;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    hook?.server.close();
    slack?.server.close();
    delete process.env.SLACK_WEBHOOK_BASE_URL;
  });

  it('is for owners with two-step verification, on plans that include it', async () => {
    fails(await as('hr').get('/integrations/catalogue'), 403);
    fails(await as('ownerNoMfa').get('/integrations/catalogue'), 403, 'mfa_required');
    fails(await as('proOwner').get('/integrations/catalogue'), 402);
    const c = ok(await as('owner').get('/integrations/catalogue'));
    expect(c.connectors.find((x: any) => x.key === 'slack')).toMatchObject({ status: 'available', count: 0 });
    expect(c.connectors.find((x: any) => x.key === 'microsoft_teams')).toMatchObject({ status: 'planned' });
    expect(c.scopes.map((s: any) => s.key)).not.toContain('payroll:read');
  });

  describe('API keys', () => {
    it('shows the key once, stores only a hash, and refuses scopes that are not read-only', async () => {
      fails(await as('owner').post('/integrations/api-keys').send({ name: 'Payroll sync', scopes: ['payroll:read'] }), 422);
      fails(await as('owner').post('/integrations/api-keys').send({ name: 'Writer', scopes: ['employees:create'] }), 422);
      const k = ok(await as('owner').post('/integrations/api-keys').send({ name: 'Directory sync', scopes: ['employees:read', 'org:read'], expiresInDays: 30 }), 201);
      expect(k.key).toMatch(/^crew_[a-z0-9]{10}_[A-Za-z0-9_-]{43}$/);
      ids.key = k.id;
      tokens.key = k.key;
      const list = ok(await as('owner').get('/integrations/api-keys'));
      expect(JSON.stringify(list)).not.toContain(k.key.split('_').pop());
      expect(list[0]).toMatchObject({ name: 'Directory sync', prefix: k.prefix, status: 'active', useCount: 0 });
      const row = (await pool.one('api_keys', { id: k.id }))!;
      expect(row.secret_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.secret_hash).not.toContain(k.key.split('_').pop());
    });

    it('reads data within its scopes and workspace, and nothing else', async () => {
      await hire('Kira');
      const staff = ok(await api(app, tokens.key).get('/employees'));
      expect((staff.items ?? staff).some((e: any) => e.firstName === 'Kira')).toBe(true);
      ok(await api(app, tokens.key).get('/org/departments'));
      fails(await api(app, tokens.key).get('/leave/requests'), 403);
      fails(await api(app, tokens.key).get('/me'), 403);
      fails(await api(app, tokens.key).get('/integrations/api-keys'), 403);
      fails(await api(app, tokens.key).post('/employees').send({ firstName: 'X' }), 403);
      // Other workspaces' people are invisible.
      await api(app, tokens.otherOwner).post('/employees').send({ legalEntityId: other.legalEntityId, firstName: 'Olga', lastName: 'Other', dateOfJoining: '2024-01-01', probationMonths: 0, onboardingTemplateId: null });
      const again = ok(await api(app, tokens.key).get('/employees'));
      expect(JSON.stringify(again)).not.toContain('Olga');
      const row = (await pool.one('api_keys', { id: ids.key }))!;
      expect(Number(row.use_count)).toBeGreaterThanOrEqual(3);
      expect(row.last_used_at).toBeTruthy();
    });

    it('stops working when revoked, expired, tampered with, or when its creator leaves', async () => {
      const [, prefix, secret] = /^crew_([a-z0-9]{10})_(.+)$/.exec(tokens.key)!;
      fails(await api(app, `crew_${prefix}_${'A'.repeat(secret!.length)}`).get('/employees'), 401);
      fails(await api(app, 'crew_nonsense').get('/employees'), 401);
      await pool.update('api_keys', { id: ids.key }, { $set: { expires_at: new Date(Date.now() - 60_000) } });
      fails(await api(app, tokens.key).get('/employees'), 401);
      await pool.update('api_keys', { id: ids.key }, { $set: { expires_at: new Date(Date.now() + 86_400_000) } });
      ok(await api(app, tokens.key).get('/employees'));
      ok(await as('owner').post(`/integrations/api-keys/${ids.key}/revoke`));
      fails(await api(app, tokens.key).get('/employees'), 401);
      fails(await as('owner').post(`/integrations/api-keys/${ids.key}/revoke`), 409);
      await expect(pool.update('api_keys', { id: ids.key }, { $set: { revoked_at: null } })).rejects.toThrow(/revoked/);

      // A key acts as its creator: if the creator's membership ends, so does the key.
      const temp = await addMember(pool, t, { roles: ['tenant_owner'], name: 'Temp Owner' });
      const tok = (await loginWithMfa(app, pool, temp.email)).accessToken;
      const k = ok(await api(app, tok).post('/integrations/api-keys').send({ name: 'Temp key', scopes: ['org:read'], expiresInDays: null }), 201);
      ok(await api(app, k.key).get('/org/departments'));
      await pool.update('memberships', { id: temp.membershipId }, { $set: { status: 'suspended' } });
      fails(await api(app, k.key).get('/org/departments'), 401);
      expect(await pool.count('audit_events', { tenant_id: t.id, action: 'api_key.created' })).toBe(2);
    });
  });

  describe('Outgoing webhooks', () => {
    it('checks addresses and keeps the signing secret encrypted', async () => {
      fails(await as('owner').post('/integrations/webhooks').send({ name: 'Bad', url: 'ftp://example.com/x', events: ['employee.created'] }), 422);
      fails(await as('owner').post('/integrations/webhooks').send({ name: 'Bad', url: 'https://user:pw@example.com/x', events: ['employee.created'] }), 422);
      fails(await as('owner').post('/integrations/webhooks').send({ name: 'Bad', url: 'https://example.com/x', events: ['employee.salary_changed'] }), 422);
      const w = ok(await as('owner').post('/integrations/webhooks').send({ name: 'HRIS bridge', url: `${hook.base()}/crew`, events: ['employee.created', 'leave.requested'] }), 201);
      expect(w.secret).toMatch(/^whsec_/);
      ids.endpoint = w.id;
      ids.secret = w.secret;
      const row = (await pool.one('webhook_endpoints', { id: w.id }))!;
      expect(row.secret_enc).not.toContain(w.secret);
      expect(JSON.stringify(ok(await as('owner').get(`/integrations/webhooks/${w.id}`)))).not.toContain('whsec_');
      fails(await as('otherOwner').get(`/integrations/webhooks/${w.id}`), 404);
    });

    it('delivers subscribed events once, signed, with ids only', async () => {
      const id = await hire('Wade');
      await outbox.dispatchOnce();
      const ev = (await pool.one('outbox_events', { tenant_id: t.id, type: 'employee.created', 'payload.employeeId': id }))!;
      // A second delivery of the same event (at-least-once outbox) does not queue a second delivery.
      await webhooks.onEvent({ id: ev.id, tenantId: t.id, type: 'employee.created', payload: { employeeId: id }, occurredAt: new Date().toISOString() });
      expect((await pool.count('webhook_deliveries', { endpoint_id: ids.endpoint }))).toBe(1);
      await webhooks.runDue();
      const got = hook.got.filter((g) => g.url === '/crew');
      expect(got).toHaveLength(1);
      const body = JSON.parse(got[0]!.body);
      expect(body).toEqual({ id: ev.id, type: 'employee.created', createdAt: expect.any(String), workspaceId: t.id, data: { employeeId: id } });
      expect(got[0]!.headers['crew-event']).toBe('employee.created');
      expect(verify(ids.secret!, got[0]!.headers['crew-signature'] as string, got[0]!.body)).toBe(true);
      expect(verify('whsec_wrong', got[0]!.headers['crew-signature'] as string, got[0]!.body)).toBe(false);
      const list = ok(await as('owner').get(`/integrations/webhooks/${ids.endpoint}/deliveries`));
      expect(list[0]).toMatchObject({ eventType: 'employee.created', status: 'succeeded', attempts: 1, lastStatusCode: 200 });
      const d = ok(await as('owner').get(`/integrations/deliveries/${list[0].id}`));
      expect(d.attemptLog).toEqual([expect.objectContaining({ attempt: 1, ok: true, statusCode: 200 })]);
    });

    it('retries failures on a back-off, then gives up, and can be sent again', async () => {
      hook.set(500, 'boom');
      ok(await as('owner').post(`/integrations/webhooks/${ids.endpoint}/test`));
      await webhooks.runDue();
      const row = (await pool.one('webhook_deliveries', { endpoint_id: ids.endpoint, event_type: 'webhook.test' }))!;
      const d1 = { id: row.id, status: row.status, attempts: row.attempts, wait: Math.trunc((row.next_attempt_at.getTime() - Date.now()) / 1000) };
      expect(d1).toMatchObject({ status: 'pending', attempts: 1 });
      expect(d1.wait).toBeGreaterThan(50);
      expect(d1.wait).toBeLessThanOrEqual(60);
      for (let i = 2; i <= 6; i++) {
        await pool.update('webhook_deliveries', { id: d1.id }, { $set: { next_attempt_at: new Date() } });
        await webhooks.runDue();
      }
      const d = ok(await as('owner').get(`/integrations/deliveries/${d1.id}`));
      expect(d).toMatchObject({ status: 'failed', attempts: 6 });
      expect(d.attemptLog.map((a: any) => a.statusCode)).toEqual([500, 500, 500, 500, 500, 500]);
      await webhooks.runDue();
      expect((await pool.one('webhook_deliveries', { id: d1.id }))!.attempts).toBe(6);
      hook.set(204);
      ok(await as('owner').post(`/integrations/deliveries/${d1.id}/redeliver`));
      await webhooks.runDue();
      expect(ok(await as('owner').get(`/integrations/deliveries/${d1.id}`))).toMatchObject({ status: 'succeeded', attempts: 7 });
      expect((await pool.one('webhook_endpoints', { id: ids.endpoint }))!.consecutive_failures).toBe(0);
    });

    it('switches off an endpoint that keeps failing and tells its creator', async () => {
      hook.set(503);
      await pool.update('webhook_endpoints', { id: ids.endpoint }, { $set: { consecutive_failures: 14 } });
      ok(await as('owner').post(`/integrations/webhooks/${ids.endpoint}/test`));
      await webhooks.runDue();
      const w = ok(await as('owner').get(`/integrations/webhooks/${ids.endpoint}`));
      expect(w.status).toBe('disabled');
      expect(w.statusReason).toMatch(/15 failed attempts/);
      expect(await pool.count('notifications', { membership_id: t.ownerMembershipId, kind: 'webhook.disabled' })).toBe(1);
      // Nothing new is queued or sent while it is off.
      await hire('Otto');
      await outbox.dispatchOnce();
      const before = hook.got.length;
      await webhooks.runDue();
      expect(hook.got.length).toBe(before);
      fails(await as('owner').post(`/integrations/webhooks/${ids.endpoint}/test`), 409, 'endpoint_not_active');
      hook.set(200);
      ok(await as('owner').post(`/integrations/webhooks/${ids.endpoint}/enable`));
    });

    it('signs with the new secret after rotation', async () => {
      const r = ok(await as('owner').post(`/integrations/webhooks/${ids.endpoint}/rotate-secret`));
      ok(await as('owner').post(`/integrations/webhooks/${ids.endpoint}/test`));
      await webhooks.runDue();
      const last = hook.got.at(-1)!;
      expect(verify(r.secret, last.headers['crew-signature'] as string, last.body)).toBe(true);
      expect(verify(ids.secret!, last.headers['crew-signature'] as string, last.body)).toBe(false);
    });

    it('refuses private network addresses unless the installation allows them', async () => {
      expect(['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:127.0.0.1'].every(isPrivateAddress)).toBe(true);
      expect(['8.8.8.8', '1.1.1.1', '2606:4700::1111'].some(isPrivateAddress)).toBe(false);
      expect(checkUrlShape('http://example.com/x', false)).toMatch(/https/);
      expect(checkUrlShape('https://169.254.169.254/latest', false)).toMatch(/Private/);
      expect(checkUrlShape('https://localhost/x', false)).toMatch(/Private/);
      expect(checkUrlShape('https://example.com/x', false)).toBeNull();
      // A name that resolves to a private address is refused at connect time, not only when saved.
      const err = await new Promise<Error | null>((res) => safeLookup(false)('localhost', {}, (e) => res(e)));
      expect(err).toBeInstanceOf(UnsafeUrlError);
      expect(await new Promise<Error | null>((res) => safeLookup(true)('localhost', {}, (e) => res(e)))).toBeNull();
    });
  });

  describe('Slack and workflow steps', () => {
    it('connects a channel only after Slack accepts a message, and keeps the URL encrypted', async () => {
      fails(await as('owner').post('/integrations/connections/slack').send({ name: 'People team', webhookUrl: 'https://example.com/hook' }), 422);
      fails(await as('owner').post('/integrations/connections/slack').send({ name: 'People team', webhookUrl: 'https://hooks.slack.com/services/T000/B000/gone' }), 400, 'slack_not_verified');
      expect((await pool.count('integration_connections', { tenant_id: t.id }))).toBe(0);
      const url = 'https://hooks.slack.com/services/T000/B000/abcDEF123456';
      const c = ok(await as('owner').post('/integrations/connections/slack').send({ name: 'People team', webhookUrl: url }), 201);
      ids.slack = c.id;
      expect(slack.got.at(-1)).toMatchObject({ url: '/services/T000/B000/abcDEF123456' });
      expect(JSON.parse(slack.got.at(-1)!.body).text).toMatch(/now connected/);
      const row = (await pool.one('integration_connections', { id: c.id }))!;
      expect(row.credentials_enc).not.toContain('hooks.slack.com');
      const list = ok(await as('owner').get('/integrations/connections'));
      expect(list[0]).toMatchObject({ name: 'People team', provider: 'slack', status: 'active', display: { webhook: '…123456' } });
      expect(JSON.stringify(list)).not.toContain('abcDEF');
      ok(await as('owner').post(`/integrations/connections/${c.id}/test`));
      expect(ok(await as('owner').get(`/integrations/connections/${c.id}/logs`)).map((l: any) => l.action)).toEqual(['test', 'connect']);
    });

    it('lets a workflow post to Slack and send to a webhook, once per run', async () => {
      const def = {
        trigger: { event: 'employee.created' },
        steps: [
          { id: 'tell_slack', type: 'slack', connectionId: ids.slack, text: 'Welcome {{employee.name}} to the team' },
          { id: 'tell_hris', type: 'webhook', endpointId: ids.endpoint, message: 'New joiner {{employee.name}}' },
        ],
      };
      fails(await as('hr').post('/automation/workflows').send({ name: 'Bad refs', definition: { ...def, steps: [{ ...def.steps[0], connectionId: '00000000-0000-4000-8000-000000000000' }] } }), 422);
      const cat = ok(await as('hr').get('/automation/catalogue'));
      expect(cat.slackConnections).toEqual([{ id: ids.slack, name: 'People team', status: 'active' }]);
      const w = ok(await as('hr').post('/automation/workflows').send({ name: 'Announce joiners', definition: def }), 201);
      const test = ok(await as('hr').post(`/automation/workflows/${w.id}/test`).send({ sample: { 'employee.name': 'Sam' } }));
      expect(test.steps.map((s: any) => s.detail)).toEqual(['Would post to Slack (People team): "Welcome Sam to the team"', 'Would send to "HRIS bridge": "New joiner Sam"']);
      const slackBefore = slack.got.length;
      ok(await as('hr').post(`/automation/workflows/${w.id}/activate`));
      ids.wf = w.id;
      fails(await as('owner').post(`/integrations/connections/${ids.slack}/disconnect`), 409, 'connection_in_use');
      fails(await as('owner').delete(`/integrations/webhooks/${ids.endpoint}`), 409, 'endpoint_in_use');

      await pool.update('outbox_events', { tenant_id: t.id, published_at: null }, { $set: { published_at: new Date() } });
      await hire('Yara');
      await outbox.dispatchOnce();
      await runner.runDue();
      const run = (await pool.one('workflow_runs', { workflow_id: w.id, mode: 'live' }))!;
      expect(run.status).toBe('succeeded');
      expect(slack.got.length).toBe(slackBefore + 1);
      expect(JSON.parse(slack.got.at(-1)!.body).text).toBe('Welcome Yara Test to the team');
      await webhooks.runDue();
      const sent = hook.got.filter((g) => g.headers['crew-event'] === 'workflow.webhook');
      expect(sent).toHaveLength(1);
      expect(JSON.parse(sent[0]!.body).data).toMatchObject({ workflowId: w.id, workflowName: 'Announce joiners', runId: run.id, message: 'New joiner Yara Test' });
    });

    it('fails the run without retrying when Slack says the webhook is gone, and marks the connection', async () => {
      await pool.update('integration_connections', { id: ids.slack }, { $set: { credentials_enc: (await pool.one('integration_connections', { id: ids.slack }))!.credentials_enc } });
      // Point the connection at a removed Slack webhook by reconnecting a second channel and swapping its secret in.
      const gone = (await pool.one('integration_connections', { id: ids.slack }))!;
      expect(gone.credentials_enc).toBeTruthy();
      const app2Url = 'https://hooks.slack.com/services/T000/B000/gone';
      const enc = (await import('../src/platform/auth/crypto')).encryptField(JSON.stringify({ webhookUrl: app2Url }), process.env.FIELD_ENCRYPTION_KEY!);
      await pool.update('integration_connections', { id: ids.slack }, { $set: { credentials_enc: enc } });
      await hire('Zed');
      await outbox.dispatchOnce();
      await runner.runDue();
      const run = (await pool.find('workflow_runs', { workflow_id: ids.wf, mode: 'live' })).find((x) => x.context['employee.name'] === 'Zed Test')!;
      expect(run.status).toBe('failed');
      expect(run.error).toMatch(/no_service/);
      const c = ok(await as('owner').get('/integrations/connections'));
      expect(c[0]).toMatchObject({ status: 'error' });
      ok(await as('hr').post(`/automation/workflows/${ids.wf}/pause`));
      ok(await as('owner').post(`/integrations/connections/${ids.slack}/disconnect`));
      const after = (await pool.one('integration_connections', { id: ids.slack }))!;
      expect({ credentials_enc: after.credentials_enc, status: after.status }).toEqual({ credentials_enc: '', status: 'disconnected' });
    });
  });
});
