import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, adminPool, api, createApp, createTenant, department, login, loginWithMfa, type TestDb, type TestTenant } from './helpers';

/**
 * Appraisals: HR adds the Frequent Research form from its template and edits it, launches a cycle, the employee
 * self-appraises (draft, then submit and lock), the manager evaluates, HR finalises (with an override that needs a
 * reason) and publishes. Each person sees only their part until results are shared.
 */
describe('appraisals', () => {
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
  let formId: string;
  let cycleId: string;
  let ashaAppraisal: string;
  let manuAppraisal: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ratedIds = (detail: Record<string, any>) => (detail.definition.sections as { kind: string; questions: { id: string }[] }[]).filter((s) => s.kind === 'rated').flatMap((s) => s.questions.map((q) => q.id));

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    engineering = await department(pool, t, 'Engineering');
    people.hr = await addMember(pool, t, { roles: ['hr_admin'], name: 'Hana HR' });
    people.manager = await addMember(pool, t, { roles: ['department_manager'], departmentId: engineering, name: 'Manu Manager' });
    people.asha = await addMember(pool, t, { departmentId: engineering, name: 'Asha Rao' });
    people.other = await addMember(pool, t, { departmentId: engineering, name: 'Oz Other' });
    tokens.hr = (await loginWithMfa(app, pool, people.hr.email)).accessToken;
    const hire = async (who: string, first: string, managerEmployeeId?: string, departmentId: string | null = engineering) => {
      const body = ok(await as('hr').post('/employees').send({
        legalEntityId: t.legalEntityId, firstName: first, lastName: 'Test', dateOfJoining: '2024-04-01', probationMonths: 0, membershipId: people[who]!.membershipId,
        departmentId, managerEmployeeId, onboardingTemplateId: null,
      }), 201);
      people[who]!.employeeId = body.employee.id;
    };
    await hire('hr', 'Hana', undefined, null);
    await hire('manager', 'Manu');
    await hire('asha', 'Asha', people.manager.employeeId);
    await hire('other', 'Oz', people.manager.employeeId);
    for (const who of ['manager', 'asha', 'other']) tokens[who] = (await login(app, people[who]!.email)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('HR adds the Frequent Research template as a form and can change it; others cannot', async () => {
    expect((await as('manager').get('/appraisals/forms')).status).toBe(403);
    const before = ok(await as('hr').get('/appraisals/forms'));
    expect(before.forms).toEqual([]);
    expect(before.templates).toEqual([{ key: 'frequent_research', name: 'Frequent Research Employee Performance Evaluation', added: false }]);
    const form = ok(await as('hr').post('/appraisals/forms/from-template').send({ key: 'frequent_research' }), 201);
    formId = form.id;
    expect(form).toMatchObject({ isDefault: true, templateKey: 'frequent_research' });
    expect(form.definition.sections.map((s: { title: string }) => s.title)).toContain('Discretion and Confidentiality');
    // HR weights Productivity double and adds a question.
    const def = structuredClone(form.definition);
    const prod = def.sections.find((s: { id: string }) => s.id === 'productivity');
    for (const q of prod.questions) q.weight = 2;
    prod.questions.push({ id: 'productivity-4', text: 'Delivers client projects within budget', kind: 'score', weight: 2, required: true, active: true });
    const saved = ok(await as('hr').put(`/appraisals/forms/${formId}`).send({ name: form.name, isDefault: true, definition: def }));
    expect(saved.version).toBe(2);
    // Invalid forms are refused (a band set with no 0% start).
    expect((await as('hr').put(`/appraisals/forms/${formId}`).send({ name: form.name, definition: { ...def, bands: [{ min: 40, label: 'X' }] } })).status).toBe(422);
    const copy = ok(await as('hr').post(`/appraisals/forms/${formId}/duplicate`), 201);
    expect(copy.name).toContain('(copy)');
    expect(copy.isDefault).toBe(false);
  });

  it('HR launches a cycle; everyone with a login gets an appraisal and a notification', async () => {
    const cycle = ok(await as('hr').post('/appraisals/cycles').send({
      name: 'FY 2026 annual appraisal', formId, periodStart: '2025-04-01', periodEnd: '2026-03-31', selfDue: '2030-01-15', managerDue: '2030-01-31', hrDue: '2030-02-15', departmentIds: [engineering],
    }), 201);
    cycleId = cycle.id;
    expect((await as('hr').post('/appraisals/cycles').send({ name: 'Bad', formId, periodStart: '2026-01-01', periodEnd: '2025-01-01', selfDue: '2030-01-15', managerDue: '2030-01-31' })).status).toBe(422);
    const launched = ok(await as('hr').post(`/appraisals/cycles/${cycleId}/launch`));
    expect(launched.created).toBe(3);
    expect((await as('hr').post(`/appraisals/cycles/${cycleId}/launch`)).status).toBe(409);
    expect(await notes('asha', 'appraisal.assigned')).toBe(1);
    const mine = ok(await as('asha').get('/appraisals/mine')) as unknown as Record<string, unknown>[];
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ stage: 'self', selfCompletion: 0, cycleName: 'FY 2026 annual appraisal', managerName: 'Manu Test' });
    ashaAppraisal = mine[0]!.id as string;
    manuAppraisal = (ok(await as('manager').get('/appraisals/mine')) as unknown as { id: string }[])[0]!.id;
  });

  it('Management Skills applies only to people who manage others; employee details fill in from the profile', async () => {
    const asha = ok(await as('asha').get(`/appraisals/${ashaAppraisal}`));
    const manu = ok(await as('manager').get(`/appraisals/${manuAppraisal}`));
    expect(asha.definition.sections.map((s: { id: string }) => s.id)).not.toContain('management');
    expect(manu.definition.sections.map((s: { id: string }) => s.id)).toContain('management');
    expect(asha.employee).toMatchObject({ name: 'Asha Test', department: 'Engineering', dateOfJoining: '2024-04-01', managerName: 'Manu Test' });
    // Someone outside the appraisal cannot open it.
    expect((await as('other').get(`/appraisals/${ashaAppraisal}`)).status).toBe(404);
  });

  it('the employee saves a draft, cannot submit until complete, then submits and is locked', async () => {
    const detail = ok(await as('asha').get(`/appraisals/${ashaAppraisal}`));
    const ids = ratedIds(detail);
    expect((await as('asha').put(`/appraisals/${ashaAppraisal}/answers`).send({ answers: { [ids[0]!]: { score: 6 } } })).status).toBe(422);
    expect((await as('asha').put(`/appraisals/${ashaAppraisal}/answers`).send({ answers: { 'manager-feedback-1': { text: 'I am great' } } })).status).toBe(400);
    const draft = ok(await as('asha').put(`/appraisals/${ashaAppraisal}/answers`).send({ answers: { [ids[0]!]: { score: 5, comment: 'I know the job well' } } }));
    expect(draft.completion.employee).toBeGreaterThan(0);
    expect((await as('asha').post(`/appraisals/${ashaAppraisal}/submit`)).status).toBe(400);
    const answers: Record<string, unknown> = Object.fromEntries(ids.map((id) => [id, { score: 5 }]));
    answers['self-questions-1'] = { text: 'Launched the new survey platform' };
    answers['self-questions-2'] = { text: 'Cut fieldwork turnaround by a week' };
    answers['self-questions-3'] = { text: 'Lead a project team' };
    ok(await as('asha').put(`/appraisals/${ashaAppraisal}/answers`).send({ answers }));
    const submitted = ok(await as('asha').post(`/appraisals/${ashaAppraisal}/submit`));
    expect(submitted.stage).toBe('manager');
    expect(submitted.result.selfPercent).toBe(100);
    expect(await notes('manager', 'appraisal.self_submitted')).toBe(1);
    expect((await as('asha').put(`/appraisals/${ashaAppraisal}/answers`).send({ answers })).status).toBe(409);
  });

  it('the manager sees the self-appraisal, scores independently and submits; the employee does not see manager scores yet', async () => {
    const m = ok(await as('manager').get(`/appraisals/${ashaAppraisal}`));
    expect(m.role).toBe('manager');
    expect(m.answers.employee['self-questions-1'].text).toBe('Launched the new survey platform');
    const ids = ratedIds(m);
    // Productivity questions (weight 2) get 3, everything else 4.
    const answers: Record<string, unknown> = Object.fromEntries(ids.map((id) => [id, { score: id.startsWith('productivity') ? 3 : 4, comment: 'Solid' }]));
    for (let i = 1; i <= 6; i++) answers[`manager-feedback-${i}`] = { text: `Feedback ${i}` };
    ok(await as('manager').put(`/appraisals/${ashaAppraisal}/answers`).send({ answers }));
    const done = ok(await as('manager').post(`/appraisals/${ashaAppraisal}/submit`));
    expect(done.stage).toBe('hr');
    // 16 questions at 80% (weight 1) and 4 at 60% (weight 2): (16*80 + 4*2*60) / 24 = 73.6
    expect(done.result.managerPercent).toBe(73.6);
    expect(await notes('hr', 'appraisal.manager_submitted')).toBe(1);
    const e = ok(await as('asha').get(`/appraisals/${ashaAppraisal}`));
    expect(e.answers.manager).toEqual({});
    expect(e.result.managerPercent).toBeNull();
    expect(e.result.finalPercent).toBeNull();
  });

  it('HR reviews: an override needs a reason; finalising and publishing shares the result', async () => {
    const h = ok(await as('hr').get(`/appraisals/${ashaAppraisal}`));
    expect(h.result).toMatchObject({ calculatedPercent: 73.6, finalPercent: 73.6, band: 'Good Performance' });
    const hrAnswers = Object.fromEntries([1, 2, 3, 4, 5].map((i) => [`hr-evaluation-${i}`, { text: `HR note ${i}` }]));
    expect((await as('hr').put(`/appraisals/${ashaAppraisal}/answers`).send({ answers: hrAnswers, finalPercent: 86 })).status).toBe(422);
    // HR raises one productivity question's final score to 4 and records an approved percentage with a reason.
    const saved = ok(await as('hr').put(`/appraisals/${ashaAppraisal}/answers`).send({ answers: hrAnswers, finalScores: { 'productivity-1': 4 }, finalPercent: 86, overrideReason: 'Client award in Q4 not reflected in scores' }));
    expect(saved.result.calculatedPercent).toBe(75.2);
    expect(saved.result).toMatchObject({ finalPercent: 86, band: 'Very Good Performance' });
    const fin = ok(await as('hr').post(`/appraisals/${ashaAppraisal}/submit`));
    expect(fin.stage).toBe('finalized');
    expect(await notes('manager', 'appraisal.finalized')).toBe(1);
    // Not shared until published.
    expect(ok(await as('asha').get(`/appraisals/${ashaAppraisal}`)).result.finalPercent).toBeNull();
    const pub = ok(await as('hr').post(`/appraisals/cycles/${cycleId}/publish`));
    expect(pub.published).toBe(1);
    expect(await notes('asha', 'appraisal.published')).toBe(1);
    const e = ok(await as('asha').get(`/appraisals/${ashaAppraisal}`));
    expect(e.result).toMatchObject({ selfPercent: 100, managerPercent: 73.6, finalPercent: 86, band: 'Very Good Performance' });
    expect(e.answers.manager['manager-feedback-1'].text).toBe('Feedback 1');
    const mine = ok(await as('asha').get('/appraisals/mine')) as unknown as Record<string, unknown>[];
    expect(mine[0]).toMatchObject({ stage: 'published', finalPercent: 86, band: 'Very Good Performance' });
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'appraisal.published' })).toBe(1);
  });

  it('HR can reopen a stage with a reason, which unlocks it for that person', async () => {
    expect((await as('manager').post(`/appraisals/${ashaAppraisal}/reopen`).send({ stage: 'manager', reason: 'Fix a score' })).status).toBe(403);
    const r = ok(await as('hr').post(`/appraisals/${ashaAppraisal}/reopen`).send({ stage: 'manager', reason: 'Recheck teamwork scores' }));
    expect(r.stage).toBe('manager');
    expect(r.publishedAt).toBeNull();
    expect(await notes('manager', 'appraisal.reopened')).toBe(1);
    expect(ok(await as('manager').get(`/appraisals/${ashaAppraisal}`)).canEdit).toBe(true);
    const reviews = ok(await as('manager').get('/appraisals/reviews'));
    expect(reviews.team.map((x: { id: string }) => x.id)).toContain(ashaAppraisal);
    expect(reviews.isHr).toBe(false);
  });
});
