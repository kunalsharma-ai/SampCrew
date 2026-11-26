import type { INestApplication } from '@nestjs/common';
import { DEFAULT_LIBRARY_ITEMS } from '@crew/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, adminPool, api, createApp, createTenant, login, loginWithMfa, type TestDb, type TestTenant } from './helpers';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const day = (n: number) => new Date(Date.now() + 330 * 60_000 + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Onboarding documents (issue #89), the seven test scenarios of the brief through the API: HR adds an employee with
 * ten documents from a template; the employee uploads five; HR approves three and rejects one with a comment; the
 * employee resubmits; every mandatory document approved completes and archives the checklist; HR cannot change the
 * library until the Super Workspace allows it; employees cannot see each other's documents; both sides read the same
 * records.
 */
describe('Onboarding documents', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let owner: string;
  let pune: string;
  let hr: { email: string; membershipId: string; token: string };
  let joiner: { email: string; membershipId: string; employeeId: string; token: string };
  let other: { email: string; membershipId: string; employeeId: string; token: string };
  let checklistId: string;
  let lib: { items: { id: string; key: string; name: string; requirement: string; multiple: boolean; maxFiles: number }[]; templates: { id: string; key: string; items: { itemId: string; required: boolean }[] }[]; categories: { id: string; name: string }[] };

  const ok = (res: { status: number; body: unknown }, status = 200) => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body as Record<string, any>;
  };
  const submit = (token: string, requestId: string, files: { buf: Buffer; name: string; type: string }[] = [{ buf: PDF, name: 'doc.pdf', type: 'application/pdf' }]) => {
    let r = api(app, token).post(`/document-requests/${requestId}/submit`);
    for (const f of files) r = r.attach(files.length > 1 ? 'files' : 'file', f.buf, { filename: f.name, contentType: f.type });
    return r;
  };
  const decide = (token: string, requestId: string, decision: 'approve' | 'reject', comment?: string) => api(app, token).post(`/document-requests/${requestId}/decision`).send({ decision, ...(comment ? { comment } : {}) });

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool, { plan: 'business' });
    owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    const h = await addMember(pool, t, { name: 'Hema Pune HR' });
    const p = ok(await api(app, owner).post('/hr-workspaces').send({ name: 'Pune Branch', code: 'PUNE', kind: 'branch', features: ['leave', 'documents', 'core_hr'], adminMembershipIds: [h.membershipId] }), 201);
    pune = p.id;
    hr = { ...h, token: (await login(app, h.email)).accessToken };
    const o = await addMember(pool, t, { name: 'Omar Other' });
    const oid = ok(await api(app, owner).post('/employees').send({ legalEntityId: t.legalEntityId, firstName: 'Omar', lastName: 'Other', dateOfJoining: day(-10), probationMonths: 0, onboardingTemplateId: null, membershipId: o.membershipId, hrWorkspaceId: pune }), 201).employee.id;
    other = { ...o, employeeId: oid, token: (await login(app, o.email)).accessToken };
  });
  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('the library is prepopulated once with 35 documents in 7 categories and 8 templates', async () => {
    lib = ok(await api(app, hr.token).get('/onboarding-documents/library')) as typeof lib;
    expect(lib.categories.map((c) => c.name)).toEqual(['A. Identity Verification', 'B. Address Verification', 'C. Educational Documents', 'D. Employment History and Experience', 'E. Banking and Payroll Information', 'F. Employment and HR Documentation', 'G. Additional Documents (Conditional)']);
    expect(lib.items).toHaveLength(DEFAULT_LIBRARY_ITEMS.length);
    expect(lib.items).toHaveLength(35);
    expect(lib.templates.map((x) => x.key).sort()).toEqual(['contract', 'department_specific', 'full_time', 'intern', 'part_time', 'remote', 'senior_management', 'standard']);
    // All four kinds of requirement, and sensitive documents are never mandatory by default.
    expect(new Set(lib.items.map((i) => i.requirement))).toEqual(new Set(['mandatory', 'conditional', 'optional', 'role_specific']));
    expect(lib.items.find((i) => i.key === 'aadhaar')).toMatchObject({ multiple: true, maxFiles: 2, requirement: 'conditional' });
    // Opening it again writes nothing new.
    await api(app, owner).get('/onboarding-documents/library');
    expect(await pool.count('onboarding_doc_items', { tenant_id: t.id })).toBe(35);
  });

  it('Test 1: HR creates an employee with a template and ten documents; profile, checklist and tasks are created together', async () => {
    const j = await addMember(pool, t, { name: 'Kunal Joiner' });
    const opts = ok(await api(app, hr.token).get('/onboarding-documents/assign-options?employmentType=full_time'));
    const tpl = opts.templates.find((x: any) => x.id === opts.suggestedTemplateId);
    expect(tpl.name).toBe('Full-Time Employee Onboarding');
    const all = tpl.items.map((x: any) => x.itemId) as string[];
    // Ten documents chosen from the library by hand: seven mandatory, three optional or conditional.
    const mandatory = lib.items.filter((i) => i.requirement === 'mandatory').map((i) => i.id).slice(0, 7);
    const optional = lib.items.filter((i) => i.requirement !== 'mandatory' && !i.multiple).map((i) => i.id).slice(0, 2);
    const multi = lib.items.filter((i) => i.multiple && i.requirement !== 'mandatory').map((i) => i.id).slice(0, 1);
    const ten = [...mandatory, ...optional, ...multi];
    expect(ten.length).toBe(10);
    // Leaving out a document the template requires is refused, and nothing is created.
    const before = await pool.count('employees', { tenant_id: t.id });
    const bad = await api(app, hr.token).post('/employees').send({
      legalEntityId: t.legalEntityId, firstName: 'Kunal', lastName: 'Joiner', dateOfJoining: day(0), employmentType: 'full_time', membershipId: j.membershipId, hrWorkspaceId: pune, onboardingTemplateId: null,
      onboardingDocuments: { templateId: tpl.id, itemIds: all.slice(1) },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('required_documents');
    expect(await pool.count('employees', { tenant_id: t.id })).toBe(before);

    const created = ok(await api(app, hr.token).post('/employees').send({
      legalEntityId: t.legalEntityId, firstName: 'Kunal', lastName: 'Joiner', dateOfJoining: day(0), employmentType: 'full_time', membershipId: j.membershipId, hrWorkspaceId: pune, onboardingTemplateId: null,
      onboardingDocuments: { templateId: null, itemIds: ten, dueOn: day(14) },
    }), 201);
    joiner = { ...j, employeeId: created.employee.id, token: (await login(app, j.email)).accessToken };
    const cl = await pool.one<Record<string, any>>('onboarding_checklists', { tenant_id: t.id, employee_id: joiner.employeeId });
    checklistId = cl!.id;
    expect(cl).toMatchObject({ status: 'active', total: 10, approved: 0 });
    expect(await pool.count('document_requests', { tenant_id: t.id, checklist_id: checklistId })).toBe(10);
    expect(await pool.count('employee_tasks', { tenant_id: t.id, employee_id: joiner.employeeId, kind: 'document' })).toBe(10);
    // One notice to the employee, not ten.
    expect(await pool.count('notifications', { tenant_id: t.id, membership_id: joiner.membershipId, kind: 'onboarding.checklist_assigned' })).toBe(1);

    // Assigning the same documents again adds nothing (no duplicate tasks).
    const again = await api(app, hr.token).post(`/onboarding-documents/employees/${joiner.employeeId}/checklist`).send({ templateId: null, itemIds: ten });
    expect(again.status).toBe(409);
    expect(await pool.count('document_requests', { tenant_id: t.id, checklist_id: checklistId })).toBe(10);
  });

  it('Test 2: the employee uploads five; all five wait for HR approval and five stay not submitted, on both sides', async () => {
    const mine = ok(await api(app, joiner.token).get('/onboarding-documents/mine'));
    expect(mine.active.items).toHaveLength(10);
    expect(mine.active.items.every((i: any) => ['assigned', 'not_submitted'].includes(i.status))).toBe(true);
    // The employee never sees HR's verification notes.
    expect(mine.active.items.every((i: any) => i.verification === null)).toBe(true);
    for (const item of mine.active.items.slice(0, 5)) {
      const files = item.maxFiles > 1 ? [{ buf: PDF, name: 'front.pdf', type: 'application/pdf' }, { buf: PNG, name: 'back.png', type: 'image/png' }] : [{ buf: item.formats.includes('pdf') ? PDF : PNG, name: item.formats.includes('pdf') ? 'doc.pdf' : 'photo.png', type: item.formats.includes('pdf') ? 'application/pdf' : 'image/png' }];
      ok(await submit(joiner.token, item.requestId, files));
    }
    const emp = ok(await api(app, joiner.token).get('/onboarding-documents/mine')).active;
    const hrView = ok(await api(app, hr.token).get(`/onboarding-documents/checklists/${checklistId}`));
    for (const v of [emp, hrView]) {
      expect(v.items.filter((i: any) => i.status === 'pending_hr_approval')).toHaveLength(5);
      expect(v.items.filter((i: any) => ['assigned', 'not_submitted'].includes(i.status))).toHaveLength(5);
      expect(v.progress).toMatchObject({ total: 10, approved: 0, pendingApproval: 5 });
    }
    // In HR's list with the pending count; a multi-file document kept both files.
    const list = ok(await api(app, hr.token).get('/onboarding-documents/checklists'));
    expect(list.rows.find((r: any) => r.id === checklistId)).toMatchObject({ pendingApproval: 5, total: 10 });
    const multi = hrView.items.find((i: any) => i.maxFiles > 1 && i.status === 'pending_hr_approval');
    if (multi) expect(multi.files).toHaveLength(2);
    // Too many files or a wrong format is refused.
    const single = emp.items.find((i: any) => i.maxFiles === 1 && i.status !== 'pending_hr_approval' && i.formats.includes('pdf'));
    const tooMany = await submit(joiner.token, single.requestId, [{ buf: PDF, name: 'a.pdf', type: 'application/pdf' }, { buf: PDF, name: 'b.pdf', type: 'application/pdf' }]);
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.code).toBe('too_many_files');
    const wrong = await submit(joiner.token, single.requestId, [{ buf: Buffer.from('hello'), name: 'a.txt', type: 'text/plain' }]);
    expect(wrong.status).toBeGreaterThanOrEqual(400);
  });

  it('Test 3 and 4: HR approves three (ticks on both sides) and rejects one with a comment; the employee resubmits and HR sees the new version', async () => {
    const view = ok(await api(app, hr.token).get(`/onboarding-documents/checklists/${checklistId}`));
    const pending = view.items.filter((i: any) => i.status === 'pending_hr_approval');
    for (const i of pending.slice(0, 3)) ok(await decide(hr.token, i.requestId, 'approve'));
    // A rejection needs a reason.
    expect((await decide(hr.token, pending[3].requestId, 'reject')).status).toBeGreaterThanOrEqual(400);
    ok(await decide(hr.token, pending[3].requestId, 'reject', 'The scan is cut off at the bottom'));
    const emp = ok(await api(app, joiner.token).get('/onboarding-documents/mine')).active;
    const hrView = ok(await api(app, hr.token).get(`/onboarding-documents/checklists/${checklistId}`));
    for (const v of [emp, hrView]) {
      expect(v.items.filter((i: any) => i.approved)).toHaveLength(3);
      expect(v.items.filter((i: any) => i.status === 'pending_hr_approval')).toHaveLength(1);
      expect(v.items.find((i: any) => i.requestId === pending[3].requestId)).toMatchObject({ status: 'rejected', hrComment: 'The scan is cut off at the bottom', approved: false });
    }
    expect(await pool.count('notifications', { tenant_id: t.id, membership_id: joiner.membershipId, kind: 'document.rejected' })).toBe(1);
    // The employee cannot decide their own document.
    expect((await decide(joiner.token, pending[4].requestId, 'approve')).status).toBeGreaterThanOrEqual(403);
    // Resubmission goes back to HR; the first version stays in the history.
    const rejected = emp.items.find((i: any) => i.status === 'rejected');
    const files = rejected.maxFiles > 1 ? [{ buf: PDF, name: 'v2-a.pdf', type: 'application/pdf' }, { buf: PDF, name: 'v2-b.pdf', type: 'application/pdf' }] : [{ buf: rejected.formats.includes('pdf') ? PDF : PNG, name: 'v2.pdf', type: rejected.formats.includes('pdf') ? 'application/pdf' : 'image/png' }];
    ok(await submit(joiner.token, rejected.requestId, files));
    const after = ok(await api(app, hr.token).get(`/onboarding-documents/checklists/${checklistId}`));
    expect(after.items.find((i: any) => i.requestId === rejected.requestId)).toMatchObject({ status: 'pending_hr_approval', submissions: 2 });
    expect(after.items.find((i: any) => i.requestId === rejected.requestId).files[0].version).toBe(2);
    expect(await pool.count('employee_documents', { tenant_id: t.id, request_id: rejected.requestId })).toBeGreaterThanOrEqual(2);
  });

  it('Test 5: every mandatory document approved completes the checklist at 100%, off the active lists, kept in the history', async () => {
    let view = ok(await api(app, joiner.token).get('/onboarding-documents/mine')).active;
    for (const i of view.items.filter((x: any) => ['assigned', 'not_submitted'].includes(x.status) && x.mandatory)) {
      const files = i.maxFiles > 1 ? [{ buf: PDF, name: 'a.pdf', type: 'application/pdf' }, { buf: PDF, name: 'b.pdf', type: 'application/pdf' }] : [{ buf: i.formats.includes('pdf') ? PDF : PNG, name: 'x', type: i.formats.includes('pdf') ? 'application/pdf' : 'image/png' }];
      ok(await submit(joiner.token, i.requestId, files));
    }
    expect(await pool.count('notifications', { tenant_id: t.id, kind: 'onboarding.all_submitted' })).toBeGreaterThanOrEqual(1);
    view = ok(await api(app, hr.token).get(`/onboarding-documents/checklists/${checklistId}`));
    for (const i of view.items.filter((x: any) => x.status === 'pending_hr_approval' && x.mandatory)) ok(await decide(hr.token, i.requestId, 'approve'));
    const done = await pool.one<Record<string, any>>('onboarding_checklists', { id: checklistId });
    expect(done).toMatchObject({ status: 'completed', percent: 100 });
    expect(done!.completed_at).toBeTruthy();
    expect(done!.archived_at).toBeTruthy();
    const mine = ok(await api(app, joiner.token).get('/onboarding-documents/mine'));
    expect(mine.active).toBeNull();
    expect(mine.history[0]).toMatchObject({ id: checklistId, status: 'completed' });
    expect(mine.history[0].progress.percent).toBe(100);
    expect(ok(await api(app, hr.token).get('/onboarding-documents/checklists')).rows.some((r: any) => r.id === checklistId)).toBe(false);
    expect(ok(await api(app, hr.token).get('/onboarding-documents/checklists?status=completed')).rows.some((r: any) => r.id === checklistId)).toBe(true);
    expect(await pool.count('notifications', { tenant_id: t.id, membership_id: joiner.membershipId, kind: 'onboarding.completed' })).toBe(1);
    // Refreshing does not change anything: the statuses are stored.
    expect(ok(await api(app, hr.token).get(`/onboarding-documents/checklists/${checklistId}`)).status).toBe('completed');
  });

  it('Test 6: HR cannot change the library until the Super Workspace allows it; sensitive documents stay optional for HR', async () => {
    const cat = lib.categories[6]!.id;
    const item = { categoryId: cat, name: 'Gun Licence', requirement: 'optional', formats: ['pdf'], maxMb: 5 };
    expect((await api(app, hr.token).post('/onboarding-documents/library/documents').send(item)).status).toBe(403);
    // HR asks; the Super Workspace hears about it and grants the permission (recorded in the audit log).
    const req = ok(await api(app, hr.token).post('/onboarding-documents/library/requests').send({ kind: 'permission', reason: 'We hire drivers and need licences' }), 201);
    expect(await pool.count('notifications', { tenant_id: t.id, membership_id: t.ownerMembershipId, kind: 'onboarding.permission_requested' })).toBe(1);
    ok(await api(app, owner).post(`/onboarding-documents/library/requests/${req.id}/decide`).send({ decision: 'approve' }));
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'document_access.changed' })).toBeGreaterThanOrEqual(1);
    const hrNow = (await login(app, hr.email)).accessToken;
    const added = ok(await api(app, hrNow).post('/onboarding-documents/library/documents').send(item), 201);
    expect(added.name).toBe('Gun Licence');
    // ...but not a mandatory sensitive document.
    expect((await api(app, hrNow).post('/onboarding-documents/library/documents').send({ ...item, name: 'Medical record', requirement: 'mandatory', sensitive: true })).status).toBe(403);
    // HR's change is told to the Super Workspace.
    expect(await pool.count('notifications', { tenant_id: t.id, membership_id: t.ownerMembershipId, kind: 'onboarding.library_changed' })).toBeGreaterThanOrEqual(1);
    // The Super Workspace manages templates.
    const tpl = ok(await api(app, owner).post('/onboarding-documents/library/templates').send({ name: 'Drivers', items: [{ itemId: added.id, required: true }], employmentTypes: ['contract'] }), 201);
    expect(tpl.id).toBeTruthy();
    // An employee cannot read the library at all.
    expect((await api(app, other.token).get('/onboarding-documents/library')).status).toBe(403);
  });

  it('Test 7: employees cannot see each other\'s onboarding documents; HR of another HR Workspace cannot either', async () => {
    expect((await api(app, other.token).get(`/onboarding-documents/checklists/${checklistId}`)).status).toBe(404);
    const reqs = await pool.find('document_requests', { tenant_id: t.id, checklist_id: checklistId });
    expect((await api(app, other.token).get(`/document-requests/${reqs[0]!.id}`)).status).toBe(404);
    const delhiHr = await addMember(pool, t, { name: 'Dev Delhi HR' });
    ok(await api(app, owner).post('/hr-workspaces').send({ name: 'Delhi Branch', code: 'DEL', kind: 'branch', features: ['leave', 'documents', 'core_hr'], adminMembershipIds: [delhiHr.membershipId] }), 201);
    const dt = (await login(app, delhiHr.email)).accessToken;
    expect((await api(app, dt).get(`/onboarding-documents/checklists/${checklistId}`)).status).toBe(404);
    expect(ok(await api(app, dt).get('/onboarding-documents/checklists?status=completed')).rows.some((r: any) => r.id === checklistId)).toBe(false);
  });

  it('a checklist assigned before the person has a login is theirs once they get one', async () => {
    const e = ok(await api(app, hr.token).post('/employees').send({
      legalEntityId: t.legalEntityId, firstName: 'Nolo', lastName: 'Login', dateOfJoining: day(3), hrWorkspaceId: pune, onboardingTemplateId: null,
      onboardingDocuments: { templateId: null, itemIds: [lib.items.find((i) => i.key === 'pan')!.id] },
    }), 201).employee.id as string;
    const r = await pool.one<Record<string, any>>('document_requests', { tenant_id: t.id, employee_id: e });
    expect(r!.assignee_membership_id).toBeNull();
    const m = await addMember(pool, t, { name: 'Nolo Login' });
    ok(await api(app, owner).post(`/employees/${e}/link-login`).send({ membershipId: m.membershipId }), 201);
    expect((await pool.one<Record<string, any>>('document_requests', { id: r!.id }))!.assignee_membership_id).toBe(m.membershipId);
    const token = (await login(app, m.email)).accessToken;
    expect(ok(await api(app, token).get('/onboarding-documents/mine')).active.items).toHaveLength(1);
  });
});
