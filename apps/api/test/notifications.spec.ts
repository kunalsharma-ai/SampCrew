import type { INestApplication } from '@nestjs/common';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotificationService } from '../src/platform/notify/notification.service';
import { addMember, adminPool, api, leaveType, createApp, createTenant, department, login, loginWithMfa, type TestDb, type TestTenant } from './helpers';

/**
 * The shared notification service and the approvals page built on it: categories, priorities, folding repeated
 * events, preferences, the live stream, approval category cards and request details, and the job requisition gaps
 * (approval chain settings, the rejection remark reaching the hiring manager, the sole Owner auto-approving).
 */
describe('notifications and approvals', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let solo: TestTenant;
  let svc: NotificationService;
  let base: string;
  const people: Record<string, { email: string; membershipId: string; employeeId?: string }> = {};
  const tokens: Record<string, string> = {};
  const as = (who: string) => api(app, tokens[who]);
  const ok = (res: { status: number; body: unknown }, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as Record<string, any>;
  };
  const year = new Date().getUTCFullYear() + 1;

  beforeAll(async () => {
    app = await createApp();
    await new Promise<void>((resolve) => app.getHttpServer().listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    svc = app.get(NotificationService);
    pool = adminPool();
    t = await createTenant(pool, { standardLeaveTypes: true });
    solo = await createTenant(pool);
    const eng = await department(pool, t, 'Engineering');
    people.hr = await addMember(pool, t, { roles: ['hr_admin'], name: 'Hana HR' });
    people.mgr = await addMember(pool, t, { roles: ['department_manager', 'hiring_manager'], name: 'Mona Manager', departmentId: eng });
    people.emp = await addMember(pool, t, { managerId: people.mgr.membershipId, name: 'Eli Employee', departmentId: eng });
    people.rec = await addMember(pool, t, { roles: ['recruiter'], name: 'Rita Recruiter' });
    tokens.hr = (await loginWithMfa(app, pool, people.hr.email)).accessToken;
    const hire = async (who: string, first: string, extra: Record<string, unknown> = {}) => {
      const body = ok(await as('hr').post('/employees').send({
        legalEntityId: t.legalEntityId, firstName: first, lastName: 'Test', dateOfJoining: '2024-01-01', probationMonths: 0, departmentId: eng,
        membershipId: people[who]!.membershipId, onboardingTemplateId: null, ...extra,
      }), 201);
      people[who]!.employeeId = body.employee.id;
    };
    await hire('mgr', 'Mona');
    await hire('emp', 'Eli', { managerEmployeeId: people.mgr.employeeId });
    tokens.emp = (await login(app, people.emp.email)).accessToken;
    tokens.mgr = (await login(app, people.mgr.email)).accessToken;
    tokens.rec = (await login(app, people.rec.email)).accessToken;
    tokens.solo = (await loginWithMfa(app, pool, solo.ownerEmail)).accessToken;
    // Leave without pay, reviewed by the manager and then HR (the starter types are Permanent, Casual and Sick Leave).
    const owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    await leaveType(app, owner, { code: 'LWP', name: 'Leave without pay', paid: false, category: 'unpaid', policy: { accrualMethod: 'none', annualEntitlement: '0' }, approval: { managerFirst: true, routes: ['hr'] } });
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  const notify = (notice: Parameters<NotificationService['notify']>[1]) => pool.tenant(t.id, (tx) => svc.notify(tx, notice));

  describe('notification service', () => {
    it('derives the category from the kind, keeps the priority and folds repeated events into one unread notice', async () => {
      await notify({ membershipIds: [people.emp.membershipId], kind: 'leave.balance_low', title: 'Casual leave is running low', link: '/leave' });
      await notify({ membershipIds: [people.emp.membershipId], kind: 'asset.assigned', title: 'A laptop was assigned to you', priority: 'high' });
      for (let i = 1; i <= 3; i++) {
        await notify({ membershipIds: [people.emp.membershipId, people.emp.membershipId], kind: 'chat.message', title: `${i} new message(s) from Hana`, dedupeKey: 'chat:c1', link: '/communication?c=c1' });
      }
      const list = ok(await as('emp').get('/notifications?limit=10'));
      const chat = list.items.filter((n: { kind: string }) => n.kind === 'chat.message');
      expect(chat).toHaveLength(1);
      expect(chat[0]).toMatchObject({ category: 'communication', count: 3, title: '3 new message(s) from Hana', priority: 'normal' });
      expect(list.items.find((n: { kind: string }) => n.kind === 'leave.balance_low').category).toBe('leave');
      expect(list.items.find((n: { kind: string }) => n.kind === 'asset.assigned')).toMatchObject({ category: 'assets', priority: 'high' });

      const summary = ok(await as('emp').get('/notifications/summary'));
      expect(summary.categories.find((c: { category: string }) => c.category === 'communication')).toMatchObject({ unread: 1, total: 1 });
      expect(summary.important.map((n: { kind: string }) => n.kind)).toContain('asset.assigned');

      // Once read, the next message starts a new notice.
      ok(await as('emp').post(`/notifications/${chat[0].id}/read`), 204);
      await notify({ membershipIds: [people.emp.membershipId], kind: 'chat.message', title: '1 new message from Hana', dedupeKey: 'chat:c1' });
      expect(await pool.count('notifications', { membership_id: people.emp.membershipId, kind: 'chat.message' })).toBe(2);
      // Filters and marking one category read.
      expect(ok(await as('emp').get('/notifications?category=assets')).items).toHaveLength(1);
      ok(await as('emp').post('/notifications/read-all').send({ category: 'communication' }), 204);
      expect(ok(await as('emp').get('/notifications?unread=true&category=communication')).items).toHaveLength(0);
      expect(ok(await as('emp').get('/notifications?unread=true')).items.length).toBeGreaterThanOrEqual(2);
    });

    it('respects preferences: a muted category is not stored, email can be turned off, approvals cannot be muted in the app', async () => {
      const prefs = ok(await as('emp').put('/notifications/preferences').send({
        categories: { announcements: { inApp: false, email: false }, approvals: { inApp: false, email: false }, leave: { inApp: true, email: false } },
        sound: { enabled: true, volume: 40, minPriority: 'high' },
      }));
      expect(prefs.categories.approvals.inApp).toBe(true);
      expect(prefs.categories.announcements).toEqual({ inApp: false, email: false });
      expect(prefs.sound).toEqual({ enabled: true, volume: 40, minPriority: 'high' });
      expect(ok(await as('emp').get('/notifications/preferences')).categories.leave).toEqual({ inApp: true, email: false });

      const before = await pool.count('email_messages', { tenant_id: t.id });
      await notify({ membershipIds: [people.emp.membershipId], kind: 'announcement.published', title: 'Muted announcement', email: true });
      await notify({ membershipIds: [people.emp.membershipId], kind: 'leave.reminder', title: 'Leave reminder', email: true });
      expect(await pool.count('notifications', { membership_id: people.emp.membershipId, title: 'Muted announcement' })).toBe(0);
      expect(await pool.count('notifications', { membership_id: people.emp.membershipId, title: 'Leave reminder' })).toBe(1);
      expect(await pool.count('email_messages', { tenant_id: t.id })).toBe(before);
      ok(await as('emp').put('/notifications/preferences').send({}));
    });

    it('streams new notifications and read changes to the member, and only to them', async () => {
      const open = (who: string) =>
        new Promise<{ res: IncomingMessage; events: { event: string; data: any }[]; next: (event: string) => Promise<any> }>((resolve, reject) => {
          const req = httpRequest(`${base}/api/v1/notifications/stream`, { headers: { authorization: `Bearer ${tokens[who]}`, 'x-crew-client': 'web' } }, (res) => {
            const events: { event: string; data: any }[] = [];
            const waiters: { event: string; resolve: (d: any) => void }[] = [];
            let buf = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
              buf += chunk;
              let i;
              while ((i = buf.indexOf('\n\n')) >= 0) {
                const block = buf.slice(0, i);
                buf = buf.slice(i + 2);
                const ev = /^event: (.+)$/m.exec(block)?.[1];
                const data = /^data: (.+)$/m.exec(block)?.[1];
                if (!ev || !data) continue;
                const e = { event: ev, data: JSON.parse(data) };
                events.push(e);
                const w = waiters.findIndex((x) => x.event === ev);
                if (w >= 0) waiters.splice(w, 1)[0]!.resolve(e.data);
              }
            });
            const next = (event: string) => new Promise<any>((r, j) => {
              waiters.push({ event, resolve: r });
              setTimeout(() => j(new Error(`no ${event} event within 8s; got ${JSON.stringify(events)}`)), 8000);
            });
            resolve({ res, events, next });
          });
          req.on('error', reject);
          req.end();
        });
      const emp = await open('emp');
      const mgr = await open('mgr');
      expect(emp.res.statusCode).toBe(200);
      expect(emp.res.headers['content-type']).toContain('text/event-stream');
      await new Promise((r) => setTimeout(r, 300));
      const got = emp.next('notification');
      await notify({ membershipIds: [people.emp.membershipId], kind: 'announcement.urgent', title: 'Office closed today', priority: 'urgent', category: 'announcements' });
      // Announcements were muted in the last test and then reset, so this one is stored and pushed.
      const ev = await got;
      expect(ev.notification).toMatchObject({ title: 'Office closed today', priority: 'urgent', category: 'announcements' });
      expect(ev.unread).toBeGreaterThan(0);
      const read = emp.next('notifications.read');
      ok(await as('emp').post(`/notifications/${ev.notification.id}/read`), 204);
      expect((await read).unread).toBe(ev.unread - 1);
      expect(mgr.events.filter((e) => e.event === 'notification')).toHaveLength(0);
      emp.res.destroy();
      mgr.res.destroy();
    });
  });

  describe('approvals page', () => {
    let leaveId: string;
    let approvalId: string;

    it('files leave under its category card, with a clear status message for the person who asked', async () => {
      const types = ok(await as('emp').get('/leave/balances')).balances;
      // Leave without pay has no balance, so a date next year works whenever the test runs.
      const lwp = types.find((x: { code: string }) => x.code === 'LWP');
      const r = ok(await as('emp').post('/leave/requests').set('idempotency-key', crypto.randomUUID()).send({ leaveTypeId: lwp.leaveTypeId, startDate: `${year}-02-03`, endDate: `${year}-02-03` }), 201);
      leaveId = r.id;
      const mine = ok(await as('emp').get('/approvals/overview?view=mine'));
      const card = mine.categories.find((c: { key: string }) => c.key === 'unpaid_leave');
      expect(card).toMatchObject({ total: 1, pending: 1, approved: 0, rejected: 0 });
      const list = ok(await as('emp').get('/approvals/requests?view=mine&category=unpaid_leave'));
      expect(list).toHaveLength(1);
      approvalId = list[0].id;
      expect(list[0]).toMatchObject({ status: 'pending', waitingOn: 'Mona Manager', statusMessage: 'Your request is awaiting manager approval (Mona Manager).' });
      expect(list[0].ref).toMatch(/^APR-[0-9A-F]{6}$/);

      const waiting = ok(await as('mgr').get('/approvals/overview?view=waiting'));
      expect(waiting.categories.find((c: { key: string }) => c.key === 'unpaid_leave').pending).toBe(1);
      const asked = await pool.one('notifications', { membership_id: people.mgr.membershipId, kind: 'approval.requested' });
      expect(asked).toMatchObject({ priority: 'high', category: 'approvals', link: `/approvals/${approvalId}` });
      // Somebody else's request is not visible.
      expect((await as('rec').get(`/approvals/requests/${approvalId}`)).status).toBe(404);
    });

    it('moves through a two-step chain, telling the employee it now waits for HR, then shows the decision and remarks', async () => {
      const types = ok(await as('emp').get('/leave/balances')).balances;
      const lwp = types.find((x: { code: string }) => x.code === 'LWP');
      const r = ok(await as('emp').post('/leave/requests').set('idempotency-key', crypto.randomUUID()).send({ leaveTypeId: lwp.leaveTypeId, startDate: `${year}-04-06`, endDate: `${year}-04-06`, startHalf: 'second_half' }), 201);
      const [row] = ok(await as('emp').get('/approvals/requests?view=mine&status=pending&q=without'));
      expect(row.category).toBe('half_day_leave');
      ok(await as('mgr').post(`/approvals/${row.id}/approve`).send({ comment: 'Fine by me' }));
      const progressed = await pool.one('notifications', { membership_id: people.emp.membershipId, kind: 'approval.progressed' });
      expect(progressed!.body).toContain('Your request is pending HR approval (Hana HR).');
      ok(await as('hr').post(`/approvals/${row.id}/reject`).send({ comment: 'Quarter-end freeze' }));
      const d = ok(await as('emp').get(`/approvals/requests/${row.id}`));
      expect(d).toMatchObject({ status: 'rejected', statusMessage: 'Your request has been rejected. Please check the remarks.', canDecide: false, mine: true });
      expect(d.finalDecision).toMatchObject({ status: 'rejected', by: 'Hana HR', remarks: 'Quarter-end freeze' });
      expect(d.trail.map((s: { status: string; comment: string | null }) => [s.status, s.comment])).toEqual([['approved', 'Fine by me'], ['rejected', 'Quarter-end freeze']]);
      const told = await pool.one('notifications', { membership_id: people.emp.membershipId, kind: 'approval.rejected' });
      expect(told!.body).toContain('Remarks: Quarter-end freeze');
      expect(told!.priority).toBe('high');
      expect(ok(await as('hr').get('/approvals/overview?view=decided')).categories.find((c: { key: string }) => c.key === 'half_day_leave')).toMatchObject({ rejected: 1 });
      void r;
    });

    it('lets HR add their own category, which picks up matching requests already waiting', async () => {
      expect((await as('emp').post('/approvals/categories').send({ key: 'medical', label: 'Medical', resourceTypes: ['leave_request'], leaveTypeCodes: ['SL'] })).status).toBe(403);
      expect((await as('hr').post('/approvals/categories').send({ key: 'sick_leave', label: 'Clash', resourceTypes: ['leave_request'] })).status).toBe(409);
      ok(await as('hr').post('/approvals/categories').send({ key: 'medical', label: 'Medical leave', resourceTypes: ['leave_request'], leaveTypeCodes: ['LWP'], color: '#ff0066' }), 201);
      const cats = ok(await as('emp').get('/approvals/categories'));
      expect(cats[0]).toMatchObject({ key: 'medical', builtIn: false, active: true });
      const d = ok(await as('emp').get(`/approvals/requests/${approvalId}`));
      expect(d.category).toBe('medical');
      expect(d.categoryLabel).toBe('Medical leave');
      ok(await as('hr').delete('/approvals/categories/medical'), 204);
      expect(ok(await as('emp').get(`/approvals/requests/${approvalId}`)).category).toBe('unpaid_leave');
      expect(await pool.count('audit_events', { tenant_id: t.id, action: 'approval_category.created' })).toBe(1);
      void leaveId;
    });
  });

  describe('job requisitions', () => {
    it('shows the rejection remark on the job and tells the hiring manager', async () => {
      const eng = (await pool.one('departments', { tenant_id: t.id, name: 'Engineering' }))!.id;
      const created = ok(await as('rec').post('/recruitment/requisitions').send({
        title: 'Data Engineer', legalEntityId: t.legalEntityId, departmentId: eng, hiringManagerMembershipId: people.mgr.membershipId, headcount: 1, currency: 'INR', scorecard: ['Skills'],
      }), 201);
      ok(await as('rec').post(`/recruitment/requisitions/${created.id}/submit`).send({}));
      const inbox = ok(await as('hr').get('/approvals/inbox')) as unknown as { id: string; resourceId: string }[];
      const item = inbox.find((i) => i.resourceId === created.id)!;
      ok(await as('hr').post(`/approvals/${item.id}/reject`).send({ comment: 'No budget this quarter' }));
      const job = ok(await as('rec').get(`/recruitment/requisitions/${created.id}`));
      expect(job.status).toBe('rejected');
      expect(job.statusReason).toBe('No budget this quarter');
      expect(job.approval.trail[0]).toMatchObject({ status: 'rejected', comment: 'No budget this quarter', decidedBy: 'Hana HR' });
      const hm = await pool.one('notifications', { membership_id: people.mgr.membershipId, kind: 'requisition.rejected' });
      expect(hm!.body).toBe('Remarks: No budget this quarter');
      // The recruiter who submitted it hears through the approvals engine, once.
      expect(await pool.count('notifications', { membership_id: people.rec.membershipId, kind: 'requisition.rejected' })).toBe(0);
      expect((await pool.one('notifications', { membership_id: people.rec.membershipId, kind: 'approval.rejected' }))!.body).toContain('Remarks: No budget this quarter');
    });

    it('approves automatically, with an audit entry, when the sole Owner is the only possible approver', async () => {
      const dept = await department(pool, solo, 'Ops');
      const created = await api(app, tokens.solo).post('/recruitment/requisitions').send({
        title: 'Office Manager', legalEntityId: solo.legalEntityId, departmentId: dept, hiringManagerMembershipId: solo.ownerMembershipId, headcount: 1, currency: 'INR', scorecard: ['Skills'],
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const sub = ok(await api(app, tokens.solo).post(`/recruitment/requisitions/${created.body.id}/submit`).send({}));
      expect(sub).toMatchObject({ status: 'approved', autoApproved: true });
      const job = ok(await api(app, tokens.solo).get(`/recruitment/requisitions/${created.body.id}`));
      expect(job.approval).toMatchObject({ status: 'approved', autoApproved: true });
      const audit = await pool.one('audit_events', { tenant_id: solo.id, action: 'approval.auto_approved' });
      expect(audit).toBeTruthy();
      expect(await pool.count('notifications', { membership_id: solo.ownerMembershipId, kind: 'approval.auto_approved' })).toBe(1);
      // In a workspace with an HR admin it still goes to them.
      expect((await pool.one('approval_requests', { tenant_id: t.id, resource_type: 'job_requisition' }))!.auto_approved).toBeFalsy();
    });
  });
});
