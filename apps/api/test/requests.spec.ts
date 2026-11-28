import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, adminPool, api, createApp, createTenant, login, loginWithMfa, type TestDb, type TestTenant } from './helpers';

/**
 * Requests (28 November 2026): anyone raises a request (work from home, late coming, leave ...) with a reason,
 * dates and times, and loops in several people (their HR and reporting manager). Every looped person sees it in
 * Approvals at once and decides with a comment; a rejection needs a reason; the requester sees every comment and is
 * notified. An approved leave request leads to the pre-filled leave application form, which goes to the same people
 * (Approvals and email) and books real leave once they approve.
 */
describe('Requests: raise, loop in approvers, decide with comments, then apply for leave', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  const people: Record<string, { email: string; membershipId: string; employeeId?: string }> = {};
  const tokens: Record<string, string> = {};
  const as = (who: string) => api(app, tokens[who]);
  const ok = (res: { status: number; body: unknown }, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as Record<string, any>;
  };
  const year = new Date().getUTCFullYear() + 1;
  const day = (md: string) => `${year}-${md}`;

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool, { standardLeaveTypes: true });
    people.hr = await addMember(pool, t, { roles: ['hr_admin'], name: 'Simran HR' });
    people.mgr = await addMember(pool, t, { roles: ['department_manager'], name: 'Manish Arora' });
    people.emp = await addMember(pool, t, { name: 'Kunal Sharma' });
    people.peer = await addMember(pool, t, { name: 'Pooja Peer' });
    tokens.hr = (await loginWithMfa(app, pool, people.hr.email)).accessToken;
    const hire = async (who: string, first: string, extra: Record<string, unknown> = {}) => {
      const body = ok(await as('hr').post('/employees').send({
        legalEntityId: t.legalEntityId, firstName: first, lastName: 'Test', dateOfJoining: '2024-01-01', probationMonths: 0,
        membershipId: people[who]!.membershipId, onboardingTemplateId: null, ...extra,
      }), 201);
      people[who]!.employeeId = body.employee.id;
    };
    await hire('hr', 'Simran');
    await hire('mgr', 'Manish');
    await hire('emp', 'Kunal', { managerEmployeeId: people.mgr.employeeId });
    await hire('peer', 'Pooja', { managerEmployeeId: people.mgr.employeeId });
    for (const who of ['emp', 'mgr', 'peer']) tokens[who] = (await login(app, people[who]!.email)).accessToken;
    tokens.owner = (await login(app, t.ownerEmail)).accessToken;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  const inbox = async (who: string) => (ok(await as(who).get('/approvals/inbox')) as unknown as { id: string; resourceType: string; resourceId: string }[]);
  const notices = async (who: string) => (ok(await as(who).get('/notifications?limit=30')).items as { kind: string; title: string; body: string; link: string }[]);

  it('suggests the reporting manager and HR, and lists the request types', async () => {
    // An HR Workspace login that does not look after leave (an auditor) is not "Your HR", and comes after the HR who do.
    const auditor = await addMember(pool, t, { roles: ['auditor'], name: 'Audit Person' });
    const o = ok(await as('emp').get('/requests/options'));
    const hrs = o.suggested.filter((p: { role: string }) => p.role === 'hr') as { membershipId: string; roleLabel: string }[];
    expect(hrs[0]).toMatchObject({ membershipId: people.hr.membershipId, roleLabel: 'Your HR' });
    const aud = hrs.find((p) => p.membershipId === auditor.membershipId);
    if (aud) expect(aud.roleLabel).toBe('HR Workspace');
    expect(o.kinds.map((k: { key: string }) => k.key)).toEqual(expect.arrayContaining(['wfh', 'early_leave', 'late_coming', 'comp_off', 'leave', 'half_day']));
    const roles = Object.fromEntries(o.suggested.map((p: { membershipId: string; role: string }) => [p.membershipId, p.role]));
    expect(roles[people.mgr.membershipId]).toBe('manager');
    expect(roles[people.hr.membershipId]).toBe('hr');
    expect(o.me).toMatchObject({ name: expect.stringContaining('Kunal'), levelLabel: 'Employee Workspace' });
    expect(o.hasEmployeeRecord).toBe(true);
    const found = ok(await as('emp').get('/requests/people?q=simran')).items;
    expect(found.map((p: { membershipId: string }) => p.membershipId)).toContain(people.hr.membershipId);
  });

  it('refuses looping in yourself, nobody with authority, or the same person twice', async () => {
    const base = { kind: 'wfh', reason: 'Plumber at home all day', startDate: day('02-02'), endDate: day('02-04') };
    expect((await as('emp').post('/requests').send({ ...base, approverMembershipIds: [people.emp.membershipId, people.hr.membershipId] })).body.error.code).toBe('self_approver');
    expect((await as('emp').post('/requests').send({ ...base, approverMembershipIds: [people.peer.membershipId] })).body.error.code).toBe('no_authority');
    expect((await as('emp').post('/requests').send({ ...base, approverMembershipIds: [people.hr.membershipId, people.hr.membershipId] })).status).toBe(422);
    // Late coming needs the arrival time and is for one day.
    expect((await as('emp').post('/requests').send({ kind: 'late_coming', reason: 'School drop-off', startDate: day('02-02'), approverMembershipIds: [people.mgr.membershipId] })).status).toBe(422);
  });

  it('sends a work-from-home request to HR and the manager at once; each decides with a comment; a rejection needs a reason', async () => {
    const r = ok(await as('emp').post('/requests').send({
      kind: 'wfh', reason: 'Plumber at home all day', startDate: day('02-02'), endDate: day('02-04'), startTime: '09:30', endTime: '18:30',
      approverMembershipIds: [people.hr.membershipId, people.mgr.membershipId, people.peer.membershipId],
    }), 201);
    expect(r).toMatchObject({ status: 'pending', kind: 'wfh', days: 3, ref: expect.stringMatching(/^REQ-/) });
    expect(r.when).toContain('9:30 AM to 6:30 PM');
    expect(r.statusMessage).toContain('Waiting for 3 of 3 approvers');
    // All three see it in their Approvals now (one stage).
    for (const who of ['hr', 'mgr', 'peer']) expect((await inbox(who)).some((i) => i.resourceId === r.id)).toBe(true);
    expect((await notices('mgr')).some((n) => n.kind === 'approval.requested' && n.title.includes('work from home'))).toBe(true);
    expect((await notices('emp')).some((n) => n.kind === 'request.submitted')).toBe(true);

    ok(await as('hr').post(`/approvals/${r.approvalId}/approve`).send({ comment: 'Fine, stay reachable on chat.' }));
    let mine = ok(await as('emp').get(`/requests/${r.id}`));
    expect(mine.status).toBe('pending');
    expect(mine.approvers.find((a: { membershipId: string }) => a.membershipId === people.hr.membershipId)).toMatchObject({ status: 'approved', comment: 'Fine, stay reachable on chat.' });
    expect((await notices('emp')).find((n) => n.kind === 'approval.progressed')?.body).toContain('Fine, stay reachable on chat.');

    // A rejection without a reason is refused; with one it ends the request and the others' steps are withdrawn.
    expect((await as('mgr').post(`/approvals/${r.approvalId}/reject`).send({})).body.error.code).toBe('reason_required');
    ok(await as('mgr').post(`/approvals/${r.approvalId}/reject`).send({ comment: 'Release week, we need you in the office.' }));
    mine = ok(await as('emp').get(`/requests/${r.id}`));
    expect(mine.status).toBe('rejected');
    expect(mine.statusMessage).toContain('Rejected');
    expect(mine.approvers.find((a: { membershipId: string }) => a.membershipId === people.mgr.membershipId)).toMatchObject({ status: 'rejected', comment: 'Release week, we need you in the office.' });
    expect((await inbox('peer')).some((i) => i.resourceId === r.id)).toBe(false);
    const n = (await notices('emp')).find((x) => x.kind === 'request.rejected');
    expect(n?.body).toContain('Release week');
    // Nobody else opens it.
    expect((await as('owner').get(`/requests/${r.id}`)).status).toBe(200);
    const outsider = await addMember(pool, t, { name: 'Out Sider' });
    expect((await api(app, (await login(app, outsider.email)).accessToken).get(`/requests/${r.id}`)).status).toBe(404);
  });

  it('cancels a pending request and takes it out of the approvers’ Approvals', async () => {
    const r = ok(await as('emp').post('/requests').send({ kind: 'late_coming', reason: 'School drop-off', startDate: day('03-03'), startTime: '11:00', approverMembershipIds: [people.mgr.membershipId] }), 201);
    expect(r.when).toContain('arriving at 11:00 AM');
    expect((await inbox('mgr')).some((i) => i.resourceId === r.id)).toBe(true);
    const c = ok(await as('emp').post(`/requests/${r.id}/cancel`).send({ reason: 'Plans changed' }));
    expect(c.status).toBe('cancelled');
    expect((await inbox('mgr')).some((i) => i.resourceId === r.id)).toBe(false);
    expect((await notices('mgr')).some((n) => n.kind === 'request.cancelled')).toBe(true);
    expect((await as('emp').post(`/requests/${r.id}/cancel`).send({})).status).toBe(409);
  });

  it('after a leave request is approved, applies for the leave on the pre-filled form; it goes to the same people and by email', async () => {
    const o = ok(await as('emp').get('/requests/options'));
    const cl = o.leaveTypes.find((x: { code: string }) => x.code === 'CL');
    expect(cl).toBeTruthy();
    const r = ok(await as('emp').post('/requests').send({
      kind: 'leave', reason: 'Family function out of town', startDate: day('04-06'), endDate: day('04-08'), leaveTypeId: cl.id,
      approverMembershipIds: [people.hr.membershipId, people.mgr.membershipId],
    }), 201);
    // Applying before everyone approved is refused.
    const early = { leaveTypeId: cl.id, startDate: day('04-06'), endDate: day('04-08'), reason: 'Family function out of town' };
    expect((await as('emp').post(`/requests/${r.id}/leave`).send(early)).status).toBe(409);
    ok(await as('hr').post(`/approvals/${r.approvalId}/approve`).send({ comment: 'Approved, enjoy.' }));
    ok(await as('mgr').post(`/approvals/${r.approvalId}/approve`).send({}));
    const approved = ok(await as('emp').get(`/requests/${r.id}`));
    expect(approved).toMatchObject({ status: 'approved', canApplyLeave: true });
    expect(approved.statusMessage).toContain('Apply for the leave now');
    const prompt = (await notices('emp')).find((n) => n.kind === 'request.approved');
    expect(prompt?.link).toBe(`/requests/${r.id}/apply`);

    const form = ok(await as('emp').get(`/requests/${r.id}/leave-form`));
    expect(form.applicant).toMatchObject({ name: expect.stringContaining('Kunal'), employeeCode: expect.any(String) });
    expect(form.reportingManager?.name).toContain('Manish');
    expect(form.hrManager?.name).toContain('Simran');
    expect(form.prefill).toMatchObject({ leaveTypeId: cl.id, startDate: day('04-06'), endDate: day('04-08'), reason: 'Family function out of town' });
    expect(form.sendTo.map((p: { membershipId: string }) => p.membershipId).sort()).toEqual([people.hr.membershipId, people.mgr.membershipId].sort());

    // Only the approved days.
    expect((await as('emp').post(`/requests/${r.id}/leave`).send({ ...early, endDate: day('04-10') })).body.error.code).toBe('outside_request');
    const applied = ok(await as('emp').post(`/requests/${r.id}/leave`).send({ ...early, contactDuringLeave: '+91 98100 00000', handoverTo: 'Pooja' }), 201);
    expect(applied.leaveRequest).toMatchObject({ status: 'pending', staffRequestId: r.id, approvalRouteLabel: 'The people looped into the request' });
    expect(applied.leaveRequest.applicationForm).toMatchObject({ handoverTo: 'Pooja', requestRef: r.ref });
    expect(applied.request.canApplyLeave).toBe(false);
    expect(applied.request.leaveApplication).toMatchObject({ status: 'pending' });
    // It waits for both looped people in Approvals, and the form went to them (and a copy to Kunal) by email.
    for (const who of ['hr', 'mgr']) expect((await inbox(who)).some((i) => i.resourceType === 'leave_request' && i.resourceId === applied.leaveRequest.id)).toBe(true);
    const mails = await pool.find('email_messages', { tenant_id: t.id, template: 'leave.application' });
    expect(mails).toHaveLength(3);
    expect(String(mails[0]!.html_body)).toContain('Leave Application Form');
    expect(String(mails[0]!.html_body)).toContain('Family function out of town');
    expect((await as('emp').post(`/requests/${r.id}/leave`).send(early)).status).toBe(409);

    // Both approve: the leave is booked.
    ok(await as('hr').post(`/approvals/${applied.leaveRequest.approvalId}/approve`).send({ comment: 'OK' }));
    ok(await as('mgr').post(`/approvals/${applied.leaveRequest.approvalId}/approve`).send({}));
    expect(ok(await as('emp').get(`/leave/requests/${applied.leaveRequest.id}`)).status).toBe('approved');
    const list = ok(await as('emp').get('/requests'));
    expect(list.counts.approved).toBeGreaterThanOrEqual(1);
    expect(list.items.find((x: { id: string }) => x.id === r.id).leaveApplication.status).toBe('approved');
  });

  it('lets the Super Workspace raise a request too, looping in HR', async () => {
    const r = ok(await as('owner').post('/requests').send({ kind: 'on_duty', reason: 'Client workshop in Gurugram', startDate: day('05-05'), approverMembershipIds: [people.hr.membershipId] }), 201);
    expect(r.requester.levelLabel).toBe('Super Workspace');
    expect((await inbox('hr')).some((i) => i.resourceId === r.id)).toBe(true);
    ok(await as('hr').post(`/approvals/${r.approvalId}/approve`).send({ comment: 'Noted' }));
    expect(ok(await as('owner').get(`/requests/${r.id}`)).status).toBe('approved');
  });
});
