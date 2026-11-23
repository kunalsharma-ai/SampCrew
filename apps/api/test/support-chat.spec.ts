import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/platform/auth/crypto';
import { currentTotp } from '../src/platform/auth/mfa';
import { addMember, adminPool, api, createApp, createTenant, loginWithMfa, PASSWORD, type TestDb, type TestTenant } from './helpers';

/**
 * SampCrew Support chat (Super Workspace <-> Console Admin team) and sender identity in the internal chat. Covers the
 * five tests of the brief: support both ways, two Super Workspaces kept apart, Super Workspace to Employee Workspace
 * with clear sender identity, tampered ids and calls refused, and the existing chat unchanged.
 */
describe('support chat and sender identity', () => {
  let app: INestApplication;
  let pool: TestDb;
  let a: TestTenant;
  let b: TestTenant;
  const tokens: Record<string, string> = {};
  const people: Record<string, { email: string; membershipId: string; userId: string }> = {};
  const as = (who: string) => api(app, tokens[who]);
  const stamp = Date.now();
  const ok = (res: { status: number; body: unknown }, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as Record<string, any>;
  };

  async function platformToken(role: string, name: string) {
    const email = `${role}.support.${stamp}.${name.split(' ')[0]!.toLowerCase()}@sampledge.test`;
    await pool.insert('platform_admins', { email, full_name: name, password_hash: await hashPassword(PASSWORD), role });
    const res = await api(app).post('/platform/auth/login').send({ email, password: PASSWORD });
    const setup = await api(app, res.body.accessToken).post('/platform/auth/mfa/setup');
    return (await api(app, res.body.accessToken).post('/platform/auth/mfa/enable').send({ code: currentTotp(setup.body.secret) })).body.accessToken as string;
  }

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    a = await createTenant(pool);
    b = await createTenant(pool);
    await pool.update('tenants', { id: a.id }, { $set: { name: 'Acme Works' } });
    await pool.update('tenants', { id: b.id }, { $set: { name: 'Bolt Labs' } });
    people.amit = await addMember(pool, a, { roles: ['super_workspace'], name: 'Amit Sharma' });
    people.priya = await addMember(pool, a, { roles: ['hr_admin'], name: 'Priya Sharma' });
    people.rahul = await addMember(pool, a, { name: 'Rahul Sharma' });
    people.bea = await addMember(pool, b, { roles: ['super_workspace'], name: 'Bea Bolt' });
    for (const who of ['amit', 'priya', 'rahul', 'bea']) tokens[who] = (await loginWithMfa(app, pool, people[who]!.email)).accessToken;
    tokens.owner = (await loginWithMfa(app, pool, a.ownerEmail)).accessToken;
    tokens.rahulAdmin = await platformToken('super_admin', 'Rahul Console');
    tokens.sana = await platformToken('support', 'Sana Support');
    tokens.viewer = await platformToken('viewer', 'Vic Viewer');
    tokens.billing = await platformToken('billing_ops', 'Bill Ops');
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  let convA: string;

  it('Test 1: Super Workspace writes, the Console team sees who wrote, replies, and the Super Workspace gets it', async () => {
    const started = ok(await as('amit').post('/support/conversations').send({ subject: 'Attendance report', category: 'technical', body: 'Please help me with employee attendance.', clientId: 'first' }), 201);
    convA = started.id;
    // A retried start with the same client id does not open a second conversation.
    expect(ok(await as('amit').post('/support/conversations').send({ subject: 'Attendance report', category: 'technical', body: 'Please help me with employee attendance.', clientId: 'first' }), 201).id).toBe(convA);
    ok(await as('amit').post(`/support/conversations/${convA}/messages`).send({ body: 'It shows zero for Monday.' }), 201);

    // The Console team sees the conversation, unread, with the Super Workspace's identity.
    const inbox = ok(await api(app, tokens.sana).get('/platform/support/conversations'));
    const row = inbox.items.find((c: any) => c.id === convA);
    expect(row).toMatchObject({ number: 1, subject: 'Attendance report', category: 'technical', status: 'open', state: 'unread', unread: 2, workspace: { id: a.id, name: 'Acme Works' } });
    expect(row.startedBy).toMatchObject({ name: 'Amit Sharma', level: 'super', levelLabel: 'Super Workspace', workspace: 'Acme Works' });
    expect(ok(await api(app, tokens.sana).get('/platform/support/unread')).unread).toBeGreaterThanOrEqual(2);
    // Listing it reached the Console: the Super Workspace sees Delivered.
    let mine = ok(await as('amit').get(`/support/conversations/${convA}`));
    expect(mine.messages.map((m: any) => m.delivery)).toEqual(['delivered', 'delivered']);
    expect(mine.messages[0].sender).toMatchObject({ name: 'Amit Sharma', levelLabel: 'Super Workspace', workspace: 'Acme Works' });

    // Another Console Admin opens and answers. The message records who answered.
    const detail = ok(await api(app, tokens.rahulAdmin).get(`/platform/support/conversations/${convA}`));
    expect(detail.workspaceInfo).toMatchObject({ superWorkspace: expect.arrayContaining([{ name: 'Amit Sharma' }]) });
    ok(await api(app, tokens.rahulAdmin).post(`/platform/support/conversations/${convA}/read`).send({}));
    mine = ok(await as('amit').get(`/support/conversations/${convA}`));
    expect(mine.messages.map((m: any) => m.delivery)).toEqual(['read', 'read']);
    const reply = ok(await api(app, tokens.rahulAdmin).post(`/platform/support/conversations/${convA}/messages`).send({ body: 'We have reviewed your concern and fixed the report.', clientId: 'r1' }), 201);
    expect(reply.sender).toMatchObject({ name: 'Rahul Console', level: 'console', levelLabel: 'Console Admin', workspace: 'SampCrew Support' });
    expect(reply).toMatchObject({ fromConsole: true, mine: true, ourSide: true, delivery: 'sent' });
    // A retried reply is not posted twice.
    ok(await api(app, tokens.rahulAdmin).post(`/platform/support/conversations/${convA}/messages`).send({ body: 'We have reviewed your concern and fixed the report.', clientId: 'r1' }), 201);

    // The other admin sees it as their team's message, not their own.
    const seenBySana = ok(await api(app, tokens.sana).get(`/platform/support/conversations/${convA}`));
    expect(seenBySana.messages.filter((m: any) => m.fromConsole)).toHaveLength(1);
    expect(seenBySana.messages.at(-1)).toMatchObject({ ourSide: true, mine: false });
    expect(seenBySana.conversation).toMatchObject({ state: 'replied', handledBy: 'Rahul Console' });

    // The Super Workspace: unread reply, a notification, and the reply with the admin's name.
    const list = ok(await as('amit').get('/support/conversations'));
    expect(list.items[0]).toMatchObject({ id: convA, unread: 1, state: 'unread' });
    expect(list.unread).toBe(1);
    const notes = await pool.find('notifications', { membership_id: people.amit.membershipId, kind: 'support.reply' });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ category: 'communication', link: `/support/${convA}` });
    // The company's other Super Workspace member (the owner) is told too, and sees the same history.
    expect(await pool.find('notifications', { membership_id: a.ownerMembershipId, kind: 'support.reply' })).toHaveLength(1);
    const owners = ok(await as('owner').get(`/support/conversations/${convA}`));
    expect(owners.messages.at(-1)).toMatchObject({ body: 'We have reviewed your concern and fixed the report.', fromConsole: true, ourSide: false });
    expect(owners.messages[0]).toMatchObject({ ourSide: true, mine: false });

    ok(await as('amit').post(`/support/conversations/${convA}/read`));
    expect(ok(await as('amit').get('/support/unread'))).toEqual({ unread: 0, allowed: true });
    expect((await pool.find('notifications', { membership_id: people.amit.membershipId, kind: 'support.reply' }))[0]!.read_at).toBeTruthy();
    // The admin now sees Read on the reply.
    expect(ok(await api(app, tokens.sana).get(`/platform/support/conversations/${convA}`)).messages.at(-1).delivery).toBe('read');
    // Live events: one for the Console team and one for the company's Super Workspace members.
    expect(await pool.count('live_events', { tenant_id: a.id, console: true, type: 'support.message' })).toBeGreaterThanOrEqual(3);
  });

  it('the Console marks unread and resolves; a new message reopens; search and filters find it', async () => {
    ok(await api(app, tokens.sana).post(`/platform/support/conversations/${convA}/read`).send({ read: false }));
    let row = ok(await api(app, tokens.sana).get('/platform/support/conversations?state=unread')).items.find((c: any) => c.id === convA);
    expect(row).toMatchObject({ state: 'unread', unread: 1 });
    ok(await api(app, tokens.sana).put(`/platform/support/conversations/${convA}/status`).send({ status: 'resolved' }));
    row = ok(await api(app, tokens.sana).get('/platform/support/conversations?state=resolved')).items.find((c: any) => c.id === convA);
    expect(row.status).toBe('resolved');
    const detail = ok(await as('amit').get(`/support/conversations/${convA}`));
    expect(detail.messages.at(-1)).toMatchObject({ system: true, body: 'Sana Support marked this conversation resolved' });
    ok(await as('amit').post(`/support/conversations/${convA}/messages`).send({ body: 'One more thing about the export.' }), 201);
    expect(ok(await as('amit').get(`/support/conversations/${convA}`)).conversation.status).toBe('open');
    // Search by company, subject and message text.
    for (const q of ['Acme', 'attendance report', 'export']) expect(ok(await api(app, tokens.sana).get(`/platform/support/conversations?q=${encodeURIComponent(q)}`)).items.map((c: any) => c.id)).toContain(convA);
    expect(ok(await api(app, tokens.sana).get('/platform/support/conversations?q=nothing-like-this')).items).toHaveLength(0);
    expect(ok(await api(app, tokens.sana).get(`/platform/support/conversations?tenantId=${b.id}`)).items).toHaveLength(0);
  });

  it('Test 2: Super Workspace B never sees A\'s conversation, and A\'s is not in B\'s list', async () => {
    const own = ok(await as('bea').post('/support/conversations').send({ subject: 'Billing question', category: 'billing', body: 'When is the invoice due?' }), 201);
    expect(ok(await as('bea').get('/support/conversations')).items.map((c: any) => c.id)).toEqual([own.id]);
    expect(ok(await as('amit').get('/support/conversations')).items.map((c: any) => c.id)).not.toContain(own.id);
    // Numbering is per company.
    expect(ok(await as('bea').get(`/support/conversations/${own.id}`)).conversation.number).toBe(1);
    // Changing the id in the URL finds nothing.
    for (const call of [
      () => as('bea').get(`/support/conversations/${convA}`),
      () => as('bea').post(`/support/conversations/${convA}/messages`).send({ body: 'Peek' }),
      () => as('bea').post(`/support/conversations/${convA}/read`),
      () => as('bea').put(`/support/conversations/${convA}/status`).send({ status: 'resolved' }),
    ]) expect((await call()).status).toBe(404);
    expect(await pool.count('support_messages', { conversation_id: convA, body: 'Peek' })).toBe(0);
    // The Console sees both companies, each with its own name.
    const inbox = ok(await api(app, tokens.sana).get('/platform/support/conversations'));
    expect(inbox.items.find((c: any) => c.id === own.id).workspace.name).toBe('Bolt Labs');
  });

  it('Test 4: HR Workspace, Employee Workspace and Console roles without support:chat are refused', async () => {
    for (const who of ['priya', 'rahul']) {
      expect((await as(who).get('/support/conversations')).status).toBe(403);
      expect((await as(who).get(`/support/conversations/${convA}`)).status).toBe(403);
      expect((await as(who).post(`/support/conversations/${convA}/messages`).send({ body: 'Let me in' })).status).toBe(403);
      expect((await as(who).post('/support/conversations').send({ subject: 'Hello there', body: 'Hi' })).status).toBe(403);
      expect(ok(await as(who).get('/support/unread'))).toEqual({ unread: 0, allowed: false });
      // Nor through the internal chat or its search.
      expect((await as(who).get(`/communication/conversations/${convA}`)).status).toBe(404);
      expect(ok(await as(who).get('/communication/search?q=attendance')).items).toHaveLength(0);
    }
    // A workspace token on the Console routes, and Console roles without support:chat.
    expect((await as('amit').get('/platform/support/conversations')).status).toBe(401);
    for (const t of ['viewer', 'billing']) {
      expect((await api(app, tokens[t]).get('/platform/support/conversations')).status).toBe(403);
      expect((await api(app, tokens[t]).post(`/platform/support/conversations/${convA}/messages`).send({ body: 'x' })).status).toBe(403);
    }
    // No token at all.
    expect((await api(app).get('/support/conversations')).status).toBe(401);
    expect((await api(app).get('/platform/support/stream')).status).toBe(401);
    // A made-up id on the Console side.
    expect((await api(app, tokens.sana).get('/platform/support/conversations/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('Test 3: Super Workspace messages an employee: the employee sees name, level and workspace', async () => {
    // The picker shows level, workspace, email and finds people by email.
    const found = ok(await as('amit').get(`/communication/people?q=${encodeURIComponent(people.rahul.email)}`));
    expect(found.items).toHaveLength(1);
    expect(found.items[0]).toMatchObject({ name: 'Rahul Sharma', level: 'employee', levelLabel: 'Employee Workspace', workspace: 'Acme Works', email: people.rahul.email });
    expect(ok(await as('amit').get('/communication/people?q=HR%20Workspace')).items.map((p: any) => p.name)).toContain('Priya Sharma');

    const conv = ok(await as('amit').post('/communication/conversations').send({ kind: 'direct', membershipId: people.rahul.membershipId }), 201);
    ok(await as('amit').post(`/communication/conversations/${conv.id}/messages`).send({ body: 'Hello, I wanted to discuss your attendance record.' }), 201);
    const seen = ok(await as('rahul').get(`/communication/conversations/${conv.id}`));
    expect(seen.messages[0]).toMatchObject({ senderName: 'Amit Sharma', sender: { name: 'Amit Sharma', level: 'super', levelLabel: 'Super Workspace', workspace: 'Acme Works' } });
    expect(seen.conversation).toMatchObject({ title: 'Amit Sharma', subtitle: 'Super Workspace · Acme Works', counterpart: { levelLabel: 'Super Workspace' } });
    const list = ok(await as('rahul').get('/communication/conversations'));
    expect(list.items.find((c: any) => c.id === conv.id)).toMatchObject({ unread: 1, subtitle: 'Super Workspace · Acme Works' });
    const note = (await pool.find('notifications', { membership_id: people.rahul.membershipId, kind: 'chat.message' }))[0]!;
    expect(note.title).toBe('New message from Amit Sharma (Super Workspace)');
    // The level is kept with the message: a later change does not rewrite history.
    expect((await pool.find('chat_messages', { conversation_id: conv.id }))[0]).toMatchObject({ sender_level: 'super', sender_workspace: 'Acme Works' });
    // HR replies in a group: everyone sees HR Workspace next to Priya.
    const group = ok(await as('priya').post('/communication/conversations').send({ kind: 'group', title: 'Shift planning', membershipIds: [people.rahul.membershipId, people.amit.membershipId] }), 201);
    ok(await as('priya').post(`/communication/conversations/${group.id}/messages`).send({ body: 'Shifts change next week.' }), 201);
    const g = ok(await as('rahul').get(`/communication/conversations/${group.id}`));
    expect(g.messages.find((m: any) => !m.system).sender).toMatchObject({ name: 'Priya Sharma', levelLabel: 'HR Workspace', workspace: 'Acme Works' });
    expect(g.conversation.members.find((m: any) => m.membershipId === people.amit.membershipId).identity.levelLabel).toBe('Super Workspace');
  });

  it('Test 5: the existing chat keeps working: HR conversation, unread, read ticks, search', async () => {
    const hr = ok(await as('rahul').post('/communication/conversations').send({ kind: 'hr' }), 201);
    ok(await as('rahul').post(`/communication/conversations/${hr.id}/messages`).send({ body: 'When is payroll?' }), 201);
    const seen = ok(await as('priya').get('/communication/conversations')).items.find((c: any) => c.id === hr.id);
    expect(seen).toMatchObject({ kind: 'hr', title: 'Rahul Sharma', unread: 1, subtitle: 'Message to HR · Employee Workspace · Acme Works' });
    ok(await as('priya').get(`/communication/conversations/${hr.id}`));
    ok(await as('priya').post(`/communication/conversations/${hr.id}/read`));
    expect(ok(await as('rahul').get(`/communication/conversations/${hr.id}`)).messages[0].delivery).toBe('read');
    const hits = ok(await as('rahul').get('/communication/search?q=payroll'));
    expect(hits.items[0]).toMatchObject({ senderName: 'Rahul Sharma', sender: { levelLabel: 'Employee Workspace' } });
    // Support messages never show up in the internal chat.
    expect(ok(await as('amit').get('/communication/search?q=attendance')).items.every((h: any) => !String(h.body).includes('employee attendance'))).toBe(true);
  });
});
