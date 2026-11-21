import type { INestApplication } from '@nestjs/common';
import { defaultMobileConfig, type MobileAppConfig } from '@crew/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, adminPool, api, createApp, createTenant, department, login, loginWithMfa, PASSWORD, type TestDb, type TestTenant } from './helpers';

/**
 * The centralized mobile app: the Super Workspace's configuration (draft, preview, publish, history, restore), what
 * each level's phone gets, and the server refusing phone requests to hidden modules while the web stays open.
 */
describe('mobile app configuration', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let other: TestTenant;
  let owner: string;
  let hrWeb: string;
  let emp: { email: string; membershipId: string; employeeId?: string };
  let empPhone: string;
  let empWeb: string;
  let hrPhone: string;
  let ownerPhone: string;
  let otherPhone: string;
  let pune: string;

  const ok = (res: { status: number; body: unknown }, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as Record<string, any>;
  };
  const phoneLogin = async (email: string, tenantSlug?: string) => {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/login').set('x-crew-client', 'mobile').send({ email, password: PASSWORD, tenantSlug });
    expect(res.body.status, JSON.stringify(res.body)).toBe('ok');
    return res.body.accessToken as string;
  };
  const as = (tk: string) => api(app, tk);
  const draft = async () => ok(await as(owner).get('/mobile-app')).draft as { config: MobileAppConfig; revision: number; issues: { severity: string; message: string }[]; changes: string[] };
  const publish = async (change: (c: MobileAppConfig) => void, extra: Record<string, unknown> = {}) => {
    const d = await draft();
    change(d.config);
    const saved = ok(await as(owner).put('/mobile-app/draft').send({ config: d.config }));
    return as(owner).post('/mobile-app/publish').send({ draftRevision: saved.draft.revision, note: 'test', ...extra });
  };

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    other = await createTenant(pool);
    const dept = await department(pool, t, 'Sales');
    pune = (await pool.insert('locations', { tenant_id: t.id, legal_entity_id: t.legalEntityId, name: 'Pune', kind: 'office', timezone: 'Asia/Kolkata', country_code: 'IN' })).id as string;
    owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    const hr = await addMember(pool, t, { roles: ['hr_admin'], name: 'Hana HR' });
    emp = await addMember(pool, t, { departmentId: dept, name: 'Eli Employee' });
    hrWeb = (await loginWithMfa(app, pool, hr.email)).accessToken;
    const res = await as(hrWeb).post('/employees').send({ legalEntityId: t.legalEntityId, firstName: 'Eli', lastName: 'Employee', dateOfJoining: '2024-01-15', probationMonths: 0, locationId: pune, departmentId: dept, membershipId: emp.membershipId, onboardingTemplateId: null });
    emp.employeeId = ok(res, 201).employee.id;
    empPhone = await phoneLogin(emp.email);
    empWeb = (await login(app, emp.email)).accessToken;
    hrPhone = await phoneLogin(hr.email);
    ownerPhone = await phoneLogin(t.ownerEmail);
    otherPhone = await phoneLogin(other.ownerEmail);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('gives each level its own app from the starting configuration', async () => {
    const mine = ok(await as(empPhone).get('/mobile/app'));
    expect(mine.level).toBe('employee');
    expect(mine.levelLabel).toBe('Employee Workspace');
    expect(mine.version).toBe(0);
    expect(mine.tabs).toEqual(['attendance', 'chat', 'documents']);
    expect(mine.modules.map((m: { key: string }) => m.key)).toEqual(expect.arrayContaining(['home', 'leave', 'email', 'learning', 'profile', 'sessions']));
    expect(mine.modules.find((m: { key: string }) => m.key === 'attendance').features).not.toContain('team');
    expect(mine.modules.find((m: { key: string }) => m.key === 'email').features).toEqual(['inbox']);
    const hr = ok(await as(hrPhone).get('/mobile/app'));
    expect(hr.level).toBe('hr');
    expect(hr.modules.find((m: { key: string }) => m.key === 'attendance').features).toContain('team');
    expect(hr.modules.find((m: { key: string }) => m.key === 'email').features).toEqual(['inbox', 'compose', 'sent']);
    const sup = ok(await as(ownerPhone).get('/mobile/app'));
    expect(sup.level).toBe('super');
    expect(sup.widgets.map((w: { key: string }) => w.key)).toContain('attendance.team');
    expect(mine.widgets.map((w: { key: string }) => w.key)).not.toContain('attendance.team');
  });

  it('only the Super Workspace manages it', async () => {
    expect((await as(hrWeb).get('/mobile-app')).status).toBe(403);
    expect((await as(empWeb).put('/mobile-app/draft').send({ config: defaultMobileConfig() })).status).toBe(403);
    const o = ok(await as(owner).get('/mobile-app'));
    expect(o.stats).toMatchObject({ totalModules: o.catalogue.length, status: 'default', latestVersion: 0 });
  });

  it('a draft changes nothing on phones until it is published', async () => {
    const d = await draft();
    d.config.modules.email!.enabled = false;
    const saved = ok(await as(owner).put('/mobile-app/draft').send({ config: d.config }));
    expect(saved.draft.changes).toEqual(['Email hidden']);
    expect(saved.stats.status).toBe('draft_pending');
    expect(ok(await as(empPhone).get('/mobile/app')).modules.map((m: { key: string }) => m.key)).toContain('email');
    // The preview shows the draft for a level, read-only.
    const preview = ok(await as(owner).get('/mobile-app/preview?level=employee&source=draft'));
    expect(preview.modules.map((m: { key: string }) => m.key)).not.toContain('email');
    expect(ok(await as(owner).get('/mobile-app/preview?level=employee&source=published')).modules.map((m: { key: string }) => m.key)).toContain('email');
  });

  it('publishing hides Email on phones and closes its API to phones only', async () => {
    expect(ok(await as(empPhone).get('/communication/emails/inbox'))).toBeDefined();
    const o = ok(await as(owner).get('/mobile-app'));
    const pub = await as(owner).post('/mobile-app/publish').send({ draftRevision: o.draft.revision, note: 'No email on phones' });
    // Eli just read the inbox on the phone, so hiding Email asks for confirmation first.
    expect(pub.status, JSON.stringify(pub.body)).toBe(409);
    expect(pub.body.code ?? pub.body.error?.code).toBe('modules_in_use');
    const done = ok(await as(owner).post('/mobile-app/publish').send({ draftRevision: o.draft.revision, note: 'No email on phones', confirmHidingInUse: true }));
    expect(done.published.version).toBe(1);
    const mine = ok(await as(empPhone).get('/mobile/app?since=0'));
    expect(mine.unchanged).toBe(false);
    expect(mine.version).toBe(1);
    expect(mine.modules.map((m: { key: string }) => m.key)).not.toContain('email');
    expect(mine.quickActions.map((q: { key: string }) => q.key)).not.toContain('email.open');
    expect(ok(await as(empPhone).get('/mobile/app?since=1')).unchanged).toBe(true);
    const refused = await as(empPhone).get('/communication/emails/inbox');
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toContain('mobile_module_off');
    expect((await as(hrPhone).post('/communication/emails/send').send({})).status).toBe(403);
    // Other modules keep working, the Web Portal is not affected, and nothing was deleted.
    expect(ok(await as(empPhone).get('/communication/conversations'))).toBeDefined();
    expect(ok(await as(empWeb).get('/communication/emails/inbox'))).toBeDefined();
    expect(ok(await as(empPhone).get('/me')).user.email).toBe(emp.email);
    // Another company's phones follow their own configuration.
    expect(ok(await as(otherPhone).get('/mobile/app')).modules.map((m: { key: string }) => m.key)).toContain('email');
  });

  it('switches features per level, with the server agreeing', async () => {
    ok(await publish((c) => {
      c.modules.leave!.features.cancel!.enabled = false;
      c.modules.attendance!.features.history!.levels.employee = false;
    }));
    const mine = ok(await as(empPhone).get('/mobile/app'));
    expect(mine.modules.find((m: { key: string }) => m.key === 'leave').features).not.toContain('cancel');
    expect(mine.modules.find((m: { key: string }) => m.key === 'attendance').features).not.toContain('history');
    expect((await as(empPhone).post('/leave/requests/5f0c2c1e-4a5b-4c3d-9e8f-0a1b2c3d4e5f/cancel')).status).toBe(403);
    // History also feeds the calendar and summary, which stay on, so the days route stays open.
    expect((await as(empPhone).get('/attendance/days?from=2026-11-01&to=2026-11-02')).status).not.toBe(403);
    expect(ok(await as(hrPhone).get('/mobile/app')).modules.find((m: { key: string }) => m.key === 'attendance').features).toContain('history');
  });

  it('refuses invalid configurations and stale drafts', async () => {
    const d = await draft();
    d.config.modules.leave!.placement = 'tab';
    d.config.modules.attendance!.features.punch!.enabled = false;
    const saved = ok(await as(owner).put('/mobile-app/draft').send({ config: d.config }));
    expect(saved.draft.issues.filter((i: { severity: string }) => i.severity === 'error').length).toBeGreaterThanOrEqual(2);
    const res = await as(owner).post('/mobile-app/publish').send({ draftRevision: saved.draft.revision });
    expect(res.status).toBe(400);
    expect((await as(owner).post('/mobile-app/publish').send({ draftRevision: saved.draft.revision - 1 })).status).toBe(409);
    ok(await as(owner).post('/mobile-app/draft/discard'));
    expect((await draft()).changes).toEqual([]);
  });

  it('keeps every version, who published it and what changed, and restores an old one', async () => {
    const versions = ok(await as(owner).get('/mobile-app/versions')) as unknown as { version: number; changes: string[]; publishedBy: string; note: string }[];
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[1]!.changes).toEqual(['Email hidden']);
    expect(versions[1]!.publishedBy).toBe('Owner Person');
    const restored = ok(await as(owner).post('/mobile-app/versions/1/restore').send({}));
    expect(restored.published.version).toBe(3);
    expect(restored.published.changes).toEqual(expect.arrayContaining(['Leave: Cancel a request on']));
    const mine = ok(await as(empPhone).get('/mobile/app'));
    expect(mine.modules.find((m: { key: string }) => m.key === 'leave').features).toContain('cancel');
    expect(mine.modules.map((m: { key: string }) => m.key)).not.toContain('email');
    const audit = await pool.find('audit_events', { tenant_id: t.id, action: { $in: ['mobile_app.published', 'mobile_app.restored'] } });
    expect(audit.length).toBe(3);
    expect(ok(await as(owner).get('/mobile-app/versions/3')).config.modules.email.enabled).toBe(false);
  });

  it('records breaks and refuses impossible attendance sequences from the phone', async () => {
    const device = ok(await as(empPhone).post('/mobile/devices').send({ installationId: 'install-mobile-app-test-01', platform: 'android', appVersion: '2.0.0' }));
    let seq = 0;
    const punch = async (direction: 'in' | 'out', purpose: 'work' | 'break') => {
      const r = ok(await as(empPhone).post('/mobile/punches').send({ deviceId: device.id, punches: [{ sequence: ++seq, direction, purpose, capturedAt: new Date().toISOString() }] }));
      return r.results[0] as { status: string; reason?: string };
    };
    const state = async () => ok(await as(empPhone).get('/attendance/today')).state as string;
    expect(await state()).toBe('not_started');
    expect((await punch('out', 'work')).reason).toBe('not_in');
    expect((await punch('in', 'break')).reason).toBe('no_break');
    expect((await punch('in', 'work')).status).toBe('accepted');
    expect((await punch('in', 'work')).reason).toBe('already_in');
    expect(await state()).toBe('working');
    expect((await punch('out', 'break')).status).toBe('accepted');
    expect(await state()).toBe('on_break');
    expect((await punch('in', 'work')).reason).toBe('on_break');
    expect((await punch('in', 'break')).status).toBe('accepted');
    expect((await punch('out', 'work')).status).toBe('accepted');
    expect(await state()).toBe('checked_out');
    const today = ok(await as(empPhone).get('/attendance/today'));
    expect(today.punches.map((p: { purpose: string | null }) => p.purpose)).toEqual(['work', 'break', 'break', 'work']);
    // The same records the Web Portal and HR see: one attendance system.
    expect(ok(await as(hrWeb).get(`/attendance/days/${emp.employeeId}/${today.date}`)).punches).toHaveLength(4);
  });

  it('shows sign-in history and signs out other devices', async () => {
    const r = ok(await as(empPhone).get('/me/sign-ins'));
    expect(r.signIns.length).toBeGreaterThanOrEqual(2);
    expect(r.signIns.find((s: { current: boolean }) => s.current).client).toBe('mobile');
    expect(r.previous).not.toBeNull();
    expect(JSON.stringify(r)).not.toMatch(/token|hash/i);
    expect(ok(await as(empPhone).post('/me/sessions/sign-out-others')).signedOut).toBeGreaterThanOrEqual(1);
    expect((await as(empWeb).get('/me')).status).toBe(401);
    expect((await as(empPhone).get('/me')).status).toBe(200);
  });
});
