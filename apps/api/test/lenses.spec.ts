import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, adminPool, api, createApp, createTenant, department, loginWithMfa, type TestTenant } from './helpers';

/** Workforce Universe lenses: skills people hold, and saved headcount scenarios. */
describe('universe lenses', () => {
  let app: INestApplication;
  let pool: Pool;
  let t: TestTenant;
  let other: TestTenant;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const as = (who: string) => api(app, tokens[who]);

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    other = await createTenant(pool);
    ids.ops = await department(pool, t, 'Operations');
    ids.sales = await department(pool, t, 'Sales');
    const people = {
      hr: await addMember(pool, t, { roles: ['hr_admin'], name: 'Hana HR' }),
      finance: await addMember(pool, t, { roles: ['payroll_admin'], name: 'Fin Finance' }),
      talent: await addMember(pool, t, { roles: ['hr_admin', 'recruiter'], name: 'Tara Talent' }),
      olu: await addMember(pool, t, { departmentId: ids.ops, name: 'Olu Operator' }),
      peer: await addMember(pool, t, { departmentId: ids.sales, name: 'Pia Peer' }),
      stranger: await addMember(pool, other, { roles: ['hr_admin'], name: 'Other HR' }),
    };
    for (const [k, p] of Object.entries(people)) tokens[k] = (await loginWithMfa(app, pool, p.email, k === 'stranger' ? other.slug : t.slug)).accessToken;
    const hire = async (body: Record<string, unknown>) => {
      const res = await as('hr').post('/employees').send({ legalEntityId: t.legalEntityId, probationMonths: 0, dateOfJoining: '2023-01-02', ...body });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.employee.id as string;
    };
    ids.olu = await hire({ firstName: 'Olu', lastName: 'Operator', departmentId: ids.ops, membershipId: people.olu.membershipId });
    ids.ada = await hire({ firstName: 'Ada', lastName: 'Ops', departmentId: ids.ops });
    ids.pia = await hire({ firstName: 'Pia', lastName: 'Peer', departmentId: ids.sales, membershipId: people.peer.membershipId });
    const st = await pool.query<{ id: string }>(`insert into salary_structures (tenant_id, name) values ($1, 'Lenses') returning id`, [t.id]);
    for (const [emp, ctc] of [[ids.olu, 360000], [ids.ada, 480000], [ids.pia, 600000]] as const) {
      await pool.query(`insert into employee_salaries (tenant_id, employee_id, effective_from, annual_ctc, currency, structure_id) values ($1, $2, '2023-01-02', $3, 'INR', $4)`, [t.id, emp, ctc, st.rows[0]!.id]);
    }
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('skills', () => {
    it('lets HR and the person set skills, and keeps one list of skill names', async () => {
      const set = await as('hr').put(`/employees/${ids.olu}/skills`).send({ skills: [{ name: 'Forklift', level: 3 }, { name: 'Six Sigma', level: 2 }] });
      expect(set.status, JSON.stringify(set.body)).toBe(200);
      expect(set.body.skills.map((s: { name: string; level: number }) => [s.name, s.level])).toEqual([['Forklift', 3], ['Six Sigma', 2]]);
      // Olu updates their own; "forklift" in another case is the same skill.
      const own = await as('olu').put(`/employees/${ids.olu}/skills`).send({ skills: [{ name: 'forklift', level: 4 }, { name: 'First aid', level: 1 }] });
      expect(own.status, JSON.stringify(own.body)).toBe(200);
      expect(own.body.skills.map((s: { name: string }) => s.name)).toEqual(['Forklift', 'First aid']);
      expect((await pool.query(`select count(*)::int as n from skills where tenant_id = $1`, [t.id])).rows[0].n).toBe(3);
      await as('hr').put(`/employees/${ids.ada}/skills`).send({ skills: [{ name: 'Forklift', level: 2 }] });
      const audit = await pool.query(`select changes from audit_events where tenant_id = $1 and action = 'employee.skills_updated' and resource_id = $2 order by created_at`, [t.id, ids.olu]);
      expect(audit.rows.at(-1)!.changes).toMatchObject({ before: ['Forklift:3', 'Six Sigma:2'], after: ['Forklift:4', 'First aid:1'] });
    });

    it('refuses people outside the caller’s access and bad input', async () => {
      expect((await as('peer').put(`/employees/${ids.olu}/skills`).send({ skills: [] })).status).toBe(404);
      expect((await as('stranger').get(`/employees/${ids.olu}/skills`)).status).toBe(404);
      expect((await as('olu').get(`/employees/${ids.olu}/skills`)).body).toMatchObject({ canEdit: true });
      expect((await as('hr').put(`/employees/${ids.olu}/skills`).send({ skills: [{ name: 'A', level: 2 }] })).status).toBe(422);
      expect((await as('hr').put(`/employees/${ids.olu}/skills`).send({ skills: [{ name: 'Welding', level: 5 }] })).status).toBe(422);
      expect((await as('hr').put(`/employees/${ids.olu}/skills`).send({ skills: [{ name: 'Welding', level: 2 }, { name: 'welding', level: 3 }] })).status).toBe(422);
    });

    it('draws the network from the people the caller can see', async () => {
      const hr = (await as('hr').get('/insights/skills')).body;
      expect(hr.people).toHaveLength(3);
      expect(hr.skills.map((s: { name: string }) => s.name).sort()).toEqual(['First aid', 'Forklift']);
      expect(hr.links).toHaveLength(3);
      // Pia sees only herself, and she has no skills yet.
      const pia = (await as('peer').get('/insights/skills')).body;
      expect(pia).toMatchObject({ people: [{ id: ids.pia }], links: [], skills: [] });
    });
  });

  describe('scenarios', () => {
    it('shows the baseline with costs only to people whose payroll access covers everyone', async () => {
      const fin = (await as('finance').get('/insights/scenarios')).body;
      expect(fin.baseline.costs).toBe(true);
      expect(fin.baseline.currency).toBe('INR');
      expect(fin.baseline.departments.find((d: { id: string }) => d.id === ids.ops)).toMatchObject({ headcount: 2, monthlyCost: 70000 });
      const hr = (await as('hr').get('/insights/scenarios')).body;
      expect(hr.baseline).toMatchObject({ costs: false, currency: null });
      expect(hr.baseline.departments.find((d: { id: string }) => d.id === ids.ops)).toMatchObject({ headcount: 2, monthlyCost: null });
    });

    it('saves, updates and deletes scenarios, for planners only', async () => {
      const body = { name: 'Second shift', notes: 'Peak season', changes: [{ departmentId: ids.ops, delta: 4, monthlyCostPerHead: 30000 }, { departmentId: ids.sales, delta: -1 }] };
      const made = await as('finance').post('/insights/scenarios').send(body);
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      expect(made.body).toMatchObject({ name: 'Second shift', createdBy: 'Fin Finance', changes: body.changes, requisitions: [] });
      expect(made.body.assumptions).toEqual({ startMonth: null, horizonMonths: 12, attritionPctYear: 0, payRisePct: 0, payRiseMonth: null });
      const upd = await as('hr').put(`/insights/scenarios/${made.body.id}`).send({ ...body, name: 'Second shift (lean)', changes: [{ departmentId: ids.ops, delta: 2 }] });
      expect(upd.status, JSON.stringify(upd.body)).toBe(200);
      expect((await as('hr').get('/insights/scenarios')).body.scenarios).toEqual([expect.objectContaining({ name: 'Second shift (lean)', changes: [{ departmentId: ids.ops, delta: 2 }] })]);
      // An employee may look but not save; unknown departments and empty changes are refused; other workspaces see nothing.
      expect((await as('olu').post('/insights/scenarios').send(body)).status).toBe(403);
      expect((await as('hr').post('/insights/scenarios').send({ ...body, changes: [{ departmentId: other.legalEntityId, delta: 1 }] })).status).toBe(422);
      expect((await as('hr').post('/insights/scenarios').send({ ...body, changes: [{ departmentId: ids.ops, delta: 0 }] })).status).toBe(422);
      expect((await as('stranger').get('/insights/scenarios')).body.scenarios).toEqual([]);
      expect((await as('stranger').delete(`/insights/scenarios/${made.body.id}`)).status).toBe(404);
      expect((await as('hr').delete(`/insights/scenarios/${made.body.id}`)).status).toBe(200);
      expect((await as('hr').get('/insights/scenarios')).body.scenarios).toEqual([]);
    });

    it('keeps timing and assumptions, and raises draft requisitions once per department', async () => {
      const body = {
        name: 'Peak season 2027', notes: 'Two lines from March',
        changes: [{ departmentId: ids.ops, delta: 3, startMonth: '2027-03', role: 'Forklift operator', monthlyCostPerHead: 25000 }, { departmentId: ids.sales, delta: -1, startMonth: '2027-06' }],
        assumptions: { startMonth: '2027-01', horizonMonths: 18, attritionPctYear: 10, payRisePct: 6, payRiseMonth: '2027-04' },
      };
      const made = await as('hr').post('/insights/scenarios').send(body);
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      expect(made.body).toMatchObject({ changes: body.changes, assumptions: body.assumptions });
      expect((await as('hr').post('/insights/scenarios').send({ ...body, assumptions: { ...body.assumptions, horizonMonths: 60 } })).status).toBe(422);

      // Raising needs requisitions:create as well as planning access; it happens once; the draft carries the role, the people and the month.
      expect((await as('olu').post(`/insights/scenarios/${made.body.id}/requisitions`).send({})).status).toBe(403);
      expect((await as('hr').post(`/insights/scenarios/${made.body.id}/requisitions`).send({})).status).toBe(403);
      const raised = await as('talent').post(`/insights/scenarios/${made.body.id}/requisitions`).send({});
      expect(raised.status, JSON.stringify(raised.body)).toBe(201);
      expect(raised.body.requisitions).toEqual([expect.objectContaining({ title: 'Forklift operator', status: 'draft', departmentId: ids.ops, headcount: 3 })]);
      const req = (await as('talent').get(`/recruitment/requisitions/${raised.body.requisitions[0].id}`)).body;
      expect(req).toMatchObject({ status: 'draft', headcount: 3, targetStartDate: '2027-03-01', departmentId: ids.ops });
      expect(req.justification).toContain('Peak season 2027');
      const again = await as('talent').post(`/insights/scenarios/${made.body.id}/requisitions`).send({});
      expect(again.status).toBe(422);
      expect((await as('hr').get('/insights/scenarios')).body.scenarios[0].requisitions).toHaveLength(1);
      const audit = await pool.query(`select count(*)::int as n from audit_events where tenant_id = $1 and action = 'scenario.requisition_raised' and resource_id = $2`, [t.id, made.body.id]);
      expect(audit.rows[0].n).toBe(1);
      expect((await as('stranger').get('/insights/scenarios')).body.scenarios).toEqual([]);
    });
  });
});
