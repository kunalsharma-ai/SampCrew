import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiGatewayService } from '../src/modules/ai/ai-gateway.service';
import { AiService } from '../src/modules/ai/ai.service';
import { AnthropicProvider } from '../src/modules/ai/ai-provider';
import { WorkflowRunnerService } from '../src/modules/automation/workflow-runner.service';
import { MongoService as DatabaseService } from '../src/platform/database/mongo.service';
import { OutboxService } from '../src/platform/events/outbox.service';
import { addMember, adminPool, api, createApp, createTenant, department, login, loginWithMfa, type TestDb, type TestTenant } from './helpers';

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
  let pool: TestDb;
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
    await pool.update('outbox_events', { tenant_id: t.id }, { $set: { published_at: new Date() } });
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
      const audit = await pool.find('audit_events', { tenant_id: t.id, action: 'ai.settings_changed' });
      expect(audit[0]!.changes.after.features.assistant).toBe(true);
      expect(ok(await as('asha').get('/ai/status')).features.assistant.available).toBe(true);
    });

    it('answers without a model when no help article matches', async () => {
      const r = ok(await as('asha').post('/ai/assistant').send({ question: 'What is the canteen menu on Friday?' }));
      expect(r).toMatchObject({ answered: false, sources: [], model: null });
      expect(r.answer).toContain("couldn't find this");
      expect(stub.requests).toHaveLength(0);
      const row = (await pool.one('ai_interactions', { id: r.interactionId }))!;
      expect({ status: row.status, credits: row.credits }).toEqual({ status: 'no_sources', credits: 0 });
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
      const row = (await pool.one('ai_interactions', { id: r.interactionId }))!;
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
      const rows = await pool.find('ai_interactions', { tenant_id: t.id, status: { $in: ['refused', 'error'] } }, { sort: { created_at: 1 } });
      expect(rows.map((r) => r.status)).toEqual(['refused', 'error']);
      expect(rows[1]!.error).toBe('The AI provider returned an error (500)');
    });

    it('stops at the monthly AI credit allowance', async () => {
      await pool.update('subscriptions', { tenant_id: t.id }, { $set: { feature_overrides: { ai_credits_monthly: 3 } } });
      fails(await as('asha').post('/ai/assistant').send({ question: 'Explain provident fund rules' }), 402, 'ai_credits_used');
      expect(ok(await as('asha').get('/ai/status')).features.assistant.reason).toContain("used this month's AI credits");
      await pool.update('subscriptions', { tenant_id: t.id }, { $set: { feature_overrides: {} } });
    });

    it('lets auditors read the prompt log, audits each view, and keeps other workspaces out', async () => {
      fails(await as('asha').get('/ai/interactions'), 403);
      const list = ok(await as('auditor').get('/ai/interactions?feature=assistant')) as unknown as any[];
      expect(list.length).toBeGreaterThanOrEqual(4);
      const one = ok(await as('auditor').get(`/ai/interactions/${ids.answer}`));
      expect(one.request.user).toContain('[email]');
      expect(one).toMatchObject({ response: 'Provident fund is 12% of your basic pay [1].', helpful: true, byName: 'Asha Test' });
      expect(await pool.count('audit_events', { tenant_id: t.id, action: 'ai.interaction_viewed', resource_id: ids.answer })).toBe(1);
      fails(await as('otherOwner').get(`/ai/interactions/${ids.answer}`), 404);
    });

    it('removes prompt text after the retention period but keeps usage, and the log cannot be rewritten', async () => {
      await pool.update('ai_interactions', { id: ids.answer }, { $set: { request: null } }).catch(() => undefined);
      // Past the data rules, straight in the database, as if 40 days had gone by.
      await (await pool.database()).collection('ai_interactions').updateOne({ _id: ids.answer }, { $set: { created_at: new Date(Date.now() - 40 * 86_400_000) } });
      const n = await app.get(DatabaseService).tenant((tx) => app.get(AiService).purgeExpired(tx), { tenantId: t.id });
      expect(n).toBe(1);
      const row = (await pool.one('ai_interactions', { id: ids.answer }))!;
      expect({ request: row.request ?? null, response: row.response ?? null, credits: row.credits }).toMatchObject({ request: null, response: null, credits: 3 });
      expect(row.purged_at).toBeTruthy();
      await expect(pool.update('ai_interactions', { id: ids.answer }, { $set: { credits: 0 } })).rejects.toThrow(/cannot be changed/);
      await expect(pool.update('ai_interactions', { id: ids.answer }, { $set: { response: 'rewritten' } })).rejects.toThrow(/can only be removed/);
      await expect(pool.delete('ai_interactions', { id: ids.answer })).rejects.toThrow(/cannot be deleted/);
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
      ids.course = (await pool.insert('courses', { tenant_id: t.id, title: 'Safety induction', format: 'online' })).id;
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
      const before = (await pool.count('notifications', { tenant_id: t.id }));
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
      expect((await pool.count('notifications', { tenant_id: t.id }))).toBe(before);
      expect((await pool.count('approval_requests', { tenant_id: t.id, resource_type: 'workflow_run' }))).toBe(0);
      const a = ok(await as('hr').post(`/automation/workflows/${w.id}/activate`));
      expect(a).toMatchObject({ status: 'active', canActivate: false });
    });

    it('runs live from a domain event, waits for the manager, then finishes, once per event', async () => {
      const newbie = await addMember(pool, t, { departmentId: ops, managerId: people.manager.membershipId, name: 'Nia New' });
      people.nia = newbie;
      await hire('nia', 'Nia', { departmentId: ops, managerEmployeeId: people.manager.employeeId });
      await hire('none', 'Quinn', { departmentId: null });
      await outbox.dispatchOnce();
      const runs = await pool.find('workflow_runs', { workflow_id: ids.wf, mode: 'live' }, { sort: { created_at: 1 } });
      expect(runs).toHaveLength(2);
      ids.run = runs.find((r) => r.context['employee.name'] === 'Nia Test')!.id;
      expect(runs.find((r) => r.id === ids.run)!.context).not.toHaveProperty('employee.salary');
      await runner.runDue();
      let run = ok(await as('hr').get(`/automation/runs/${ids.run}`));
      expect(run).toMatchObject({ status: 'waiting', stepIndex: 2, canCancel: true });
      expect(run.steps.map((s: any) => `${s.stepId}:${s.status}`)).toEqual(['only_ops:succeeded', 'tell_manager:succeeded', 'manager_ok:waiting']);
      const quinn = runs.find((r) => r.context['employee.name'] === 'Quinn Test')!.id;
      expect(ok(await as('hr').get(`/automation/runs/${quinn}`))).toMatchObject({ status: 'stopped' });
      const told = await pool.find('notifications', { membership_id: people.manager.membershipId, kind: 'workflow.notice' });
      expect(told.map((r) => r.title)).toEqual(['Nia Test joins your team']);

      // The same event delivered again starts nothing new.
      const e = (await pool.one('outbox_events', { tenant_id: t.id, type: 'employee.created', 'payload.employeeId': people.nia!.employeeId }))!;
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
      const assigned = (await pool.one('course_assignments', { employee_id: people.nia!.employeeId, course_id: ids.course }))!;
      expect(assigned.assigned_by_membership_id).toBe(people.hr.membershipId);
      const audit = (await pool.one('audit_events', { tenant_id: t.id, action: 'learning.assigned' }, { sort: { created_at: -1 } }))!;
      expect(audit.actor_label).toBe('Workflow "Operations joiner" (as Hana HR)');
    });

    it('retries a failing step, fails the run with a notice, and replays it from that step', async () => {
      await pool.update('courses', { id: ids.course }, { $set: { archived_at: new Date() } });
      const m = await addMember(pool, t, { departmentId: ops, managerId: people.manager.membershipId, name: 'Omar' });
      people.omar = m;
      await hire('omar', 'Omar', { departmentId: ops, managerEmployeeId: people.manager.employeeId });
      await outbox.dispatchOnce();
      await runner.runDue();
      const id = (await pool.find('workflow_runs', { workflow_id: ids.wf })).find((x) => x.context['employee.name'] === 'Omar Test')!.id;
      const inbox = ok(await as('manager').get('/approvals/inbox')) as unknown as any[];
      ok(await as('manager').post(`/approvals/${inbox.find((x) => x.resourceType === 'workflow_run').id}/approve`).send({}));
      await runner.runDue();
      let run = ok(await as('hr').get(`/automation/runs/${id}`));
      expect(run).toMatchObject({ status: 'failed', canRetry: true, error: 'The course no longer exists or is archived' });
      expect((ok(await as('hr').get('/automation/runs?status=failed')) as unknown as any[]).map((r) => r.id)).toContain(id);
      const notice = await pool.find('notifications', { membership_id: people.hr.membershipId, kind: 'workflow.failed' });
      expect(notice[0]!.title).toBe('Workflow "Operations joiner" failed at step 4');
      await pool.update('courses', { id: ids.course }, { $set: { archived_at: null } });
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
      const r = (await pool.one('workflow_runs', { workflow_id: w.id, mode: 'live' }))!;
      expect(r.status).toBe('waiting');
      expect(new Date(r.wake_at).getTime()).toBeGreaterThan(Date.now() + 47 * 3_600_000);
      await runner.runDue();
      expect((await pool.one('workflow_runs', { id: r.id }))!.status).toBe('waiting');
      await pool.update('workflow_runs', { id: r.id }, { $set: { wake_at: new Date(Date.now() - 1000) } });
      await runner.runDue();
      const done = ok(await as('hr').get(`/automation/runs/${r.id}`));
      expect(done.status).toBe('succeeded');
      expect(done.steps.at(-1).detail).toBe('Notified 2 people: "Check documents for Della Test"');
      ok(await as('hr').post(`/automation/workflows/${w.id}/archive`));
    });

    it('pauses itself when its owner loses permission, and keeps other workspaces out', async () => {
      // Take the owner's HR role away; the next run notices.
      const hrRole = (await pool.one('roles', { tenant_id: t.id, key: 'hr_admin' }))!;
      await pool.delete('role_assignments', { membership_id: people.hr.membershipId, role_id: hrRole.id });
      const e = ok(await as('hr2').post('/employees').send({ legalEntityId: t.legalEntityId, firstName: 'Ravi', lastName: 'Test', dateOfJoining: '2024-01-01', probationMonths: 0, departmentId: ops, managerEmployeeId: people.manager.employeeId, onboardingTemplateId: null }), 201);
      await outbox.dispatchOnce();
      await runner.runDue();
      const run = (await pool.one('workflow_runs', { workflow_id: ids.wf, subject_employee_id: e.employee.id }))!;
      expect(run.status).toBe('failed');
      expect(run.error).toContain('no longer has permission');
      const w = ok(await as('hr2').get(`/automation/workflows/${ids.wf}`));
      expect(w).toMatchObject({ status: 'paused', statusReason: 'The workflow owner no longer has permission to manage workflows, so the workflow was paused.' });
      await pool.insert('role_assignments', { tenant_id: t.id, membership_id: people.hr.membershipId, role_id: hrRole.id });
      fails(await as('otherOwner').get(`/automation/workflows/${ids.wf}`), 404);
      fails(await as('otherOwner').get(`/automation/runs/${ids.run}`), 404);
    });

    it('keeps versions immutable and drafts workflows from plain English with AI', async () => {
      await expect(pool.update('workflow_versions', { workflow_id: ids.wf }, { $set: { definition: {} } })).rejects.toThrow(/cannot be changed/);
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
      const joined = new Date();
      joined.setUTCMonth(joined.getUTCMonth() - 40);
      const fortyMonthsAgo = joined.toISOString().slice(0, 10);
      await pool.update('employees', { id: people.asha!.employeeId }, { $set: { date_of_joining: fortyMonthsAgo } });
      await pool.update('employment_records', { employee_id: people.asha!.employeeId }, { $set: { effective_from: fortyMonthsAgo } });
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
      expect(await pool.count('audit_events', { tenant_id: t.id, action: 'insights.attrition_viewed' })).toBeGreaterThanOrEqual(2);
      fails(await as('otherOwner').get(`/insights/attrition/${people.asha!.employeeId}`), 404);
    });

    it('checks a payroll run against each person\'s own finalised months', async () => {
      const monthEnd = (start: string) => {
        const [y, m] = start.split('-').map(Number) as [number, number];
        return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      };
      const run = async (period: string, status: string) => (await pool.insert('payroll_runs', {
        tenant_id: t.id, legal_entity_id: t.legalEntityId, period_start: period, period_end: monthEnd(period), pay_date: monthEnd(period), currency: 'INR', status,
      })).id as string;
      const item = (runId: string, employeeId: string, gross: string, net: string, codes: string[]) => pool.insert('payroll_items', {
        tenant_id: t.id, run_id: runId, employee_id: employeeId, days_in_period: 30, employed_days: 30, paid_days: 30, gross, net,
        lines: codes.map((c) => ({ code: c, name: c, kind: 'earning', amount: '100.00', explanation: '' })),
      });
      for (const [p, n] of [['2026-07-01', '45000.00'], ['2026-08-01', '45000.00'], ['2026-09-01', '46000.00']] as const) {
        const r = await run(p, 'computed');
        await item(r, people.asha!.employeeId, '50000.00', n, ['BASIC', 'HRA', 'PF']);
        await item(r, people.manager!.employeeId!, '80000.00', '70000.00', ['BASIC', 'HRA', 'PF']);
        await pool.update('payroll_runs', { id: r }, { $set: { status: 'finalised', finalised_at: new Date() } });
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
