import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CandidatesService } from '../src/modules/recruitment/candidates.service';
import { addMember, adminPool, api, createApp, createTenant, department, login, loginWithMfa, type TestTenant } from './helpers';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const PRIVACY = 'We use the details you send only to consider you for this job and similar roles. We keep them for a year and you can ask us to delete them.';
const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

/** Phase 4 through the HTTP API: requisitions, the career site, the pipeline, interviews, offers and hiring. */
describe('recruitment', () => {
  let app: INestApplication;
  let pool: Pool;
  let t: TestTenant;
  let other: TestTenant;
  let engineering: string;
  let sales: string;
  const people: Record<string, { email: string; membershipId: string }> = {};
  const tokens: Record<string, string> = {};
  const as = (who: string) => api(app, tokens[who]);
  let reqId: string;
  let salesReqId: string;
  let siteSlug: string;

  const emails = async (to: string, template?: string) =>
    (await pool.query<{ subject: string; text_body: string; template: string }>(
      `select subject, text_body, template from email_messages where tenant_id = $1 and to_email = $2 ${template ? 'and template = $3' : ''} order by created_at`,
      template ? [t.id, to, template] : [t.id, to],
    )).rows;
  const approveAll = async (who: string, type: string) => {
    const inbox = await as(who).get('/approvals/inbox');
    expect(inbox.status, JSON.stringify(inbox.body)).toBe(200);
    const items = (inbox.body as { id: string; resourceType: string }[]).filter((i) => i.resourceType === type);
    for (const i of items) {
      const res = await as(who).post(`/approvals/${i.id}/approve`).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    return items.length;
  };
  const requisition = (overrides: Record<string, unknown> = {}) => ({
    title: 'Backend Engineer', legalEntityId: t.legalEntityId, departmentId: engineering, hiringManagerMembershipId: people.manager!.membershipId,
    headcount: 1, salaryMin: '1800000', salaryMax: '2400000', currency: 'INR', justification: 'Platform team growth',
    scorecard: ['Coding', 'System design', 'Communication'], ...overrides,
  });
  const openReq = async (body: Record<string, unknown>, by = 'recruiter') => {
    const created = await as(by).post('/recruitment/requisitions').send(body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await as(by).post(`/recruitment/requisitions/${created.body.id}/submit`).send({})).status).toBe(200);
    await approveAll('hr', 'job_requisition');
    expect((await as(by).post(`/recruitment/requisitions/${created.body.id}/status`).send({ action: 'open' })).body).toEqual({ status: 'open' });
    return created.body.id as string;
  };
  const publicApply = (job: string, fields: Record<string, string>, file: Buffer | null = PDF, name = 'cv.pdf', type = 'application/pdf') => {
    let r = request(app.getHttpServer()).post(`/api/v1/public/careers/${siteSlug}/jobs/${job}/apply`);
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    if (file) r = r.attach('cv', file, { filename: name, contentType: type });
    return r;
  };
  const candidateByEmail = async (email: string) => (await pool.query<{ id: string }>('select id from candidates where tenant_id = $1 and email = $2', [t.id, email])).rows[0]?.id;
  const applicationOf = async (candidateId: string, requisitionId: string) =>
    (await pool.query<{ id: string; status: string }>('select id, status from applications where candidate_id = $1 and requisition_id = $2', [candidateId, requisitionId])).rows[0]!;

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    other = await createTenant(pool);
    engineering = await department(pool, t, 'Engineering');
    sales = await department(pool, t, 'Sales');
    people.hr = await addMember(pool, t, { roles: ['hr_admin'], name: 'Hana HR' });
    people.recruiter = await addMember(pool, t, { roles: ['recruiter'], name: 'Rita Recruiter' });
    people.manager = await addMember(pool, t, { roles: ['hiring_manager'], departmentId: engineering, name: 'Manu Manager' });
    people.salesManager = await addMember(pool, t, { roles: ['hiring_manager'], departmentId: sales, name: 'Sal Sales' });
    people.panelist = await addMember(pool, t, { departmentId: engineering, name: 'Pia Panelist' });
    people.employee = await addMember(pool, t, { departmentId: engineering, name: 'Eve Employee' });
    tokens.hr = (await loginWithMfa(app, pool, people.hr.email)).accessToken;
    for (const who of ['recruiter', 'manager', 'salesManager', 'panelist', 'employee']) tokens[who] = (await login(app, people[who]!.email)).accessToken;
    siteSlug = `jobs-${t.slug}`;
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('requisitions', () => {
    it('are raised, approved by HR, opened and numbered', async () => {
      const bad = await as('recruiter').post('/recruitment/requisitions').send(requisition({ salaryMin: '3000000' }));
      expect(bad.status).toBe(422);
      const created = await as('manager').post('/recruitment/requisitions').send(requisition());
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body).toMatchObject({ status: 'draft', code: expect.stringMatching(/^REQ-\d+/), hiringManagerName: 'Manu Manager' });
      reqId = created.body.id;
      // Nothing can be opened before approval.
      expect((await as('manager').post(`/recruitment/requisitions/${reqId}/status`).send({ action: 'open' })).status).toBe(409);
      expect((await as('manager').post(`/recruitment/requisitions/${reqId}/submit`).send({})).body).toMatchObject({ status: 'pending_approval' });
      // The requester cannot approve; HR can.
      expect(((await as('manager').get('/approvals/inbox')).body as unknown[]).length).toBe(0);
      expect(await approveAll('hr', 'job_requisition')).toBe(1);
      const approved = await as('manager').get(`/recruitment/requisitions/${reqId}`);
      expect(approved.body).toMatchObject({ status: 'approved', can: { edit: true, manageCandidates: true } });
      // Budget is fixed after approval; wording is not.
      expect((await as('manager').patch(`/recruitment/requisitions/${reqId}`).send({ salaryMax: '9000000' })).status).toBe(409);
      expect((await as('manager').patch(`/recruitment/requisitions/${reqId}`).send({ description: 'Build and run the payments platform.' })).status).toBe(200);
      expect((await as('recruiter').post(`/recruitment/requisitions/${reqId}/status`).send({ action: 'open' })).body).toEqual({ status: 'open' });
      const audit = await pool.query(`select action from audit_events where tenant_id = $1 and resource_id = $2 order by chain_seq`, [t.id, reqId]);
      expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['requisition.created', 'requisition.submitted', 'requisition.approved', 'requisition.open']));
    });

    it('are scoped: a hiring manager sees their department only, a recruiter sees all, an employee none', async () => {
      salesReqId = await openReq(requisition({ title: 'Account Executive', departmentId: sales, hiringManagerMembershipId: people.salesManager!.membershipId, scorecard: ['Discovery', 'Closing'] }));
      const mine = (await as('manager').get('/recruitment/requisitions')).body as { id: string }[];
      expect(mine.map((r) => r.id)).toContain(reqId);
      expect(mine.map((r) => r.id)).not.toContain(salesReqId);
      expect((await as('manager').get(`/recruitment/requisitions/${salesReqId}`)).status).toBe(404);
      expect((await as('manager').get(`/recruitment/requisitions/${salesReqId}/pipeline`)).status).toBe(404);
      const all = (await as('recruiter').get('/recruitment/requisitions')).body as { id: string }[];
      expect(all.map((r) => r.id)).toEqual(expect.arrayContaining([reqId, salesReqId]));
      expect((await as('employee').get('/recruitment/requisitions')).status).toBe(403);
      // A hiring manager cannot raise a requisition for another department.
      expect((await as('manager').post('/recruitment/requisitions').send(requisition({ departmentId: sales }))).status).toBe(404);
    });

    it('cannot be used by a workspace without the recruitment plan', async () => {
      const starter = await createTenant(pool, { plan: 'starter' });
      const owner = (await login(app, starter.ownerEmail)).accessToken;
      const res = await api(app, owner).get('/recruitment/requisitions');
      expect(res.status).toBe(402);
    });
  });

  describe('career site', () => {
    it('is configured by recruiters and only lists published postings of open requisitions', async () => {
      expect((await as('recruiter').get('/recruitment/settings/career-site')).body).toMatchObject({ configured: false, enabled: false });
      expect((await as('manager').put('/recruitment/settings/career-site').send({ enabled: true, slug: siteSlug, headline: 'Join us', privacyNotice: PRIVACY })).status).toBe(403);
      const short = await as('recruiter').put('/recruitment/settings/career-site').send({ enabled: true, slug: siteSlug, headline: 'Join us', privacyNotice: 'Too short' });
      expect(short.status).toBe(422);
      const saved = await as('recruiter').put('/recruitment/settings/career-site').send({ enabled: true, slug: siteSlug, headline: 'Build with us', privacyNotice: PRIVACY, retentionDays: 180 });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(saved.body).toMatchObject({ enabled: true, privacyNoticeVersion: 1, retentionDays: 180 });
      // Another workspace cannot take the same address.
      const otherOwner = (await login(app, other.ownerEmail)).accessToken;
      expect((await api(app, otherOwner).put('/recruitment/settings/career-site').send({ enabled: true, slug: siteSlug, headline: 'Mine', privacyNotice: PRIVACY })).status).toBe(409);

      const posting = await as('recruiter').put(`/recruitment/requisitions/${reqId}/posting`).send({
        publicTitle: 'Backend Engineer (Payments)', slug: 'backend-engineer', summary: 'Own our payments APIs',
        description: 'You will design, build and run the services that move money for our customers.', locationText: 'Pune or remote', showSalary: true,
      });
      expect(posting.status, JSON.stringify(posting.body)).toBe(200);
      expect((await request(app.getHttpServer()).get(`/api/v1/public/careers/${siteSlug}`)).body.jobs).toEqual([]);
      expect((await as('recruiter').post(`/recruitment/requisitions/${reqId}/posting/publish`).send({})).body).toMatchObject({ published: true });
      const site = await request(app.getHttpServer()).get(`/api/v1/public/careers/${siteSlug}`);
      expect(site.status).toBe(200);
      expect(site.body).toMatchObject({ headline: 'Build with us', jobs: [expect.objectContaining({ slug: 'backend-engineer', title: 'Backend Engineer (Payments)' })] });
      // Public pages show nothing internal.
      expect(JSON.stringify(site.body)).not.toMatch(/justification|Platform team growth|hiringManager/);
      const job = await request(app.getHttpServer()).get(`/api/v1/public/careers/${siteSlug}/jobs/backend-engineer`);
      expect(job.body, JSON.stringify(job.body)).toMatchObject({ privacyNotice: PRIVACY, job: expect.objectContaining({ salaryMin: '1800000.00', salaryMax: '2400000.00' }) });
      expect((await request(app.getHttpServer()).get(`/api/v1/public/careers/${siteSlug}/jobs/nope`)).status).toBe(404);
      expect((await request(app.getHttpServer()).get('/api/v1/public/careers/no-such-site')).status).toBe(404);
    });

    it('takes applications with consent and a real CV, without revealing who already applied', async () => {
      const fields = { firstName: 'Asha', lastName: 'Rao', email: 'asha.rao@example.com', consent: 'true', coverNote: 'I built payment rails at my last job.' };
      const noConsent = await publicApply('backend-engineer', { ...fields, consent: 'false' });
      expect(noConsent.status).toBe(422);
      const noCv = await publicApply('backend-engineer', fields, null);
      expect(noCv.status).toBe(400);
      const fakePdf = await publicApply('backend-engineer', fields, Buffer.from('MZ this is an executable'), 'cv.pdf');
      expect(fakePdf.status).toBe(400);
      const ok = await publicApply('backend-engineer', fields);
      expect(ok.status, JSON.stringify(ok.body)).toBe(202);
      expect(ok.body).toEqual({ received: true });
      // Applying twice gives the same answer and creates nothing new.
      expect((await publicApply('backend-engineer', fields)).body).toEqual({ received: true });
      const cid = await candidateByEmail('asha.rao@example.com');
      expect(cid).toBeTruthy();
      expect((await pool.query('select count(*)::int as n from applications where candidate_id = $1', [cid])).rows[0].n).toBe(1);
      const c = (await pool.query('select consent_basis, privacy_notice_version, source from candidates where id = $1', [cid])).rows[0];
      expect(c).toEqual({ consent_basis: 'candidate_consent', privacy_notice_version: 1, source: 'career_site' });
      expect((await emails('asha.rao@example.com', 'candidate.received')).length).toBe(1);
      // A bot filling the hidden field gets the same answer and nothing is stored.
      const bot = await publicApply('backend-engineer', { ...fields, email: 'bot@example.com', website: 'http://spam.example' });
      expect(bot.status).toBe(202);
      expect(bot.body).toEqual({ received: true });
      expect(await candidateByEmail('bot@example.com')).toBeUndefined();
      // The hiring manager and the recruiter who raised it are told.
      const n = await pool.query(`select count(*)::int as n from notifications where tenant_id = $1 and kind = 'application.received' and membership_id = $2`, [t.id, people.manager!.membershipId]);
      expect(n.rows[0].n).toBe(1);
    });

    it('stops taking applications when the requisition is put on hold, and when the site is switched off', async () => {
      expect((await as('recruiter').post(`/recruitment/requisitions/${reqId}/status`).send({ action: 'hold' })).body).toEqual({ status: 'on_hold' });
      expect((await request(app.getHttpServer()).get(`/api/v1/public/careers/${siteSlug}/jobs/backend-engineer`)).status).toBe(404);
      expect((await as('recruiter').post(`/recruitment/requisitions/${reqId}/status`).send({ action: 'reopen' })).body).toEqual({ status: 'open' });
      expect((await as('recruiter').post(`/recruitment/requisitions/${reqId}/posting/publish`).send({})).status).toBe(200);
      await as('recruiter').put('/recruitment/settings/career-site').send({ enabled: false, slug: siteSlug, headline: 'Build with us', privacyNotice: PRIVACY, retentionDays: 180 });
      expect((await request(app.getHttpServer()).get(`/api/v1/public/careers/${siteSlug}`)).status).toBe(404);
      expect((await publicApply('backend-engineer', { firstName: 'Late', email: 'late@example.com', consent: 'true' })).status).toBe(404);
      await as('recruiter').put('/recruitment/settings/career-site').send({ enabled: true, slug: siteSlug, headline: 'Build with us', privacyNotice: PRIVACY, retentionDays: 180 });
    });

    it('bumps the privacy notice version when its text changes', async () => {
      const res = await as('recruiter').put('/recruitment/settings/career-site').send({ enabled: true, slug: siteSlug, headline: 'Build with us', privacyNotice: `${PRIVACY} Contact privacy@example.com.`, retentionDays: 180 });
      expect(res.body.privacyNoticeVersion).toBe(2);
    });
  });

  describe('pipeline', () => {
    let ashaId: string;
    let ashaApp: string;
    let vikramId: string;
    let interviewId: string;

    it('adds candidates by hand only with a lawful basis, and refuses duplicates', async () => {
      const body = { firstName: 'Vikram', lastName: 'Shah', email: 'vikram@example.com', source: 'referral', requisitionId: reqId, currentTitle: 'SDE II' };
      expect((await as('recruiter').post('/recruitment/candidates').send(body)).status).toBe(422);
      const created = await as('recruiter').post('/recruitment/candidates').send({ ...body, lawfulBasisConfirmed: true });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      vikramId = created.body.id;
      const dup = await as('recruiter').post('/recruitment/candidates').send({ ...body, lawfulBasisConfirmed: true });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('candidate_exists');
      expect((await pool.query('select consent_basis from candidates where id = $1', [vikramId])).rows[0].consent_basis).toBe('recruiter_confirmed');
    });

    it('shows the board to people in scope only', async () => {
      ashaId = (await candidateByEmail('asha.rao@example.com'))!;
      ashaApp = (await applicationOf(ashaId, reqId)).id;
      const board = await as('manager').get(`/recruitment/requisitions/${reqId}/pipeline`);
      expect(board.status).toBe(200);
      expect(board.body.stages.map((s: { name: string }) => s.name)).toEqual(['Applied', 'Screening', 'Interview', 'Offer', 'Hired']);
      expect(board.body.applications).toHaveLength(2);
      expect(board.body.counts).toMatchObject({ active: 2 });
      // The sales hiring manager cannot see these candidates at all.
      expect((await as('salesManager').get(`/recruitment/candidates/${ashaId}`)).status).toBe(404);
      expect(((await as('salesManager').get('/recruitment/candidates')).body as unknown[]).length).toBe(0);
      expect((await as('employee').get(`/recruitment/candidates/${ashaId}`)).status).toBe(403);
      const profile = await as('manager').get(`/recruitment/candidates/${ashaId}`);
      expect(profile.body.candidate).toMatchObject({ firstName: 'Asha', consentBasis: 'candidate_consent' });
      expect(profile.body.files).toHaveLength(1);
      expect(profile.body.timeline.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(['applied', 'email_queued']));
    });

    it('moves candidates between stages but never straight to Hired', async () => {
      const board = (await as('recruiter').get(`/recruitment/requisitions/${reqId}/pipeline`)).body as { stages: { id: string; kind: string }[] };
      const stage = (kind: string) => board.stages.find((s) => s.kind === kind)!.id;
      expect((await as('recruiter').post(`/recruitment/applications/${ashaApp}/move`).send({ stageId: stage('screen'), note: 'Strong payments background' })).body).toEqual({ stageId: stage('screen') });
      const hired = await as('recruiter').post(`/recruitment/applications/${ashaApp}/move`).send({ stageId: stage('hired') });
      expect(hired.status).toBe(400);
      expect(hired.body.error.code).toBe('use_hire');
      expect((await as('recruiter').post(`/recruitment/applications/${ashaApp}/move`).send({ stageId: stage('interview') })).status).toBe(200);
      const events = await pool.query(`select kind from application_events where application_id = $1 order by id`, [ashaApp]);
      expect(events.rows.filter((r) => r.kind === 'stage_changed')).toHaveLength(2);
      // History is append-only, even for the app role.
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('set local role crew_app');
        await client.query(`select set_config('app.tenant_id', $1, true)`, [t.id]);
        await expect(client.query(`update application_events set kind = 'hired' where application_id = $1`, [ashaApp])).rejects.toThrow();
        await client.query('rollback');
      } finally {
        client.release();
      }
    });

    it('signs CV links for people who may see the candidate', async () => {
      const files = (await as('recruiter').get(`/recruitment/candidates/${ashaId}`)).body.files as { id: string }[];
      const link = await as('recruiter').get(`/recruitment/candidate-files/${files[0]!.id}/link`);
      expect(link.status).toBe(200);
      const dl = await request(app.getHttpServer()).get(link.body.path);
      expect(dl.status).toBe(200);
      expect(dl.headers['content-type']).toBe('application/pdf');
      expect(dl.body.toString().startsWith('%PDF')).toBe(true);
      // A tampered or document-style signature does not work.
      expect((await request(app.getHttpServer()).get(link.body.path.replace(/sig=[^&]+/, 'sig=0000000000000000'))).status).toBe(404);
      expect((await request(app.getHttpServer()).get(link.body.path.replace('/files/resumes/', '/files/'))).status).toBe(404);
      expect((await as('salesManager').get(`/recruitment/candidate-files/${files[0]!.id}/link`)).status).toBe(404);
    });

    it('schedules interviews, invites the panel and the candidate', async () => {
      const noLink = await as('recruiter').post(`/recruitment/applications/${ashaApp}/interviews`).send({ title: 'Technical', startsAt: new Date().toISOString(), mode: 'video', panelMembershipIds: [people.panelist!.membershipId] });
      expect(noLink.status).toBe(422);
      const res = await as('recruiter').post(`/recruitment/applications/${ashaApp}/interviews`).send({
        title: 'Technical round', startsAt: new Date(Date.now() - 60 * 60_000).toISOString(), durationMinutes: 60, mode: 'video',
        meetingUrl: 'https://meet.example.com/abc-defg', panelMembershipIds: [people.panelist!.membershipId, people.employee!.membershipId], notifyCandidate: true,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      interviewId = res.body.id;
      const invite = await emails('asha.rao@example.com', 'candidate.interview');
      expect(invite).toHaveLength(1);
      expect(invite[0]!.text_body).toContain('https://meet.example.com/abc-defg');
      expect(invite[0]!.text_body).toMatch(/IST|India|\+05:30|Asia\/Kolkata/);
      const mine = await as('panelist').get('/recruitment/interviews/mine');
      expect((mine.body as { id: string }[]).map((i) => i.id)).toContain(interviewId);
      // A panelist may read the candidate's CV for the interview without wider candidate access.
      const detail = await as('panelist').get(`/recruitment/interviews/${interviewId}`);
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({ can: { feedback: true, manage: false }, interview: { scorecard: ['Coding', 'System design', 'Communication'] } });
      expect((await as('panelist').get(`/recruitment/candidate-files/${detail.body.files[0].id}/link`)).status).toBe(200);
      expect((await as('panelist').get(`/recruitment/candidates/${ashaId}`)).status).toBe(403);
      expect((await as('salesManager').get(`/recruitment/interviews/${interviewId}`)).status).toBe(404);
    });

    it('keeps scorecards independent until each interviewer has submitted', async () => {
      const ratings = (scores: number[]) => ['Coding', 'System design', 'Communication'].map((criterion, i) => ({ criterion, score: scores[i]! }));
      const wrong = await as('panelist').post(`/recruitment/interviews/${interviewId}/feedback`).send({ ratings: [{ criterion: 'Vibes', score: 4 }], recommendation: 'yes', summary: 'Seemed fine to me overall.' });
      expect(wrong.status).toBe(400);
      expect(wrong.body.error.code).toBe('scorecard_mismatch');
      expect((await as('recruiter').post(`/recruitment/interviews/${interviewId}/feedback`).send({ ratings: ratings([3, 3, 3]), recommendation: 'yes', summary: 'Not on the panel.' })).status).toBe(403);
      expect((await as('panelist').post(`/recruitment/interviews/${interviewId}/feedback`).send({ ratings: ratings([4, 3, 4]), recommendation: 'strong_yes', summary: 'Clear thinker, designed a sound ledger.' })).status).toBe(201);
      expect((await as('panelist').post(`/recruitment/interviews/${interviewId}/feedback`).send({ ratings: ratings([1, 1, 1]), recommendation: 'no', summary: 'Changing my mind later.' })).status).toBe(409);
      // The second interviewer does not see the first scorecard before writing their own.
      const before = await as('employee').get(`/recruitment/interviews/${interviewId}`);
      expect(before.body).toMatchObject({ otherFeedback: [], othersHidden: true, can: { feedback: true } });
      expect(JSON.stringify(before.body)).not.toContain('ledger');
      expect((await as('employee').post(`/recruitment/interviews/${interviewId}/feedback`).send({ ratings: ratings([3, 2, 3]), recommendation: 'yes', summary: 'Good coder, design needs some coaching.' })).status).toBe(201);
      const after = await as('employee').get(`/recruitment/interviews/${interviewId}`);
      expect(after.body.otherFeedback).toHaveLength(1);
      // The hiring manager sees every scorecard and the average.
      const hm = await as('manager').get(`/recruitment/interviews/${interviewId}`);
      expect(hm.body.otherFeedback).toHaveLength(2);
      const board = await as('manager').get(`/recruitment/requisitions/${reqId}/pipeline`);
      expect(board.body.applications.find((a: { id: string }) => a.id === ashaApp)).toMatchObject({ scorecards: 2, averageScore: '3.17' });
    });

    it('does not open scorecards before the interview starts', async () => {
      const vApp = (await applicationOf(vikramId, reqId)).id;
      const res = await as('recruiter').post(`/recruitment/applications/${vApp}/interviews`).send({
        title: 'Screen', startsAt: new Date(Date.now() + 2 * 86400000).toISOString(), mode: 'phone', panelMembershipIds: [people.panelist!.membershipId], notifyCandidate: false,
      });
      expect(res.status).toBe(201);
      const early = await as('panelist').post(`/recruitment/interviews/${res.body.id}/feedback`).send({ ratings: [{ criterion: 'Coding', score: 3 }, { criterion: 'System design', score: 3 }, { criterion: 'Communication', score: 3 }], recommendation: 'yes', summary: 'Writing this too early.' });
      expect(early.status).toBe(409);
      expect(early.body.error.code).toBe('interview_not_started');
      expect((await emails('vikram@example.com')).length).toBe(0);
    });

    it('rejects with a reason, cancels future interviews and can send a neutral email', async () => {
      const vApp = (await applicationOf(vikramId, reqId)).id;
      const res = await as('manager').post(`/recruitment/applications/${vApp}/reject`).send({ reason: 'better_candidate', note: 'Asha is further along', notifyCandidate: true });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await pool.query(`select status from interviews where application_id = $1`, [vApp])).rows.map((r) => r.status)).toEqual(['cancelled']);
      const mail = await emails('vikram@example.com', 'candidate.rejected');
      expect(mail).toHaveLength(1);
      // The email never includes the internal reason or note.
      expect(mail[0]!.text_body).not.toMatch(/better_candidate|Asha|further along/);
      const screen = (await as('manager').get(`/recruitment/requisitions/${reqId}/pipeline`)).body.stages[1].id;
      expect((await as('manager').post(`/recruitment/applications/${vApp}/move`).send({ stageId: screen })).status).toBe(409);
      expect((await as('manager').post(`/recruitment/applications/${vApp}/reopen`).send({})).body).toEqual({ status: 'active' });
      expect((await as('manager').post(`/recruitment/applications/${vApp}/reject`).send({ reason: 'better_candidate' })).status).toBe(200);
    });

    describe('offers and hiring', () => {
      let offerId: string;
      const offer = { jobTitle: 'Backend Engineer', baseSalary: '2600000', currency: 'INR', payPeriod: 'annual', joiningDate: day(30), expiresOn: day(7) };

      it('drafts an offer, flags pay above the approved range and needs approval with MFA', async () => {
        expect((await as('manager').post(`/recruitment/applications/${ashaApp}/offers`).send(offer)).status).toBe(403); // offers:manage is the recruiter's
        const res = await as('recruiter').post(`/recruitment/applications/${ashaApp}/offers`).send(offer);
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        offerId = res.body.id;
        expect((await as('recruiter').post(`/recruitment/applications/${ashaApp}/offers`).send(offer)).status).toBe(409);
        const app1 = await pool.query(`select s.kind from applications a join recruitment_stages s on s.id = a.stage_id where a.id = $1`, [ashaApp]);
        expect(app1.rows[0].kind).toBe('offer');
        expect((await as('recruiter').post(`/recruitment/offers/${offerId}/send`).send({})).status).toBe(409); // not approved yet
        expect((await as('recruiter').post(`/recruitment/offers/${offerId}/submit`).send({})).body).toEqual({ status: 'pending_approval' });
        const inbox = (await as('hr').get('/approvals/inbox')).body as { id: string; resourceType: string; summary: string }[];
        const item = inbox.find((i) => i.resourceType === 'offer')!;
        expect(item.summary).toMatch(/ABOVE/);
        // HR without a verified second factor cannot approve an offer.
        const noMfa = (await login(app, people.hr!.email)).accessToken;
        expect((await api(app, noMfa).post(`/approvals/${item.id}/approve`).send({})).status).toBe(403);
        expect((await as('hr').post(`/approvals/${item.id}/approve`).send({})).status).toBe(200);
        expect((await pool.query('select status, above_range from offers where id = $1', [offerId])).rows[0]).toEqual({ status: 'approved', above_range: true });
      });

      it('sends the offer, records the answer, and refuses to hire before acceptance', async () => {
        expect((await as('hr').post(`/recruitment/applications/${ashaApp}/hire`).send({})).body.error?.code).toBe('no_accepted_offer');
        expect((await as('recruiter').post(`/recruitment/offers/${offerId}/send`).send({})).body).toEqual({ status: 'sent' });
        const mail = await emails('asha.rao@example.com', 'candidate.offer');
        expect(mail).toHaveLength(1);
        expect(mail[0]!.text_body).toMatch(/26,00,000|2,600,000|2600000/);
        expect((await as('recruiter').post(`/recruitment/offers/${offerId}/response`).send({ response: 'accepted', note: 'Accepted by email on the 3rd' })).body).toEqual({ status: 'accepted' });
      });

      it('only someone who may create employees completes the hire, which fills the requisition', async () => {
        expect((await as('recruiter').post(`/recruitment/applications/${ashaApp}/hire`).send({})).status).toBe(403);
        const res = await as('hr').post(`/recruitment/applications/${ashaApp}/hire`).send({ workEmail: 'asha@crew-test.example', probationMonths: 3 });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        const emp = res.body.employee as { id: string; firstName: string; departmentId: string };
        expect(emp).toMatchObject({ firstName: 'Asha', departmentId: engineering });
        const a = await pool.query('select status, employee_id from applications where id = $1', [ashaApp]);
        expect(a.rows[0]).toEqual({ status: 'hired', employee_id: emp.id });
        const r = (await as('recruiter').get(`/recruitment/requisitions/${reqId}`)).body;
        expect(r).toMatchObject({ status: 'filled', hiredCount: 1, published: false });
        expect((await request(app.getHttpServer()).get(`/api/v1/public/careers/${siteSlug}/jobs/backend-engineer`)).status).toBe(404);
        // Hiring twice is refused.
        expect((await as('hr').post(`/recruitment/applications/${ashaApp}/hire`).send({})).status).toBe(409);
      });

      it('withdraws an offer awaiting approval when the application is rejected, and cancels the approval', async () => {
        const cid = (await as('recruiter').post('/recruitment/candidates').send({ firstName: 'Kiran', email: 'kiran@example.com', requisitionId: salesReqId, lawfulBasisConfirmed: true })).body.id;
        const kApp = (await applicationOf(cid, salesReqId)).id;
        const o = await as('recruiter').post(`/recruitment/applications/${kApp}/offers`).send({ ...offer, baseSalary: '2000000' });
        expect((await as('recruiter').post(`/recruitment/offers/${o.body.id}/submit`).send({})).status).toBe(200);
        expect((await as('recruiter').post(`/recruitment/applications/${kApp}/reject`).send({ reason: 'salary' })).status).toBe(200);
        const row = (await pool.query('select o.status, r.status as approval from offers o join approval_requests r on r.id = o.approval_request_id where o.id = $1', [o.body.id])).rows[0];
        expect(row).toEqual({ status: 'withdrawn', approval: 'cancelled' });
        expect(((await as('hr').get('/approvals/inbox')).body as { resourceId: string }[]).some((i) => i.resourceId === o.body.id)).toBe(false);
      });
    });
  });

  describe('candidate data', () => {
    it('erases a candidate on request but keeps the anonymous pipeline history', async () => {
      const vikram = (await candidateByEmail('vikram@example.com'))!;
      // Erasure needs workspace-wide candidate access; a hiring manager's own-scope grant does not reach it.
      expect((await as('manager').post(`/recruitment/candidates/${vikram}/erase`).send({ reason: 'Asked by email' })).status).toBe(404);
      const res = await as('recruiter').post(`/recruitment/candidates/${vikram}/erase`).send({ reason: 'Candidate asked by email' });
      expect(res.body).toEqual({ erased: true });
      const c = (await pool.query('select first_name, email, phone, anonymized_at from candidates where id = $1', [vikram])).rows[0];
      expect(c.email).toBeNull();
      expect(c.first_name).not.toBe('Vikram');
      expect(c.anonymized_at).not.toBeNull();
      expect((await pool.query('select count(*)::int as n from candidate_notes where candidate_id = $1', [vikram])).rows[0].n).toBe(0);
      expect((await pool.query(`select count(*)::int as n from application_events e join applications a on a.id = e.application_id where a.candidate_id = $1`, [vikram])).rows[0].n).toBeGreaterThan(0);
      expect((await as('recruiter').post(`/recruitment/candidates/${vikram}/erase`).send({ reason: 'Again' })).body).toEqual({ erased: false });
      const audit = await pool.query(`select metadata from audit_events where tenant_id = $1 and action = 'candidate.erased' and resource_id = $2`, [t.id, vikram]);
      expect(audit.rows).toHaveLength(1);
    });

    it('anonymises candidates past the retention period with no open application', async () => {
      const stale = (await as('recruiter').post('/recruitment/candidates').send({ firstName: 'Old', lastName: 'Lead', email: 'old.lead@example.com', lawfulBasisConfirmed: true })).body.id;
      const active = (await as('recruiter').post('/recruitment/candidates').send({ firstName: 'Busy', email: 'busy@example.com', requisitionId: salesReqId, lawfulBasisConfirmed: true })).body.id;
      await pool.query(`update candidates set last_activity_at = now() - interval '400 days' where id = any($1::uuid[])`, [[stale, active]]);
      const n = await app.get(CandidatesService).applyRetention(t.id);
      expect(n).toBe(1);
      expect((await pool.query('select email from candidates where id = $1', [stale])).rows[0].email).toBeNull();
      expect((await pool.query('select email from candidates where id = $1', [active])).rows[0].email).toBe('busy@example.com');
      expect(await app.get(CandidatesService).applyRetention(t.id)).toBe(0);
    });
  });

  describe('stage settings', () => {
    it('lets recruiters add, rename and reorder stages but keeps Applied first and Hired last', async () => {
      const added = await as('recruiter').post('/recruitment/settings/stages').send({ name: 'Take-home task', kind: 'interview' });
      expect(added.status, JSON.stringify(added.body)).toBe(201);
      const stages = (await as('recruiter').get('/recruitment/settings/stages')).body as { id: string; name: string; kind: string }[];
      expect(stages.map((s) => s.name)).toEqual(['Applied', 'Screening', 'Interview', 'Offer', 'Take-home task', 'Hired']);
      const ids = stages.map((s) => s.id);
      const swapped = [ids[0]!, ids[1]!, ids[4]!, ids[2]!, ids[3]!, ids[5]!];
      expect((await as('recruiter').put('/recruitment/settings/stages/order').send({ stageIds: swapped })).status).toBe(200);
      expect((await as('recruiter').put('/recruitment/settings/stages/order').send({ stageIds: [ids[5]!, ...ids.slice(0, 5)] })).status).toBe(400);
      expect((await as('recruiter').patch(`/recruitment/settings/stages/${ids[4]}`).send({ name: 'Take-home' })).status).toBe(200);
      expect((await as('recruiter').delete(`/recruitment/settings/stages/${ids[0]}`)).status).toBe(400);
      expect((await as('recruiter').delete(`/recruitment/settings/stages/${ids[4]}`)).status).toBe(204);
      expect((await as('manager').post('/recruitment/settings/stages').send({ name: 'Vibe check', kind: 'screen' })).status).toBe(403);
    });
  });

  describe('isolation', () => {
    it('keeps every Phase 4 record inside its workspace', async () => {
      const tables = ['recruitment_stages', 'job_requisitions', 'job_postings', 'career_sites', 'candidates', 'candidate_files', 'candidate_notes', 'applications',
        'application_events', 'interviews', 'interview_panelists', 'interview_feedback', 'offers'];
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('set local role crew_app');
        await client.query(`select set_config('app.tenant_id', $1, true)`, [other.id]);
        for (const table of tables) {
          const r = await client.query(`select count(*)::int as n from ${table} where tenant_id = $1`, [t.id]);
          expect(r.rows[0].n, table).toBe(0);
        }
        await expect(client.query(`insert into candidates (tenant_id, first_name, email, source, consent_basis) values ($1, 'X', 'x@example.com', 'manual', 'recruiter_confirmed')`, [t.id])).rejects.toThrow();
        await client.query('rollback');
      } finally {
        client.release();
      }
      const otherOwner = (await login(app, other.ownerEmail)).accessToken;
      const asha = (await candidateByEmail('asha.rao@example.com'))!;
      expect((await api(app, otherOwner).get(`/recruitment/requisitions/${reqId}`)).status).toBe(404);
      expect((await api(app, otherOwner).get(`/recruitment/candidates/${asha}`)).status).toBe(404);
      expect((await api(app, otherOwner).get(`/recruitment/requisitions/${reqId}/pipeline`)).status).toBe(404);
    });
  });
});
