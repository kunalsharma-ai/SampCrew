import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, adminPool, api, createApp, createTenant, department, login, loginWithMfa, type TestDb, type TestTenant } from './helpers';

const Y = new Date().getUTCFullYear() + 1; // dates next year, so notice rules never get in the way
const weekday = (month: number, nth = 1, dow = 1) => {
  const d = new Date(Date.UTC(Y, month - 1, 1));
  while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCDate(d.getUTCDate() + 7 * (nth - 1));
  return d.toISOString().slice(0, 10);
};
const plus = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
type Bal = { code: string; balance: string; available: string | null; taken: string; tracked: boolean; kind: string };

/**
 * The leave upgrade: the standard catalogue (maternity, paternity, bereavement, comp-off, optional holiday, work from
 * home, loss of pay), policies scoped by department, designation and location, changing requests, adjustment history
 * and the balance overview.
 */
describe('leave catalogue, allocations and changes', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let hr: string;
  let sup: string;
  let eng: string;
  let ops: string;
  let senior: string;
  const people: Record<string, { email: string; membershipId: string; employeeId?: string }> = {};
  const token = async (who: string) => (await login(app, people[who]!.email)).accessToken;
  const types: Record<string, string> = {};
  const balances = async (who: string, year = Y) => (await api(app, await token(who)).get(`/leave/balances?year=${year}`)).body.balances as Bal[];

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    eng = await department(pool, t, 'Engineering');
    ops = await department(pool, t, 'Operations');
    senior = (await pool.insert('designations', { tenant_id: t.id, name: 'Senior engineer' })).id as string;
    people.hr = await addMember(pool, t, { roles: ['hr_admin'], name: 'Hana HR' });
    people.lead = await addMember(pool, t, { roles: ['department_manager'], departmentId: eng, name: 'Lee Lead' });
    people.fiona = await addMember(pool, t, { departmentId: eng, managerId: people.lead.membershipId, name: 'Fiona Field' });
    people.mark = await addMember(pool, t, { departmentId: eng, managerId: people.lead.membershipId, name: 'Mark Moss' });
    people.oscar = await addMember(pool, t, { departmentId: ops, name: 'Oscar Ops' });
    hr = (await loginWithMfa(app, pool, people.hr.email)).accessToken;
    sup = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    const hire = async (who: string, body: Record<string, unknown>) => {
      const res = await api(app, hr).post('/employees').send({ legalEntityId: t.legalEntityId, dateOfJoining: '2024-01-15', probationMonths: 0, membershipId: people[who]!.membershipId, ...body });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      people[who]!.employeeId = res.body.employee.id;
    };
    await hire('hr', { firstName: 'Hana', lastName: 'HR' });
    await hire('lead', { firstName: 'Lee', lastName: 'Lead', departmentId: eng });
    await hire('fiona', { firstName: 'Fiona', lastName: 'Field', departmentId: eng, gender: 'female', managerEmployeeId: people.lead.employeeId });
    await hire('mark', { firstName: 'Mark', lastName: 'Moss', departmentId: eng, designationId: senior, gender: 'male', managerEmployeeId: people.lead.employeeId });
    await hire('oscar', { firstName: 'Oscar', lastName: 'Ops', departmentId: ops });
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('adds types from the templates, once, and only the Super Workspace can', async () => {
    const list = await api(app, sup).get('/leave/types/standard');
    expect(list.status).toBe(200);
    expect(list.body.map((x: { code: string }) => x.code)).toEqual(expect.arrayContaining(['PL', 'CL', 'SL', 'ML', 'PTL', 'BL', 'CO', 'OH', 'WFH', 'LWP']));
    expect(list.body.every((x: { added: boolean }) => !x.added)).toBe(true);
    expect((await api(app, hr).post('/leave/types/standard').send({ codes: ['CL'] })).status).toBe(403);
    const add = await api(app, sup).post('/leave/types/standard').send({ codes: ['CL', 'ML', 'PTL', 'BL', 'CO', 'OH', 'WFH', 'LWP'] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect(add.body.added).toHaveLength(8);
    const again = await api(app, sup).post('/leave/types/standard').send({ codes: ['ML', 'WFH'] });
    expect(again.body).toMatchObject({ added: [], skipped: ['ML', 'WFH'] });
    expect((await api(app, sup).post('/leave/types/standard').send({ codes: ['NOPE'] })).status).toBe(400);
    expect((await api(app, await token('fiona')).post('/leave/types/standard').send({ codes: ['PL'] })).status).toBe(403);
    const all = (await api(app, sup).get('/leave/types')).body as { id: string; code: string; kind: string; eligibleGender: string; countsCalendarDays: boolean }[];
    for (const x of all) types[x.code] = x.id;
    expect(all.find((x) => x.code === 'ML')).toMatchObject({ kind: 'standard', eligibleGender: 'female', countsCalendarDays: true });
    expect((await api(app, sup).get('/leave/types/standard')).body.find((x: { code: string }) => x.code === 'ML').added).toBe(true);
    // Created is not allocated: give each to everyone eligible, with the company HR team reviewing.
    for (const id of Object.values(types)) {
      expect((await api(app, sup).post('/leave/allocations').send({ target: 'hr_workspace', leaveTypeId: id, hrWorkspaceId: null })).status).toBe(201);
      expect((await api(app, sup).post('/leave/allocations').send({ target: 'employees', leaveTypeId: id, criteria: { all: true } })).status).toBe(201);
    }
  });

  it('shows each person only the types open to them, with comp-off kept as a balance HR credits', async () => {
    expect((await api(app, sup).post('/leave/accruals/run').send({ asOf: `${Y}-01-01` })).status).toBe(201);
    const f = await balances('fiona');
    const m = await balances('mark');
    expect(f.map((b) => b.code)).toContain('ML');
    expect(f.map((b) => b.code)).not.toContain('PTL');
    expect(m.map((b) => b.code)).toContain('PTL');
    expect(m.map((b) => b.code)).not.toContain('ML');
    // Oscar has no recorded gender, so neither is closed to him.
    expect((await balances('oscar')).map((b) => b.code)).toEqual(expect.arrayContaining(['ML', 'PTL']));
    expect(f.find((b) => b.code === 'ML')).toMatchObject({ balance: '182.00', tracked: true });
    expect(f.find((b) => b.code === 'CO')).toMatchObject({ balance: '0.00', tracked: true, kind: 'comp_off' });
    expect(f.find((b) => b.code === 'WFH')).toMatchObject({ tracked: false, available: null, kind: 'wfh' });
  });

  it('applies the most specific allocation: designation over department over everyone', async () => {
    const save = (body: Record<string, unknown>) => api(app, sup).post('/leave/allocations').send({ target: 'employees', leaveTypeId: types.CL, ...body });
    expect((await save({ criteria: { departmentIds: [eng] }, entitlementDays: '10' })).status).toBe(201);
    expect((await save({ criteria: { designationIds: [senior] }, entitlementDays: '12.5' })).status).toBe(201);
    expect((await save({ criteria: { departmentIds: ['00000000-0000-4000-8000-000000000000'] }, entitlementDays: '5' })).status).toBe(400);
    const cl = ((await api(app, sup).get(`/leave/allocations?leaveTypeId=${types.CL}`)).body as { target: string; summary: string; entitlementDays: string | null }[]).filter((a) => a.target === 'employees');
    expect(cl.map((a) => [a.summary, a.entitlementDays])).toEqual([['Designations: Senior engineer', '12.50'], ['Departments: Engineering', '10.00'], ['Everyone eligible', null]]);
    await api(app, sup).post('/leave/accruals/run').send({ asOf: `${Y}-01-02` });
    // Accruals for a year are posted once per period, so a change shows from the next credit; this tenant's CL was
    // credited at 8 on 1 January before the narrower allocations existed. New people get the specific amount.
    const lines = await pool.find('leave_ledger', { employee_id: people.mark!.employeeId, leave_type_id: types.CL, leave_year: Y, kind: 'accrual' });
    expect(lines.map((l) => l.quantity)).toEqual(['8.00']);
    const late = await addMember(pool, t, { departmentId: eng, name: 'Nia New' });
    people.nia = late;
    const res = await api(app, hr).post('/employees').send({ legalEntityId: t.legalEntityId, dateOfJoining: '2024-01-15', probationMonths: 0, membershipId: late.membershipId, firstName: 'Nia', lastName: 'New', departmentId: eng, designationId: senior });
    expect(res.status).toBe(201);
    people.nia.employeeId = res.body.employee.id;
    await api(app, sup).post('/leave/accruals/run').send({ asOf: `${Y}-01-03` });
    expect((await balances('nia')).find((b) => b.code === 'CL')!.balance).toBe('12.50');
    const dept = await addMember(pool, t, { departmentId: eng, name: 'Dev Dept' });
    const d = await api(app, hr).post('/employees').send({ legalEntityId: t.legalEntityId, dateOfJoining: '2024-01-15', probationMonths: 0, membershipId: dept.membershipId, firstName: 'Dev', lastName: 'Dept', departmentId: eng });
    people.dev = { ...dept, employeeId: d.body.employee.id };
    await api(app, sup).post('/leave/accruals/run').send({ asOf: `${Y}-01-03` });
    expect((await balances('dev')).find((b) => b.code === 'CL')!.balance).toBe('10.00');
  });

  it('counts maternity in calendar days, keeps it to those it is open to, and limits optional holidays to optional days', async () => {
    const mon = weekday(6, 1, 1);
    const ml = await api(app, await token('fiona')).post('/leave/requests/preview').send({ leaveTypeId: types.ML, startDate: mon, endDate: plus(mon, 6) });
    expect(ml.status, JSON.stringify(ml.body)).toBe(201);
    expect(ml.body.days).toBe('7.00');
    const no = await api(app, await token('mark')).post('/leave/requests/preview').send({ leaveTypeId: types.ML, startDate: mon, endDate: mon });
    expect(no.status).toBe(400);
    expect(no.body.error.code).toBe('not_eligible');

    const cal = (await api(app, hr).get('/leave/calendars')).body.find((c: { isDefault: boolean }) => c.isDefault);
    const festival = weekday(8, 2, 3);
    expect((await api(app, hr).post(`/leave/calendars/${cal.id}/holidays`).send({ date: festival, name: 'Festival', isOptional: true })).status).toBe(201);
    const oh = await api(app, await token('fiona')).post('/leave/requests/preview').send({ leaveTypeId: types.OH, startDate: festival, endDate: festival });
    expect(oh.status, JSON.stringify(oh.body)).toBe(201);
    expect(oh.body.days).toBe('1.00');
    const wrong = await api(app, await token('fiona')).post('/leave/requests/preview').send({ leaveTypeId: types.OH, startDate: plus(festival, 1), endDate: plus(festival, 1) });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('not_optional_holiday');
  });

  it('records balance adjustments with a required remark and lists their history to those who may see them', async () => {
    const fiona = people.fiona!.employeeId!;
    expect((await api(app, hr).post('/leave/adjustments').send({ employeeId: fiona, leaveTypeId: types.CO, quantity: '1', note: 'ok' })).status).toBe(422);
    const ok = await api(app, hr).post('/leave/adjustments').send({ employeeId: fiona, leaveTypeId: types.CO, quantity: '1', note: 'Worked the Sunday release' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.balances.find((b: Bal) => b.code === 'CO').balance).toBe('1.00');
    const history = await api(app, hr).get(`/leave/adjustments?employeeId=${fiona}`);
    expect(history.status).toBe(200);
    expect(history.body).toEqual([expect.objectContaining({ employeeName: 'Fiona Field', leaveTypeName: 'Compensatory Off', quantity: '1.00', note: 'Worked the Sunday release', by: 'Hana HR', opening: false })]);
    expect((await api(app, await token('fiona')).get('/leave/adjustments')).body).toHaveLength(1);
    expect((await api(app, await token('oscar')).get(`/leave/adjustments?employeeId=${fiona}`)).body).toEqual([]);
  });

  it('changes a pending request in place and restarts its approval', async () => {
    const f = await token('fiona');
    const day = weekday(3, 1, 1);
    const res = await api(app, f).post('/leave/requests').send({ leaveTypeId: types.CL, startDate: day, endDate: day });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const first = res.body as { id: string; approvalId: string };
    const changed = await api(app, f).post(`/leave/requests/${first.id}/modify`).send({ leaveTypeId: types.CL, startDate: day, endDate: plus(day, 1), reason: 'Two days after all' });
    expect(changed.status, JSON.stringify(changed.body)).toBe(201);
    expect(changed.body).toMatchObject({ id: first.id, status: 'pending', days: '2.00', reason: 'Two days after all' });
    expect(changed.body.approvalId).not.toBe(first.approvalId);
    expect(changed.body.modifications).toEqual([expect.objectContaining({ startDate: day, endDate: day, days: '1.00', by: 'Fiona Field' })]);
    expect((await pool.one('approval_requests', { id: first.approvalId }))!.status).toBe('cancelled');
    expect((await api(app, f).post(`/leave/requests/${first.id}/modify`).send({ leaveTypeId: types.CL, startDate: day, endDate: plus(day, 1), reason: 'Two days after all' })).body.error.code).toBe('no_change');
    // Someone else in another department cannot change it.
    expect((await api(app, await token('oscar')).post(`/leave/requests/${first.id}/modify`).send({ leaveTypeId: types.CL, startDate: day, endDate: day })).status).toBe(404);
    const ok = await api(app, hr).post(`/approvals/${changed.body.approvalId}/approve`).send({});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await balances('fiona')).find((b) => b.code === 'CL')!.taken).toBe('2.00');
  });

  it('changes approved leave through a new request that replaces it only once approved', async () => {
    const f = await token('fiona');
    const day = weekday(3, 1, 1);
    const original = ((await api(app, f).get('/leave/requests?scope=mine')).body as { id: string; status: string; startDate: string }[]).find((r) => r.startDate === day && r.status === 'approved')!;
    const change = await api(app, f).post(`/leave/requests/${original.id}/modify`).send({ leaveTypeId: types.CL, startDate: plus(day, 2), endDate: plus(day, 2) });
    expect(change.status, JSON.stringify(change.body)).toBe(201);
    expect(change.body).toMatchObject({ status: 'pending', replacesRequestId: original.id, days: '1.00' });
    expect((await api(app, f).get(`/leave/requests/${original.id}`)).body.status).toBe('approved');
    expect((await api(app, f).post(`/leave/requests/${original.id}/modify`).send({ leaveTypeId: types.CL, startDate: plus(day, 3), endDate: plus(day, 3) })).body.error.code).toBe('change_pending');
    // Rejected: the original stands.
    expect((await api(app, hr).post(`/approvals/${change.body.approvalId}/reject`).send({ comment: 'Release week' })).status).toBe(200);
    expect((await api(app, f).get(`/leave/requests/${original.id}`)).body.status).toBe('approved');
    expect((await balances('fiona')).find((b) => b.code === 'CL')!.taken).toBe('2.00');
    // Asked again and approved: the original is cancelled and its days given back.
    const again = await api(app, f).post(`/leave/requests/${original.id}/modify`).send({ leaveTypeId: types.CL, startDate: plus(day, 2), endDate: plus(day, 2) });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect((await api(app, hr).post(`/approvals/${again.body.approvalId}/approve`).send({})).status).toBe(200);
    expect((await api(app, f).get(`/leave/requests/${original.id}`)).body).toMatchObject({ status: 'cancelled', cancelReason: 'Replaced by an approved change' });
    expect((await api(app, f).get(`/leave/requests/${again.body.id}`)).body.status).toBe('approved');
    const kinds = (await pool.find('leave_ledger', { leave_request_id: original.id }, { sort: { created_at: 1 } })).map((l) => [l.kind, l.quantity]);
    expect(kinds).toEqual([['taken', '-2.00'], ['reversal', '2.00']]);
    expect((await balances('fiona')).find((b) => b.code === 'CL')!.taken).toBe('1.00');
  });

  it('withdraws a waiting change when the leave it changes is cancelled', async () => {
    const f = await token('fiona');
    const day = weekday(4, 2, 2);
    const r = await api(app, f).post('/leave/requests').send({ leaveTypeId: types.CL, startDate: day, endDate: day });
    await api(app, hr).post(`/approvals/${r.body.approvalId}/approve`).send({});
    const change = await api(app, f).post(`/leave/requests/${r.body.id}/modify`).send({ leaveTypeId: types.CL, startDate: plus(day, 1), endDate: plus(day, 1) });
    expect(change.status).toBe(201);
    expect((await api(app, f).post(`/leave/requests/${r.body.id}/cancel`).send({ reason: 'Not travelling' })).status).toBe(201);
    expect((await api(app, f).get(`/leave/requests/${change.body.id}`)).body).toMatchObject({ status: 'cancelled', cancelReason: 'The leave it changed was cancelled' });
    expect((await pool.one('approval_requests', { id: change.body.approvalId }))!.status).toBe('cancelled');
  });

  it('counts approved work from home as present in attendance, not as leave', async () => {
    const f = await token('fiona');
    // A recent past working day.
    const d = new Date();
    do d.setUTCDate(d.getUTCDate() - 1); while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
    const day = d.toISOString().slice(0, 10);
    const r = await api(app, f).post('/leave/requests').send({ leaveTypeId: types.WFH, startDate: day, endDate: day });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await api(app, hr).post(`/approvals/${r.body.approvalId}/approve`).send({})).status).toBe(200);
    const att = await pool.one('attendance_days', { employee_id: people.fiona!.employeeId, work_date: day });
    expect(att?.status).toBe('present');
    // Work from home is not unpaid leave and keeps no balance.
    expect((await balances('fiona', Number(day.slice(0, 4)))).find((b) => b.code === 'WFH')).toMatchObject({ tracked: false, available: null });
  });

  it('shows HR and managers a balance overview of the people they can see', async () => {
    const all = await api(app, hr).get(`/leave/balances/overview?year=${Y}`);
    expect(all.status).toBe(200);
    const names = all.body.rows.map((r: { name: string }) => r.name);
    expect(names).toEqual(expect.arrayContaining(['Fiona Field', 'Mark Moss', 'Oscar Ops']));
    expect(all.body.types.map((x: { code: string }) => x.code)).toEqual(expect.arrayContaining(['CL', 'ML', 'PTL', 'CO']));
    const fiona = all.body.rows.find((r: { name: string }) => r.name === 'Fiona Field');
    expect(fiona.balances[types.CL!]).toMatchObject({ taken: '1.00' });
    expect(fiona.balances[types.PTL!]).toBeUndefined();
    expect(fiona.balances[types.WFH!]).toMatchObject({ balance: null });
    const eng_ = await api(app, hr).get(`/leave/balances/overview?year=${Y}&departmentId=${eng}`);
    expect(eng_.body.rows.map((r: { name: string }) => r.name)).not.toContain('Oscar Ops');
    const search = await api(app, hr).get(`/leave/balances/overview?year=${Y}&q=fio`);
    expect(search.body.rows.map((r: { name: string }) => r.name)).toEqual(['Fiona Field']);
    const own = await api(app, await token('oscar')).get(`/leave/balances/overview?year=${Y}`);
    expect(own.body.rows.map((r: { name: string }) => r.name)).toEqual(['Oscar Ops']);
  });

  it('shows a whole year on the leave calendar', async () => {
    const res = await api(app, await token('fiona')).get(`/leave/calendar?from=${Y}-01-01&to=${Y}-12-31`);
    expect(res.status).toBe(200);
    expect(res.body.holidays.map((h: { name: string }) => h.name)).toContain('Festival');
    expect(res.body.requests.map((r: { startDate: string; status: string }) => [r.startDate, r.status])).toEqual([[plus(weekday(3, 1, 1), 2), 'approved']]);
  });
});
