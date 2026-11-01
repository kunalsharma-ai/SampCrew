import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, adminPool, api, createApp, createTenant, department, loginWithMfa, type TestTenant } from './helpers';

/** Workspace experience: per-member appearance and shortcuts, and the permission-aware Home dashboard. */
describe('workspace experience', () => {
  let app: INestApplication;
  let pool: Pool;
  let t: TestTenant;
  let other: TestTenant;
  const people: Record<string, { email: string; membershipId: string }> = {};
  const tokens: Record<string, string> = {};
  const as = (who: string) => api(app, tokens[who]);
  const ok = (res: { status: number; body: unknown }, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as Record<string, any>;
  };
  const isoDaysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    other = await createTenant(pool);
    const ops = await department(pool, t, 'Operations');
    const sales = await department(pool, t, 'Sales');
    people.hr = await addMember(pool, t, { roles: ['hr_admin'], name: 'Hana HR' });
    people.manager = await addMember(pool, t, { roles: ['department_manager'], departmentId: ops, name: 'Manu Manager' });
    people.asha = await addMember(pool, t, { departmentId: ops, managerId: people.manager.membershipId, name: 'Asha' });
    people.sam = await addMember(pool, t, { departmentId: sales, name: 'Sam' });
    people.stranger = await addMember(pool, other, { roles: ['hr_admin'], name: 'Other HR' });
    for (const who of Object.keys(people)) tokens[who] = (await loginWithMfa(app, pool, people[who]!.email, who === 'stranger' ? other.slug : t.slug)).accessToken;

    // Asha joined about five and a half months ago on six months' probation, so her probation ends within 30 days.
    const joined = new Date();
    joined.setUTCMonth(joined.getUTCMonth() - 6);
    joined.setUTCDate(joined.getUTCDate() + 12);
    const manu = ok(await as('hr').post('/employees').send({
      legalEntityId: t.legalEntityId, departmentId: ops, firstName: 'Manu', lastName: 'Menon', dateOfJoining: '2020-01-01', probationMonths: 0,
      membershipId: people.manager!.membershipId, onboardingTemplateId: null,
    }), 201);
    ok(await as('hr').post('/employees').send({
      legalEntityId: t.legalEntityId, departmentId: ops, firstName: 'Asha', lastName: 'Rao', dateOfJoining: joined.toISOString().slice(0, 10), probationMonths: 6,
      membershipId: people.asha!.membershipId, managerEmployeeId: manu.employee.id, onboardingTemplateId: null,
    }), 201);
    ok(await as('hr').post('/employees').send({
      legalEntityId: t.legalEntityId, departmentId: sales, firstName: 'Sam', lastName: 'Iyer', dateOfJoining: isoDaysAgo(10), probationMonths: 0,
      membershipId: people.sam!.membershipId, onboardingTemplateId: null,
    }), 201);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('preferences', () => {
    it('starts every member on the default appearance', async () => {
      const p = ok(await as('asha').get('/me/preferences'));
      expect(p.appearance).toMatchObject({ preset: 'midnight', mode: 'system', density: 'comfortable', motion: 'balanced', focusMode: false });
      expect(p.favourites).toEqual([]);
      expect(p.dashboard.order[0]).toBe('attention');
    });

    it('saves a partial appearance change and keeps the rest', async () => {
      ok(await as('asha').put('/me/preferences/appearance').send({ preset: 'emerald', mode: 'dark' }));
      const p = ok(await as('asha').put('/me/preferences/appearance').send({ density: 'compact', primary: '#12ab34', focusMode: true }));
      expect(p.appearance).toMatchObject({ preset: 'emerald', mode: 'dark', density: 'compact', primary: '#12ab34', focusMode: true });
      expect(ok(await as('asha').get('/me/preferences')).appearance.preset).toBe('emerald');
    });

    it('refuses unknown presets, bad colours and unknown fields', async () => {
      for (const body of [{ preset: 'neon' }, { primary: 'green' }, { isAdmin: true }]) {
        const r = await as('asha').put('/me/preferences/appearance').send(body);
        expect(r.status, JSON.stringify(body)).toBe(422);
      }
    });

    it('keeps each member’s preferences to themselves, within and across workspaces', async () => {
      expect(ok(await as('sam').get('/me/preferences')).appearance.preset).toBe('midnight');
      expect(ok(await as('stranger').get('/me/preferences')).appearance.preset).toBe('midnight');
      const rows = await pool.query('select tenant_id from member_preferences where membership_id = $1', [people.asha!.membershipId]);
      expect(rows.rows).toEqual([{ tenant_id: t.id }]);
    });

    it('resets to the default appearance', async () => {
      expect(ok(await as('asha').post('/me/preferences/appearance/reset')).appearance.preset).toBe('midnight');
    });

    it('stores favourites in order, without duplicates, and only for pages inside CREW', async () => {
      const p = ok(await as('asha').put('/me/preferences/favourites').send({ hrefs: ['/leave', '/payslips', '/leave'] }));
      expect(p.favourites).toEqual(['/leave', '/payslips']);
      expect((await as('asha').put('/me/preferences/favourites').send({ hrefs: ['https://evil.test'] })).status).toBe(422);
      expect((await as('asha').put('/me/preferences/favourites').send({ hrefs: Array.from({ length: 13 }, (_, i) => `/p${i}`) })).status).toBe(422);
    });

    it('keeps the last 8 distinct pages visited, newest first', async () => {
      for (let i = 0; i < 10; i++) ok(await as('asha').post('/me/preferences/recents').send({ href: `/page-${i}`, label: `Page ${i}` }));
      const p = ok(await as('asha').post('/me/preferences/recents').send({ href: '/page-5', label: 'Page 5' }));
      expect(p.recents).toHaveLength(8);
      expect(p.recents.map((r: { href: string }) => r.href).slice(0, 3)).toEqual(['/page-5', '/page-9', '/page-8']);
    });

    it('saves the Home layout and personal notes', async () => {
      const p = ok(await as('asha').put('/me/preferences/dashboard').send({ order: ['notes', 'attention'], hidden: ['access'] }));
      expect(p.dashboard.order.slice(0, 2)).toEqual(['notes', 'attention']);
      expect(p.dashboard.hidden).toEqual(['access']);
      expect((await as('asha').put('/me/preferences/dashboard').send({ order: ['notes', 'notes'] })).status).toBe(422);
      expect(ok(await as('asha').put('/me/preferences/notes').send({ notes: 'Call payroll about March' })).notes).toBe('Call payroll about March');
      expect((await as('asha').put('/me/preferences/notes').send({ notes: 'x'.repeat(4001) })).status).toBe(422);
    });
  });

  describe('dashboard', () => {
    const kpi = (d: Record<string, any>, key: string) => (d.kpis as { key: string; value: number }[]).find((k) => k.key === key);

    it('shows HR the whole workspace, with probation reviews that need attention', async () => {
      const d = ok(await as('hr').get('/dashboard'));
      expect(kpi(d, 'headcount')?.value).toBe(3);
      expect(kpi(d, 'new-hires')?.value).toBe(1);
      expect(kpi(d, 'approvals')?.value).toBe(0);
      expect(d.departments.map((x: { name: string }) => x.name).sort()).toEqual(['Operations', 'Sales']);
      expect(d.attention.some((a: { kind: string; title: string }) => a.kind === 'probation' && a.title.includes('Asha'))).toBe(true);
    });

    it('limits a manager to their department', async () => {
      const d = ok(await as('manager').get('/dashboard'));
      expect(kpi(d, 'headcount')?.value).toBe(2);
      expect(d.departments).toEqual([expect.objectContaining({ name: 'Operations', count: 2 })]);
    });

    it('gives an employee only their own items, never workspace numbers', async () => {
      const d = ok(await as('sam').get('/dashboard'));
      expect(kpi(d, 'headcount')).toBeUndefined();
      expect(kpi(d, 'attrition')).toBeUndefined();
      expect(kpi(d, 'approvals')).toBeDefined();
      expect(d.departments).toBeNull();
      expect(d.attention.filter((a: { kind: string }) => a.kind === 'probation')).toEqual([]);
    });

    it('never counts another workspace', async () => {
      const d = ok(await as('stranger').get('/dashboard'));
      expect(kpi(d, 'headcount')?.value).toBe(0);
    });
  });
});
