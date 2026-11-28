import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttendanceDaysService } from '../src/modules/attendance/attendance-days.service';
import { RequestsService } from '../src/modules/requests/requests.service';
import { MongoService } from '../src/platform/database/mongo.service';
import { addMember, adminPool, api, createApp, createTenant, login, loginWithMfa, type TestDb, type TestTenant } from './helpers';

/**
 * Requests (28 November 2026, Kunal's written spec). Anyone raises a request or applies for leave, chooses a primary
 * approver, additional approvers and CC participants. Approvers approve, reject (reason required) or request changes
 * (comment required); CC participants are told but do not decide. A leave application is itself a request: nothing
 * is deducted and attendance is not marked until it is fully approved. The six mandatory scenarios of the spec are
 * marked "Scenario n".
 */
describe('Requests: approvers and CC, workflows, changes, leave as a request', () => {
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
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  /** The next working day (Monday to Friday) after today: "tomorrow" unless tomorrow is a weekend. */
  const tomorrow = (() => {
    let d = Date.now() + 86_400_000;
    while ([0, 6].includes(new Date(d).getUTCDay())) d += 86_400_000;
    return iso(d);
  })();
  /** The last working day before today (for attendance regularization). */
  const lastWorkingDay = (() => {
    let d = Date.now() - 86_400_000;
    while ([0, 6].includes(new Date(d).getUTCDay())) d -= 86_400_000;
    return iso(d);
  })();

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool, { standardLeaveTypes: true });
    people.hr = await addMember(pool, t, { roles: ['hr_admin'], name: 'Simran HR' });
    people.hr2 = await addMember(pool, t, { roles: ['hr_admin'], name: 'Harpreet HR' });
    people.mgr = await addMember(pool, t, { roles: ['department_manager'], name: 'Manish Arora' });
    people.emp = await addMember(pool, t, { name: 'Kunal Sharma' });
    people.peer = await addMember(pool, t, { name: 'Pooja Peer' });
    people.cc1 = await addMember(pool, t, { name: 'Chetan Cc' });
    people.cc2 = await addMember(pool, t, { name: 'Divya Cc' });
    people.owner = { email: t.ownerEmail, membershipId: t.ownerMembershipId };
    tokens.hr = (await loginWithMfa(app, pool, people.hr.email)).accessToken;
    tokens.hr2 = (await loginWithMfa(app, pool, people.hr2.email)).accessToken;
    const hire = async (who: string, first: string, extra: Record<string, unknown> = {}) => {
      const body = ok(await as('hr').post('/employees').send({
        legalEntityId: t.legalEntityId, firstName: first, lastName: 'Test', dateOfJoining: '2024-01-01', probationMonths: 0,
        membershipId: people[who]!.membershipId, onboardingTemplateId: null, ...extra,
      }), 201);
      people[who]!.employeeId = body.employee.id;
    };
    await hire('hr', 'Simran');
    await hire('hr2', 'Harpreet');
    await hire('mgr', 'Manish');
    await hire('emp', 'Kunal', { managerEmployeeId: people.mgr.employeeId });
    await hire('peer', 'Pooja', { managerEmployeeId: people.mgr.employeeId });
    for (const who of ['emp', 'mgr', 'peer', 'cc1', 'cc2']) tokens[who] = (await login(app, people[who]!.email)).accessToken;
    tokens.owner = (await login(app, t.ownerEmail)).accessToken;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  const notices = async (who: string) => (ok(await as(who).get('/notifications?limit=50')).items as { kind: string; title: string; body: string; link: string }[]);
  const approvalsOf = async (who: string, view = 'pending') => ok(await as(who).get(`/requests/approvals?view=${view}`));
  const decide = (who: string, id: string, decision: 'approve' | 'reject' | 'changes', comment?: string) => as(who).post(`/requests/${id}/decision`).send({ decision, ...(comment ? { comment } : {}) });
  const options = async (who = 'emp') => ok(await as(who).get('/requests/options'));
  const leaveTypeId = async (code: string) => ((await options()).leaveTypes as { id: string; code: string }[]).find((x) => x.code === code)!.id;
  const balanceOf = async (code: string, y: number) => (ok(await as('emp').get(`/leave/balances?year=${y}`)).balances as { code: string; balance: string; pending: string; used: string }[]).find((b) => b.code === code)!;
  const dayStatus = async (employeeId: string, date: string) => {
    // Attendance for a future day is worked out when the day comes: work it out now as if it were that day.
    await app.get(MongoService).tenant((tx) => app.get(AttendanceDaysService).recompute(tx, employeeId, date, date, Date.parse(`${date}T12:00:00Z`)), { tenantId: t.id });
    return (await pool.one<{ status: string }>('attendance_days', { tenant_id: t.id, employee_id: employeeId, work_date: date }))?.status ?? null;
  };
  const wfh = (start: string, extra: Record<string, unknown> = {}) => ({ kind: 'wfh', reason: 'Plumber at home all day', startDate: start, endDate: start, primaryApproverId: people.mgr.membershipId, ...extra });

  it('fills in the requester, their manager and HR, and suggests the manager as primary approver and HR as additional', async () => {
    const o = await options();
    expect(o.me).toMatchObject({ name: expect.stringContaining('Kunal'), levelLabel: 'Employee Workspace', employeeCode: expect.any(String) });
    expect(o.reportingManager?.name).toContain('Manish');
    expect(o.hrManager?.membershipId).toBeTruthy();
    expect(o.defaults.primaryApproverId).toBe(people.mgr.membershipId);
    expect(o.defaults.additionalApproverIds).toEqual([o.hrManager.membershipId]);
    expect(o.categories.map((c: { key: string }) => c.key)).toEqual(expect.arrayContaining(['wfh', 'leave', 'early_leave', 'late_coming', 'comp_off', 'attendance_regularization', 'other']));
    // The directory searches by name, designation, department and workspace.
    const found = ok(await as('emp').get('/requests/people?q=simran')).items;
    expect(found.map((p: { membershipId: string }) => p.membershipId)).toContain(people.hr.membershipId);
  });

  it('refuses yourself, an approver without authority, and a person who is both approver and CC', async () => {
    expect((await as('emp').post('/requests').send(wfh(day('01-12'), { primaryApproverId: people.emp.membershipId }))).body.error.code).toBe('self_approver');
    expect((await as('emp').post('/requests').send(wfh(day('01-12'), { primaryApproverId: people.peer.membershipId }))).body.error.code).toBe('no_authority');
    expect((await as('emp').post('/requests').send(wfh(day('01-12'), { ccIds: [people.mgr.membershipId] }))).status).toBe(422);
    // A leave goes on the leave form, and late arrival needs the time.
    expect((await as('emp').post('/requests').send(wfh(day('01-12'), { kind: 'leave' }))).status).toBe(422);
    expect((await as('emp').post('/requests').send(wfh(day('01-12'), { kind: 'late_coming' }))).status).toBe(422);
  });

  it('Scenario 1: leave for tomorrow reaches the manager and HR, nothing is booked until both approve, then balance and attendance update', async () => {
    const cl = await leaveTypeId('CL');
    const y = Number(tomorrow.slice(0, 4));
    const before = await balanceOf('CL', y);
    const o = await options();
    const r = ok(await as('emp').post('/requests/leave').send({
      leaveTypeId: cl, startDate: tomorrow, endDate: tomorrow, duration: 'full', reason: 'Family function out of town',
      primaryApproverId: o.defaults.primaryApproverId, additionalApproverIds: [people.hr.membershipId], contactDuringLeave: '+91 98100 00000', handoverTo: 'Pooja',
    }), 201);
    expect(r).toMatchObject({ kind: 'leave', status: 'pending', ref: expect.stringMatching(/^LV-/), workflow: 'all' });
    expect(r.leave).toMatchObject({ status: 'pending', days: '1.00', duration: 'full', handoverTo: 'Pooja' });
    expect(r.approvers.map((a: { part: string; membershipId: string }) => [a.part, a.membershipId])).toEqual([['primary', people.mgr.membershipId], ['additional', people.hr.membershipId]]);
    // Both see it waiting for them, both are notified, and the application form went to them by email (and a copy to Kunal).
    for (const who of ['mgr', 'hr']) {
      expect((await approvalsOf(who)).items.map((x: { id: string }) => x.id)).toContain(r.id);
      expect((await notices(who)).filter((n) => n.kind === 'approval.requested' && n.link.includes(r.approvalId)).length).toBe(1);
    }
    const mails = await pool.find('email_messages', { tenant_id: t.id, template: 'leave.application' });
    expect(mails).toHaveLength(3);
    expect(String(mails[0]!.html_body)).toContain('Leave Application Form');
    // Pending: no deduction from the balance, no attendance mark.
    const pending = await balanceOf('CL', y);
    expect(pending.used).toBe(before.used);
    expect(Number(pending.pending)).toBe(Number(before.pending) + 1);
    expect(await dayStatus(people.emp.employeeId!, tomorrow)).not.toMatch(/leave/);
    // A second application for the same day is refused (no duplicates, no overlap).
    expect((await as('emp').post('/requests/leave').send({ leaveTypeId: cl, startDate: tomorrow, endDate: tomorrow, reason: 'Family function again', primaryApproverId: people.mgr.membershipId })).body.error.code).toBe('overlapping_leave');

    // The manager approves (with a confirmation comment): still waiting for HR.
    const half = ok(await decide('mgr', r.id, 'approve', 'Enjoy the function.'));
    expect(half.status).toBe('pending');
    expect(half.statusMessage).toContain('Waiting for 1 of 2');
    expect((await balanceOf('CL', y)).used).toBe(before.used);
    const done = ok(await decide('hr', r.id, 'approve'));
    expect(done).toMatchObject({ status: 'approved', leave: { status: 'approved' } });
    expect(done.events.map((e: { action: string }) => e.action)).toEqual(['submitted', 'approved', 'approved', 'completed']);
    // Booked now: the balance goes down and the day is on leave.
    expect(Number((await balanceOf('CL', y)).used)).toBe(Number(before.used) + 1);
    expect(await dayStatus(people.emp.employeeId!, tomorrow)).toBe('on_leave');
    const n = (await notices('emp')).find((x) => x.kind === 'request.approved' && x.link === `/requests/${r.id}`);
    expect(n?.title).toContain(r.ref);
    expect(n?.body).toContain('balance and attendance are updated');
    // The same record in My Requests, in both approvers' lists and for the Super Workspace.
    expect(ok(await as('emp').get('/requests')).items.find((x: { id: string }) => x.id === r.id).status).toBe('approved');
    for (const who of ['mgr', 'hr', 'owner']) expect(ok(await as(who).get(`/requests/${r.id}`)).status).toBe('approved');
  });

  it('Scenario 2: two approvers and two CC participants: one request, one notice each, CC cannot decide, no duplicate request', async () => {
    const r = ok(await as('emp').post('/requests').send(wfh(day('02-02'), { endDate: day('02-04'), additionalApproverIds: [people.hr.membershipId], ccIds: [people.cc1.membershipId, people.cc2.membershipId] })), 201);
    expect(r).toMatchObject({ status: 'pending', days: 3, ref: expect.stringMatching(/^REQ-/) });
    expect(r.cc.map((c: { membershipId: string }) => c.membershipId)).toEqual([people.cc1.membershipId, people.cc2.membershipId]);
    expect(await pool.find('staff_requests', { tenant_id: t.id, kind: 'wfh', start_date: day('02-02') })).toHaveLength(1);
    for (const who of ['mgr', 'hr']) expect((await notices(who)).filter((n) => n.kind === 'approval.requested' && n.link.includes(r.approvalId))).toHaveLength(1);
    for (const who of ['cc1', 'cc2']) {
      const mine = (await notices(who)).filter((n) => n.link === `/requests/${r.id}`);
      expect(mine).toHaveLength(1);
      expect(mine[0]!.title).toContain('you are in CC');
      // CC participants open it but cannot decide.
      const v = ok(await as(who).get(`/requests/${r.id}`));
      expect(v.can.decide).toBe(false);
      expect((await decide(who, r.id, 'approve')).status).toBe(404);
    }
    // The same request again for overlapping days is refused.
    expect((await as('emp').post('/requests').send(wfh(day('02-03'), { additionalApproverIds: [people.hr.membershipId] }))).body.error.code).toBe('duplicate_request');
    // Comments reach everyone else on the request.
    const c = ok(await as('cc1').post(`/requests/${r.id}/comments`).send({ body: 'I will cover the standup.' }), 201);
    expect(c.events.at(-1)).toMatchObject({ action: 'commented', comment: 'I will cover the standup.' });
    for (const who of ['emp', 'mgr', 'hr', 'cc2']) expect((await notices(who)).some((n) => n.kind === 'request.commented' && n.link === `/requests/${r.id}`)).toBe(true);
    ok(await decide('mgr', r.id, 'approve'));
    ok(await decide('hr', r.id, 'approve'));
    for (const who of ['cc1', 'cc2']) expect((await notices(who)).filter((n) => n.kind === 'request.approved' && n.link === `/requests/${r.id}`)).toHaveLength(1);
    expect((await notices('emp')).filter((n) => n.kind === 'request.approved' && n.link === `/requests/${r.id}`)).toHaveLength(1);
  });

  it('Scenario 3: a rejection needs a reason; the requester is notified and sees it; the status is the same everywhere', async () => {
    const r = ok(await as('emp').post('/requests').send({ kind: 'early_leave', reason: 'Doctor appointment at 5 PM', startDate: day('03-03'), startTime: '16:30', primaryApproverId: people.mgr.membershipId, additionalApproverIds: [people.hr.membershipId] }), 201);
    expect(r.when).toContain('leaving at 4:30 PM');
    expect((await decide('mgr', r.id, 'reject')).status).toBe(422);
    const rej = ok(await decide('mgr', r.id, 'reject', 'Client demo at 5, please move the appointment.'));
    expect(rej.status).toBe('rejected');
    expect(rej.statusMessage).toContain('Rejected by Manish');
    const mine = ok(await as('emp').get(`/requests/${r.id}`));
    expect(mine.approvers[0]).toMatchObject({ status: 'rejected', comment: 'Client demo at 5, please move the appointment.' });
    // HR's step was withdrawn: nothing waits for them.
    expect(mine.approvers[1].status).toBe('cancelled');
    expect((await approvalsOf('hr')).items.map((x: { id: string }) => x.id)).not.toContain(r.id);
    expect((await approvalsOf('hr', 'rejected')).items.map((x: { id: string }) => x.id)).toContain(r.id);
    const n = (await notices('emp')).find((x) => x.kind === 'request.rejected' && x.link === `/requests/${r.id}`);
    expect(n?.body).toContain('Client demo at 5');
    for (const who of ['mgr', 'hr', 'owner']) expect(ok(await as(who).get(`/requests/${r.id}`)).status).toBe('rejected');
  });

  it('Scenario 4: an Employee Workspace member sends to an HR Workspace user and a Super Workspace manager; decisions sync', async () => {
    const r = ok(await as('emp').post('/requests').send(wfh(day('04-14'), { primaryApproverId: people.hr2.membershipId, additionalApproverIds: [people.owner.membershipId] })), 201);
    expect(r.approvers.map((a: { levelLabel: string }) => a.levelLabel)).toEqual(['HR Workspace', 'Super Workspace']);
    expect((await approvalsOf('hr2')).items.map((x: { id: string }) => x.id)).toContain(r.id);
    expect((await approvalsOf('owner')).items.map((x: { id: string }) => x.id)).toContain(r.id);
    ok(await decide('owner', r.id, 'approve', 'Fine by me.'));
    // The HR user sees the Super Workspace decision on the same record.
    const forHr = ok(await as('hr2').get(`/requests/${r.id}`));
    expect(forHr.approvers[1]).toMatchObject({ status: 'approved', comment: 'Fine by me.' });
    expect(forHr.can.decide).toBe(true);
    ok(await decide('hr2', r.id, 'approve'));
    for (const who of ['emp', 'hr2', 'owner']) expect(ok(await as(who).get(`/requests/${r.id}`)).status).toBe('approved');
    expect((await approvalsOf('owner', 'approved')).items.map((x: { id: string }) => x.id)).toContain(r.id);
  });

  it('Scenario 5: My Day for an HR user shows only their own requests and decisions', async () => {
    const own = ok(await as('hr').post('/requests').send(wfh(day('05-05'), { primaryApproverId: people.owner.membershipId })), 201);
    const d = ok(await as('hr').get('/requests/my-day'));
    expect(d.recent.length).toBeGreaterThan(0);
    expect(d.recent.every((x: { requester: { membershipId: string } }) => x.requester.membershipId === people.hr.membershipId)).toBe(true);
    expect(d.recent.map((x: { id: string }) => x.id)).toContain(own.id);
    expect(d.counts.pending).toBe(1);
    // Their decisions are listed (approval history), but no one else's requests appear as their own.
    expect(d.decisions.length).toBeGreaterThan(0);
    expect(d.decisions.every((x: { requester: string }) => typeof x.requester === 'string')).toBe(true);
    expect(JSON.stringify(d.recent)).not.toContain(people.emp.membershipId);
  });

  it('request changes: a comment is required, the requester corrects it and it goes to the same approvers as round 2', async () => {
    const r = ok(await as('emp').post('/requests').send({ kind: 'late_coming', reason: 'School drop-off', startDate: day('06-08'), startTime: '11:00', primaryApproverId: people.mgr.membershipId }), 201);
    expect((await decide('mgr', r.id, 'changes')).status).toBe(422);
    const back = ok(await decide('mgr', r.id, 'changes', 'Please say when you will reach.'));
    expect(back.status).toBe('changes_requested');
    expect(back.statusMessage).toContain('asked for changes');
    const n = (await notices('emp')).find((x) => x.kind === 'request.changes_requested' && x.link === `/requests/${r.id}`);
    expect(n?.body).toContain('Please say when you will reach.');
    const mine = ok(await as('emp').get(`/requests/${r.id}`));
    expect(mine.can).toMatchObject({ resubmit: true, cancel: true });
    const again = ok(await as('emp').post(`/requests/${r.id}/resubmit`).send({ reason: 'School drop-off, I will reach by 10:45', startDate: day('06-08'), startTime: '10:45', note: 'Added the time' }));
    expect(again).toMatchObject({ status: 'pending', round: 2, startTime: '10:45' });
    expect(again.events.map((e: { action: string }) => e.action)).toEqual(['submitted', 'changes_requested', 'resubmitted']);
    expect((await approvalsOf('mgr')).items.map((x: { id: string }) => x.id)).toContain(r.id);
    expect(ok(await decide('mgr', r.id, 'approve')).status).toBe('approved');
  });

  it('workflows from Settings: sequential goes one approver after another; "any one" approves on the first approval', async () => {
    // Only the Super Workspace changes the settings.
    const s = ok(await as('owner').get('/requests/settings'));
    expect(s.canManage).toBe(true);
    const categories = s.settings.categories.map((c: Record<string, unknown>) => (c.key === 'early_leave' ? { ...c, workflow: 'sequential' } : c.key === 'comp_off' ? { ...c, workflow: 'any' } : c));
    const body = { ...s.settings, categories };
    expect((await as('emp').put('/requests/settings').send(body)).status).toBe(403);
    ok(await as('owner').put('/requests/settings').send(body));

    const seq = ok(await as('emp').post('/requests').send({ kind: 'early_leave', reason: 'Bank work before closing', startDate: day('07-07'), startTime: '15:00', primaryApproverId: people.mgr.membershipId, additionalApproverIds: [people.hr.membershipId] }), 201);
    expect(seq.workflow).toBe('sequential');
    expect(seq.approvers.map((a: { status: string }) => a.status)).toEqual(['pending', 'waiting']);
    expect((await approvalsOf('hr')).items.map((x: { id: string }) => x.id)).not.toContain(seq.id);
    ok(await decide('mgr', seq.id, 'approve'));
    expect((await approvalsOf('hr')).items.map((x: { id: string }) => x.id)).toContain(seq.id);
    expect(ok(await decide('hr', seq.id, 'approve')).status).toBe('approved');

    const any = ok(await as('emp').post('/requests').send({ kind: 'comp_off', reason: 'Worked on the release Sunday', startDate: day('07-09'), workedOn: day('07-05'), primaryApproverId: people.mgr.membershipId, additionalApproverIds: [people.hr.membershipId] }), 201);
    const one = ok(await decide('hr', any.id, 'approve'));
    expect(one.status).toBe('approved');
    expect(one.approvers.map((a: { status: string }) => a.status)).toEqual(['not_needed', 'approved']);
    // A switched-off category cannot be raised.
    ok(await as('owner').put('/requests/settings').send({ ...body, categories: categories.map((c: Record<string, unknown>) => (c.key === 'other' ? { ...c, enabled: false } : c)) }));
    expect((await as('emp').post('/requests').send({ kind: 'other', title: 'New chair', reason: 'My chair is broken', startDate: day('07-10'), primaryApproverId: people.mgr.membershipId })).body.error.code).toBe('category_disabled');
  });

  it('half-day and hourly leave, cancelling a pending leave, and cancelling approved leave through the approvers', async () => {
    const cl = await leaveTypeId('CL');
    const half = ok(await as('emp').post('/requests/leave').send({ leaveTypeId: cl, startDate: day('08-03'), endDate: day('08-03'), duration: 'half', startHalf: 'second_half', reason: 'Parent-teacher meeting', primaryApproverId: people.mgr.membershipId }), 201);
    expect(half.leave).toMatchObject({ days: '0.50', duration: 'half', startHalf: 'second_half' });
    expect(half.when).toContain('second half');
    const hours = ok(await as('emp').post('/requests/leave').send({ leaveTypeId: cl, startDate: day('08-04'), endDate: day('08-04'), duration: 'hours', startTime: '10:00', endTime: '12:00', reason: 'Passport appointment', primaryApproverId: people.mgr.membershipId }), 201);
    expect(hours.leave).toMatchObject({ days: '0.25', duration: 'hours', startTime: '10:00', endTime: '12:00' });

    // A pending one is simply cancelled: the leave is closed and it leaves the approver's list.
    const c = ok(await as('emp').post(`/requests/${hours.id}/cancel`).send({ reason: 'Appointment moved' }));
    expect(c).toMatchObject({ status: 'cancelled', leave: { status: 'cancelled' } });
    expect((await approvalsOf('mgr')).items.map((x: { id: string }) => x.id)).not.toContain(hours.id);
    expect((await notices('mgr')).some((n) => n.kind === 'request.cancelled' && n.link === `/requests/${hours.id}`)).toBe(true);

    // Approved leave: "Cancel" is refused; the cancellation goes to the same approvers and the leave stays booked meanwhile.
    ok(await decide('mgr', half.id, 'approve'));
    expect((await as('emp').post(`/requests/${half.id}/cancel`).send({})).status).toBe(409);
    expect((await as('emp').post(`/leave/requests/${half.leave.id}/cancel`).send({ reason: 'Not needed' })).body.error.code).toBe('cancellation_needs_approval');
    const asked = ok(await as('emp').post(`/requests/${half.id}/cancel-leave`).send({ reason: 'Meeting called off' }));
    expect(asked.cancellation).toMatchObject({ kind: 'leave_cancellation', status: 'pending', cancelsLeave: { id: half.leave.id } });
    expect(asked.request.can.cancelApprovedLeave).toBe(false);
    expect((await as('emp').post(`/requests/${half.id}/cancel-leave`).send({ reason: 'Meeting called off' })).body.error.code).toBe('duplicate_request');
    expect(ok(await as('emp').get(`/leave/requests/${half.leave.id}`)).status).toBe('approved');
    ok(await decide('mgr', asked.cancellation.id, 'approve'));
    expect(ok(await as('emp').get(`/leave/requests/${half.leave.id}`)).status).toBe('cancelled');
    const original = ok(await as('emp').get(`/requests/${half.id}`));
    expect(original.status).toBe('cancelled');
    expect(original.events.map((e: { action: string }) => e.action)).toContain('cancellation_requested');
  });

  it('a rejected leave application books nothing, and changes requested on leave close it until it is corrected', async () => {
    const cl = await leaveTypeId('CL');
    const before = await balanceOf('CL', year);
    const r = ok(await as('emp').post('/requests/leave').send({ leaveTypeId: cl, startDate: day('09-07'), endDate: day('09-08'), reason: 'Trip to Jaipur', primaryApproverId: people.mgr.membershipId }), 201);
    ok(await decide('mgr', r.id, 'changes', 'Take the 9th as well, the team is off.'));
    let v = ok(await as('emp').get(`/requests/${r.id}`));
    expect(v.leave.status).toBe('cancelled');
    expect((await balanceOf('CL', year)).pending).toBe(before.pending);
    v = ok(await as('emp').post(`/requests/${r.id}/resubmit`).send({ reason: 'Trip to Jaipur', startDate: day('09-07'), endDate: day('09-09') }));
    expect(v).toMatchObject({ status: 'pending', round: 2, leave: { status: 'pending', days: '3.00' } });
    ok(await decide('mgr', v.id, 'reject', 'Quarter close, not possible.'));
    v = ok(await as('emp').get(`/requests/${r.id}`));
    expect(v).toMatchObject({ status: 'rejected', leave: { status: 'rejected' } });
    expect((await balanceOf('CL', year)).used).toBe(before.used);
  });

  it('an approved attendance regularization adds the check-in and check-out to the day', async () => {
    const r = ok(await as('emp').post('/requests').send({ kind: 'attendance_regularization', reason: 'Forgot to check out', startDate: lastWorkingDay, startTime: '09:30', endTime: '18:30', primaryApproverId: people.mgr.membershipId }), 201);
    expect((await pool.find('attendance_events', { tenant_id: t.id, employee_id: people.emp.employeeId, source_event_id: { $regex: `^request:${r.id}` } }))).toHaveLength(0);
    ok(await decide('mgr', r.id, 'approve'));
    const punches = await pool.find('attendance_events', { tenant_id: t.id, employee_id: people.emp.employeeId, source_event_id: { $regex: `^request:${r.id}` } });
    expect(punches.map((p) => p.direction).sort()).toEqual(['in', 'out']);
    // Not for a future day.
    expect((await as('emp').post('/requests').send({ kind: 'attendance_regularization', reason: 'Will forget', startDate: day('10-10'), startTime: '09:30', endTime: '18:30', primaryApproverId: people.mgr.membershipId })).body.error.code).toBe('future_date');
  });

  it('reminds the approvers once before a pending request starts, and hides a request from people not on it', async () => {
    const soon = iso(Date.now() + 86_400_000);
    const r = ok(await as('peer').post('/requests').send(wfh(soon)), 201);
    const sent = await app.get(RequestsService).remindDue(t.id, iso(Date.now()));
    expect(sent).toBeGreaterThanOrEqual(1);
    expect((await notices('mgr')).filter((n) => n.kind === 'request.reminder' && n.link === `/requests/${r.id}`)).toHaveLength(1);
    expect(await app.get(RequestsService).remindDue(t.id, iso(Date.now()))).toBe(0);
    expect((await as('emp').get(`/requests/${r.id}`)).status).toBe(404);
    expect((await as('cc1').get(`/requests/${r.id}`)).status).toBe(404);
  });
});
