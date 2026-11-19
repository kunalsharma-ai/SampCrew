import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, adminPool, api, createApp, createTenant, department, login, loginWithMfa, type TestDb, type TestTenant } from './helpers';

/**
 * Communication: chat (direct, groups, departments, employees with the HR team) with unread counts, delivery and
 * read status, files and search; HR emails to audiences with drafts, Cc/Bcc, safe rich text, attachments and
 * per-person delivery status; groups; the dashboard and each employee's communication record.
 */
describe('communication', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let eng: string;
  let ops: string;
  const people: Record<string, { email: string; membershipId: string; employeeId?: string }> = {};
  const tokens: Record<string, string> = {};
  const as = (who: string) => api(app, tokens[who]);
  const ok = (res: { status: number; body: unknown }, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as Record<string, any>;
  };

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    eng = await department(pool, t, 'Engineering');
    ops = await department(pool, t, 'Operations');
    const platformTeam = await department(pool, t, 'Platform team', eng);
    people.hr = await addMember(pool, t, { roles: ['hr_admin'], name: 'Hana HR' });
    people.mgr = await addMember(pool, t, { roles: ['department_manager'], name: 'Mona Manager', departmentId: eng });
    people.emp = await addMember(pool, t, { managerId: people.mgr.membershipId, name: 'Eli Employee', departmentId: eng });
    people.sub = await addMember(pool, t, { name: 'Sam Sub', departmentId: platformTeam });
    people.other = await addMember(pool, t, { name: 'Omar Other', departmentId: ops });
    tokens.hr = (await loginWithMfa(app, pool, people.hr.email)).accessToken;
    const designation = (await pool.insert('designations', { tenant_id: t.id, name: 'Engineer' })).id as string;
    const hire = async (who: string, first: string, departmentId: string, extra: Record<string, unknown> = {}) => {
      const body = ok(await as('hr').post('/employees').send({
        legalEntityId: t.legalEntityId, firstName: first, lastName: 'Test', dateOfJoining: '2024-01-01', probationMonths: 0, departmentId,
        membershipId: people[who]!.membershipId, onboardingTemplateId: null, ...extra,
      }), 201);
      people[who]!.employeeId = body.employee.id;
    };
    await hire('mgr', 'Mona', eng);
    await hire('emp', 'Eli', eng, { managerEmployeeId: people.mgr.employeeId, designationId: designation });
    await hire('sub', 'Sam', platformTeam, { designationId: designation });
    await hire('other', 'Omar', ops);
    for (const who of ['emp', 'mgr', 'sub', 'other']) tokens[who] = (await login(app, people[who]!.email)).accessToken;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  describe('chat', () => {
    it('an employee writes to HR: the whole HR team sees it, folds notices, and the employee sees Read once HR opens it', async () => {
      const conv = ok(await as('emp').post('/communication/conversations').send({ kind: 'hr' }), 201);
      // Opening it again returns the same conversation.
      expect(ok(await as('emp').post('/communication/conversations').send({ kind: 'hr' }), 201).id).toBe(conv.id);
      // HR does not see an empty conversation.
      expect(ok(await as('hr').get('/communication/conversations')).items.some((c: any) => c.id === conv.id)).toBe(false);
      ok(await as('emp').post(`/communication/conversations/${conv.id}/messages`).send({ body: 'When is the next payroll run?', clientId: 'c1' }), 201);
      // A retried send with the same client id does not post twice.
      ok(await as('emp').post(`/communication/conversations/${conv.id}/messages`).send({ body: 'When is the next payroll run?', clientId: 'c1' }), 201);
      ok(await as('emp').post(`/communication/conversations/${conv.id}/messages`).send({ body: 'And the bonus?' }), 201);
      const list = ok(await as('hr').get('/communication/conversations'));
      const seen = list.items.find((c: any) => c.id === conv.id);
      expect(seen).toMatchObject({ kind: 'hr', title: 'Eli Test', unread: 2 });
      const notes = await pool.find('notifications', { membership_id: people.hr.membershipId, kind: 'chat.hr_message' });
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ category: 'communication', count: 2, link: `/communication/chat/${conv.id}` });
      expect(ok(await as('hr').get('/communication/dashboard')).chat.waitingForHr).toBe(1);
      // Someone outside the HR team cannot open it.
      expect((await as('mgr').get(`/communication/conversations/${conv.id}`)).status).toBe(404);

      let mine = ok(await as('emp').get(`/communication/conversations/${conv.id}`));
      expect(mine.messages.map((m: any) => m.delivery)).toEqual(['delivered', 'delivered']);
      ok(await as('hr').get(`/communication/conversations/${conv.id}`));
      ok(await as('hr').post(`/communication/conversations/${conv.id}/read`));
      mine = ok(await as('emp').get(`/communication/conversations/${conv.id}`));
      expect(mine.messages.map((m: any) => m.delivery)).toEqual(['read', 'read']);
      expect(await pool.count('notifications', { membership_id: people.hr.membershipId, kind: 'chat.hr_message', read_at: null })).toBe(0);

      ok(await as('hr').post(`/communication/conversations/${conv.id}/messages`).send({ body: 'On the 28th, with the bonus.' }), 201);
      expect(ok(await as('emp').get('/communication/unread')).unread).toBe(1);
      const empNote = await pool.one('notifications', { membership_id: people.emp.membershipId, kind: 'chat.hr_message' });
      expect(empNote?.title).toBe('New message from Hana HR (HR team)');
      expect(ok(await as('hr').get('/communication/dashboard')).chat.waitingForHr).toBe(0);
    });

    it('a direct conversation is one per pair; delivery moves from Sent to Delivered to Read', async () => {
      const a = ok(await as('emp').post('/communication/conversations').send({ kind: 'direct', membershipId: people.mgr.membershipId }), 201);
      const b = ok(await as('mgr').post('/communication/conversations').send({ kind: 'direct', membershipId: people.emp.membershipId }), 201);
      expect(b.id).toBe(a.id);
      const sent = ok(await as('emp').post(`/communication/conversations/${a.id}/messages`).send({ body: 'Can we move the 1:1?' }), 201);
      expect(sent.delivery).toBe('sent');
      // The manager's app receives it (listing their conversations).
      const list = ok(await as('mgr').get('/communication/conversations'));
      expect(list.items.find((c: any) => c.id === a.id)).toMatchObject({ title: 'Eli Test', unread: 1 });
      expect(ok(await as('emp').get(`/communication/conversations/${a.id}`)).messages.at(-1).delivery).toBe('delivered');
      ok(await as('mgr').post(`/communication/conversations/${a.id}/read`));
      expect(ok(await as('emp').get(`/communication/conversations/${a.id}`)).messages.at(-1).delivery).toBe('read');
      expect((await as('other').get(`/communication/conversations/${a.id}`)).status).toBe(404);
      // Deleting your own message; someone else's cannot be deleted.
      expect((await as('mgr').delete(`/communication/conversations/${a.id}/messages/${sent.id}`)).status).toBe(403);
      ok(await as('emp').delete(`/communication/conversations/${a.id}/messages/${sent.id}`));
      expect(ok(await as('mgr').get(`/communication/conversations/${a.id}`)).messages.at(-1)).toMatchObject({ deleted: true, body: '' });
      expect((await as('emp').post('/communication/conversations').send({ kind: 'direct', membershipId: people.emp.membershipId })).status).toBe(400);
    });

    it('groups: members only, the owner renames and changes members, muting stops notices', async () => {
      const g = ok(await as('emp').post('/communication/conversations').send({ kind: 'group', title: 'Release crew', membershipIds: [people.mgr.membershipId, people.sub.membershipId] }), 201);
      expect((await as('other').get(`/communication/conversations/${g.id}`)).status).toBe(404);
      expect((await as('mgr').put(`/communication/conversations/${g.id}`).send({ title: 'Not mine' })).status).toBe(403);
      ok(await as('emp').put(`/communication/conversations/${g.id}`).send({ title: 'Release team', add: [people.other.membershipId], remove: [people.sub.membershipId] }));
      const view = ok(await as('other').get(`/communication/conversations/${g.id}`));
      expect(view.conversation.title).toBe('Release team');
      expect(view.messages.filter((m: any) => m.system).map((m: any) => m.body)).toEqual([
        'Eli Test created the group "Release crew"', 'Eli Test renamed the conversation to "Release team"', 'Eli Test added Omar Test', 'Eli Test removed Sam Test',
      ]);
      expect((await as('sub').get(`/communication/conversations/${g.id}`)).status).toBe(404);
      ok(await as('mgr').put(`/communication/conversations/${g.id}/mute`).send({ muted: true }));
      ok(await as('emp').post(`/communication/conversations/${g.id}/messages`).send({ body: 'Release at 5' }), 201);
      expect(await pool.count('notifications', { membership_id: people.mgr.membershipId, dedupe_key: `chat:${g.id}` })).toBe(0);
      expect(await pool.count('notifications', { membership_id: people.other.membershipId, dedupe_key: `chat:${g.id}` })).toBe(1);
      ok(await as('other').post(`/communication/conversations/${g.id}/leave`));
      expect((await as('other').get(`/communication/conversations/${g.id}`)).status).toBe(404);
    });

    it('a department conversation (HR) includes the department and its sub-departments', async () => {
      expect((await as('emp').post('/communication/conversations').send({ kind: 'department', departmentId: eng })).status).toBe(403);
      const d = ok(await as('hr').post('/communication/conversations').send({ kind: 'department', departmentId: eng }), 201);
      const view = ok(await as('sub').get(`/communication/conversations/${d.id}`));
      expect(view.conversation.title).toBe('Engineering');
      expect(view.conversation.members.map((m: any) => m.membershipId).sort()).toEqual([people.hr.membershipId, people.mgr.membershipId, people.emp.membershipId, people.sub.membershipId].sort());
      expect((await as('other').get(`/communication/conversations/${d.id}`)).status).toBe(404);
    });

    it('files are checked, and only people in the conversation can download them; search finds messages', async () => {
      const bad = await as('emp').post('/communication/files').attach('file', Buffer.from('MZ\x90\x00not a pdf'), { filename: 'x.pdf', contentType: 'application/pdf' });
      expect(bad.status).toBe(400);
      const f = ok(await as('emp').post('/communication/files').attach('file', Buffer.from('rota for next week'), { filename: 'rota.txt', contentType: 'text/plain' }), 201);
      const conv = ok(await as('emp').post('/communication/conversations').send({ kind: 'direct', membershipId: people.mgr.membershipId }), 201);
      // Someone else's upload cannot be attached.
      const g = ok(await as('other').post('/communication/files').attach('file', Buffer.from('x'), { filename: 'o.txt', contentType: 'text/plain' }), 201);
      expect((await as('emp').post(`/communication/conversations/${conv.id}/messages`).send({ body: 'hi', fileIds: [g.id] })).status).toBe(400);
      const m = ok(await as('emp').post(`/communication/conversations/${conv.id}/messages`).send({ body: 'Here is the rota', fileIds: [f.id] }), 201);
      expect(m.files[0]).toMatchObject({ name: 'rota.txt', href: `/communication-files/${f.id}` });
      const link = ok(await as('mgr').post(`/communication/files/${f.id}/link`));
      const file = await api(app).get(link.path.replace('/api/v1', ''));
      expect(file.status).toBe(200);
      expect(file.text ?? file.body.toString()).toContain('rota for next week');
      expect((await as('other').post(`/communication/files/${f.id}/link`)).status).toBe(404);
      const hits = ok(await as('mgr').get('/communication/search?q=rota'));
      expect(hits.items.map((h: any) => h.body)).toContain('Here is the rota');
      expect(ok(await as('other').get('/communication/search?q=rota')).items).toHaveLength(0);
    });
  });

  describe('email', () => {
    it('HR drafts, then sends to a department with Cc; each person gets a safe copy and a delivery status', async () => {
      expect((await as('emp').get('/communication/emails')).status).toBe(403);
      const draft = ok(await as('hr').post('/communication/emails').send({ subject: 'Diwali timings', html: '<p>Office closes at <b>2 pm</b>.</p><script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a>' }), 201);
      // A draft does not need an audience yet; sending does.
      expect((await as('hr').post(`/communication/emails/${draft.id}/send`).send({ subject: 'Diwali timings', html: '<p>x</p>', audience: { all: false } })).status).toBe(422);
      const sent = ok(await as('hr').post(`/communication/emails/${draft.id}/send`).send({
        subject: 'Diwali timings', html: '<p>Office closes at <b>2 pm</b>.</p><script>alert(1)</script><a href="javascript:alert(1)">x</a>',
        audience: { departmentIds: [eng] }, cc: ['Payroll@Example.com'],
      }));
      expect(sent.recipients).toBe(4); // Mona, Eli, Sam (sub-department) and the Cc address
      const rows = await pool.find('comm_email_recipients', { email_id: draft.id });
      expect(rows.filter((r) => r.kind === 'to').map((r) => r.membership_id).sort()).toEqual([people.mgr.membershipId, people.emp.membershipId, people.sub.membershipId].sort());
      expect(rows.find((r) => r.kind === 'cc')?.address).toBe('payroll@example.com');
      const queued = await pool.find('email_messages', { id: { $in: rows.map((r) => r.email_message_id) } });
      expect(queued).toHaveLength(4);
      for (const q of queued) {
        expect(q.html_body).toContain('<b>2 pm</b>');
        expect(q.html_body).not.toMatch(/script|javascript|onerror/);
        expect(q.text_body).toContain('Office closes at 2 pm.');
      }
      expect(queued.find((q) => q.to_email === 'payroll@example.com')?.text_body).toMatch(/^Copy of an email sent to 3 people/);
      // A sent email cannot be edited or deleted.
      expect((await as('hr').put(`/communication/emails/${draft.id}`).send({ subject: 'Changed' })).status).toBe(409);
      expect((await as('hr').delete(`/communication/emails/${draft.id}`)).status).toBe(409);

      // The mail queue sends two and one fails: statuses follow.
      const byAddress = new Map(rows.map((r) => [r.address, r.email_message_id]));
      await pool.update('email_messages', { id: byAddress.get(people.emp.email) }, { $set: { status: 'sent', sent_at: new Date() } });
      await pool.update('email_messages', { id: byAddress.get(people.mgr.email) }, { $set: { status: 'sent', sent_at: new Date() } });
      await pool.update('email_messages', { id: byAddress.get(people.sub.email) }, { $set: { status: 'failed', last_error: 'Mailbox full' } });
      let detail = ok(await as('hr').get(`/communication/emails/${draft.id}`));
      expect(detail).toMatchObject({ status: 'sending', sentCount: 2, failedCount: 1 });
      expect(detail.recipients.find((r: any) => r.address === people.sub.email)).toMatchObject({ status: 'failed', error: 'Mailbox full' });
      await pool.update('email_messages', { id: byAddress.get('payroll@example.com') }, { $set: { status: 'sent', sent_at: new Date() } });
      detail = ok(await as('hr').get(`/communication/emails/${draft.id}`));
      expect(detail).toMatchObject({ status: 'partly_failed', sentCount: 3, failedCount: 1, audienceLabel: 'Engineering' });

      // The employee reads it in SampCrew; it is on their communication record; the dashboard counts it.
      const inbox = ok(await as('emp').get('/communication/emails/inbox'));
      expect(inbox.items[0]).toMatchObject({ subject: 'Diwali timings', sentByName: 'Hana HR' });
      expect(ok(await as('other').get('/communication/emails/inbox')).items).toHaveLength(0);
      const record = ok(await as('hr').get(`/communication/employees/${people.emp.employeeId}`));
      expect(record.emails[0]).toMatchObject({ subject: 'Diwali timings', status: 'sent' });
      const dash = ok(await as('hr').get('/communication/dashboard'));
      expect(dash.email).toMatchObject({ sent30: 1, recipients30: 4, delivered30: 3, failed30: 1, deliveryRate: 75 });
      expect(ok(await as('hr').get(`/communication/emails?employeeId=${people.emp.employeeId}`)).items.map((e: any) => e.id)).toEqual([draft.id]);
      expect((await pool.find('audit_events', { action: 'comm_email.sent', resource_id: draft.id }))).toHaveLength(1);
    });

    it('audiences by designation, group and chosen people; attachments go with the email', async () => {
      const group = ok(await as('hr').post('/communication/groups').send({ name: 'First aiders', membershipIds: [people.other.membershipId, people.mgr.membershipId] }), 201);
      expect((await as('hr').post('/communication/groups').send({ name: 'first AIDERS', membershipIds: [people.emp.membershipId] })).status).toBe(409);
      const preview = ok(await as('hr').post('/communication/audience/preview').send({ designationIds: [(await pool.one('designations', { tenant_id: t.id, name: 'Engineer' }))!.id], groupIds: [group.id] }));
      expect(preview.count).toBe(4); // Eli and Sam (Engineer), Omar and Mona (group)
      expect(ok(await as('hr').post('/communication/audience/preview').send({ all: true })).count).toBe(6); // the owner and the five people above
      const f = ok(await as('hr').post('/communication/files').attach('file', Buffer.from('%PDF-1.4 policy'), { filename: 'policy.pdf', contentType: 'application/pdf' }), 201);
      const sent = ok(await as('hr').post('/communication/emails/send').send({ subject: 'First aid refresher', html: '<p>See attached.</p>', audience: { groupIds: [group.id], membershipIds: [people.emp.membershipId] }, bcc: ['audit@example.com'], fileIds: [f.id] }));
      expect(sent.recipients).toBe(4);
      const msg = await pool.one('email_messages', { to_email: people.other.email, subject: 'First aid refresher' });
      expect(msg?.attachments).toEqual([expect.objectContaining({ filename: 'policy.pdf', contentType: 'application/pdf' })]);
      // A recipient can download the attachment; someone who was not sent it cannot.
      expect((await as('other').post(`/communication/files/${f.id}/link`)).status).toBe(200);
      expect((await as('sub').post(`/communication/files/${f.id}/link`)).status).toBe(404);
      ok(await as('hr').delete(`/communication/groups/${group.id}`));
      expect(ok(await as('hr').get('/communication/groups')).items).toHaveLength(0);
    });
  });
});
