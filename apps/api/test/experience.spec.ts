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

    it('stores favourites in order, without duplicates, and only for pages inside SampCrew', async () => {
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

  describe('module overviews', () => {
    const tile = (o: Record<string, any>, key: string) => (o.tiles as { key: string; value: number | null }[]).find((x) => x.key === key);
    const chart = (o: Record<string, any>, key: string) => (o.charts as { key: string }[]).find((x) => x.key === key) as Record<string, any> | undefined;

    it('gives HR live workforce numbers for the whole workspace', async () => {
      const o = ok(await as('hr').get('/dashboard/modules/employees'));
      expect(o.module).toBe('employees');
      expect(tile(o, 'total')?.value).toBe(3);
      expect(tile(o, 'upcoming')?.value).toBe(0);
      expect(chart(o, 'headcount')!.points).toHaveLength(6);
      expect(chart(o, 'headcount')!.points.at(-1).value).toBe(3);
      expect(chart(o, 'departments')!.slices.map((x: { label: string }) => x.label).sort()).toEqual(['Operations', 'Sales']);
      const a = ok(await as('hr').get('/dashboard/modules/analytics'));
      expect(tile(a, 'headcount')?.value).toBe(3);
      expect(tile(a, 'attrition')?.value).toBe(0);
      expect(chart(a, 'insights')!.items.length).toBeGreaterThan(0);
    });

    it('limits a department manager to their department, with the same scope as the lists', async () => {
      const o = ok(await as('manager').get('/dashboard/modules/employees'));
      expect(tile(o, 'total')?.value).toBe(2);
      expect(chart(o, 'departments')!.slices).toEqual([expect.objectContaining({ label: 'Operations', value: 2 })]);
    });

    it('refuses people whose access covers only their own record', async () => {
      for (const m of ['employees', 'leave', 'performance', 'analytics']) expect((await as('sam').get(`/dashboard/modules/${m}`)).status, m).toBe(403);
    });

    it('never counts another workspace', async () => {
      const o = ok(await as('stranger').get('/dashboard/modules/employees'));
      expect(tile(o, 'total')?.value).toBe(0);
    });

    it('answers every module for HR with tiles from live records', async () => {
      for (const m of ['recruitment', 'attendance', 'leave', 'performance', 'learning']) {
        const o = ok(await as('hr').get(`/dashboard/modules/${m}`));
        expect(o.tiles.length, m).toBeGreaterThan(0);
        for (const x of o.tiles) expect(['violet', 'teal', 'orange', 'blue', 'pink', 'green']).toContain(x.tone);
      }
      const r = ok(await as('hr').get('/dashboard/modules/recruitment'));
      expect(tile(r, 'jobs')?.value).toBe(0);
      const l = ok(await as('hr').get('/dashboard/modules/learning'));
      expect(tile(l, 'completion')?.value).toBeNull();
    });

    it('rejects an unknown module', async () => {
      expect((await as('hr').get('/dashboard/modules/secrets')).status).toBe(422);
    });
  });

  describe('neon design preferences', () => {
    it('defaults to the neon style and saves the style and background', async () => {
      expect(ok(await as('manager').get('/me/preferences')).appearance).toMatchObject({ style: 'neon', backdrop: 'aurora' });
      const p = ok(await as('manager').put('/me/preferences/appearance').send({ style: 'classic', backdrop: 'cosmos', preset: 'cyber' }));
      expect(p.appearance).toMatchObject({ style: 'classic', backdrop: 'cosmos', preset: 'cyber' });
      expect(ok(await as('manager').get('/me/preferences')).appearance).toMatchObject({ style: 'classic', backdrop: 'cosmos', preset: 'cyber' });
      expect((await as('manager').put('/me/preferences/appearance').send({ backdrop: 'lava' })).status).toBe(422);
    });
  });

  describe('saved views', () => {
    const state = { filters: { status: 'active' }, sort: 'joined', dir: 'desc', columns: ['name', 'department'], density: 'compact' };
    it('saves, renames, defaults and deletes views, one default per list', async () => {
      const a = ok(await as('hr').post('/me/views').send({ page: 'employees', name: 'Confirmed staff', state, isDefault: true }), 201);
      const b = ok(await as('hr').post('/me/views').send({ page: 'employees', name: 'Newest', state: { filters: {}, sort: 'joined', dir: 'desc' }, isDefault: true }), 201);
      const list = ok(await as('hr').get('/me/views?page=employees')) as unknown as { id: string; isDefault: boolean; name: string }[];
      expect(list.filter((v) => v.isDefault).map((v) => v.id)).toEqual([b.id]);
      expect((await as('hr').post('/me/views').send({ page: 'employees', name: 'newest', state })).status).toBe(409);
      expect(ok(await as('hr').patch(`/me/views/${a.id}`).send({ name: 'Confirmed', isDefault: true })).isDefault).toBe(true);
      expect((ok(await as('hr').get('/me/views?page=employees')) as unknown as { id: string; isDefault: boolean }[]).filter((v) => v.isDefault).map((v) => v.id)).toEqual([a.id]);
      expect((await as('hr').delete(`/me/views/${b.id}`)).status).toBe(204);
    });

    it('keeps views private to their owner', async () => {
      const mine = ok(await as('hr').get('/me/views?page=employees')) as unknown as { id: string }[];
      expect(ok(await as('manager').get('/me/views?page=employees'))).toEqual([]);
      expect((await as('manager').delete(`/me/views/${mine[0]!.id}`)).status).toBe(404);
      expect((await as('stranger').patch(`/me/views/${mine[0]!.id}`).send({ name: 'x' })).status).toBe(404);
    });

    it('refuses bad view state', async () => {
      expect((await as('hr').post('/me/views').send({ page: 'payroll', name: 'x', state: {} })).status).toBe(422);
      expect((await as('hr').post('/me/views').send({ page: 'employees', name: 'x', state: { hack: 1 } })).status).toBe(422);
    });
  });

  describe('employee directory', () => {
    it('sorts on the server in both directions and pages without gaps', async () => {
      const byName = ok(await as('hr').get('/employees?sort=name&dir=asc&limit=2'));
      expect(byName.total).toBe(3);
      expect(byName.items.map((e: { firstName: string }) => e.firstName)).toEqual(['Asha', 'Manu']);
      const next = ok(await as('hr').get(`/employees?sort=name&dir=asc&limit=2&cursor=${encodeURIComponent(byName.nextCursor)}`));
      expect(next.items.map((e: { firstName: string }) => e.firstName)).toEqual(['Sam']);
      const newest = ok(await as('hr').get('/employees?sort=joined&dir=desc'));
      expect(newest.items[0].firstName).toBe('Sam');
      const byDept = ok(await as('hr').get('/employees?sort=department&dir=desc&limit=1'));
      expect(byDept.items[0].departmentName).toBe('Sales');
    });

    it('exports the chosen columns as CSV, within scope, neutralising formulas, and audits it', async () => {
      const samLast = (await pool.query(`select last_name from employees where tenant_id = $1 and first_name = 'Sam'`, [t.id])).rows[0].last_name;
      await pool.query(`update employees set preferred_name = '=HYPERLINK("x")' where tenant_id = $1 and first_name = 'Sam'`, [t.id]);
      const r = await as('hr').get('/employees/export.csv?columns=name,department,status&sort=name');
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toContain('text/csv');
      const lines = r.text.replace(/^\ufeff/, '').trim().split('\r\n');
      expect(lines[0]).toBe('Name,Department,Status');
      expect(lines).toHaveLength(4);
      expect(lines).toContain(`"'=HYPERLINK(""x"") Patel",Sales,active`.replace(' Patel', ` ${samLast}`));
      expect(r.text).not.toMatch(/(^|,|")=HYPERLINK/m);
      await pool.query(`update employees set preferred_name = null where tenant_id = $1 and first_name = 'Sam'`, [t.id]);
      const m = await as('manager').get('/employees/export.csv?columns=name');
      expect(m.text.replace(/^\ufeff/, '').trim().split('\r\n')).toHaveLength(3);
      expect((await as('hr').get('/employees/export.csv?columns=salary')).status).toBe(422);
      const audit = await pool.query(`select count(*)::int as n from audit_events where tenant_id = $1 and action = 'employee.directory_exported'`, [t.id]);
      expect(audit.rows[0].n).toBe(2);
    });
  });

  describe('hiring helpers', () => {
    it('flags likely duplicates by email, phone or name', async () => {
      const r = ok(await as('hr').post('/employees/duplicate-check').send({ firstName: 'asha', lastName: 'RAO' }));
      expect(r.matches).toEqual([expect.objectContaining({ displayName: 'Asha Rao', reasons: ['Same name'] })]);
      expect(ok(await as('hr').post('/employees/duplicate-check').send({ firstName: 'Nobody', lastName: 'Here' })).matches).toEqual([]);
      expect((await as('sam').post('/employees/duplicate-check').send({ firstName: 'Asha', lastName: 'Rao' })).status).toBe(403);
      expect(ok(await as('stranger').post('/employees/duplicate-check').send({ firstName: 'Asha', lastName: 'Rao' })).matches).toEqual([]);
    });

    it('saves, resumes and discards an unfinished hire, privately', async () => {
      const d = ok(await as('hr').post('/employees/drafts').send({ step: 2, data: { firstName: 'Priya', lastName: 'Nair', probationMonths: 6, inviteToCrew: false } }), 201);
      const u = ok(await as('hr').put(`/employees/drafts/${d.id}`).send({ step: 3, data: { firstName: 'Priya', lastName: 'Nair', departmentId: null } }));
      expect(u.step).toBe(3);
      expect((ok(await as('hr').get('/employees/drafts')) as unknown as { id: string }[]).map((x) => x.id)).toEqual([d.id]);
      const hr2 = await addMember(pool, t, { roles: ['hr_admin'], name: 'Second HR' });
      const tok = (await loginWithMfa(app, pool, hr2.email, t.slug)).accessToken;
      expect(ok(await api(app, tok).get('/employees/drafts'))).toEqual([]);
      expect((await api(app, tok).put(`/employees/drafts/${d.id}`).send({ step: 1, data: {} })).status).toBe(404);
      expect((await as('hr').post('/employees/drafts').send({ step: 1, data: { nested: { a: 1 } } })).status).toBe(422);
      expect((await as('hr').delete(`/employees/drafts/${d.id}`)).status).toBe(204);
      expect(ok(await as('hr').get('/employees/drafts'))).toEqual([]);
    });
  });
});
