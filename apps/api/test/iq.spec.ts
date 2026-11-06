import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, adminPool, api, createApp, createTenant, department, loginWithMfa, type TestTenant } from './helpers';

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** SampCrew IQ: answers from the workspace under the asker's permissions; actions only open prefilled forms. */
describe('SampCrew IQ', () => {
  let app: INestApplication;
  let pool: Pool;
  let t: TestTenant;
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const ask = async (who: string, question: string) => {
    const r = await api(app, tokens[who]).post('/iq/ask').send({ question });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body;
  };

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    const ops = await department(pool, t, 'Operations');
    const sales = await department(pool, t, 'Sales');
    const people = {
      hr: await addMember(pool, t, { roles: ['hr_admin'], name: 'Hana HR' }),
      recruiter: await addMember(pool, t, { roles: ['recruiter'], name: 'Rita Recruiter' }),
      payroll: await addMember(pool, t, { roles: ['payroll_admin'], name: 'Pat Payroll' }),
      olu: await addMember(pool, t, { departmentId: ops, name: 'Olu Operator' }),
    };
    for (const [k, p] of Object.entries(people)) tokens[k] = (await loginWithMfa(app, pool, p.email)).accessToken;
    const hire = async (body: Record<string, unknown>) => {
      const res = await api(app, tokens.hr).post('/employees').send({ legalEntityId: t.legalEntityId, probationMonths: 0, ...body });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body.employee.id as string;
    };
    ids.olu = await hire({ firstName: 'Olu', lastName: 'Operator', departmentId: ops, dateOfJoining: '2022-06-01', membershipId: people.olu.membershipId });
    ids.ada = await hire({ firstName: 'Ada', lastName: 'Ops', departmentId: ops, dateOfJoining: day(-20) });
    ids.sal = await hire({ firstName: 'Sal', lastName: 'Seller', departmentId: sales, dateOfJoining: '2023-02-01' });
    // Overtime: Operations doubled theirs in the last 30 days; Sales did less.
    const ot = async (emp: string, n: number, minutes: number) => pool.query(
      `insert into attendance_days (tenant_id, employee_id, work_date, day_type, status, worked_minutes, overtime_minutes, engine_version) values ($1, $2, $3, 'working', 'present', 540, $4, 1)`,
      [t.id, emp, day(n), minutes],
    );
    await ot(ids.olu!, -40, 60); await ot(ids.olu!, -10, 60); await ot(ids.olu!, -5, 60);
    await ot(ids.sal!, -45, 120); await ot(ids.sal!, -3, 30);
    const lt = await pool.query<{ id: string }>(`insert into leave_types (tenant_id, code, name) values ($1, 'IQTEST', 'Casual leave') returning id`, [t.id]);
    await pool.query(
      `insert into leave_requests (tenant_id, employee_id, leave_type_id, start_date, end_date, days, status) values ($1, $2, $3, current_date, current_date, 1, 'approved')`,
      [t.id, ids.sal, lt.rows[0]!.id],
    );
    await pool.query(`insert into helpdesk_articles (tenant_id, title, body) values ($1, 'Sick leave policy', 'Everyone gets twelve days of sick leave a year. Tell your manager on the first morning.')`, [t.id]);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('counts headcount by department, only among the people the asker can see', async () => {
    const hr = await ask('hr', 'Headcount by department');
    expect(hr).toMatchObject({ intent: 'headcount', confidence: 'exact', title: '3 people across 2 departments' });
    expect(hr.table.rows).toEqual([['Operations', 2, 1], ['Sales', 1, 0]]);
    expect(hr.how).toContain('Matched “headcount” to headcount.');
    expect(hr.sources[0]).toEqual({ label: 'Employees', href: '/employees' });
    // An employee's access covers only themselves.
    expect((await ask('olu', 'How many employees do we have')).title).toBe('1 person across 1 department');
  });

  it('finds departments with rising overtime from attendance', async () => {
    const r = await ask('hr', 'Show departments with increasing overtime.');
    expect(r).toMatchObject({ intent: 'overtime', title: '1 department with rising overtime' });
    expect(r.table.rows[0]).toEqual(['Operations', '1.0 h', '2.0 h', 'up 1.0 h']);
    expect(r.table.rows[1]).toEqual(['Sales', '2.0 h', '0.5 h', 'down 1.5 h']);
  });

  it('lists who is on leave and refuses areas outside the asker’s role', async () => {
    const r = await ask('hr', 'Who is on leave today?');
    expect(r.title).toBe('1 person on leave today');
    expect(r.table.rows[0].slice(0, 2)).toEqual(['Sal Seller', 'Casual leave']);
    // Olu can only see their own leave, and has none.
    expect((await ask('olu', 'Who is on leave today?')).title).toBe('Nobody you can see is on leave today');
    const refused = await ask('olu', 'Summarize recruitment performance this quarter');
    expect(refused).toMatchObject({ title: 'Not available to you', confidence: 'exact' });
    expect(await ask('olu', 'Create a staffing proposal for five recruiters')).toMatchObject({ title: 'Not available to you' });
  });

  it('opens prefilled forms for actions and changes nothing', async () => {
    const before = (await pool.query(`select count(*)::int as n from staffing_bids where tenant_id = $1`, [t.id])).rows[0].n;
    const bid = await ask('recruiter', 'Create a staffing proposal for five recruiters');
    expect(bid).toMatchObject({ intent: 'draft_bid', confidence: 'exact' });
    expect(bid.action.href).toBe('/staffing/bids/new?mode=quick&people=5&role=Recruiter');
    expect(bid.action.preview).toEqual(expect.arrayContaining([{ label: 'Role', value: 'Recruiter' }, { label: 'People', value: '5' }]));
    expect((await pool.query(`select count(*)::int as n from staffing_bids where tenant_id = $1`, [t.id])).rows[0].n).toBe(before);
    const job = await ask('recruiter', 'Prepare a draft job description for a Senior HR Manager.');
    const href = new URL(job.action.href, 'http://x');
    expect(href.pathname).toBe('/recruitment');
    expect(href.searchParams.get('create')).toBe('requisition');
    expect(href.searchParams.get('title')).toBe('Senior HR Manager');
    expect(href.searchParams.get('description')).toContain('is looking for a Senior HR Manager');
  });

  it('answers policy questions from help articles, and says when it does not understand', async () => {
    const p = await ask('olu', 'How many days of sick leave do I get?');
    expect(p).toMatchObject({ intent: 'policy', confidence: 'matched' });
    expect(p.sources[0].label).toBe('Sick leave policy');
    expect(p.sources[0].href).toMatch(/^\/helpdesk\?article=[0-9a-f-]{36}$/);
    const u = await ask('olu', 'bananas');
    expect(u).toMatchObject({ intent: 'unknown', confidence: 'low' });
    expect(u.suggestions.length).toBeGreaterThan(3);
    expect((await api(app, tokens.olu).post('/iq/ask').send({ question: '' })).status).toBe(422);
    expect((await api(app).post('/iq/ask').send({ question: 'headcount' })).status).toBe(401);
  });

  it('summarizes recruitment for the jobs the asker can see', async () => {
    const r = await ask('recruiter', 'Summarize recruitment performance this quarter');
    expect(r).toMatchObject({ intent: 'recruitment_summary', confidence: 'exact', title: expect.stringMatching(/^Recruitment this quarter \(Q[1-4] \d{4}\)$/) });
    expect(r.summary).toMatch(/^0 applied, 0 hired and 0 rejected this quarter/);
    expect(r.sources[0]).toEqual({ label: 'Recruitment', href: '/recruitment' });
  });

  it('shows the approvals waiting for the asker', async () => {
    expect(await ask('hr', 'What is waiting for my approval?')).toMatchObject({ intent: 'approvals', title: 'Nothing is waiting for your approval' });
  });

  describe('more subjects', () => {
    beforeAll(async () => {
      // A leaver this year, someone whose probation ends soon, an anniversary this month, an absence today, a goal at risk.
      const today = new Date();
      const thisMonth = (d: number) => new Date(Date.UTC(today.getUTCFullYear() - 3, today.getUTCMonth(), d)).toISOString().slice(0, 10);
      const lw = new Date(Date.UTC(today.getUTCFullYear(), 0, 2)).toISOString().slice(0, 10);
      await pool.query(`insert into employees (tenant_id, employee_code, first_name, last_name, date_of_joining, status, last_working_day, exit_reason, current_department_id, current_legal_entity_id)
                        values ($1, 'IQ-L1', 'Lee', 'Leaver', '2020-01-06', 'exited', $2, 'Moved city', (select current_department_id from employees where id = $3), $4)`, [t.id, lw, ids.olu, t.legalEntityId]);
      await pool.query(`update employees set status = 'probation', probation_end_date = current_date + 5 where id = $1`, [ids.ada]);
      await pool.query(`update employees set date_of_joining = $2 where id = $1`, [ids.sal, thisMonth(Math.min(28, today.getUTCDate()))]);
      await pool.query(`insert into attendance_days (tenant_id, employee_id, work_date, day_type, status, worked_minutes, engine_version) values ($1, $2, current_date, 'working', 'absent', 0, 1)`, [t.id, ids.olu]);
      await pool.query(`insert into goals (tenant_id, employee_id, title, period_start, period_end, status, progress, confidence) values ($1, $2, 'Halve scrap on line 3', current_date - 30, current_date + 60, 'active', 20, 'at_risk')`, [t.id, ids.olu]);
      await pool.query(`insert into payroll_runs (tenant_id, legal_entity_id, period_start, period_end, pay_date, currency, status, employee_count, gross, net, employer_contributions)
                        values ($1, $2, '2026-09-01', '2026-09-30', '2026-09-30', 'INR', 'finalised', 3, 300000, 250000, 20000),
                               ($1, $2, '2026-10-01', '2026-10-31', '2026-10-31', 'INR', 'pending_approval', 3, 330000, 275000, 22000)`, [t.id, t.legalEntityId]);
    });

    it('answers leavers, probation, anniversaries, absences and goals from records', async () => {
      const left = await ask('hr', 'Who left this year?');
      expect(left).toMatchObject({ intent: 'attrition', confidence: 'exact', title: expect.stringMatching(/^1 person left in \d{4}$/) });
      expect(left.table.rows[0].slice(0, 2)).toEqual(['Lee Leaver', 'Operations']);
      expect((await ask('hr', 'Whose probation ends this month?')).items).toEqual([expect.objectContaining({ label: 'Ada Ops', href: `/employees/${ids.ada}` })]);
      expect((await ask('hr', 'Work anniversaries this month')).items).toEqual([expect.objectContaining({ label: 'Sal Seller', detail: expect.stringMatching(/^3 years on /) })]);
      expect((await ask('hr', 'Who is absent or late today?')).title).toBe('1 absent, 0 late, 0 missing a punch today');
      const goals = await ask('hr', 'Goals at risk');
      expect(goals.title).toBe('1 goal at risk or off track of 1 active');
      // Olu sees only their own records: their own absence, and no leavers.
      expect((await ask('olu', 'Who left this year?')).title).toMatch(/^Nobody you can see left/);
    });

    it('shows payroll totals only to people with payroll access', async () => {
      const p = await ask('payroll', 'What did the last payroll cost?');
      expect(p).toMatchObject({ intent: 'payroll_summary', title: '1 Oct to 31 Oct: ₹2,75,000 net' });
      expect(p.summary).toContain('Net pay is up 10% on the run before.');
      expect((await ask('hr', 'What did the last payroll cost?')).title).toBe('Not available to you');
    });

    it('narrows to a department named in the question', async () => {
      expect((await ask('hr', 'Headcount in Sales')).title).toBe('1 person in Sales');
      expect((await ask('hr', 'Who is absent or late today in Sales?')).title).toBe('Nobody absent or late so far today in Sales');
    });
  });

  describe('conversations', () => {
    it('keeps the asker’s questions, continues the subject for follow-ups, and lets them delete it', async () => {
      const first = await ask('hr', 'Headcount by department');
      expect(first.conversationId).toMatch(/^[0-9a-f-]{36}$/);
      const follow = (await api(app, tokens.hr).post('/iq/ask').send({ question: 'What about Sales?', conversationId: first.conversationId })).body;
      expect(follow).toMatchObject({ intent: 'headcount', title: '1 person in Sales', conversationId: first.conversationId });
      expect(follow.how).toMatch(/^Read as a follow-up to “Headcount by department”\./);
      const list = (await api(app, tokens.hr).get('/iq/conversations')).body;
      expect(list[0]).toMatchObject({ id: first.conversationId, title: 'Headcount by department', questions: 2 });
      const conv = (await api(app, tokens.hr).get(`/iq/conversations/${first.conversationId}`)).body;
      expect(conv.messages.map((m: { question: string }) => m.question)).toEqual(['Headcount by department', 'What about Sales?']);
      expect(conv.messages[1].answer.title).toBe('1 person in Sales');
      // Nobody else can read or continue it.
      expect((await api(app, tokens.olu).get(`/iq/conversations/${first.conversationId}`)).status).toBe(404);
      expect((await api(app, tokens.olu).post('/iq/ask').send({ question: 'and today?', conversationId: first.conversationId })).status).toBe(404);
      expect((await api(app, tokens.olu).get('/iq/conversations')).body.every((c: { id: string }) => c.id !== first.conversationId)).toBe(true);
      expect((await api(app, tokens.hr).delete(`/iq/conversations/${first.conversationId}`)).status).toBe(200);
      expect((await api(app, tokens.hr).get(`/iq/conversations/${first.conversationId}`)).status).toBe(404);
      expect((await pool.query(`select count(*)::int as n from iq_messages where conversation_id = $1`, [first.conversationId])).rows[0].n).toBe(0);
    });
  });
});
