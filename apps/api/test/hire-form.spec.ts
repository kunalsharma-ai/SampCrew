import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, adminPool, api, createApp, createTenant, loginWithMfa, type TestDb, type TestTenant, leaveType } from './helpers';

const today = () => new Date().toISOString().slice(0, 10);
const yearsAgo = (n: number, from = today()) => `${Number(from.slice(0, 4)) - n}${from.slice(4)}`.replace(/-02-29$/, '-02-28');

/**
 * The create employee form's rules, through the HTTP API: phone numbers, the date of birth against the joining
 * date (and minors), work email versus personal email, typed designations, and adding someone already working here.
 */
describe('create employee rules', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let hr: string;
  let cl: string;
  const post = (body: Record<string, unknown>) => api(app, hr).post('/employees').send({ legalEntityId: t.legalEntityId, dateOfJoining: today(), probationMonths: 0, onboardingTemplateId: null, ...body });
  const fieldErrors = (body: { error?: { details?: { path: string; message: string }[] } }) => Object.fromEntries((body.error?.details ?? []).map((d) => [d.path, d.message]));

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    const member = await addMember(pool, t, { roles: ['hr_admin'], name: 'Hina HR' });
    hr = (await loginWithMfa(app, pool, member.email)).accessToken;
    const owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    cl = await leaveType(app, owner, { code: 'CL', name: 'Casual leave', policy: { accrualMethod: 'annual_upfront', annualEntitlement: '12' } });
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('accepts only real phone numbers, checking local ones against the legal entity country', async () => {
    for (const phone of ['+91 98201 2345', 'call me', '0000000000', '+91 01234 56789']) {
      const r = await post({ firstName: 'Phone', lastName: 'Bad', phone });
      expect(r.status, phone).toBe(422);
      expect(Object.keys(fieldErrors(r.body)), phone).toContain('phone');
    }
    // The test workspace's legal entity is in India: a local Indian number is fine, a short one is not.
    expect((await post({ firstName: 'Phone', lastName: 'Local', phone: '098201 23456' })).status).toBe(201);
    const short = await post({ firstName: 'Phone', lastName: 'Short', phone: '9820 1234' });
    expect(short.status).toBe(422);
    expect(fieldErrors(short.body).phone).toMatch(/numbers there have 10/);
    const ok = await post({ firstName: 'Phone', lastName: 'Good', phone: '+44 7700 900123' });
    expect(ok.status).toBe(201);
    // The profile uses the same rules.
    const id = ok.body.employee.id as string;
    expect((await api(app, hr).patch(`/employees/${id}`).send({ phone: '12345' })).status).toBe(422);
    expect((await api(app, hr).patch(`/employees/${id}`).send({ phone: '+91 98201 23456' })).status).toBe(200);
  });

  it('keeps the date of birth in step with the joining date, and makes HR confirm a minor', async () => {
    const young = await post({ firstName: 'Too', lastName: 'Young', dateOfBirth: yearsAgo(13) });
    expect(young.status).toBe(422);
    expect(fieldErrors(young.body).dateOfBirth).toMatch(/at least 14/);
    const after = await post({ firstName: 'Born', lastName: 'Later', dateOfJoining: '2020-01-01', dateOfBirth: '2021-05-05' });
    expect(fieldErrors(after.body).dateOfBirth).toMatch(/before the joining date/);

    const minor = { firstName: 'Mina', lastName: 'Minor', dateOfBirth: yearsAgo(16) };
    const unconfirmed = await post(minor);
    expect(unconfirmed.status).toBe(422);
    expect(fieldErrors(unconfirmed.body).minorConfirmed).toMatch(/under 18/);
    const hired = await post({ ...minor, minorConfirmed: true });
    expect(hired.status, JSON.stringify(hired.body)).toBe(201);
    const audit = await pool.one('audit_events', { tenant_id: t.id, action: 'employee.created', resource_id: hired.body.employee.id });
    expect(audit!.changes).toMatchObject({ minorConfirmed: true, ageOnJoining: 16 });
    // The same rule when the date of birth is changed later.
    expect((await api(app, hr).patch(`/employees/${hired.body.employee.id}`).send({ dateOfBirth: yearsAgo(10) })).status).toBe(422);
  });

  it('never takes the personal email as the work email', async () => {
    const r = await post({ firstName: 'Ema', lastName: 'Il', workEmail: 'ema@gmail.example', personalEmail: 'EMA@gmail.example' });
    expect(r.status).toBe(422);
    expect(fieldErrors(r.body).workEmail).toMatch(/not their personal email/);
    const ok = await post({ firstName: 'Ema', lastName: 'Il', workEmail: 'ema@acme.example', personalEmail: 'ema@gmail.example' });
    expect(ok.status).toBe(201);
    expect(ok.body.employee).toMatchObject({ workEmail: 'ema@acme.example', personalEmail: 'ema@gmail.example' });
    expect((await api(app, hr).patch(`/employees/${ok.body.employee.id}`).send({ personalEmail: 'ema@acme.example' })).status).toBe(422);
  });

  it('adds a typed designation once, with the catalogue code when it is a known title', async () => {
    const a = await post({ firstName: 'Desi', lastName: 'One', designationName: 'Data Scientist' });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const des = await pool.find('designations', { tenant_id: t.id, name: 'Data Scientist' });
    expect(des.map((d) => ({ code: d.code, level: d.level }))).toEqual([{ code: 'DS', level: 40 }]);
    expect(a.body.employee).toMatchObject({ designationId: des[0]!.id, designationName: 'Data Scientist' });
    // Typed again in another case: the same designation, not a second one.
    const b = await post({ firstName: 'Desi', lastName: 'Two', designationName: '  data   scientist ' });
    expect(b.body.employee.designationId).toBe(des[0]!.id);
    // A title nobody has heard of is fine too.
    const c = await post({ firstName: 'Desi', lastName: 'Three', designationName: 'Chief Happiness Officer' });
    expect(c.body.employee.designationName).toBe('Chief Happiness Officer');
    const list = await api(app, hr).get('/designations');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.map((d: { name: string }) => d.name)).toEqual(expect.arrayContaining(['Data Scientist', 'Chief Happiness Officer']));
  });

  it('adds someone already working here with their joining date, code, confirmation and leave balance', async () => {
    const joined = yearsAgo(5);
    const r = await post({
      firstName: 'Esha', lastName: 'Existing', joinedAs: 'existing', dateOfJoining: joined, probationMonths: 6, employeeCode: 'OLD/0042',
      openingLeaveBalances: [{ leaveTypeId: cl, days: '7.5' }], onboardingTemplateId: undefined,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const e = r.body.employee;
    expect(e).toMatchObject({ employeeCode: 'OLD/0042', status: 'active', dateOfJoining: joined, joinedAs: 'existing' });
    expect(e.confirmationDate > joined && e.confirmationDate < today()).toBe(true);
    // No joining checklist for someone who joined years ago, even with a default template in place.
    expect(await pool.find('onboarding_tasks', { employee_id: e.id })).toHaveLength(0);
    // This year's accrual is posted, then topped up or reduced to the opening balance.
    const bal = (await api(app, hr).get(`/leave/balances?employeeId=${e.id}`)).body.balances.find((b: { leaveTypeId: string }) => b.leaveTypeId === cl);
    expect(bal.balance).toBe('7.50');
    const ledger = await pool.find('leave_ledger', { employee_id: e.id, kind: 'adjustment' });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.accrual_key).toBe(`OPEN${today().slice(0, 4)}`);
    const events = (await api(app, hr).get(`/employees/${e.id}/history`)).body.events.map((x: { kind: string }) => x.kind);
    expect(events).toEqual(expect.arrayContaining(['hired', 'confirmed']));

    // An explicit confirmation date is kept; still on probation when it has not ended.
    const explicit = await post({ firstName: 'Esha', lastName: 'Explicit', joinedAs: 'existing', dateOfJoining: joined, probationMonths: 6, confirmationDate: yearsAgo(4) });
    expect(explicit.body.employee).toMatchObject({ status: 'active', confirmationDate: yearsAgo(4) });
    const recent = await post({ firstName: 'Esha', lastName: 'Recent', joinedAs: 'existing', dateOfJoining: today(), probationMonths: 6 });
    expect(recent.body.employee).toMatchObject({ status: 'probation', confirmationDate: null });
  });

  it('refuses a taken code and a future joining date; a new joiner gets no leave typed in (issue #89)', async () => {
    const taken = await post({ firstName: 'Code', lastName: 'Taken', joinedAs: 'existing', dateOfJoining: yearsAgo(1), employeeCode: 'OLD/0042' });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('employee_code_taken');
    const future = await post({ firstName: 'Not', lastName: 'Yet', joinedAs: 'existing', dateOfJoining: '2099-01-01' });
    expect(future.status).toBe(422);
    expect(fieldErrors(future.body).dateOfJoining).toMatch(/on or before today/);
    const newJoiner = await post({ firstName: 'New', lastName: 'Joiner', openingLeaveBalances: [{ leaveTypeId: cl, days: 3 }] });
    expect(newJoiner.status, JSON.stringify(newJoiner.body)).toBe(422);
    expect(fieldErrors(newJoiner.body).openingLeaveBalances).toBeTruthy();
  });
});
