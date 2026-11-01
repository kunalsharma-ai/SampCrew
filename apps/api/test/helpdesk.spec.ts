import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HelpdeskService } from '../src/modules/helpdesk/helpdesk.service';
import { DatabaseService } from '../src/platform/database/database.service';
import { addMember, adminPool, api, createApp, createTenant, department, login, loginWithMfa, type TestTenant } from './helpers';

/** Phase 7 through the HTTP API: the HR helpdesk and announcements. */
describe('helpdesk and announcements', () => {
  let app: INestApplication;
  let pool: Pool;
  let t: TestTenant;
  let other: TestTenant;
  let ukEntity: string;
  let ops: string;
  let plant: string;
  const people: Record<string, { email: string; membershipId: string; employeeId?: string }> = {};
  const tokens: Record<string, string> = {};
  const as = (who: string) => api(app, tokens[who]);
  const ids: Record<string, string> = {};

  const ok = (res: { status: number; body: unknown }, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as Record<string, any>;
  };
  const fails = (res: { status: number; body: any }, status: number, code?: string) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    if (code) expect(res.body.error.code).toBe(code);
  };
  const unread = async (who: string, kind: string) => {
    const r = await pool.query(`select title from notifications where membership_id = $1 and kind = $2 order by created_at desc`, [people[who]!.membershipId, kind]);
    return r.rows.map((x) => x.title as string);
  };

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    other = await createTenant(pool);
    ukEntity = (await pool.query<{ id: string }>(`insert into legal_entities (tenant_id, name, legal_name, country_code, currency, timezone) values ($1, 'Northwind UK', 'Northwind UK Ltd', 'GB', 'GBP', 'Europe/London') returning id`, [t.id])).rows[0]!.id;
    ops = await department(pool, t, 'Operations');
    const line = await department(pool, t, 'Line 1', ops);
    plant = (await pool.query<{ id: string }>(
      `insert into locations (tenant_id, legal_entity_id, name, kind, timezone, country_code) values ($1, $2, 'Plant', 'factory', 'Asia/Kolkata', 'IN') returning id`, [t.id, t.legalEntityId],
    )).rows[0]!.id;
    people.hr = await addMember(pool, t, { roles: ['hr_admin'], name: 'Hana HR' });
    people.hr2 = await addMember(pool, t, { roles: ['hr_admin'], name: 'Hugo HR' });
    people.ukhr = await addMember(pool, t, { roles: ['hr_manager'], legalEntityId: ukEntity, constraints: { legalEntityIds: [ukEntity] }, name: 'Uma UK HR' });
    people.manager = await addMember(pool, t, { roles: ['department_manager'], departmentId: ops, name: 'Manu Manager' });
    people.asha = await addMember(pool, t, { departmentId: line, managerId: people.manager.membershipId, name: 'Asha' });
    people.bala = await addMember(pool, t, { departmentId: ops, managerId: people.manager.membershipId, name: 'Bala' });
    people.olly = await addMember(pool, t, { legalEntityId: ukEntity, name: 'Olly' });
    tokens.hr = (await loginWithMfa(app, pool, people.hr.email)).accessToken;
    const hire = async (who: string, first: string, extra: Record<string, unknown> = {}) => {
      const body = ok(await as('hr').post('/employees').send({
        legalEntityId: t.legalEntityId, firstName: first, lastName: 'Test', dateOfJoining: '2024-01-01', probationMonths: 0,
        membershipId: people[who]!.membershipId, onboardingTemplateId: null, ...extra,
      }), 201);
      people[who]!.employeeId = body.employee.id;
    };
    await hire('hr', 'Hana');
    await hire('hr2', 'Hugo');
    await hire('ukhr', 'Uma', { legalEntityId: ukEntity });
    await hire('manager', 'Manu', { departmentId: ops });
    await hire('asha', 'Asha', { departmentId: line, managerEmployeeId: people.manager.employeeId, locationId: plant });
    await hire('bala', 'Bala', { departmentId: ops, managerEmployeeId: people.manager.employeeId });
    await hire('olly', 'Olly', { legalEntityId: ukEntity });
    for (const who of ['hr2', 'ukhr', 'manager', 'asha', 'bala', 'olly']) tokens[who] = (await login(app, people[who]!.email)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('categories and articles', () => {
    it('starts every workspace with categories and lets HR configure handlers and targets', async () => {
      const cats = ok(await as('asha').get('/helpdesk/categories')) as unknown as { id: string; name: string }[];
      expect(cats.map((c) => c.name)).toEqual(['Documents and letters', 'IT and access', 'Leave and attendance', 'Pay and payslips', 'Something else']);
      ids.pay = cats.find((c) => c.name === 'Pay and payslips')!.id;
      fails(await as('asha').get('/helpdesk/categories?manage=true'), 403);
      fails(await as('manager').post('/helpdesk/categories').send({ name: 'Nope' }), 403);
      // Handlers must hold helpdesk:manage.
      fails(await as('hr').post('/helpdesk/categories').send({ name: 'Grievance', confidential: true, handlerMembershipIds: [people.manager.membershipId] }), 400, 'not_a_handler');
      fails(await as('hr').post('/helpdesk/categories').send({ name: 'Grievance', confidential: true, handlerMembershipIds: [] }), 422, 'validation_failed');
      ids.grievance = ok(await as('hr').post('/helpdesk/categories').send({
        name: 'Grievance', description: 'Raise a concern in confidence.', confidential: true, firstResponseHours: 24, resolutionHours: 240, handlerMembershipIds: [people.hr2.membershipId],
      }), 201).id;
      fails(await as('hr').post('/helpdesk/categories').send({ name: 'grievance' }), 409, 'category_exists');
      ok(await as('hr').put(`/helpdesk/categories/${ids.pay}`).send({ name: 'Pay and payslips', firstResponseHours: 8, resolutionHours: 48, handlerMembershipIds: [people.hr.membershipId, people.hr2.membershipId] }));
      const managed = ok(await as('hr').get('/helpdesk/categories?manage=true')) as unknown as { name: string; handlers: { name: string }[] }[];
      expect(managed.find((c) => c.name === 'Grievance')!.handlers.map((h) => h.name)).toEqual(['Hugo Test']);
    });

    it('publishes help articles and hides drafts from employees', async () => {
      ids.article = ok(await as('hr').post('/helpdesk/articles').send({ categoryId: ids.pay, title: 'When is salary paid?', body: 'Salary is paid on the last working day of each month.' }), 201).id;
      ids.draft = ok(await as('hr').post('/helpdesk/articles').send({ categoryId: ids.pay, title: 'Bonus policy (draft)', body: 'Not ready yet for anyone to read.', published: false }), 201).id;
      const list = ok(await as('asha').get(`/helpdesk/articles?categoryId=${ids.pay}`)) as unknown as { title: string }[];
      expect(list.map((a) => a.title)).toEqual(['When is salary paid?']);
      expect((ok(await as('asha').get('/helpdesk/articles?q=last%20working')) as unknown as unknown[]).length).toBe(1);
      fails(await as('asha').get(`/helpdesk/articles/${ids.draft}`), 404);
      expect((ok(await as('hr').get('/helpdesk/articles?all=true')) as unknown as unknown[]).length).toBe(2);
    });
  });

  describe('cases', () => {
    it('numbers a case, assigns the least busy handler and sets response targets by priority', async () => {
      const before = Date.now();
      const c = ok(await as('asha').post('/helpdesk/cases').send({ categoryId: ids.pay, subject: 'Overtime missing', description: 'My overtime for last month is not on my payslip.', priority: 'high' }), 201);
      expect(c.ref).toBe('HR-0001');
      ids.case1 = c.id;
      const d = ok(await as('asha').get(`/helpdesk/cases/${c.id}`));
      expect(d).toMatchObject({ role: 'requester', status: 'open', assigneeName: 'Hana Test', firstResponse: 'on_time', moves: [] });
      // 8 hours at high priority (x0.75) = 6 hours.
      const due = new Date(d.firstResponseDueAt).getTime() - before;
      expect(due).toBeGreaterThan(5.9 * 3600_000);
      expect(due).toBeLessThan(6.1 * 3600_000);
      expect(await unread('hr', 'helpdesk.case_new')).toEqual(['New helpdesk case HR-0001 in Pay and payslips']);
      // The next case goes to the other handler, who has fewer open cases.
      const c2 = ok(await as('bala').post('/helpdesk/cases').send({ categoryId: ids.pay, subject: 'Tax declaration', description: 'Where do I declare rent paid for tax?' }), 201);
      expect(c2.ref).toBe('HR-0002');
      ids.case2 = c2.id;
      expect(ok(await as('bala').get(`/helpdesk/cases/${c2.id}`)).assigneeName).toBe('Hugo Test');
      fails(await as('asha').post('/helpdesk/cases').send({ categoryId: ids.pay, subject: 'x', description: 'short' }), 422, 'validation_failed');
    });

    it('keeps cases away from managers and colleagues, and from HR outside their legal entity', async () => {
      fails(await as('manager').get(`/helpdesk/cases/${ids.case1}`), 404);
      fails(await as('bala').get(`/helpdesk/cases/${ids.case1}`), 404);
      fails(await as('manager').get('/helpdesk/cases?view=queue'), 403);
      fails(await as('ukhr').get(`/helpdesk/cases/${ids.case1}`), 404);
      const uk = ok(await as('olly').post('/helpdesk/cases').send({ categoryId: ids.pay, subject: 'UK payslip', description: 'My UK payslip shows the wrong address.' }), 201);
      const ukQueue = ok(await as('ukhr').get('/helpdesk/cases?view=queue')) as unknown as { id: string }[];
      expect(ukQueue.map((c) => c.id)).toEqual([uk.id]);
      ok(await as('ukhr').get(`/helpdesk/cases/${uk.id}`));
      const queue = ok(await as('hr').get('/helpdesk/cases?view=queue')) as unknown as { ref: string; priority: string }[];
      expect(queue[0]).toMatchObject({ ref: 'HR-0001', priority: 'high' });
    });

    it('runs the conversation: internal notes stay with HR, the first reply counts as the first response', async () => {
      ok(await as('hr').post(`/helpdesk/cases/${ids.case1}/messages`).send({ body: 'Checking with payroll whether the overtime was approved.', internal: true }));
      fails(await as('asha').post(`/helpdesk/cases/${ids.case1}/messages`).send({ body: 'sneaky', internal: true }), 403);
      let d = ok(await as('hr').get(`/helpdesk/cases/${ids.case1}`));
      expect(d.firstRespondedAt).toBeNull();
      ok(await as('hr').post(`/helpdesk/cases/${ids.case1}/messages`).send({ body: 'Thanks Asha, we are looking into it.' }));
      d = ok(await as('hr').get(`/helpdesk/cases/${ids.case1}`));
      expect(d).toMatchObject({ status: 'in_progress', firstResponse: 'met' });
      expect(d.messages).toHaveLength(2);
      expect(d.history.map((h: { action: string }) => h.action)).toEqual(['created', 'assigned', 'status']);
      const mine = ok(await as('asha').get(`/helpdesk/cases/${ids.case1}`));
      expect(mine.messages.map((m: { body: string }) => m.body)).toEqual(['Thanks Asha, we are looking into it.']);
      expect(mine.history).toEqual([]);
      expect(await unread('asha', 'helpdesk.reply')).toEqual(['HR replied on HR-0001']);
      // Waiting on the employee, then their reply puts it back in progress.
      ok(await as('hr').post(`/helpdesk/cases/${ids.case1}/status`).send({ status: 'waiting_on_employee', message: 'Which dates did you work overtime?' }));
      ok(await as('asha').post(`/helpdesk/cases/${ids.case1}/messages`).send({ body: 'The 3rd and the 10th.' }));
      expect(ok(await as('asha').get(`/helpdesk/cases/${ids.case1}`)).status).toBe('in_progress');
    });

    it('resolves with a message; the person rates, reopens or confirms; a closed case is final', async () => {
      fails(await as('asha').post(`/helpdesk/cases/${ids.case1}/status`).send({ status: 'resolved' }), 409, 'invalid_move');
      fails(await as('hr').post(`/helpdesk/cases/${ids.case1}/status`).send({ status: 'resolved' }), 400, 'resolution_required');
      fails(await as('hr').post(`/helpdesk/cases/${ids.case1}/status`).send({ status: 'closed' }), 409, 'invalid_move');
      ok(await as('hr').post(`/helpdesk/cases/${ids.case1}/status`).send({ status: 'resolved', message: 'Added to next month as arrears.' }));
      let mine = ok(await as('asha').get(`/helpdesk/cases/${ids.case1}`));
      expect(mine).toMatchObject({ status: 'resolved', moves: ['closed', 'open'], can: { rate: true } });
      // Reopen, resolve again, rate and confirm.
      ok(await as('asha').post(`/helpdesk/cases/${ids.case1}/status`).send({ status: 'open', message: 'It is still not on my payslip.' }));
      mine = ok(await as('asha').get(`/helpdesk/cases/${ids.case1}`));
      expect(mine).toMatchObject({ status: 'open', reopenedCount: 1, resolvedAt: null });
      ok(await as('hr').post(`/helpdesk/cases/${ids.case1}/status`).send({ status: 'resolved', message: 'Paid as a one-off adjustment today.' }));
      ok(await as('asha').post(`/helpdesk/cases/${ids.case1}/rating`).send({ rating: 4, comment: 'Took two tries, but sorted.' }));
      fails(await as('asha').post(`/helpdesk/cases/${ids.case1}/rating`).send({ rating: 5 }), 409, 'already_rated');
      ok(await as('asha').post(`/helpdesk/cases/${ids.case1}/status`).send({ status: 'closed' }));
      fails(await as('hr').post(`/helpdesk/cases/${ids.case1}/messages`).send({ body: 'One more thing' }), 409, 'case_closed');
      // The database itself refuses changes to a closed case.
      await expect(pool.query(`update helpdesk_cases set subject = 'edited' where id = $1`, [ids.case1])).rejects.toThrow(/closed helpdesk cases/);
      await expect(pool.query(`delete from helpdesk_cases where id = $1`, [ids.case1])).rejects.toThrow(/cannot be deleted/);
      // Messages are insert-only for the API role.
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('set local role crew_app');
        await client.query(`select set_config('app.tenant_id', $1, true)`, [t.id]);
        await expect(client.query(`update helpdesk_messages set body = 'x' where case_id = $1`, [ids.case1])).rejects.toThrow(/permission denied/);
        await client.query('rollback');
      } finally {
        client.release();
      }
    });

    it('closes resolved cases after 7 days without an answer', async () => {
      ok(await as('hr2').post(`/helpdesk/cases/${ids.case2}/status`).send({ status: 'resolved', message: 'Declare rent in the tax declaration window in January.' }));
      await pool.query(`update helpdesk_cases set resolved_at = now() - interval '8 days' where id = $1`, [ids.case2]);
      const db = app.get(DatabaseService);
      const closed = await db.tenant((tx) => app.get(HelpdeskService).autoClose(tx), { tenantId: t.id });
      expect(closed).toBe(1);
      const d = ok(await as('bala').get(`/helpdesk/cases/${ids.case2}`));
      expect(d).toMatchObject({ status: 'closed', moves: [] });
    });

    it('keeps confidential cases to their handlers, and audits every look', async () => {
      const g = ok(await as('asha').post('/helpdesk/cases').send({ categoryId: ids.grievance, subject: 'Concern about conduct', description: 'I want to raise a concern about behaviour on my shift.' }), 201);
      ids.grievanceCase = g.id;
      expect(await unread('hr2', 'helpdesk.case_new')).toContain(`New helpdesk case ${g.ref} in Grievance`);
      // Hana is an HR admin but not a handler of this category.
      fails(await as('hr').get(`/helpdesk/cases/${g.id}`), 404);
      expect((ok(await as('hr').get('/helpdesk/cases?view=queue')) as unknown as { id: string }[]).map((c) => c.id)).not.toContain(g.id);
      fails(await as('hr2').put(`/helpdesk/cases/${g.id}/assignee`).send({ assigneeMembershipId: people.hr.membershipId }), 400, 'assignee_cannot_handle');
      const d = ok(await as('hr2').get(`/helpdesk/cases/${g.id}`));
      expect(d).toMatchObject({ confidential: true, role: 'handler' });
      const audit = await pool.query(`select count(*)::int as n from audit_events where tenant_id = $1 and action = 'helpdesk.case_viewed' and resource_id = $2`, [t.id, g.id]);
      expect(audit.rows[0].n).toBe(1);
      // A case moved into a confidential category becomes confidential, and the case text never reaches the audit trail.
      const moved = ok(await as('bala').post('/helpdesk/cases').send({ categoryId: ids.pay, subject: 'About my team lead', description: 'Something happened that I would rather discuss privately.' }), 201);
      const handler = ok(await as('bala').get(`/helpdesk/cases/${moved.id}`)).assigneeName === 'Hana Test' ? 'hr' : 'hr2';
      ok(await as(handler).put(`/helpdesk/cases/${moved.id}/category`).send({ categoryId: ids.grievance }));
      fails(await as('hr').get(`/helpdesk/cases/${moved.id}`), 404);
      expect(ok(await as('hr2').get(`/helpdesk/cases/${moved.id}`))).toMatchObject({ confidential: true, assigneeName: 'Hugo Test' });
      const leaked = await pool.query(`select count(*)::int as n from audit_events where tenant_id = $1 and (changes::text ilike '%team lead%' or metadata::text ilike '%team lead%')`, [t.id]);
      expect(leaked.rows[0].n).toBe(0);
    });

    it('lets HR log a case for someone, and recalculates targets on a priority change', async () => {
      const c = ok(await as('hr').post('/helpdesk/cases').send({ categoryId: ids.pay, subject: 'Called about bank details', description: 'Bala called to update the bank account for salary.', employeeId: people.bala.employeeId }), 201);
      const d = ok(await as('bala').get(`/helpdesk/cases/${c.id}`));
      expect(d.role).toBe('requester');
      expect(await unread('bala', 'helpdesk.case_logged')).toEqual([`HR logged case ${c.ref} for you`]);
      fails(await as('asha').post('/helpdesk/cases').send({ categoryId: ids.pay, subject: 'For Bala', description: 'Raising this on behalf of a colleague.', employeeId: people.bala.employeeId }), 404);
      const h = ok(await as('hr').get(`/helpdesk/cases/${c.id}`));
      ok(await as('hr').put(`/helpdesk/cases/${c.id}/priority`).send({ priority: 'urgent' }));
      const after = ok(await as('hr').get(`/helpdesk/cases/${c.id}`));
      const created = new Date(h.createdAt).getTime();
      expect(new Date(after.firstResponseDueAt).getTime() - created).toBe(4 * 3600_000);
      const sum = ok(await as('bala').get('/helpdesk/summary'));
      expect(sum.mine.open).toBeGreaterThanOrEqual(1);
      expect(sum.assignedToMe).toBeNull();
    });
  });

  describe('announcements', () => {
    it('drafts, addresses and publishes to the right people only', async () => {
      fails(await as('manager').post('/announcements').send({ title: 'Hi', body: 'x' }), 403);
      ids.ann = ok(await as('hr').post('/announcements').send({ title: 'Plant shutdown on Friday', body: 'The Operations floor is closed on Friday for maintenance.', departmentId: ops, requiresAck: true }), 201).id;
      ids.allHands = ok(await as('hr').post('/announcements').send({ title: 'Town hall', body: 'Everyone is welcome at the town hall.', pinned: true }), 201).id;
      // Drafts are not in anyone's feed.
      expect(ok(await as('asha').get('/announcements'))).toEqual([]);
      const pub = ok(await as('hr').post(`/announcements/${ids.ann}/publish`));
      // Manager, Asha (sub-department Line 1) and Bala.
      expect(pub.audience).toBe(3);
      ok(await as('hr').post(`/announcements/${ids.allHands}/publish`));
      const feed = ok(await as('asha').get('/announcements')) as unknown as { title: string }[];
      expect(feed.map((a) => a.title)).toEqual(['Town hall', 'Plant shutdown on Friday']);
      expect((ok(await as('olly').get('/announcements')) as unknown as { title: string }[]).map((a) => a.title)).toEqual(['Town hall']);
      fails(await as('olly').get(`/announcements/${ids.ann}`), 404);
      expect(await unread('asha', 'announcement')).toContain('Please read and acknowledge: Plant shutdown on Friday');
    });

    it('records reads and acknowledgements, which cannot be undone', async () => {
      const r = ok(await as('asha').get(`/announcements/${ids.ann}`));
      expect(r).toMatchObject({ inAudience: true, acknowledgedAt: null });
      expect(r.readAt).toBeTruthy();
      const ack = ok(await as('asha').post(`/announcements/${ids.ann}/acknowledge`));
      expect(ack.acknowledgedAt).toBeTruthy();
      const again = ok(await as('asha').post(`/announcements/${ids.ann}/acknowledge`));
      expect(again.acknowledgedAt).toEqual(ack.acknowledgedAt);
      fails(await as('asha').post(`/announcements/${ids.allHands}/acknowledge`), 400, 'no_ack_needed');
      const detail = ok(await as('hr').get(`/announcements/manage/${ids.ann}`));
      expect(detail.people.map((p: { name: string; acknowledgedAt: string | null }) => [p.name, Boolean(p.acknowledgedAt)])).toEqual([
        ['Bala Test', false], ['Manu Test', false], ['Asha Test', true],
      ]);
      const list = ok(await as('hr').get('/announcements/manage')) as unknown as { id: string; readCount: number; ackCount: number; audienceSize: number }[];
      expect(list.find((a) => a.id === ids.ann)).toMatchObject({ readCount: 1, ackCount: 1, audienceSize: 3 });
      await expect(pool.query(`update announcement_receipts set acknowledged_at = null where announcement_id = $1`, [ids.ann])).rejects.toThrow(/acknowledgement cannot be changed/);
    });

    it('freezes the wording once published; only pinning and expiry change, then archive', async () => {
      ok(await as('hr').put(`/announcements/${ids.ann}`).send({ title: 'Changed title', body: 'Changed body', pinned: true }));
      const a = ok(await as('hr').get(`/announcements/manage/${ids.ann}`));
      expect(a).toMatchObject({ title: 'Plant shutdown on Friday', pinned: true });
      await expect(pool.query(`update announcements set body = 'tampered' where id = $1`, [ids.ann])).rejects.toThrow(/cannot be reworded/);
      fails(await as('hr').delete(`/announcements/${ids.ann}`), 409, 'not_draft');
      ok(await as('hr').post(`/announcements/${ids.ann}/archive`));
      expect((ok(await as('asha').get('/announcements')) as unknown as { title: string }[]).map((x) => x.title)).toEqual(['Town hall']);
      fails(await as('hr').post(`/announcements/${ids.ann}/publish`), 409, 'not_draft');
    });
  });

  describe('isolation', () => {
    it('keeps every Phase 7 record inside its workspace', async () => {
      const tables = ['helpdesk_categories', 'helpdesk_category_handlers', 'helpdesk_articles', 'helpdesk_counters', 'helpdesk_cases', 'helpdesk_messages',
        'helpdesk_events', 'announcements', 'announcement_receipts', 'mobile_devices'];
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('set local role crew_app');
        await client.query(`select set_config('app.tenant_id', $1, true)`, [other.id]);
        for (const table of tables) {
          const r = await client.query(`select count(*)::int as n from ${table} where tenant_id = $1`, [t.id]);
          expect(r.rows[0].n, table).toBe(0);
        }
        await client.query('savepoint s1');
        await expect(client.query(`insert into helpdesk_categories (tenant_id, name) values ($1, 'Injected')`, [t.id])).rejects.toThrow();
        await client.query('rollback to savepoint s1');
        await expect(client.query(`select count(*) from push_messages`)).rejects.toThrow(/permission denied/);
        await client.query('rollback');
      } finally {
        client.release();
      }
      const owner = (await loginWithMfa(app, pool, other.ownerEmail)).accessToken;
      const o = api(app, owner);
      fails(await o.get(`/helpdesk/cases/${ids.grievanceCase}`), 404);
      fails(await o.get(`/announcements/manage/${ids.allHands}`), 404);
      fails(await o.get(`/helpdesk/articles/${ids.article}`), 404);
      fails(await o.put(`/helpdesk/categories/${ids.pay}`).send({ name: 'Hijack' }), 404);
    });
  });
});
