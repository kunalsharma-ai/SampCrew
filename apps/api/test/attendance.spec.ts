import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attlogLines } from '../src/modules/attendance/zk-push';
import { addMember, adminPool, api, createApp, createTenant, department, login, loginWithMfa, type TestTenant } from './helpers';

const IST_OFFSET = '+05:30';
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const plus = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dow = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
/** The nth weekday (Mon-Fri) before today in India, counting back from two days ago. */
const pastWeekday = (n: number) => {
  let d = plus(istToday(), -2);
  let seen = 0;
  for (;;) {
    if (dow(d) !== 0 && dow(d) !== 6 && ++seen === n) return d;
    d = plus(d, -1);
  }
};
const futureWeekday = (n: number) => {
  let d = plus(istToday(), 2);
  let seen = 0;
  for (;;) {
    if (dow(d) !== 0 && dow(d) !== 6 && ++seen === n) return d;
    d = plus(d, 1);
  }
};

/** Phase 3 through the HTTP API: punching, the engine, corrections, overtime, locks, rosters, swaps, devices, kiosks. */
describe('attendance', () => {
  let app: INestApplication;
  let pool: Pool;
  let t: TestTenant;
  let other: TestTenant;
  let hrAdmin: string;
  let assembly: string;
  let qa: string;
  let pune: string;
  const people: Record<string, { email: string; membershipId: string; employeeId: string }> = {};
  const token = async (who: string) => (await login(app, people[who]!.email)).accessToken;
  const punchAt = async (who: string, date: string, time: string, direction: 'in' | 'out' | 'unknown' = 'unknown') => {
    await pool.query(
      `insert into attendance_events (tenant_id, employee_id, source, source_event_id, captured_at, direction) values ($1, $2, 'import', gen_random_uuid()::text, $3, $4)`,
      [t.id, people[who]!.employeeId, `${date}T${time}:00${IST_OFFSET}`, direction],
    );
  };
  const dayOf = async (who: string, date: string, as?: string) => {
    const res = await api(app, as ?? (await token(who))).get(`/attendance/days?employeeId=${people[who]!.employeeId}&from=${date}&to=${date}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.days[0] as { status: string; lateMinutes: number; workedMinutes: number; overtimeMinutes: number; approvedOvertimeMinutes: number; flags: string[]; explanation: string[] };
  };
  const approveAll = async (who: string) => {
    const tk = await token(who);
    const inbox = await api(app, tk).get('/approvals/inbox');
    for (const item of inbox.body) expect((await api(app, tk).post(`/approvals/${item.id}/approve`).send({})).status).toBe(200);
    return inbox.body as { id: string; resourceType: string; summary: string }[];
  };

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    other = await createTenant(pool);
    assembly = await department(pool, t, 'Assembly');
    qa = await department(pool, t, 'Quality');
    pune = (await pool.query<{ id: string }>(
      `insert into locations (tenant_id, legal_entity_id, name, kind, timezone, country_code, latitude, longitude, geofence_radius_m) values ($1, $2, 'Pune Plant', 'factory', 'Asia/Kolkata', 'IN', 18.5204, 73.8567, 200) returning id`,
      [t.id, t.legalEntityId],
    )).rows[0]!.id;
    const hr = await addMember(pool, t, { roles: ['hr_admin'], name: 'Hana HR' });
    const sup = await addMember(pool, t, { roles: ['department_manager'], departmentId: assembly, name: 'Sam Supervisor' });
    const op = await addMember(pool, t, { departmentId: assembly, managerId: sup.membershipId, name: 'Olu Operator' });
    const op2 = await addMember(pool, t, { departmentId: assembly, managerId: sup.membershipId, name: 'Ola Operator' });
    const peer = await addMember(pool, t, { departmentId: qa, name: 'Pat Peer' });
    hrAdmin = (await loginWithMfa(app, pool, hr.email)).accessToken;
    const hire = async (m: { email: string; membershipId: string }, body: Record<string, unknown>) => {
      const res = await api(app, hrAdmin).post('/employees').send({ legalEntityId: t.legalEntityId, dateOfJoining: '2024-01-15', probationMonths: 0, locationId: pune, membershipId: m.membershipId, ...body });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return { ...m, employeeId: res.body.employee.id as string };
    };
    people.hr = await hire(hr, { firstName: 'Hana', lastName: 'HR' });
    people.supervisor = await hire(sup, { firstName: 'Sam', lastName: 'Supervisor', departmentId: assembly });
    people.operator = await hire(op, { firstName: 'Olu', lastName: 'Operator', departmentId: assembly, managerEmployeeId: people.supervisor.employeeId });
    people.operator2 = await hire(op2, { firstName: 'Ola', lastName: 'Operator', departmentId: assembly, managerEmployeeId: people.supervisor.employeeId });
    people.peer = await hire(peer, { firstName: 'Pat', lastName: 'Peer', departmentId: qa });
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('punching', () => {
    it('records web punches once per client id, alternating in and out, with the geofence result', async () => {
      const op = await token('operator');
      const first = await api(app, op).post('/attendance/punch').send({ clientEventId: 'web-test-0001', latitude: 18.5205, longitude: 73.8568, accuracyM: 20 });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(first.body.punch).toMatchObject({ direction: 'in', source: 'web', geofence: 'inside' });
      const retry = await api(app, op).post('/attendance/punch').send({ clientEventId: 'web-test-0001', latitude: 18.5205, longitude: 73.8568 });
      expect(retry.body).toMatchObject({ duplicate: true, punch: { id: first.body.punch.id } });
      // Outside the fence is recorded and flagged while the policy only warns.
      const out = await api(app, op).post('/attendance/punch').send({ clientEventId: 'web-test-0002', latitude: 18.53, longitude: 73.8567 });
      expect(out.body.punch).toMatchObject({ direction: 'out', geofence: 'outside' });
      expect(out.body.punch.distanceM).toBeGreaterThan(1000);
      const today = await api(app, op).get('/attendance/today');
      expect(today.body).toMatchObject({ nextDirection: 'in', geofence: { mode: 'warn', configured: true, radiusM: 200 } });
      expect(today.body.punches).toHaveLength(2);
      expect(today.body.day.flags).toContain('outside_geofence');
    });

    it('refuses punches outside an enforced geofence, or without a location, and audits the refusal', async () => {
      expect((await api(app, hrAdmin).put('/attendance/policies').send({ locationId: pune, geofenceMode: 'enforce', defaultShiftId: null })).status).toBe(200);
      const peer = await token('peer');
      const far = await api(app, peer).post('/attendance/punch').send({ clientEventId: 'web-test-0101', latitude: 18.6, longitude: 73.8567 });
      expect(far.status).toBe(403);
      expect(far.body.error.message).toMatch(/outside its 200 m area/);
      expect((await api(app, peer).post('/attendance/punch').send({ clientEventId: 'web-test-0102' })).body.error.code).toBe('location_required');
      expect((await api(app, peer).post('/attendance/punch').send({ clientEventId: 'web-test-0103', latitude: 18.5204, longitude: 73.8567 })).status).toBe(201);
      const audit = await pool.query(`select 1 from audit_events where tenant_id = $1 and action = 'attendance.punch_refused'`, [t.id]);
      expect(audit.rowCount).toBe(1);
      // Back to the workspace default for the rest of the tests.
      expect((await api(app, hrAdmin).delete(`/attendance/policies/${pune}`)).status).toBe(204);
    });

    it('raw punches cannot be edited or deleted, even directly in the database', async () => {
      await expect(pool.query(`update attendance_events set captured_at = now() where tenant_id = $1`, [t.id])).rejects.toThrow(/append-only|not allowed|immutable/i);
      await expect(pool.query(`delete from attendance_events where tenant_id = $1`, [t.id])).rejects.toThrow();
    });
  });

  describe('engine on real data', () => {
    it('computes past days from punches: late, missing punch, absent and weekly off, with explanations', async () => {
      const [d1, d2, d3] = [pastWeekday(3), pastWeekday(4), pastWeekday(5)];
      await punchAt('operator', d1, '09:25');
      await punchAt('operator', d1, '18:30');
      await punchAt('operator', d2, '09:00', 'in');
      const late = await dayOf('operator', d1);
      expect(late).toMatchObject({ status: 'present', lateMinutes: 25, workedMinutes: 485 });
      expect(late.explanation.join(' ')).toContain('25 minutes after the shift start of 09:00');
      expect(await dayOf('operator', d2)).toMatchObject({ status: 'missing_punch', flags: ['missing_out'] });
      expect((await dayOf('operator', d3)).status).toBe('absent');
      let sunday = plus(istToday(), -3);
      while (dow(sunday) !== 0) sunday = plus(sunday, -1);
      expect((await dayOf('operator', sunday)).status).toBe('weekly_off');
    });

    it('team view shows only people in scope, with counts', async () => {
      const d1 = pastWeekday(3);
      const sup = await api(app, await token('supervisor')).get(`/attendance/team?date=${d1}`);
      expect(sup.status).toBe(200);
      const names = sup.body.rows.map((r: { employeeName: string }) => r.employeeName).sort();
      // The supervisor sees their team and themselves.
      expect(names).toEqual(['Ola Operator', 'Olu Operator', 'Sam Supervisor']);
      expect(sup.body.summary).toMatchObject({ total: 3, present: 1, absent: 2, late: 1 });
      const peer = await api(app, await token('peer')).get(`/attendance/team?date=${d1}`);
      expect(peer.body.rows.map((r: { employeeName: string }) => r.employeeName)).toEqual(['Pat Peer']);
      // Someone outside the team cannot open a colleague's day.
      expect((await api(app, await token('peer')).get(`/attendance/days/${people.operator!.employeeId}/${d1}`)).status).toBe(404);
    });
  });

  describe('corrections and overtime', () => {
    it('a correction goes to the manager; approval adds a punch and fixes the day, leaving the originals as they were', async () => {
      const d2 = pastWeekday(4);
      const op = await token('operator');
      const before = await pool.query(`select count(*)::int as n from attendance_events where employee_id = $1`, [people.operator!.employeeId]);
      const twice = await api(app, op).post('/attendance/corrections').send({ workDate: d2, punches: [{ time: '18:05', direction: 'out' }, { time: '18:05', direction: 'out' }], reason: 'Twice' });
      expect(twice.status).toBe(422);
      const res = await api(app, op).post('/attendance/corrections').send({ workDate: d2, punches: [{ time: '18:05', direction: 'out' }], reason: 'Forgot to punch out' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect((await api(app, op).post('/attendance/corrections').send({ workDate: d2, punches: [{ time: '18:10', direction: 'out' }], reason: 'Again' })).body.error.code).toBe('correction_pending');
      expect((await api(app, op).post('/attendance/corrections').send({ workDate: plus(istToday(), 3), punches: [{ time: '18:10', direction: 'out' }], reason: 'Future' })).body.error.code).toBe('future_date');
      // The operator cannot approve it; the supervisor can.
      expect((await api(app, op).get('/approvals/inbox')).body).toHaveLength(0);
      const approved = await approveAll('supervisor');
      expect(approved.map((a) => a.resourceType)).toEqual(['attendance_correction']);
      expect(await dayOf('operator', d2)).toMatchObject({ status: 'present', flags: [] });
      const after = await pool.query(`select count(*)::int as n, count(*) filter (where source = 'correction')::int as c from attendance_events where employee_id = $1`, [people.operator!.employeeId]);
      expect(after.rows[0]).toEqual({ n: before.rows[0].n + 1, c: 1 });
    });

    it('overtime counts once a claim for it is approved, and a claim cannot exceed what was recorded', async () => {
      const gen = (await api(app, hrAdmin).get('/shifts/templates')).body.find((s: { code: string }) => s.code === 'GEN');
      const { id, archivedAt, ...rest } = gen;
      expect((await api(app, hrAdmin).put(`/shifts/templates/${id}`).send({ ...rest, overtimeEnabled: true, overtimeMinMinutes: 30 })).status).toBe(200);
      const d4 = pastWeekday(6);
      await punchAt('operator', d4, '09:00');
      await punchAt('operator', d4, '20:00');
      expect(await dayOf('operator', d4)).toMatchObject({ overtimeMinutes: 120, approvedOvertimeMinutes: 0 });
      const op = await token('operator');
      expect((await api(app, op).post('/attendance/overtime').send({ workDate: d4, minutes: 150 })).body.error.code).toBe('too_many_minutes');
      expect((await api(app, op).post('/attendance/overtime').send({ workDate: d4, minutes: 120, reason: 'Line changeover' })).status).toBe(201);
      await approveAll('supervisor');
      expect(await dayOf('operator', d4)).toMatchObject({ overtimeMinutes: 120, approvedOvertimeMinutes: 120 });
    });

    it('approved leave turns an absence into leave', async () => {
      const d3 = pastWeekday(5);
      const type = await api(app, hrAdmin).post('/leave/types').send({ code: 'LWP', name: 'Leave without pay', paid: false });
      expect((await api(app, hrAdmin).post('/leave/policies').send({ leaveTypeId: type.body.id, accrualMethod: 'none', annualEntitlement: '0' })).status).toBe(201);
      const req = await api(app, hrAdmin).post('/leave/requests').send({ employeeId: people.operator!.employeeId, leaveTypeId: type.body.id, startDate: d3, endDate: d3, reason: 'Recorded late' });
      expect(req.status, JSON.stringify(req.body)).toBe(201);
      await approveAll('supervisor');
      expect((await dayOf('operator', d3)).status).toBe('on_leave');
    });
  });

  describe('period locks', () => {
    it('a locked period freezes days and refuses corrections; unlocking needs a reason', async () => {
      const d = pastWeekday(9);
      expect((await dayOf('operator', d)).status).toBe('absent');
      const lock = await api(app, hrAdmin).post('/attendance/locks').send({ periodStart: plus(d, -1), periodEnd: plus(d, 1), note: 'Payroll test' });
      expect(lock.status, JSON.stringify(lock.body)).toBe(201);
      expect((await api(app, hrAdmin).post('/attendance/locks').send({ periodStart: d, periodEnd: d })).body.error.code).toBe('already_locked');
      await punchAt('operator', d, '09:00');
      await punchAt('operator', d, '18:00');
      await api(app, hrAdmin).post('/attendance/recompute').send({ employeeId: people.operator!.employeeId, from: d, to: d });
      expect((await dayOf('operator', d)).status).toBe('absent');
      expect((await api(app, await token('operator')).post('/attendance/corrections').send({ workDate: d, punches: [{ time: '09:00', direction: 'in' }], reason: 'Locked' })).body.error.code).toBe('period_locked');
      expect((await api(app, hrAdmin).post(`/attendance/locks/${lock.body.id}/unlock`).send({})).status).toBe(422);
      expect((await api(app, hrAdmin).post(`/attendance/locks/${lock.body.id}/unlock`).send({ reason: 'Late punches imported' })).status).toBe(204);
      await api(app, hrAdmin).post('/attendance/recompute').send({ employeeId: people.operator!.employeeId, from: d, to: d });
      expect((await dayOf('operator', d)).status).toBe('present');
      // Only attendance configurers can lock.
      expect((await api(app, await token('supervisor')).post('/attendance/locks').send({ periodStart: d, periodEnd: d })).status).toBe(403);
    });
  });

  describe('shifts and rosters', () => {
    let night: string;
    let gen: string;
    const f1 = futureWeekday(3);

    it('a draft roster changes nothing until published; publishing notifies the people on it', async () => {
      const n = await api(app, hrAdmin).post('/shifts/templates').send({ code: 'NIGHT', name: 'Night', startTime: '22:00', endTime: '06:00', breakMinutes: 30, fullDayMinutes: 450 });
      expect(n.status, JSON.stringify(n.body)).toBe(201);
      night = n.body.id;
      gen = (await api(app, hrAdmin).get('/shifts/templates')).body.find((s: { code: string }) => s.code === 'GEN').id;
      const sup = await token('supervisor');
      const roster = await api(app, sup).post('/shifts/rosters').send({ name: 'Assembly next week', startDate: f1, endDate: plus(f1, 2), departmentId: assembly });
      expect(roster.status, JSON.stringify(roster.body)).toBe(201);
      expect(roster.body.rows.map((r: { name: string }) => r.name).sort()).toEqual(['Ola Operator', 'Olu Operator', 'Sam Supervisor']);
      const put = await api(app, sup).put('/shifts/assignments').send({
        rosterId: roster.body.id,
        assignments: [{ employeeId: people.operator!.employeeId, workDate: f1, shiftTemplateId: night }, { employeeId: people.operator2!.employeeId, workDate: f1, shiftTemplateId: gen }],
      });
      expect(put.status, JSON.stringify(put.body)).toBe(200);
      const op = await token('operator');
      const sched = async () => (await api(app, op).get(`/shifts/schedule?from=${f1}&to=${f1}`)).body.days[0].shift.code;
      expect(await sched()).toBe('GEN');
      expect((await api(app, sup).post(`/shifts/rosters/${roster.body.id}/publish`)).status).toBe(200);
      expect(await sched()).toBe('NIGHT');
      const notes = await api(app, op).get('/notifications');
      expect(notes.body.items.some((x: { kind: string }) => x.kind === 'roster.published')).toBe(true);
      expect((await api(app, sup).delete(`/shifts/rosters/${roster.body.id}`)).body.error.code).toBe('roster_published');
    });

    it('managers can only schedule their own team', async () => {
      const sup = await token('supervisor');
      const res = await api(app, sup).put('/shifts/assignments').send({ assignments: [{ employeeId: people.peer!.employeeId, workDate: f1, shiftTemplateId: night }] });
      expect(res.status).toBe(404);
      const peer = await token('peer');
      expect((await api(app, peer).put('/shifts/assignments').send({ assignments: [{ employeeId: people.peer!.employeeId, workDate: f1, shiftTemplateId: night }] })).status).toBe(403);
    });

    it('a swap needs the colleague to accept and the manager to approve, then the shifts exchange', async () => {
      const op = await token('operator');
      const cands = await api(app, op).get(`/shifts/swap-candidates?date=${f1}`);
      expect(cands.body.myShift).toMatch(/^NIGHT/);
      expect(cands.body.candidates.map((c: { name: string }) => c.name)).toContain('Ola Operator');
      const swap = await api(app, op).post('/shifts/swaps').send({ workDate: f1, counterpartEmployeeId: people.operator2!.employeeId, reason: 'Exam the next day' });
      expect(swap.status, JSON.stringify(swap.body)).toBe(201);
      // Nothing for the manager until the colleague agrees, and only the colleague can agree.
      expect((await api(app, await token('supervisor')).get('/approvals/inbox')).body).toHaveLength(0);
      expect((await api(app, op).post(`/shifts/swaps/${swap.body.id}/accept`)).status).toBe(404);
      expect((await api(app, await token('operator2')).post(`/shifts/swaps/${swap.body.id}/accept`)).body.status).toBe('pending');
      expect((await approveAll('supervisor')).map((a) => a.resourceType)).toEqual(['shift_swap']);
      const mine = (await api(app, op).get(`/shifts/schedule?from=${f1}&to=${f1}`)).body.days[0].shift.code;
      const theirs = (await api(app, await token('operator2')).get(`/shifts/schedule?from=${f1}&to=${f1}`)).body.days[0].shift.code;
      expect([mine, theirs]).toEqual(['GEN', 'NIGHT']);
    });
  });

  describe('devices', () => {
    const sn = `CREWT${Date.now().toString(36).toUpperCase()}`;
    let deviceId: string;
    const push = () => request(app.getHttpServer());

    it('refuses unknown serials, answers the handshake for a registered device', async () => {
      expect((await push().get(`/iclock/cdata?SN=NOPE1234&options=all`)).status).toBe(401);
      const dev = await api(app, hrAdmin).post('/attendance/devices').send({ name: 'Gate 1', vendor: 'zkteco', model: 'Push terminal', serialNumber: sn, locationId: pune });
      expect(dev.status, JSON.stringify(dev.body)).toBe(201);
      deviceId = dev.body.id;
      expect((await api(app, hrAdmin).post('/attendance/devices').send({ name: 'Copy', vendor: 'zkteco', serialNumber: sn, locationId: pune })).body.error.code).toBe('serial_registered');
      const hs = await push().get(`/iclock/cdata?SN=${sn}&options=all&pushver=2.4.1`);
      expect(hs.status).toBe(200);
      expect(hs.text).toContain(`GET OPTION FROM: ${sn}`);
      expect(hs.text).toContain('ATTLOGStamp=');
      const poll = await push().get(`/iclock/getrequest?SN=${sn}&INFO=Ver 8.0.4,12,10,345,192.168.1.20`);
      expect(poll.text).toBe('OK');
      const detail = await api(app, hrAdmin).get(`/attendance/devices/${deviceId}`);
      expect(detail.body).toMatchObject({ status: 'online', firmware: 'Ver 8.0.4', reportedUserCount: 12, reportedPunchCount: 345, setup: { path: '/iclock/cdata', serialNumber: sn } });
    });

    it('stores each record once, keeps punches from unmapped people, and applies them when mapped', async () => {
      const d5 = pastWeekday(7);
      const body = attlogLines([{ pin: '101', local: `${d5} 08:58:10`, status: 0 }, { pin: '101', local: `${d5} 18:02:44`, status: 1 }]) + 'garbage line\n';
      const up = await push().post(`/iclock/cdata?SN=${sn}&table=ATTLOG&Stamp=9999`).set('content-type', 'text/plain').send(body);
      expect(up.status).toBe(200);
      expect(up.text).toBe('OK: 2');
      const again = await push().post(`/iclock/cdata?SN=${sn}&table=ATTLOG&Stamp=9999`).set('content-type', 'application/x-www-form-urlencoded').send(body);
      expect(again.text).toBe('OK: 2');
      const detail = await api(app, hrAdmin).get(`/attendance/devices/${deviceId}`);
      expect(detail.body).toMatchObject({ recordsAccepted: 2, recordsDuplicate: 2, recordsRejected: 2, coverage: { seen: 1, mapped: 0 } });
      expect(detail.body.users[0]).toMatchObject({ deviceUserId: '101', punches: 2, employeeId: null });
      expect(detail.body.log[0]).toMatchObject({ kind: 'attlog', accepted: 0, duplicates: 2, rejected: 1 });
      expect((await dayOf('operator2', d5)).status).toBe('absent');
      expect((await api(app, hrAdmin).post('/attendance/devices/mappings').send({ deviceUserId: '101', employeeId: people.operator2!.employeeId })).status).toBe(201);
      expect(await dayOf('operator2', d5)).toMatchObject({ status: 'present', workedMinutes: 544 - 60 });
      const day = await api(app, await token('operator2')).get(`/attendance/days/${people.operator2!.employeeId}/${d5}`);
      expect(day.body.punches.map((p: { source: string; direction: string; device: string }) => [p.source, p.direction, p.device])).toEqual([['device', 'in', 'Gate 1'], ['device', 'out', 'Gate 1']]);
      // Operation logs are acknowledged and not stored.
      expect((await push().post(`/iclock/cdata?SN=${sn}&table=OPERLOG`).set('content-type', 'text/plain').send('OPLOG 4\t0\t2026-01-01 10:00:00\n')).text).toBe('OK: 1');
    });

    it('only accepts pushes from allowed addresses when a list is set', async () => {
      expect((await api(app, hrAdmin).patch(`/attendance/devices/${deviceId}`).send({ allowedIps: ['10.0.0.0/8'] })).status).toBe(200);
      expect((await push().get(`/iclock/getrequest?SN=${sn}`)).status).toBe(403);
      expect((await api(app, hrAdmin).get(`/attendance/devices/${deviceId}`)).body.status).toBe('error');
      expect((await api(app, hrAdmin).patch(`/attendance/devices/${deviceId}`).send({ allowedIps: ['127.0.0.1', '::1'] })).status).toBe(200);
      expect((await push().get(`/iclock/getrequest?SN=${sn}`)).status).toBe(200);
    });

    it('simulated devices are labelled and generate punches through the same pipeline; real pushes to them are refused', async () => {
      const simSn = `SIM${Date.now().toString(36).toUpperCase()}`;
      const dev = await api(app, hrAdmin).post('/attendance/devices').send({ name: 'Simulator', vendor: 'essl', serialNumber: simSn, locationId: pune, simulated: true });
      expect((await api(app, hrAdmin).post('/attendance/devices/mappings').send({ deviceId: dev.body.id, deviceUserId: '7', employeeId: people.peer!.employeeId })).status).toBe(201);
      const d6 = pastWeekday(8);
      const sim = await api(app, hrAdmin).post(`/attendance/devices/${dev.body.id}/simulate`).send({ date: d6, scenario: 'normal_day' });
      expect(sim.status, JSON.stringify(sim.body)).toBe(200);
      expect(sim.body.accepted).toBeGreaterThanOrEqual(2);
      expect((await api(app, hrAdmin).get('/attendance/devices')).body.find((d: { id: string }) => d.id === dev.body.id).status).toBe('simulated');
      expect((await dayOf('peer', d6, hrAdmin)).status).toBe('present');
      expect((await push().get(`/iclock/cdata?SN=${simSn}`)).status).toBe(403);
      expect((await api(app, hrAdmin).post(`/attendance/devices/${deviceId}/simulate`).send({})).body.error.code).toBe('not_simulated');
      // Device management needs its permission.
      expect((await api(app, await token('supervisor')).get('/attendance/devices')).status).toBe(403);
    });
  });

  describe('QR kiosk', () => {
    it('shows a rotating code to its token; scanning it punches once; forged or revoked codes fail', async () => {
      const k = await api(app, hrAdmin).post('/attendance/kiosks').send({ name: 'Canteen screen', locationId: pune });
      expect(k.status).toBe(201);
      expect(k.body.token).toHaveLength(43);
      expect((await request(app.getHttpServer()).get('/api/v1/kiosk/qr').set('x-kiosk-token', 'wrong')).status).toBe(401);
      const qr = await request(app.getHttpServer()).get('/api/v1/kiosk/qr').set('x-kiosk-token', k.body.token);
      expect(qr.body).toMatchObject({ kiosk: 'Canteen screen', location: 'Pune Plant', refreshSeconds: 30 });
      const op = await token('operator2');
      const scan = await api(app, op).post('/attendance/qr-punch').send({ code: qr.body.code });
      expect(scan.status, JSON.stringify(scan.body)).toBe(201);
      expect(scan.body.punch).toMatchObject({ source: 'qr', geofence: 'kiosk' });
      expect((await api(app, op).post('/attendance/qr-punch').send({ code: qr.body.code })).body.duplicate).toBe(true);
      const forged = qr.body.code.replace(/.$/, (c: string) => (c === 'A' ? 'B' : 'A'));
      expect((await api(app, op).post('/attendance/qr-punch').send({ code: forged })).body.error.code).toBe('qr_expired');
      expect((await api(app, hrAdmin).post(`/attendance/kiosks/${k.body.id}/revoke`)).status).toBe(204);
      expect((await request(app.getHttpServer()).get('/api/v1/kiosk/qr').set('x-kiosk-token', k.body.token)).status).toBe(401);
      // Another workspace's people cannot use this workspace's kiosk codes.
      const outsider = await addMember(pool, other, {});
      const k2 = await api(app, hrAdmin).post('/attendance/kiosks').send({ name: 'Gate screen', locationId: pune });
      const code2 = (await request(app.getHttpServer()).get('/api/v1/kiosk/qr').set('x-kiosk-token', k2.body.token)).body.code;
      const res = await api(app, (await login(app, outsider.email)).accessToken).post('/attendance/qr-punch').send({ code: code2 });
      expect(res.body.error.code).toBe('qr_expired');
    });
  });

  describe('isolation', () => {
    it('keeps every Phase 3 record inside its workspace', async () => {
      const tables = ['shift_templates', 'rosters', 'shift_assignments', 'attendance_policies', 'attendance_devices', 'device_user_mappings', 'device_ingest_log',
        'attendance_kiosks', 'attendance_events', 'attendance_days', 'attendance_periods', 'attendance_corrections', 'overtime_claims', 'shift_swap_requests'];
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('set local role crew_app');
        await client.query(`select set_config('app.tenant_id', $1, true)`, [other.id]);
        for (const table of tables) {
          const r = await client.query(`select count(*)::int as n from ${table} where tenant_id = $1`, [t.id]);
          expect(r.rows[0].n, table).toBe(0);
        }
        await expect(client.query(`insert into attendance_events (tenant_id, employee_id, source, source_event_id, captured_at) values ($1, $2, 'web', 'x', now())`, [t.id, people.operator!.employeeId])).rejects.toThrow();
        await client.query('rollback');
      } finally {
        client.release();
      }
      const otherOwner = (await login(app, other.ownerEmail)).accessToken;
      expect((await api(app, otherOwner).get(`/attendance/days/${people.operator!.employeeId}/${pastWeekday(3)}`)).status).toBe(404);
      expect((await api(app, otherOwner).get(`/attendance/devices/${(await pool.query('select id from attendance_devices where tenant_id = $1 limit 1', [t.id])).rows[0].id}`)).status).toBe(404);
    });
  });
});
