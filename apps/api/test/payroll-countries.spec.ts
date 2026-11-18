import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, adminPool, api, createApp, createTenant, department, login, loginWithMfa, type TestDb, type TestTenant } from './helpers';

/**
 * Statutory settings outside India through the HTTP API: each legal entity gets its own country's scheme
 * (a ready-made pack such as the UK's, or a custom scheme for any other country), and payroll runs, tax years
 * and payslips follow it. India behaviour is covered by payroll.spec.ts.
 */
describe('payroll in other countries', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let ukId: string;
  let deId: string;
  let structureId: string;
  const people: Record<string, { email: string; membershipId: string; employeeId?: string }> = {};
  const tokens: Record<string, string> = {};
  const as = (who: string) => api(app, tokens[who]);
  const ok = (res: { status: number; body: unknown }, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as Record<string, any>;
  };
  const approveAll = async (who: string) => {
    const inbox = ok(await as(who).get('/approvals/inbox')) as unknown as { id: string; resourceType: string }[];
    for (const i of inbox.filter((x) => x.resourceType === 'payroll_run')) ok(await as(who).post(`/approvals/${i.id}/approve`).send({}));
  };
  const entityStart = async (id: string) => (ok(await as('payroll').get('/payroll/statutory')).entities as { legalEntityId: string; countryCode: string; pack: { country: string } | null; settings: any; notice: string }[]).find((e) => e.legalEntityId === id)!;

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    ukId = (await pool.insert('legal_entities', { tenant_id: t.id, name: 'Acme UK', legal_name: 'Acme UK Ltd', country_code: 'GB', currency: 'GBP', timezone: 'Europe/London', fiscal_year_start_month: 4 })).id;
    deId = (await pool.insert('legal_entities', { tenant_id: t.id, name: 'Acme GmbH', legal_name: 'Acme GmbH', country_code: 'DE', currency: 'EUR', timezone: 'Europe/Berlin', fiscal_year_start_month: 1 })).id;
    const london = (await pool.insert('locations', { tenant_id: t.id, legal_entity_id: ukId, name: 'London office', timezone: 'Europe/London', city: 'London', region: 'England', country_code: 'GB' })).id;
    const berlin = (await pool.insert('locations', { tenant_id: t.id, legal_entity_id: deId, name: 'Berlin office', timezone: 'Europe/Berlin', city: 'Berlin', region: 'Berlin', country_code: 'DE' })).id;
    const ops = await department(pool, t, 'Operations');
    people.hr = await addMember(pool, t, { roles: ['hr_admin'], name: 'Hana HR' });
    people.payroll = await addMember(pool, t, { roles: ['payroll_admin'], name: 'Pat Payroll' });
    people.finance = await addMember(pool, t, { roles: ['finance_manager'], name: 'Fin Finance' });
    people.olivia = await addMember(pool, t, { departmentId: ops, name: 'Olivia Smith' });
    people.jonas = await addMember(pool, t, { departmentId: ops, name: 'Jonas Weber' });
    tokens.hr = (await loginWithMfa(app, pool, people.hr.email)).accessToken;
    tokens.payroll = (await loginWithMfa(app, pool, people.payroll.email)).accessToken;
    tokens.finance = (await loginWithMfa(app, pool, people.finance.email)).accessToken;
    const hire = async (who: string, first: string, last: string, legalEntityId: string, locationId: string) => {
      const body = ok(await as('hr').post('/employees').send({
        legalEntityId, firstName: first, lastName: last, dateOfJoining: '2025-01-01', probationMonths: 0, membershipId: people[who]!.membershipId, departmentId: ops, locationId, onboardingTemplateId: null,
      }), 201);
      people[who]!.employeeId = body.employee.id;
    };
    await hire('olivia', 'Olivia', 'Smith', ukId, london);
    await hire('jonas', 'Jonas', 'Weber', deId, berlin);
    tokens.olivia = (await login(app, people.olivia.email)).accessToken;
    structureId = (ok(await as('payroll').get('/payroll/structures')) as unknown as { id: string; name: string }[]).find((s) => s.name === 'Standard')!.id;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('starting values', () => {
    it('come from each legal entity’s country, with a notice to have them checked', async () => {
      const s = ok(await as('payroll').get('/payroll/statutory'));
      expect(s.packs.map((p: { countryCode: string }) => p.countryCode)).toEqual(expect.arrayContaining(['IN', 'GB', 'US', 'AE', 'SA', 'SG', 'AU']));
      const india = s.entities.find((e: { legalEntityId: string }) => e.legalEntityId === t.legalEntityId);
      expect(india.countryCode).toBe('IN');
      expect(india.settings.pf.employeeRatePercent).toBe('12');
      const uk = await entityStart(ukId);
      expect(uk.pack!.country).toBe('United Kingdom');
      expect(uk.settings).toMatchObject({ kind: 'generic', countryCode: 'GB', taxYearStartMonth: 4 });
      expect(uk.notice).toMatch(/local payroll advisor/);
      const de = await entityStart(deId);
      expect(de.pack).toBeNull();
      expect(de.settings).toMatchObject({ kind: 'generic', countryCode: 'DE', taxYearStartMonth: 1, contributions: [] });
      expect(de.notice).toMatch(/no ready-made pack/);
    });

    it('the salary form knows what each switch means in the country', async () => {
      const h = ok(await as('payroll').get(`/payroll/salaries/${people.olivia.employeeId}`));
      expect(h.statutory).toMatchObject({ countryCode: 'GB', saved: false, pf: 'Enrolled in the workplace pension', esi: null, tds: 'Income tax (PAYE)', employerInCtc: false });
    });
  });

  describe('saving', () => {
    it('only accepts the scheme of the entity’s country, with valid rules', async () => {
      const uk = await entityStart(ukId);
      const india = (await entityStart(t.legalEntityId)).settings;
      const save = (legalEntityId: string, settings: unknown) => as('payroll').post('/payroll/statutory').send({ legalEntityId, effectiveFrom: '2026-04-01', lopSource: 'leave_only', settings });
      let res = await save(ukId, india);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('scheme_country');
      expect((await save(t.legalEntityId, uk.settings)).body.error.code).toBe('scheme_country');
      expect((await save(deId, uk.settings)).body.error.code).toBe('scheme_country');
      const twice = structuredClone(uk.settings);
      twice.contributions.push({ ...twice.contributions[0] });
      expect((await save(ukId, twice)).body.error.code).toBe('contribution_code');
      const backwards = structuredClone(uk.settings);
      backwards.contributions[0].ceiling = '500';
      expect((await save(ukId, backwards)).body.error.code).toBe('contribution_range');
      const reserved = structuredClone(uk.settings);
      reserved.contributions[0].code = 'TAX';
      expect((await save(ukId, reserved)).status).toBe(422);
      const open = structuredClone(uk.settings);
      open.incomeTax.slabs = [{ upTo: '12570', ratePercent: '0' }];
      expect((await save(ukId, open)).body.error.code).toBe('open_slab');
      res = await save(ukId, uk.settings);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const saved = ok(await as('payroll').get(`/payroll/statutory?legalEntityId=${ukId}`)).settings;
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ countryCode: 'GB', effectiveFrom: '2026-04-01', settings: { kind: 'generic', countryCode: 'GB' } });
    });

    it('lets a country without a pack define its own contributions and tax', async () => {
      const de = (await entityStart(deId)).settings;
      de.taxYearStartMonth = 1;
      de.contributions = [{ code: 'RV', name: 'Pension insurance', employeeRatePercent: '9.3', employerRatePercent: '9.3', base: 'gross', threshold: null, ceiling: '8450', eligibleFrom: null, appliesTo: 'everyone', reducesTaxablePay: false }];
      de.incomeTax = { name: 'Lohnsteuer', allowance: '0', slabs: [{ upTo: '12000', ratePercent: '0' }, { upTo: null, ratePercent: '25' }], levyPercent: '0', surchargePercent: '0', reviewAbove: null, reviewNote: '' };
      ok(await as('payroll').post('/payroll/statutory').send({ legalEntityId: deId, effectiveFrom: '2026-01-01', lopSource: 'leave_only', settings: de }), 201);
    });
  });

  describe('salaries and a payroll run in the United Kingdom', () => {
    let april: string;

    it('treats the annual amount as gross salary, with employer contributions on top', async () => {
      const p = ok(await as('payroll').post(`/payroll/salaries/${people.olivia.employeeId}/preview`).send({ effectiveFrom: '2026-04-01', annualCtc: '36000', structureId }));
      expect(p.currency).toBe('GBP');
      expect(p.employerInCtc).toBe(false);
      expect(p.components.map((c: { monthly: string }) => c.monthly)).toEqual(['1500.00', '600.00', '900.00']);
      expect(p.employerPfMonthly).toBe('461.85'); // employer NI 387.45 + pension 74.40
      ok(await as('payroll').post(`/payroll/salaries/${people.olivia.employeeId}`).send({ effectiveFrom: '2026-04-01', annualCtc: '36000', structureId, pfEnabled: true, esiEnabled: false, ptEnabled: false, tdsEnabled: true }), 201);
      ok(await as('payroll').post(`/payroll/salaries/${people.jonas.employeeId}`).send({ effectiveFrom: '2026-01-01', annualCtc: '48000', structureId }), 201);
    });

    it('computes PAYE, National Insurance and pension, and is approved and frozen', async () => {
      april = ok(await as('payroll').post('/payroll/runs').send({ legalEntityId: ukId, month: '2026-04', payDate: '2026-04-30' }), 201).id;
      ok(await as('payroll').post(`/payroll/runs/${april}/compute`));
      const run = ok(await as('payroll').get(`/payroll/runs/${april}`));
      expect(run.currency).toBe('GBP');
      expect(run.items).toHaveLength(1);
      const item = ok(await as('payroll').get(`/payroll/runs/${april}/items/${run.items[0].id}`));
      const line = (code: string) => item.lines.find((l: { code: string }) => l.code === code)?.amount;
      expect(line('NI_EE')).toBe('156.16');
      expect(line('NIER_ER')).toBe('387.45');
      expect(line('PENSION_EE')).toBe('124.00');
      expect(line('TAX')).toBe('365.70');
      expect(line('PF_EE')).toBeUndefined();
      expect(item).toMatchObject({ gross: '3000.00', net: '2354.14', employerContributions: '461.85', tds: '365.70', taxable: '2876.00' });
      expect(item.explanation.join(' ')).toMatch(/Projected taxable pay this tax year GBP 34,512.00/);
      ok(await as('payroll').post(`/payroll/runs/${april}/submit`));
      await approveAll('finance');
      expect(ok(await as('payroll').get(`/payroll/runs/${april}`)).status).toBe('finalised');
    });

    it('carries the UK tax year (from April) into May, and onto the payslip', async () => {
      const may = ok(await as('payroll').post('/payroll/runs').send({ legalEntityId: ukId, month: '2026-05', payDate: '2026-05-29' }), 201).id;
      ok(await as('payroll').post(`/payroll/runs/${may}/compute`));
      const run = ok(await as('payroll').get(`/payroll/runs/${may}`));
      const item = ok(await as('payroll').get(`/payroll/runs/${may}/items/${run.items[0].id}`));
      expect(item.inputs.ytd).toMatchObject({ taxable: '2876.00', tds: '365.70' });
      expect(item.tds).toBe('365.70');
      ok(await as('payroll').post(`/payroll/runs/${may}/cancel`).send({ reason: 'Test run only' }));
      const mine = ok(await as('olivia').get('/payslips?mine=true')) as unknown as { id: string }[];
      const slip = ok(await as('olivia').get(`/payslips/${mine[0]!.id}`));
      expect(slip).toMatchObject({ currency: 'GBP', net: '2354.14', incomeTaxName: 'Income tax', countryCode: 'GB', yearToDate: { financialYearFrom: '2026-04-01', tds: '365.70' } });
    });
  });

  describe('a custom scheme', () => {
    it('pays a German employee with the rules the workspace defined', async () => {
      const run = ok(await as('payroll').post('/payroll/runs').send({ legalEntityId: deId, month: '2026-03', payDate: '2026-03-31' }), 201).id;
      ok(await as('payroll').post(`/payroll/runs/${run}/compute`));
      const r = ok(await as('payroll').get(`/payroll/runs/${run}`));
      const item = ok(await as('payroll').get(`/payroll/runs/${run}/items/${r.items[0].id}`));
      const line = (code: string) => item.lines.find((l: { code: string }) => l.code === code)?.amount;
      expect(line('RV_EE')).toBe('372.00');
      expect(line('RV_ER')).toBe('372.00');
      // January tax year, first run in March: 10 months left at 4,000 project to 40,000; 25% above 12,000 = 7,000.
      expect(item.explanation.join(' ')).toMatch(/Lohnsteuer for the year EUR 7,000.00/);
      expect(line('TAX')).toBe('700.00');
      expect(item.net).toBe('2928.00');
    });

    it('stops a run when the entity has moved to another country since the settings were saved', async () => {
      await pool.update('legal_entities', { id: deId }, { $set: { country_code: 'AT' } });
      try {
        const run = ok(await as('payroll').post('/payroll/runs').send({ legalEntityId: deId, month: '2026-04', payDate: '2026-04-30' }), 201).id;
        const res = await as('payroll').post(`/payroll/runs/${run}/compute`);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('statutory_country');
      } finally {
        await pool.update('legal_entities', { id: deId }, { $set: { country_code: 'DE' } });
      }
    });
  });
});
