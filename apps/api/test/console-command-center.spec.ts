import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/platform/auth/crypto';
import { currentTotp } from '../src/platform/auth/mfa';
import { adminPool, api, createApp, createTenant, loginWithMfa, PASSWORD, type TestDb, type TestTenant } from './helpers';

/**
 * The Console command center: roles enforced on the API, clients (companies) with masking, notifications, the
 * dashboard, search, reports, the audit log, security, the plan lifecycle, refunds, system status, settings and View as.
 */
describe('Console command center', () => {
  let app: INestApplication;
  let pool: TestDb;
  const stamp = Date.now();
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  let tenant: TestTenant;
  let clientId: string;

  async function signIn(role: string) {
    const email = `${role}.${stamp}@sampledge.test`;
    const row = await pool.insert('platform_admins', { email, full_name: `${role} admin`, password_hash: await hashPassword(PASSWORD), role });
    ids[role] = row.id as string;
    const res = await api(app).post('/platform/auth/login').send({ email, password: PASSWORD });
    const setup = await api(app, res.body.accessToken).post('/platform/auth/mfa/setup');
    const enabled = await api(app, res.body.accessToken).post('/platform/auth/mfa/enable').send({ code: currentTotp(setup.body.secret) });
    tokens[role] = enabled.body.accessToken;
  }
  const as = (role: string) => api(app, tokens[role]);

  let savedSettings: Array<Record<string, unknown> & { id?: string }> = [];
  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    for (const r of ['super_admin', 'admin', 'billing_ops', 'support', 'operations', 'viewer']) await signIn(r);
    tenant = await createTenant(pool);
    clientId = (await pool.platform((tx) => tx.collection<{ company_id: string }>('tenants').findOne({ id: tenant.id })))!.company_id;
    savedSettings = await pool.platform((tx) => tx.collection<Record<string, unknown>>('platform_settings').find({}));
  });
  afterAll(async () => {
    // Global settings changed here (default plan, trial days, support reply) must not reach later test files.
    await pool.platform(async (tx) => {
      const settings = tx.collection<Record<string, unknown>>('platform_settings');
      await settings.delete({});
      if (savedSettings.length) await settings.insertMany(savedSettings);
    });
    await app.close();
    await pool.end();
  });

  it('every Super Workspace belongs to a client company, and the built-in roles are in the database', async () => {
    expect(clientId).toBeTruthy();
    const roles = await as('super_admin').get('/platform/roles');
    expect(roles.status).toBe(200);
    expect(roles.body.map((r: { key: string }) => r.key)).toEqual(expect.arrayContaining(['super_admin', 'admin', 'billing_ops', 'support', 'operations', 'viewer']));
    const mine = await as('viewer').get('/platform/roles/mine');
    expect(mine.body.permissions).toContain('tenants:read');
    expect(mine.body.permissions).not.toContain('tenants:manage');
  });

  it('enforces permissions on the API and records refused attempts', async () => {
    expect((await as('viewer').put(`/platform/clients/${clientId}/profile`).send({ name: 'Hacked' })).status).toBe(403);
    expect((await as('viewer').get('/platform/security')).status).toBe(403);
    expect((await as('admin').get('/platform/security')).status).toBe(403);
    expect((await as('support').get('/platform/reports/business')).status).toBe(403);
    expect((await as('billing_ops').get('/platform/audit-log')).status).toBe(403);
    const log = await as('super_admin').get('/platform/audit-log').query({ action: 'platform.permission_denied', status: 'denied' });
    expect(log.status).toBe(200);
    expect(log.body.items.length).toBeGreaterThanOrEqual(5);
    expect(log.body.items[0]).toMatchObject({ status: 'denied', area: 'security' });
  });

  it('a custom role applies at once, and changing it changes what its admins can do on their next request', async () => {
    const created = await as('super_admin').post('/platform/roles').send({ name: `Analyst ${stamp}`, description: 'Reports only', permissions: ['reports:read'] });
    expect(created.status).toBe(201);
    const key = created.body.key as string;
    await pool.platform((tx) => tx.collection('platform_admins').updateOne({ id: ids.viewer }, { $set: { role: key } }));
    expect((await as('viewer').get('/platform/clients')).status).toBe(403);
    expect((await as('viewer').get('/platform/reports/workspaces')).status).toBe(200);
    await as('super_admin').put(`/platform/roles/${key}`).send({ name: `Analyst ${stamp}`, description: 'Reports and companies', permissions: ['reports:read', 'tenants:read'] });
    expect((await as('viewer').get('/platform/clients')).status).toBe(200);
    expect((await as('super_admin').delete(`/platform/roles/${key}`)).status).toBe(409);
    await pool.platform((tx) => tx.collection('platform_admins').updateOne({ id: ids.viewer }, { $set: { role: 'viewer' } }));
    expect((await as('super_admin').delete(`/platform/roles/${key}`)).status).toBe(204);
    // Super Admin always keeps every permission.
    const sa = await as('super_admin').put('/platform/roles/super_admin').send({ name: 'Super Admin', description: '', permissions: ['tenants:read'] });
    expect(sa.body.error.code).toBe('super_admin_fixed');
  });

  it('lists clients and opens the 360 view; contact details are masked without users:pii', async () => {
    const saved = await as('admin').put(`/platform/clients/${clientId}/profile`).send({ name: `Acme ${stamp}`, website: 'https://acme.example', email: 'ceo@acme.example', phone: '+91 98765 43210', industry: 'it_services' });
    expect(saved.status).toBe(200);
    const list = await as('viewer').get('/platform/clients').query({ q: `Acme ${stamp}` });
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ id: clientId, superWorkspaces: 1 });
    const full = await as('admin').get(`/platform/clients/${clientId}`);
    expect(full.body.profile.email).toBe('ceo@acme.example');
    expect(full.body.workspaces[0]).toMatchObject({ id: tenant.id });
    const masked = await as('operations').get(`/platform/clients/${clientId}`);
    expect(masked.body.profile.email).toBe('c***@acme.example');
    expect(masked.body.money).toBeNull();
    // Saving the masked value back without users:pii leaves the real one alone.
    await as('operations').put(`/platform/clients/${clientId}/profile`).send({ ...masked.body.profile, name: `Acme ${stamp}`, email: 'c***@acme.example', address: null, primaryContact: null, accountManagerId: undefined, tags: [] });
    expect((await as('admin').get(`/platform/clients/${clientId}`)).body.profile.email).toBe('ceo@acme.example');
    const users = await as('operations').get(`/platform/clients/${clientId}/users`);
    expect(users.status).toBe(200);
    expect(users.body.items[0].email).toMatch(/\*\*\*@/);
  });

  it('creates a company with its first Super Workspace, adds a second one, and notifies the Console', async () => {
    const slug = `cc-${String(stamp).slice(-6)}`;
    const ws = { companyName: `Globex ${stamp}`, slug, ownerEmail: `owner@${slug}.test`, ownerName: 'Globex Owner', planKey: 'business', seats: 10, countryCode: 'IN', currency: 'INR', timezone: 'Asia/Kolkata', trialDays: 14, ownerAccess: 'invite' };
    const created = await as('operations').post('/platform/clients').send({ profile: { name: `Globex ${stamp}`, industry: 'retail' }, workspace: ws });
    expect(created.status).toBe(201);
    const companyId = created.body.companyId as string;
    const second = await as('operations').post(`/platform/clients/${companyId}/workspaces`).send({ ...ws, companyName: `Globex East ${stamp}`, slug: `${slug}-e`, ownerEmail: `east@${slug}.test` });
    expect(second.status).toBe(201);
    const detail = await as('operations').get(`/platform/clients/${companyId}`);
    expect(detail.body.workspaces).toHaveLength(2);
    const summary = await as('super_admin').get('/platform/notifications/summary');
    expect(summary.body.unread).toBeGreaterThan(0);
    expect(summary.body.byCategory.clients).toBeGreaterThan(0);
    expect(summary.body.prefs.sound).toBe(false);
    // Mute a category: it leaves the badge but stays in the history.
    await as('super_admin').put('/platform/notifications/preferences').send({ muted: ['clients', 'workspaces'], sound: false, desktop: false });
    expect((await as('super_admin').get('/platform/notifications/summary')).body.byCategory.clients).toBeUndefined();
    expect((await as('super_admin').get('/platform/notifications').query({ category: 'clients' })).body.items.length).toBeGreaterThan(0);
    await as('super_admin').post('/platform/notifications/read-all');
    expect((await as('super_admin').get('/platform/notifications/summary')).body.unread).toBe(0);
    // A Read Only Admin never sees security or support notifications.
    expect((await as('viewer').get('/platform/notifications')).body.categories).not.toContain('security');
    // A retired plan takes no new companies.
    const dup = await as('billing_ops').post('/platform/plans/business/duplicate').send({ key: `biz_${String(stamp).slice(-6)}`, name: 'Business copy' });
    expect(dup.status).toBe(201);
    expect((await as('billing_ops').post(`/platform/plans/${dup.body.key}/retire`).send({ reason: 'Test retirement' })).status).toBe(200);
    const refused = await as('operations').post('/platform/clients').send({ profile: { name: 'Nope' }, workspace: { ...ws, slug: `${slug}-x`, ownerEmail: `x@${slug}.test`, planKey: dup.body.key } });
    expect(refused.body.error.code).toBe('plan_closed');
    expect((await as('billing_ops').delete(`/platform/plans/${dup.body.key}`)).status).toBe(204);
  });

  it('the dashboard shows money only with billing:read', async () => {
    const full = await as('admin').get('/platform/command-center').query({ range: '30d' });
    expect(full.status).toBe(200);
    expect(full.body.workspaces.companies).toBeGreaterThan(0);
    expect(full.body.series.growth.length).toBeGreaterThan(0);
    const ops = await as('operations').get('/platform/command-center').query({ range: '7d' });
    expect(ops.body.revenue.mrr).toBe('0');
    expect((await as('viewer').get('/platform/command-center').query({ range: 'custom', from: '2026-01-01' })).status).toBe(422);
  });

  it('searches only what the role can open, and finds users by full email only', async () => {
    const r = await as('viewer').get('/platform/search').query({ q: `Acme ${stamp}` });
    expect(r.body.hits.some((h: { type: string; id: string }) => h.type === 'company' && h.id === clientId)).toBe(true);
    expect(r.body.skipped).toEqual(expect.arrayContaining(['admin', 'audit', 'user']));
    const partial = await as('support').get('/platform/search').query({ q: tenant.ownerEmail.slice(0, 8), types: 'user' });
    expect(partial.body.hits).toHaveLength(0);
    const exact = await as('operations').get('/platform/search').query({ q: tenant.ownerEmail, types: 'user' });
    expect(exact.body.hits[0].subtitle).toMatch(/\*\*\*@/);
  });

  it('reports and exports: JSON for reports:read, files for reports:export, every export audited', async () => {
    const ws = await as('viewer').get('/platform/reports/workspaces');
    expect(ws.body.table.rows.length).toBeGreaterThan(0);
    expect((await as('viewer').get('/platform/reports/workspaces').query({ format: 'csv' })).status).toBe(403);
    const csv = await as('billing_ops').get('/platform/reports/payments').query({ format: 'csv' });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    const xlsx = await as('admin').get('/platform/clients/export').query({ format: 'xlsx' });
    expect(xlsx.status).toBe(200);
    const log = await as('super_admin').get('/platform/audit-log').query({ q: 'exported' });
    expect(log.body.items.map((i: { action: string }) => i.action)).toEqual(expect.arrayContaining(['platform.report_exported', 'platform.clients_exported']));
  });

  it('the audit log shows before and after values, IP and device', async () => {
    const r = await as('support').get('/platform/audit-log').query({ action: 'platform.company_updated' });
    const row = r.body.items.find((i: { resourceId: string }) => i.resourceId === clientId);
    expect(row.before).toHaveProperty('name');
    expect(row.after.name).toBe(`Acme ${stamp}`);
    expect(row).toHaveProperty('ip');
    const file = await as('super_admin').get('/platform/audit-log/export').query({ format: 'csv', area: 'companies' });
    expect(file.text).toContain('Company updated');
  });

  it('security: failed sign-ins, sessions and revoking one', async () => {
    await api(app).post('/platform/auth/login').send({ email: `nobody.${stamp}@sampledge.test`, password: 'wrong-wrong-wrong' });
    await api(app).post('/platform/auth/login').send({ email: `viewer.${stamp}@sampledge.test`, password: 'wrong-wrong-wrong' });
    const s = await as('super_admin').get('/platform/security');
    expect(s.status).toBe(200);
    expect(s.body.logins.some((l: { ok: boolean; adminId: string | null }) => !l.ok && l.adminId === null)).toBe(true);
    const viewerSession = s.body.sessions.find((x: { adminId: string; active: boolean }) => x.adminId === ids.viewer && x.active);
    expect((await as('super_admin').post(`/platform/sessions/${viewerSession.id}/revoke`)).status).toBe(200);
    expect((await as('viewer').get('/platform/clients')).status).toBe(401);
    const own = s.body.sessions.find((x: { current: boolean }) => x.current);
    expect((await as('super_admin').post(`/platform/sessions/${own.id}/revoke`)).body.error.code).toBe('own_session');
  });

  it('plan impact: subscribers and the billing records that block deleting', async () => {
    const impact = await as('billing_ops').get('/platform/plans/business/impact');
    expect(impact.body.subscribers.total).toBeGreaterThan(0);
    expect(impact.body.canDelete).toBe(false);
    const preview = await as('billing_ops').post('/platform/plans/business/impact').send({ features: ['core_hr'], limits: { max_hr_workspaces: 0 } });
    expect(preview.body.removed.length).toBeGreaterThan(0);
    expect(preview.body.lowered[0]).toMatchObject({ limit: 'max_hr_workspaces', to: 0 });
  });

  it('refunds a paid invoice by bank transfer with a credit note, and never beyond the invoice', async () => {
    const inv = await pool.platform((tx) => tx.collection('invoices').insert({ tenant_id: tenant.id, number: `TST-${stamp}`, status: 'paid', currency: 'INR', subtotal: '1000.00', tax: '180.00', total: '1180.00', period_start: '2026-11-01', period_end: '2026-12-01', paid_at: new Date(), provider: 'manual', paid_reference: 'NEFT123' }));
    expect((await as('support').post('/platform/refunds').send({ invoiceId: inv.id, amount: '100', method: 'bank_transfer', reason: 'Goodwill', reference: 'NEFT-R1' })).status).toBe(403);
    const r = await as('billing_ops').post('/platform/refunds').send({ invoiceId: inv.id, amount: '1000', method: 'bank_transfer', reason: 'Duplicate payment', reference: 'NEFT-R1' });
    expect(r.status).toBe(201);
    expect(r.body.number).toMatch(/^CN\d{4}-\d{6}$/);
    const over = await as('billing_ops').post('/platform/refunds').send({ invoiceId: inv.id, amount: '200', method: 'bank_transfer', reason: 'Too much', reference: 'NEFT-R2' });
    expect(over.body.error.code).toBe('too_much');
    const gw = await as('billing_ops').post('/platform/refunds').send({ invoiceId: inv.id, amount: '10', method: 'gateway', reason: 'Card refund' });
    expect(gw.body.error.code).toBe('not_gateway');
    expect((await as('billing_ops').get('/platform/credit-notes').query({ invoiceId: inv.id })).body).toHaveLength(1);
    expect((await as('billing_ops').post(`/platform/credit-notes/${r.body.id}/void`).send({ reason: 'Recorded twice' })).status).toBe(200);
  });

  it('system status and settings', async () => {
    const st = await as('support').get('/platform/status');
    expect(st.status).toBe(200);
    expect(['operational', 'warning', 'critical']).toContain(st.body.level);
    expect(st.body.components.map((c: { key: string }) => c.key)).toEqual(expect.arrayContaining(['api', 'database', 'migrations', 'audit']));
    expect((await as('operations').patch('/platform/settings').send({ workspaceDefaults: { trialDays: 21, defaultPlan: null, requireMfa: false, region: 'in' } })).status).toBe(403);
    const saved = await as('admin').patch('/platform/settings').send({ workspaceDefaults: { trialDays: 21, defaultPlan: 'business', requireMfa: false, region: 'in' } });
    expect(saved.body.workspaceDefaults.trialDays).toBe(21);
    expect((await as('admin').patch('/platform/settings').send({ workspaceDefaults: { trialDays: 21, defaultPlan: 'nope', requireMfa: false, region: 'in' } })).body.error.code).toBe('unknown_plan');
    const log = await as('super_admin').get('/platform/audit-log').query({ action: 'platform.settings_updated' });
    expect(log.body.items[0].before.workspaceDefaults.trialDays).toBe(14);
    expect(log.body.items[0].after.workspaceDefaults.trialDays).toBe(21);
  });

  it('account managers, company activity in the audit log, and the automatic support reply from Settings', async () => {
    const managers = await as('operations').get('/platform/clients/managers');
    expect(managers.status).toBe(200);
    expect(managers.body.map((m: { id: string }) => m.id)).toContain(ids.super_admin);
    expect(Object.keys(managers.body[0]).sort()).toEqual(['id', 'name']);
    // A profile change on the company is found by its company id, Console events only unless scope is all.
    await as('admin').put(`/platform/clients/${clientId}/profile`).send({ name: `Acme ${stamp}`, companySize: '11-50' });
    const mine = await as('super_admin').get('/platform/audit-log').query({ clientId });
    expect(mine.status).toBe(200);
    expect(mine.body.items.some((r: { action: string }) => r.action === 'platform.company_updated')).toBe(true);
    expect(mine.body.items.every((r: { tenantId: string | null }) => r.tenantId === null)).toBe(true);
    const other = await as('super_admin').get('/platform/audit-log').query({ clientId: '00000000-0000-4000-8000-000000000000' });
    expect(other.body.items).toEqual([]);
    // Settings > Client communication: the automatic reply (with support hours) is posted when a conversation starts.
    const before = (await as('super_admin').get('/platform/settings')).body.communication;
    await as('super_admin').patch('/platform/settings').send({ communication: { ...before, autoReply: 'Thanks, we will answer soon.', supportHours: 'Mon-Fri 9:00-18:00 IST' } });
    try {
      const owner = (await loginWithMfa(app, pool, tenant.ownerEmail)).accessToken;
      const started = await api(app, owner).post('/support/conversations').send({ subject: 'Invoice question', category: 'billing', body: 'Where is our invoice?' });
      expect(started.status).toBe(201);
      const thread = await api(app, owner).get(`/support/conversations/${started.body.id}`);
      const bodies = thread.body.messages.map((m: { body: string }) => m.body);
      expect(bodies).toContain('Where is our invoice?');
      expect(bodies.some((b: string) => b.includes('Thanks, we will answer soon.') && b.includes('Mon-Fri 9:00-18:00 IST'))).toBe(true);
      // With scope all, the company's activity also holds what happened inside its Super Workspace.
      const all = await as('super_admin').get('/platform/audit-log').query({ clientId, scope: 'all' });
      expect(all.body.items.some((r: { tenantId: string | null; action: string }) => r.tenantId === tenant.id && r.action === 'support_chat.started')).toBe(true);
    } finally {
      await as('super_admin').patch('/platform/settings').send({ communication: before });
    }
  });

  it('View as needs a client-approved grant, and Exit ends it', async () => {
    expect((await as('support').get(`/platform/tenants/${tenant.id}/view-as`)).body.session).toBeNull();
    expect((await as('support').get(`/platform/tenants/${tenant.id}/view-as/overview`)).status).toBe(403);
    await pool.platform((tx) => tx.collection('support_access_grants').insert({ tenant_id: tenant.id, platform_admin_id: ids.support, reason: 'Test', duration_minutes: 30, status: 'approved', expires_at: new Date(Date.now() + 30 * 60_000) }));
    const cur = await as('support').get(`/platform/tenants/${tenant.id}/view-as`);
    expect(cur.body.session.sections).toEqual(expect.arrayContaining(['overview', 'users']));
    expect(cur.body.session.sections).not.toContain('billing');
    expect((await as('support').get(`/platform/tenants/${tenant.id}/view-as/billing`)).status).toBe(403);
    const ov = await as('support').get(`/platform/tenants/${tenant.id}/view-as/structure`);
    expect(ov.status).toBe(200);
    expect(ov.body.legalEntities.length).toBeGreaterThan(0);
    expect((await as('support').post(`/platform/tenants/${tenant.id}/view-as/exit`)).status).toBe(200);
    expect((await as('support').get(`/platform/tenants/${tenant.id}/view-as/structure`)).status).toBe(403);
    const trail = await pool.platform((tx) => tx.collection('audit_events').count({ tenant_id: tenant.id, action: 'support_access.viewed' }));
    expect(trail).toBeGreaterThan(0);
  });
});
