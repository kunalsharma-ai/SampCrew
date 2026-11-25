import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { MailerService } from '../src/platform/notify/mailer.service';
import { addMember, adminPool, api, createApp, createTenant, login, loginWithMfa, type TestDb, type TestTenant } from './helpers';

/** A file download as a Buffer (supertest gives binary bodies as text otherwise). */
const binary = (res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

/** The smallest SMTP server nodemailer talks to: accepts every message and keeps it. */
function fakeSmtp() {
  const received: string[] = [];
  const server: Server = createServer((sock: Socket) => {
    let data = false;
    let body = '';
    sock.write('220 fake.smtp ready\r\n');
    sock.on('data', (chunk) => {
      for (const line of chunk.toString().split('\r\n')) {
        if (data) {
          if (line === '.') { data = false; received.push(body); body = ''; sock.write('250 queued as fake\r\n'); } else body += `${line}\n`;
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (!line) continue;
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-fake.smtp\r\n250 8BITMIME\r\n');
        else if (cmd === 'DATA') { data = true; sock.write('354 go ahead\r\n'); } else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); } else sock.write('250 ok\r\n');
      }
    });
  });
  return { server, received };
}

/**
 * Issue #83 (HR Admin and Employee feedback) through the HTTP API: the company's own email server, same names,
 * the next employee ID, the homepage name, monthly leave credit, invitations without email, the lockout time, no
 * notices about your own actions, several documents in one request, the setup gaps and the attendance report in
 * every format for chosen people.
 */
describe('issue #83 feedback', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let owner: string;
  let hr: string;
  let hrMember: { email: string; membershipId: string };
  const smtp = fakeSmtp();

  const hire = async (token: string, body: Record<string, unknown>) => {
    const r = await api(app, token).post('/employees').send({ legalEntityId: t.legalEntityId, dateOfJoining: '2024-01-15', probationMonths: 0, onboardingTemplateId: null, ...body });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.employee as { id: string; employeeCode: string };
  };

  beforeAll(async () => {
    await new Promise<void>((resolve) => smtp.server.listen(0, '127.0.0.1', resolve));
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool, { plan: 'business' });
    owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    hrMember = await addMember(pool, t, { roles: ['hr_admin'], name: 'Hema HR' });
    hr = (await loginWithMfa(app, pool, hrMember.email)).accessToken;
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
    smtp.server.close();
  });

  it('HR 2 / Emp 2-3: two people with the same name are hired, and the next employee ID is shown before saving', async () => {
    const next = await api(app, owner).get('/employees/next-code');
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(next.body.code).toMatch(/\d/);
    const a = await hire(owner, { firstName: 'Ravi', lastName: 'Kumar' });
    expect(a.employeeCode).toBe(next.body.code);
    const b = await hire(owner, { firstName: 'Ravi', lastName: 'Kumar' });
    expect(b.id).not.toBe(a.id);
    expect(b.employeeCode).not.toBe(a.employeeCode);
    // A typed ID is kept as typed.
    const c = await hire(owner, { firstName: 'Ravi', lastName: 'Kumar', employeeCode: 'RK-777' });
    expect(c.employeeCode).toBe('RK-777');
    expect((await api(app, owner).get('/employees/next-code')).body.code).not.toBe(b.employeeCode);
  });

  it('Emp 1: the homepage greets people by the name on their employee record after it changes', async () => {
    const m = await addMember(pool, t, { name: 'Old Login Name' });
    const e = await hire(owner, { firstName: 'Meera', lastName: 'Iyer', membershipId: m.membershipId });
    const token = (await login(app, m.email)).accessToken;
    expect((await api(app, token).get('/me')).body.user.fullName).toBe('Meera Iyer');
    const r = await api(app, owner).patch(`/employees/${e.id}`).send({ firstName: 'Meera', lastName: 'Nair' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await api(app, token).get('/me')).body.user.fullName).toBe('Meera Nair');
  });

  it('HR 6: a leave type can be unpaid and credit days every month; new joiners get opening days at registration', async () => {
    const paid = await api(app, owner).post('/leave/types').send({ code: 'ML', name: 'Monthly Leave', monthlyCredit: '1.5' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const unpaid = await api(app, owner).post('/leave/types').send({ code: 'UL', name: 'Unpaid Leave', paid: false });
    expect(unpaid.status, JSON.stringify(unpaid.body)).toBe(201);
    const types = (await api(app, owner).get('/leave/types')).body as { id: string; paid: boolean; monthlyCredit: string | null }[];
    expect(types.find((x) => x.id === paid.body.id)).toMatchObject({ paid: true, monthlyCredit: '1.5' });
    expect(types.find((x) => x.id === unpaid.body.id)).toMatchObject({ paid: false, monthlyCredit: null });
    expect((await api(app, owner).post('/leave/types').send({ code: 'BAD', name: 'Too much', monthlyCredit: '40' })).status).toBe(422);

    // Opening days asked at registration, for a brand new joiner too.
    const joiner = await hire(owner, { firstName: 'Nisha', lastName: 'New', dateOfJoining: new Date().toISOString().slice(0, 10), openingLeaveBalances: [{ leaveTypeId: paid.body.id, days: '3' }] });
    const credit = await pool.find('leave_ledger', { employee_id: joiner.id, leave_type_id: paid.body.id });
    expect(credit.map((x) => String(x.quantity))).toContain('3.00');

    // The monthly run credits each employee once a month, however often it runs.
    expect((await api(app, owner).post('/leave/escalations/run')).status).toBe(201);
    expect((await api(app, owner).post('/leave/escalations/run')).status).toBe(201);
    const month = new Date().toISOString().slice(0, 7);
    const monthly = await pool.find('leave_ledger', { employee_id: joiner.id, leave_type_id: paid.body.id, accrual_key: `MONTH${month}` });
    expect(monthly).toHaveLength(1);
    expect(String(monthly[0]!.quantity)).toBe('1.50');
  });

  it('HR 7: Home is told which basics are missing (no shift, no paid leave type yet)', async () => {
    const fresh = await createTenant(pool, { plan: 'business' });
    const token = (await loginWithMfa(app, pool, fresh.ownerEmail)).accessToken;
    const o = (await api(app, token).get('/org/overview')).body;
    expect(o).toMatchObject({ leaveTypes: 0, paidLeaveTypes: 0, employees: 0, mailConfigured: false });
    expect(typeof o.shiftTemplates).toBe('number');
    expect((await api(app, owner).get('/org/overview')).body.paidLeaveTypes).toBeGreaterThan(0);
  });

  it('HR 1 / HR 3: the company sets up its own email server, tests it, and invitations go out through it (or come back as a link)', async () => {
    // Without email set up, an invitation (and a resend) gives the link to share by hand.
    const inv = await api(app, hr).post('/members/invite').send({ email: `ivy.${Date.now()}@example.test`, fullName: 'Ivy Invite' });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect(inv.body).toMatchObject({ delivery: 'email_not_configured' });
    expect(inv.body.inviteUrl).toContain('/accept-invite?token=');
    const again = await api(app, hr).post(`/members/${inv.body.member.id}/resend-invite`);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.inviteUrl).toContain('/accept-invite?token=');

    // Company-wide HR may set it up; an Employee Workspace person may not.
    const staff = await addMember(pool, t, { name: 'Sam Staff' });
    const staffToken = (await login(app, staff.email)).accessToken;
    expect((await api(app, staffToken).get('/settings/mail')).status).toBe(403);
    const { port } = smtp.server.address() as AddressInfo;
    const body = { enabled: true, host: '127.0.0.1', port, security: 'none', username: '', fromName: 'Acme HR', fromAddress: 'hr@acme.example', replyTo: '' };
    const saved = await api(app, hr).put('/settings/mail').send(body);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ enabled: true, host: '127.0.0.1', fromAddress: 'hr@acme.example' });
    expect(JSON.stringify(saved.body)).not.toContain('secrets');
    // A user name needs its password.
    expect((await api(app, hr).put('/settings/mail').send({ ...body, username: 'apikey' })).status).toBe(422);

    const test = await api(app, hr).post('/settings/mail/test').send({ sendTo: 'check@acme.example' });
    expect(test.status, JSON.stringify(test.body)).toBe(200);
    expect(test.body.ok, test.body.message).toBe(true);
    expect(smtp.received.some((m) => /From: "?Acme HR"? <hr@acme\.example>/.test(m) && m.includes('test email from SampCrew'))).toBe(true);
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'workspace.mail_settings_saved' })).toBeGreaterThan(0);

    // Now invitations are emailed through the company's server and no link is handed back in production-like setups.
    const sentBefore = smtp.received.length;
    const inv2 = await api(app, hr).post('/members/invite').send({ email: `ian.${Date.now()}@example.test`, fullName: 'Ian Invite' });
    expect(inv2.body.delivery).toBe('email_queued');
    await app.get(MailerService).sendBatch(200);
    expect(smtp.received.length).toBeGreaterThan(sentBefore);
    expect(smtp.received.at(-1)).toContain('hr@acme.example');
    expect((await api(app, owner).get('/org/overview')).body.mailConfigured).toBe(true);
  });

  it('HR 11: after too many wrong passwords the message says when to try again', async () => {
    const m = await addMember(pool, t, { name: 'Lock Test' });
    let last = '';
    for (let i = 0; i < 5; i++) {
      const r = await api(app).post('/auth/login').send({ email: m.email, password: 'wrong-password' });
      expect(r.status).toBe(401);
      last = r.body.error.message;
    }
    expect(last).toMatch(/try again after \d+ minutes/);
    const locked = await api(app).post('/auth/login').send({ email: m.email, password: 'Correct-Horse-42!' });
    expect(locked.status).toBe(429);
    expect(locked.body.error.message).toMatch(/^Too many failed sign-in attempts\. Try again after (1[0-5]|[1-9]) minutes?\.$/);
    expect(locked.body.error.details.retryInMinutes).toBeGreaterThan(0);
  });

  it('HR 9 / Emp 5: several documents in one request, and the person who asked gets no notice about it', async () => {
    const m = await addMember(pool, t, { name: 'Dev Docs' });
    const e = await hire(owner, { firstName: 'Dev', lastName: 'Docs', membershipId: m.membershipId });
    const r = await api(app, owner).post('/document-requests').send({ target: 'employee', employeeIds: [e.id], typeKey: 'aadhaar', typeKeys: ['aadhaar', 'pan'], reason: 'Identity proof for records' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((r.body as { typeKey: string }[]).map((x) => x.typeKey).sort()).toEqual(['aadhaar', 'pan']);
    expect(await pool.count('notifications', { membership_id: m.membershipId, kind: 'document.requested' })).toBe(2);
    expect(await pool.count('notifications', { membership_id: t.ownerMembershipId, kind: 'document.requested' })).toBe(0);
    // A replacement still asks for exactly one document.
    expect((await api(app, owner).post('/document-requests').send({ target: 'employee', employeeIds: [e.id], typeKey: 'aadhaar', typeKeys: ['pan'], reason: 'Renew it', replacesDocumentId: e.id })).status).toBe(422);

    // An announcement to everyone reaches everyone except the HR person who published it.
    const a = await api(app, hr).post('/announcements').send({ title: 'Office closed Monday', body: 'The office is closed on Monday for maintenance.' });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect((await api(app, hr).post(`/announcements/${a.body.id}/publish`)).status).toBe(200);
    expect(await pool.count('notifications', { membership_id: hrMember.membershipId, link: `/announcements/${a.body.id}` })).toBe(0);
    expect(await pool.count('notifications', { membership_id: m.membershipId, link: `/announcements/${a.body.id}` })).toBe(1);
  });

  it('HR 12 / Emp 8: the attendance report downloads as CSV, Word and PDF for chosen people, with who they are', async () => {
    const from = '2024-03-04';
    const to = '2024-03-08';
    const e1 = await hire(owner, { firstName: 'Asha', lastName: 'Report' });
    const e2 = await hire(owner, { firstName: 'Bharat', lastName: 'Report' });
    await pool.tenant(t.id, async (tx) => {
      for (const id of [e1.id, e2.id]) {
        await tx.collection('attendance_days').insert({ employee_id: id, work_date: from, status: 'present', day_type: 'working', engine_version: 1, late_minutes: 0, worked_minutes: 480, first_in: new Date(`${from}T03:30:00Z`), last_out: new Date(`${from}T12:00:00Z`) });
      }
    });
    const get = (qs: string) => api(app, owner).get(`/attendance/export?from=${from}&to=${to}${qs}`).buffer(true).parse(binary as never) as unknown as Promise<{ status: number; body: Buffer; headers: Record<string, string> }>;

    const csv = await get(`&format=csv&include=records&employeeIds=${e1.id}`);
    expect(csv.status, csv.body.toString()).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.body.toString('utf8').replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toContain('Employee Name,Employee ID,Department,Designation,Location,Date');
    expect(lines.slice(1).every((l) => l.includes('Asha Report'))).toBe(true);
    expect(lines.some((l) => l.includes('Bharat Report'))).toBe(false);
    // One row per day of the period for the chosen person, with the day's status.
    expect(lines.slice(1)).toHaveLength(5);
    expect(lines.some((l) => l.includes(`,${from},Monday,`)), lines.join('\n')).toBe(true);

    const docx = await get(`&format=docx&employeeIds=${e1.id},${e2.id}`);
    expect(docx.status).toBe(200);
    expect(docx.headers['content-disposition']).toContain('.docx');
    const xml = strFromU8(unzipSync(new Uint8Array(docx.body))['word/document.xml']!);
    expect(xml).toContain('Attendance report');
    expect(xml).toContain('Asha Report');
    expect(xml).toContain('Bharat Report');

    const pdf = await get(`&format=pdf&include=people&employeeIds=${e2.id}`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');

    // Excel still holds every sheet, and the format is checked.
    expect((await get('&format=xlsx')).body.subarray(0, 2).toString()).toBe('PK');
    expect((await get('&format=txt')).status).toBe(422);
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'attendance.exported' })).toBeGreaterThanOrEqual(4);
  });
});
