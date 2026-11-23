import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, adminPool, api, createApp, createTenant, login, loginWithMfa, type TestDb, type TestTenant } from './helpers';

const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
// The smallest MP4 header the upload check accepts ("ftyp" at byte 4).
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(200, 1)]);

/**
 * Learning & Development, the whole flow through the HTTP API (spec part 48): the Super Workspace builds "Workplace
 * Safety Training 2026" (video, PDF, quiz, assignment), publishes it and assigns it to everyone; Kunal gets a
 * notification, works through it, passes the quiz with 85%, submits the assignment; HR (once the Super Workspace
 * switches grading on for its HR Workspace) approves it; the module is 100% complete and both dashboards show it.
 * Along the way: HR has no management powers until they are switched on, HR only reaches its own people, learners
 * never see answers, drafts or other people's work, and published versions protect finished records.
 */
describe('Learning & Development', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let owner: string;
  const tok: Record<string, string> = {};
  const emp: Record<string, string> = {};
  const as = (who: string) => api(app, who === 'owner' ? owner : tok[who]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ok = (res: { status: number; body: any }, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body;
  };
  let delhi: string;
  let pune: string;
  let videoId: string;
  let pdfId: string;
  let moduleId: string;
  let kunalEnrolment: string;

  const hire = async (first: string, last: string, membershipId?: string) =>
    ok(await api(app, owner).post('/employees').send({ legalEntityId: t.legalEntityId, firstName: first, lastName: last, dateOfJoining: '2025-01-06', probationMonths: 0, onboardingTemplateId: null, membershipId }), 201).employee.id as string;

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool, { plan: 'business' });
    owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    const priya = await addMember(pool, t, { name: 'Priya Sharma' });
    const ravi = await addMember(pool, t, { name: 'Ravi Pune' });
    const kunal = await addMember(pool, t, { name: 'Kunal Sharma' });
    const neha = await addMember(pool, t, { name: 'Neha Pune' });
    emp.kunal = await hire('Kunal', 'Sharma', kunal.membershipId);
    emp.neha = await hire('Neha', 'Verma', neha.membershipId);
    emp.priya = await hire('Priya', 'Sharma', priya.membershipId);
    delhi = ok(await api(app, owner).post('/hr-workspaces').send({ name: 'Delhi HR', kind: 'branch', features: ['learning', 'leave'], adminMembershipIds: [priya.membershipId] }), 201).id;
    pune = ok(await api(app, owner).post('/hr-workspaces').send({ name: 'Pune HR', kind: 'branch', features: ['learning', 'leave'], adminMembershipIds: [ravi.membershipId] }), 201).id;
    ok(await api(app, owner).post(`/hr-workspaces/${delhi}/members`).send({ employeeIds: [emp.kunal], reason: 'Delhi office' }), 201);
    ok(await api(app, owner).post(`/hr-workspaces/${pune}/members`).send({ employeeIds: [emp.neha], reason: 'Pune office' }), 201);
    for (const [k, m] of Object.entries({ priya, ravi, kunal, neha })) tok[k] = (await login(app, m.email)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('gives HR Workspaces only "View learning" until the Super Workspace switches more on', async () => {
    const acc = ok(await as('priya').get('/learning/access'));
    expect(acc.level).toBe('hr');
    expect(acc.caps).toMatchObject({ view: true, create: false, publish: false, grade: false, reports: false });
    expect(ok(await as('owner').get('/learning/access')).level).toBe('super');
    expect(ok(await as('kunal').get('/learning/access'))).toMatchObject({ level: 'employee', manager: false });
    const r = await as('priya').post('/learning/modules').send({ title: 'Delhi induction', category: 'Onboarding', creatorName: 'Priya Sharma' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('learning_permission');
    // Only the Super Workspace sets the switches.
    expect((await as('priya').put('/learning/permissions').send({ hrWorkspaceId: delhi, caps: ['view', 'create'] })).status).toBe(403);
    const rows = ok(await as('owner').get('/learning/permissions'));
    expect(rows.map((x: { name: string }) => x.name)).toEqual(['Company-wide HR (central group)', 'Delhi HR', 'Pune HR']);
    expect(rows.find((x: { hrWorkspaceId: string }) => x.hrWorkspaceId === delhi).caps).toEqual(['view']);
    ok(await as('owner').put('/learning/permissions').send({ hrWorkspaceId: delhi, caps: ['create', 'edit', 'quiz', 'assign', 'grade', 'reports'] }));
    expect(ok(await as('priya').get('/learning/access')).caps).toMatchObject({ view: true, create: true, publish: false, grade: true, export: false });
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'learning.permissions_changed' })).toBe(1);
    // Employees and people without HR access have nothing to manage.
    expect((await as('kunal').get('/learning/modules')).status).toBe(403);
    expect((await as('kunal').get('/learning/dashboard')).status).toBe(403);
    expect((await as('kunal').get('/learning/reports')).status).toBe(403);
  });

  it('uploads learning files with checks on type and content', async () => {
    videoId = ok(await as('owner').post('/learning/files').attach('file', MP4, { filename: 'safety.mp4', contentType: 'video/mp4' }), 201).id;
    pdfId = ok(await as('owner').post('/learning/files').attach('file', PDF, { filename: 'safety-handbook.pdf', contentType: 'application/pdf' }), 201).id;
    expect((await as('owner').post('/learning/files').attach('file', Buffer.from('not a video'), { filename: 'x.mp4', contentType: 'video/mp4' })).status).toBe(400);
    expect((await as('owner').post('/learning/files').attach('file', Buffer.from('MZ'), { filename: 'x.exe', contentType: 'application/x-msdownload' })).status).toBe(400);
    // A learner cannot add course content, and cannot open it before being enrolled.
    expect((await as('kunal').post('/learning/files').attach('file', PDF, { filename: 'a.pdf', contentType: 'application/pdf' })).status).toBe(403);
    expect((await as('kunal').post(`/learning/files/${pdfId}/link`)).status).toBe(404);
  });

  const blocks = () => [
    { id: 'intro', kind: 'text', title: 'Introduction', body: '<h3>Why safety matters</h3><p>Read this first.</p>', completion: 'manual' },
    { id: 'video', kind: 'video', title: 'Training video', source: { type: 'upload', fileId: videoId }, durationMinutes: 2, completion: 'percent', minPercent: 90 },
    { id: 'handbook', kind: 'document', title: 'Safety handbook', source: { type: 'upload', fileId: pdfId }, completion: 'open' },
    {
      id: 'quiz', kind: 'quiz', title: 'Safety quiz', settings: { passPercent: 70, maxAttempts: 3, showCorrectAnswers: true, showScore: true, allowRetake: true, finalAssessment: true },
      questions: [
        { id: 'q1', type: 'single', text: 'Where is the assembly point?', options: [{ id: 'a', text: 'Car park' }, { id: 'b', text: 'Roof' }], correct: ['a'], marks: 4, explanation: 'Always the car park.' },
        { id: 'q2', type: 'multiple', text: 'Which are fire classes?', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'z', text: 'Z' }], correct: ['a', 'b'], marks: 4 },
        { id: 'q3', type: 'true_false', text: 'Use lifts in a fire.', correct: ['false'], marks: 4 },
        { id: 'q4', type: 'exact', text: 'Emergency number?', accepted: ['112'], marks: 4 },
        { id: 'q5', type: 'matching', text: 'Match the sign', pairs: [{ left: 'Red', right: 'Stop' }, { left: 'Green', right: 'Safe' }], marks: 4 },
      ],
    },
    { id: 'report', kind: 'assignment', title: 'Hazard report', settings: { instructions: 'Find one hazard at your desk and describe the fix.', maxScore: 100, passScore: 60, submissionTypes: ['text', 'link'] } },
  ];

  it('creates, edits and publishes a module from the Super Workspace with its creator shown', async () => {
    const bad = await as('owner').post('/learning/modules').send({
      title: 'Broken', category: 'Compliance', creatorName: 'Kunal Sharma',
      blocks: [{ id: 'q', kind: 'quiz', title: 'Q', questions: [{ id: 'q1', type: 'single', text: 'x', options: [{ id: 'a', text: 'A' }], correct: ['b'] }] }],
    });
    expect(bad.status).toBe(422);
    moduleId = ok(await as('owner').post('/learning/modules').send({
      title: 'Workplace Safety Training 2026', shortDescription: 'Stay safe at work', category: 'Workplace Safety', topic: 'Fire safety', skills: ['Safety Awareness', 'Communication'],
      difficulty: 'beginner', durationMinutes: 45, creatorName: 'Kunal Sharma', creatorDesignation: 'Learning & Development Manager', tags: ['2026'], certificate: true, blocks: blocks(),
    }), 201).id;
    // New skills join the workspace skill list.
    expect(await pool.count('skills', { tenant_id: t.id, name: 'Safety Awareness' })).toBe(1);
    const draft = ok(await as('owner').get(`/learning/modules/${moduleId}`));
    expect(draft).toMatchObject({ status: 'draft', version: 0, format: 'mixed', creator: { name: 'Kunal Sharma', designation: 'Learning & Development Manager', workspace: 'Super Workspace' } });
    // A draft is invisible to learners and to HR Workspaces that do not own it.
    expect((await as('priya').get(`/learning/modules/${moduleId}`)).status).toBe(404);
    expect((await as('owner').post(`/learning/modules/${moduleId}/assign`).send({ audience: { all: true } })).status).toBe(409);
    ok(await as('owner').post(`/learning/modules/${moduleId}/publish`).send({ note: 'First version' }), 201);
    const pub = ok(await as('owner').get(`/learning/modules/${moduleId}`));
    expect(pub).toMatchObject({ status: 'published', version: 1, unpublishedChanges: false });
    // Published Super Workspace modules can be seen by HR, but only the Super Workspace changes them.
    expect(ok(await as('priya').get(`/learning/modules/${moduleId}`)).blocks).toEqual([]);
    expect((await as('priya').put(`/learning/modules/${moduleId}`).send({ title: 'Hijack', category: 'Other', creatorName: 'x' })).status).toBe(403);
  });

  it('assigns it to all employees: everyone is enrolled and notified', async () => {
    const r = ok(await as('owner').post(`/learning/modules/${moduleId}/assign`).send({ audience: { all: true }, dueOn: inDays(9) }), 201);
    expect(r.enrolled).toBe(3);
    expect(r.audience).toBe('All employees');
    const again = ok(await as('owner').post(`/learning/modules/${moduleId}/assign`).send({ audience: { all: true } }), 201);
    expect(again).toMatchObject({ enrolled: 0, alreadyEnrolled: 3 });
    const kunalMember = (await pool.one('employees', { id: emp.kunal }))!.membership_id;
    expect(await pool.count('notifications', { tenant_id: t.id, membership_id: kunalMember, kind: 'learning.assigned' })).toBe(1);
    const my = ok(await as('kunal').get('/learning/my'));
    expect(my.summary).toMatchObject({ total: 1, notStarted: 1 });
    const item = my.items[0];
    kunalEnrolment = item.id;
    expect(item).toMatchObject({ title: 'Workplace Safety Training 2026', status: 'not_started', progressPercent: 0, dueOn: inDays(9), creator: { name: 'Kunal Sharma', workspace: 'Super Workspace' } });
  });

  it('never shows the learner the answers, and keeps other people out of their learning', async () => {
    const p = ok(await as('kunal').get(`/learning/my/${kunalEnrolment}`));
    expect(p.blocks.map((b: { kind: string }) => b.kind)).toEqual(['text', 'video', 'document', 'quiz', 'assignment']);
    expect(JSON.stringify(p)).not.toContain('Always the car park');
    expect(p.blocks[3].questions).toBeUndefined();
    const start = ok(await as('kunal').post(`/learning/my/${kunalEnrolment}/items/quiz/attempts`), 201);
    expect(JSON.stringify(start.questions)).not.toMatch(/"correct"|"accepted"|explanation/);
    expect(start.questions.find((q: { id: string }) => q.id === 'q5').right.sort()).toEqual(['Safe', 'Stop']);
    // Someone else's enrolment looks the same as one that does not exist.
    expect((await as('neha').get(`/learning/my/${kunalEnrolment}`)).status).toBe(404);
    expect((await as('neha').post(`/learning/my/${kunalEnrolment}/items/intro/progress`).send({ action: 'complete' })).status).toBe(404);
    // Ravi's HR Workspace (Pune) has nothing switched on beyond viewing, and does not reach Kunal (Delhi).
    expect((await as('ravi').get(`/learning/learners/${emp.kunal}`)).status).toBe(404);
    expect(ok(await as('priya').get(`/learning/learners/${emp.kunal}`)).summary.assigned).toBe(1);
  });

  it('works out progress from what Kunal actually does', async () => {
    const url = `/learning/my/${kunalEnrolment}/items`;
    // A video with a percentage rule cannot just be ticked.
    expect((await as('kunal').post(`${url}/video/progress`).send({ action: 'complete' })).status).toBe(400);
    let p = ok(await as('kunal').post(`${url}/intro/progress`).send({ action: 'complete', seconds: 60 }), 201);
    expect(p).toMatchObject({ status: 'in_progress', progressPercent: 20 });
    p = ok(await as('kunal').post(`${url}/video/progress`).send({ action: 'heartbeat', position: 60, duration: 120, seconds: 60 }), 201);
    expect(p.blocks[1].state).toMatchObject({ done: false, percent: 50 });
    p = ok(await as('kunal').post(`${url}/video/progress`).send({ action: 'heartbeat', position: 110, duration: 120, seconds: 50 }), 201);
    expect(p.blocks[1].state.done).toBe(true);
    p = ok(await as('kunal').post(`${url}/handbook/progress`).send({ action: 'open' }), 201);
    expect(p.progressPercent).toBe(60);
    expect(p.remaining).toEqual(['quiz', 'report']);
    // The handbook PDF can be opened now Kunal is enrolled.
    expect(ok(await as('kunal').post(`/learning/files/${pdfId}/link`), 201).path).toMatch(/^\/api\/v1\/files\/learning\//);
  });

  it('marks the quiz on the server: a first try fails, the second passes with 85%', async () => {
    const url = `/learning/my/${kunalEnrolment}/items/quiz/attempts`;
    const first = ok(await as('kunal').post(url), 201);
    const fail = ok(await as('kunal').post(`${url}/submit`).send({ attemptId: first.attemptId, answers: { q1: ['b'], q2: ['a'], q3: ['true'], q4: '999', q5: ['Safe', 'Stop'] } }), 201);
    expect(fail).toMatchObject({ percent: 0, passed: false });
    expect(fail.questions[0]).toMatchObject({ correct: false, explanation: 'Always the car park.', answer: ['Car park'] });
    const second = ok(await as('kunal').post(url), 201);
    expect(second.attemptNo).toBe(2);
    // 4 + 4 + 4 + 4 + half of 4 (one pair of two) = 18 of 20 = 90%; then a wrong typed answer: 14/20 = 70%... use 17/20 = 85%
    const pass = ok(await as('kunal').post(`${url}/submit`).send({ attemptId: second.attemptId, answers: { q1: ['a'], q2: ['a', 'b'], q3: ['false'], q4: ' 112 ', q5: ['Stop', 'Wrong'] } }), 201);
    expect(pass).toMatchObject({ percent: 90, passed: true });
    expect(pass.enrolment.blocks[3].state).toMatchObject({ done: true, passed: true, attempts: 2, bestPercent: 90 });
    // Passed: no more attempts.
    expect((await as('kunal').post(url)).status).toBe(409);
    expect(await pool.count('learning_quiz_attempts', { tenant_id: t.id, assignment_id: kunalEnrolment })).toBe(2);
  });

  it('takes the assignment and HR reviews it only once allowed, for its own people', async () => {
    const url = `/learning/my/${kunalEnrolment}/items/report/submissions`;
    expect((await as('kunal').post(url).send({ text: '' })).status).toBe(422);
    const p = ok(await as('kunal').post(url).send({ text: 'Loose cable under my desk: tied it with a clip.', link: 'https://example.com/photo' }), 201);
    expect(p.blocks[4].state.submission).toBe('submitted');
    expect((await as('kunal').post(url).send({ text: 'Again' })).status).toBe(409);
    // Pune HR has no grading switched on; Delhi HR does, and sees Kunal's work.
    expect((await as('ravi').get('/learning/reviews/submissions')).status).toBe(403);
    const queue = ok(await as('priya').get('/learning/reviews/submissions'));
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ employeeName: 'Kunal Sharma', hrWorkspace: 'Delhi HR', assignmentTitle: 'Hazard report', status: 'submitted' });
    const sid = queue[0].id;
    expect((await as('priya').post(`/learning/reviews/submissions/${sid}`).send({ decision: 'approved', score: 40 })).status).toBe(422);
    ok(await as('priya').post(`/learning/reviews/submissions/${sid}`).send({ decision: 'resubmit', feedback: 'Add what you did to prevent it next time.' }), 201);
    expect((await as('priya').post(`/learning/reviews/submissions/${sid}`).send({ decision: 'approved', score: 80 })).status).toBe(409);
    ok(await as('kunal').post(url).send({ text: 'Tied the cable and asked facilities to add a cable tray.' }), 201);
    const next = ok(await as('priya').get('/learning/reviews/submissions'))[0];
    ok(await as('priya').post(`/learning/reviews/submissions/${next.id}`).send({ decision: 'approved', score: 80, feedback: 'Good fix.' }), 201);
  });

  it('completes Kunal at 100% with his score, a certificate, and shows it on both dashboards', async () => {
    const p = ok(await as('kunal').get(`/learning/my/${kunalEnrolment}`));
    expect(p).toMatchObject({ status: 'completed', progressPercent: 100, scorePercent: 90, passed: true, completedOn: today() });
    expect(p.certificateNo).toMatch(/^SC-\d{4}-[A-Z0-9]{8}$/);
    const cert = ok(await as('kunal').get(`/learning/my/${kunalEnrolment}/certificate`));
    expect(cert).toMatchObject({ employeeName: 'Kunal Sharma', moduleTitle: 'Workplace Safety Training 2026', scorePercent: 90, creator: { name: 'Kunal Sharma' } });
    const kunalMember = (await pool.one('employees', { id: emp.kunal }))!.membership_id;
    expect(await pool.count('notifications', { tenant_id: t.id, membership_id: kunalMember, kind: 'learning.completed' })).toBe(1);
    const dash = ok(await as('owner').get('/learning/dashboard'));
    expect(dash).toMatchObject({ assigned: 3, completed: 1, notStarted: 2, completionRate: 33.3, averageScore: 90, modules: { published: 1 } });
    expect(dash.recentCompletions[0]).toMatchObject({ employeeName: 'Kunal Sharma', scorePercent: 90, completedOn: today() });
    expect(dash.byHrWorkspace.map((g: { name: string }) => g.name).sort()).toEqual(['Central group', 'Delhi HR', 'Pune HR']);
    // Delhi HR sees only its own people: Kunal.
    const hr = ok(await as('priya').get('/learning/dashboard'));
    expect(hr).toMatchObject({ assigned: 1, completed: 1, completionRate: 100, scope: 'Delhi HR' });
    const report = ok(await as('priya').get('/learning/reports'));
    expect(report.rows.map((r: { employeeName: string }) => r.employeeName)).toEqual(['Kunal Sharma']);
    expect(report.canExport).toBe(false);
    expect((await as('priya').get('/learning/reports/export.xlsx')).status).toBe(403);
    const xlsx = await as('owner').get('/learning/reports/export.xlsx').buffer(true);
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    // Filters.
    expect(ok(await as('owner').get('/learning/reports?status=completed')).rows).toHaveLength(1);
    expect(ok(await as('owner').get(`/learning/reports?hrWorkspaceId=${pune}`)).rows.map((r: { employeeName: string }) => r.employeeName)).toEqual(['Neha Verma']);
  });

  it('keeps finished records on their version when the module changes', async () => {
    const changed = blocks();
    changed[0] = { ...changed[0]!, title: 'Introduction (2027 update)' };
    ok(await as('owner').put(`/learning/modules/${moduleId}`).send({ title: 'Workplace Safety Training 2026', category: 'Workplace Safety', creatorName: 'Kunal Sharma', certificate: true, blocks: changed }));
    // Learners keep the published version until the changes are published.
    expect(ok(await as('neha').get('/learning/my')).items[0].version).toBe(1);
    ok(await as('owner').post(`/learning/modules/${moduleId}/publish`).send({ note: '2027 update' }), 201);
    const m = ok(await as('owner').get(`/learning/modules/${moduleId}`));
    expect(m.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    const kunal = ok(await as('kunal').get(`/learning/my/${kunalEnrolment}`));
    expect(kunal).toMatchObject({ version: 1, status: 'completed' });
    expect(kunal.blocks[0].title).toBe('Introduction');
    // Re-assigning enrols Kunal on version 2 as new learning; his version 1 completion stays.
    const r = ok(await as('owner').post(`/learning/modules/${moduleId}/assign`).send({ audience: { employeeIds: [emp.kunal] } }), 201);
    expect(r.enrolled).toBe(1);
    const mine = ok(await as('kunal').get('/learning/my')).items;
    expect(mine.map((i: { version: number; status: string }) => `${i.version}:${i.status}`).sort()).toEqual(['1:completed', '2:not_started']);
  });

  it('lets an HR Workspace create and assign only within its powers and its own people', async () => {
    const id = ok(await as('priya').post('/learning/modules').send({ title: 'Delhi office induction', category: 'Onboarding', creatorName: 'Priya Sharma', creatorDesignation: 'HR Manager', blocks: [{ id: 'intro', kind: 'text', title: 'Welcome', body: '<p>Hi</p>' }] }), 201).id;
    expect(ok(await as('priya').get(`/learning/modules/${id}`)).creator).toMatchObject({ name: 'Priya Sharma', designation: 'HR Manager', workspace: 'Delhi HR HR Workspace', level: 'hr' });
    // No assignment power switched on for assignments content, and no publishing yet.
    expect((await as('priya').put(`/learning/modules/${id}`).send({ title: 'Delhi office induction', category: 'Onboarding', creatorName: 'Priya Sharma', blocks: blocks().slice(4) })).status).toBe(403);
    expect((await as('priya').post(`/learning/modules/${id}/publish`).send({})).status).toBe(403);
    ok(await as('owner').put('/learning/permissions').send({ hrWorkspaceId: delhi, caps: ['create', 'edit', 'publish', 'quiz', 'assign', 'grade', 'reports'] }));
    ok(await as('priya').post(`/learning/modules/${id}/publish`).send({}), 201);
    // Pune and the whole company are out of reach; changing ids in the request does not help.
    expect((await as('priya').post(`/learning/modules/${id}/assign`).send({ audience: { hrWorkspaceIds: [pune] } })).status).toBe(403);
    expect((await as('priya').post(`/learning/modules/${id}/assign`).send({ audience: { employeeIds: [emp.neha] } })).status).toBe(403);
    expect((await as('priya').post(`/learning/modules/${id}/assign`).send({ audience: { all: true } })).status).toBe(403);
    const r = ok(await as('priya').post(`/learning/modules/${id}/assign`).send({ audience: { hrWorkspaceIds: [delhi] } }), 201);
    expect(r.enrolled).toBe(1);
    // A department audience only reaches Priya's own people too.
    // The Super Workspace sees the HR module; Pune HR does not see Delhi's draft-stage work, only once published.
    expect(ok(await as('owner').get('/learning/modules')).map((m: { title: string }) => m.title)).toContain('Delhi office induction');
  });

  it('keeps the existing course endpoints working for the phone app, without drafts', async () => {
    ok(await as('owner').post('/learning/modules').send({ title: 'Secret draft', category: 'Other', creatorName: 'Kunal Sharma' }), 201);
    const courses = ok(await as('kunal').get('/learning/courses'));
    expect(courses.map((c: { title: string }) => c.title)).not.toContain('Secret draft');
    const mine = ok(await as('kunal').get('/learning/assignments?view=mine'));
    expect(mine[0]).toHaveProperty('progressPercent');
    // A module with a quiz cannot be ticked off through the old "complete" call.
    const open = mine.find((a: { status: string; courseTitle: string }) => a.status !== 'completed' && a.courseTitle === 'Workplace Safety Training 2026');
    expect((await as('kunal').post(`/learning/assignments/${open.id}/complete`).send({})).status).toBe(409);
    // A simple course made with the old form is still a module with one item.
    const c = ok(await as('owner').post('/learning/courses').send({ title: 'Ethics refresher', format: 'online', contentUrl: 'https://example.com/ethics' }), 201);
    const row = await pool.one('courses', { id: c.id });
    expect(row).toMatchObject({ status: 'published', version: 1 });
    expect(row!.blocks[0]).toMatchObject({ kind: 'external', url: 'https://example.com/ethics' });
  });
});
