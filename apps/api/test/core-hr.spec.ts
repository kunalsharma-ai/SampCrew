import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HrJobsService } from '../src/modules/hr-jobs/hr-jobs.service';
import { MailerService } from '../src/platform/notify/mailer.service';
import { addMember, adminPool, api, createApp, createTenant, department, login, loginWithMfa, PASSWORD, type TestTenant } from './helpers';

const Y = new Date().getUTCFullYear() + 1; // leave tests use next year so every date is in the future
const weekday = (month: number, nth = 1, dow = 1) => {
  const d = new Date(Date.UTC(Y, month - 1, 1));
  while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCDate(d.getUTCDate() + 7 * (nth - 1));
  return d.toISOString().slice(0, 10);
};
const plus = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

/** Phase 2 end-to-end through the HTTP API: hiring, scopes, job history, leave with approvals, documents, email. */
describe('core HR', () => {
  let app: INestApplication;
  let pool: Pool;
  let t: TestTenant;
  let other: TestTenant;
  let owner: string;
  let hrAdmin: string;
  let assembly: string;
  let qa: string;
  const people: Record<string, { email: string; membershipId: string; employeeId?: string }> = {};
  const token = async (who: string) => (await login(app, people[who]!.email)).accessToken;

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    other = await createTenant(pool);
    assembly = await department(pool, t, 'Assembly');
    qa = await department(pool, t, 'Quality');
    people.hr = await addMember(pool, t, { roles: ['hr_admin'], name: 'Hana HR' });
    people.supervisor = await addMember(pool, t, { roles: ['department_manager'], departmentId: assembly, name: 'Sam Supervisor' });
    people.operator = await addMember(pool, t, { departmentId: assembly, managerId: people.supervisor.membershipId, name: 'Olu Operator' });
    people.peer = await addMember(pool, t, { departmentId: qa, name: 'Pat Peer' });
    owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    hrAdmin = (await loginWithMfa(app, pool, people.hr.email)).accessToken;
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('hiring and records', () => {
    it('hires people, links logins, allocates codes and creates the job record and onboarding checklist', async () => {
      const hire = async (body: Record<string, unknown>) => {
        const res = await api(app, hrAdmin).post('/employees').send({ legalEntityId: t.legalEntityId, dateOfJoining: '2024-01-15', probationMonths: 0, ...body });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return res.body.employee as { id: string; employeeCode: string; status: string; managerEmployeeId: string | null };
      };
      const hr = await hire({ firstName: 'Hana', lastName: 'HR', membershipId: people.hr!.membershipId });
      people.hr!.employeeId = hr.id;
      const sup = await hire({ firstName: 'Sam', lastName: 'Supervisor', departmentId: assembly, membershipId: people.supervisor!.membershipId });
      people.supervisor!.employeeId = sup.id;
      const op = await hire({ firstName: 'Olu', lastName: 'Operator', departmentId: assembly, managerEmployeeId: sup.id, membershipId: people.operator!.membershipId });
      people.operator!.employeeId = op.id;
      const peer = await hire({ firstName: 'Pat', lastName: 'Peer', departmentId: qa, membershipId: people.peer!.membershipId });
      people.peer!.employeeId = peer.id;
      // A shop-floor worker without a CREW login.
      const helper = await hire({ firstName: 'Hari', lastName: 'Helper', departmentId: assembly, managerEmployeeId: sup.id, probationMonths: 6, dateOfJoining: today() });
      people.helper = { email: '', membershipId: '', employeeId: helper.id };

      expect(hr.employeeCode).toBe('EMP0001');
      expect(helper.employeeCode).toBe('EMP0005');
      expect(helper.status).toBe('probation');
      const rec = await pool.query(`select change_reason, effective_from::text from employment_records where employee_id = $1`, [op.id]);
      expect(rec.rows).toEqual([{ change_reason: 'hire', effective_from: '2024-01-15' }]);
      const tasks = await pool.query(`select owner, assignee_membership_id from onboarding_tasks where employee_id = $1 order by sort`, [op.id]);
      expect(tasks.rowCount).toBe(8);
      // Manager tasks go to the manager, the joiner's own tasks to their login.
      expect(tasks.rows.find((r) => r.owner === 'manager').assignee_membership_id).toBe(people.supervisor!.membershipId);
      expect(tasks.rows.find((r) => r.owner === 'employee').assignee_membership_id).toBe(people.operator!.membershipId);
      // The membership follows the employee placement, including the manager's login.
      const m = await pool.query(`select manager_membership_id, department_id, employee_id from memberships where id = $1`, [people.operator!.membershipId]);
      expect(m.rows[0]).toEqual({ manager_membership_id: people.supervisor!.membershipId, department_id: assembly, employee_id: op.id });
    });

    it('validates hiring input and refuses to link a login twice', async () => {
      const bad = await api(app, hrAdmin).post('/employees').send({ legalEntityId: t.legalEntityId, firstName: '', dateOfJoining: '2024-13-01' });
      expect(bad.status).toBe(422);
      const twice = await api(app, hrAdmin).post('/employees').send({ legalEntityId: t.legalEntityId, firstName: 'X', dateOfJoining: '2024-01-01', membershipId: people.operator!.membershipId });
      expect(twice.status).toBe(409);
      const loop = await api(app, hrAdmin).post(`/employees/${people.supervisor!.employeeId}/job-changes`).send({ effectiveFrom: today(), reason: 'manager_change', managerEmployeeId: people.operator!.employeeId });
      expect(loop.status).toBe(400);
      expect(loop.body.error.message).toMatch(/loop/);
    });

    it('limits the directory to what each person may see, including staff without logins', async () => {
      const ids = async (tok: string) => new Set<string>((await api(app, tok).get('/employees?limit=200')).body.items.map((e: { id: string }) => e.id));
      expect(await ids(await token('operator'))).toEqual(new Set([people.operator!.employeeId]));
      expect(await ids(await token('supervisor'))).toEqual(new Set([people.supervisor!.employeeId, people.operator!.employeeId, people.helper!.employeeId]));
      expect((await ids(hrAdmin)).size).toBe(5);
      const peerView = await api(app, await token('peer')).get(`/employees/${people.operator!.employeeId}`);
      expect(peerView.status).toBe(404);
    });

    it('lets employees edit only their own contact fields', async () => {
      const op = await token('operator');
      const ok = await api(app, op).patch(`/employees/${people.operator!.employeeId}`).send({ phone: '+91 98200 00000', preferredName: 'Olu' });
      expect(ok.status).toBe(200);
      expect(ok.body.displayName).toBe('Olu Operator');
      const blocked = await api(app, op).patch(`/employees/${people.operator!.employeeId}`).send({ firstName: 'Changed' });
      expect(blocked.status).toBe(403);
      const unknown = await api(app, op).patch(`/employees/${people.operator!.employeeId}`).send({ salary: 1 });
      expect(unknown.status).toBe(422);
    });

    it('encrypts bank details, requires MFA to read them and audits every view', async () => {
      const op = await token('operator');
      const put = await api(app, op).put(`/employees/${people.operator!.employeeId}/sensitive`).send({ bankName: 'Demo Bank', bankAccount: '123456789012', bankRouting: 'DEMO0001234' });
      expect(put.status).toBe(403);
      expect(put.body.error.code).toBe('mfa_required');
      const set = await api(app, hrAdmin).put(`/employees/${people.operator!.employeeId}/sensitive`).send({ bankName: 'Demo Bank', bankAccount: '123456789012', bankRouting: 'DEMO0001234', taxId: 'ABCDE1234F' });
      expect(set.status).toBe(200);
      const raw = await pool.query(`select bank_account_enc, tax_id_enc from employee_sensitive where employee_id = $1`, [people.operator!.employeeId]);
      expect(raw.rows[0].bank_account_enc).toMatch(/^v2\.[0-9a-f]{8}\./);
      expect(JSON.stringify(raw.rows[0])).not.toContain('123456789012');
      const mine = await loginWithMfa(app, pool, people.operator!.email);
      const got = await api(app, mine.accessToken).get(`/employees/${people.operator!.employeeId}/sensitive`);
      expect(got.status).toBe(200);
      expect(got.body.bankAccount).toBe('123456789012');
      const supervisor = await loginWithMfa(app, pool, people.supervisor!.email);
      expect((await api(app, supervisor.accessToken).get(`/employees/${people.operator!.employeeId}/sensitive`)).status).toBe(404);
      const views = await pool.query(`select count(*)::int as n from audit_events where tenant_id = $1 and action = 'employee.sensitive_viewed'`, [t.id]);
      expect(views.rows[0].n).toBe(1);
      const audit = await pool.query(`select changes::text, metadata::text from audit_events where tenant_id = $1 and action = 'employee.sensitive_updated'`, [t.id]);
      expect(audit.rows[0].changes + audit.rows[0].metadata).not.toContain('123456789012');
      // The employee is told when someone else changes their bank details.
      const note = await pool.query(`select 1 from notifications where membership_id = $1 and kind = 'employee.sensitive_changed'`, [people.operator!.membershipId]);
      expect(note.rowCount).toBe(1);
    });
  });

  describe('effective-dated job changes', () => {
    it('keeps a future transfer pending until its date, then applies it and moves access with it', async () => {
      const from = plus(today(), 10);
      const res = await api(app, hrAdmin).post(`/employees/${people.peer!.employeeId}/job-changes`)
        .send({ effectiveFrom: from, reason: 'transfer', departmentId: assembly, managerEmployeeId: people.supervisor!.employeeId });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.departmentId).toBe(qa);
      const sup = await token('supervisor');
      expect((await api(app, sup).get(`/employees/${people.peer!.employeeId}`)).status).toBe(404);

      const later = await api(app, hrAdmin).post(`/employees/${people.peer!.employeeId}/job-changes`).send({ effectiveFrom: plus(today(), 5), reason: 'promotion', grade: 'L2' });
      expect(later.status).toBe(409);

      await app.get(HrJobsService).runTenant(t.id, from);
      const e = await pool.query(`select current_department_id, current_manager_employee_id from employees where id = $1`, [people.peer!.employeeId]);
      expect(e.rows[0]).toEqual({ current_department_id: assembly, current_manager_employee_id: people.supervisor!.employeeId });
      const m = await pool.query(`select department_id, manager_membership_id from memberships where id = $1`, [people.peer!.membershipId]);
      expect(m.rows[0]).toEqual({ department_id: assembly, manager_membership_id: people.supervisor!.membershipId });
      expect((await api(app, sup).get(`/employees/${people.peer!.employeeId}`)).status).toBe(200);

      const history = await api(app, hrAdmin).get(`/employees/${people.peer!.employeeId}/history`);
      expect(history.body.records.map((r: { reason: string }) => r.reason)).toEqual(['transfer', 'hire']);
      expect(history.body.records[1].effectiveTo).toBe(plus(from, -1));
      expect(history.body.events.map((e: { kind: string }) => e.kind)).toContain('transferred');
    });

    it('lifecycle events cannot be edited', async () => {
      await expect(pool.query(`update lifecycle_events set kind = 'confirmed' where employee_id = $1`, [people.peer!.employeeId])).rejects.toThrow();
    });

    it('confirms probation', async () => {
      const res = await api(app, hrAdmin).post(`/employees/${people.helper!.employeeId}/confirm`).send({ effectiveOn: today() });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('active');
      expect((await api(app, hrAdmin).post(`/employees/${people.helper!.employeeId}/confirm`).send({ effectiveOn: today() })).status).toBe(409);
    });
  });

  describe('leave and approvals', () => {
    let cl: string;
    let unpaid: string;

    it('sets up leave types, a policy and holidays', async () => {
      const type = await api(app, hrAdmin).post('/leave/types').send({ code: 'cl', name: 'Casual leave' });
      expect(type.status).toBe(201);
      expect(type.body.code).toBe('CL');
      cl = type.body.id;
      unpaid = (await api(app, hrAdmin).post('/leave/types').send({ code: 'LWP', name: 'Unpaid', paid: false })).body.id;
      const pol = await api(app, hrAdmin).post('/leave/policies').send({ leaveTypeId: cl, accrualMethod: 'annual_upfront', annualEntitlement: '6', maxConsecutiveDays: '4' });
      expect(pol.status).toBe(201);
      expect(pol.body.annualEntitlement).toBe('6.00');
      expect((await api(app, hrAdmin).post('/leave/policies').send({ leaveTypeId: unpaid, accrualMethod: 'none', annualEntitlement: 0 })).status).toBe(201);
      const cal = (await api(app, hrAdmin).get('/leave/calendars')).body.find((c: { isDefault: boolean }) => c.isDefault);
      const hol = await api(app, hrAdmin).post(`/leave/calendars/${cal.id}/holidays`).send({ date: weekday(3, 1, 3), name: 'Test holiday' });
      expect(hol.status).toBe(201);
      expect((await api(app, await token('operator')).post('/leave/types').send({ code: 'X', name: 'X' })).status).toBe(403);
    });

    it('posts accruals once, however many times the job runs', async () => {
      const first = await api(app, hrAdmin).post('/leave/accruals/run').send({ asOf: `${Y}-01-01` });
      expect(first.body.posted).toBe(5);
      const again = await api(app, hrAdmin).post('/leave/accruals/run').send({ asOf: `${Y}-01-01` });
      expect(again.body.posted).toBe(0);
      const bal = await api(app, await token('operator')).get(`/leave/balances?year=${Y}`);
      const c = bal.body.balances.find((b: { code: string }) => b.code === 'CL');
      expect(c).toMatchObject({ accrued: '6.00', balance: '6.00', available: '6.00', tracked: true });
    });

    it('previews working days, skipping weekends and holidays', async () => {
      const op = await token('operator');
      const mon = weekday(3, 1, 1); // Monday; the Wednesday after it is the test holiday
      const res = await api(app, op).post('/leave/requests/preview').send({ leaveTypeId: cl, startDate: mon, endDate: plus(mon, 6), endHalf: 'full' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.days).toBe('4.00');
      expect(res.body.holidaysInRange).toEqual([weekday(3, 1, 3)]);
      const weekend = await api(app, op).post('/leave/requests/preview').send({ leaveTypeId: cl, startDate: plus(mon, 5), endDate: plus(mon, 6) });
      expect(weekend.body.error.code).toBe('no_working_days');
      const long = await api(app, op).post('/leave/requests/preview').send({ leaveTypeId: cl, startDate: mon, endDate: plus(mon, 7) });
      expect(long.body.error.code).toBe('too_long');
      const spans = await api(app, op).post('/leave/requests/preview').send({ leaveTypeId: cl, startDate: `${Y}-12-31`, endDate: `${Y + 1}-01-01` });
      expect(spans.body.error.code).toBe('spans_years');
    });

    let requestId: string;
    it('routes a request to the manager, who approves it; the balance moves through the ledger', async () => {
      const op = await token('operator');
      const day = weekday(2, 2, 2);
      const res = await api(app, op).post('/leave/requests').send({ leaveTypeId: cl, startDate: day, endDate: plus(day, 1), endHalf: 'first_half', reason: 'Family visit' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ status: 'pending', days: '1.50' });
      requestId = res.body.id;

      const overlap = await api(app, op).post('/leave/requests').send({ leaveTypeId: unpaid, startDate: day, endDate: day });
      expect(overlap.status).toBe(409);

      const pending = await api(app, op).get(`/leave/balances?year=${Y}`);
      expect(pending.body.balances.find((b: { code: string }) => b.code === 'CL')).toMatchObject({ balance: '6.00', pending: '1.50', available: '4.50' });

      // The requester never sees their own request to approve; the peer has no business with it.
      expect((await api(app, op).get('/approvals/inbox')).body).toEqual([]);
      const approvalId = res.body.approvalId;
      expect((await api(app, op).post(`/approvals/${approvalId}/approve`).send({})).status).toBe(403);
      expect((await api(app, await token('peer')).post(`/approvals/${approvalId}/approve`).send({})).status).toBe(404);

      const sup = await token('supervisor');
      const inbox = await api(app, sup).get('/approvals/inbox');
      expect(inbox.body.map((i: { id: string }) => i.id)).toEqual([approvalId]);
      const ok = await api(app, sup).post(`/approvals/${approvalId}/approve`).send({ comment: 'Enjoy' });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.status).toBe('approved');
      expect((await api(app, sup).post(`/approvals/${approvalId}/approve`).send({})).status).toBe(409);

      const after = await api(app, op).get(`/leave/requests/${requestId}`);
      expect(after.body.status).toBe('approved');
      expect(after.body.approvalTrail[0]).toMatchObject({ status: 'approved', comment: 'Enjoy' });
      const bal = await api(app, op).get(`/leave/balances?year=${Y}`);
      expect(bal.body.balances.find((b: { code: string }) => b.code === 'CL')).toMatchObject({ taken: '1.50', balance: '4.50', pending: '0.00' });
      const notes = await pool.query(`select kind from notifications where membership_id = $1 and kind = 'approval.approved'`, [people.operator!.membershipId]);
      expect(notes.rowCount).toBe(1);
    });

    it('returns days through a reversal when approved leave is cancelled, and never edits the ledger', async () => {
      const op = await token('operator');
      const res = await api(app, op).post(`/leave/requests/${requestId}/cancel`).send({ reason: 'Plans changed' });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('cancelled');
      const rows = await pool.query(`select kind, quantity::text from leave_ledger where leave_request_id = $1 order by created_at`, [requestId]);
      expect(rows.rows).toEqual([{ kind: 'taken', quantity: '-1.50' }, { kind: 'reversal', quantity: '1.50' }]);
      await expect(pool.query(`delete from leave_ledger where leave_request_id = $1`, [requestId])).rejects.toThrow();
      const bal = await api(app, op).get(`/leave/balances?year=${Y}`);
      expect(bal.body.balances.find((b: { code: string }) => b.code === 'CL').balance).toBe('6.00');
    });

    it('rejects insufficient balance, and handles rejection', async () => {
      const op = await token('operator');
      const big = await api(app, op).post('/leave/requests').send({ leaveTypeId: cl, startDate: weekday(4, 1, 1), endDate: plus(weekday(4, 1, 1), 3) });
      expect(big.status).toBe(201);
      const more = await api(app, op).post('/leave/requests').send({ leaveTypeId: cl, startDate: weekday(5, 1, 1), endDate: plus(weekday(5, 1, 1), 3) });
      expect(more.body.error.code).toBe('insufficient_balance');
      const sup = await token('supervisor');
      const rej = await api(app, sup).post(`/approvals/${big.body.approvalId}/reject`).send({ comment: 'Peak season' });
      expect(rej.body.status).toBe('rejected');
      expect((await api(app, op).get(`/leave/requests/${big.body.id}`)).body.status).toBe('rejected');
    });

    it('never lets someone approve their own leave, even without a manager', async () => {
      const day = weekday(6, 1, 1);
      const res = await api(app, hrAdmin).post('/leave/requests').send({ leaveTypeId: cl, startDate: day, endDate: day });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      // No manager, and the only HR admin is the requester, so it falls back to the workspace owner.
      expect((await api(app, hrAdmin).get('/approvals/inbox')).body).toEqual([]);
      expect((await api(app, hrAdmin).post(`/approvals/${res.body.approvalId}/approve`).send({})).status).toBe(403);
      const inbox = await api(app, owner).get('/approvals/inbox');
      expect(inbox.body.map((i: { id: string }) => i.id)).toContain(res.body.approvalId);
      expect((await api(app, owner).post(`/approvals/${res.body.approvalId}/approve`).send({})).body.status).toBe('approved');
    });

    it('supports multi-step chains configured per workspace', async () => {
      const set = await api(app, hrAdmin).put('/approvals/policies/leave_request').send({ steps: [{ type: 'manager' }, { type: 'role', role: 'hr_admin' }] });
      expect(set.status).toBe(200);
      const op = await token('operator');
      const day = weekday(7, 1, 1);
      const res = await api(app, op).post('/leave/requests').send({ leaveTypeId: unpaid, startDate: day, endDate: day });
      const id = res.body.approvalId;
      expect((await api(app, hrAdmin).get('/approvals/inbox')).body.map((i: { id: string }) => i.id)).not.toContain(id);
      expect((await api(app, await token('supervisor')).post(`/approvals/${id}/approve`).send({})).body.status).toBe('pending');
      expect((await api(app, hrAdmin).get('/approvals/inbox')).body.map((i: { id: string }) => i.id)).toContain(id);
      expect((await api(app, hrAdmin).post(`/approvals/${id}/approve`).send({})).body.status).toBe('approved');
      await api(app, hrAdmin).put('/approvals/policies/leave_request').send({ steps: [{ type: 'manager' }] });
    });

    it('lets HR adjust balances with a note, but not their own', async () => {
      const res = await api(app, hrAdmin).post('/leave/adjustments').send({ employeeId: people.operator!.employeeId, leaveTypeId: cl, quantity: '-0.5', note: 'Correction for late joining' });
      expect(res.status).toBe(201);
      const self = await api(app, hrAdmin).post('/leave/adjustments').send({ employeeId: people.hr!.employeeId, leaveTypeId: cl, quantity: '5', note: 'Bonus days' });
      expect(self.status).toBe(403);
    });
  });

  describe('documents', () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

    it('stores files, hides HR-only ones from the employee and serves them only through signed links', async () => {
      const up = await api(app, hrAdmin).post(`/employees/${people.operator!.employeeId}/documents`)
        .field('category', 'contract').field('title', 'Employment contract').field('visibility', 'employee')
        .attach('file', pdf, { filename: 'contract.pdf', contentType: 'application/pdf' });
      expect(up.status, JSON.stringify(up.body)).toBe(201);
      expect(up.body.sha256).toMatch(/^[0-9a-f]{64}$/);
      const secret = await api(app, hrAdmin).post(`/employees/${people.operator!.employeeId}/documents`)
        .field('category', 'other').field('title', 'Investigation notes').field('visibility', 'hr_only')
        .attach('file', Buffer.from('confidential'), { filename: 'notes.txt', contentType: 'text/plain' });
      expect(secret.status).toBe(201);

      const op = await token('operator');
      const list = await api(app, op).get(`/employees/${people.operator!.employeeId}/documents`);
      expect(list.body.map((d: { title: string }) => d.title)).toEqual(['Employment contract']);
      expect((await api(app, op).post(`/documents/${secret.body.id}/link`)).status).toBe(404);

      const link = await api(app, op).post(`/documents/${up.body.id}/link`);
      expect(link.status).toBe(201);
      const file = await api(app).get(link.body.path.replace('/api/v1', ''));
      expect(file.status).toBe(200);
      expect(file.headers['content-disposition']).toContain('contract.pdf');
      const tampered = await api(app).get(link.body.path.replace('/api/v1', '').replace(/sig=.{4}/, 'sig=AAAA'));
      expect(tampered.status).toBe(404);
    });

    it('rejects files whose content does not match their type, and uploads by other employees', async () => {
      const fake = await api(app, hrAdmin).post(`/employees/${people.operator!.employeeId}/documents`)
        .field('category', 'other').field('title', 'Fake').attach('file', Buffer.from('MZ\x90\x00binary'), { filename: 'x.pdf', contentType: 'application/pdf' });
      expect(fake.body.error.code).toBe('content_mismatch');
      const peer = await api(app, await token('peer')).post(`/employees/${people.operator!.employeeId}/documents`)
        .field('category', 'other').field('title', 'Nope').attach('file', pdf, { filename: 'x.pdf', contentType: 'application/pdf' });
      expect(peer.status).toBe(404);
      const own = await api(app, await token('operator')).post(`/employees/${people.operator!.employeeId}/documents`)
        .field('category', 'id_proof').field('title', 'ID card').attach('file', pdf, { filename: 'id.pdf', contentType: 'application/pdf' });
      expect(own.status).toBe(201);
    });
  });

  describe('onboarding and notifications', () => {
    it('lets assignees complete their tasks and nobody else', async () => {
      const op = await token('operator');
      const mine = await api(app, op).get('/onboarding/my-tasks');
      expect(mine.body.length).toBeGreaterThan(0);
      const task = mine.body[0];
      expect((await api(app, await token('peer')).patch(`/onboarding/tasks/${task.id}`).send({ status: 'done' })).status).toBe(404);
      const done = await api(app, op).patch(`/onboarding/tasks/${task.id}`).send({ status: 'done' });
      expect(done.status).toBe(200);
      expect(done.body.status).toBe('done');
    });

    it('shows each member only their own notifications', async () => {
      const op = await token('operator');
      const list = await api(app, op).get('/notifications');
      expect(list.body.items.length).toBeGreaterThan(0);
      const theirs = await pool.query(`select id from notifications where membership_id = $1 limit 1`, [people.supervisor!.membershipId]);
      expect((await api(app, op).post(`/notifications/${theirs.rows[0].id}/read`)).status).toBe(404);
      expect((await api(app, op).post('/notifications/read-all')).status).toBe(204);
      expect((await api(app, op).get('/notifications/unread-count')).body.unread).toBe(0);
    });

    it('marks email as not delivered when SMTP is not configured, instead of pretending', async () => {
      const r = await app.get(MailerService).sendBatch(500);
      expect(r.sent).toBe(0);
      const rows = await pool.query(`select status, last_error from email_messages where tenant_id = $1 limit 1`, [t.id]);
      expect(rows.rows[0]).toEqual({ status: 'skipped', last_error: 'Email delivery is not set up (Super Admin Console > Integrations > Email)' });
    });
  });

  describe('exits and isolation', () => {
    it('completes an exit after the last working day: login suspended, sessions revoked', async () => {
      // A job change scheduled after the last day blocks the exit until it is corrected.
      const blocked = await api(app, hrAdmin).post(`/employees/${people.peer!.employeeId}/exit`).send({ exitType: 'resignation', lastWorkingDay: plus(today(), 2) });
      expect(blocked.body.error.code).toBe('later_change_scheduled');

      const m = await addMember(pool, t, { name: 'Lee Leaver' });
      const hired = await api(app, hrAdmin).post('/employees').send({ legalEntityId: t.legalEntityId, firstName: 'Lee', lastName: 'Leaver', dateOfJoining: '2023-01-02', membershipId: m.membershipId, onboardingTemplateId: null });
      people.leaver = { ...m, employeeId: hired.body.employee.id };
      const peer = await login(app, m.email);
      const yesterday = plus(today(), -1);
      const res = await api(app, hrAdmin).post(`/employees/${people.leaver.employeeId}/exit`).send({ exitType: 'resignation', resignationDate: plus(today(), -30), lastWorkingDay: yesterday });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.status).toBe('exited');
      expect((await api(app, peer.accessToken).get('/employees/me')).status).toBe(401);
      const again = await api(app).post('/auth/login').send({ email: m.email, password: PASSWORD });
      expect(again.body.status).not.toBe('ok');
    });

    it('keeps every Phase 2 record inside its tenant', async () => {
      const outsider = (await loginWithMfa(app, pool, other.ownerEmail)).accessToken;
      const op = people.operator!.employeeId!;
      expect((await api(app, outsider).get(`/employees/${op}`)).status).toBe(404);
      expect((await api(app, outsider).get(`/employees/${op}/documents`)).status).toBe(404);
      expect((await api(app, outsider).get(`/leave/balances?employeeId=${op}`)).status).toBe(404);
      expect((await api(app, outsider).get('/employees')).body.items).toEqual([]);
      const req = await pool.query(`select id, approval_request_id from leave_requests where employee_id = $1 limit 1`, [op]);
      expect((await api(app, outsider).get(`/leave/requests/${req.rows[0].id}`)).status).toBe(404);
      expect((await api(app, outsider).post(`/approvals/${req.rows[0].approval_request_id}/approve`).send({})).status).toBe(404);
      // RLS holds even for direct queries under the application role.
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query('set local role crew_app');
        await c.query(`select set_config('app.tenant_id', $1, true)`, [other.id]);
        for (const table of ['employees', 'employment_records', 'leave_ledger', 'leave_requests', 'approval_requests', 'employee_documents', 'notifications', 'onboarding_tasks', 'employee_sensitive']) {
          const n = await c.query(`select count(*)::int as n from ${table} where tenant_id = $1`, [t.id]);
          expect(n.rows[0].n, table).toBe(0);
        }
        // The application role can queue email but never read it back.
        await expect(c.query(`select count(*) from email_messages`)).rejects.toThrow(/permission denied/);
      } finally {
        await c.query('rollback');
        c.release();
      }
    });
  });
});
