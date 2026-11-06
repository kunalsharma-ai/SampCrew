import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiGatewayService } from '../src/modules/ai/ai-gateway.service';
import { AiService } from '../src/modules/ai/ai.service';
import { AnthropicProvider } from '../src/modules/ai/ai-provider';
import { WorkflowRunnerService } from '../src/modules/automation/workflow-runner.service';
import { DatabaseService } from '../src/platform/database/database.service';
import { OutboxService } from '../src/platform/events/outbox.service';
import { addMember, adminPool, api, createApp, createTenant, department, login, loginWithMfa, type TestTenant } from './helpers';

/**
 * A stand-in for the Claude Messages API on localhost, so the real HTTP client and gateway run without a key or
 * network access. Each test sets what it answers next; every request is kept for inspection.
 */
interface StubReply { status?: number; text?: string; stop?: string; usage?: { input_tokens: number; output_tokens: number } }
function stubServer() {
  const requests: { headers: IncomingMessage['headers']; body: any }[] = [];
  let next: StubReply[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push({ headers: req.headers, body: raw ? JSON.parse(raw) : null });
      const r = next.shift() ?? { text: 'OK' };
      res.setHeader('content-type', 'application/json');
      if (r.status && r.status >= 400) {
        res.statusCode = r.status;
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'stub failure' } }));
        return;
      }
      res.end(JSON.stringify({
        id: 'msg_stub', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: r.stop ?? 'end_turn', stop_sequence: null,
        content: r.stop === 'refusal' ? [] : [{ type: 'text', text: r.text ?? 'OK' }],
        usage: r.usage ?? { input_tokens: 1200, output_tokens: 300 },
      }));
    });
  });
  return { server, requests, reply: (...r: StubReply[]) => { next = r; } };
}

describe('AI copilots, Automation Studio and insights', () => {
  let app: INestApplication;
  let pool: Pool;
  let t: TestTenant;
  let other: TestTenant;
  let stub: ReturnType<typeof stubServer>;
  let gateway: AiGatewayService;
  let runner: WorkflowRunnerService;
  let outbox: OutboxService;
  let ops: string;
  const people: Record<string, { email: string; membershipId: string; employeeId?: string }> = {};
  const tokens: Record<string, string> = {};
  const as = (who: string) => api(app, tokens[who]);
  const ids: Record<string, string> = {};

  const ok = (res: { status: number; body: unknown }, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as Record<string, any>;
  };
  const fails = (res: { status: number; body: any }, status: number, code?: string) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    if (code) expect(res.body.error.code).toBe(code);
    return res.body;
  };
  const useStub = () => {
    gateway.setProvider(new AnthropicProvider({ apiKey: 'sk-test-not-a-real-key', baseUrl: `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`, model: 'claude-opus-5-5', effort: 'low', refusalFallback: true, timeoutMs: 30_000 }));
  };
  const hire = async (who: string, first: string, extra: Record<string, unknown> = {}) => {
    const body = ok(await as('hr').post('/employees').send({
      legalEntityId: t.legalEntityId, firstName: first, lastName: 'Test', dateOfJoining: '2024-01-01', probationMonths: 0,
      ...(people[who] ? { membershipId: people[who]!.membershipId } : {}), onboardingTemplateId: null, ...extra,
    }), 201);
    if (people[who]) people[who]!.employeeId = body.employee.id;
    return body.employee.id as string;
  };

  beforeAll(async () => {
    stub = stubServer();
    await new Promise<void>((r) => stub.server.listen(0, '127.0.0.1', r));
    app = await createApp();
    pool = adminPool();
    gateway = app.get(AiGatewayService);
    runner = app.get(WorkflowRunnerService);
    outbox = app.get(OutboxService);
    t = await createTenant(pool);
    other = await createTenant(pool);
    ops = await department(pool, t, 'Operations');
    people.hr = await addMember(pool, t, { roles: ['hr_admin'], name: 'Hana HR' });
    people.hr2 = await addMember(pool, t, { roles: ['hr_admin'], name: 'Hugo HR' });
    people.manager = await addMember(pool, t, { roles: ['department_manager'], departmentId: ops, name: 'Manu Manager' });
    people.asha = await addMember(pool, t, { departmentId: ops, managerId: people.manager.membershipId, name: 'Asha' });
    people.auditor = await addMember(pool, t, { roles: ['auditor'], name: 'Avi Auditor' });
    people.payroll = await addMember(pool, t, { roles: ['payroll_admin'], name: 'Pia Payroll' });
    people.owner = { email: t.ownerEmail, membershipId: t.ownerMembershipId };
    people.otherOwner = { email: other.ownerEmail, membershipId: other.ownerMembershipId };
    tokens.hr = (await loginWithMfa(app, pool, people.hr.email)).accessToken;
    tokens.hr2 = (await loginWithMfa(app, pool, people.hr2.email)).accessToken;
    tokens.owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    tokens.otherOwner = (await loginWithMfa(app, pool, other.ownerEmail)).accessToken;
    tokens.payroll = (await loginWithMfa(app, pool, people.payroll.email)).accessToken;
    await hire('hr', 'Hana');
    await hire('hr2', 'Hugo');
    await hire('manager', 'Manu', { departmentId: ops });
    await hire('asha', 'Asha', { departmentId: ops, managerEmployeeId: people.manager.employeeId });
    for (const who of ['manager', 'asha', 'auditor']) tokens[who] = (await login(app, people[who]!.email)).accessToken;
    // Employee records created above published events; clear them so workflow tests start clean.
    await pool.query('update outbox_events set published_at = now() where tenant_id = $1', [t.id]);
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    stub?.server.close();
  });

  beforeEach(() => stub.reply());

  describe('AI settings and the gateway', () => {
    it('says plainly when AI is not set up, and sends nothing', async () => {
      gateway.setProvider(null);
      const s = ok(await as('asha').get('/ai/status'));
      expect(s.configured).toBe(false);
      expect(s.features.assistant).toEqual({ available: false, reason: 'AI is not set up for this SampCrew installation.' });
      fails(await as('asha').post('/ai/assistant').send({ question: 'How is provident fund calculated?' }), 409, 'ai_not_configured');
      expect(stub.requests).toHaveLength(0);
    });

    it('keeps every feature off until an administrator switches it on, with MFA', async () => {
      useStub();
      fails(await as('asha').post('/ai/assistant').send({ question: 'How is provident fund calculated?' }), 409, 'ai_feature_off');
      fails(await as('asha').put('/ai/settings').send({ features: { assistant: true, helpdesk_draft: true, workflow_draft: true } }), 403);
      fails(await as('hr').put('/ai/settings').send({ features: { assistant: true, helpdesk_draft: true, workflow_draft: true } }), 403);
      const owner = (await login(app, t.ownerEmail)).accessToken;
      fails(await api(app, owner).put('/ai/settings').send({ features: { assistant: true, helpdesk_draft: true, workflow_draft: true } }), 403, 'mfa_required');
      fails(await as('owner').put('/ai/settings').send({ features: { assistant: true } }), 422);
      const s = ok(await as('owner').put('/ai/settings').send({ features: { assistant: true, helpdesk_draft: true, workflow_draft: true }, promptLogDays: 30 }));
      expect(s).toMatchObject({ configured: true, provider: 'anthropic', model: 'claude-opus-5-5', promptLogDays: 30, features: { assistant: true }, usage: { used: 0, limit: 5000 } });
      const audit = await pool.query(`select changes from audit_events where tenant_id = $1 and action = 'ai.settings_changed'`, [t.id]);
      expect(audit.rows[0].changes.after.features.assistant).toBe(true);
      expect(ok(await as('asha').get('/ai/status')).features.assistant.available).toBe(true);
    });

    it('answers without a model when no help article matches', async () => {
      const r = ok(await as('asha').post('/ai/assistant').send({ question: 'What is the canteen menu on Friday?' }));
      expect(r).toMatchObject({ answered: false, sources: [], model: null });
      expect(r.answer).toContain("couldn't find this");
      expect(stub.requests).toHaveLength(0);
      const row = await pool.query('select status, credits from ai_interactions where id = $1', [r.interactionId]);
      expect(row.rows[0]).toEqual({ status: 'no_sources', credits: 0 });
    });

    it('answers from published articles with citations, removing personal identifiers from the prompt', async () => {
      const a = ok(await as('hr').post('/helpdesk/articles').send({ title: 'Provident fund deductions', body: 'Provident fund is 12% of basic pay, capped at the statutory wage ceiling. It is shown on your payslip as PF.' }), 201);
      ok(await as('hr').post('/helpdesk/articles').send({ title: 'Draft policy on bonuses', body: 'Bonus provident details not final yet, do not share.', published: false }), 201);
      ids.article = a.id;
      stub.reply({ text: 'Provident fund is 12% of your basic pay [1].', usage: { input_tokens: 1500, output_tokens: 600 } });
      const r = ok(await as('asha').post('/ai/assistant').send({ question: 'How much provident fund is deducted? Reply to asha.k@example.com or 9876543210.' }));
      expect(r).toMatchObject({ answered: true, answer: 'Provident fund is 12% of your basic pay [1].', model: 'claude-opus-5-5' });
      expect(r.sources).toEqual([{ number: 1, articleId: a.id, title: 'Provident fund deductions', cited: true }]);
      const sent = stub.requests.at(-1)!;
      expect(sent.headers['x-api-key'] ?? sent.headers.authorization).toContain('sk-test-not-a-real-key');
      expect(sent.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
      expect(sent.body).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', output_config: { effort: 'low' } });
      expect(sent.body.system).toContain('Provident fund is 12% of basic pay');
      expect(sent.body.system).not.toContain('not final yet');
      expect(sent.body.messages[0].content).toBe('How much provident fund is deducted? Reply to [email] or [phone].');
      const row = (await pool.query('select status, credits, input_tokens, output_tokens, redactions, evidence, prompt_version from ai_interactions where id = $1', [r.interactionId])).rows[0];
      expect(row).toMatchObject({ status: 'ok', credits: 3, input_tokens: 1500, output_tokens: 600, redactions: { email: 1, phone: 1 }, prompt_version: 'assistant-v1' });
      expect(row.evidence).toEqual([{ kind: 'helpdesk_article', id: a.id, title: 'Provident fund deductions' }]);
      ids.answer = r.interactionId;
    });

    it('takes feedback only from the person who asked', async () => {
      fails(await as('manager').post(`/ai/interactions/${ids.answer}/feedback`).send({ helpful: false }), 404);
      ok(await as('asha').post(`/ai/interactions/${ids.answer}/feedback`).send({ helpful: true, comment: 'Clear' }));
      const usage = ok(await as('owner').get('/ai/usage'));
      expect(usage.used).toBe(3);
      expect(usage.byFeature.find((f: any) => f.feature === 'assistant')).toMatchObject({ calls: 2, credits: 3, helpful: 1 });
    });

    it('reports refusals and provider errors honestly and records them', async () => {
      stub.reply({ stop: 'refusal' });
      fails(await as('asha').post('/ai/assistant').send({ question: 'Explain provident fund rules' }), 409, 'ai_refused');
      stub.reply({ status: 500 }, { status: 500 }, { status: 500 });
      fails(await as('asha').post('/ai/assistant').send({ question: 'Explain provident fund rules' }), 503, 'ai_unavailable');
      const rows = await pool.query(`select status, error from ai_interactions where tenant_id = $1 and status in ('refused', 'error') order by created_at`, [t.id]);
      expect(rows.rows.map((r) => r.status)).toEqual(['refused', 'error']);
      expect(rows.rows[1].error).toBe('The AI provider returned an error (500)');
    });

    it('stops at the monthly AI credit allowance', async () => {
      await pool.query(`update subscriptions set feature_overrides = '{"ai_credits_monthly": 3}' where tenant_id = $1`, [t.id]);
      fails(await as('asha').post('/ai/assistant').send({ question: 'Explain provident fund rules' }), 402, 'ai_credits_used');
      expect(ok(await as('asha').get('/ai/status')).features.assistant.reason).toContain("used this month's AI credits");
      await pool.query(`update subscriptions set feature_overrides = '{}' where tenant_id = $1`, [t.id]);
    });

    it('lets auditors read the prompt log, audits each view, and keeps other workspaces out', async () => {
      fails(await as('asha').get('/ai/interactions'), 403);
      const list = ok(await as('auditor').get('/ai/interactions?feature=assistant')) as unknown as any[];
      expect(list.length).toBeGreaterThanOrEqual(4);
      const one = ok(await as('auditor').get(`/ai/interactions/${ids.answer}`));
      expect(one.request.user).toContain('[email]');
      expect(one).toMatchObject({ response: 'Provident fund is 12% of your basic pay [1].', helpful: true, byName: 'Asha Test' });
      const viewed = await pool.query(`select count(*)::int as n from audit_events where tenant_id = $1 and action = 'ai.interaction_viewed' and resource_id = $2`, [t.id, ids.answer]);
      expect(viewed.rows[0].n).toBe(1);
      fails(await as('otherOwner').get(`/ai/interactions/${ids.answer}`), 404);
    });

    it('removes prompt text after the retention period but keeps usage, and the log cannot be rewritten', async () => {
      await pool.query(`update ai_interactions set request = null where id = $1`, [ids.answer]).catch(() => undefined);
      await pool.query(`alter table ai_interactions disable trigger ai_interactions_guard`);
      await pool.query(`update ai_interactions set created_at = now() - interval '40 days' where id = $1`, [ids.answer]);
      await pool.query(`alter table ai_interactions enable trigger ai_interactions_guard`);
      const n = await app.get(DatabaseService).tenant((tx) => app.get(AiService).purgeExpired(tx), { tenantId: t.id });
      expect(n).toBe(1);
      const row = (await pool.query('select request, response, credits, purged_at from ai_interactions where id = $1', [ids.answer])).rows[0];
      expect(row).toMatchObject({ request: null, response: null, credits: 3 });
      expect(row.purged_at).not.toBeNull();
      await expect(pool.query(`update ai_interactions set credits = 0 where id = $1`, [ids.answer])).rejects.toThrow(/cannot be changed/);
      await expect(pool.query(`update ai_interactions set response = 'rewritten' where id = $1`, [ids.answer])).rejects.toThrow(/can only be removed/);
      await expect(pool.query(`delete from ai_interactions where id = $1`, [ids.answer])).rejects.toThrow(/cannot be deleted/);
    });
  });

  describe('helpdesk reply drafts', () => {
    it('drafts a reply for the handler, who edits and sends it as their own', async () => {
      const cats = ok(await as('asha').get('/helpdesk/categories')) as unknown as any[];
      const pay = cats.find((c) => c.name === 'Pay and payslips').id;
      const c = ok(await as('asha').post('/helpdesk/cases').send({ categoryId: pay, subject: 'Provident fund went up', description: 'My provident fund deduction changed this month. My PAN is ABCDE1234F.' }), 201);
      fails(await as('asha').post(`/ai/helpdesk/cases/${c.id}/draft`), 403);
      stub.reply({ text: 'Your provident fund is 12% of basic pay [1]. [check the employee\'s payslip]' });
      const d = ok(await as('hr').post(`/ai/helpdesk/cases/${c.id}/draft`));
      expect(d.draft).toContain('12% of basic pay');
      expect(d.sources[0]).toMatchObject({ articleId: ids.article, cited: true });
      const sent = stub.requests.at(-1)!.body;
      expect(sent.messages[0].content).toContain('Employee: My provident fund deduction changed this month. My PAN is [tax id].');
      expect(sent.messages[0].content).not.toContain('Asha');
      // Nothing reached the employee yet.
      expect((ok(await as('asha').get(`/helpdesk/cases/${c.id}`)).messages as any[]).length).toBe(0);
      fails(await as('hr2').post(`/helpdesk/cases/${c.id}/messages`).send({ body: 'Edited', aiInteractionId: d.interactionId }), 400, 'unknown_draft');
      ok(await as('hr').post(`/helpdesk/cases/${c.id}/messages`).send({ body: 'Your provident fund is 12% of basic pay; the base went up with your raise.', aiInteractionId: d.interactionId }));
      const seen = ok(await as('asha').get(`/helpdesk/cases/${c.id}`));
      expect(seen.messages[0]).toMatchObject({ aiDrafted: true, authorName: 'Hana Test', fromHr: true });
    });

    it('is not offered for confidential cases', async () => {
      const cat = ok(await as('hr').post('/helpdesk/categories').send({ name: 'Grievance', confidential: true, handlerMembershipIds: [people.hr.membershipId] }), 201);
      const c = ok(await as('asha').post('/helpdesk/cases').send({ categoryId: cat.id, subject: 'A concern in confidence', description: 'I would like to raise a concern about my shift.' }), 201);
      fails(await as('hr').post(`/ai/helpdesk/cases/${c.id}/draft`), 409, 'confidential_case');
    });
  });

  describe('Automation Studio', () => {
    const definition = () => ({
      trigger: { event: 'employee.created' },
      steps: [
        { id: 'only_ops', type: 'condition', field: 'employee.department', op: 'eq', value: 'operations' },
        { id: 'tell_manager', type: 'notify', to: 'manager', title: '{{employee.name}} joins your team', body: 'Starts on {{employee.dateOfJoining}}.' },
        { id: 'manager_ok', type: 'approval', approver: 'manager', summary: 'Enrol {{employee.name}} in safety induction' },
        { id: 'induction', type: 'assign_course', courseId: ids.course, dueInDays: 14 },
        { id: 'welcome', type: 'notify', to: 'employee', title: 'Welcome, {{employee.name}}', email: true },
      ],
    });

    beforeAll(async () => {
      ids.course = (await pool.query<{ id: string }>(`insert into courses (tenant_id, title, format) values ($1, 'Safety induction', 'online') returning id`, [t.id])).rows[0]!.id;
    });

    it('is for workflow administrators with MFA only', async () => {
      fails(await as('asha').get('/automation/workflows'), 403);
      fails(await as('manager').get('/automation/workflows'), 403);
      const hrNoMfa = (await login(app, people.hr.email)).accessToken;
      fails(await api(app, hrNoMfa).get('/automation/workflows'), 403, 'mfa_required');
      const cat = ok(await as('hr').get('/automation/catalogue'));
      expect(cat.triggers.map((x: any) => x.key)).toContain('leave.requested');
      expect(cat.courses).toEqual([{ id: ids.course, title: 'Safety induction' }]);
    });

    it('refuses definitions that would not work, explaining why', async () => {
      const bad = fails(await as('hr').post('/automation/workflows').send({
        name: 'Broken', definition: { trigger: { event: 'employee.created' }, steps: [
          { id: 'x', type: 'condition', field: 'leave.days', op: 'gt', value: 2 },
          { id: 'y', type: 'notify', to: 'role', role: 'no_such_role', title: 'Pay is {{salary}}' },
        ] },
      }), 422);
      const msgs = bad.error.details.map((d: any) => d.message);
      expect(msgs).toEqual(expect.arrayContaining(['"leave.days" is not available for this trigger', 'Role "no_such_role" does not exist', '{{salary}} is not available for this trigger']));
      const gone = fails(await as('hr').post('/automation/workflows').send({ name: 'No course', definition: { trigger: { event: 'employee.created' }, steps: [{ id: 'c', type: 'assign_course', courseId: '00000000-0000-4000-8000-000000000000' }] } }), 422);
      expect(gone.error.details[0].message).toBe('Choose a current course');
    });

    it('needs a passing test run before activation; tests touch nobody', async () => {
      const w = ok(await as('hr').post('/automation/workflows').send({ name: 'Operations joiner', description: 'Tell the manager and enrol in induction', definition: definition() }), 201);
      ids.wf = w.id;
      expect(w).toMatchObject({ status: 'draft', canActivate: false, latest: { version: 1, testedAt: null } });
      expect(w.latest.steps[2].summary).toBe('Ask the employee\'s manager to approve: "Enrol {{employee.name}} in safety induction"');
      fails(await as('hr').post(`/automation/workflows/${w.id}/activate`), 409, 'not_tested');
      const before = (await pool.query('select count(*)::int as n from notifications where tenant_id = $1', [t.id])).rows[0].n;
      const stopped = ok(await as('hr').post(`/automation/workflows/${w.id}/test`).send({ sample: { 'employee.name': 'Test Person', 'employee.department': 'Quality' } }));
      expect(stopped).toMatchObject({ status: 'stopped', passed: true });
      expect(stopped.steps).toHaveLength(1);
      const full = ok(await as('hr').post(`/automation/workflows/${w.id}/test`).send({ sample: { 'employee.name': 'Test Person', 'employee.department': 'Operations' } }));
      expect(full.status).toBe('succeeded');
      expect(full.steps.map((s: any) => s.status)).toEqual(['succeeded', 'simulated', 'simulated', 'simulated', 'simulated']);
      expect(full.steps[1].detail).toBe('Would notify the employee\'s manager: "Test Person joins your team"');
      expect(full.steps[3].detail).toBe('Would assign "Safety induction", due in 14 days');
      const rejected = ok(await as('hr').post(`/automation/workflows/${w.id}/test`).send({ sample: { 'employee.department': 'Operations' }, approvals: 'reject' }));
      expect(rejected.status).toBe('stopped');
      expect((await pool.query('select count(*)::int as n from notifications where tenant_id = $1', [t.id])).rows[0].n).toBe(before);
      expect((await pool.query(`select count(*)::int as n from approval_requests where tenant_id = $1 and resource_type = 'workflow_run'`, [t.id])).rows[0].n).toBe(0);
      const a = ok(await as('hr').post(`/automation/workflows/${w.id}/activate`));
      expect(a).toMatchObject({ status: 'active', canActivate: false });
    });

    it('runs live from a domain event, waits for the manager, then finishes, once per event', async () => {
      const newbie = await addMember(pool, t, { departmentId: ops, managerId: people.manager.membershipId, name: 'Nia New' });
      people.nia = newbie;
      await hire('nia', 'Nia', { departmentId: ops, managerEmployeeId: people.manager.employeeId });
      await hire('none', 'Quinn', { departmentId: null });
      await outbox.dispatchOnce();
      const runs = await pool.query(`select id, status, context from workflow_runs where workflow_id = $1 and mode = 'live' order by created_at`, [ids.wf]);
      expect(runs.rows).toHaveLength(2);
      ids.run = runs.rows.find((r) => r.context['employee.name'] === 'Nia Test')!.id;
      expect(runs.rows.find((r) => r.id === ids.run)!.context).not.toHaveProperty('employee.salary');
      await runner.runDue();
      let run = ok(await as('hr').get(`/automation/runs/${ids.run}`));
      expect(run).toMatchObject({ status: 'waiting', stepIndex: 2, canCancel: true });
      expect(run.steps.map((s: any) => `${s.stepId}:${s.status}`)).toEqual(['only_ops:succeeded', 'tell_manager:succeeded', 'manager_ok:waiting']);
      const quinn = runs.rows.find((r) => r.context['employee.name'] === 'Quinn Test')!.id;
      expect(ok(await as('hr').get(`/automation/runs/${quinn}`))).toMatchObject({ status: 'stopped' });
      const told = await pool.query(`select title from notifications where membership_id = $1 and kind = 'workflow.notice'`, [people.manager.membershipId]);
      expect(told.rows.map((r) => r.title)).toEqual(['Nia Test joins your team']);

      // The same event delivered again starts nothing new.
      const ev = await pool.query(`select id, tenant_id, type, payload, occurred_at from outbox_events where tenant_id = $1 and type = 'employee.created' and payload->>'employeeId' = $2`, [t.id, people.nia!.employeeId]);
      const e = ev.rows[0];
      expect(await runner.onEvent({ id: e.id, tenantId: e.tenant_id, type: e.type, payload: e.payload, occurredAt: e.occurred_at })).toBe(0);

      const inbox = ok(await as('manager').get('/approvals/inbox')) as unknown as any[];
      const req = inbox.find((x) => x.resourceType === 'workflow_run');
      expect(req.summary).toBe('Enrol Nia Test in safety induction');
      ok(await as('manager').post(`/approvals/${req.id}/approve`).send({}));
      await runner.runDue();
      run = ok(await as('hr').get(`/automation/runs/${ids.run}`));
      expect(run.status).toBe('succeeded');
      expect(run.steps.map((s: any) => `${s.stepId}:${s.status}`)).toEqual(['only_ops:succeeded', 'tell_manager:succeeded', 'manager_ok:waiting', 'manager_ok:succeeded', 'induction:succeeded', 'welcome:succeeded']);
      expect(run.steps[3].detail).toMatch(/^Approved by /);
      const assigned = await pool.query(`select assigned_by_membership_id, due_on from course_assignments where employee_id = $1 and course_id = $2`, [people.nia!.employeeId, ids.course]);
      expect(assigned.rows[0].assigned_by_membership_id).toBe(people.hr.membershipId);
      const audit = await pool.query(`select actor_label from audit_events where tenant_id = $1 and action = 'learning.assigned' order by created_at desc limit 1`, [t.id]);
      expect(audit.rows[0].actor_label).toBe('Workflow "Operations joiner" (as Hana HR)');
    });

    it('retries a failing step, fails the run with a notice, and replays it from that step', async () => {
      await pool.query('update courses set archived_at = now() where id = $1', [ids.course]);
      const m = await addMember(pool, t, { departmentId: ops, managerId: people.manager.membershipId, name: 'Omar' });
      people.omar = m;
      await hire('omar', 'Omar', { departmentId: ops, managerEmployeeId: people.manager.employeeId });
      await outbox.dispatchOnce();
      await runner.runDue();
      const id = (await pool.query(`select id from workflow_runs where workflow_id = $1 and context->>'employee.name' = 'Omar Test'`, [ids.wf])).rows[0].id;
      const inbox = ok(await as('manager').get('/approvals/inbox')) as unknown as any[];
      ok(await as('manager').post(`/approvals/${inbox.find((x) => x.resourceType === 'workflow_run').id}/approve`).send({}));
      await runner.runDue();
      let run = ok(await as('hr').get(`/automation/runs/${id}`));
      expect(run).toMatchObject({ status: 'failed', canRetry: true, error: 'The course no longer exists or is archived' });
      expect((ok(await as('hr').get('/automation/runs?status=failed')) as unknown as any[]).map((r) => r.id)).toContain(id);
      const notice = await pool.query(`select title from notifications where membership_id = $1 and kind = 'workflow.failed'`, [people.hr.membershipId]);
      expect(notice.rows[0].title).toBe('Workflow "Operations joiner" failed at step 4');
      await pool.query('update courses set archived_at = null where id = $1', [ids.course]);
      ok(await as('hr').post(`/automation/runs/${id}/retry`));
      await runner.runDue();
      run = ok(await as('hr').get(`/automation/runs/${id}`));
      expect(run.status).toBe('succeeded');
      expect(run.steps.filter((s: any) => s.stepId === 'tell_manager')).toHaveLength(1);
    });

    it('waits durably on a delay and backs off on a transient failure', async () => {
      const w = ok(await as('hr').post('/automation/workflows').send({ name: 'Remind HR', definition: { trigger: { event: 'employee.created' }, steps: [
        { id: 'wait', type: 'delay', amount: 2, unit: 'days' },
        { id: 'remind', type: 'notify', to: 'role', role: 'hr_admin', title: 'Check documents for {{employee.name}}' },
      ] } }), 201);
      ok(await as('hr').post(`/automation/workflows/${w.id}/test`).send({}));
      ok(await as('hr').post(`/automation/workflows/${w.id}/activate`));
      await hire('none', 'Della', {});
      await outbox.dispatchOnce();
      await runner.runDue();
      const r = (await pool.query(`select id, status, wake_at from workflow_runs where workflow_id = $1`, [w.id])).rows[0];
      expect(r.status).toBe('waiting');
      expect(new Date(r.wake_at).getTime()).toBeGreaterThan(Date.now() + 47 * 3_600_000);
      await runner.runDue();
      expect((await pool.query('select status from workflow_runs where id = $1', [r.id])).rows[0].status).toBe('waiting');
      await pool.query(`update workflow_runs set wake_at = now() - interval '1 second' where id = $1`, [r.id]);
      await runner.runDue();
      const done = ok(await as('hr').get(`/automation/runs/${r.id}`));
      expect(done.status).toBe('succeeded');
      expect(done.steps.at(-1).detail).toBe('Notified 2 people: "Check documents for Della Test"');
      ok(await as('hr').post(`/automation/workflows/${w.id}/archive`));
    });

    it('pauses itself when its owner loses permission, and keeps other workspaces out', async () => {
      // Take the owner's HR role away; the next run notices.
      await pool.query(`delete from role_assignments ra using roles r where r.id = ra.role_id and ra.membership_id = $1 and r.key = 'hr_admin'`, [people.hr.membershipId]);
      const e = ok(await as('hr2').post('/employees').send({ legalEntityId: t.legalEntityId, firstName: 'Ravi', lastName: 'Test', dateOfJoining: '2024-01-01', probationMonths: 0, departmentId: ops, managerEmployeeId: people.manager.employeeId, onboardingTemplateId: null }), 201);
      await outbox.dispatchOnce();
      await runner.runDue();
      const run = (await pool.query(`select status, error from workflow_runs where workflow_id = $1 and subject_employee_id = $2`, [ids.wf, e.employee.id])).rows[0];
      expect(run.status).toBe('failed');
      expect(run.error).toContain('no longer has permission');
      const w = ok(await as('hr2').get(`/automation/workflows/${ids.wf}`));
      expect(w).toMatchObject({ status: 'paused', statusReason: 'The workflow owner no longer has permission to manage workflows, so the workflow was paused.' });
      await pool.query(`insert into role_assignments (tenant_id, membership_id, role_id) select $1, $2, id from roles where tenant_id = $1 and key = 'hr_admin'`, [t.id, people.hr.membershipId]);
      fails(await as('otherOwner').get(`/automation/workflows/${ids.wf}`), 404);
      fails(await as('otherOwner').get(`/automation/runs/${ids.run}`), 404);
    });

    it('keeps versions immutable and drafts workflows from plain English with AI', async () => {
      await expect(pool.query(`update workflow_versions set definition = '{}' where workflow_id = $1`, [ids.wf])).rejects.toThrow(/cannot be changed/);
      stub.reply({ text: JSON.stringify({ trigger: { event: 'leave.requested' }, steps: [
        { id: 'long', type: 'condition', field: 'leave.days', op: 'gte', value: 5 },
        { id: 'tell_hr', type: 'notify', to: 'role', role: 'hr_admin', title: '{{employee.name}} asked for {{leave.days}} days' },
      ] }) });
      const d = ok(await as('hr').post('/automation/drafts').send({ description: 'When someone asks for five or more days of leave, tell HR.' }));
      expect(d.issues).toEqual([]);
      expect(d.definition.steps[1]).toMatchObject({ type: 'notify', role: 'hr_admin', email: false });
      expect(stub.requests.at(-1)!.body.system).toContain('"leave.days (number)"');
      const w = ok(await as('hr').post('/automation/workflows').send({ name: 'Long leave', definition: d.definition, aiInteractionId: d.interactionId }), 201);
      expect(w.versions[0].aiDrafted).toBe(true);
      fails(await as('hr2').put(`/automation/workflows/${w.id}`).send({ name: 'Long leave', definition: d.definition, aiInteractionId: d.interactionId }), 400, 'unknown_draft');
      stub.reply({ text: 'I cannot do that.' });
      const none = ok(await as('hr').post('/automation/drafts').send({ description: 'Pay everyone a bonus when it rains.' }));
      expect(none.definition).toBeNull();
    });
  });

  describe('insights', () => {
    it('scores attrition risk with named factors for HR only, and records reviews', async () => {
      // Asha: in the company 3+ years with no move and no recognition, and a spike of sick leave.
      await pool.query(`update employees set date_of_joining = current_date - interval '40 months' where id = $1`, [people.asha!.employeeId]);
      await pool.query(`update employment_records set effective_from = current_date - interval '40 months' where employee_id = $1`, [people.asha!.employeeId]);
      fails(await as('manager').get('/insights/attrition'), 403);
      fails(await as('asha').get(`/insights/attrition/${people.asha!.employeeId}`), 403);
      ok(await as('hr').post('/insights/attrition/recalculate'));
      const list = ok(await as('hr').get('/insights/attrition'));
      expect(list.rulesVersion).toBe('attrition-rules-v1');
      const asha = list.people.find((p: any) => p.employeeId === people.asha!.employeeId);
      expect(asha.factors.map((f: any) => f.key)).toEqual(['stalled', 'no_recognition']);
      expect(asha).toMatchObject({ score: 30, band: 'medium' });
      const nia = list.people.find((p: any) => p.employeeId === people.nia!.employeeId);
      expect(nia.factors.map((f: any) => f.key)).toEqual(['no_recognition']); // 34 months in: not yet three years
      ok(await as('hr').post(`/insights/attrition/${people.asha!.employeeId}/reviews`).send({ outcome: 'action_planned', note: 'Career conversation booked' }), 201);
      const one = ok(await as('hr').get(`/insights/attrition/${people.asha!.employeeId}`));
      expect(one.reviews[0]).toMatchObject({ outcome: 'action_planned', note: 'Career conversation booked', score: 30, byName: 'Hana Test' });
      expect(one.history[0].inputs).toMatchObject({ recognitions180: 0, monthsSinceJobChange: null });
      const viewed = await pool.query(`select count(*)::int as n from audit_events where tenant_id = $1 and action = 'insights.attrition_viewed'`, [t.id]);
      expect(viewed.rows[0].n).toBeGreaterThanOrEqual(2);
      fails(await as('otherOwner').get(`/insights/attrition/${people.asha!.employeeId}`), 404);
    });

    it('checks a payroll run against each person\'s own finalised months', async () => {
      const run = async (period: string, status: string) => (await pool.query<{ id: string }>(
        `insert into payroll_runs (tenant_id, legal_entity_id, period_start, period_end, pay_date, currency, status)
         values ($1, $2, $3::date, ($3::date + interval '1 month' - interval '1 day')::date, ($3::date + interval '1 month' - interval '1 day')::date, 'INR', $4) returning id`,
        [t.id, t.legalEntityId, period, status],
      )).rows[0]!.id;
      const item = (runId: string, employeeId: string, gross: string, net: string, codes: string[]) => pool.query(
        `insert into payroll_items (tenant_id, run_id, employee_id, days_in_period, employed_days, paid_days, gross, net, lines) values ($1, $2, $3, 30, 30, 30, $4, $5, $6)`,
        [t.id, runId, employeeId, gross, net, JSON.stringify(codes.map((c) => ({ code: c, name: c, kind: 'earning', amount: '100.00', explanation: '' })))],
      );
      for (const [p, n] of [['2026-07-01', '45000.00'], ['2026-08-01', '45000.00'], ['2026-09-01', '46000.00']] as const) {
        const r = await run(p, 'computed');
        await item(r, people.asha!.employeeId, '50000.00', n, ['BASIC', 'HRA', 'PF']);
        await item(r, people.manager!.employeeId!, '80000.00', '70000.00', ['BASIC', 'HRA', 'PF']);
        await pool.query(`update payroll_runs set status = 'finalised', finalised_at = now() where id = $1`, [r]);
      }
      const current = await run('2026-10-01', 'computed');
      await item(current, people.asha!.employeeId, '65000.00', '58000.00', ['BASIC', 'HRA', 'PF', 'BONUS']);
      await item(current, people.manager!.employeeId!, '80000.00', '70100.00', ['BASIC', 'HRA', 'PF']);
      await item(current, people.nia!.employeeId!, '30000.00', '27000.00', ['BASIC']);
      fails(await as('hr').get(`/insights/payroll-runs/${current}`), 403);
      const c = ok(await as('payroll').get(`/insights/payroll-runs/${current}`));
      expect(c).toMatchObject({ checked: 3, flagged: 1, thresholdPct: 20 });
      const asha = c.people.find((p: any) => p.employeeId === people.asha!.employeeId);
      expect(asha.anomalies.map((a: any) => a.code)).toEqual(['gross_change', 'net_change', 'component_added']);
      expect(c.people.find((p: any) => p.employeeId === people.nia!.employeeId).anomalies[0].code).toBe('no_history');
      expect(c.people.find((p: any) => p.employeeId === people.manager!.employeeId)).toBeUndefined();
    });
  });
});
