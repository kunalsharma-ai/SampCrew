import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mongo } from '@crew/db';
const { HELP_LIBRARY_ARTICLES, HELP_LIBRARY_CATEGORIES } = mongo;
import { hashPassword } from '../src/platform/auth/crypto';
import { currentTotp } from '../src/platform/auth/mfa';
import { scoreArticle } from '../src/modules/help/help-content.service';
import { addMember, adminPool, api, createApp, createTenant, login, loginWithMfa, PASSWORD, type TestDb, type TestTenant } from './helpers';

/**
 * Help & Support: content filtered per level, feature and permission; search; activity (recently viewed, helpful,
 * tutorial progress); Raise a Query with routing to the level above, statuses, replies, notes, assignment, escalation
 * up to the Console Admin team, reopen and rating; attachments; isolation between people and companies; the Console's
 * content manager; and the feature parts that switch it off.
 */
describe('help centre', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let other: TestTenant;
  let space: string;
  let spaceB: string;
  const tok: Record<string, string> = {};
  const m: Record<string, { email: string; membershipId: string; userId: string }> = {};
  const as = (who: string) => api(app, tok[who]);
  const ok = (res: { status: number; body: unknown }, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return res.body as Record<string, any>;
  };
  const stamp = Date.now();

  async function consoleToken(role: string, name: string) {
    const email = `${role}.help.${stamp}.${name.split(' ')[0]!.toLowerCase()}@sampledge.test`;
    await pool.insert('platform_admins', { email, full_name: name, password_hash: await hashPassword(PASSWORD), role });
    const res = await api(app).post('/platform/auth/login').send({ email, password: PASSWORD });
    const setup = await api(app, res.body.accessToken).post('/platform/auth/mfa/setup');
    return (await api(app, res.body.accessToken).post('/platform/auth/mfa/enable').send({ code: currentTotp(setup.body.secret) })).body.accessToken as string;
  }

  async function employeeFor(tenant: TestTenant, membershipId: string, code: string, hrWorkspaceId: string | null) {
    await pool.insert('employees', {
      tenant_id: tenant.id, employee_code: code, first_name: code, last_name: 'Person', date_of_joining: '2024-01-08', status: 'active',
      current_legal_entity_id: tenant.legalEntityId, membership_id: membershipId, hr_workspace_id: hrWorkspaceId, phone: '+91 98200 11122',
    });
  }

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    other = await createTenant(pool);
    await pool.update('tenants', { id: t.id }, { $set: { name: 'Acme Works' } });
    tok.owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    m.hari = await addMember(pool, t, { name: 'Hari Branch' });
    m.bina = await addMember(pool, t, { name: 'Bina Other' });
    m.esha = await addMember(pool, t, { name: 'Esha Employee' });
    m.cleo = await addMember(pool, t, { name: 'Cleo Central' });
    m.eve = await addMember(pool, t, { name: 'Eve Elsewhere' });
    m.otto = await addMember(pool, other, { name: 'Otto Other' });
    const a = ok(await api(app, tok.owner).post('/hr-workspaces').send({ name: 'Mumbai Branch', features: ['leave', 'attendance_basic'], adminMembershipIds: [m.hari.membershipId] }), 201);
    const b = ok(await api(app, tok.owner).post('/hr-workspaces').send({ name: 'Delhi Branch', features: ['leave'], adminMembershipIds: [m.bina.membershipId] }), 201);
    space = a.id;
    spaceB = b.id;
    await employeeFor(t, m.esha.membershipId, 'ESHA', space);
    await employeeFor(t, m.cleo.membershipId, 'CLEO', null);
    await employeeFor(t, m.eve.membershipId, 'EVE', spaceB);
    tok.hari = (await loginWithMfa(app, pool, m.hari.email)).accessToken;
    tok.bina = (await loginWithMfa(app, pool, m.bina.email)).accessToken;
    for (const who of ['esha', 'cleo', 'eve']) tok[who] = (await login(app, m[who]!.email)).accessToken;
    tok.otto = (await login(app, m.otto.email)).accessToken;
    tok.sana = await consoleToken('support', 'Sana Support');
    tok.rahul = await consoleToken('super_admin', 'Rahul Console');
    tok.viewer = await consoleToken('viewer', 'Vic Viewer');
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  describe('the built-in library', () => {
    it('is seeded: every category and article, with unique slugs, links inside the app and steps for guides', async () => {
      const slugs = HELP_LIBRARY_ARTICLES.map((x) => x.slug);
      expect(new Set(slugs).size).toBe(slugs.length);
      const keys = new Set(HELP_LIBRARY_CATEGORIES.map((c) => c.key));
      for (const art of HELP_LIBRARY_ARTICLES) {
        expect(keys.has(art.category), art.slug).toBe(true);
        if (['guide', 'tutorial', 'quickstart'].includes(art.kind)) expect(art.steps.length, art.slug).toBeGreaterThan(0);
        else expect(art.body.length, art.slug).toBeGreaterThan(40);
        for (const r of art.related) expect(slugs, `${art.slug} -> ${r}`).toContain(r);
        if (art.href) expect(art.href.startsWith('/'), art.slug).toBe(true);
      }
      expect(HELP_LIBRARY_ARTICLES.length).toBeGreaterThanOrEqual(120);
      expect(await pool.count('help_articles', { builtin_key: { $ne: null } })).toBe(HELP_LIBRARY_ARTICLES.length);
      expect(await pool.count('help_categories', {})).toBe(HELP_LIBRARY_CATEGORIES.length);
      expect((await pool.one('help_query_categories', { key: 'other' }))).toMatchObject({ active: true, label: 'Other' });
    });

    it('scores titles and keywords above body text, and needs every word', () => {
      const art = { title: 'Apply for leave', summary: 'Ask for time off.', body: 'Open Leave.', keywords: ['time off', 'vacation'], steps: [] };
      expect(scoreArticle(art, 'Leave management', 'apply leave')).toBeGreaterThan(scoreArticle(art, 'Leave management', 'open'));
      expect(scoreArticle(art, 'Leave', 'vacation')).toBeGreaterThan(0);
      expect(scoreArticle(art, 'Leave', 'payroll')).toBe(0);
    });
  });

  describe('what each level sees', () => {
    it('Employee Workspace sees its own content only; HR Workspace adds HR; Super Workspace adds Super', async () => {
      const emp = ok(await as('esha').get('/help'));
      expect(emp).toMatchObject({ level: 'employee', levelLabel: 'Employee Workspace', queries: { raise: true, inbox: false } });
      expect(emp.quickstarts.map((a: any) => a.slug)).toEqual(['quickstart-employee']);
      const empCats = emp.categories.map((c: any) => c.key);
      expect(empCats).toEqual(expect.arrayContaining(['account', 'troubleshooting', 'help-support']));
      expect(empCats).not.toContain('employees');
      expect(empCats).not.toContain('console-start');
      expect(empCats).not.toContain('billing');

      const hr = ok(await as('hari').get('/help'));
      expect(hr).toMatchObject({ level: 'hr', levelLabel: 'HR Workspace', queries: { inbox: true } });
      expect(hr.quickstarts.map((a: any) => a.slug)).toEqual(['quickstart-hr', 'quickstart-employee']);
      expect(hr.categories.map((c: any) => c.key)).toContain('hr-workspaces');

      const sup = ok(await as('owner').get('/help'));
      expect(sup.level).toBe('super');
      expect(sup.quickstarts.map((a: any) => a.slug)).toEqual(['quickstart-super', 'quickstart-hr', 'quickstart-employee']);
      expect(sup.categories.map((c: any) => c.key)).toEqual(expect.arrayContaining(['billing', 'workspace-settings']));
      expect(sup.categories.map((c: any) => c.key)).not.toContain('console-help');
    });

    it('an article for another level, a feature that is off or a permission not held is not found', async () => {
      expect((await as('esha').get('/help/articles/create-hr-workspace')).status).toBe(404);
      expect((await as('esha').get('/help/articles/quickstart-console')).status).toBe(404);
      // Payroll runs need payroll:read even for HR content.
      expect((await as('esha').get('/help/articles/run-payroll')).status).toBe(404);
      ok(await as('owner').get('/help/articles/run-payroll'));
      ok(await as('owner').get('/help/articles/create-hr-workspace'));
      // Documents articles need documents:read, which arrives with the document management module.
      const docs = await as('owner').get('/help/articles/my-documents');
      expect([200, 404]).toContain(docs.status);
      // The Console sees only Console Admin content.
      ok(await api(app, tok.viewer).get('/platform/help/articles/quickstart-console'));
      expect((await api(app, tok.viewer).get('/platform/help/articles/how-to-apply-leave')).status).toBe(404);
      expect(ok(await api(app, tok.viewer).get('/platform/help')).categories.map((c: any) => c.key)).toEqual(expect.arrayContaining(['console-start', 'console-help']));
    });

    it('a category shows its subcategories and only articles the viewer may see', async () => {
      const gs = ok(await as('hari').get('/help/categories/getting-started'));
      expect(gs.subcategories.map((c: any) => c.key)).toEqual(['getting-started-employee', 'getting-started-hr']);
      const sub = ok(await as('hari').get('/help/categories/getting-started-hr'));
      expect(sub.parent.key).toBe('getting-started');
      expect((await as('esha').get('/help/categories/getting-started-hr')).status).toBe(404);
    });
  });

  describe('search and activity', () => {
    it('finds feature names, questions and error messages, filtered by kind and category', async () => {
      const leave = ok(await as('esha').get('/help/search').query({ q: 'apply leave' }));
      expect(leave.items[0].slug).toBe('how-to-apply-leave');
      expect(leave.items[0].snippet.length).toBeGreaterThan(10);
      const err = ok(await as('esha').get('/help/search').query({ q: '403 forbidden' }));
      expect(err.items[0].slug).toBe('no-access-page');
      const limit = ok(await as('hari').get('/help/search').query({ q: 'workspace_limit_reached' }));
      expect(limit.items.map((a: any) => a.slug)).toContain('workspace-limits');
      const faqs = ok(await as('esha').get('/help/search').query({ q: 'leave', kind: 'faq' }));
      expect(faqs.items.every((a: any) => a.kind === 'faq')).toBe(true);
      const inCat = ok(await as('esha').get('/help/search').query({ category: 'getting-started' }));
      expect(inCat.items.map((a: any) => a.slug)).toContain('quickstart-employee');
      // Help for one page: articles about that page come first.
      const page = ok(await as('esha').get('/help/search').query({ page: '/leave' }));
      expect(page.items[0].href).toBe('/leave');
      // An employee never finds HR-only content.
      expect(ok(await as('esha').get('/help/search').query({ q: 'create hr workspace' })).items.map((a: any) => a.slug)).not.toContain('create-hr-workspace');
    });

    it('records views (recently viewed and popular), helpful votes and tutorial progress', async () => {
      const a = ok(await as('esha').get('/help/articles/how-to-apply-leave'));
      expect(a.stepList.length).toBe(5);
      expect(a.related.map((r: any) => r.slug)).toContain('cancel-leave');
      expect(a.mine).toMatchObject({ views: 1, helpful: null, doneSteps: [] });
      ok(await as('esha').get('/help/articles/how-to-apply-leave'));
      const fb = ok(await as('esha').put('/help/articles/how-to-apply-leave/feedback').send({ helpful: true }));
      expect(fb).toMatchObject({ yes: 1, no: 0, helpful: true });
      ok(await as('cleo').put('/help/articles/how-to-apply-leave/feedback').send({ helpful: false }));
      let p = ok(await as('esha').put('/help/articles/how-to-apply-leave/progress').send({ step: 0, done: true }));
      p = ok(await as('esha').put('/help/articles/how-to-apply-leave/progress').send({ step: 2, done: true }));
      expect(p).toMatchObject({ doneSteps: [0, 2], total: 5, complete: false });
      p = ok(await as('esha').put('/help/articles/how-to-apply-leave/progress').send({ step: 0, done: false }));
      expect(p.doneSteps).toEqual([2]);
      expect((await as('esha').put('/help/articles/how-to-apply-leave/progress').send({ step: 9, done: true })).status).toBe(400);
      const again = ok(await as('esha').get('/help/articles/how-to-apply-leave'));
      expect(again.mine).toMatchObject({ views: 3, helpful: true, doneSteps: [2] });
      expect(again.helpful).toEqual({ yes: 1, no: 1 });
      const home = ok(await as('esha').get('/help'));
      expect(home.recent[0].slug).toBe('how-to-apply-leave');
      expect(home.popular[0].slug).toBe('how-to-apply-leave');
      // Activity stays inside the company.
      expect(ok(await as('otto').get('/help')).recent).toEqual([]);
    });
  });

  describe('Raise a Query', () => {
    let q1: string;

    it('the form has the categories with Other last and the contact details from the account', async () => {
      const f = ok(await as('esha').get('/help/queries/form'));
      expect(f.categories.at(-1)).toMatchObject({ key: 'other', label: 'Other' });
      expect(f.contact).toMatchObject({ name: 'Esha Employee', level: 'employee', phone: '+91 98200 11122', routesTo: 'Mumbai Branch HR Workspace' });
      expect(f.settings).toMatchObject({ attachments: true, reopenDays: 14 });
    });

    it('an Employee Workspace query goes to the HR Workspace that looks after them, with a ticket ID and notices', async () => {
      const shot = ok(await as('esha').post('/help/files').attach('file', Buffer.from('steps to reproduce'), { filename: 'steps.txt', contentType: 'text/plain' }), 201);
      const body = { categoryKey: 'other', subject: 'My leave balance is zero', description: 'Casual leave shows zero since Monday although I have not taken any.', page: 'Leave', fileIds: [shot.id], clientId: 'c1' };
      const r = ok(await as('esha').post('/help/queries').send(body), 201);
      expect(r).toMatchObject({ ticketId: 'HQ-00001', number: 1, created: true });
      q1 = r.id;
      // A retried submit does not raise it twice.
      expect(ok(await as('esha').post('/help/queries').send(body), 201)).toMatchObject({ id: q1, created: false });
      const row = (await pool.one('help_queries', { id: q1 }))!;
      expect(row).toMatchObject({ route: 'hr', hr_workspace_id: space, status: 'open', raiser_name: 'Esha Employee', raiser_level: 'employee', raiser_workspace: 'Mumbai Branch', category_label: 'Other', raiser_email: m.esha.email });
      // Nobody is notified about what they did themselves.
      expect(await pool.find('notifications', { membership_id: m.esha.membershipId, kind: 'help.query_submitted' })).toHaveLength(0);
      expect(await pool.find('notifications', { membership_id: m.hari.membershipId, kind: 'help.query_new' })).toHaveLength(1);
      // The other HR Workspace is not told and cannot open it.
      expect(await pool.find('notifications', { membership_id: m.bina.membershipId, kind: 'help.query_new' })).toHaveLength(0);
      expect((await as('bina').get(`/help/inbox/${q1}`)).status).toBe(404);
      expect((await as('cleo').get(`/help/queries/${q1}`)).status).toBe(404);
      expect((await as('otto').get(`/help/queries/${q1}`)).status).toBe(404);
      const mine = ok(await as('esha').get('/help/queries'));
      expect(mine.items[0]).toMatchObject({ ticketId: 'HQ-00001', status: 'open', statusLabel: 'Open', routeLabel: 'HR Workspace', hrWorkspace: { name: 'Mumbai Branch' } });
      expect(mine.counts).toMatchObject({ all: 1, open: 1 });
      // The attachment: the raiser and the handler may download it, nobody else.
      expect(ok(await as('esha').post(`/help/queries/${q1}/files/${shot.id}/link`), 201).path).toContain('/files/comm/');
      ok(await as('hari').post(`/help/queries/${q1}/files/${shot.id}/link`), 201);
      expect((await as('cleo').post(`/help/queries/${q1}/files/${shot.id}/link`)).status).toBe(404);
      // Someone else's upload cannot be attached.
      const foreign = ok(await as('cleo').post('/help/files').attach('file', Buffer.from('x'), { filename: 'x.txt', contentType: 'text/plain' }), 201);
      expect((await as('esha').post('/help/queries').send({ ...body, clientId: 'c2', fileIds: [foreign.id] })).status).toBe(400);
    });

    it('the HR Workspace assigns, replies (Awaiting User Response), adds an internal note; the employee replies back', async () => {
      const inbox = ok(await as('hari').get('/help/inbox'));
      expect(inbox.items.map((x: any) => x.id)).toEqual([q1]);
      expect(inbox.waiting).toBe(1);
      expect(ok(await as('bina').get('/help/inbox')).items).toEqual([]);
      const d = ok(await as('hari').get(`/help/inbox/${q1}`));
      expect(d.can).toMatchObject({ handle: true, escalate: true });
      expect(d.assignees.map((x: any) => x.name)).toEqual(expect.arrayContaining(['Hari Branch', 'Owner Person']));
      let after = ok(await as('hari').put(`/help/inbox/${q1}/assignee`).send({ assigneeId: m.hari.membershipId }));
      expect(after).toMatchObject({ status: 'in_progress', assignee: { name: 'Hari Branch' } });
      expect((await as('hari').put(`/help/inbox/${q1}/assignee`).send({ assigneeId: m.bina.membershipId })).status).toBe(400);
      ok(await as('hari').post(`/help/inbox/${q1}/replies`).send({ body: 'Checked: accrual starts next month.', internal: true }), 201);
      after = ok(await as('hari').post(`/help/inbox/${q1}/replies`).send({ body: 'Your casual leave accrues monthly. Can you confirm your joining date?' }), 201);
      expect(after.status).toBe('awaiting_user');
      expect(await pool.find('notifications', { membership_id: m.esha.membershipId, kind: 'help.query_replied' })).toHaveLength(1);
      // The employee never sees the internal note, and cannot write one.
      const seen = ok(await as('esha').get(`/help/queries/${q1}`));
      expect(seen.messages.map((x: any) => x.kind)).not.toContain('note');
      expect(seen.messages.filter((x: any) => x.kind === 'message').at(-1)).toMatchObject({ author: { name: 'Hari Branch', levelLabel: 'HR Workspace' }, fromRaiser: false });
      expect(seen.status).toBe('awaiting_user');
      expect((await as('esha').post(`/help/queries/${q1}/replies`).send({ body: 'note', internal: true })).status).toBe(403);
      expect((await as('esha').put(`/help/queries/${q1}/status`).send({ status: 'resolved' })).status).toBe(403);
      const back = ok(await as('esha').post(`/help/queries/${q1}/replies`).send({ body: 'I joined on 8 January 2024.' }), 201);
      expect(back.status).toBe('in_progress');
      expect(await pool.find('notifications', { membership_id: m.hari.membershipId, kind: 'help.query_reply' })).toHaveLength(1);
    });

    it('resolved: the employee reopens it within the allowed days, then closes and rates it', async () => {
      const res = ok(await as('hari').put(`/help/inbox/${q1}/status`).send({ status: 'resolved', note: 'Balance corrected.' }));
      expect(res).toMatchObject({ status: 'resolved', statusLabel: 'Resolved' });
      expect(await pool.find('notifications', { membership_id: m.esha.membershipId, kind: 'help.query_resolved' })).toHaveLength(1);
      let mine = ok(await as('esha').get(`/help/queries/${q1}`));
      expect(mine.can).toMatchObject({ reopen: true, rate: true });
      mine = ok(await as('esha').put(`/help/queries/${q1}/status`).send({ status: 'open', note: 'Still zero today.' }));
      expect(mine.status).toBe('in_progress');
      ok(await as('hari').put(`/help/inbox/${q1}/status`).send({ status: 'resolved' }));
      mine = ok(await as('esha').put(`/help/queries/${q1}/status`).send({ status: 'closed' }));
      expect(mine.status).toBe('closed');
      expect((await as('esha').post(`/help/queries/${q1}/replies`).send({ body: 'one more thing' })).status).toBe(409);
      expect(ok(await as('esha').post(`/help/queries/${q1}/rating`).send({ rating: 5, comment: 'Quick answer' }))).toMatchObject({ rating: 5 });
      expect((await pool.count('audit_events', { tenant_id: t.id, resource_id: q1 }))).toBeGreaterThanOrEqual(6);
    });

    it('escalation: HR Workspace -> Super Workspace -> SampCrew Support in the Console', async () => {
      const r = ok(await as('esha').post('/help/queries').send({ categoryKey: 'attendance', subject: 'Punch refused at the warehouse', description: 'The app says I am outside the geofence at the warehouse gate.' }), 201);
      ok(await as('hari').post(`/help/inbox/${r.id}/escalate`).send({ reason: 'The geofence is set by the Super Workspace' }));
      let row = (await pool.one('help_queries', { id: r.id }))!;
      expect(row).toMatchObject({ route: 'super', status: 'open', hr_workspace_id: null });
      expect((await as('hari').get(`/help/inbox/${r.id}`)).status).toBe(404);
      expect(await pool.find('notifications', { membership_id: t.ownerMembershipId, kind: 'help.query_new' })).toHaveLength(1);
      ok(await as('owner').post(`/help/inbox/${r.id}/escalate`).send({ reason: 'Looks like a SampCrew location bug' }));
      row = (await pool.one('help_queries', { id: r.id }))!;
      expect(row.route).toBe('console');
      // The Console Admin team picks it up.
      const list = ok(await api(app, tok.sana).get('/platform/help/queries'));
      expect(list.items.find((x: any) => x.id === r.id)).toMatchObject({ ticketId: 'HQ-00002', workspace: { name: 'Acme Works' }, raisedBy: { name: 'Esha Employee', levelLabel: 'Employee Workspace' } });
      expect(ok(await api(app, tok.sana).get('/platform/help/queries/waiting')).waiting).toBeGreaterThanOrEqual(1);
      const admins = ok(await api(app, tok.sana).get(`/platform/help/queries/${r.id}`)).assignees.map((x: any) => x.name);
      expect(admins).toEqual(expect.arrayContaining(['Sana Support', 'Rahul Console']));
      const rahul = (await pool.one('platform_admins', { full_name: 'Rahul Console' }))!;
      expect(ok(await api(app, tok.sana).put(`/platform/help/queries/${r.id}/assignee`).send({ assigneeId: rahul.id }))).toMatchObject({ status: 'in_progress', assignee: { name: 'Rahul Console' } });
      const reply = ok(await api(app, tok.rahul).post(`/platform/help/queries/${r.id}/replies`).send({ body: 'Fixed the geofence radius check. Please try again.', status: 'resolved' }), 201);
      expect(reply.status).toBe('resolved');
      const seen = ok(await as('esha').get(`/help/queries/${r.id}`));
      expect(seen.messages.filter((x: any) => x.kind === 'message').at(-1).author).toMatchObject({ name: 'Rahul Console', levelLabel: 'Console Admin', workspace: 'SampCrew Support' });
      // The workspace sees the team, not the admin's name, as the assignee.
      expect(seen.assignee.name).toBe('SampCrew Support');
      // A viewer Console role cannot answer queries; a workspace cannot reach the Console routes.
      expect((await api(app, tok.viewer).get('/platform/help/queries')).status).toBe(403);
      expect((await as('owner').get('/platform/help/queries')).status).toBe(401);
    });

    it('routes by level: HR Workspace to Super Workspace, Super Workspace and SampCrew categories to the Console, central employees without company HR to Super', async () => {
      const hr = ok(await as('hari').post('/help/queries').send({ categoryKey: 'leave', subject: 'Allocate leave to a new joiner', description: 'How do I give casual leave to someone who joined today?' }), 201);
      expect((await pool.one('help_queries', { id: hr.id }))!.route).toBe('super');
      const sup = ok(await as('owner').post('/help/queries').send({ categoryKey: 'other', subject: 'Custom report request', description: 'Can SampCrew add a headcount by grade report?' }), 201);
      expect((await pool.one('help_queries', { id: sup.id }))!.route).toBe('console');
      const bug = ok(await as('esha').post('/help/queries').send({ categoryKey: 'bug', subject: 'Payslip PDF is blank', description: 'Printing my October payslip gives an empty page.' }), 201);
      expect((await pool.one('help_queries', { id: bug.id }))!.route).toBe('console');
      const central = ok(await as('cleo').post('/help/queries').send({ categoryKey: 'other', subject: 'Who is my HR contact?', description: 'I am not sure who to ask about my contract.' }), 201);
      expect((await pool.one('help_queries', { id: central.id }))).toMatchObject({ route: 'super', hr_workspace_id: null });
      expect(ok(await as('owner').get('/help/inbox')).items.map((x: any) => x.id)).toEqual(expect.arrayContaining([hr.id, central.id]));
      // Ticket numbers are per company.
      const otto = ok(await as('otto').post('/help/queries').send({ categoryKey: 'other', subject: 'First question here', description: 'Our first query in this company.' }), 201);
      expect(otto.ticketId).toBe('HQ-00001');
      expect((await as('esha').post('/help/queries').send({ categoryKey: 'nope', subject: 'Bad category', description: 'This category does not exist.' })).status).toBe(400);
      expect((await as('esha').get('/help/inbox')).status).toBe(403);
    });
  });

  describe('public Help & Support (before signing in)', () => {
    it('anyone reads feature briefs, FAQs, articles and guides; nothing for a level, a feature or a draft', async () => {
      const home = ok(await api(app).get('/public/help'));
      expect(home.features.length).toBeGreaterThanOrEqual(10);
      expect(home.features[0]).toMatchObject({ kind: 'feature', audiences: ['public'] });
      expect(home.features[0].body.length).toBeGreaterThan(40);
      expect(home.faqs.map((f: any) => f.slug)).toEqual(expect.arrayContaining(['public-forgot-password', 'public-show-password']));
      expect(home.articles.map((a: any) => a.slug)).toEqual(expect.arrayContaining(['sampcrew-overview', 'our-offerings', 'our-facilities']));
      expect(home.categories.map((c: any) => c.key)).toEqual(expect.arrayContaining(['our-features', 'about-sampcrew']));
      // Only public content: no level's articles and no categories of the app.
      const all = [...home.features, ...home.faqs, ...home.articles, ...home.guides];
      expect(all.every((a: any) => a.audiences.includes('public'))).toBe(true);
      expect(home.categories.map((c: any) => c.key)).not.toContain('leave');

      const art = ok(await api(app).get('/public/help/articles/our-offerings'));
      expect(art).toMatchObject({ kind: 'article', icon: 'briefcase' });
      expect(art.mine).toBeUndefined();
      expect((await api(app).get('/public/help/articles/how-to-apply-leave')).status).toBe(404);
      expect((await api(app).get('/public/help/articles/quickstart-console')).status).toBe(404);
      const found = ok(await api(app).get('/public/help/search').query({ q: 'forgot password' }));
      expect(found.items[0].slug).toMatch(/^public-(forgot-password|reset-password-guide)$/);
      expect(found.items.every((i: any) => i.audiences.includes('public'))).toBe(true);
    });

    it('a Console Admin publishes a feature brief for everyone; a feature-gated or draft one stays off the public page', async () => {
      const cats = ok(await api(app, tok.rahul).get('/platform/help/manage')).categories;
      const features = cats.find((c: any) => c.key === 'our-features');
      const brief = { slug: `brief-${stamp}`, categoryId: features.id, kind: 'feature', title: 'Canteen menus', body: 'Post the weekly canteen menu so everybody knows what is for lunch today.', audiences: ['public'], icon: 'heart', status: 'published' };
      // A feature brief needs its text.
      expect((await api(app, tok.rahul).post('/platform/help/manage/articles').send({ ...brief, body: '' })).status).toBe(400);
      ok(await api(app, tok.rahul).post('/platform/help/manage/articles').send(brief), 201);
      const home = ok(await api(app).get('/public/help'));
      expect(home.features.find((f: any) => f.slug === `brief-${stamp}`)).toMatchObject({ title: 'Canteen menus', icon: 'heart' });
      // Signed-in people see public content in their help centre too.
      expect(ok(await as('esha').get(`/help/articles/brief-${stamp}`)).title).toBe('Canteen menus');
      ok(await api(app, tok.rahul).post('/platform/help/manage/articles').send({ ...brief, slug: `gated-${stamp}`, feature: 'payroll' }), 201);
      ok(await api(app, tok.rahul).post('/platform/help/manage/articles').send({ ...brief, slug: `draft-${stamp}`, status: 'draft' }), 201);
      expect((await api(app).get(`/public/help/articles/gated-${stamp}`)).status).toBe(404);
      expect((await api(app).get(`/public/help/articles/draft-${stamp}`)).status).toBe(404);
    });
  });

  describe('Console content manager', () => {
    it('creates a category and a draft article, publishes it for one level, edits a built-in one and keeps it on resync', async () => {
      expect((await api(app, tok.sana).get('/platform/help/manage')).status).toBe(403);
      const all = ok(await api(app, tok.rahul).get('/platform/help/manage'));
      expect(all.articles.length).toBeGreaterThanOrEqual(HELP_LIBRARY_ARTICLES.length);
      expect(all.articles.find((a: any) => a.slug === 'how-to-apply-leave')).toMatchObject({ views: 3, yes: 1, no: 1, builtin: true });
      const cat = ok(await api(app, tok.rahul).post('/platform/help/manage/categories').send({ key: `canteen-${stamp}`, name: 'Canteen', description: 'Meals at work', icon: 'heart', audiences: ['employee'], sort: 500 }), 201);
      const body = { slug: `canteen-menu-${stamp}`, categoryId: cat.id, kind: 'faq', title: 'Where is the canteen menu?', body: 'The weekly menu is posted every Monday in Announcements.', audiences: ['employee'], keywords: ['lunch', 'food'], status: 'draft' };
      const art = ok(await api(app, tok.rahul).post('/platform/help/manage/articles').send(body), 201);
      expect((await as('esha').get(`/help/articles/canteen-menu-${stamp}`)).status).toBe(404);
      ok(await api(app, tok.rahul).put(`/platform/help/manage/articles/${art.id}/status`).send({ status: 'published' }));
      expect(ok(await as('esha').get(`/help/articles/canteen-menu-${stamp}`)).title).toBe('Where is the canteen menu?');
      expect(ok(await as('esha').get('/help/search').query({ q: 'lunch' })).items[0].slug).toBe(`canteen-menu-${stamp}`);
      // A guide needs steps; a slug cannot be used twice.
      expect((await api(app, tok.rahul).post('/platform/help/manage/articles').send({ ...body, slug: `g-${stamp}`, kind: 'guide' })).status).toBe(400);
      expect((await api(app, tok.rahul).post('/platform/help/manage/articles').send(body)).status).toBe(409);

      const builtin = all.articles.find((a: any) => a.slug === 'cancel-leave');
      const full = ok(await api(app, tok.rahul).get(`/platform/help/manage/articles/${builtin.id}`));
      ok(await api(app, tok.rahul).put(`/platform/help/manage/articles/${builtin.id}`).send({ ...full, title: 'Change or cancel your leave' }));
      await pool.platform((tx) => import('@crew/db').then(({ mongo }) => mongo.syncHelpLibraryMongo(tx)));
      expect((await pool.one('help_articles', { id: builtin.id }))!.title).toBe('Change or cancel your leave');
      // Deleting a built-in one keeps it deleted after a resync.
      ok(await api(app, tok.rahul).delete(`/platform/help/manage/articles/${builtin.id}`));
      await pool.platform((tx) => import('@crew/db').then(({ mongo }) => mongo.syncHelpLibraryMongo(tx)));
      expect((await as('esha').get('/help/articles/cancel-leave')).status).toBe(404);
      expect((await api(app, tok.rahul).delete(`/platform/help/manage/categories/${cat.id}`)).status).toBe(409);
      expect((await pool.count('audit_events', { action: { $regex: '^help\\.' }, tenant_id: null }))).toBeGreaterThanOrEqual(4);
    });

    it('manages query categories (Other always stays) and settings (reopen days, attachments)', async () => {
      const all = ok(await api(app, tok.rahul).get('/platform/help/manage'));
      const otherCat = all.queryCategories.find((c: any) => c.key === 'other');
      expect((await api(app, tok.rahul).delete(`/platform/help/manage/query-categories/${otherCat.id}`)).status).toBe(400);
      expect((await api(app, tok.rahul).put(`/platform/help/manage/query-categories/${otherCat.id}`).send({ key: 'other', label: 'Other', active: false })).status).toBe(400);
      const c = ok(await api(app, tok.rahul).post('/platform/help/manage/query-categories').send({ key: `travel-${stamp}`, label: 'Travel desk', sort: 140 }), 201);
      expect(ok(await as('esha').get('/help/queries/form')).categories.map((x: any) => x.key)).toContain(`travel-${stamp}`);
      ok(await api(app, tok.rahul).delete(`/platform/help/manage/query-categories/${c.id}`));
      expect(ok(await as('esha').get('/help/queries/form')).categories.map((x: any) => x.key)).not.toContain(`travel-${stamp}`);

      ok(await api(app, tok.rahul).put('/platform/help/manage/settings').send({ attachments: false, reopenDays: 0, escalation: true, welcome: 'How can we help?' }));
      expect(ok(await as('esha').get('/help')).welcome).toBe('How can we help?');
      const f = ok(await as('esha').post('/help/files').attach('file', Buffer.from('y'), { filename: 'y.txt', contentType: 'text/plain' }), 201);
      expect((await as('esha').post('/help/queries').send({ categoryKey: 'other', subject: 'With a file', description: 'Attachments are switched off now.', fileIds: [f.id] })).status).toBe(400);
      const q = ok(await as('esha').post('/help/queries').send({ categoryKey: 'other', subject: 'No reopen', description: 'Resolved queries cannot be reopened now.' }), 201);
      ok(await as('hari').put(`/help/inbox/${q.id}/status`).send({ status: 'resolved' }));
      expect((await as('esha').put(`/help/queries/${q.id}/status`).send({ status: 'open' })).status).toBe(409);
      ok(await api(app, tok.rahul).put('/platform/help/manage/settings').send({ attachments: true, reopenDays: 14, escalation: true, welcome: 'Search guides, FAQs and tutorials, or raise a query and we will get back to you.' }));
      const ins = ok(await api(app, tok.rahul).get('/platform/help/manage/insights'));
      expect(ins.queries.total).toBeGreaterThanOrEqual(7);
    });
  });

  describe('switching it off', () => {
    it('a Console switch for the company closes Raise a Query (API and home) but keeps the guides', async () => {
      const sub = (await pool.one('subscriptions', { tenant_id: t.id }))!;
      await pool.update('subscriptions', { tenant_id: t.id }, { $set: { feature_overrides: { ...(sub.feature_overrides ?? {}), 'core_hr.help_queries': false } } });
      try {
        expect((await as('esha').post('/help/queries').send({ categoryKey: 'other', subject: 'Should be refused', description: 'Raise a Query is off for the company.' })).status).toBe(403);
        expect((await as('esha').get('/help/queries')).status).toBe(403);
        const home = ok(await as('esha').get('/help'));
        expect(home.queries.raise).toBe(false);
        ok(await as('esha').get('/help/articles/how-to-apply-leave'));
      } finally {
        await pool.update('subscriptions', { tenant_id: t.id }, { $set: { feature_overrides: sub.feature_overrides ?? {} } });
      }
      ok(await as('esha').get('/help/queries'));
    });
  });
});
