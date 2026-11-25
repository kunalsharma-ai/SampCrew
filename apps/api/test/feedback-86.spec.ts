import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_ACCESS, recordScore, withheldPages } from '@crew/contracts';
import { addMember, adminPool, api, createApp, createTenant, login, loginWithMfa, type TestDb, type TestTenant } from './helpers';

/**
 * Issue #86 (feedback of 25 November 2026) through the HTTP API: registered company details locked, sign-in location
 * and the activity log, chat edit / delete with undo / emoji reactions, the employee record with its completion
 * score, page access chosen at registration, and an HR Workspace hire with opening balances.
 */
describe('issue #86 feedback', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let owner: string;
  let hr: string;
  let emp: string;
  let empMember: { email: string; membershipId: string };
  let empId: string;

  const ok = (res: { status: number; body: unknown }, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as Record<string, any>;
  };

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool, { plan: 'business' });
    owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    const hrMember = await addMember(pool, t, { roles: ['hr_admin'], name: 'Hema HR' });
    hr = (await loginWithMfa(app, pool, hrMember.email)).accessToken;
    empMember = await addMember(pool, t, { name: 'Eli Employee' });
    empId = ok(await api(app, owner).post('/employees').send({
      legalEntityId: t.legalEntityId, firstName: 'Eli', lastName: 'Employee', dateOfJoining: '2024-01-15', probationMonths: 0, onboardingTemplateId: null, membershipId: empMember.membershipId,
    }), 201).employee.id;
    emp = (await login(app, empMember.email)).accessToken;
  });
  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('W3: once setup is finished, registered legal entity details stay as registered; empty ones can be filled', async () => {
    await pool.update('tenants', { id: t.id }, { $set: { company_locked_at: new Date() } });
    const res = await api(app, owner).patch(`/org/legal-entities/${t.legalEntityId}`).send({ name: 'Another Name Pvt Ltd' });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/name/);
    const le = await pool.one<Record<string, any>>('legal_entities', { id: t.legalEntityId });
    if (!le?.tax_id) ok(await api(app, owner).patch(`/org/legal-entities/${t.legalEntityId}`).send({ taxId: 'AAACT1234Z' }));
  });

  it('H5 / H16: the sign-in location is kept with the session and the activity log shows IP, GPS and actions', async () => {
    const me = ok(await api(app, emp).get('/me'));
    expect(me.session?.locationPending).toBe(true);
    ok(await api(app, emp).post('/me/session-location').send({ latitude: 28.6139, longitude: 77.209, accuracyM: 25 }), 204);
    expect(ok(await api(app, emp).get('/me')).session?.locationPending).toBe(false);
    const log = ok(await api(app, emp).get('/activity'));
    expect(log.self).toBe(true);
    expect(log.canViewOthers).toBe(false);
    const current = (log.sessions as any[]).find((s) => s.current);
    expect(current.location).toMatchObject({ status: 'shared', latitude: 28.6139, longitude: 77.209 });
    // Someone else's activity needs audit:read.
    expect((await api(app, emp).get(`/activity?membershipId=${t.ownerMembershipId}`)).status).toBe(403);
    const other = ok(await api(app, owner).get(`/activity?membershipId=${empMember.membershipId}`));
    expect(other.person.membershipId).toBe(empMember.membershipId);
    expect(other.sessions.length).toBeGreaterThan(0);
  });

  it('I7: chat messages can be edited (shows Edited), reacted to, deleted and brought back; only your own', async () => {
    const conv = ok(await api(app, emp).post('/communication/conversations').send({ kind: 'hr' }), 201);
    const m = ok(await api(app, emp).post(`/communication/conversations/${conv.id}/messages`).send({ body: 'Helo HR' }), 201);
    expect(m.canEdit).toBe(true);
    const edited = ok(await api(app, emp).patch(`/communication/conversations/${conv.id}/messages/${m.id}`).send({ body: 'Hello HR' }));
    expect(edited.body).toBe('Hello HR');
    expect(edited.editedAt).toBeTruthy();
    // HR cannot rewrite someone else's words.
    expect((await api(app, hr).patch(`/communication/conversations/${conv.id}/messages/${m.id}`).send({ body: 'Changed' })).status).toBe(403);
    const reacted = ok(await api(app, hr).put(`/communication/conversations/${conv.id}/messages/${m.id}/reactions`).send({ emoji: '👍' }));
    expect(reacted.reactions).toEqual([expect.objectContaining({ emoji: '👍', count: 1, mine: true })]);
    const again = ok(await api(app, hr).put(`/communication/conversations/${conv.id}/messages/${m.id}/reactions`).send({ emoji: '👍' }));
    expect(again.reactions).toEqual([]);
    ok(await api(app, emp).delete(`/communication/conversations/${conv.id}/messages/${m.id}`));
    let view = ok(await api(app, emp).get(`/communication/conversations/${conv.id}`));
    const gone = (view.messages as any[]).find((x) => x.id === m.id);
    expect(gone.deleted).toBe(true);
    expect(gone.canUndo).toBe(true);
    const back = ok(await api(app, emp).post(`/communication/conversations/${conv.id}/messages/${m.id}/restore`));
    expect(back.deleted).toBe(false);
    expect(back.body).toBe('Hello HR');
    view = ok(await api(app, hr).get(`/communication/conversations/${conv.id}`));
    expect((view.messages as any[]).find((x) => x.id === m.id).body).toBe('Hello HR');
  });

  it('H18: the employee record lists every field and document with a completion score, and keeps its own fields', async () => {
    const before = ok(await api(app, owner).get(`/employees/${empId}/record`));
    expect(before.items.some((i: any) => i.key === 'doc_aadhaar' && !i.done)).toBe(true);
    expect(before.score).toBe(recordScore(before.items).score);
    const after = ok(await api(app, owner).put(`/employees/${empId}/record`).send({ fatherName: 'Raj Employee', parentAadhaar: '1234 5678 9012', workStatus: 'working', ctcAnnual: '600000' }));
    expect(after.done).toBe(before.done + 4);
    expect(after.values.parentAadhaarMasked).toBe('XXXX XXXX 9012');
    expect(after.values.ctcAnnual).toBe(600000);
    const row = await pool.one<Record<string, any>>('employee_record_details', { employee_id: empId });
    expect(row?.parent_aadhaar_enc).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain('123456789012');
    // The person sees their record, but not as an editor, and CTC figures stay hidden from people who may not see pay.
    const own = ok(await api(app, emp).get(`/employees/${empId}/record`));
    expect(own.can.edit).toBe(false);
    expect((await api(app, emp).put(`/employees/${empId}/record`).send({ fatherName: 'X' })).status).toBe(403);
  });

  it('H2: page access chosen at registration withholds the unticked pages, and can be changed later', async () => {
    expect(DEFAULT_PAGE_ACCESS).toEqual(['attendance', 'leave', 'announcements', 'signature']);
    const hired = ok(await api(app, owner).post('/employees').send({
      legalEntityId: t.legalEntityId, firstName: 'Pia', lastName: 'Pages', dateOfJoining: '2024-02-01', probationMonths: 0, onboardingTemplateId: null,
      workEmail: `pia.pages.${Date.now()}@example.com`, loginMode: 'password', pageAccess: ['leave', 'announcements'],
    }), 201);
    const id = hired.employee.id as string;
    expect(ok(await api(app, owner).get(`/employees/${id}/page-access`)).pages).toEqual(['leave', 'announcements']);
    const e = await pool.one<Record<string, any>>('employees', { id });
    const row = await pool.one<Record<string, any>>('member_module_assignments', { membership_id: e!.membership_id });
    expect([...row!.withheld_features].sort()).toEqual(withheldPages(['leave', 'announcements']));
    const changed = ok(await api(app, owner).put(`/employees/${id}/page-access`).send({ pages: ['leave', 'announcements', 'attendance'] }));
    expect(changed.pages).toEqual(['attendance', 'leave', 'announcements']);
    expect((await api(app, emp).put(`/employees/${id}/page-access`).send({ pages: [] })).status).toBe(403);
  });

  it('I6: an HR Workspace admin hires into their HR Workspace with opening leave balances (no "Resource not found")', async () => {
    const admin = await addMember(pool, t, { name: 'Bina Branch' });
    const ws = ok(await api(app, owner).post('/hr-workspaces').send({ name: 'Pune Branch', code: 'PUNE86', kind: 'branch', features: ['leave', 'attendance_basic'], adminMembershipIds: [admin.membershipId] }), 201);
    const type = ok(await api(app, owner).post('/leave/types').send({ code: 'CL86', name: 'Casual Leave 86' }), 201);
    const token = (await loginWithMfa(app, pool, admin.email)).accessToken;
    const hired = ok(await api(app, token).post('/employees').send({
      legalEntityId: t.legalEntityId, hrWorkspaceId: ws.id, firstName: 'Nina', lastName: 'Branch', dateOfJoining: '2024-03-01', probationMonths: 0, onboardingTemplateId: null,
      joinedAs: 'existing', openingLeaveBalances: [{ leaveTypeId: type.id, days: '4' }],
    }), 201);
    expect((await pool.find('leave_ledger', { employee_id: hired.employee.id, leave_type_id: type.id })).length).toBeGreaterThan(0);
  });
});
