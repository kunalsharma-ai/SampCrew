import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, adminPool, api, createApp, createTenant, department, login, loginWithMfa, type TestDb, type TestTenant } from './helpers';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

/**
 * HR Tasks and Manager Tasks: who can assign what to whom, the employee's progress, document uploads that HR
 * verifies (from the task and from Approvals), reopening with remarks, counts and notifications.
 */
describe('HR tasks and manager tasks', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let engineering: string;
  const people: Record<string, { email: string; membershipId: string; employeeId?: string }> = {};
  const tokens: Record<string, string> = {};
  const as = (who: string) => api(app, tokens[who]);
  const ok = (res: { status: number; body: unknown }, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return res.body as Record<string, any>;
  };
  const notes = (who: string, kind: string) => pool.count('notifications', { tenant_id: t.id, membership_id: people[who]!.membershipId, kind });

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    engineering = await department(pool, t, 'Engineering');
    people.hr = await addMember(pool, t, { roles: ['hr_admin'], name: 'Hana HR' });
    people.manager = await addMember(pool, t, { roles: ['department_manager'], departmentId: engineering, name: 'Manu Manager' });
    people.asha = await addMember(pool, t, { departmentId: engineering, name: 'Asha Rao' });
    people.other = await addMember(pool, t, { name: 'Oz Other' });
    tokens.hr = (await loginWithMfa(app, pool, people.hr.email)).accessToken;
    const hire = async (who: string, first: string, managerEmployeeId?: string, departmentId: string | null = engineering) => {
      const body = ok(await as('hr').post('/employees').send({
        legalEntityId: t.legalEntityId, firstName: first, lastName: 'Test', dateOfJoining: '2025-01-01', probationMonths: 0, membershipId: people[who]!.membershipId,
        departmentId, managerEmployeeId, onboardingTemplateId: null,
      }), 201);
      people[who]!.employeeId = body.employee.id;
    };
    await hire('hr', 'Hana', undefined, null);
    await hire('manager', 'Manu');
    await hire('asha', 'Asha', people.manager.employeeId);
    await hire('other', 'Oz', undefined, null);
    for (const who of ['manager', 'asha', 'other']) tokens[who] = (await login(app, people[who]!.email)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('manager tasks', () => {
    let taskId: string;

    it('the manager assigns to their team only, never to themselves or outside it', async () => {
      const base = { category: 'manager', title: 'Weekly deliverables report', description: 'Send the status of your sprint work', priority: 'high', dueOn: '2030-01-10' };
      expect((await as('manager').post('/tasks').send({ ...base, employeeIds: [people.other.employeeId] })).status).toBe(404);
      expect((await as('manager').post('/tasks').send({ ...base, employeeIds: [people.manager.employeeId] })).status).toBe(400);
      // A plain employee cannot assign anything; nor can a manager hand out HR tasks.
      expect((await as('asha').post('/tasks').send({ ...base, employeeIds: [people.other.employeeId] })).status).toBe(404);
      expect((await as('manager').post('/tasks').send({ ...base, category: 'hr', employeeIds: [people.asha.employeeId] })).status).toBe(403);
      // Document uploads are HR tasks.
      expect((await as('manager').post('/tasks').send({ ...base, kind: 'document', document: { formats: ['pdf'] }, employeeIds: [people.asha.employeeId] })).status).toBe(422);
      const [task] = ok(await as('manager').post('/tasks').send({ ...base, employeeIds: [people.asha.employeeId] }), 201) as unknown as Record<string, unknown>[];
      taskId = task!.id as string;
      expect(task).toMatchObject({ category: 'manager', status: 'new', isNew: true, priority: 'high', assignedBy: 'Manu Manager' });
      expect(await notes('asha', 'task.assigned')).toBe(1);
      const people_ = ok(await as('manager').get('/tasks/assignable'));
      expect(people_.manager.map((p: { id: string }) => p.id)).toEqual([people.asha.employeeId]);
      expect(people_.hr).toEqual([]);
    });

    it('the employee sees it under Manager Tasks with a new count; other people cannot see it', async () => {
      const counts = ok(await as('asha').get('/tasks/counts'));
      expect(counts.manager).toMatchObject({ open: 1, new: 1 });
      expect(counts.hr).toMatchObject({ open: 0, new: 0 });
      const mine = ok(await as('asha').get('/tasks?scope=mine&category=manager')) as unknown as { id: string }[];
      expect(mine.map((x) => x.id)).toEqual([taskId]);
      expect((await as('other').get(`/tasks/${taskId}`)).status).toBe(404);
      ok(await as('asha').post(`/tasks/${taskId}/seen`));
      expect(ok(await as('asha').get('/tasks/counts')).manager.new).toBe(0);
      expect(ok(await as('asha').get(`/tasks/${taskId}`)).status).toBe('not_started');
    });

    it('the employee works on it and sends it for review; the manager reopens it with a reason, then accepts it', async () => {
      // Only the employee updates progress; the manager reviews.
      expect((await as('manager').post(`/tasks/${taskId}/progress`).send({ status: 'in_progress' })).status).toBe(403);
      ok(await as('asha').post(`/tasks/${taskId}/progress`).send({ status: 'in_progress', remarks: 'Started on it' }));
      ok(await as('asha').post(`/tasks/${taskId}/progress`).send({ status: 'pending_review', remarks: 'Report attached in the shared drive' }));
      expect(await notes('manager', 'task.updated')).toBe(1);
      expect(ok(await as('manager').get('/tasks/counts')).toReview).toBe(1);
      expect((await as('asha').post(`/tasks/${taskId}/review`).send({ action: 'complete' })).status).toBe(403);
      expect((await as('manager').post(`/tasks/${taskId}/review`).send({ action: 'reopen' })).status).toBe(422);
      const reopened = ok(await as('manager').post(`/tasks/${taskId}/review`).send({ action: 'reopen', remarks: 'Add the client numbers' }));
      expect(reopened).toMatchObject({ status: 'reopened', reviewerRemarks: 'Add the client numbers' });
      expect(await notes('asha', 'task.reopened')).toBe(1);
      ok(await as('asha').post(`/tasks/${taskId}/progress`).send({ status: 'pending_review', remarks: 'Numbers added' }));
      const done = ok(await as('manager').post(`/tasks/${taskId}/review`).send({ action: 'complete', remarks: 'Thanks' }));
      expect(done.status).toBe('completed');
      expect(done.history.map((h: { action: string }) => h.action)).toEqual(['assigned', 'progress', 'progress', 'reopened', 'progress', 'accepted']);
      expect((await as('asha').post(`/tasks/${taskId}/progress`).send({ status: 'in_progress' })).status).toBe(409);
      expect(await pool.count('audit_events', { tenant_id: t.id, action: 'task.completed' })).toBe(1);
    });

    it('shows overdue for open tasks past their due date', async () => {
      const [late] = ok(await as('manager').post('/tasks').send({ category: 'manager', title: 'Old target', dueOn: '2020-01-01', employeeIds: [people.asha.employeeId] }), 201) as unknown as Record<string, unknown>[];
      expect(late).toMatchObject({ displayStatus: 'overdue', overdue: true });
      expect(ok(await as('asha').get('/tasks/counts')).manager.overdue).toBe(1);
      ok(await as('manager').post(`/tasks/${late!.id}/review`).send({ action: 'cancel', remarks: 'No longer needed' }));
      expect(ok(await as('asha').get('/tasks/counts')).manager.open).toBe(0);
    });
  });

  describe('HR document tasks', () => {
    let taskId: string;

    it('HR assigns a document task with format and size rules', async () => {
      const [task] = ok(await as('hr').post('/tasks').send({
        category: 'hr', kind: 'document', title: 'Submit identity proof', description: 'Passport or national ID card', priority: 'normal',
        document: { category: 'id_proof', formats: ['pdf'], maxMb: 1 }, employeeIds: [people.asha.employeeId],
      }), 201) as unknown as Record<string, unknown>[];
      taskId = task!.id as string;
      expect(task).toMatchObject({ kind: 'document', document: { spec: { category: 'id_proof', formats: ['pdf'], maxMb: 1 }, id: null } });
      expect(ok(await as('asha').get('/tasks/counts')).hr.open).toBe(1);
      // Document tasks complete only through verification.
      expect((await as('asha').post(`/tasks/${taskId}/progress`).send({ status: 'completed' })).status).toBe(400);
    });

    it('refuses files of the wrong format or size, and uploads from anyone but the employee', async () => {
      const txt = await as('asha').post(`/tasks/${taskId}/document`).attach('file', Buffer.from('hello'), { filename: 'id.txt', contentType: 'text/plain' });
      expect(txt.status).toBe(400);
      expect(txt.body.error.message).toContain('PDF');
      const big = Buffer.concat([PDF, Buffer.alloc(1024 * 1024 + 10, 0x20)]);
      expect((await as('asha').post(`/tasks/${taskId}/document`).attach('file', big, { filename: 'id.pdf', contentType: 'application/pdf' })).status).toBe(400);
      expect((await as('hr').post(`/tasks/${taskId}/document`).attach('file', PDF, { filename: 'id.pdf', contentType: 'application/pdf' })).status).toBe(403);
    });

    it('the upload is filed in the employee documents as pending and reaches HR in Approvals', async () => {
      const up = ok(await as('asha').post(`/tasks/${taskId}/document`).field('remarks', 'My passport').attach('file', PDF, { filename: 'passport.pdf', contentType: 'application/pdf' }));
      expect(up.status).toBe('pending_review');
      expect(up.document).toMatchObject({ fileName: 'passport.pdf', verificationStatus: 'pending' });
      const docs = ok(await as('hr').get(`/employees/${people.asha.employeeId}/documents`)) as unknown as Record<string, unknown>[];
      expect(docs.find((d) => d.taskId === taskId)).toMatchObject({ category: 'id_proof', verificationStatus: 'pending' });
      expect((await as('asha').post(`/tasks/${taskId}/document`).attach('file', PDF, { filename: 'again.pdf', contentType: 'application/pdf' })).status).toBe(409);
      const inbox = ok(await as('hr').get('/approvals/inbox')) as unknown as Record<string, unknown>[];
      const item = inbox.find((i) => i.resourceType === 'document_verification');
      expect(item).toMatchObject({ label: 'Document verification', link: `/tasks/${taskId}` });
      expect((item!.details as Record<string, unknown>).fileName).toBe('passport.pdf');
      expect(ok(await as('hr').get('/tasks/counts')).documentsToVerify).toBe(1);
      // The manager cannot verify HR documents.
      expect((await as('manager').post(`/tasks/${taskId}/verify`).send({ decision: 'verify' })).status).toBe(404);
    });

    it('HR rejects with remarks: the task reopens and the employee uploads again', async () => {
      expect((await as('hr').post(`/tasks/${taskId}/verify`).send({ decision: 'reject' })).status).toBe(422);
      const rejected = ok(await as('hr').post(`/tasks/${taskId}/verify`).send({ decision: 'reject', remarks: 'The photo page is cut off' }));
      expect(rejected).toMatchObject({ status: 'reopened', reviewerRemarks: 'The photo page is cut off', document: { verificationStatus: 'rejected', verificationRemarks: 'The photo page is cut off' } });
      expect(await notes('asha', 'approval.rejected')).toBe(1);
      ok(await as('asha').post(`/tasks/${taskId}/document`).attach('file', PDF, { filename: 'passport-full.pdf', contentType: 'application/pdf' }));
    });

    it('HR verifies from Approvals: the document is verified and the task completed', async () => {
      const inbox = ok(await as('hr').get('/approvals/inbox')) as unknown as Record<string, unknown>[];
      const item = inbox.find((i) => i.resourceType === 'document_verification')!;
      ok(await as('hr').post(`/approvals/${item.id}/approve`).send({ comment: 'Looks good' }));
      const done = ok(await as('asha').get(`/tasks/${taskId}`));
      expect(done).toMatchObject({ status: 'completed', document: { fileName: 'passport-full.pdf', verificationStatus: 'verified' } });
      expect(done.history.map((h: { action: string }) => h.action)).toEqual(['assigned', 'uploaded', 'document_rejected', 'uploaded', 'document_verified']);
      expect(await pool.count('audit_events', { tenant_id: t.id, action: 'task.document_verified' })).toBe(1);
      expect(ok(await as('hr').get('/tasks/counts')).documentsToVerify).toBe(0);
    });

    it('acknowledgement tasks are completed by the employee', async () => {
      const copies = ok(await as('hr').post('/tasks').send({ category: 'hr', kind: 'acknowledgement', title: 'Acknowledge company policies', employeeIds: [people.asha.employeeId, people.other.employeeId] }), 201) as unknown as Record<string, unknown>[];
      const ack = copies.find((c) => c.employeeId === people.asha.employeeId);
      const done = ok(await as('asha').post(`/tasks/${ack!.id}/progress`).send({ status: 'completed' }));
      expect(done.acknowledgedAt).toBeTruthy();
      // HR sees every person's copy.
      const assigned = ok(await as('hr').get('/tasks?scope=assigned&category=hr')) as unknown as { employeeId: string; title: string }[];
      expect(assigned.filter((x) => x.title === 'Acknowledge company policies').map((x) => x.employeeId).sort()).toEqual([people.asha.employeeId, people.other.employeeId].sort());
    });
  });
});
