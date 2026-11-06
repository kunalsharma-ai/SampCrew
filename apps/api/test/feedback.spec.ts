import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { temporaryPasswordValue } from '../src/modules/employees/employees.service';
import { addMember, adminPool, api, createApp, createTenant, login, loginWithMfa, PASSWORD, type TestTenant } from './helpers';

// A real 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const today = () => new Date().toISOString().slice(0, 10);

/**
 * SAMPLEDGE feedback (2026-11-06): first-login company setup with ready-made departments and designations, employee
 * photos, attendance registration at hire, and logins created by HR with a temporary password.
 */
describe('SAMPLEDGE feedback', () => {
  let app: INestApplication;
  let pool: Pool;
  let t: TestTenant;
  let owner: string;
  let plain: { email: string; membershipId: string };
  let plainToken: string;
  let generalShift: string;
  let nightShift: string;

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    plain = await addMember(pool, t, { name: 'Plain Member' });
    plainToken = (await login(app, plain.email)).accessToken;
    generalShift = (await pool.query(`select id from shift_templates where tenant_id = $1 and code = 'GEN'`, [t.id])).rows[0].id;
    nightShift = (await pool.query(
      `insert into shift_templates (tenant_id, code, name, start_time, end_time, break_minutes) values ($1, 'NIGHT', 'Night shift', '22:00', '06:00', 30) returning id`, [t.id],
    )).rows[0].id;
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('first-login company setup', () => {
    it('starts unfinished for a new workspace and suggests departments and designations for the industry', async () => {
      const me = await api(app, owner).get('/me');
      expect(me.body.tenant.setupCompletedAt).toBeNull();
      const s = await api(app, owner).get('/setup');
      expect(s.status).toBe(200);
      expect(s.body.counts).toMatchObject({ departments: 0, designations: 0, employees: 0 });
      expect(s.body.suggestions.departments.map((d: { name: string }) => d.name)).toContain('Human Resources');
    });

    it('saves the company profile on the workspace and its main legal entity', async () => {
      const res = await api(app, owner).put('/setup/company').send({
        name: 'Acme Tools', legalName: 'Acme Tools Private Limited', industry: 'manufacturing', companySize: '51-200', website: 'https://acme.example',
        contactEmail: 'hr@acme.example', contactPhone: '+91 20 5555 0100', countryCode: 'IN', currency: 'INR', timezone: 'Asia/Kolkata', fiscalYearStartMonth: 4,
        registrationNumber: 'U12345MH2020PTC000001', taxId: '27AAACA1234A1Z5', address: 'Plot 4, MIDC, Pune',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const row = (await pool.query(`select t.name, t.industry, t.company_size, t.setup_step, le.legal_name, le.tax_id from tenants t join legal_entities le on le.tenant_id = t.id where t.id = $1`, [t.id])).rows[0];
      expect(row).toMatchObject({ name: 'Acme Tools', industry: 'manufacturing', company_size: '51-200', legal_name: 'Acme Tools Private Limited', tax_id: '27AAACA1234A1Z5' });
      expect(row.setup_step).toBeGreaterThanOrEqual(1);
      // The suggestions now follow the industry.
      const s = await api(app, owner).get('/setup');
      expect(s.body.suggestions.departments.map((d: { name: string }) => d.name)).toContain('Production');
      expect(s.body.suggestions.designations.map((d: { name: string }) => d.name)).toContain('Machine Operator');
      // Bad input is refused field by field.
      expect((await api(app, owner).put('/setup/company').send({ name: 'X', industry: 'farming', companySize: '1-10', countryCode: 'IN', currency: 'INR', timezone: 'Asia/Kolkata', fiscalYearStartMonth: 4 })).status).toBe(422);
    });

    it('adds the chosen departments and designations once, skipping names that already exist', async () => {
      const body = {
        departments: [{ name: 'Production', code: 'PRD' }, { name: 'Human Resources', code: 'HR' }],
        designations: [{ name: 'Plant Head', code: 'PH', level: 80 }, { name: 'Machine Operator', code: 'OPR', level: 10 }],
      };
      const first = await api(app, owner).post('/setup/structure').send(body);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body.created).toEqual({ departments: ['Production', 'Human Resources'], designations: ['Plant Head', 'Machine Operator'] });
      const again = await api(app, owner).post('/setup/structure').send({ departments: [{ name: 'production' }, { name: 'Maintenance', code: 'PRD' }], designations: [] });
      expect(again.body.skipped.departments).toEqual(['production']);
      expect(again.body.created.departments).toEqual(['Maintenance']);
      // A suggested code already taken is dropped instead of failing the batch.
      expect((await pool.query(`select code from departments where tenant_id = $1 and name = 'Maintenance'`, [t.id])).rows[0].code).toBeNull();
      const list = await api(app, owner).get('/designations');
      expect(list.body.map((d: { name: string }) => d.name)).toEqual(['Machine Operator', 'Plant Head']);
    });

    it('is for people who manage the organization only', async () => {
      expect((await api(app, plainToken).post('/setup/structure').send({ departments: [{ name: 'Sneaky' }] })).status).toBe(403);
      expect((await api(app, plainToken).post('/setup/complete')).status).toBe(403);
    });

    it('finishes once and shows on /me', async () => {
      const done = await api(app, owner).post('/setup/complete');
      expect(done.status).toBe(200);
      const first = done.body.setupCompletedAt;
      expect((await api(app, owner).get('/me')).body.tenant.setupCompletedAt).toBe(new Date(first).toISOString());
      expect((await api(app, owner).post('/setup/complete')).body.setupCompletedAt).toBe(first);
    });
  });

  describe('logins created at hire', () => {
    it('creates a working login with a generated temporary password that must be replaced at first sign-in', async () => {
      const email = `riya@${t.slug}.test`;
      const res = await api(app, owner).post('/employees').send({
        firstName: 'Riya', lastName: 'Rao', workEmail: email, legalEntityId: t.legalEntityId, dateOfJoining: today(), probationMonths: 0, loginMode: 'password',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.login.email).toBe(email);
      const temp = res.body.login.temporaryPassword as string;
      expect(temp).toHaveLength(16);
      expect(res.body.employee.membershipId).toBeTruthy();
      expect(res.body.employee.loginStatus).toBe('active');
      // The welcome email never carries the password.
      const mail = (await pool.query(`select subject, text_body from email_messages where to_email = $1`, [email])).rows;
      expect(mail).toHaveLength(1);
      expect(mail[0].text_body).not.toContain(temp);

      const http = () => request(app.getHttpServer());
      const first = await http().post('/api/v1/auth/login').send({ email, password: temp });
      expect(first.body.status).toBe('password_change_required');
      expect(first.body.accessToken).toBeUndefined();
      // The temporary password cannot be kept, and weak ones are refused.
      expect((await http().post('/api/v1/auth/initial-password').send({ changeToken: first.body.changeToken, newPassword: temp })).body.error.code).toBe('same_password');
      expect((await http().post('/api/v1/auth/initial-password').send({ changeToken: first.body.changeToken, newPassword: 'short' })).status).toBe(422);
      const set = await http().post('/api/v1/auth/initial-password').send({ changeToken: first.body.changeToken, newPassword: 'Riya-Own-Password-1' });
      expect(set.body.status, JSON.stringify(set.body)).toBe('ok');
      const me = await api(app, set.body.accessToken).get('/employees/me');
      expect(me.body.employee.firstName).toBe('Riya');
      // From now on the new password signs straight in and the temporary one no longer works.
      expect((await http().post('/api/v1/auth/login').send({ email, password: 'Riya-Own-Password-1' })).body.status).toBe('ok');
      expect((await http().post('/api/v1/auth/login').send({ email, password: temp })).status).toBe(401);
      // A change token cannot be used twice.
      expect((await http().post('/api/v1/auth/initial-password').send({ changeToken: first.body.changeToken, newPassword: 'Another-Password-22' })).status).toBe(401);
    });

    it('accepts a temporary password typed by HR without echoing it back', async () => {
      const email = `kiran@${t.slug}.test`;
      const res = await api(app, owner).post('/employees').send({
        firstName: 'Kiran', workEmail: email, legalEntityId: t.legalEntityId, dateOfJoining: today(), loginMode: 'password', initialPassword: 'Kiran-Temp-Pass-9',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.login).toBeUndefined();
      expect((await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password: 'Kiran-Temp-Pass-9' })).body.status).toBe('password_change_required');
      // Weak typed passwords and passwords without the password mode are refused.
      expect((await api(app, owner).post('/employees').send({ firstName: 'W', workEmail: `w@${t.slug}.test`, legalEntityId: t.legalEntityId, dateOfJoining: today(), loginMode: 'password', initialPassword: 'weak' })).status).toBe(422);
      expect((await api(app, owner).post('/employees').send({ firstName: 'W', workEmail: `w@${t.slug}.test`, legalEntityId: t.legalEntityId, dateOfJoining: today(), loginMode: 'invite', initialPassword: 'Kiran-Temp-Pass-9' })).status).toBe(422);
      expect((await api(app, owner).post('/employees').send({ firstName: 'W', legalEntityId: t.legalEntityId, dateOfJoining: today(), loginMode: 'password' })).status).toBe(422);
    });

    it('will not set a password on an email that already has a CREW account, and the hire is rolled back', async () => {
      const res = await api(app, owner).post('/employees').send({ firstName: 'Dup', workEmail: plain.email, legalEntityId: t.legalEntityId, dateOfJoining: today(), loginMode: 'password' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('account_exists');
      expect((await pool.query(`select 1 from employees where tenant_id = $1 and first_name = 'Dup'`, [t.id])).rowCount).toBe(0);
    });

    it('gives an existing employee a login from their profile, by invitation or temporary password', async () => {
      const make = async (first: string) => (await api(app, owner).post('/employees').send({ firstName: first, workEmail: `${first.toLowerCase()}@${t.slug}.test`, legalEntityId: t.legalEntityId, dateOfJoining: today() })).body.employee.id as string;
      const a = await make('Anil');
      const inv = await api(app, owner).post(`/employees/${a}/login`).send({ mode: 'invite' });
      expect(inv.status, JSON.stringify(inv.body)).toBe(201);
      expect(inv.body.inviteUrl).toContain('/accept-invite?token=');
      expect(inv.body.employee.loginStatus).toBe('invited');
      expect((await api(app, owner).post(`/employees/${a}/login`).send({ mode: 'password' })).body.error.code).toBe('already_linked');
      const b = await make('Bina');
      const pw = await api(app, owner).post(`/employees/${b}/login`).send({ mode: 'password' });
      expect(pw.body.login.temporaryPassword).toHaveLength(16);
      // Ordinary members cannot create logins.
      const c = await make('Chet');
      expect([403, 404]).toContain((await api(app, plainToken).post(`/employees/${c}/login`).send({ mode: 'password' })).status);
    });

    it('generates passwords that pass the password rules', () => {
      for (let i = 0; i < 200; i++) {
        const p = temporaryPasswordValue();
        expect(p).toHaveLength(16);
        expect([/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].every((r) => r.test(p))).toBe(true);
      }
    });
  });

  describe('attendance registration', () => {
    let emp: string;

    it('registers the usual shift and enrolment numbers at hire', async () => {
      const res = await api(app, owner).post('/employees').send({
        firstName: 'Meena', legalEntityId: t.legalEntityId, dateOfJoining: today(), defaultShiftId: nightShift,
        attendanceEnrolments: [{ deviceUserId: '1042' }],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      emp = res.body.employee.id;
      expect(res.body.employee.defaultShiftId).toBe(nightShift);
      const reg = await api(app, owner).get(`/employees/${emp}/attendance-registration`);
      expect(reg.body).toMatchObject({ registered: true, defaultShift: { id: nightShift, name: 'Night shift', startTime: '22:00' }, enrolments: [{ deviceUserId: '1042', deviceId: null }] });
      // The shift is the one attendance uses for this person.
      const to = new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10);
      const plan = await api(app, owner).get(`/shifts/schedule?employeeId=${emp}&from=${today()}&to=${to}`);
      expect(plan.status, JSON.stringify(plan.body)).toBe(200);
      const working = plan.body.days.filter((d: { dayType: string }) => d.dayType === 'working');
      expect(working.length).toBeGreaterThan(0);
      for (const d of working) expect(d.shift.code).toBe('NIGHT');
    });

    it('refuses an enrolment number someone else already uses, and rolls the hire back', async () => {
      const res = await api(app, owner).post('/employees').send({ firstName: 'Clash', legalEntityId: t.legalEntityId, dateOfJoining: today(), attendanceEnrolments: [{ deviceUserId: '1042' }] });
      expect(res.status).toBe(409);
      expect(res.body.error.message).toContain('Meena');
      expect((await pool.query(`select 1 from employees where tenant_id = $1 and first_name = 'Clash'`, [t.id])).rowCount).toBe(0);
      expect((await api(app, owner).post('/employees').send({ firstName: 'Bad', legalEntityId: t.legalEntityId, dateOfJoining: today(), attendanceEnrolments: [{ deviceUserId: 'has space' }] })).status).toBe(422);
    });

    it('updates the registration from the profile', async () => {
      const res = await api(app, owner).put(`/employees/${emp}/attendance-registration`).send({ defaultShiftId: generalShift, enrolments: [{ deviceUserId: '2001' }, { deviceUserId: '2002' }] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.defaultShift.code).toBe('GEN');
      expect(res.body.enrolments.map((x: { deviceUserId: string }) => x.deviceUserId)).toEqual(['2001', '2002']);
      expect((await pool.query(`select device_user_id from device_user_mappings where employee_id = $1 order by 1`, [emp])).rows.map((r) => r.device_user_id)).toEqual(['2001', '2002']);
      const cleared = await api(app, owner).put(`/employees/${emp}/attendance-registration`).send({ defaultShiftId: null, enrolments: [] });
      expect(cleared.body).toMatchObject({ registered: false, defaultShift: null, enrolments: [] });
      expect([403, 404]).toContain((await api(app, plainToken).put(`/employees/${emp}/attendance-registration`).send({ defaultShiftId: null, enrolments: [] })).status);
      const audit = await pool.query(`select count(*)::int as n from audit_events where tenant_id = $1 and action = 'employee.attendance_registration_updated' and resource_id = $2`, [t.id, emp]);
      expect(audit.rows[0].n).toBe(2);
    });
  });

  describe('employee photos', () => {
    let emp: string;
    let self: string;

    beforeAll(async () => {
      emp = (await api(app, owner).post('/employees').send({ firstName: 'Photo', lastName: 'Person', legalEntityId: t.legalEntityId, dateOfJoining: today() })).body.employee.id;
      self = (await api(app, owner).post('/employees').send({ firstName: 'Plain', legalEntityId: t.legalEntityId, dateOfJoining: today(), membershipId: plain.membershipId })).body.employee.id;
    });

    it('lets HR upload, view and remove a photo', async () => {
      expect((await api(app, owner).get(`/employees/${emp}/photo`)).status).toBe(404);
      const up = await api(app, owner).put(`/employees/${emp}/photo`).attach('file', PNG, { filename: 'face.png', contentType: 'image/png' });
      expect(up.status, JSON.stringify(up.body)).toBe(200);
      expect(up.body.photoUpdatedAt).toBeTruthy();
      const got = await api(app, owner).get(`/employees/${emp}/photo`).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
      expect(got.status).toBe(200);
      expect(got.headers['content-type']).toBe('image/png');
      expect(Buffer.compare(got.body as Buffer, PNG)).toBe(0);
      expect((await api(app, owner).get(`/employees/${emp}`)).body.photoUpdatedAt).toBeTruthy();
      // Replacing keeps one photo; removing clears it.
      expect((await api(app, owner).put(`/employees/${emp}/photo`).attach('file', PNG, { filename: 'again.png', contentType: 'image/png' })).status).toBe(200);
      expect((await api(app, owner).delete(`/employees/${emp}/photo`)).status).toBe(204);
      expect((await api(app, owner).get(`/employees/${emp}/photo`)).status).toBe(404);
      expect((await pool.query(`select photo_key, photo_updated_at from employees where id = $1`, [emp])).rows[0]).toEqual({ photo_key: null, photo_updated_at: null });
    });

    it('checks the file type and content', async () => {
      const pdf = await api(app, owner).put(`/employees/${emp}/photo`).attach('file', Buffer.from('%PDF-1.4 nope'), { filename: 'x.pdf', contentType: 'application/pdf' });
      expect(pdf.body.error.code).toBe('unsupported_type');
      const fake = await api(app, owner).put(`/employees/${emp}/photo`).attach('file', Buffer.from('MZ not really an image'), { filename: 'x.png', contentType: 'image/png' });
      expect(fake.body.error.code).toBe('content_mismatch');
      expect((await api(app, owner).put(`/employees/${emp}/photo`)).body.error.code).toBe('file_required');
    });

    it('lets employees set their own photo but not anyone else\'s', async () => {
      const own = await api(app, plainToken).put(`/employees/${self}/photo`).attach('file', PNG, { filename: 'me.png', contentType: 'image/png' });
      expect(own.status, JSON.stringify(own.body)).toBe(200);
      const other = await api(app, plainToken).put(`/employees/${emp}/photo`).attach('file', PNG, { filename: 'x.png', contentType: 'image/png' });
      expect([403, 404]).toContain(other.status);
    });
  });

  it('keeps the default password unaffected for ordinary sign-ins', async () => {
    expect((await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: plain.email, password: PASSWORD })).body.status).toBe('ok');
  });
});
