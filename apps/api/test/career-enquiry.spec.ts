import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/platform/auth/crypto';
import { currentTotp } from '../src/platform/auth/mfa';
import { CareerJobsService } from '../src/modules/career-enquiry/career-jobs.service';
import { CareerSyncService } from '../src/modules/career-enquiry/career-sync.service';
import { addMember, adminPool, api, createApp, createTenant, login, loginWithMfa, PASSWORD, type TestDb, type TestTenant } from './helpers';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

/**
 * Career Enquiry through the HTTP API, against a stand-in for the Frequent Research website: the website's own
 * connector payload (POST {SAMPCREW_API_URL}/candidates with a Bearer key), the CV fetched from its signed link, the
 * status sent back to its webhook signed with HMAC-SHA256, duplicates, retries, access per HR Workspace, calls,
 * interviews, Move to Candidate CRM without a second record, and the Console's health view.
 */
describe('Career Enquiry', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let owner: string;
  let hrA: string;
  let hrAMember: string;
  let staff: string;
  let spaceA: string;
  let site: Server;
  let siteUrl: string;
  let intakeUrl: string;
  let apiKey: string;
  let secret: string;
  let webhookStatus = 200;
  const received: { body: Record<string, unknown>; signature: string; ok: boolean }[] = [];
  let firstId: string;

  const payload = (over: Record<string, unknown> = {}) => ({
    source: 'frequentresearch.com', externalId: 'web-1001', appliedAt: '2026-11-27T10:15:00.000Z', name: 'Meera Joshi', email: 'Meera.Joshi@example.com',
    phone: '98200 55511', countryCode: '+91', department: 'Data Processing', position: 'Survey Programmer', experience: '3-5', location: 'Pune',
    message: 'I have built Decipher surveys for four years.', linkedin: 'https://linkedin.com/in/meera-joshi', extra: {},
    cv: { name: 'Meera Joshi CV.pdf', size: PDF.length, url: '' },
    ...over,
  });
  const send = (body: unknown, key = apiKey) => api(app).post(`${intakeUrl.replace(/^.*\/api\/v1/, '')}/candidates`).set('authorization', `Bearer ${key}`).send(body as object);
  const sync = () => app.get(CareerSyncService);

  beforeAll(async () => {
    site = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.method === 'GET' && req.url?.startsWith('/files/cv.pdf')) {
          res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="cv.pdf"' });
          return res.end(PDF);
        }
        if (req.method === 'GET' && req.url?.startsWith('/files/missing')) {
          res.writeHead(404);
          return res.end();
        }
        if (req.method === 'POST' && req.url === '/api/v1/integrations/sampcrew/webhook') {
          const raw = Buffer.concat(chunks);
          const signature = String(req.headers['x-sampcrew-signature'] ?? '');
          const ok = !!secret && signature === createHmac('sha256', secret).update(raw).digest('hex');
          received.push({ body: JSON.parse(raw.toString('utf8')), signature, ok });
          res.writeHead(ok ? webhookStatus : 401, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ok, matched: 1 }));
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    const a = await addMember(pool, t, { name: 'Asha Recruiter' });
    const s = await addMember(pool, t, { name: 'Sam Staff' });
    hrAMember = a.membershipId;
    const wa = await api(app, owner).post('/hr-workspaces').send({ name: 'Pune Hiring', features: ['recruitment'], adminMembershipIds: [a.membershipId] });
    expect(wa.status, JSON.stringify(wa.body)).toBe(201);
    spaceA = wa.body.id;
    hrA = (await loginWithMfa(app, pool, a.email)).accessToken;
    staff = (await login(app, s.email)).accessToken;
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
    await new Promise<void>((r) => site.close(() => r()));
  });

  describe('Career Integration settings', () => {
    it('Super Workspace connects the website; keys are shown once and only their hash and an encrypted secret are kept', async () => {
      const empty = await api(app, owner).get('/career-enquiry/settings');
      expect(empty.status, JSON.stringify(empty.body)).toBe(200);
      expect(empty.body.integration).toBeNull();
      expect(empty.body.stages).toHaveLength(12);

      const save = await api(app, owner).put('/career-enquiry/settings/integration').send({ websiteName: 'Frequent Research', websiteUrl: siteUrl, enabled: true, sendStatusUpdates: true });
      expect(save.status, JSON.stringify(save.body)).toBe(200);
      expect(save.body).toMatchObject({ websiteName: 'Frequent Research', hasApiKey: false, status: 'not_connected', statusWebhookUrl: `${siteUrl}/api/v1/integrations/sampcrew/webhook` });
      expect(save.body.endpoint).toMatch(/\/api\/v1\/public\/career-intake\/[0-9a-f-]{36}\/candidates$/);

      const keys = await api(app, owner).post('/career-enquiry/settings/keys');
      expect(keys.status, JSON.stringify(keys.body)).toBe(200);
      expect(keys.body.websiteKeys.map((k: { name: string }) => k.name)).toEqual(['SAMPCREW_API_URL', 'SAMPCREW_API_KEY', 'SAMPCREW_WEBHOOK_SECRET']);
      intakeUrl = keys.body.apiUrl;
      apiKey = keys.body.apiKey;
      secret = keys.body.webhookSecret;
      expect(apiKey).toMatch(/^scce_/);
      expect(secret).toMatch(/^scwh_/);

      const after = await api(app, owner).get('/career-enquiry/settings');
      expect(JSON.stringify(after.body)).not.toContain(apiKey);
      expect(JSON.stringify(after.body)).not.toContain(secret);
      expect(after.body.integration).toMatchObject({ hasApiKey: true, hasWebhookSecret: true, status: 'waiting' });
      const row = await pool.one('career_integrations', { tenant_id: t.id });
      expect(JSON.stringify(row)).not.toContain(apiKey);
      expect(JSON.stringify(row)).not.toContain(secret);
    });

    it('tests the connection with a signed request the website accepts', async () => {
      const r = await api(app, owner).post('/career-enquiry/settings/test');
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.ok, JSON.stringify(r.body)).toBe(true);
      expect(received.at(-1)).toMatchObject({ ok: true, body: { externalId: 'sampcrew-connection-test' } });
    });

    it('only Super Workspace reaches the settings; Employee Workspace never sees Career Enquiry', async () => {
      expect((await api(app, hrA).put('/career-enquiry/settings/integration').send({ websiteName: 'Someone else', websiteUrl: siteUrl })).status).toBe(403);
      const emp = await api(app, staff).get('/career-enquiry/applications');
      expect(emp.status).toBe(403);
      expect((await api(app, staff).get('/me')).body.careerEnquiry).toBe(false);
      expect((await api(app, owner).get('/me')).body.careerEnquiry).toBe(true);
    });
  });

  describe('receiving from the website', () => {
    it('refuses a wrong key and an incomplete application', async () => {
      const bad = await send(payload(), 'scce_wrong');
      expect(bad.status).toBe(401);
      const none = await api(app).post(`${intakeUrl.replace(/^.*\/api\/v1/, '')}/candidates`).send(payload());
      expect(none.status).toBe(401);
      const incomplete = await send(payload({ externalId: 'web-bad', name: '', email: 'not-an-email', phone: '' }));
      expect(incomplete.status).toBe(422);
      expect(incomplete.body.error.code).toBe('application_incomplete');
    });

    it('takes the website payload, answers with an Application ID, and fetches the CV from the signed link', async () => {
      const r = await send(payload({ cv: { name: 'Meera Joshi CV.pdf', size: PDF.length, url: `${siteUrl}/files/cv.pdf?sig=abc` } }));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body).toMatchObject({ ok: true, stage: 'applied', duplicate: false });
      expect(r.body.id).toMatch(/^CE-\d{6}$/);
      firstId = r.body.applicationId;

      const got = await api(app, owner).get(`/career-enquiry/applications/${firstId}`);
      expect(got.status, JSON.stringify(got.body)).toBe(200);
      expect(got.body.application).toMatchObject({ code: r.body.id, name: 'Meera Joshi', email: 'meera.joshi@example.com', phone: '+91 98200 55511', stage: 'new_application', inCrm: false, cvState: 'stored' });
      expect(got.body.cv).toMatchObject({ fileName: 'Meera Joshi CV.pdf', contentType: 'application/pdf', previewable: true });
      // Only what the candidate gave is shown: no portfolio or notice period was sent.
      expect(got.body.personal.map((p: { key: string }) => p.key)).toEqual(['fullName', 'email', 'phone', 'location', 'linkedin', 'totalExperience']);

      const file = await api(app, owner).get(`/career-enquiry/applications/${firstId}/files/${got.body.cv.id}?inline=1`);
      expect(file.status).toBe(200);
      expect(file.headers['content-type']).toContain('application/pdf');
    });

    it('answers the same website application sent again with the one already received', async () => {
      const again = await send(payload());
      expect(again.status).toBe(201);
      expect(again.body).toMatchObject({ applicationId: firstId, duplicate: true });
      expect(await pool.count('career_applications', { tenant_id: t.id })).toBe(1);
    });

    it('keeps one candidate per person: a second application by the same email links to the same candidate', async () => {
      const second = await send(payload({ externalId: 'web-1002', position: 'Data Analyst', email: 'meera.joshi@example.com', cv: { name: 'cv.pdf', url: '', content: PDF.toString('base64') } }));
      expect(second.status, JSON.stringify(second.body)).toBe(201);
      expect(second.body.duplicate).toBe(false);
      const a1 = await pool.one('career_applications', { id: firstId });
      const a2 = await pool.one('career_applications', { id: second.body.applicationId });
      expect(a2!.candidate_id).toBe(a1!.candidate_id);
      expect(a2!.cv_state).toBe('stored');
      expect(await pool.count('candidates', { tenant_id: t.id, email: 'meera.joshi@example.com' })).toBe(1);
      const prof = await api(app, owner).get(`/career-enquiry/applications/${firstId}`);
      expect(prof.body.otherApplications).toHaveLength(1);
    });

    it('a website applicant is not in the Candidate CRM until moved, and the CRM points to Career Enquiry instead of duplicating', async () => {
      const crm = await api(app, owner).get('/recruitment/crm/candidates');
      expect(crm.status, JSON.stringify(crm.body)).toBe(200);
      expect(JSON.stringify(crm.body)).not.toContain('meera.joshi@example.com');
      const dup = await api(app, owner).post('/recruitment/crm/candidates').send({ firstName: 'Meera', lastName: 'Joshi', email: 'meera.joshi@example.com', source: 'linkedin', lawfulBasisConfirmed: true });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('candidate_in_career_enquiry');
    });

    it('retries a CV whose link fails and marks the job failed after the last attempt', async () => {
      const r = await send(payload({ externalId: 'web-1003', name: 'Ravi Kumar', email: 'ravi.kumar@example.com', phone: '', cv: { name: 'ravi.pdf', url: `${siteUrl}/files/missing.pdf` } }));
      expect(r.status).toBe(201);
      const job = await pool.one('career_sync_jobs', { tenant_id: t.id, direction: 'cv', status: { $in: ['pending', 'failed'] } });
      expect(job).toBeTruthy();
      expect(job!.last_error).toContain('404');
      for (let i = 0; i < 6; i++) {
        await pool.update('career_sync_jobs', { id: job!.id, status: 'pending' }, { $set: { next_attempt_at: new Date(0) } });
        await sync().runDue();
      }
      const done = await pool.one('career_sync_jobs', { id: job!.id });
      expect(done!.status).toBe('failed');
      expect((await pool.one('career_applications', { id: r.body.applicationId }))!.cv_state).toBe('failed');
      const log = await api(app, owner).get('/career-enquiry/settings/log?status=failed');
      expect(log.body.rows.some((x: { id: string }) => x.id === job!.id)).toBe(true);
      const retry = await api(app, owner).post('/career-enquiry/settings/retry').send({ jobIds: [job!.id] });
      expect(retry.status, JSON.stringify(retry.body)).toBe(200);
      expect((await pool.one('career_sync_jobs', { id: job!.id }))!.status).toBe('pending');
    });
  });

  describe('working an application', () => {
    it('moves through the pipeline with history and sends each change back to the website, signed', async () => {
      received.length = 0;
      const r = await api(app, owner).post(`/career-enquiry/applications/${firstId}/status`).send({ stage: 'shortlisted', comment: 'Strong Decipher skills' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      await sync().runDue();
      expect(received.at(-1)).toMatchObject({ ok: true, body: { externalId: 'web-1001', stage: 'shortlisted', status: 'shortlisted' } });
      const got = await api(app, owner).get(`/career-enquiry/applications/${firstId}`);
      expect(got.body.application.websiteStage).toBe('shortlisted');
      expect(got.body.history.find((h: { kind: string }) => h.kind === 'status_changed')).toMatchObject({ from: 'New Application', to: 'Shortlisted', comment: 'Strong Decipher skills' });

      const unknown = await api(app, owner).post(`/career-enquiry/applications/${firstId}/status`).send({ stage: 'nope' });
      expect(unknown.status).toBe(422);
    });

    it('retries a status update the website refused, then delivers it', async () => {
      webhookStatus = 503;
      await api(app, owner).post(`/career-enquiry/applications/${firstId}/status`).send({ stage: 'under_review' });
      await sync().runDue();
      const job = await pool.one('career_sync_jobs', { tenant_id: t.id, direction: 'outbound', status: 'pending' });
      expect(job, 'outbound job waits for a retry').toBeTruthy();
      expect(job!.attempts).toBe(1);
      webhookStatus = 200;
      await pool.update('career_sync_jobs', { id: job!.id }, { $set: { next_attempt_at: new Date(0) } });
      await sync().runDue();
      expect((await pool.one('career_sync_jobs', { id: job!.id }))!.status).toBe('succeeded');
    });

    it('logs calls with outcome, duration and a follow-up; notes, assignment and email', async () => {
      const call = await api(app, owner).post(`/career-enquiry/applications/${firstId}/calls`).send({ outcome: 'call_back', durationMinutes: 4, notes: 'Asked to call after 6 pm', nextFollowUpAt: inHours(5) });
      expect(call.status, JSON.stringify(call.body)).toBe(201);
      const note = await api(app, owner).post(`/career-enquiry/applications/${firstId}/notes`).send({ kind: 'comment', body: 'Good communication' });
      expect(note.status, JSON.stringify(note.body)).toBe(201);
      await api(app, owner).post(`/career-enquiry/applications/${firstId}/notes`).send({ kind: 'internal', body: 'Salary expectation is high' });
      const assign = await api(app, owner).post(`/career-enquiry/applications/${firstId}/assign`).send({ hrWorkspaceId: spaceA, recruiterMembershipId: hrAMember });
      expect(assign.status, JSON.stringify(assign.body)).toBe(200);
      const mail = await api(app, owner).post(`/career-enquiry/applications/${firstId}/email`).send({ subject: 'Your application', body: 'Thanks for applying, Meera.' });
      expect(mail.status, JSON.stringify(mail.body)).toBe(202);

      const got = await api(app, owner).get(`/career-enquiry/applications/${firstId}`);
      expect(got.body.calls[0]).toMatchObject({ outcome: 'call_back', durationMinutes: 4, notes: 'Asked to call after 6 pm' });
      expect(got.body.followUps).toHaveLength(1);
      expect(got.body.notes).toHaveLength(2);
      expect(got.body.emails[0].subject).toBe('Your application');
      expect(got.body.application).toMatchObject({ recruiterMembershipId: hrAMember, hrWorkspaceId: spaceA });
      // The recruiter was told.
      expect(await pool.count('notifications', { tenant_id: t.id, membership_id: hrAMember, kind: { $regex: '^career\\.' } })).toBeGreaterThan(0);
    });

    it('schedules, reschedules and completes an interview, with a reminder an hour before', async () => {
      const s = await api(app, owner).post(`/career-enquiry/applications/${firstId}/interviews`).send({ startsAt: inHours(0.5), type: 'video', interviewerMembershipId: hrAMember, meetingLink: 'https://meet.example.com/abc' });
      expect(s.status, JSON.stringify(s.body)).toBe(201);
      expect((await pool.one('career_applications', { id: firstId }))!.stage).toBe('interview_scheduled');
      const sent = await app.get(CareerJobsService).runTenant(t.id);
      expect(sent).toBeGreaterThan(0);
      expect(await app.get(CareerJobsService).runTenant(t.id)).toBe(0);

      const re = await api(app, owner).post(`/career-enquiry/applications/${firstId}/interviews/${s.body.id}`).send({ action: 'reschedule', startsAt: inHours(26), reason: 'Candidate travelling' });
      expect(re.status, JSON.stringify(re.body)).toBe(200);
      const done = await api(app, owner).post(`/career-enquiry/applications/${firstId}/interviews/${s.body.id}`).send({ action: 'complete', feedback: 'Solid' });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      const got = await api(app, owner).get(`/career-enquiry/applications/${firstId}`);
      expect(got.body.interviews[0]).toMatchObject({ status: 'completed', feedback: 'Solid', rescheduled: 1 });
      const list = await api(app, owner).get('/career-enquiry/interviews?when=past');
      expect(list.status, JSON.stringify(list.body)).toBe(200);
    });
  });

  describe('access per HR Workspace', () => {
    it('an HR Workspace sees nothing until Super Workspace switches it on, then only its own applications and powers', async () => {
      const off = await api(app, hrA).get('/career-enquiry/context');
      expect(off.status).toBe(403);
      expect(off.body.error.code).toBe('career_not_enabled');

      const on = await api(app, owner).put('/career-enquiry/access').send({ changes: [{ key: spaceA, enabled: true, scope: 'all', caps: ['manage'] }] });
      expect(on.status, JSON.stringify(on.body)).toBe(200);
      expect((await api(app, hrA).get('/me')).body.careerEnquiry).toBe(true);

      const list = await api(app, hrA).get('/career-enquiry/applications');
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      expect(list.body.rows.map((r: { id: string }) => r.id)).toEqual([firstId]);

      const prof = await api(app, hrA).get(`/career-enquiry/applications/${firstId}`);
      expect(prof.body.cv).toBeNull();
      expect(prof.body.can).toMatchObject({ manage: true, cv: false, contact: false, crm: false });
      expect((await api(app, hrA).post(`/career-enquiry/applications/${firstId}/calls`).send({ outcome: 'connected' })).status).toBe(403);
      expect((await api(app, hrA).post(`/career-enquiry/applications/${firstId}/move-to-crm`)).status).toBe(403);

      const other = await pool.one('career_applications', { tenant_id: t.id, id: { $ne: firstId } });
      expect((await api(app, hrA).get(`/career-enquiry/applications/${other!.id}`)).status).toBe(404);
    });
  });

  describe('Move to Candidate CRM', () => {
    it('moves the same candidate record in with its CV, history and notes, keeping the Application ID, and never twice', async () => {
      const app1 = (await pool.one('career_applications', { id: firstId }))!;
      const m = await api(app, owner).post(`/career-enquiry/applications/${firstId}/move-to-crm`);
      expect(m.status, JSON.stringify(m.body)).toBe(200);
      const cand = (await pool.one('candidates', { id: app1.candidate_id }))!;
      expect(cand.career_only).toBe(false);
      expect(await pool.count('candidates', { tenant_id: t.id, email: 'meera.joshi@example.com' })).toBe(1);

      const crm = await api(app, owner).get(`/recruitment/crm/candidates/${cand.id}`);
      expect(crm.status, JSON.stringify(crm.body)).toBe(200);
      expect(JSON.stringify(crm.body)).toContain(app1.code as string);
      expect(JSON.stringify(crm.body)).toContain('Good communication');

      const again = await api(app, owner).post(`/career-enquiry/applications/${firstId}/move-to-crm`);
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('already_in_crm');
      expect((await api(app, owner).get(`/career-enquiry/applications/${firstId}`)).body.crm).toMatchObject({ inCrm: true });
    });
  });

  describe('dashboard and reports', () => {
    it('counts the summary cards, the pipeline and the trend, and exports CSV', async () => {
      const d = await api(app, owner).get('/career-enquiry/dashboard');
      expect(d.status, JSON.stringify(d.body)).toBe(200);
      const card = (k: string) => d.body.cards.find((c: { key: string }) => c.key === k)?.count;
      expect(card('total')).toBe(3);
      expect(card('new')).toBe(2);
      expect(d.body.pipeline.length).toBeGreaterThanOrEqual(12);
      expect(d.body.recent.length).toBe(3);

      const filtered = await api(app, owner).get('/career-enquiry/dashboard?position=Data%20Analyst');
      expect(filtered.body.cards.find((c: { key: string }) => c.key === 'total').count).toBe(1);

      const csv = await api(app, owner).get('/career-enquiry/applications/export.csv');
      expect(csv.status).toBe(200);
      expect(csv.text).toContain('Meera Joshi');
      expect(csv.text).toContain('Ravi Kumar');
    });
  });

  describe('Console', () => {
    it('shows each company’s integration health without candidate details, and retries failed jobs', async () => {
      const email = `career.${Date.now()}@sampledge.test`;
      await pool.insert('platform_admins', { email, full_name: 'Career admin', password_hash: await hashPassword(PASSWORD), role: 'super_admin' });
      const res = await api(app).post('/platform/auth/login').send({ email, password: PASSWORD });
      const setup = await api(app, res.body.accessToken).post('/platform/auth/mfa/setup');
      const token = (await api(app, res.body.accessToken).post('/platform/auth/mfa/enable').send({ code: currentTotp(setup.body.secret) })).body.accessToken;
      const list = await api(app, token).get('/platform/career-integrations');
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      const row = list.body.rows.find((r: { tenantId: string }) => r.tenantId === t.id);
      expect(row).toMatchObject({ websiteName: 'Frequent Research', connected: true, total: 3 });
      expect(JSON.stringify(list.body)).not.toContain('meera.joshi@example.com');
      const retry = await api(app, token).post(`/platform/career-integrations/${t.id}/retry`);
      expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    });
  });
});
