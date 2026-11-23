import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/platform/auth/crypto';
import { currentTotp } from '../src/platform/auth/mfa';
import { addMember, adminPool, api, createApp, createTenant, login, loginWithMfa, PASSWORD, type TestDb, type TestTenant } from './helpers';

const Y = new Date().getUTCFullYear() + 1; // dates next year, so notice rules never get in the way
const weekday = (month: number, nth = 1, dow = 1) => {
  const d = new Date(Date.UTC(Y, month - 1, 1));
  while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCDate(d.getUTCDate() + 7 * (nth - 1));
  return d.toISOString().slice(0, 10);
};
const plus = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = Record<string, any>;

/**
 * The leave rebuild, through the acceptance scenarios of the specification: the Console switches the module, the
 * Super Workspace owns leave types and their policies, allocation is separate from creation, HR Workspaces allocate
 * only what they were given, applications go to HR, the Super Workspace or both, and every action is recorded.
 */
describe('leave rebuild (acceptance scenarios)', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let other: TestTenant;
  let consoleToken: string;
  let sup: string;
  let companyHr: string;
  let puneHr: string;
  let wsId: string;
  const people: Record<string, { email: string; membershipId: string; employeeId?: string }> = {};
  const tok: Record<string, string> = {};
  const types: Record<string, string> = {};
  const as = (who: string) => api(app, tok[who]);
  const ok = (res: { status: number; body: unknown }, status = 200): Any => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as Any;
  };
  const inbox = async (token: string) => (ok(await api(app, token).get('/approvals/inbox')) as unknown as { id: string; resourceId: string }[]).map((i) => i.resourceId);
  const balance = async (who: string, code: string) => (ok(await as(who).get(`/leave/balances?year=${Y}`)).balances as Any[]).find((b) => b.code === code);

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool, { plan: 'business' });
    other = await createTenant(pool, { plan: 'business', standardLeaveTypes: true });
    sup = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    const hana = await addMember(pool, t, { roles: ['hr_admin'], name: 'Hana HR' });
    companyHr = (await loginWithMfa(app, pool, hana.email)).accessToken;
    const pune = await addMember(pool, t, { name: 'Priya Pune' });
    const ws = ok(await api(app, sup).post('/hr-workspaces').send({ name: 'Pune Branch', code: 'PUNE', kind: 'branch', features: ['leave', 'attendance_basic'], adminMembershipIds: [pune.membershipId] }), 201);
    wsId = ws.id;
    puneHr = (await login(app, pune.email)).accessToken;
    const hire = async (who: string, name: string, body: Record<string, unknown>) => {
      people[who] = await addMember(pool, t, { name });
      const [first, last] = name.split(' ');
      const res = ok(await api(app, sup).post('/employees').send({
        legalEntityId: t.legalEntityId, dateOfJoining: '2024-01-15', probationMonths: 0, onboardingTemplateId: null, firstName: first, lastName: last,
        membershipId: people[who]!.membershipId, ...body,
      }), 201);
      people[who]!.employeeId = res.employee.id;
      tok[who] = (await login(app, people[who]!.email)).accessToken;
    };
    await hire('perm', 'Pia Permanent', { hrWorkspaceId: wsId, employmentType: 'full_time' });
    await hire('contractor', 'Cal Contract', { hrWorkspaceId: wsId, employmentType: 'contract' });
    await hire('central', 'Cyd Central', { hrWorkspaceId: null, employmentType: 'full_time' });
    tok.other = (await loginWithMfa(app, pool, other.ownerEmail)).accessToken;
    const email = `leave.${Date.now()}@sampledge.test`;
    await pool.insert('platform_admins', { email, full_name: 'Console Leave', password_hash: await hashPassword(PASSWORD), role: 'super_admin' });
    const res = await api(app).post('/platform/auth/login').send({ email, password: PASSWORD });
    const setup = await api(app, res.body.accessToken).post('/platform/auth/mfa/setup');
    consoleToken = (await api(app, res.body.accessToken).post('/platform/auth/mfa/enable').send({ code: currentTotp(setup.body.secret) })).body.accessToken;
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('1. the Console switches the leave module off and on for the company, keeping its records', async () => {
    const sw = (state: string) => api(app, consoleToken).put(`/platform/tenants/${t.id}/access/modules`).send({ changes: [{ key: 'leave', state }] });
    ok(await sw('off'));
    expect((await as('perm').get('/leave/mine')).status).toBe(403);
    expect((await api(app, sup).get('/leave/types')).status).toBe(403);
    ok(await sw('on'));
    ok(await as('perm').get('/leave/mine'));
    ok(await sw('plan'));
    // The Super Workspace and HR Workspaces cannot switch the module for the company.
    expect((await api(app, sup).put(`/platform/tenants/${t.id}/access/modules`).send({ changes: [{ key: 'leave', state: 'off' }] })).status).toBe(401);
  });

  it('2. the Super Workspace creates the starter types PL, CL and SL, recorded as created by it', async () => {
    expect(ok(await api(app, sup).get('/leave/types'))).toEqual([]);
    const r = ok(await api(app, sup).post('/leave/types/starter').send({}), 201);
    expect(r.added).toEqual(['PL', 'CL', 'SL']);
    const list = ok(await api(app, sup).get('/leave/types')) as unknown as Any[];
    for (const x of list) types[x.code] = x.id;
    expect(list.map((x) => [x.code, x.name]).sort()).toEqual([['CL', 'Casual Leave'], ['PL', 'Permanent Leave'], ['SL', 'Sick Leave']]);
    expect(list[0]!.createdBy).toMatchObject({ name: 'Owner Person', level: 'super' });
    expect(list.every((x) => x.allocations.employees === 0)).toBe(true);
    // Nothing is allocated yet, so nobody holds them.
    expect(ok(await as('perm').get('/leave/mine')).types).toEqual([]);
  });

  it('3-4. the Super Workspace creates Special Medical Leave and allocates it only to permanent employees', async () => {
    const sml = ok(await api(app, sup).post('/leave/types').send({
      code: 'SML', name: 'Special Medical Leave', category: 'medical', description: 'Treatment that needs more than sick leave',
      eligibility: { employmentTypes: ['full_time'] },
      policy: { accrualMethod: 'annual_upfront', annualEntitlement: '10', documents: { mode: 'required', requiredOverDays: '2', note: 'A doctor’s note' } },
      approval: { routes: ['hr', 'super', 'both'], employeeChooses: true, order: 'sequential' },
    }), 201);
    types.SML = sml.id;
    expect(sml).toMatchObject({ version: 1, active: true, createdBy: { level: 'super' }, eligibility: { employmentTypes: ['full_time'] } });
    ok(await api(app, sup).post('/leave/allocations').send({ target: 'hr_workspace', leaveTypeId: types.SML, hrWorkspaceId: wsId }), 201);
    const preview = ok(await api(app, sup).post('/leave/allocations/preview').send({ target: 'employees', leaveTypeId: types.SML, criteria: { employmentTypes: ['full_time'] } }), 201);
    expect(preview.people.map((p: Any) => p.name).sort()).toEqual(['Cyd Central', 'Pia Permanent']);
    const a = ok(await api(app, sup).post('/leave/allocations').send({ target: 'employees', leaveTypeId: types.SML, criteria: { employmentTypes: ['full_time'] }, note: 'Permanent staff' }), 201);
    expect(a).toMatchObject({ reach: 2, byLevel: 'super', byName: 'Owner Person' });
    // Told they can now apply.
    expect(await pool.count('notifications', { membership_id: people.perm!.membershipId, kind: 'leave.allocated' })).toBe(1);
  });

  it('5. people outside the eligible group neither see nor can apply for Special Medical Leave', async () => {
    expect((ok(await as('contractor').get('/leave/types')) as unknown as Any[]).map((x) => x.code)).not.toContain('SML');
    expect(ok(await as('contractor').get('/leave/mine')).types.map((x: Any) => x.code)).not.toContain('SML');
    expect((await as('contractor').get(`/leave/types/${types.SML}`)).status).toBe(404);
    const r = await as('contractor').post('/leave/requests/preview').send({ leaveTypeId: types.SML, startDate: weekday(3), endDate: weekday(3) });
    expect(r.body.error.code).toBe('not_eligible');
    // Even when named in an allocation, the type's eligibility keeps them out.
    const named = ok(await api(app, sup).post('/leave/allocations/preview').send({ target: 'employees', leaveTypeId: types.SML, criteria: { employeeIds: [people.contractor!.employeeId] } }), 201);
    expect(named.count).toBe(0);
    expect(ok(await as('perm').get('/leave/mine')).types.map((x: Any) => x.code)).toContain('SML');
  });

  it('6-7. the Super Workspace gives Casual Leave to the Pune HR Workspace, which allocates it to chosen people', async () => {
    // Not available yet: HR cannot allocate it.
    expect((await api(app, puneHr).post('/leave/allocations').send({ target: 'employees', leaveTypeId: types.CL, hrWorkspaceId: wsId, criteria: { all: true } })).status).toBe(403);
    // Only the Super Workspace gives types to HR Workspaces.
    expect((await api(app, puneHr).post('/leave/allocations').send({ target: 'hr_workspace', leaveTypeId: types.CL, hrWorkspaceId: wsId })).status).toBe(403);
    ok(await api(app, sup).post('/leave/allocations').send({ target: 'hr_workspace', leaveTypeId: types.CL, hrWorkspaceId: wsId }), 201);
    expect((await api(app, sup).post('/leave/allocations').send({ target: 'hr_workspace', leaveTypeId: types.CL, hrWorkspaceId: wsId })).body.error.code).toBe('already_available');
    expect(await pool.count('notifications', { kind: 'leave.type_available', tenant_id: t.id })).toBeGreaterThanOrEqual(1);
    // The HR Workspace sees the type now, and only what it was given.
    expect((ok(await api(app, puneHr).get('/leave/types')) as unknown as Any[]).map((x) => x.code).sort()).toEqual(['CL', 'SML']);
    // Someone outside its HR Workspace is not its to allocate to.
    const outside = await api(app, puneHr).post('/leave/allocations').send({ target: 'employees', leaveTypeId: types.CL, hrWorkspaceId: wsId, criteria: { employeeIds: [people.central!.employeeId] } });
    expect(outside.status).toBe(400);
    const a = ok(await api(app, puneHr).post('/leave/allocations').send({ target: 'employees', leaveTypeId: types.CL, hrWorkspaceId: wsId, criteria: { employeeIds: [people.perm!.employeeId] } }), 201);
    expect(a).toMatchObject({ byLevel: 'hr', byName: 'Priya Pune', reach: 1 });
    const mine = ok(await as('perm').get('/leave/mine')).types.find((x: Any) => x.code === 'CL');
    expect(mine).toMatchObject({ createdBy: { level: 'super', name: 'Owner Person' }, allocatedBy: { level: 'hr', name: 'Priya Pune', hrWorkspaceName: 'Pune Branch' }, managedBy: 'HR Workspace: Pune Branch' });
    expect(ok(await as('contractor').get('/leave/mine')).types.map((x: Any) => x.code)).not.toContain('CL');
    // It cannot reach past its own HR Workspace with a broad allocation either.
    const wide = ok(await api(app, puneHr).post('/leave/allocations/preview').send({ target: 'employees', leaveTypeId: types.CL, hrWorkspaceId: wsId, criteria: { all: true } }), 201);
    expect(wide.people.map((p: Any) => p.name).sort()).toEqual(['Cal Contract', 'Pia Permanent']);
  });

  it('8. HR Workspaces cannot create, change or remove leave types', async () => {
    for (const token of [puneHr, companyHr]) {
      expect((await api(app, token).post('/leave/types').send({ code: 'HRX', name: 'HR made' })).status).toBe(403);
      expect((await api(app, token).patch(`/leave/types/${types.CL}`).send({ name: 'Renamed' })).status).toBe(403);
      expect((await api(app, token).post(`/leave/types/${types.CL}/status`).send({ active: false, reason: 'Trying' })).status).toBe(403);
      expect((await api(app, token).delete(`/leave/types/${types.PL}`)).status).toBe(403);
      expect((await api(app, token).post('/leave/types/starter').send({})).status).toBe(403);
    }
    expect((await as('perm').post('/leave/allocations').send({ target: 'employees', leaveTypeId: types.CL, criteria: { all: true } })).status).toBe(403);
  });

  it('9. the Super Workspace edits a policy and the change shows in the HR and Employee Workspaces', async () => {
    const before = ok(await api(app, sup).get(`/leave/types/${types.CL}`));
    const policy = { ...before.policy, annualEntitlement: '12', maxDaysPerRequest: '10' };
    const approval = { ...before.approval, routes: ['hr', 'super', 'both'], employeeChooses: true, order: 'simultaneous' };
    const up = ok(await api(app, sup).patch(`/leave/types/${types.CL}`).send({ policy, approval, version: before.version, note: 'Longer casual leave' }));
    expect(up).toMatchObject({ version: before.version + 1, policy: { annualEntitlement: '12' }, updatedBy: { level: 'super', name: 'Owner Person' } });
    // A change made on the older version is refused, so nothing is overwritten silently.
    expect((await api(app, sup).patch(`/leave/types/${types.CL}`).send({ name: 'Casual', version: before.version })).body.error.code).toBe('stale_version');
    expect((ok(await api(app, puneHr).get('/leave/types')) as unknown as Any[]).find((x) => x.code === 'CL').policy.annualEntitlement).toBe('12');
    const mine = ok(await as('perm').get('/leave/mine')).types.find((x: Any) => x.code === 'CL');
    expect(mine.policy.annualEntitlement).toBe('12');
    expect(mine.approval.routes.map((r: Any) => r.route)).toEqual(['hr', 'super', 'both']);
    expect(await pool.count('notifications', { tenant_id: t.id, kind: 'leave.type_changed' })).toBeGreaterThanOrEqual(1);
    const history = ok(await api(app, sup).get(`/leave/types/${types.CL}`)).history as Any[];
    expect(history.find((h) => h.kind === 'type_updated')).toMatchObject({ byName: 'Owner Person', byLevel: 'super', note: 'Longer casual leave', changes: ['policy', 'approval'] });
    // Credit next year's balances.
    ok(await api(app, sup).post('/leave/accruals/run').send({ asOf: `${Y}-01-01` }), 201);
    expect(await balance('perm', 'CL')).toMatchObject({ entitlement: '12.00', available: '12.00', used: '0.00' });
  });

  let twoDays: Any;
  it('11-12. two days of Casual Leave sent to the HR Workspace go to the Pune HR Workspace only', async () => {
    const day = weekday(2, 2, 1);
    const preview = ok(await as('perm').post('/leave/requests/preview').send({ leaveTypeId: types.CL, startDate: day, endDate: plus(day, 1), approvalRoute: 'hr' }), 201);
    expect(preview).toMatchObject({ days: '2.00', route: 'hr', reviewers: ['HR Workspace: Pune Branch'], employeeChooses: true });
    twoDays = ok(await as('perm').post('/leave/requests').send({ leaveTypeId: types.CL, startDate: day, endDate: plus(day, 1), approvalRoute: 'hr', reason: 'Family visit' }), 201);
    expect(twoDays).toMatchObject({ status: 'pending', approvalRoute: 'hr', reviewerHrWorkspaceName: 'Pune Branch', reference: expect.stringMatching(/^LV-[0-9A-F]{6}$/) });
    expect(twoDays.authorities).toEqual([expect.objectContaining({ authority: 'hr', status: 'pending', label: 'HR Workspace: Pune Branch' })]);
    expect(await inbox(puneHr)).toContain(twoDays.id);
    expect(await inbox(companyHr)).not.toContain(twoDays.id);
    expect(await inbox(sup)).not.toContain(twoDays.id);
    expect((ok(await api(app, puneHr).get('/leave/requests?scope=review')) as unknown as Any[]).map((r) => r.id)).toEqual([twoDays.id]);
    expect(await pool.count('notifications', { membership_id: (await pool.one('role_assignments', { constraints: { hrWorkspaceIds: [wsId] } }))!.membership_id, kind: 'approval.requested' })).toBe(1);
    expect(await balance('perm', 'CL')).toMatchObject({ pending: '2.00', available: '10.00', used: '0.00' });
  });

  let week: Any;
  it('13-14. a week of leave sent to the Super Workspace appears on its approvals only', async () => {
    const mon = weekday(3, 2, 1);
    week = ok(await as('perm').post('/leave/requests').send({ leaveTypeId: types.CL, startDate: mon, endDate: plus(mon, 6), approvalRoute: 'super' }), 201);
    expect(week).toMatchObject({ days: '5.00', approvalRoute: 'super', authorities: [expect.objectContaining({ authority: 'super', status: 'pending' })] });
    expect(await inbox(sup)).toContain(week.id);
    expect(await inbox(puneHr)).not.toContain(week.id);
    const dash = ok(await api(app, sup).get(`/leave/dashboard?year=${Y}`));
    expect(dash.counts).toMatchObject({ pending: 2, waitingForMe: 1 });
    expect(dash.byHrWorkspace.find((w: Any) => w.name === 'Pune Branch')).toMatchObject({ pending: 2, types: ['Casual Leave', 'Special Medical Leave'] });
  });

  it('15-17. sent to both, both receive it at once; it stays pending until both approve', async () => {
    const day = weekday(4, 2, 2);
    const both = ok(await as('perm').post('/leave/requests').send({ leaveTypeId: types.CL, startDate: day, endDate: day, endHalf: 'first_half', approvalRoute: 'both' }), 201);
    expect(both.days).toBe('0.50');
    expect(await inbox(puneHr)).toContain(both.id);
    expect(await inbox(sup)).toContain(both.id);
    ok(await api(app, puneHr).post(`/approvals/${both.approvalId}/approve`).send({ comment: 'Fine by HR' }));
    const mid = ok(await as('perm').get(`/leave/requests/${both.id}`));
    expect(mid.status).toBe('pending');
    expect(mid.authorities.map((a: Any) => [a.authority, a.status])).toEqual([['hr', 'approved'], ['super', 'pending']]);
    expect(mid.authorities[0]).toMatchObject({ decidedBy: 'Priya Pune', comment: 'Fine by HR' });
    expect(await balance('perm', 'CL')).toMatchObject({ used: '0.00', pending: '7.50' });
    ok(await api(app, sup).post(`/approvals/${both.approvalId}/approve`).send({}));
    const done = ok(await as('perm').get(`/leave/requests/${both.id}`));
    expect(done.status).toBe('approved');
    expect(done.authorities.map((a: Any) => a.status)).toEqual(['approved', 'approved']);
    expect(await pool.count('notifications', { membership_id: people.perm!.membershipId, kind: 'approval.approved' })).toBe(1);
    // In order: the Super Workspace sees it only after the HR Workspace approved it.
    const s = ok(await as('perm').post('/leave/requests').send({ leaveTypeId: types.SML, startDate: weekday(5, 1, 1), endDate: weekday(5, 1, 1), approvalRoute: 'both' }), 201);
    expect(s.authorities.map((a: Any) => [a.authority, a.status])).toEqual([['hr', 'pending'], ['super', 'waiting']]);
    expect(await inbox(sup)).not.toContain(s.id);
    ok(await api(app, puneHr).post(`/approvals/${s.approvalId}/approve`).send({}));
    expect(await inbox(sup)).toContain(s.id);
    // Any mandatory authority rejecting rejects the whole application.
    ok(await api(app, sup).post(`/approvals/${s.approvalId}/reject`).send({ comment: 'Use sick leave' }));
    expect(ok(await as('perm').get(`/leave/requests/${s.id}`))).toMatchObject({ status: 'rejected', authorities: [expect.objectContaining({ status: 'approved' }), expect.objectContaining({ status: 'rejected', comment: 'Use sick leave' })] });
  });

  it('18. employees cannot bypass the approval rules the Super Workspace set', async () => {
    const pl = ok(await api(app, sup).get(`/leave/types/${types.PL}`));
    ok(await api(app, sup).patch(`/leave/types/${types.PL}`).send({ approval: { ...pl.approval, routes: ['both'], employeeChooses: false }, version: pl.version }));
    ok(await api(app, sup).post('/leave/allocations').send({ target: 'hr_workspace', leaveTypeId: types.PL, hrWorkspaceId: wsId }), 201);
    ok(await api(app, sup).post('/leave/allocations').send({ target: 'employees', leaveTypeId: types.PL, criteria: { all: true } }), 201);
    ok(await api(app, sup).post('/leave/accruals/run').send({ asOf: `${Y}-02-01` }), 201);
    const day = weekday(6, 1, 3);
    // A type that needs both cannot go to HR alone.
    expect((await as('perm').post('/leave/requests').send({ leaveTypeId: types.PL, startDate: day, endDate: day, approvalRoute: 'hr' })).body.error.code).toBe('route_not_allowed');
    // Without a choice, it goes where the rules send it.
    const auto = ok(await as('perm').post('/leave/requests').send({ leaveTypeId: types.PL, startDate: day, endDate: day }), 201);
    expect(auto.approvalRoute).toBe('both');
    // Long leave must include the Super Workspace when the rules say so.
    const cl = ok(await api(app, sup).get(`/leave/types/${types.CL}`));
    ok(await api(app, sup).patch(`/leave/types/${types.CL}`).send({ approval: { ...cl.approval, superRequiredOverDays: '3' }, version: cl.version }));
    const mon = weekday(7, 1, 1);
    expect((await as('perm').post('/leave/requests').send({ leaveTypeId: types.CL, startDate: mon, endDate: plus(mon, 3), approvalRoute: 'hr' })).body.error.code).toBe('route_not_allowed');
    // An HR Workspace that does not manage a type is never a route for it: Cyd's HR is the company HR team, which was not given CL.
    ok(await api(app, sup).post('/leave/allocations').send({ target: 'employees', leaveTypeId: types.CL, criteria: { employeeIds: [people.central!.employeeId] } }), 201);
    ok(await api(app, sup).post('/leave/accruals/run').send({ asOf: `${Y}-01-01` }), 201);
    const opts = ok(await as('central').get('/leave/mine')).types.find((x: Any) => x.code === 'CL').approval;
    expect(opts.routes.map((r: Any) => r.route)).toEqual(['super']);
    expect((await as('central').post('/leave/requests').send({ leaveTypeId: types.CL, startDate: day, endDate: day, approvalRoute: 'hr' })).body.error.code).toBe('route_not_allowed');
    // Nobody approves their own application, and an employee cannot decide one at all.
    expect((await as('perm').post(`/approvals/${auto.approvalId}/approve`).send({})).status).toBe(403);
    expect((await as('contractor').post(`/approvals/${auto.approvalId}/approve`).send({})).status).toBe(404);
  });

  it('19. balances follow approval, rejection and cancellation through the ledger', async () => {
    // The two days are rejected: they stop counting as pending.
    ok(await api(app, puneHr).post(`/approvals/${twoDays.approvalId}/reject`).send({ comment: 'Release week' }));
    expect(await balance('perm', 'CL')).toMatchObject({ used: '0.50', pending: '5.00' });
    // The week is approved: it is deducted.
    ok(await api(app, sup).post(`/approvals/${week.approvalId}/approve`).send({}));
    expect(await balance('perm', 'CL')).toMatchObject({ used: '5.50', pending: '0.00', available: '6.50', upcomingApproved: '5.50' });
    // Not more than the balance, and no overlapping dates.
    expect((await as('perm').post('/leave/requests').send({ leaveTypeId: types.CL, startDate: weekday(8, 1, 1), endDate: plus(weekday(8, 1, 1), 15) })).body.error.code).toBe('too_long');
    expect((await as('perm').post('/leave/requests').send({ leaveTypeId: types.CL, startDate: plus(week.startDate, 1), endDate: plus(week.startDate, 1) })).status).toBe(409);
    // Cancelled: the days come back through a reversal line.
    ok(await as('perm').post(`/leave/requests/${week.id}/cancel`).send({ reason: 'Trip off' }), 201);
    expect(await balance('perm', 'CL')).toMatchObject({ used: '0.50', available: '11.50' });
    const lines = (await pool.find('leave_ledger', { leave_request_id: week.id }, { sort: { created_at: 1 } })).map((l) => [l.kind, l.quantity]);
    expect(lines).toEqual([['taken', '-5.00'], ['reversal', '5.00']]);
  });

  it('documents: a long Special Medical Leave needs the document, which reviewers can open', async () => {
    const mon = weekday(9, 1, 1);
    expect((await as('perm').post('/leave/requests').send({ leaveTypeId: types.SML, startDate: mon, endDate: plus(mon, 2), approvalRoute: 'hr' })).body.error.code).toBe('document_required');
    const up = ok(await as('perm').post('/leave/documents').attach('file', Buffer.from('%PDF-1.4\n%%EOF\n'), { filename: 'note.pdf', contentType: 'application/pdf' }), 201);
    const r = ok(await as('perm').post('/leave/requests').send({ leaveTypeId: types.SML, startDate: mon, endDate: plus(mon, 2), approvalRoute: 'hr', documentIds: [up.id] }), 201);
    expect(r.documents).toEqual([expect.objectContaining({ id: up.id, name: 'note.pdf' })]);
    ok(await api(app, puneHr).post(`/leave/requests/${r.id}/documents/${up.id}/link`).send({}), 201);
    expect((await as('contractor').post(`/leave/requests/${r.id}/documents/${up.id}/link`).send({})).status).toBe(404);
  });

  it('escalation: a review left too long reaches the Super Workspace', async () => {
    const sl = ok(await api(app, sup).get(`/leave/types/${types.SL}`));
    ok(await api(app, sup).patch(`/leave/types/${types.SL}`).send({ approval: { ...sl.approval, escalation: { enabled: true, afterDays: 2 } }, version: sl.version }));
    ok(await api(app, sup).post('/leave/allocations').send({ target: 'hr_workspace', leaveTypeId: types.SL, hrWorkspaceId: wsId }), 201);
    ok(await api(app, sup).post('/leave/allocations').send({ target: 'employees', leaveTypeId: types.SL, criteria: { all: true } }), 201);
    ok(await api(app, sup).post('/leave/accruals/run').send({ asOf: `${Y}-01-01` }), 201);
    const r = ok(await as('perm').post('/leave/requests').send({ leaveTypeId: types.SL, startDate: weekday(10, 1, 2), endDate: weekday(10, 1, 2) }), 201);
    expect(await inbox(sup)).not.toContain(r.id);
    await pool.update('leave_requests', { id: r.id }, { $set: { created_at: new Date(Date.now() - 3 * 86400000) } });
    expect(ok(await api(app, sup).post('/leave/escalations/run').send({}), 201).escalated).toBe(1);
    expect(await inbox(sup)).toContain(r.id);
    expect(ok(await as('perm').get(`/leave/requests/${r.id}`)).authorities[0].escalated).toBe(true);
    ok(await api(app, sup).post(`/approvals/${r.approvalId}/approve`).send({}));
    expect(ok(await as('perm').get(`/leave/requests/${r.id}`)).status).toBe('approved');
  });

  it('10. a deactivated type takes no new applications and keeps its history; a used type cannot be removed', async () => {
    const used = ok(await as('perm').get('/leave/requests?scope=mine')) as unknown as Any[];
    const slRequest = used.find((r) => r.leaveTypeCode === 'SL')!;
    ok(await api(app, sup).post(`/leave/types/${types.SL}/status`).send({ active: false, reason: 'Merged into Special Medical Leave' }), 201);
    expect((await api(app, sup).delete(`/leave/types/${types.SL}`)).body.error.code).toBe('leave_type_in_use');
    expect(ok(await as('perm').get(`/leave/requests/${slRequest.id}`))).toMatchObject({ status: 'approved', leaveTypeActive: false, leaveTypeName: 'Sick Leave' });
    expect((await as('perm').post('/leave/requests').send({ leaveTypeId: types.SL, startDate: weekday(11, 1, 2), endDate: weekday(11, 1, 2) })).body.error.code).toBe('invalid_leave_type');
    expect((ok(await api(app, sup).get('/leave/types')) as unknown as Any[]).map((x) => x.code)).not.toContain('SL');
    expect((ok(await api(app, sup).get('/leave/types?includeArchived=true')) as unknown as Any[]).find((x) => x.code === 'SL')).toMatchObject({ active: false, deactivatedReason: 'Merged into Special Medical Leave' });
    // A type never used can be removed outright.
    const temp = ok(await api(app, sup).post('/leave/types').send({ code: 'TMP', name: 'Typo type' }), 201);
    ok(await api(app, sup).delete(`/leave/types/${temp.id}`), 204);
  });

  it('20. leave types, allocations and applications are the same records in every workspace', async () => {
    const hrDash = ok(await api(app, puneHr).get(`/leave/dashboard?year=${Y}`));
    expect(hrDash.level).toBe('hr');
    expect(hrDash.counts.employees).toBe(2);
    const supDash = ok(await api(app, sup).get(`/leave/dashboard?year=${Y}`));
    expect(supDash.level).toBe('super');
    const mine = ok(await as('perm').get('/leave/mine'));
    const mineIds = [...mine.pending, ...mine.upcoming].map((r: Any) => r.id);
    const hrIds = (ok(await api(app, puneHr).get('/leave/requests?scope=visible')) as unknown as Any[]).map((r) => r.id);
    const supIds = (ok(await api(app, sup).get('/leave/requests?scope=visible')) as unknown as Any[]).map((r) => r.id);
    for (const id of mineIds) {
      expect(hrIds).toContain(id);
      expect(supIds).toContain(id);
    }
    const report = ok(await api(app, sup).get(`/leave/reports?year=${Y}`));
    expect(report.byType.find((x: Any) => x.code === 'CL')).toMatchObject({ holders: 2 });
    expect(report.employees.find((e: Any) => e.name === 'Pia Permanent').cells[types.CL!]).toMatchObject({ used: '0.50' });
  });

  it('21. nobody reaches leave outside their scope or organisation', async () => {
    const r = ok(await as('perm').get('/leave/requests?scope=mine')) as unknown as Any[];
    expect((await as('contractor').get(`/leave/requests/${r[0]!.id}`)).status).toBe(404);
    expect((await as('contractor').get(`/leave/balances?employeeId=${people.perm!.employeeId}`)).status).toBe(404);
    expect((await api(app, puneHr).get(`/leave/balances?employeeId=${people.central!.employeeId}`)).status).toBe(404);
    expect((ok(await api(app, puneHr).get('/leave/requests?scope=visible')) as unknown as Any[]).every((x) => x.employeeName !== 'Cyd Central')).toBe(true);
    expect((await api(app, tok.other!).get(`/leave/types/${types.CL}`)).status).toBe(404);
    expect((await api(app, tok.other!).get(`/leave/requests/${r[0]!.id}`)).status).toBe(404);
    expect((ok(await api(app, tok.other!).get('/leave/types')) as unknown as Any[]).map((x) => x.id)).not.toContain(types.CL);
  });

  it('22. creation, changes, allocation and approvals are in the audit trail and the leave history', async () => {
    const count = (action: string) => pool.count('audit_events', { tenant_id: t.id, action });
    expect(await count('leave_type.created')).toBeGreaterThanOrEqual(5);
    expect(await count('leave_type.updated')).toBeGreaterThanOrEqual(3);
    expect(await count('leave_type.deactivated')).toBe(1);
    expect(await count('leave_type.deleted')).toBe(1);
    expect(await count('leave_type.made_available')).toBeGreaterThanOrEqual(3);
    expect(await count('leave_allocation.created')).toBeGreaterThanOrEqual(4);
    expect(await count('leave_request.submitted')).toBeGreaterThanOrEqual(6);
    expect(await count('approval.step_approved')).toBeGreaterThanOrEqual(4);
    const h = ok(await api(app, sup).get('/leave/history')) as unknown as Any[];
    expect(h.find((x) => x.kind === 'type_created' && x.leaveTypeName === 'Special Medical Leave')).toMatchObject({ byName: 'Owner Person', byLevel: 'super' });
    expect(h.find((x) => x.kind === 'allocated' && x.byLevel === 'hr')).toMatchObject({ byName: 'Priya Pune', leaveTypeName: 'Casual Leave' });
    expect(h.find((x) => x.kind === 'type_deactivated')).toMatchObject({ note: 'Merged into Special Medical Leave' });
    // An HR Workspace sees the history of what it runs, not the company's other allocations.
    const hrH = ok(await api(app, puneHr).get('/leave/history')) as unknown as Any[];
    expect(hrH.every((x) => x.kind.startsWith('type_') || x.note?.includes('Pune Branch') || x.byLevel === 'hr')).toBe(true);
    expect((await as('perm').get('/leave/history')).status).toBe(403);
  });
});
