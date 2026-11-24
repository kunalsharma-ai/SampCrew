import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotificationService } from '../src/platform/notify/notification.service';
import { addMember, adminPool, api, createApp, createTenant, loginWithMfa, type TestDb, type TestTenant } from './helpers';

/**
 * The central notification framework: notices that ask for action, the organisation's notification policy set by the
 * Super Workspace (and how it sits above each person's own settings), per-category phone push and sound, read state
 * shared by every place a notice shows, and the level-aware sign-in welcome (/me levels.leadsTeam).
 */
describe('notification framework', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let other: TestTenant;
  let svc: NotificationService;
  const people: Record<string, { email: string; membershipId: string }> = {};
  const tokens: Record<string, string> = {};
  const as = (who: string) => api(app, tokens[who]);
  const ok = (res: { status: number; body: unknown }, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const notify = (tenant: TestTenant, notice: Parameters<NotificationService['notify']>[1]) => pool.tenant(tenant.id, (tx) => svc.notify(tx, notice));

  beforeAll(async () => {
    app = await createApp();
    svc = app.get(NotificationService);
    pool = adminPool();
    t = await createTenant(pool);
    other = await createTenant(pool);
    people.sup = await addMember(pool, t, { roles: ['super_workspace'], name: 'Sana Super' });
    people.hr = await addMember(pool, t, { roles: ['hr_admin'], name: 'Hari HR' });
    people.lead = await addMember(pool, t, { name: 'Lata Lead' });
    people.emp = await addMember(pool, t, { name: 'Esha Employee', managerId: people.lead.membershipId });
    people.out = await addMember(pool, other, { name: 'Omar Outsider' });
    for (const who of ['sup', 'hr', 'lead', 'emp']) tokens[who] = (await loginWithMfa(app, pool, people[who]!.email)).accessToken;
    tokens.out = (await loginWithMfa(app, pool, people.out.email)).accessToken;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('marks notices that ask for action, filters on them and counts them in the summary', async () => {
    await notify(t, { membershipIds: [people.emp.membershipId], kind: 'approval.requested', title: 'Leave request from Ravi is awaiting your approval', link: '/approvals' });
    await notify(t, { membershipIds: [people.emp.membershipId], kind: 'leave.approved', title: 'Your leave was approved', link: '/leave' });
    await notify(t, { membershipIds: [people.emp.membershipId], kind: 'workflow.notice', title: 'Sign the policy', action: true });
    const all = ok(await as('emp').get('/notifications?limit=20'));
    const byTitle = (s: string) => all.items.find((n: { title: string }) => n.title === s);
    expect(byTitle('Leave request from Ravi is awaiting your approval').actionRequired).toBe(true);
    expect(byTitle('Your leave was approved').actionRequired).toBe(false);
    expect(byTitle('Sign the policy').actionRequired).toBe(true);
    const action = ok(await as('emp').get('/notifications?action=true&unread=true'));
    expect(action.items.map((n: { title: string }) => n.title).sort()).toEqual(['Leave request from Ravi is awaiting your approval', 'Sign the policy']);
    expect(ok(await as('emp').get('/notifications/summary')).actionNeeded).toBe(2);
  });

  it('keeps read state in one place: reading in a module marks it read for the bell, Home and the phone', async () => {
    await notify(t, { membershipIds: [people.emp.membershipId], kind: 'attendance.late_reminder', title: 'You were late today', link: '/attendance' });
    const before = ok(await as('emp').get('/notifications/summary'));
    const att = before.categories.find((c: { category: string }) => c.category === 'attendance');
    expect(att.unread).toBe(1);
    // The Attendance page's "Mark all read" (category) ...
    ok(await as('emp').post('/notifications/read-all').send({ category: 'attendance' }), 204);
    // ... is what the bell (unread count), Home (summary) and the phone (same API) read next.
    const after = ok(await as('emp').get('/notifications/summary'));
    expect(after.categories.find((c: { category: string }) => c.category === 'attendance').unread).toBe(0);
    expect(after.unread).toBe(before.unread - 1);
    expect(ok(await as('emp').get('/notifications?category=attendance&unread=true')).items).toHaveLength(0);
  });

  it('lets only the Super Workspace read and change the notification policy, and audits the change', async () => {
    expect((await as('hr').get('/notifications/policy')).status).toBe(403);
    expect((await as('emp').put('/notifications/policy').send({ allowSound: false })).status).toBe(403);
    const start = ok(await as('sup').get('/notifications/policy'));
    expect(start.policy).toMatchObject({ mandatory: [], emailRequired: [], allowSound: true, allowDesktop: true, allowPush: true });
    const saved = ok(await as('sup').put('/notifications/policy').send({ mandatory: ['leave'], emailRequired: ['payroll'], allowSound: false, allowDesktop: false, allowPush: true, defaults: { sound: false, toasts: true, desktop: false } }));
    expect(saved.policy).toMatchObject({ mandatory: ['leave'], emailRequired: ['payroll'], allowSound: false });
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'notifications.policy_changed' })).toBe(1);
    // Another company is untouched.
    expect(await pool.count('notification_policies', { tenant_id: other.id })).toBe(0);
    expect((await as('out').get('/notifications/preferences')).body.locks).toMatchObject({ sound: false, desktop: false, push: false });
  });

  it('applies the policy above personal choices: required categories and emails stay on, sound and desktop stay off', async () => {
    const put = ok(await as('emp').put('/notifications/preferences').send({
      categories: { leave: { inApp: false, email: false, push: false, sound: true }, payroll: { inApp: true, email: false, push: true, sound: true }, learning: { inApp: true, email: true, push: false, sound: false } },
      sound: { enabled: true, volume: 80, minPriority: 'normal' }, desktop: true,
    }));
    expect(put.categories.leave).toMatchObject({ inApp: true, push: false, sound: false });
    expect(put.categories.payroll.email).toBe(true);
    expect(put.categories.learning).toMatchObject({ push: false, sound: false });
    expect(put.sound.enabled).toBe(false);
    expect(put.desktop).toBe(false);
    expect(put.locks).toMatchObject({ inApp: expect.arrayContaining(['approvals', 'system', 'leave']), email: expect.arrayContaining(['system', 'payroll']), sound: true, desktop: true, push: false });
    // Leave still reaches the person even though they tried to hide it.
    await notify(t, { membershipIds: [people.emp.membershipId], kind: 'leave.allocated', title: 'Leave allocated for next year' });
    expect(await pool.count('notifications', { membership_id: people.emp.membershipId, title: 'Leave allocated for next year' })).toBe(1);
    // When the organisation allows sound again, the person's own choice comes back (it was kept).
    ok(await as('sup').put('/notifications/policy').send({}));
    const back = ok(await as('emp').get('/notifications/preferences'));
    expect(back.categories.leave.inApp).toBe(false);
    expect(back.locks.sound).toBe(false);
  });

  it('gives people who never chose the organisation starting choices', async () => {
    ok(await as('sup').put('/notifications/policy').send({ defaults: { sound: true, toasts: false, desktop: true } }));
    const fresh = ok(await as('hr').get('/notifications/preferences'));
    expect(fresh).toMatchObject({ customised: false, toasts: false, desktop: true });
    expect(fresh.sound.enabled).toBe(true);
    ok(await as('sup').put('/notifications/policy').send({}));
  });

  it('queues phone pushes per category, silent where sound is off, and none where push is off or not allowed', async () => {
    const device = await pool.insert('mobile_devices', { tenant_id: t.id, membership_id: people.lead.membershipId, installation_id: 'framework-test-phone', platform: 'android', push_token: 'ExponentPushToken[framework]' });
    ok(await as('lead').put('/notifications/preferences').send({ categories: { learning: { inApp: true, email: true, push: false, sound: true }, assets: { inApp: true, email: true, push: true, sound: false } } }));
    const pushes = async () => pool.find('push_messages', { mobile_device_id: device.id });
    await notify(t, { membershipIds: [people.lead.membershipId], kind: 'learning.assigned', title: 'New course' });
    expect(await pushes()).toHaveLength(0);
    await notify(t, { membershipIds: [people.lead.membershipId], kind: 'asset.assigned', title: 'Laptop for you', priority: 'high' });
    const [quiet] = await pushes();
    expect(quiet).toMatchObject({ silent: true, category: 'assets', priority: 'high' });
    await notify(t, { membershipIds: [people.lead.membershipId], kind: 'leave.approved', title: 'Leave approved' });
    expect((await pushes()).find((p) => p.category === 'leave')).toMatchObject({ silent: false });
    ok(await as('sup').put('/notifications/policy').send({ allowPush: false }));
    const count = (await pushes()).length;
    await notify(t, { membershipIds: [people.lead.membershipId], kind: 'leave.approved', title: 'Another leave approved' });
    expect(await pushes()).toHaveLength(count);
    ok(await as('sup').put('/notifications/policy').send({}));
  });

  it('only ever shows people their own notices', async () => {
    await notify(other, { membershipIds: [people.out.membershipId], kind: 'payslip.published', title: 'Your payslip for another company' });
    const mine = ok(await as('emp').get('/notifications?limit=100'));
    expect(mine.items.some((n: { title: string }) => n.title.includes('another company'))).toBe(false);
    const theirs = ok(await as('out').get('/notifications?limit=5'));
    expect((await as('emp').post(`/notifications/${theirs.items[0].id}/read`)).status).toBe(404);
  });

  it('tells the sign-in welcome who leads a team', async () => {
    expect(ok(await as('lead').get('/me')).levels).toMatchObject({ super: false, leadsTeam: true });
    expect(ok(await as('emp').get('/me')).levels.leadsTeam).toBe(false);
    expect(ok(await as('sup').get('/me')).levels.super).toBe(true);
  });
});
