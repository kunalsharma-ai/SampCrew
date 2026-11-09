import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, adminPool, api, createApp, createTenant, department, expectHiddenFrom, login, loginWithMfa, type TestDb, type TestTenant } from './helpers';

const QUESTIONS = [
  { id: 'achievements', text: 'What went well this period?' },
  { id: 'growth', text: 'What should change next period?' },
];
const SCALE = [
  { value: 1, label: 'Below expectations' },
  { value: 2, label: 'Partly meets' },
  { value: 3, label: 'Meets expectations' },
  { value: 4, label: 'Exceeds expectations' },
  { value: 5, label: 'Outstanding' },
];
const year = new Date().getUTCFullYear();

/** Phase 6 through the HTTP API: goals, review cycles with 360 feedback and calibration, learning, surveys and recognition. */
describe('talent', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let other: TestTenant;
  let engineering: string;
  let qa: string;
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

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    other = await createTenant(pool);
    engineering = await department(pool, t, 'Engineering');
    qa = await department(pool, t, 'Quality', engineering);
    people.hr = await addMember(pool, t, { roles: ['hr_admin'], name: 'Hana HR' });
    people.manager = await addMember(pool, t, { roles: ['department_manager'], departmentId: engineering, name: 'Manu Manager' });
    people.manager2 = await addMember(pool, t, { roles: ['department_manager'], name: 'Mira Other' });
    for (const who of ['asha', 'bala', 'chen', 'dev', 'eve']) {
      people[who] = await addMember(pool, t, { departmentId: who === 'dev' ? qa : engineering, name: who });
    }
    tokens.hr = (await loginWithMfa(app, pool, people.hr.email)).accessToken;
    const hire = async (who: string, first: string, managerEmployeeId?: string, departmentId: string | null = engineering) => {
      const body = ok(await as('hr').post('/employees').send({
        legalEntityId: t.legalEntityId, firstName: first, lastName: 'Test', dateOfJoining: `${year - 1}-01-01`, probationMonths: 0,
        membershipId: people[who]!.membershipId, departmentId: departmentId ?? undefined, managerEmployeeId, onboardingTemplateId: null,
      }), 201);
      people[who]!.employeeId = body.employee.id;
    };
    await hire('hr', 'Hana', undefined, null);
    await hire('manager', 'Manu');
    await hire('manager2', 'Mira', undefined, null);
    for (const who of ['asha', 'bala', 'chen', 'eve']) await hire(who, who[0]!.toUpperCase() + who.slice(1), people.manager.employeeId);
    await hire('dev', 'Dev', people.manager.employeeId, qa);
    for (const who of ['manager', 'manager2', 'asha', 'bala', 'chen', 'dev', 'eve']) tokens[who] = (await login(app, people[who]!.email)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('access', () => {
    it('is part of the Business plan', async () => {
      const starter = await createTenant(pool, { plan: 'starter' });
      const owner = (await loginWithMfa(app, pool, starter.ownerEmail)).accessToken;
      for (const path of ['/goals', '/reviews', '/learning/courses', '/recognition']) expect((await api(app, owner).get(path)).status, path).toBe(402);
    });

    it('keeps cycles, catalogue and surveys for HR', async () => {
      for (const who of ['asha', 'manager']) {
        expect((await as(who).get('/review-cycles')).status).toBe(403);
        expect((await as(who).get('/surveys')).status).toBe(403);
        expect((await as(who).post('/learning/courses').send({ title: 'Nope', format: 'online' })).status).toBe(403);
      }
      expect((await as('asha').post('/learning/assignments').send({ employeeIds: [people.bala.employeeId], courseId: people.bala.employeeId })).status).toBe(403);
    });
  });

  describe('goals', () => {
    it('lets people set goals with key results and computes progress from check-ins', async () => {
      const g = ok(await as('asha').post('/goals').send({
        title: 'Ship the night-shift handover app', periodStart: `${year}-01-01`, periodEnd: `${year}-12-31`, weight: 60,
        keyResults: [{ title: 'Screens shipped', startValue: '0', targetValue: '10' }, { title: 'Handover defects per month', startValue: '40', targetValue: '10' }],
      }), 201);
      ids.ashaGoal = g.id;
      const before = ok(await as('asha').get(`/goals/${g.id}`));
      expect(before.progress).toBe(0);
      const [screens, defects] = before.keyResults;
      fails(await as('asha').post(`/goals/${g.id}/checkins`).send({ progress: 50, confidence: 'on_track' }), 400, 'progress_from_key_results');
      const c = ok(await as('asha').post(`/goals/${g.id}/checkins`).send({
        values: [{ keyResultId: screens.id, value: '5' }, { keyResultId: defects.id, value: '25' }], confidence: 'at_risk', note: 'Waiting on the scanner API',
      }), 201);
      expect(c.progress).toBe(50);
      const after = ok(await as('asha').get(`/goals/${g.id}`));
      expect(after.confidence).toBe('at_risk');
      expect(after.checkins[0].values).toEqual([
        { keyResultId: screens.id, title: 'Screens shipped', from: '0.00', to: '5' },
        { keyResultId: defects.id, title: 'Handover defects per month', from: '40.00', to: '25' },
      ]);
      // The manager hears about the risk.
      const n = await pool.find('notifications', { membership_id: people.manager.membershipId, kind: 'goal.at_risk' });
      expect(n[0]!.title).toMatch(/at risk/);
      const mine = ok(await as('asha').get('/goals'));
      expect(mine.overallProgress).toBe(50);
    });

    it('shows a goal only to its owner, their managers and HR', async () => {
      fails(await as('bala').get(`/goals/${ids.ashaGoal}`), 404);
      fails(await as('manager2').get(`/goals/${ids.ashaGoal}`), 404);
      expect(ok(await as('manager').get(`/goals/${ids.ashaGoal}`)).can.manage).toBe(true);
      expect(ok(await as('hr').get(`/goals/${ids.ashaGoal}`)).title).toMatch(/handover/);
      const team = ok(await as('manager').get('/goals?view=team'));
      expect(team.goals.map((g: any) => g.id)).toContain(ids.ashaGoal);
      expect(ok(await as('manager2').get('/goals?view=team')).goals).toHaveLength(0);
      fails(await as('bala').put(`/goals/${ids.ashaGoal}`).send({ title: 'Hijack', periodStart: `${year}-01-01`, periodEnd: `${year}-12-31` }), 404);
    });

    it('lets managers set goals for their team, aligned with their own', async () => {
      const mg = ok(await as('manager').post('/goals').send({ title: 'Cut handover defects by 75%', periodStart: `${year}-01-01`, periodEnd: `${year}-12-31` }), 201);
      ids.managerGoal = mg.id;
      const options = ok(await as('bala').get('/goals/alignable')) as unknown as { id: string }[];
      expect(options.map((o) => o.id)).toContain(mg.id);
      expect(options.map((o) => o.id)).not.toContain(ids.ashaGoal);
      fails(await as('bala').post('/goals').send({ title: 'Support Asha', parentGoalId: ids.ashaGoal, periodStart: `${year}-01-01`, periodEnd: `${year}-06-30` }), 400, 'invalid_parent');
      const bg = ok(await as('manager').post('/goals').send({
        employeeId: people.bala.employeeId, parentGoalId: mg.id, title: 'Run the handover pilot', periodStart: `${year}-01-01`, periodEnd: `${year}-06-30`,
      }), 201);
      ids.balaGoal = bg.id;
      const b = ok(await as('bala').get(`/goals/${bg.id}`));
      expect(b.parent.title).toBe('Cut handover defects by 75%');
      expect(ok(await as('manager').get(`/goals/${mg.id}`)).children.map((c: any) => c.id)).toEqual([bg.id]);
      fails(await as('manager2').post('/goals').send({ employeeId: people.bala.employeeId, title: 'Not my team', periodStart: `${year}-01-01`, periodEnd: `${year}-06-30` }), 404);
      // No key results: progress is reported directly.
      fails(await as('bala').post(`/goals/${bg.id}/checkins`).send({ confidence: 'on_track' }), 400, 'progress_required');
      expect(ok(await as('bala').post(`/goals/${bg.id}/checkins`).send({ progress: 30, confidence: 'on_track' }), 201).progress).toBe(30);
    });

    it('keeps goal history: a goal with check-ins is cancelled, not deleted', async () => {
      fails(await as('bala').delete(`/goals/${ids.balaGoal}`), 409, 'goal_in_use');
      ok(await as('bala').post(`/goals/${ids.balaGoal}/status`).send({ status: 'cancelled', note: 'Pilot moved to next year' }), 201);
      fails(await as('bala').post(`/goals/${ids.balaGoal}/checkins`).send({ progress: 40, confidence: 'on_track' }), 409);
      const draft = ok(await as('bala').post('/goals').send({ title: 'Typo goal', periodStart: `${year}-01-01`, periodEnd: `${year}-01-31` }), 201);
      expect((await as('bala').delete(`/goals/${draft.id}`)).status).toBe(204);
    });
  });

  describe('review cycle', () => {
    it('previews, launches and asks people and managers to write', async () => {
      const c = ok(await as('hr').post('/review-cycles').send({
        name: `H1 ${year} review`, periodStart: `${year}-01-01`, periodEnd: `${year}-06-30`, peerFeedback: true, questions: QUESTIONS, ratingScale: SCALE, departmentId: engineering,
      }), 201);
      ids.cycle = c.id;
      fails(await as('hr').post('/review-cycles').send({ name: 'Bad scale', periodStart: `${year}-01-01`, periodEnd: `${year}-06-30`, questions: QUESTIONS, ratingScale: [{ value: 2, label: 'Two' }, { value: 1, label: 'One' }] }), 422);
      const draft = ok(await as('hr').get(`/review-cycles/${c.id}`));
      expect(draft.preview.map((p: any) => p.name).sort()).toEqual(['Asha Test', 'Bala Test', 'Chen Test', 'Dev Test', 'Eve Test', 'Manu Test']);
      const l = ok(await as('hr').post(`/review-cycles/${c.id}/launch`), 201);
      expect(l).toEqual({ participants: 6, withoutManager: 1 });
      fails(await as('hr').put(`/review-cycles/${c.id}`).send({ name: 'Too late', periodStart: `${year}-01-01`, periodEnd: `${year}-06-30`, questions: QUESTIONS, ratingScale: SCALE }), 409);
      expect(await pool.count('notifications', { kind: 'review.self_requested', tenant_id: t.id })).toBe(6);
      const mine = ok(await as('asha').get('/reviews')) as unknown as { id: string }[];
      expect(mine).toHaveLength(1);
      ids.ashaReview = mine[0]!.id;
      const team = ok(await as('manager').get('/reviews?view=team')) as unknown as { id: string; employeeName: string }[];
      expect(team).toHaveLength(5);
      for (const r of team) ids[`review_${r.employeeName.split(' ')[0]!.toLowerCase()}`] = r.id;
    });

    it('takes self reviews as drafts, then locks them on submit', async () => {
      const id = ids.ashaReview;
      ok(await as('asha').put(`/reviews/${id}/self`).send({ answers: { achievements: 'Shipped the handover app pilot' }, rating: 4 }));
      fails(await as('asha').put(`/reviews/${id}/self`).send({ answers: { achievements: 'Shipped' }, rating: 4, submit: true }), 400, 'answers_missing');
      fails(await as('asha').put(`/reviews/${id}/self`).send({ answers: { nope: 'x' } }), 400, 'unknown_question');
      // The manager does not see a draft.
      expect(ok(await as('manager').get(`/reviews/${id}`)).selfAnswers).toEqual({});
      ok(await as('asha').put(`/reviews/${id}/self`).send({ answers: { achievements: 'Shipped the handover app pilot', growth: 'Delegate more' }, rating: 4, submit: true }));
      fails(await as('asha').put(`/reviews/${id}/self`).send({ answers: { achievements: 'Changed my mind' }, rating: 5 }), 409);
      expect(ok(await as('manager').get(`/reviews/${id}`)).selfRating).toBe(4);
      fails(await as('bala').get(`/reviews/${id}`), 404);
      fails(await as('asha').put(`/reviews/${id}/manager`).send({ answers: {}, rating: 5 }), 403);
    });

    it('collects 360 feedback from colleagues', async () => {
      const id = ids.ashaReview;
      fails(await as('manager').post(`/reviews/${id}/feedback-requests`).send({ reviewerEmployeeIds: [people.asha.employeeId] }), 400, 'invalid_reviewer');
      ok(await as('manager').post(`/reviews/${id}/feedback-requests`).send({ reviewerEmployeeIds: [people.bala.employeeId, people.chen.employeeId, people.dev.employeeId] }), 201);
      ok(await as('manager').post(`/reviews/${ids.review_bala}/feedback-requests`).send({ reviewerEmployeeIds: [people.asha.employeeId] }), 201);
      const comments: Record<string, [string, string]> = { bala: ['Unblocks the night shift', 'Write things down'], chen: ['Great pairing partner', 'Share demos earlier'], dev: ['Calm under pressure', 'Ask QA sooner'] };
      for (const who of ['bala', 'chen', 'dev']) {
        const inbox = ok(await as(who).get('/reviews?view=feedback')) as unknown as { id: string; employeeName: string }[];
        const req = inbox.find((r) => r.employeeName === 'Asha Test')!;
        const form = ok(await as(who).get(`/feedback/${req.id}`));
        expect(form.notice).toMatch(/without names/);
        fails(await as(who).put(`/feedback/${req.id}`).send({ answers: { strengths: 'x' }, submit: true }), 400, 'answers_missing');
        ok(await as(who).put(`/feedback/${req.id}`).send({ answers: { strengths: comments[who]![0], improve: comments[who]![1] }, submit: true }));
        fails(await as(who).put(`/feedback/${req.id}`).send({ answers: { strengths: 'Edited' } }), 409);
      }
      const forManager = ok(await as('manager').get(`/reviews/${id}`));
      expect(forManager.peer.requests.map((r: any) => r.reviewerName).sort()).toEqual(['Bala Test', 'Chen Test', 'Dev Test']);
      const feedbackId = forManager.peer.requests[0].id;
      fails(await as('asha').get(`/feedback/${feedbackId}`), 404);
    });

    it('needs every manager review before calibration; HR can exclude people with a reason', async () => {
      const write = (id: string, rating: number, submit = true) =>
        as('manager').put(`/reviews/${id}/manager`).send({ answers: { achievements: 'Delivered', growth: 'Keep going' }, rating, submit });
      ok(await write(ids.ashaReview!, 3));
      fails(await write(ids.ashaReview!, 5), 409);
      for (const [who, rating] of [['bala', 3], ['chen', 4], ['dev', 2]] as const) ok(await write(ids[`review_${who}`]!, rating));
      fails(await as('manager2').put(`/reviews/${ids.review_eve}/manager`).send({ answers: {}, rating: 3 }), 404);
      const blocked = await as('hr').post(`/review-cycles/${ids.cycle}/calibration`);
      fails(blocked, 409, 'manager_reviews_missing');
      expect(blocked.body.error.message).toMatch(/Eve Test, Manu Test/);
      ok(await as('hr').post(`/reviews/${ids.review_eve}/exclude`).send({ reason: 'On long leave for most of the period' }), 201);
      // Manu has no manager in SampCrew, so HR writes that review.
      const manu = (ok(await as('hr').get(`/review-cycles/${ids.cycle}`)).reviews as any[]).find((r) => r.employeeName === 'Manu Test');
      expect(ok(await as('hr').get(`/reviews/${manu.id}`)).can.writeManager).toBe(true);
      ok(await as('hr').put(`/reviews/${manu.id}/manager`).send({ answers: { achievements: 'Built the team', growth: 'Hire a lead' }, rating: 4, submit: true }));
      ok(await as('hr').post(`/review-cycles/${ids.cycle}/calibration`), 201);
      // Unanswered requests close when calibration starts.
      const late = await pool.find('review_feedback', { reviewer_employee_id: people.asha.employeeId });
      expect(late[0]!.status).toBe('withdrawn');
      fails(await as('asha').put(`/feedback/${late[0]!.id}`).send({ answers: { strengths: 'late' } }), 409);
    });

    it('calibrates with reasons and keeps results hidden until release', async () => {
      const id = ids.ashaReview!;
      fails(await as('manager').post(`/reviews/${id}/calibrate`).send({ finalRating: 5, reason: 'My favourite' }), 403);
      fails(await as('hr').post(`/reviews/${id}/calibrate`).send({ finalRating: 4, reason: 'no' }), 422);
      ok(await as('hr').post(`/reviews/${id}/calibrate`).send({ finalRating: 4, reason: 'Pilot impact was larger than the manager review reflects' }), 201);
      const cycle = ok(await as('hr').get(`/review-cycles/${ids.cycle}`));
      expect(cycle.distribution.manager.levels.map((l: any) => l.count)).toEqual([0, 1, 2, 2, 0]);
      expect(cycle.distribution.final.levels.map((l: any) => l.count)).toEqual([0, 1, 1, 3, 0]);
      const hrView = ok(await as('hr').get(`/reviews/${id}`));
      expect(hrView.calibrations).toMatchObject([{ fromRating: 3, toRating: 4 }]);
      const early = ok(await as('asha').get(`/reviews/${id}`));
      expect(early.finalRating).toBeNull();
      expect(early.managerAnswers).toEqual({});
      expect(early.peer.shown).toBe(false);
      expect(ok(await as('manager').get(`/reviews/${id}`)).calibrations).toEqual([]);
    });

    it('releases results; peer feedback reaches the employee without names, and only above the threshold', async () => {
      ok(await as('hr').post(`/review-cycles/${ids.cycle}/release`), 201);
      const r = ok(await as('asha').get(`/reviews/${ids.ashaReview}`));
      expect(r.finalRating).toBe(4);
      expect(r.managerAnswers.achievements).toBe('Delivered');
      expect(r.peer.shown).toBe(true);
      expect(r.peer.answers[0].comments).toEqual(['Calm under pressure', 'Great pairing partner', 'Unblocks the night shift']);
      expect(JSON.stringify(r.peer)).not.toMatch(/Bala|Chen|Dev/);
      const bala = ok(await as('bala').get(`/reviews/${ids.review_bala}`));
      expect(bala.peer).toMatchObject({ shown: false });
      expect(bala.peer.reason).toMatch(/at least 3/);
      expect((ok(await as('eve').get('/reviews')) as unknown as unknown[])).toHaveLength(0);
      ok(await as('asha').post(`/reviews/${ids.ashaReview}/acknowledge`).send({ comment: 'Thanks, agreed on delegation' }), 201);
      fails(await as('asha').post(`/reviews/${ids.ashaReview}/acknowledge`).send({}), 409);
      fails(await as('hr').post(`/reviews/${ids.ashaReview}/calibrate`).send({ finalRating: 2, reason: 'Changing it after release' }), 409);
    });

    it('freezes released reviews in the database itself', async () => {
      await expect(pool.update('reviews', { id: ids.ashaReview }, { $set: { final_rating: 1 } })).rejects.toThrow(/released review/);
      await expect(pool.delete('reviews', { id: ids.ashaReview })).rejects.toThrow(/released review/);
      const fb = (await pool.one('review_feedback', { review_id: ids.ashaReview, status: 'submitted' }))!;
      await expect(pool.update('review_feedback', { id: fb.id }, { $set: { answers: {} } })).rejects.toThrow(/cannot be changed/);
      // Calibration history is insert-only from a workspace transaction.
      await expect(pool.tenant(t.id, (tx) => tx.collection('review_calibrations').update({}, { $set: { to_rating: 5 } }))).rejects.toThrow(/not allowed/);
    });
  });

  describe('learning', () => {
    it('builds a catalogue and paths', async () => {
      fails(await as('hr').post('/learning/courses').send({ title: 'Insecure link', format: 'online', contentUrl: 'http://example.com' }), 422);
      ids.safety = ok(await as('hr').post('/learning/courses').send({ title: 'Forklift safety refresher', format: 'video', contentUrl: 'https://learn.example.com/forklift', durationMinutes: 45, validityMonths: 12, category: 'Safety', selfEnrol: false }), 201).id;
      ids.drill = ok(await as('hr').post('/learning/courses').send({ title: 'Fire drill', format: 'classroom', durationMinutes: 60, category: 'Safety', selfEnrol: false }), 201).id;
      ids.excel = ok(await as('hr').post('/learning/courses').send({ title: 'Spreadsheets for supervisors', format: 'online', category: 'Skills' }), 201).id;
      ids.path = ok(await as('hr').post('/learning/paths').send({ title: 'Shop floor safety', courseIds: [ids.safety, ids.drill] }), 201).id;
      const paths = ok(await as('asha').get('/learning/paths')) as unknown as { courses: { title: string }[] }[];
      expect(paths[0]!.courses.map((c) => c.title)).toEqual(['Forklift safety refresher', 'Fire drill']);
    });

    it('lets managers assign to their team only, without duplicates', async () => {
      const due = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
      fails(await as('manager').post('/learning/assignments').send({ employeeIds: [people.asha.employeeId], pathId: ids.path, dueOn: '2001-01-01' }), 400, 'past_due_date');
      const a = ok(await as('manager').post('/learning/assignments').send({ employeeIds: [people.asha.employeeId, people.bala.employeeId], pathId: ids.path, dueOn: due }), 201);
      expect(a).toEqual({ created: 4, skipped: [] });
      const again = ok(await as('manager').post('/learning/assignments').send({ employeeIds: [people.asha.employeeId], courseId: ids.safety }), 201);
      expect(again.created).toBe(0);
      expect(again.skipped[0]).toMatch(/already assigned/);
      fails(await as('manager2').post('/learning/assignments').send({ employeeIds: [people.asha.employeeId], courseId: ids.excel }), 403);
      const n = await pool.find('notifications', { membership_id: people.asha.membershipId, kind: 'learning.assigned' });
      expect(n[0]!.title).toMatch(/2 courses/);
    });

    it('records completion with an expiry; classroom attendance is confirmed by the manager', async () => {
      const mine = ok(await as('asha').get('/learning/assignments')) as unknown as { id: string; courseTitle: string; status: string }[];
      const safety = mine.find((x) => x.courseTitle === 'Forklift safety refresher')!;
      const drill = mine.find((x) => x.courseTitle === 'Fire drill')!;
      ok(await as('asha').post(`/learning/assignments/${safety.id}/start`), 201);
      fails(await as('bala').post(`/learning/assignments/${safety.id}/complete`).send({}), 404);
      const today = new Date();
      ok(await as('asha').post(`/learning/assignments/${safety.id}/complete`).send({ note: 'Passed the quiz' }), 201);
      fails(await as('asha').post(`/learning/assignments/${drill.id}/complete`).send({}), 403);
      fails(await as('asha').post(`/learning/assignments/${drill.id}/cancel`).send({ reason: 'Do not want it' }), 403);
      ok(await as('manager').post(`/learning/assignments/${drill.id}/complete`).send({ note: 'Attended on the floor' }), 201);
      const done = (ok(await as('asha').get('/learning/assignments')) as unknown as any[]).find((x) => x.id === safety.id);
      const expected = new Date(Date.UTC(today.getUTCFullYear() + 1, today.getUTCMonth(), today.getUTCDate())).toISOString().slice(0, 10);
      expect(done.status).toBe('completed');
      expect(done.expiresOn).toBe(expected);
      fails(await as('manager').post(`/learning/assignments/${safety.id}/cancel`).send({ reason: 'Undo' }), 409);
      await expect(pool.update('course_assignments', { id: safety.id }, { $set: { completed_on: '2001-01-01' } })).rejects.toThrow(/completed course/);
      // A lapsed completion is flagged and the course can be assigned again.
      // (Past the guard, straight in the database, as if a year had gone by.)
      await (await pool.database()).collection('course_assignments').updateOne({ _id: safety.id }, { $set: { expires_on: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10) } });
      expect((ok(await as('asha').get('/learning/assignments')) as unknown as any[]).find((x) => x.id === safety.id).expired).toBe(true);
      expect(ok(await as('manager').post('/learning/assignments').send({ employeeIds: [people.asha.employeeId], courseId: ids.safety }), 201).created).toBe(1);
    });

    it('supports self-enrolment where the course allows it, and shows overdue work to the manager', async () => {
      fails(await as('chen').post(`/learning/courses/${ids.safety}/enrol`), 403);
      ok(await as('chen').post(`/learning/courses/${ids.excel}/enrol`), 201);
      fails(await as('chen').post(`/learning/courses/${ids.excel}/enrol`), 409, 'already_enrolled');
      const courses = ok(await as('chen').get('/learning/courses')) as unknown as { id: string; myStatus: string }[];
      expect(courses.find((c) => c.id === ids.excel)!.myStatus).toBe('in_progress');
      await pool.update('course_assignments', { employee_id: people.bala.employeeId, status: 'assigned' }, { $set: { due_on: new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10) } });
      const overdue = ok(await as('manager').get('/learning/assignments?view=team&status=overdue')) as unknown as { employeeName: string; overdue: boolean }[];
      expect(overdue.length).toBe(2);
      expect(overdue.every((o) => o.employeeName === 'Bala Test' && o.overdue)).toBe(true);
      expect(ok(await as('manager2').get('/learning/assignments?view=team')) as unknown as unknown[]).toHaveLength(0);
    });
  });

  describe('surveys', () => {
    const questions = [
      { id: 'tools', kind: 'scale', text: 'I have the tools I need' },
      { id: 'enps', kind: 'enps', text: 'How likely are you to recommend working here?' },
      { id: 'other', kind: 'text', text: 'Anything else?' },
    ];

    it('refuses audiences smaller than the anonymity threshold', async () => {
      const s = ok(await as('hr').post('/surveys').send({ title: 'Quality team pulse', minResponses: 3, questions, departmentId: qa }), 201);
      fails(await as('hr').post(`/surveys/${s.id}/open`), 400, 'audience_too_small');
      fails(await as('hr').post('/surveys').send({ title: 'Too low', minResponses: 2, questions }), 422);
    });

    it('collects one anonymous answer per person', async () => {
      ids.survey = ok(await as('hr').post('/surveys').send({ title: 'Engineering pulse', minResponses: 3, questions, departmentId: engineering }), 201).id;
      expect(ok(await as('hr').post(`/surveys/${ids.survey}/open`), 201).invited).toBe(6);
      fails(await as('hr').put(`/surveys/${ids.survey}`).send({ title: 'Changed', questions }), 409);
      expect(ok(await as('hr').get(`/surveys/${ids.survey}/results`))).toMatchObject({ shown: false, invited: 6, responded: 0 });
      const form = ok(await as('asha').get(`/my-surveys/${ids.survey}`));
      expect(form.notice).toMatch(/without your name/);
      fails(await as('hr').get(`/my-surveys/${ids.survey}`), 404);
      fails(await as('asha').post(`/my-surveys/${ids.survey}/responses`).send({ answers: { tools: 9, enps: 8 } }), 400, 'invalid_answers');
      const answers: Record<string, Record<string, unknown>> = {
        asha: { tools: 4, enps: 9, other: 'More standing desks' },
        bala: { tools: 2, enps: 6 },
        chen: { tools: 5, enps: 10, other: 'Async standups please' },
        dev: { tools: 3, enps: 7 },
      };
      for (const [who, a] of Object.entries(answers)) ok(await as(who).post(`/my-surveys/${ids.survey}/responses`).send({ answers: a }), 201);
      fails(await as('asha').post(`/my-surveys/${ids.survey}/responses`).send({ answers: answers.asha }), 409, 'already_responded');
      const stored = await pool.find('survey_responses', { survey_id: ids.survey });
      expect(stored).toHaveLength(4);
      expect(stored.every((r) => (r.employee_id ?? null) === null)).toBe(true);
      await expect(pool.insert('survey_responses', { tenant_id: t.id, survey_id: ids.survey, employee_id: people.eve.employeeId, answers: {} })).rejects.toThrow(/anonymous/);
      expect(await pool.count('audit_events', { tenant_id: t.id, resource_id: ids.survey, action: { $regex: '^survey\\.respon' } })).toBe(0);
    });

    it('shows results above the threshold and withholds a breakdown that would expose a small group', async () => {
      const r = ok(await as('hr').get(`/surveys/${ids.survey}/results`));
      expect(r).toMatchObject({ shown: true, invited: 6, responded: 4 });
      expect(r.questions[0].average).toBe(3.5);
      expect(r.questions[1].enps).toBe(25); // promoters 9 and 10, detractor 6, of 4
      expect(r.questions[2].comments).toEqual(['Async standups please', 'More standing desks']);
      // Engineering has 3 answers and Quality 1: showing Engineering would reveal Quality's single answer by subtraction.
      expect(r.breakdown.shown).toBe(false);
      fails(await as('manager').get(`/surveys/${ids.survey}/results`), 403);
      ok(await as('hr').post(`/surveys/${ids.survey}/close`), 201);
      fails(await as('eve').post(`/my-surveys/${ids.survey}/responses`).send({ answers: { tools: 3, enps: 7 } }), 409, 'survey_closed');
    });
  });

  describe('recognition', () => {
    it('posts to the wall and notifies the person and their manager', async () => {
      const values = ok(await as('asha').get('/company-values')) as unknown as { id: string; name: string }[];
      const teamwork = values.find((v) => v.name === 'Teamwork')!;
      fails(await as('asha').post('/recognition').send({ toEmployeeId: people.asha.employeeId, message: 'Me again' }), 400, 'self_recognition');
      ids.kudos = ok(await as('asha').post('/recognition').send({ toEmployeeId: people.bala.employeeId, valueId: teamwork.id, message: 'Covered my shift at short notice' }), 201).id;
      const feed = ok(await as('chen').get('/recognition')) as unknown as any[];
      expect(feed[0]).toMatchObject({ fromName: 'Asha Test', toName: 'Bala Test', valueName: 'Teamwork', message: 'Covered my shift at short notice' });
      const n = await pool.find('notifications', { membership_id: { $in: [people.bala.membershipId, people.manager.membershipId] }, kind: { $regex: '^recognition\\.' } }, { sort: { kind: 1 } });
      expect(n.map((r) => r.kind)).toEqual(['recognition.received', 'recognition.team']);
    });

    it('lets HR hide a post with a reason', async () => {
      fails(await as('asha').post(`/recognition/${ids.kudos}/hide`).send({ reason: 'Mine' }), 403);
      ok(await as('hr').post(`/recognition/${ids.kudos}/hide`).send({ reason: 'Posted to the wrong person' }), 201);
      expect((ok(await as('chen').get('/recognition')) as unknown as unknown[])).toHaveLength(0);
      expect((ok(await as('hr').get('/recognition')) as unknown as any[])[0].hiddenReason).toBe('Posted to the wrong person');
    });
  });

  describe('isolation', () => {
    it('keeps every Phase 6 record inside its workspace', async () => {
      const tables = ['goals', 'goal_key_results', 'goal_checkins', 'review_cycles', 'reviews', 'review_feedback', 'review_calibrations', 'courses', 'learning_paths',
        'learning_path_courses', 'course_assignments', 'surveys', 'survey_invitations', 'survey_responses', 'company_values', 'recognitions'];
      await expectHiddenFrom(pool, t, other, tables);
      await expect(pool.tenant(other.id, (tx) => tx.collection('company_values').insert({ tenant_id: t.id, name: 'Injected' }))).rejects.toThrow();
      const owner = (await loginWithMfa(app, pool, other.ownerEmail)).accessToken;
      const o = api(app, owner);
      expect((await o.get(`/goals/${ids.ashaGoal}`)).status).toBe(404);
      expect((await o.get(`/reviews/${ids.ashaReview}`)).status).toBe(404);
      expect((await o.get(`/review-cycles/${ids.cycle}`)).status).toBe(404);
      expect((await o.get(`/surveys/${ids.survey}/results`)).status).toBe(404);
      expect((await o.post(`/learning/courses/${ids.excel}/enrol`)).status).toBe(400); // no employee record in that workspace
      expect(ok(await o.get('/recognition')) as unknown as unknown[]).toHaveLength(0);
      expect((ok(await o.get('/learning/courses')) as unknown as { title: string }[]).map((c) => c.title)).not.toContain('Fire drill');
    });
  });
});
