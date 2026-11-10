import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, adminPool, api, createApp, createTenant, department, login, loginWithMfa, type TestDb, type TestTenant } from './helpers';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const MONTH = '2026-09';

/** Phase 5 through the HTTP API: settings, salaries, a full payroll run with approval, payslips, expenses and exports. */
describe('payroll', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let other: TestTenant;
  let engineering: string;
  let mumbai: string;
  const people: Record<string, { email: string; membershipId: string; employeeId?: string }> = {};
  const tokens: Record<string, string> = {};
  const as = (who: string) => api(app, tokens[who]);
  let starting: Record<string, unknown>;
  let runId: string;
  let claimId: string;

  const ok = (res: { status: number; body: unknown }, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as Record<string, any>;
  };
  const approveAll = async (who: string, type: string) => {
    const inbox = ok(await as(who).get('/approvals/inbox')) as unknown as { id: string; resourceType: string }[];
    const items = inbox.filter((i) => i.resourceType === type);
    for (const i of items) ok(await as(who).post(`/approvals/${i.id}/approve`).send({}));
    return items.length;
  };
  const punch = (employeeId: string, date: string, time: string, direction: 'in' | 'out') =>
    pool.insert('attendance_events', { tenant_id: t.id, employee_id: employeeId, source: 'import', source_event_id: randomUUID(), captured_at: new Date(`${date}T${time}:00+05:30`), direction });

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    other = await createTenant(pool);
    engineering = await department(pool, t, 'Engineering');
    mumbai = (await pool.insert('locations', { tenant_id: t.id, legal_entity_id: t.legalEntityId, name: 'Mumbai office', timezone: 'Asia/Kolkata', city: 'Mumbai', region: 'Maharashtra', country_code: 'IN' })).id;
    people.hr = await addMember(pool, t, { roles: ['hr_admin'], name: 'Hana HR' });
    people.payroll = await addMember(pool, t, { roles: ['payroll_admin'], name: 'Pat Payroll' });
    people.finance = await addMember(pool, t, { roles: ['finance_manager'], name: 'Fin Finance' });
    people.manager = await addMember(pool, t, { roles: ['department_manager'], departmentId: engineering, name: 'Manu Manager' });
    people.asha = await addMember(pool, t, { departmentId: engineering, name: 'Asha Rao' });
    people.bala = await addMember(pool, t, { departmentId: engineering, name: 'Bala Iyer' });
    tokens.hr = (await loginWithMfa(app, pool, people.hr.email)).accessToken;
    tokens.payroll = (await loginWithMfa(app, pool, people.payroll.email)).accessToken;
    tokens.payrollNoMfa = (await login(app, people.payroll.email)).accessToken;
    tokens.finance = (await loginWithMfa(app, pool, people.finance.email)).accessToken;

    const hire = async (who: string, first: string, last: string, joined: string, managerEmployeeId?: string) => {
      const body = ok(await as('hr').post('/employees').send({
        legalEntityId: t.legalEntityId, firstName: first, lastName: last, dateOfJoining: joined, probationMonths: 0, membershipId: people[who]!.membershipId,
        departmentId: engineering, locationId: mumbai, managerEmployeeId, onboardingTemplateId: null,
      }), 201);
      people[who]!.employeeId = body.employee.id;
    };
    await hire('manager', 'Manu', 'Manager', '2024-01-01');
    await hire('asha', 'Asha', 'Rao', '2025-01-01', people.manager.employeeId);
    await hire('bala', 'Bala', 'Iyer', '2026-09-16', people.manager.employeeId);
    // Someone without a salary is left out of the run with a warning.
    ok(await as('hr').post('/employees').send({ legalEntityId: t.legalEntityId, firstName: 'Cleo', lastName: 'NoSalary', dateOfJoining: '2025-06-01', probationMonths: 0, departmentId: engineering, onboardingTemplateId: null }), 201);
    for (const who of ['manager', 'asha', 'bala']) tokens[who] = (await login(app, people[who]!.email)).accessToken;

    // Asha's September: present every working day except an absence on the 8th, a half day on the 9th and a day of unpaid leave on the 15th.
    for (let d = 1; d <= 30; d++) {
      const date = `${MONTH}-${String(d).padStart(2, '0')}`;
      const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
      if (dow === 0 || dow === 6 || d === 8 || d === 15) continue;
      await punch(people.asha.employeeId!, date, '09:00', 'in');
      await punch(people.asha.employeeId!, date, d === 9 ? '14:30' : '18:00', 'out');
    }
    const lwp = (await pool.insert('leave_types', { tenant_id: t.id, code: 'LWP', name: 'Leave without pay', paid: false })).id;
    await pool.insert('leave_requests', { tenant_id: t.id, employee_id: people.asha.employeeId, leave_type_id: lwp, start_date: '2026-09-15', end_date: '2026-09-15', days: 1, status: 'approved' });
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('access', () => {
    it('is part of the Business plan', async () => {
      const starter = await createTenant(pool, { plan: 'starter' });
      const owner = (await loginWithMfa(app, pool, starter.ownerEmail)).accessToken;
      expect((await api(app, owner).get('/payroll/runs')).status).toBe(402);
      expect((await api(app, owner).get('/expenses/claims')).status).toBe(402);
    });

    it('needs MFA and a payroll role', async () => {
      const res = await as('payrollNoMfa').get('/payroll/runs');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('mfa_required');
      expect((await as('asha').get('/payroll/runs')).status).toBe(403);
      expect((await as('hr').get('/payroll/salaries')).status).toBe(403); // HR administers people, not pay
      expect((await as('finance').post('/payroll/runs').send({ legalEntityId: t.legalEntityId, month: MONTH, payDate: '2026-09-30' })).status).toBe(403);
    });
  });

  describe('settings', () => {
    it('offers India starting values but stores nothing until an admin reviews and saves them', async () => {
      const s = ok(await as('payroll').get('/payroll/statutory'));
      expect(s.settings).toEqual([]);
      expect(s.startingValues.notice).toMatch(/does not certify/);
      starting = s.startingValues.settings;
      const bad = structuredClone(starting) as any;
      bad.tds.slabs = [{ upTo: '800000', ratePercent: '5' }, { upTo: '400000', ratePercent: '0' }, { upTo: null, ratePercent: '30' }];
      expect((await as('payroll').post('/payroll/statutory').send({ legalEntityId: t.legalEntityId, effectiveFrom: '2026-04-01', settings: bad })).status).toBe(400);
      expect((await as('payroll').post('/payroll/statutory').send({ legalEntityId: t.legalEntityId, effectiveFrom: '2026-04-01', settings: { pf: {} } })).status).toBe(422);
    });

    it('has default components and a structure, and validates new ones', async () => {
      const comps = ok(await as('payroll').get('/payroll/components')) as unknown as { code: string; isBasic: boolean }[];
      expect(comps.map((c) => c.code)).toEqual(expect.arrayContaining(['BASIC', 'HRA', 'SPECIAL']));
      const structures = ok(await as('payroll').get('/payroll/structures')) as unknown as { name: string; lines: { code: string }[] }[];
      expect(structures[0]!.name).toBe('Standard');
      ok(await as('payroll').post('/payroll/components').send({ code: 'lta', name: 'Leave travel allowance', kind: 'earning' }), 201);
      expect((await as('payroll').post('/payroll/components').send({ code: 'LTA', name: 'Again', kind: 'earning' })).status).toBe(409);
      const hra = (ok(await as('payroll').get('/payroll/components')) as unknown as { id: string; code: string }[]).find((c) => c.code === 'HRA')!;
      const noBasic = await as('payroll').post('/payroll/structures').send({ name: 'Broken', lines: [{ componentId: hra.id, calc: 'balance' }] });
      expect(noBasic.status).toBe(400);
      expect(noBasic.body.error.code).toBe('basic_required');
      expect((await as('hr').post('/payroll/components').send({ code: 'X1', name: 'Nope', kind: 'earning' })).status).toBe(403);
    });
  });

  describe('salaries', () => {
    let structureId: string;
    beforeAll(async () => {
      structureId = ((ok(await as('payroll').get('/payroll/structures')) as unknown as { id: string; name: string }[]).find((s) => s.name === 'Standard'))!.id;
    });

    it('previews and assigns a salary from a CTC, with employer PF inside the CTC', async () => {
      const p = ok(await as('payroll').post(`/payroll/salaries/${people.asha.employeeId}/preview`).send({ effectiveFrom: '2026-04-01', annualCtc: '600000', structureId }));
      expect(p.components.map((c: { code: string; monthly: string }) => [c.code, c.monthly])).toEqual([['BASIC', '25000.00'], ['HRA', '10000.00'], ['SPECIAL', '13200.00']]);
      expect(p.employerPfMonthly).toBe('1800.00');
      expect(p.warnings[0]).toMatch(/No statutory settings/);
      ok(await as('payroll').post(`/payroll/salaries/${people.asha.employeeId}`).send({ effectiveFrom: '2026-04-01', annualCtc: '600000', structureId }), 201);
      ok(await as('payroll').post(`/payroll/salaries/${people.bala.employeeId}`).send({ effectiveFrom: '2026-09-16', annualCtc: '240000', structureId }), 201);
      const dup = await as('payroll').post(`/payroll/salaries/${people.bala.employeeId}`).send({ effectiveFrom: '2026-09-16', annualCtc: '250000', structureId });
      expect(dup.status).toBe(409);
      const h = ok(await as('payroll').get(`/payroll/salaries/${people.bala.employeeId}`));
      expect(h.revisions[0].lines.map((l: { monthly: string }) => l.monthly)).toEqual(['10000.00', '4000.00', '4800.00']);
      const list = ok(await as('payroll').get('/payroll/salaries')) as unknown as { name: string; annualCtc: string | null }[];
      expect(list.find((r) => r.name === 'Asha Rao')!.annualCtc).toBe('600000.00');
      expect(list.find((r) => r.name === 'Cleo NoSalary')!.annualCtc).toBeNull();
      // The audit trail records the revision without the pay amount.
      const audit = await pool.find('audit_events', { tenant_id: t.id, action: 'employee_salary.assigned' });
      expect(audit.length).toBeGreaterThan(0);
      expect(JSON.stringify(audit.map((a) => [a.changes, a.metadata]))).not.toContain('600000');
    });

    it('refuses a structure that does not fit the CTC', async () => {
      const basic = (ok(await as('payroll').get('/payroll/components')) as unknown as { id: string; code: string }[]).find((c) => c.code === 'BASIC')!;
      const special = (ok(await as('payroll').get('/payroll/components')) as unknown as { id: string; code: string }[]).find((c) => c.code === 'SPECIAL')!;
      const fixed = ok(await as('payroll').post('/payroll/structures').send({ name: 'Fixed basic', lines: [{ componentId: basic.id, calc: 'fixed', value: '300000' }, { componentId: special.id, calc: 'balance' }] }), 201);
      const res = await as('payroll').post(`/payroll/salaries/${people.asha.employeeId}/preview`).send({ effectiveFrom: '2026-04-01', annualCtc: '200000', structureId: fixed.id });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('structure_does_not_fit');
    });
  });

  describe('expenses', () => {
    let travel: string;
    let meals: string;
    beforeAll(async () => {
      const cats = ok(await as('bala').get('/expenses/categories')) as unknown as { id: string; name: string }[];
      travel = cats.find((c) => c.name === 'Travel')!.id;
      meals = cats.find((c) => c.name === 'Meals')!.id;
    });
    const claim = (who: string, fields: Record<string, string>, file: Buffer | null = PNG, type = 'image/png') => {
      let r = request(app.getHttpServer()).post('/api/v1/expenses/claims').set('authorization', `Bearer ${tokens[who]}`);
      for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
      if (file) r = r.attach('receipt', file, { filename: 'receipt.png', contentType: type });
      return r;
    };

    it('checks receipts, limits and dates', async () => {
      expect((await claim('bala', { categoryId: travel, spentOn: '2026-09-20', amount: '1200', description: 'Cab to client site' }, null)).body.error.code).toBe('receipt_required');
      expect((await claim('bala', { categoryId: meals, spentOn: '2026-09-20', amount: '9000', description: 'Team dinner' })).body.error.code).toBe('over_limit');
      expect((await claim('bala', { categoryId: travel, spentOn: '2026-09-20', amount: '1200', description: 'Cab' }, Buffer.from('MZ not a png'))).body.error.code).toBe('content_mismatch');
      expect((await claim('bala', { categoryId: travel, spentOn: '2099-01-01', amount: '1200', description: 'Cab to client site' })).body.error.code).toBe('future_date');
      expect((await claim('bala', { categoryId: travel, spentOn: '2026-09-20', amount: '-5', description: 'Cab to client site' })).status).toBe(422);
    });

    it('goes to the manager, who approves it; colleagues cannot see it', async () => {
      claimId = ok(await claim('bala', { categoryId: travel, spentOn: '2026-09-20', amount: '1200.50', description: 'Cab to client site' }), 201).id;
      expect((await as('asha').get(`/expenses/claims/${claimId}`)).status).toBe(404);
      expect((await as('asha').post(`/expenses/claims/${claimId}/receipt-link`)).status).toBe(404);
      const pending = ok(await as('manager').get('/expenses/claims?view=approvals')) as unknown as { id: string }[];
      expect(pending.map((c) => c.id)).toContain(claimId);
      const link = ok(await as('manager').post(`/expenses/claims/${claimId}/receipt-link`));
      const file = await request(app.getHttpServer()).get(link.path);
      expect(file.status).toBe(200);
      expect(file.headers['content-type']).toBe('image/png');
      expect((await request(app.getHttpServer()).get(link.path.replace(/sig=[^&]+/, 'sig=forgedforgedforged'))).status).toBe(404);
      expect(await approveAll('manager', 'expense_claim')).toBe(1);
      expect(ok(await as('bala').get(`/expenses/claims/${claimId}`)).status).toBe('approved');
      // A second claim is withdrawn by its owner.
      const second = ok(await claim('bala', { categoryId: travel, spentOn: '2026-09-21', amount: '300', description: 'Metro card top-up' }), 201).id;
      expect((await as('manager').post(`/expenses/claims/${second}/cancel`)).status).toBe(403);
      expect(ok(await as('bala').post(`/expenses/claims/${second}/cancel`)).status).toBe('cancelled');
    });
  });

  describe('a payroll run', () => {
    it('cannot compute before statutory settings are saved', async () => {
      runId = ok(await as('payroll').post('/payroll/runs').send({ legalEntityId: t.legalEntityId, month: MONTH, payDate: '2026-09-30' }), 201).id;
      expect((await as('payroll').post('/payroll/runs').send({ legalEntityId: t.legalEntityId, month: MONTH, payDate: '2026-09-30' })).status).toBe(409);
      const res = await as('payroll').post(`/payroll/runs/${runId}/compute`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('statutory_missing');
      ok(await as('payroll').post('/payroll/statutory').send({ legalEntityId: t.legalEntityId, effectiveFrom: '2026-04-01', lopSource: 'attendance_and_leave', settings: starting }), 201);
    });

    it('computes pay from salary, attendance, unpaid leave and approved expenses, explaining every line', async () => {
      const result = ok(await as('payroll').post(`/payroll/runs/${runId}/compute`));
      expect(result).toMatchObject({ employees: 2, included: 2 });
      const run = ok(await as('payroll').get(`/payroll/runs/${runId}`));
      expect(run.status).toBe('computed');
      expect(run.warnings.join('\n')).toMatch(/Cleo NoSalary has no salary/);
      expect(run.warnings.join('\n')).toMatch(/Bala Iyer: No attendance was recorded/);

      const asha = run.items.find((i: { name: string }) => i.name === 'Asha Rao');
      expect(asha).toMatchObject({ lopDays: '2.50', paidDays: '27.50', gross: '44183.34', deductions: '2000.00', net: '42183.34' });
      const detail = ok(await as('payroll').get(`/payroll/runs/${runId}/items/${asha.id}`));
      const line = (code: string) => detail.lines.find((l: { code: string }) => l.code === code);
      expect(line('BASIC')).toMatchObject({ amount: '22916.67', explanation: 'INR 25,000.00 x 27.5 / 30 days' });
      expect(line('PF_EE')).toMatchObject({ amount: '1800.00' });
      expect(line('PT')).toMatchObject({ amount: '200.00' });
      expect(line('ESI_EE')).toBeUndefined();
      expect(line('TDS')).toBeUndefined();
      expect(detail.explanation.join(' ')).toMatch(/1 day\(s\) of approved unpaid leave.*1 day\(s\) absent.*0.5 day\(s\) lost to half days/);

      const bala = run.items.find((i: { name: string }) => i.name === 'Bala Iyer');
      // Joined on the 16th: 15 of 30 days. ESI applies below the ceiling (rounded up), Maharashtra PT 175, the approved cab claim is reimbursed.
      expect(bala).toMatchObject({ employedDays: 15, lopDays: '0.00', paidDays: '15.00', gross: '9400.00', deductions: '846.00', reimbursements: '1200.50', net: '9754.50' });
      expect(run).toMatchObject({ employeeCount: 2, gross: '53583.34', net: '51937.84' });
      expect((await pool.one('expense_claims', { id: claimId }))!.payroll_run_id).toBe(runId);
    });

    it('applies adjustments and loss-of-pay overrides with a reason, then recomputes', async () => {
      const adj = ok(await as('payroll').post(`/payroll/runs/${runId}/adjustments`).send({ employeeId: people.asha.employeeId, kind: 'earning', label: 'Spot award', amount: '1000', reason: 'Q2 release' }), 201);
      let run = ok(await as('payroll').get(`/payroll/runs/${runId}`));
      expect(run.items.find((i: { name: string }) => i.name === 'Asha Rao').net).toBe('43183.34');
      const bala = run.items.find((i: { name: string }) => i.name === 'Bala Iyer');
      expect((await as('payroll').patch(`/payroll/runs/${runId}/items/${bala.id}`).send({ lopDays: '1' })).status).toBe(422);
      expect((await as('payroll').patch(`/payroll/runs/${runId}/items/${bala.id}`).send({ lopDays: '1.25', reason: 'x'.repeat(5) })).status).toBe(422);
      const o = ok(await as('payroll').patch(`/payroll/runs/${runId}/items/${bala.id}`).send({ lopDays: '1', reason: 'Absent on 17th, attendance not used yet' }));
      run = ok(await as('payroll').get(`/payroll/runs/${runId}`));
      expect(run.items.find((i: { name: string }) => i.name === 'Bala Iyer')).toMatchObject({ lopDays: '0.00', lopOverride: '1.00', paidDays: '14.00' });
      const item = ok(await as('payroll').get(`/payroll/runs/${runId}/items/${o.id}`));
      expect(item.explanation.join(' ')).toMatch(/set by hand to 1 \(calculated 0\): Absent on 17th/);
      ok(await as('payroll').patch(`/payroll/runs/${runId}/items/${o.id}`).send({ lopDays: null, reason: 'Back to calculated' }));
      expect((await as('payroll').delete(`/payroll/runs/${runId}/adjustments/${adj.id}`)).status).toBe(204);
      run = ok(await as('payroll').get(`/payroll/runs/${runId}`));
      expect(run.net).toBe('51937.84');
    });

    it('is approved by someone other than the preparer, then frozen', async () => {
      ok(await as('payroll').post(`/payroll/runs/${runId}/submit`));
      expect((await as('payroll').post(`/payroll/runs/${runId}/compute`)).status).toBe(409);
      expect(await approveAll('payroll', 'payroll_run')).toBe(0);
      expect(await approveAll('finance', 'payroll_run')).toBe(1);
      const run = ok(await as('payroll').get(`/payroll/runs/${runId}`));
      expect(run.status).toBe('finalised');
      expect(run.can.exportBankFile).toBe(true);

      // Frozen in the database, not just in the API.
      await expect(pool.update('payroll_items', { run_id: runId }, { $set: { net: '1' } })).rejects.toThrow(/finalised payroll run cannot be changed/);
      await expect(pool.update('payroll_runs', { id: runId }, { $set: { net: '1' } })).rejects.toThrow(/finalised/);
      await expect(pool.insert('payroll_adjustments', { tenant_id: t.id, run_id: runId, employee_id: people.asha.employeeId, kind: 'earning', label: 'Late', amount: '1', reason: 'x' })).rejects.toThrow(/finalised/);
      expect((await as('payroll').post(`/payroll/runs/${runId}/cancel`).send({ reason: 'Too late now' })).status).toBe(409);
      // Attendance for the month is locked, the claim is paid, and payslips were announced.
      expect(await pool.count('attendance_periods', { tenant_id: t.id, period_start: '2026-09-01', period_end: '2026-09-30', unlocked_at: null })).toBe(1);
      expect((await pool.one('expense_claims', { id: claimId }))!.status).toBe('paid');
      const notes = await pool.find('notifications', { tenant_id: t.id, kind: 'payslip.published', membership_id: people.asha.membershipId });
      expect(notes[0]!.title).toBe('Your payslip for September 2026 is ready');
    });

    it('carries this year’s pay and tax into the next month', async () => {
      const structureId = (ok(await as('payroll').get('/payroll/structures')) as unknown as { id: string; name: string }[]).find((s) => s.name === 'Standard')!.id;
      ok(await as('payroll').post(`/payroll/salaries/${people.asha.employeeId}`).send({ effectiveFrom: '2026-10-01', annualCtc: '3600000', structureId }), 201);
      const oct = ok(await as('payroll').post('/payroll/runs').send({ legalEntityId: t.legalEntityId, month: '2026-10', payDate: '2026-10-31' }), 201).id;
      ok(await as('payroll').post(`/payroll/runs/${oct}/compute`));
      const run = ok(await as('payroll').get(`/payroll/runs/${oct}`));
      const asha = run.items.find((i: { name: string }) => i.name === 'Asha Rao');
      const item = ok(await as('payroll').get(`/payroll/runs/${oct}/items/${asha.id}`));
      expect(item.inputs.ytd.taxable).toBe('44183.34');
      expect(Number(item.tds)).toBeGreaterThan(0);
      expect(item.explanation.join(' ')).toMatch(/Projected taxable pay this financial year/);
      ok(await as('payroll').post(`/payroll/runs/${oct}/cancel`).send({ reason: 'Test run only' }));
    });
  });

  describe('payslips and exports', () => {
    it('shows people their own payslips only', async () => {
      const mine = ok(await as('asha').get('/payslips?mine=true')) as unknown as { id: string; month: string; net: string }[];
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ month: MONTH, net: '42183.34' });
      const slip = ok(await as('asha').get(`/payslips/${mine[0]!.id}`));
      expect(slip).toMatchObject({ name: 'Asha Rao', paidDays: '27.50', lopDays: '2.50', yearToDate: { financialYearFrom: '2026-04-01', gross: '44183.34' } });
      const bala = (ok(await as('payroll').get('/payslips')) as unknown as { id: string; name: string }[]).find((p) => p.name === 'Bala Iyer')!;
      expect((await as('asha').get(`/payslips/${bala.id}`)).status).toBe(404);
      expect(ok(await as('asha').get('/payslips')) as unknown as unknown[]).toHaveLength(1);
      expect((await as('manager').get(`/payslips/${mine[0]!.id}`)).status).toBe(404);
      ok(await as('payroll').get(`/payslips/${bala.id}`));
      expect(await pool.count('audit_events', { tenant_id: t.id, action: 'payslip.viewed' })).toBe(1);
    });

    it('exports the register and an audited bank file with decrypted accounts', async () => {
      const reg = await as('payroll').get(`/payroll/runs/${runId}/register.csv`);
      expect(reg.status).toBe(200);
      expect(reg.headers['content-type']).toMatch(/text\/csv/);
      expect(reg.text.split('\r\n')[0]).toMatch(/^Employee code,Name,Status,Paid days,Loss-of-pay days,Basic,/);
      expect(reg.text).toContain('Asha Rao');
      ok(await as('hr').put(`/employees/${people.asha.employeeId}/sensitive`).send({ bankName: 'Demo Bank', bankAccount: '123456789012', bankRouting: 'DEMO0001234' }));
      expect((await as('finance').get(`/payroll/runs/${runId}/bank-file.csv`)).status).toBe(403);
      const bank = await as('payroll').get(`/payroll/runs/${runId}/bank-file.csv`);
      expect(bank.status).toBe(200);
      expect(bank.text).toContain('123456789012');
      expect(bank.text).toContain('MISSING'); // Bala has no bank details yet
      expect(bank.headers['x-missing-bank-details']).toBe('1');
      const audit = await pool.find('audit_events', { tenant_id: t.id, action: 'payroll_run.bank_file_exported' });
      expect(audit[0]!.metadata.rows).toBe(2);
      expect(JSON.stringify(audit)).not.toContain('123456789012');
    });
  });

  describe('isolation', () => {
    it('keeps every Phase 5 record inside its workspace', async () => {
      const tables = ['pay_components', 'salary_structures', 'salary_structure_lines', 'employee_salaries', 'employee_salary_lines', 'statutory_settings',
        'payroll_runs', 'payroll_items', 'payroll_adjustments', 'expense_categories', 'expense_claims'];
      for (const table of tables) {
        const ids = (await pool.find(table, { tenant_id: t.id })).map((x) => x.id);
        expect(await pool.tenant(other.id, (tx) => tx.collection(table).count({ id: { $in: ids } })), table).toBe(0);
      }
      await expect(pool.tenant(other.id, (tx) => tx.collection('expense_categories').insert({ tenant_id: t.id, name: 'Injected' }))).rejects.toThrow();
      const otherOwner = (await loginWithMfa(app, pool, other.ownerEmail)).accessToken;
      expect((await api(app, otherOwner).get(`/payroll/runs/${runId}`)).status).toBe(404);
      expect((await api(app, otherOwner).get(`/expenses/claims/${claimId}`)).status).toBe(404);
      expect((await api(app, otherOwner).get(`/payroll/salaries/${people.asha.employeeId}`)).status).toBe(404);
      expect(ok(await api(app, otherOwner).get('/payslips')) as unknown as unknown[]).toHaveLength(0);
    });
  });
});
