import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyCompanyEmailTemplate } from '../src/modules/mail-setup/email-templates';
import { MongoService } from '../src/platform/database/mongo.service';
import { addMember, adminPool, api, createApp, createTenant, login, loginWithMfa, type TestDb, type TestTenant } from './helpers';

const day = (n: number) => new Date(Date.now() + 330 * 60_000 + n * 86_400_000).toISOString().slice(0, 10);
const fieldErrors = (body: { error?: { details?: { path: string; message: string }[] } }) => Object.fromEntries((body.error?.details ?? []).map((d) => [d.path, d.message]));

/**
 * Issue #89 through the API: the Add Employee form set up by the Super Workspace (work email domain, required and
 * hidden fields), leave by employment status (none on probation, credited on confirmation), comp-off for a weekly
 * off worked, and company email templates applied to what the mailer sends.
 */
describe('Issue #89', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let owner: string;
  let hr: { email: string; membershipId: string; token: string };

  const ok = (res: { status: number; body: unknown }, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as Record<string, any>;
  };
  const hire = (token: string, body: Record<string, unknown>) =>
    api(app, token).post('/employees').send({ legalEntityId: t.legalEntityId, dateOfJoining: day(-20), onboardingTemplateId: null, ...body });

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool, { plan: 'business' });
    owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    const h = await addMember(pool, t, { name: 'Hema HR' });
    ok(await api(app, owner).post('/hr-workspaces').send({ name: 'Delhi', code: 'DEL', kind: 'branch', features: ['leave', 'documents', 'core_hr'], adminMembershipIds: [h.membershipId] }), 201);
    hr = { ...h, token: (await login(app, h.email)).accessToken };
  });
  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('points 15 and 17: the Super Workspace sets the work email domain and the Add Employee fields; HR cannot change them', async () => {
    const start = ok(await api(app, owner).get('/employee-form'));
    expect(start).toMatchObject({ workEmailDomains: [], enforceWorkEmailDomain: false, canChange: true });
    expect(start.resolved.find((f: { key: string }) => f.key === 'firstName')).toMatchObject({ locked: true, required: true, visible: true });

    const body = { workEmailDomains: ['acme.example'], enforceWorkEmailDomain: true, fields: { lastName: { visible: true, required: true, label: 'Surname', hint: null }, grade: { visible: false, required: false, label: null, hint: null } } };
    expect((await api(app, hr.token).put('/employee-form').send(body)).status).toBe(403);
    expect(ok(await api(app, hr.token).get('/employee-form')).canChange).toBe(false);
    // A domain is needed before it can be enforced; a locked field cannot be hidden.
    expect((await api(app, owner).put('/employee-form').send({ ...body, workEmailDomains: [] })).status).toBe(422);
    expect((await api(app, owner).put('/employee-form').send({ ...body, fields: { firstName: { visible: false, required: false, label: null, hint: null } } })).status).toBe(422);
    const saved = ok(await api(app, owner).put('/employee-form').send(body));
    expect(saved.resolved.find((f: { key: string }) => f.key === 'lastName')).toMatchObject({ label: 'Surname', required: true });
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'employee_form.changed' })).toBe(1);

    const gmail = await hire(hr.token, { firstName: 'Gita', lastName: 'Rao', workEmail: 'gita@gmail.com' });
    expect(gmail.status).toBe(422);
    expect(fieldErrors(gmail.body).workEmail).toMatch(/@acme\.example/);
    const noSurname = await hire(hr.token, { firstName: 'Gita', workEmail: 'gita@acme.example' });
    expect(noSurname.status).toBe(422);
    expect(fieldErrors(noSurname.body).lastName).toMatch(/Surname is required/);
    ok(await hire(hr.token, { firstName: 'Gita', lastName: 'Rao', workEmail: 'gita@acme.example' }), 201);
  });

  it('leave items 1 and 2: no leave typed in for a new joiner, none on probation, and the days credited on confirmation', async () => {
    ok(await api(app, owner).put('/employee-form').send({ workEmailDomains: [], enforceWorkEmailDomain: false, fields: {} }));
    const el = ok(await api(app, owner).post('/leave/types').send({ code: 'EL', name: 'Earned Leave' }), 201);
    const rules = ok(await api(app, owner).get('/leave/status-rules')) as unknown as { leaveTypeId: string }[];
    expect(rules.some((r) => r.leaveTypeId === el.id)).toBe(true);
    expect((await api(app, owner).put(`/leave/status-rules/${el.id}`).send({ probation: 'no_leave', onConfirmationDays: '7.3', prorate: false })).status).toBe(422);
    ok(await api(app, owner).put(`/leave/status-rules/${el.id}`).send({ probation: 'no_leave', onConfirmationDays: '12', prorate: false }));

    const refused = await hire(owner, { firstName: 'Neel', lastName: 'New', probationMonths: 6, openingLeaveBalances: [{ leaveTypeId: el.id, days: '5' }] });
    expect(refused.status).toBe(422);
    expect(fieldErrors(refused.body).openingLeaveBalances).toBeTruthy();

    const m = await addMember(pool, t, { name: 'Neel New' });
    const e = ok(await hire(owner, { firstName: 'Neel', lastName: 'New', probationMonths: 6, membershipId: m.membershipId }), 201).employee;
    expect(e.status).toBe('probation');
    const neel = (await login(app, m.email)).accessToken;
    const apply = await api(app, neel).post('/leave/requests').send({ leaveTypeId: el.id, startDate: day(5), endDate: day(5), reason: 'Family function' });
    expect(apply.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(apply.body)).toMatch(/not_during_probation|probation/);
    expect(await pool.count('leave_ledger', { employee_id: e.id, leave_type_id: el.id })).toBe(0);

    ok(await api(app, owner).post(`/employees/${e.id}/confirm`).send({ effectiveOn: day(0) }), 201);
    const year = day(0).slice(0, 4);
    const credit = await pool.find('leave_ledger', { employee_id: e.id, leave_type_id: el.id, accrual_key: `CONF${year}` });
    expect(credit.map((x) => String(x.quantity))).toEqual(['12.00']);
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'leave.credited_on_confirmation' })).toBe(1);
  });

  it('leave item 5: comp-off for a weekly off worked, approved by HR, adds the day to the comp-off balance', async () => {
    const co = ok(await api(app, owner).post('/leave/types').send({ code: 'CO', name: 'Compensatory Off', kind: 'comp_off' }), 201);
    const m = await addMember(pool, t, { name: 'Sara Sunday' });
    const e = ok(await hire(owner, { firstName: 'Sara', lastName: 'Sunday', dateOfJoining: day(-40), probationMonths: 0, membershipId: m.membershipId }), 201).employee;
    const sara = (await login(app, m.email)).accessToken;
    let sunday = -1;
    while (new Date(`${day(sunday)}T00:00:00Z`).getUTCDay() !== 0) sunday--;
    let monday = -1;
    while (new Date(`${day(monday)}T00:00:00Z`).getUTCDay() !== 1) monday--;

    expect((await api(app, sara).post('/leave/comp-off').send({ workDate: day(monday), days: '1', reason: 'Quarter close' })).status).toBe(400);
    expect((await api(app, sara).post('/leave/comp-off').send({ workDate: day(3), days: '1', reason: 'Quarter close' })).status).toBe(400);
    const req = ok(await api(app, sara).post('/leave/comp-off').send({ workDate: day(sunday), days: '1', reason: 'Quarter close' }), 201);
    expect(req).toMatchObject({ status: 'pending', dayKind: 'weekly_off', days: '1' });
    expect((await api(app, sara).post('/leave/comp-off').send({ workDate: day(sunday), days: '1', reason: 'Quarter close again' })).status).toBe(409);
    expect((await api(app, sara).post(`/leave/comp-off/${req.id}/decide`).send({ decision: 'approve' })).status).toBe(403);

    const team = ok(await api(app, owner).get('/leave/comp-off?scope=team')) as unknown as { id: string }[];
    expect(team.map((x) => x.id)).toContain(req.id);
    expect((await api(app, owner).post(`/leave/comp-off/${req.id}/decide`).send({ decision: 'reject' })).status).toBe(422);
    expect(ok(await api(app, owner).post(`/leave/comp-off/${req.id}/decide`).send({ decision: 'approve' }))).toMatchObject({ status: 'approved' });
    const ledger = await pool.find('leave_ledger', { employee_id: e.id, leave_type_id: co.id, accrual_key: `COMP${day(sunday)}` });
    expect(ledger.map((x) => String(x.quantity))).toEqual(['1.00']);
    expect((ok(await api(app, sara).get('/leave/comp-off')) as unknown as { status: string }[])[0]!.status).toBe('approved');
  });

  it('point 13: a company imports its own email template; every email it sends uses it, and reset goes back to plain', async () => {
    const list = ok(await api(app, owner).get('/settings/email-templates'));
    expect(list.templates.map((x: { key: string }) => x.key)).toEqual(['layout', 'account', 'notification', 'recruitment', 'communication']);
    expect(list.defaultHtml).toContain('{{content}}');
    expect((await api(app, hr.token).put('/settings/email-templates/layout').send({ html: '<p>{{content}}</p>' })).status).toBe(403);
    expect((await api(app, owner).put('/settings/email-templates/layout').send({ html: '<p>no slot</p>' })).status).toBe(422);
    const saved = ok(await api(app, owner).put('/settings/email-templates/layout').send({ html: '<div class="brand"><script>x()</script><h1>{{company_name}}</h1>{{content}}</div>', subject: '[{{company_name}}] {{subject}}', sourceFileName: 'acme.html' }));
    const layout = saved.templates.find((x: { key: string }) => x.key === 'layout');
    expect(layout).toMatchObject({ active: true, version: 1, sourceFileName: 'acme.html' });
    expect(layout.html).not.toContain('script');
    ok(await api(app, owner).put('/settings/email-templates/recruitment').send({ html: '<section>Careers {{content}}</section>' }));

    const preview = ok(await api(app, owner).post('/settings/email-templates/preview').send({ html: '<b>{{company_name}}</b>{{content}}' }));
    expect(preview.html).toContain('Priya');

    const db = app.get(MongoService);
    const notice = { tenant_id: t.id, template: 'leave.approved', to_email: 'p@x.example', subject: 'Leave approved', text_body: 'Your leave <is> approved' };
    const made = await db.platform((tx) => applyCompanyEmailTemplate(tx, notice));
    expect(made.subject).toMatch(/^\[.+\] Leave approved$/);
    expect(made.html).toContain('<div class="brand"><h1>');
    expect(made.html).toContain('Your leave &lt;is&gt; approved');
    const candidate = await db.platform((tx) => applyCompanyEmailTemplate(tx, { ...notice, template: 'candidate.offer' }));
    expect(candidate.html).toMatch(/^<section>Careers /);
    // Another company's emails are never touched.
    const other = await createTenant(pool, { plan: 'business' });
    expect((await db.platform((tx) => applyCompanyEmailTemplate(tx, { ...notice, tenant_id: other.id }))).html).toBeNull();

    ok(await api(app, owner).post('/settings/email-templates/layout/test').send({ sendTo: 'owner@acme.example' }));
    const test = await pool.find('email_messages', { tenant_id: t.id, template: 'email_template.test' });
    expect(test).toHaveLength(1);
    expect(String(test[0]!.html_body)).toContain('Priya');

    ok(await api(app, owner).post('/settings/email-templates/layout/reset'));
    ok(await api(app, owner).post('/settings/email-templates/recruitment/reset'));
    expect((await db.platform((tx) => applyCompanyEmailTemplate(tx, notice))).html).toBeNull();
    expect(await pool.count('email_templates', { tenant_id: t.id })).toBe(2);
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'email_template.reset' })).toBe(2);
  });
});
