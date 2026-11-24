import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CrmJobsService } from '../src/modules/candidate-crm/crm-jobs.service';
import { addMember, adminPool, allowDeletes, api, createApp, createTenant, login, loginWithMfa, type TestDb, type TestTenant } from './helpers';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

/**
 * Recruitment & ATS > Candidate CRM through the HTTP API: Super Workspace's access switch for each HR Workspace,
 * strict HR Workspace isolation, the candidate record with its CAN- number, duplicates, remarks, references,
 * activities, follow-ups and their reminders, documents with versions, custom fields, import, export and erasure.
 */
describe('Candidate CRM', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let owner: string;
  let hrA: string;
  let hrB: string;
  let staff: string;
  let spaceA: string;
  let spaceB: string;
  let hrAMember: string;
  let kunal: string;
  let kunalCode: string;

  const kunalBody = {
    firstName: 'Kunal', lastName: 'Sharma', email: 'kunal.sharma@example.com', phone: '+91 98200 11122', profession: 'Data Analyst', currentTitle: 'Senior Data Analyst',
    currentCompany: 'Acme Analytics', totalExperienceMonths: 76, primarySkills: ['SQL', 'Python'], city: 'Pune', source: 'linkedin',
    compensation: { currency: 'INR', basis: 'annual', currentCtc: '1200000', expectedCtc: '1600000' }, notice: { period: '30_days' },
    links: { linkedin: 'linkedin.com/in/kunal-sharma' }, references: [{ type: 'employee_referral', name: 'Priya Nair', phone: '+91 98200 33344' }],
    remark: 'Strong SQL; open to hybrid roles.', lawfulBasisConfirmed: true,
  };

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    const a = await addMember(pool, t, { name: 'Asha Recruiter' });
    const b = await addMember(pool, t, { name: 'Bala Recruiter' });
    const s = await addMember(pool, t, { name: 'Sam Staff' });
    hrAMember = a.membershipId;
    const wa = await api(app, owner).post('/hr-workspaces').send({ name: 'Mumbai Hiring', features: ['recruitment'], adminMembershipIds: [a.membershipId] });
    expect(wa.status, JSON.stringify(wa.body)).toBe(201);
    const wb = await api(app, owner).post('/hr-workspaces').send({ name: 'Delhi Hiring', features: ['recruitment'], adminMembershipIds: [b.membershipId] });
    expect(wb.status, JSON.stringify(wb.body)).toBe(201);
    spaceA = wa.body.id;
    spaceB = wb.body.id;
    for (const space of [spaceA, spaceB]) await allowDeletes(pool, t, 'hr', ['recruitment'], space);
    hrA = (await loginWithMfa(app, pool, a.email)).accessToken;
    hrB = (await loginWithMfa(app, pool, b.email)).accessToken;
    staff = (await login(app, s.email)).accessToken;
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('access', () => {
    it('Super Workspace always has it; an HR Workspace only after Super Workspace switches it on; Employee Workspace never', async () => {
      const ctx = await api(app, owner).get('/recruitment/crm/context');
      expect(ctx.status, JSON.stringify(ctx.body)).toBe(200);
      expect(ctx.body).toMatchObject({ level: 'super', canManageAccess: true });
      expect(ctx.body.stages).toHaveLength(17);
      expect((await api(app, owner).get('/me')).body.candidateCrm).toBe(true);

      const off = await api(app, hrA).get('/recruitment/crm/context');
      expect(off.status).toBe(403);
      expect(off.body.error.code).toBe('crm_not_enabled');
      expect((await api(app, hrA).get('/me')).body.candidateCrm).toBe(false);
      expect((await api(app, hrA).get('/recruitment/crm/access')).status).toBe(403);

      const emp = await api(app, staff).get('/recruitment/crm/candidates');
      expect(emp.status).toBe(403);

      const list = await api(app, owner).get('/recruitment/crm/access');
      expect(list.body.rows.map((r: { name: string }) => r.name)).toEqual(['Company-wide HR team', 'Delhi Hiring', 'Mumbai Hiring']);
      const on = await api(app, owner).put('/recruitment/crm/access').send({ changes: [{ key: spaceA, enabled: true, caps: ['import', 'export', 'fields'] }, { key: spaceB, enabled: true, caps: [] }] });
      expect(on.status, JSON.stringify(on.body)).toBe(200);
      const ctxA = await api(app, hrA).get('/recruitment/crm/context');
      expect(ctxA.status, JSON.stringify(ctxA.body)).toBe(200);
      expect(ctxA.body).toMatchObject({ level: 'hr', canManageAccess: false, workspaces: [{ key: spaceA, name: 'Mumbai Hiring', caps: ['import', 'export', 'fields'] }] });
      expect((await api(app, hrA).get('/me')).body.candidateCrm).toBe(true);
      expect((await api(app, hrA).put('/recruitment/crm/access').send({ changes: [{ key: spaceB, enabled: false, caps: [] }] })).status).toBe(403);
      const audit = await pool.find('audit_events', { tenant_id: t.id, action: 'candidate_crm.access_enabled' });
      expect(audit.length).toBe(2);
    });
  });

  describe('candidates', () => {
    it('adds Kunal Sharma with a CAN- number, starting in New Candidate, owned by the HR Workspace', async () => {
      const r = await api(app, hrA).post('/recruitment/crm/candidates').send(kunalBody);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.candidateCode).toMatch(/^CAN-\d{6}$/);
      kunal = r.body.id;
      kunalCode = r.body.candidateCode;
      const p = await api(app, hrA).get(`/recruitment/crm/candidates/${kunal}`);
      expect(p.status).toBe(200);
      expect(p.body.candidate).toMatchObject({
        candidateCode: kunalCode, name: 'Kunal Sharma', stage: 'new', hrWorkspaceId: spaceA, hrWorkspaceName: 'Mumbai Hiring', experienceText: '6 years 4 months',
        noticeDays: 30, links: { linkedin: 'https://linkedin.com/in/kunal-sharma' }, primarySkills: ['SQL', 'Python'], sensitiveHidden: true,
      });
      expect(p.body.candidate.compensation).toMatchObject({ currentCtc: '1200000.00', expectedCtc: '1600000.00' });
      expect(p.body.references).toEqual([expect.objectContaining({ name: 'Priya Nair', typeLabel: 'Employee Referral' })]);
      expect(p.body.remarks).toEqual([expect.objectContaining({ body: 'Strong SQL; open to hybrid roles.', category: 'general', authorLevel: 'hr' })]);
      expect(p.body.activities.map((x: { kind: string }) => x.kind)).toContain('created');
    });

    it('refuses duplicates: the same email, or the same phone unless the recruiter confirms', async () => {
      const same = await api(app, hrA).post('/recruitment/crm/candidates').send({ ...kunalBody, phone: null, references: [], remark: undefined });
      expect(same.status).toBe(409);
      expect(same.body.error).toMatchObject({ code: 'candidate_exists', details: { candidateId: kunal, candidateCode: kunalCode } });
      const phone = await api(app, hrA).post('/recruitment/crm/candidates').send({ firstName: 'K', lastName: 'Sharma', phone: '09820011122', lawfulBasisConfirmed: true });
      expect(phone.status).toBe(409);
      expect(phone.body.error.code).toBe('possible_duplicate');
      // Another HR Workspace learns only that the person exists elsewhere.
      const elsewhere = await api(app, hrB).post('/recruitment/crm/candidates').send({ firstName: 'Kunal', email: 'kunal.sharma@example.com', lawfulBasisConfirmed: true });
      expect(elsewhere.status).toBe(409);
      expect(elsewhere.body.error.code).toBe('candidate_exists_elsewhere');
      expect(elsewhere.body.error.details.candidateId).toBeUndefined();
      const ok = await api(app, hrA).post('/recruitment/crm/candidates').send({ firstName: 'Karan', lastName: 'S', phone: '+91 98200 11122', allowPhoneDuplicate: true, lawfulBasisConfirmed: true });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    });

    it('keeps HR Workspaces apart until Super Workspace shares a record', async () => {
      expect((await api(app, hrB).get(`/recruitment/crm/candidates/${kunal}`)).status).toBe(404);
      expect((await api(app, hrB).get('/recruitment/crm/candidates')).body.total).toBe(0);
      const all = await api(app, owner).get('/recruitment/crm/candidates?q=kunal');
      expect(all.body.rows.map((r: { id: string }) => r.id)).toContain(kunal);
      expect((await api(app, hrA).put(`/recruitment/crm/candidates/${kunal}/share`).send({ hrWorkspaceIds: [spaceB] })).status).toBe(403);
      const share = await api(app, owner).put(`/recruitment/crm/candidates/${kunal}/share`).send({ hrWorkspaceIds: [spaceB] });
      expect(share.status, JSON.stringify(share.body)).toBe(200);
      expect((await api(app, hrB).get(`/recruitment/crm/candidates/${kunal}`)).status).toBe(200);
      await api(app, owner).put(`/recruitment/crm/candidates/${kunal}/share`).send({ hrWorkspaceIds: [] });
      expect((await api(app, hrB).get(`/recruitment/crm/candidates/${kunal}`)).status).toBe(404);
    });

    it('filters and sorts the list', async () => {
      const r = await api(app, hrA).get('/recruitment/crm/candidates?minExp=5&maxNotice=30&skills=sql&source=linkedin&referenceType=employee_referral');
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.rows).toEqual([expect.objectContaining({ id: kunal, experience: '6 years 4 months', notice: '30 Days', reference: 'Priya Nair · Employee Referral', currentCtcText: '₹12 L' })]);
      expect((await api(app, hrA).get('/recruitment/crm/candidates?minExp=7')).body.total).toBe(0);
      expect((await api(app, hrA).get('/recruitment/crm/candidates?minCtc=1300000')).body.total).toBe(0);
      expect((await api(app, hrA).get('/recruitment/crm/candidates?q=98200')).body.total).toBe(2);
    });

    it('changes the record: sections, sensitive details only with the power, and assignment with a notice', async () => {
      const sens = await api(app, hrA).patch(`/recruitment/crm/candidates/${kunal}`).send({ gender: 'male' });
      expect(sens.status).toBe(403);
      expect(sens.body.error.code).toBe('crm_cap_missing');
      const up = await api(app, hrA).patch(`/recruitment/crm/candidates/${kunal}`).send({ industry: 'Market Research', notice: { period: 'immediate' } });
      expect(up.status, JSON.stringify(up.body)).toBe(200);
      expect(up.body.changed).toEqual(expect.arrayContaining(['industry', 'notice', 'notice_days']));
      const p = (await api(app, hrA).get(`/recruitment/crm/candidates/${kunal}`)).body.candidate;
      expect(p).toMatchObject({ industry: 'Market Research', noticeDays: 0, tags: [], primarySkills: ['SQL', 'Python'] });
      const ownerUp = await api(app, owner).patch(`/recruitment/crm/candidates/${kunal}`).send({ gender: 'male', dateOfBirth: '1994-04-15' });
      expect(ownerUp.status).toBe(200);
      expect((await api(app, owner).get(`/recruitment/crm/candidates/${kunal}`)).body.candidate).toMatchObject({ gender: 'male', sensitiveHidden: false });
      expect((await api(app, hrA).get(`/recruitment/crm/candidates/${kunal}`)).body.candidate.gender).toBeUndefined();

      const assign = await api(app, owner).post(`/recruitment/crm/candidates/${kunal}/assign`).send({ membershipId: hrAMember });
      expect(assign.status, JSON.stringify(assign.body)).toBe(200);
      const n = await pool.find('notifications', { tenant_id: t.id, membership_id: hrAMember, kind: 'candidate.assigned' });
      expect(n).toHaveLength(1);
    });

    it('moves through the pipeline, and the move is on the timeline', async () => {
      const bad = await api(app, hrA).post(`/recruitment/crm/candidates/${kunal}/stage`).send({ stage: 'nowhere' });
      expect(bad.status).toBe(400);
      const r = await api(app, hrA).post(`/recruitment/crm/candidates/${kunal}/stage`).send({ stage: 'screening', note: 'Phone screen booked' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const p = (await api(app, hrA).get(`/recruitment/crm/candidates/${kunal}`)).body;
      expect(p.candidate).toMatchObject({ stage: 'screening', stageLabel: 'Screening' });
      expect(p.activities[0]).toMatchObject({ kind: 'stage_changed', text: 'Moved from New Candidate to Screening' });
      expect(p.remarks[0]).toMatchObject({ body: 'Phone screen booked' });
      const pipe = await api(app, hrA).get('/recruitment/crm/pipeline');
      expect(pipe.body.stages.find((s: { key: string }) => s.key === 'screening')).toMatchObject({ count: 1, candidates: [expect.objectContaining({ id: kunal })] });
    });
  });

  describe('remarks, references, activities and follow-ups', () => {
    it('adds dated remarks; restricted ones need the power', async () => {
      expect((await api(app, hrA).post(`/recruitment/crm/candidates/${kunal}/remarks`).send({ body: 'Salary flexible', category: 'salary', restricted: true })).status).toBe(403);
      expect((await api(app, owner).post(`/recruitment/crm/candidates/${kunal}/remarks`).send({ body: 'Counter-offer risk', category: 'observations', restricted: true })).status).toBe(201);
      expect((await api(app, hrA).post(`/recruitment/crm/candidates/${kunal}/remarks`).send({ body: 'Wants 16 LPA', category: 'salary' })).status).toBe(201);
      const asA = (await api(app, hrA).get(`/recruitment/crm/candidates/${kunal}`)).body.remarks.map((r: { body: string }) => r.body);
      expect(asA).toContain('Wants 16 LPA');
      expect(asA).not.toContain('Counter-offer risk');
      expect((await api(app, owner).get(`/recruitment/crm/candidates/${kunal}`)).body.remarks.map((r: { body: string }) => r.body)).toContain('Counter-offer risk');
    });

    it('adds and removes references, keeping the reference-type filter right', async () => {
      const r = await api(app, hrA).post(`/recruitment/crm/candidates/${kunal}/references`).send({ type: 'client_reference', name: 'Rhea Client', company: 'Globex' });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect((await api(app, hrA).get('/recruitment/crm/candidates?referenceType=client_reference')).body.total).toBe(1);
      expect((await api(app, hrA).delete(`/recruitment/crm/references/${r.body.id}`)).status).toBe(200);
      expect((await api(app, hrA).get('/recruitment/crm/candidates?referenceType=client_reference')).body.total).toBe(0);
    });

    it('logs a call with its outcome and schedules the next follow-up in the same step', async () => {
      expect((await api(app, hrA).post(`/recruitment/crm/candidates/${kunal}/activities`).send({ type: 'call' })).status).toBe(422);
      const r = await api(app, hrA).post(`/recruitment/crm/candidates/${kunal}/activities`).send({
        type: 'call', outcome: 'call_back', durationMinutes: 4, remarks: 'Asked to call after 6 pm', nextFollowUpAt: inHours(30), nextFollowUpType: 'second_call',
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.followUpId).toBeTruthy();
      const acts = await api(app, hrA).get('/recruitment/crm/activities');
      expect(acts.body.rows[0]).toMatchObject({ kind: 'call', outcomeLabel: 'Call Back Requested', candidateCode: kunalCode });
      expect(acts.body.calls).toEqual([expect.objectContaining({ outcome: 'call_back', count: 1 })]);
      expect((await api(app, hrB).get('/recruitment/crm/activities')).body.total).toBe(0);
    });

    it('schedules, reminds, reschedules and completes follow-ups', async () => {
      const f = await api(app, hrA).post(`/recruitment/crm/candidates/${kunal}/follow-ups`).send({ type: 'salary_discussion', dueAt: inHours(0.25), priority: 'high', reminderMinutes: 30 });
      expect(f.status, JSON.stringify(f.body)).toBe(201);
      const list = await api(app, hrA).get('/recruitment/crm/follow-ups?bucket=open');
      expect(list.body.counts.open).toBe(2);
      expect(list.body.rows[0]).toMatchObject({ id: f.body.id, typeLabel: 'Salary Discussion', candidateName: 'Kunal Sharma', assignedMembershipId: hrAMember });
      const row = (await api(app, hrA).get('/recruitment/crm/candidates?followUp=any')).body.rows[0];
      expect(new Date(row.nextFollowUpAt).getTime()).toBe(new Date(f.body.dueAt).getTime());

      // The reminder goes out once.
      const jobs = app.get(CrmJobsService);
      expect(await jobs.runTenant(t.id)).toBe(1);
      expect(await jobs.runTenant(t.id)).toBe(0);
      expect(await pool.find('notifications', { tenant_id: t.id, membership_id: hrAMember, kind: 'candidate.follow_up_reminder' })).toHaveLength(1);
      // Due now and overdue notices, for one that is past.
      await pool.update('candidate_follow_ups', { id: f.body.id }, { $set: { due_at: new Date(Date.now() - 3 * 86_400_000) } });
      await jobs.runTenant(t.id);
      expect(await pool.find('notifications', { tenant_id: t.id, membership_id: hrAMember, kind: 'candidate.follow_up_overdue' })).toHaveLength(1);
      expect((await api(app, hrA).get('/recruitment/crm/follow-ups?bucket=overdue')).body.counts.overdue).toBe(1);

      const bad = await api(app, hrA).patch(`/recruitment/crm/follow-ups/${f.body.id}`).send({ status: 'rescheduled' });
      expect(bad.status).toBe(422);
      const moved = await api(app, hrA).patch(`/recruitment/crm/follow-ups/${f.body.id}`).send({ dueAt: inHours(48) });
      expect(moved.body.status).toBe('rescheduled');
      const done = await api(app, hrA).patch(`/recruitment/crm/follow-ups/${f.body.id}`).send({ status: 'completed', outcome: 'Agreed 15 LPA' });
      expect(done.body.status).toBe('completed');
      const p = (await api(app, hrA).get(`/recruitment/crm/candidates/${kunal}`)).body;
      expect(p.activities.map((x: { kind: string }) => x.kind)).toEqual(expect.arrayContaining(['follow_up_scheduled', 'follow_up_completed', 'follow_up_changed']));
      expect((await api(app, hrA).patch(`/recruitment/crm/follow-ups/${f.body.id}`).send({ status: 'cancelled' })).status).toBe(409);
    });
  });

  describe('documents', () => {
    it('uploads, versions, opens and deletes documents (deleting needs the power)', async () => {
      const up = await api(app, hrA).post(`/recruitment/crm/candidates/${kunal}/documents`).field('kind', 'resume').field('name', 'CV 2026').attach('file', PDF, { filename: 'kunal.pdf', contentType: 'application/pdf' });
      expect(up.status, JSON.stringify(up.body)).toBe(201);
      const fake = await api(app, hrA).post(`/recruitment/crm/candidates/${kunal}/documents`).attach('file', Buffer.from('not a pdf'), { filename: 'x.pdf', contentType: 'application/pdf' });
      expect(fake.status).toBe(400);
      const v2 = await api(app, hrA).post(`/recruitment/crm/documents/${up.body.id}/replace`).attach('file', PDF, { filename: 'kunal-v2.pdf', contentType: 'application/pdf' });
      expect(v2.status, JSON.stringify(v2.body)).toBe(201);
      expect(v2.body.version).toBe(2);
      const docs = (await api(app, hrA).get(`/recruitment/crm/candidates/${kunal}`)).body.documents;
      expect(docs).toEqual([expect.objectContaining({ id: v2.body.id, name: 'CV 2026', version: 2, kindLabel: 'Resume / CV', versions: [expect.objectContaining({ id: up.body.id, version: 1 })] })]);
      const open = await api(app, hrA).get(`/recruitment/crm/documents/${v2.body.id}?inline=1`);
      expect(open.status).toBe(200);
      expect(open.headers['content-disposition']).toMatch(/^inline/);
      expect((await api(app, hrB).get(`/recruitment/crm/documents/${v2.body.id}`)).status).toBe(404);
      expect((await api(app, hrA).delete(`/recruitment/crm/documents/${v2.body.id}`)).status).toBe(403);
      const del = await api(app, owner).delete(`/recruitment/crm/documents/${v2.body.id}`);
      expect(del.body).toEqual({ deleted: 2 });
      expect((await api(app, hrA).get(`/recruitment/crm/candidates/${kunal}`)).body.documents).toEqual([]);
    });
  });

  describe('custom fields', () => {
    it('lets an HR Workspace with the power add its own field, used only on its candidates', async () => {
      expect((await api(app, hrB).post('/recruitment/crm/fields').send({ label: 'Shift OK', type: 'yes_no' })).status).toBe(403);
      const f = await api(app, hrA).post('/recruitment/crm/fields').send({ label: 'Hiring Track', type: 'searchable_dropdown', required: true, options: [{ value: 'campus', label: 'Campus' }, { value: 'lateral', label: 'Lateral' }], flags: ['form', 'profile', 'filter', 'import', 'export'] });
      expect(f.status, JSON.stringify(f.body)).toBe(201);
      const missing = await api(app, hrA).post('/recruitment/crm/candidates').send({ firstName: 'Neha', email: 'neha@example.com', lawfulBasisConfirmed: true });
      expect(missing.status).toBe(422);
      expect(missing.body.error.details).toEqual([expect.objectContaining({ path: 'customFields.hiring_track' })]);
      const ok = await api(app, hrA).post('/recruitment/crm/candidates').send({ firstName: 'Neha', email: 'neha@example.com', customFields: { hiring_track: 'lateral' }, lawfulBasisConfirmed: true });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      expect((await api(app, hrA).get('/recruitment/crm/candidates?cf.hiring_track=lateral')).body.rows.map((r: { id: string; custom: Record<string, string> }) => [r.id, r.custom.hiring_track])).toEqual([[ok.body.id, 'Lateral']]);
      // Delhi Hiring never sees it, and is not asked for it.
      expect((await api(app, hrB).get('/recruitment/crm/fields')).body.fields.map((x: { name: string }) => x.name)).not.toContain('hiring_track');
      expect((await api(app, hrB).post('/recruitment/crm/candidates').send({ firstName: 'Dev', email: 'dev@example.com', lawfulBasisConfirmed: true })).status).toBe(201);
    });
  });

  describe('import and export', () => {
    it('imports a CSV: maps columns, checks rows, spots duplicates, imports and reports problems', async () => {
      const csv = [
        'Candidate Name,Email ID,Mobile,Experience,Current CTC,Notice Period,Source,Hiring Track',
        'Ravi Kumar,ravi@example.com,+91 99000 11111,4.5 yrs,6 LPA,2 months,Job Portal,Campus',
        'Kunal Sharma,kunal.sharma@example.com,,7,14 L,Immediate,LinkedIn,Lateral',
        'No Contact,,,,,,,Campus',
        'Meera Iyer,meera@,+91 99000 22222,3,abc,30 days,Walk-in,Campus',
      ].join('\n');
      const up = await api(app, hrA).post('/recruitment/crm/imports').attach('file', Buffer.from(csv), { filename: 'candidates.csv', contentType: 'text/csv' });
      expect(up.status, JSON.stringify(up.body)).toBe(201);
      expect(up.body.rowCount).toBe(4);
      expect(up.body.mapping.fields).toMatchObject({ 'Candidate Name': 'fullName', 'Email ID': 'email', Mobile: 'phone', Experience: 'totalExperienceMonths', 'Current CTC': 'currentCtc', 'Notice Period': 'notice', Source: 'source', 'Hiring Track': 'cf:hiring_track' });
      const plan = { mapping: up.body.mapping.fields, duplicateAction: 'review', defaults: { stage: 'contact_pending' }, saveTemplate: 'Job portal sheet' };
      const check = await api(app, hrA).post(`/recruitment/crm/imports/${up.body.id}/check`).send(plan);
      expect(check.status, JSON.stringify(check.body)).toBe(200);
      expect(check.body.counts).toEqual({ total: 4, ready: 1, errors: 2, duplicates: 1 });
      const meera = check.body.problems.find((p: { row: number }) => p.row === 5);
      expect(meera.errors.map((e: { column: string }) => e.column)).toEqual(expect.arrayContaining(['Email ID', 'Current CTC']));
      expect(check.body.problems.find((p: { row: number }) => p.row === 3)).toMatchObject({ status: 'duplicate', match: { id: kunal, by: 'email' } });

      expect((await api(app, hrA).post(`/recruitment/crm/imports/${up.body.id}/run`).send(plan)).status).toBe(422);
      const run = await api(app, hrA).post(`/recruitment/crm/imports/${up.body.id}/run`).send({ ...plan, lawfulBasisConfirmed: true, rowActions: { 3: 'update' } });
      expect(run.status, JSON.stringify(run.body)).toBe(200);
      expect(run.body.counts).toEqual({ total: 4, created: 1, updated: 1, skipped: 0, failed: 2 });
      expect((await api(app, hrA).post(`/recruitment/crm/imports/${up.body.id}/run`).send({ ...plan, lawfulBasisConfirmed: true })).status).toBe(409);

      const ravi = (await api(app, hrA).get('/recruitment/crm/candidates?q=ravi')).body.rows[0];
      expect(ravi).toMatchObject({ stage: 'contact_pending', experience: '4 years 6 months', currentCtcText: '₹6 L', notice: '60 Days', sourceLabel: 'Job Portal', custom: { hiring_track: 'Campus' } });
      expect(ravi.candidateCode).toMatch(/^CAN-/);
      const k = (await api(app, hrA).get(`/recruitment/crm/candidates/${kunal}`)).body.candidate;
      expect(k).toMatchObject({ totalExperienceMonths: 84, noticeText: 'Immediate' });
      expect(k.compensation).toMatchObject({ currentCtc: '1400000.00', expectedCtc: '1600000.00' });

      const report = await api(app, hrA).get(`/recruitment/crm/imports/${up.body.id}/problems.xlsx`).buffer(true);
      expect(report.status).toBe(200);
      expect(report.headers['content-type']).toContain('spreadsheetml');
      const hist = await api(app, hrA).get('/recruitment/crm/imports');
      expect(hist.body.imports[0]).toMatchObject({ fileName: 'candidates.csv', status: 'completed', counts: { created: 1, updated: 1, failed: 2 } });
      // The saved mapping is offered for the next file with these columns.
      const again = await api(app, hrA).post('/recruitment/crm/imports').attach('file', Buffer.from(csv), { filename: 'next.csv', contentType: 'text/csv' });
      expect(again.body.mapping.templateName).toBe('Job portal sheet');
      expect((await api(app, hrB).post('/recruitment/crm/imports').attach('file', Buffer.from(csv), { filename: 'x.csv', contentType: 'text/csv' })).status).toBe(403);
    });

    it('exports the chosen columns, logs it, and keeps personal details for those allowed', async () => {
      const cols = await api(app, hrA).get('/recruitment/crm/export/columns');
      expect(cols.status, JSON.stringify(cols.body)).toBe(200);
      expect(cols.body.columns.map((c: { key: string }) => c.key)).not.toContain('gender');
      expect((await api(app, hrA).post('/recruitment/crm/export').send({ scope: 'all', columns: ['name', 'gender'] })).status).toBe(403);
      const x = await api(app, hrA).post('/recruitment/crm/export').send({ scope: 'selected', ids: [kunal], columns: ['candidateCode', 'name', 'expectedCtc', 'stage'], format: 'csv' });
      expect(x.status, JSON.stringify(x.body)).toBe(200);
      expect(x.text).toContain(`${kunalCode},Kunal Sharma,1600000,Screening`);
      expect((await api(app, hrB).post('/recruitment/crm/export').send({ scope: 'all', columns: ['name'] })).status).toBe(403);
      const log = await pool.find('candidate_exports', { tenant_id: t.id });
      expect(log).toEqual([expect.objectContaining({ scope: 'selected', rows: 1, format: 'csv' })]);
      expect((await api(app, owner).get('/recruitment/crm/export/columns')).body.history).toHaveLength(1);
    });
  });

  describe('overview, switching off and erasure', () => {
    it('counts real data on the overview, with the recruiter-wise view', async () => {
      const o = await api(app, hrA).get('/recruitment/crm/overview');
      expect(o.status, JSON.stringify(o.body)).toBe(200);
      expect(o.body.totals.candidates).toBe(4);
      expect(o.body.stages.find((s: { key: string }) => s.key === 'screening').count).toBe(1);
      expect(o.body.recruiters.find((r: { membershipId: string }) => r.membershipId === hrAMember)).toMatchObject({ assigned: 1, calls30: 1 });
      expect(o.body.weeks).toHaveLength(12);
      expect((await api(app, owner).get('/recruitment/crm/overview')).body.totals.candidates).toBe(5);
    });

    it('switching an HR Workspace off hides the CRM from it and keeps every record', async () => {
      await api(app, owner).put('/recruitment/crm/access').send({ changes: [{ key: spaceA, enabled: false, caps: ['import', 'export', 'fields'] }] });
      const r = await api(app, hrA).get('/recruitment/crm/candidates');
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('crm_not_enabled');
      expect((await api(app, owner).get(`/recruitment/crm/candidates/${kunal}`)).body.candidate.hrWorkspaceName).toBe('Mumbai Hiring');
      await api(app, owner).put('/recruitment/crm/access').send({ changes: [{ key: spaceA, enabled: true, caps: ['import', 'export', 'fields'] }] });
      expect((await api(app, hrA).get('/recruitment/crm/candidates')).body.total).toBe(4);
    });

    it('archives with the power, and erases personal data including the CRM profile', async () => {
      expect((await api(app, hrA).post(`/recruitment/crm/candidates/${kunal}/archive`).send({ archived: true })).status).toBe(403);
      expect((await api(app, owner).post(`/recruitment/crm/candidates/${kunal}/archive`).send({ archived: true })).body).toEqual({ archived: true });
      expect((await api(app, hrA).get('/recruitment/crm/candidates?q=kunal')).body.total).toBe(0);
      expect((await api(app, hrA).get('/recruitment/crm/candidates?q=kunal&archived=only')).body.total).toBe(1);
      const e = await api(app, owner).post(`/recruitment/crm/candidates/${kunal}/erase`).send({ reason: 'Candidate asked us to delete their data' });
      expect(e.body).toEqual({ erased: true });
      const row = await pool.one('candidates', { id: kunal });
      expect(row).toMatchObject({ email: null, phone: null, personal: {}, compensation: {}, current_ctc: null, skills: [] });
      expect(await pool.find('candidate_references', { candidate_id: kunal })).toHaveLength(0);
      expect(await pool.find('candidate_notes', { candidate_id: kunal })).toHaveLength(0);
    });
  });
});
