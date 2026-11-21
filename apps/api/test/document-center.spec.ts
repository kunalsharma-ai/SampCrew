import type { INestApplication } from '@nestjs/common';
import { DEFAULT_DOCUMENT_ACCESS } from '@crew/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DocumentCenterService } from '../src/modules/document-center/document-center.service';
import { addMember, adminPool, api, createApp, createTenant, login, loginWithMfa, type TestDb, type TestTenant } from './helpers';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const day = (n: number) => new Date(Date.now() + 330 * 60_000 + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Centralized document management, end to end through the API: the nine scenarios of the brief (HR and Super
 * Workspace requests, HR Workspace documents, rejection and resubmission, seven documents in one profile, Super
 * Workspace switching HR access off, isolation between HR Workspaces and between employees, synchronisation without
 * duplicate notices, replacement and expiry).
 */
describe('Document management, verification and approval', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let owner: string;
  let pune: string;
  let delhi: string;
  let hrPune: { email: string; membershipId: string };
  let hrDelhi: { email: string; membershipId: string };
  let hrPuneToken: string;
  let hrDelhiToken: string;
  let kunal: { email: string; membershipId: string; employeeId: string; token: string };
  let asha: { email: string; membershipId: string; employeeId: string; token: string };
  let hrPuneEmployee: string;

  const hire = async (token: string, body: Record<string, unknown>) => {
    const r = await api(app, token).post('/employees').send({ legalEntityId: t.legalEntityId, dateOfJoining: day(-30), probationMonths: 0, onboardingTemplateId: null, ...body });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.employee.id as string;
  };
  const ask = (token: string, body: Record<string, unknown>) => api(app, token).post('/document-requests').send({ reason: 'Needed for records', ...body });
  const submit = (token: string, id: string, file = PDF, name = 'aadhaar.pdf', type = 'application/pdf', extra: Record<string, string> = {}) => {
    let r = api(app, token).post(`/document-requests/${id}/submit`).attach('file', file, { filename: name, contentType: type });
    for (const [k, v] of Object.entries(extra)) r = r.field(k, v);
    return r;
  };
  const decide = (token: string, id: string, decision: string, comment?: string, expiresOn?: string) => api(app, token).post(`/document-requests/${id}/decision`).send({ decision, ...(comment ? { comment } : {}), ...(expiresOn ? { expiresOn } : {}) });
  const notices = (membershipId: string, kind: string) => pool.count('notifications', { tenant_id: t.id, membership_id: membershipId, kind });

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool, { plan: 'business' });
    owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    hrPune = await addMember(pool, t, { name: 'Priya Pune HR' });
    hrDelhi = await addMember(pool, t, { name: 'Dev Delhi HR' });
    const p = await api(app, owner).post('/hr-workspaces').send({ name: 'Pune Branch', code: 'PUNE', kind: 'branch', features: ['leave', 'documents', 'core_hr'], adminMembershipIds: [hrPune.membershipId] });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    pune = p.body.id;
    const d = await api(app, owner).post('/hr-workspaces').send({ name: 'Delhi Branch', code: 'DEL', kind: 'branch', features: ['leave', 'documents', 'core_hr'], adminMembershipIds: [hrDelhi.membershipId] });
    delhi = d.body.id;
    hrPuneToken = (await login(app, hrPune.email)).accessToken;
    hrDelhiToken = (await login(app, hrDelhi.email)).accessToken;
    const k = await addMember(pool, t, { name: 'Kunal Sharma' });
    const a = await addMember(pool, t, { name: 'Asha Rao' });
    kunal = { ...k, employeeId: await hire(owner, { firstName: 'Kunal', lastName: 'Sharma', membershipId: k.membershipId, hrWorkspaceId: pune }), token: '' };
    asha = { ...a, employeeId: await hire(owner, { firstName: 'Asha', lastName: 'Rao', membershipId: a.membershipId, hrWorkspaceId: pune }), token: '' };
    hrPuneEmployee = await hire(owner, { firstName: 'Priya', lastName: 'Pune', membershipId: hrPune.membershipId, hrWorkspaceId: pune });
    kunal.token = (await login(app, kunal.email)).accessToken;
    asha.token = (await login(app, asha.email)).accessToken;
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  let aadhaarRequest: string;
  let aadhaarDoc: string;

  it('Test 1: HR Workspace requests Aadhaar; the employee gets a task, uploads, HR verifies; it lands in the profile and in central management', async () => {
    const r = await ask(hrPuneToken, { target: 'employee', employeeIds: [kunal.employeeId], typeKey: 'aadhaar', instructions: 'Both sides, one PDF', dueOn: day(5), priority: 'high' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const req = r.body[0];
    aadhaarRequest = req.id;
    expect(req).toMatchObject({ status: 'new_request', title: 'Aadhaar Card', requestedBy: { level: 'hr_workspace', label: 'HR Workspace (Pune Branch)', name: 'Priya Pune HR' } });
    expect(await notices(kunal.membershipId, 'document.requested')).toBe(1);

    // The task on Kunal's My Tasks, linked to the request.
    const tasks = await api(app, kunal.token).get('/tasks?scope=mine');
    const task = tasks.body.find((x: { requestId: string }) => x.requestId === req.id);
    expect(task).toMatchObject({ kind: 'document', status: 'new', requestStatus: 'new_request', priority: 'high' });
    expect(task.description).toContain('Requested by HR Workspace (Pune Branch)');
    // Opening the task marks the request opened.
    await api(app, kunal.token).post(`/tasks/${task.id}/seen`);
    expect((await api(app, kunal.token).get(`/document-requests/${req.id}`)).body.status).toBe('pending_submission');

    // Wrong format is refused; a fake PDF too.
    expect((await submit(kunal.token, req.id, Buffer.from('hello'), 'a.txt', 'text/plain')).status).toBe(400);
    expect((await submit(kunal.token, req.id, Buffer.from('not a pdf at all'), 'a.pdf', 'application/pdf')).status).toBe(400);
    // Nobody else can submit it.
    expect((await submit(asha.token, req.id)).status).toBe(404);
    const s = await submit(kunal.token, req.id, PDF, 'aadhaar.pdf', 'application/pdf', { remarks: 'Front and back' });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body).toMatchObject({ status: 'submitted', submissions: 1 });
    aadhaarDoc = s.body.document.id;
    // Uploading is not approval: the file is pending, and the task waits for review.
    expect((await pool.one('employee_documents', { id: aadhaarDoc }))!.verification_status).toBe('pending');
    expect((await api(app, kunal.token).get(`/tasks/${task.id}`)).body).toMatchObject({ status: 'pending_review', requestStatus: 'submitted' });
    expect(await notices(kunal.membershipId, 'document.submitted')).toBe(1);

    // HR sees it in Approvals, under Document verification, and in its verification queue.
    const inbox = await api(app, hrPuneToken).get('/approvals/inbox');
    expect(inbox.body.find((x: { resourceId: string }) => x.resourceId === req.id)).toMatchObject({ resourceType: 'document_request', category: 'document_verification' });
    const queue = await api(app, hrPuneToken).get('/document-requests?scope=review');
    expect(queue.body.items.map((x: { id: string }) => x.id)).toContain(req.id);
    expect((await api(app, hrPuneToken).post(`/document-requests/${req.id}/review`)).body.status).toBe('under_verification');
    expect((await api(app, kunal.token).get(`/tasks/${task.id}`)).body.requestStatus).toBe('under_verification');

    const ok = await decide(hrPuneToken, req.id, 'approve', 'Matches records');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ status: 'completed', reviewer: { name: 'Priya Pune HR' } });
    expect((await api(app, kunal.token).get(`/tasks/${task.id}`)).body).toMatchObject({ status: 'completed', requestStatus: 'completed' });
    const profile = await api(app, hrPuneToken).get(`/employees/${kunal.employeeId}/documents`);
    expect(profile.body.find((x: { id: string }) => x.id === aadhaarDoc)).toMatchObject({ status: 'verified', statusLabel: 'Approved', typeName: 'Aadhaar Card', requestedBy: { level: 'hr_workspace' }, verifiedBy: { name: 'Priya Pune HR' }, version: 1 });
    expect(await notices(kunal.membershipId, 'document.approved')).toBe(1);

    // Super Workspace finds it by searching for the person, without asking anyone.
    const central = await api(app, owner).get('/documents/center/documents?q=Kunal%20Sharma');
    expect(central.status).toBe(200);
    expect(central.body.items.map((x: { id: string }) => x.id)).toContain(aadhaarDoc);
    const bySurname = await api(app, owner).get('/documents/center/documents?q=Sharma');
    expect(bySurname.body.items.map((x: { id: string }) => x.id)).toContain(aadhaarDoc);
    const byRef = await api(app, owner).get(`/documents/center/documents?q=${central.body.items[0].reference}`);
    expect(byRef.body.total).toBeGreaterThan(0);
    // Every step is in the document's history.
    const doc = await api(app, owner).get(`/documents/center/documents/${aadhaarDoc}`);
    expect(doc.body.history.map((h: { action: string }) => h.action)).toEqual(expect.arrayContaining(['requested', 'opened', 'submitted', 'review_started', 'approved']));
  });

  it('Test 2: Super Workspace requests a document from an employee; only Super Workspace verifies it', async () => {
    const r = await ask(owner, { target: 'employee', employeeIds: [kunal.employeeId], typeKey: 'pan', dueOn: day(3) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body[0].id;
    const view = await api(app, kunal.token).get(`/document-requests/${id}`);
    expect(view.body).toMatchObject({ requestedBy: { level: 'super_workspace', label: 'Super Workspace' }, reason: 'Needed for records', dueOn: day(3), isMine: true });
    expect((await submit(kunal.token, id, PNG, 'pan.png', 'image/png')).status).toBe(200);
    // HR of Kunal's HR Workspace cannot verify Super Workspace's request.
    expect((await decide(hrPuneToken, id, 'approve')).status).toBe(403);
    expect((await api(app, hrPuneToken).get('/approvals/inbox')).body.find((x: { resourceId: string }) => x.resourceId === id)).toBeUndefined();
    expect((await api(app, owner).get('/approvals/inbox')).body.find((x: { resourceId: string }) => x.resourceId === id)).toBeDefined();
    const ok = await decide(owner, id, 'approve');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('completed');
    const docs = await api(app, kunal.token).get(`/employees/${kunal.employeeId}/documents`);
    expect(docs.body.find((x: { typeKey: string }) => x.typeKey === 'pan')).toMatchObject({ status: 'verified', requestedBy: { level: 'super_workspace' } });
  });

  it('Test 3: Super Workspace requests a company document from an HR Workspace; it lands in the HR Workspace profile', async () => {
    const wrong = await ask(owner, { target: 'hr_workspace', hrWorkspaceId: pune, typeKey: 'aadhaar' });
    expect(wrong.status).toBe(400);
    const r = await ask(owner, { target: 'hr_workspace', hrWorkspaceId: pune, typeKey: 'company_registration', reason: 'Annual compliance file' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body[0].id;
    expect(await notices(hrPune.membershipId, 'document.requested')).toBe(1);
    // It is on the HR Workspace Admin's My Tasks, and says Super Workspace asked.
    const tasks = await api(app, hrPuneToken).get('/tasks?scope=mine');
    const task = tasks.body.find((x: { requestId: string }) => x.requestId === id);
    expect(task).toBeDefined();
    expect(task.employeeId).toBe(hrPuneEmployee);
    // Delhi's admin cannot see or submit it.
    expect((await api(app, hrDelhiToken).get(`/document-requests/${id}`)).status).toBe(404);
    // Submitting through the task goes to the same request.
    const s = await api(app, hrPuneToken).post(`/tasks/${task.id}/document`).attach('file', PDF, { filename: 'registration.pdf', contentType: 'application/pdf' });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    const req = (await api(app, owner).get(`/document-requests/${id}`)).body;
    expect(req.status).toBe('submitted');
    expect((await decide(owner, id, 'approve')).status).toBe(200);
    const ws = await api(app, owner).get(`/hr-workspaces/${pune}/documents`);
    expect(ws.status).toBe(200);
    expect(ws.body.documents).toHaveLength(1);
    expect(ws.body.documents[0]).toMatchObject({ ownerType: 'hr_workspace', typeName: 'Company Registration', status: 'verified', hrWorkspace: { id: pune, name: 'Pune Branch' } });
    expect((await api(app, hrPuneToken).get(`/hr-workspaces/${pune}/documents`)).body.documents).toHaveLength(1);
    expect((await api(app, hrDelhiToken).get(`/hr-workspaces/${pune}/documents`)).status).toBe(404);
    expect((await api(app, owner).get(`/documents/center/documents?owner=hr_workspace`)).body.total).toBe(1);
  });

  let passportRequest: string;
  it('Test 4: rejection needs a reason; the employee resubmits; earlier versions and history stay', async () => {
    const r = await ask(hrPuneToken, { target: 'employee', employeeIds: [kunal.employeeId], typeKey: 'passport', expiryRequired: true });
    passportRequest = r.body[0].id;
    expect((await submit(kunal.token, passportRequest)).status).toBe(400); // expiry date required
    const first = await submit(kunal.token, passportRequest, PDF, 'passport.pdf', 'application/pdf', { expiresOn: day(400) });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const v1 = first.body.document.id;
    expect((await decide(hrPuneToken, passportRequest, 'reject')).status).toBe(422);
    const no = await decide(hrPuneToken, passportRequest, 'reject', 'The photo page is unreadable');
    expect(no.status, JSON.stringify(no.body)).toBe(200);
    expect(no.body.status).toBe('rejected');
    expect((await pool.one('employee_documents', { id: v1 }))!).toMatchObject({ verification_status: 'rejected', verification_remarks: 'The photo page is unreadable' });
    expect(await notices(kunal.membershipId, 'document.rejected')).toBe(1);
    const task = (await api(app, kunal.token).get('/tasks?scope=mine')).body.find((x: { requestId: string }) => x.requestId === passportRequest);
    expect(task).toMatchObject({ status: 'reopened', requestStatus: 'rejected', reviewerRemarks: 'The photo page is unreadable' });

    const second = await submit(kunal.token, passportRequest, PDF, 'passport-clear.pdf', 'application/pdf', { expiresOn: day(400) });
    expect(second.body).toMatchObject({ status: 'resubmitted', submissions: 2 });
    expect(second.body.document.version).toBe(2);
    // Correction: the reviewer explains what to fix.
    expect((await decide(hrPuneToken, passportRequest, 'correction')).status).toBe(422);
    const fix = await decide(hrPuneToken, passportRequest, 'correction', 'Add the address page too');
    expect(fix.body.status).toBe('correction_required');
    expect(await notices(kunal.membershipId, 'document.correction_requested')).toBe(1);
    const third = await submit(kunal.token, passportRequest, PDF, 'passport-all.pdf', 'application/pdf', { expiresOn: day(400) });
    expect(third.body.document.version).toBe(3);
    expect((await decide(hrPuneToken, passportRequest, 'approve')).body.status).toBe('completed');

    // All three versions are kept, linked, with their history; only the latest is in the profile list.
    const detail = await api(app, kunal.token).get(`/document-requests/${passportRequest}`);
    expect(detail.body.versions.map((x: { version: number }) => x.version)).toEqual([3, 2, 1]);
    expect(detail.body.versions.map((x: { status: string }) => x.status)).toEqual(['verified', 'superseded', 'superseded']);
    expect(detail.body.history.map((h: { action: string }) => h.action)).toEqual(expect.arrayContaining(['submitted', 'rejected', 'resubmitted', 'correction_requested', 'approved']));
    const profile = await api(app, kunal.token).get(`/employees/${kunal.employeeId}/documents`);
    expect(profile.body.filter((x: { typeKey: string }) => x.typeKey === 'passport')).toHaveLength(1);
    const withOld = await api(app, kunal.token).get(`/employees/${kunal.employeeId}/documents?includeReplaced=true`);
    expect(withOld.body.filter((x: { typeKey: string }) => x.typeKey === 'passport')).toHaveLength(3);
  });

  it('Test 5: seven documents of one employee are all in their profile and in central management', async () => {
    const types = ['resume', 'offer_letter', 'experience_letter', 'marksheet_10', 'marksheet_12', 'graduation', 'bank_details'];
    const r = await Promise.all(types.map((typeKey) => ask(hrPuneToken, { target: 'employee', employeeIds: [asha.employeeId], typeKey })));
    for (const x of r) expect(x.status, JSON.stringify(x.body)).toBe(201);
    for (const x of r) expect((await submit(asha.token, x.body[0].id, PDF, `${x.body[0].typeKey}.pdf`)).status).toBe(200);
    for (const x of r) expect((await decide(hrPuneToken, x.body[0].id, 'approve')).status).toBe(200);
    const profile = await api(app, owner).get(`/employees/${asha.employeeId}/documents`);
    expect(profile.body).toHaveLength(7);
    expect(new Set(profile.body.map((x: { typeKey: string }) => x.typeKey))).toEqual(new Set(types));
    expect(profile.body.every((x: { status: string }) => x.status === 'verified')).toBe(true);
    const central = await api(app, owner).get(`/documents/center/documents?employeeId=${asha.employeeId}`);
    expect(central.body.total).toBe(7);
    // Filters: by category and type; sensitive bank details are marked.
    expect((await api(app, owner).get(`/documents/center/documents?employeeId=${asha.employeeId}&category=education`)).body.total).toBe(3);
    const bank = profile.body.find((x: { typeKey: string }) => x.typeKey === 'bank_details');
    expect(bank.sensitive).toBe(true);
    expect((await api(app, hrPuneToken).get(`/employees/${asha.employeeId}/documents`)).body).toHaveLength(7);
    const o = await api(app, owner).get('/documents/center/overview');
    expect(o.body).toMatchObject({ level: 'super_workspace' });
    expect(o.body.approved).toBeGreaterThanOrEqual(10);
    expect(o.body.hrWorkspaceDocuments).toBe(1);
  });

  it('Test 6: Super Workspace switches HR access off; HR loses it at once, direct links included; nothing is deleted', async () => {
    const before = await pool.count('employee_documents', { tenant_id: t.id });
    expect((await api(app, hrPuneToken).post(`/documents/${aadhaarDoc}/link`)).status).toBe(201);
    // Only Super Workspace manages the switches.
    expect((await api(app, hrPuneToken).put(`/documents/access/${pune}`).send({ switches: { ...DEFAULT_DOCUMENT_ACCESS, enabled: true } })).status).toBe(403);
    const off = await api(app, owner).put(`/documents/access/${pune}`).send({ switches: { ...DEFAULT_DOCUMENT_ACCESS, enabled: false }, version: 0 });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(await notices(hrPune.membershipId, 'documents.access_changed')).toBe(1);
    // A stale form cannot overwrite it.
    expect((await api(app, owner).put(`/documents/access/${pune}`).send({ switches: DEFAULT_DOCUMENT_ACCESS, version: 0 })).status).toBe(409);

    expect((await api(app, hrPuneToken).get(`/employees/${kunal.employeeId}/documents`)).body).toEqual([]);
    expect((await api(app, hrPuneToken).post(`/documents/${aadhaarDoc}/link`)).status).toBe(404);
    expect((await api(app, hrPuneToken).post(`/documents/${aadhaarDoc}/access-link`).send({ mode: 'preview' })).status).toBe(404);
    expect((await api(app, hrPuneToken).get(`/documents/center/documents/${aadhaarDoc}`)).status).toBe(404);
    expect((await api(app, hrPuneToken).get('/documents/center/documents')).body.items.filter((x: { ownerType: string; employee: { id: string } | null }) => x.employee?.id === kunal.employeeId)).toEqual([]);
    expect((await ask(hrPuneToken, { target: 'employee', employeeIds: [kunal.employeeId], typeKey: 'resume' })).status).toBe(403);
    // Super Workspace keeps its access and nothing was deleted.
    expect((await api(app, owner).post(`/documents/${aadhaarDoc}/link`)).status).toBe(201);
    expect(await pool.count('employee_documents', { tenant_id: t.id })).toBe(before);

    // Partial access: approved documents only, preview but no download.
    const partial = { ...DEFAULT_DOCUMENT_ACCESS, view_employee: false, view_pending: false, download: false };
    expect((await api(app, owner).put(`/documents/access/${pune}`).send({ switches: partial, version: 1 })).status).toBe(200);
    expect((await api(app, hrPuneToken).post(`/documents/${aadhaarDoc}/access-link`).send({ mode: 'preview' })).status).toBe(200);
    expect((await api(app, hrPuneToken).post(`/documents/${aadhaarDoc}/access-link`).send({ mode: 'download' })).status).toBe(403);
    const r = await ask(hrPuneToken, { target: 'employee', employeeIds: [kunal.employeeId], typeKey: 'resume' });
    await submit(kunal.token, r.body[0].id);
    const pendingId = (await api(app, kunal.token).get(`/document-requests/${r.body[0].id}`)).body.document.id;
    expect((await api(app, hrPuneToken).get(`/documents/center/documents/${pendingId}`)).status).toBe(404);
    expect((await api(app, owner).put(`/documents/access/${pune}`).send({ switches: DEFAULT_DOCUMENT_ACCESS, version: 2 })).status).toBe(200);
    expect((await api(app, hrPuneToken).get(`/documents/center/documents/${pendingId}`)).status).toBe(200);
    expect((await decide(hrPuneToken, r.body[0].id, 'approve')).status).toBe(200);
  });

  it('Test 7: one HR Workspace cannot reach another\'s documents, nor one employee another\'s', async () => {
    expect((await api(app, hrDelhiToken).get(`/employees/${kunal.employeeId}/documents`)).status).toBe(404);
    expect((await api(app, hrDelhiToken).post(`/documents/${aadhaarDoc}/link`)).status).toBe(404);
    expect((await api(app, hrDelhiToken).get(`/document-requests/${aadhaarRequest}`)).status).toBe(404);
    expect((await api(app, hrDelhiToken).get('/documents/center/documents')).body.total).toBe(0);
    expect((await ask(hrDelhiToken, { target: 'employee', employeeIds: [kunal.employeeId], typeKey: 'resume' })).status).toBe(404);
    expect((await ask(hrDelhiToken, { target: 'hr_workspace', hrWorkspaceId: pune, typeKey: 'gst_certificate' })).status).toBe(403);
    expect((await api(app, asha.token).post(`/documents/${aadhaarDoc}/link`)).status).toBe(404);
    expect((await api(app, asha.token).get(`/documents/center/documents/${aadhaarDoc}`)).status).toBe(404);
    expect((await api(app, asha.token).get(`/document-requests/${aadhaarRequest}`)).status).toBe(404);
    expect((await api(app, asha.token).get('/documents/center/documents')).body.items.every((x: { employee: { id: string } }) => x.employee.id === asha.employeeId)).toBe(true);

    // Super Workspace can let Delhi read Pune's approved documents, explicitly.
    const shared = { ...DEFAULT_DOCUMENT_ACCESS, view_other_hr: true, request_other_hr: true };
    expect((await api(app, owner).put(`/documents/access/${delhi}`).send({ switches: shared, sharedHrWorkspaceIds: [pune] })).status).toBe(200);
    expect((await api(app, hrDelhiToken).get(`/documents/center/documents/${aadhaarDoc}`)).status).toBe(200);
    const fromDelhi = await ask(hrDelhiToken, { target: 'hr_workspace', hrWorkspaceId: pune, typeKey: 'gst_certificate' });
    expect(fromDelhi.status, JSON.stringify(fromDelhi.body)).toBe(201);
    expect(fromDelhi.body[0].requestedBy.label).toBe('HR Workspace (Delhi Branch)');
    await submit(hrPuneToken, fromDelhi.body[0].id);
    // Delhi asked, so Delhi verifies (not Pune).
    expect((await decide(hrPuneToken, fromDelhi.body[0].id, 'approve')).status).toBe(403);
    expect((await decide(hrDelhiToken, fromDelhi.body[0].id, 'approve')).status).toBe(200);
  });

  it('Test 8: one change updates the task, the approval and the profile, with one notice each', async () => {
    const r = await ask(hrPuneToken, { target: 'employee', employeeIds: [asha.employeeId], typeKey: 'driving_licence' });
    const id = r.body[0].id;
    await submit(asha.token, id);
    const approval = (await pool.one('document_requests', { id }))!.approval_request_id;
    // Deciding from Approvals has the same effect as deciding from the document.
    const a = await api(app, hrPuneToken).post(`/approvals/${approval}/approve`).send({ comment: 'Fine' });
    expect(a.status, JSON.stringify(a.body)).toBeLessThan(300);
    const req = (await api(app, asha.token).get(`/document-requests/${id}`)).body;
    expect(req.status).toBe('completed');
    expect((await pool.one('employee_tasks', { id: req.taskId }))!).toMatchObject({ status: 'completed', request_status: 'completed' });
    expect((await pool.one('employee_documents', { id: req.document.id }))!.verification_status).toBe('verified');
    expect(await pool.count('notifications', { tenant_id: t.id, membership_id: asha.membershipId, kind: 'document.approved', resource_id: id })).toBe(1);
    expect(await pool.count('notifications', { tenant_id: t.id, membership_id: asha.membershipId, kind: 'approval.approved' })).toBe(0);
    expect(await pool.count('document_requests', { tenant_id: t.id, id })).toBe(1);
    expect(await pool.count('employee_tasks', { tenant_id: t.id, request_id: id })).toBe(1);
    // Rejecting from Approvals reopens the task for a resubmission, without a second task.
    const r2 = await ask(hrPuneToken, { target: 'employee', employeeIds: [asha.employeeId], typeKey: 'voter_id' });
    await submit(asha.token, r2.body[0].id);
    const ap2 = (await pool.one('document_requests', { id: r2.body[0].id }))!.approval_request_id;
    expect((await api(app, hrPuneToken).post(`/approvals/${ap2}/reject`).send({ comment: 'Expired card' })).status).toBeLessThan(300);
    await submit(asha.token, r2.body[0].id);
    expect(await pool.count('employee_tasks', { tenant_id: t.id, request_id: r2.body[0].id })).toBe(1);
    expect((await pool.one('employee_tasks', { request_id: r2.body[0].id }))!.status).toBe('pending_review');
  });

  it('Test 9: an expired document is flagged once; a replacement is requested and keeps the old version traceable', async () => {
    const r = await ask(owner, { target: 'employee', employeeIds: [kunal.employeeId], typeKey: 'professional_certification' });
    const id = r.body[0].id;
    await submit(kunal.token, id);
    expect((await decide(owner, id, 'approve', undefined, day(-1))).status).toBe(200);
    const old = (await pool.one('document_requests', { id }))!.document_id as string;
    const center = app.get(DocumentCenterService);
    expect(await center.sweepAll()).toBeGreaterThan(0);
    expect((await pool.one('employee_documents', { id: old }))!.expired_at).toBeTruthy();
    expect(await pool.count('notifications', { tenant_id: t.id, membership_id: kunal.membershipId, kind: 'document.expired' })).toBe(1);
    await center.sweepAll();
    expect(await pool.count('notifications', { tenant_id: t.id, membership_id: kunal.membershipId, kind: 'document.expired' })).toBe(1);
    const expired = await api(app, owner).get(`/documents/center/documents?status=expired`);
    expect(expired.body.items.map((x: { id: string }) => x.id)).toContain(old);
    const detail = await api(app, owner).get(`/documents/center/documents/${old}`);
    expect(detail.body).toMatchObject({ status: 'expired', canRequestReplacement: true });

    const rep = await ask(owner, { target: 'employee', employeeIds: [kunal.employeeId], typeKey: 'professional_certification', replacesDocumentId: old, reason: 'The certificate expired' });
    expect(rep.status, JSON.stringify(rep.body)).toBe(201);
    const s = await submit(kunal.token, rep.body[0].id);
    expect(s.body.document.version).toBe(2);
    expect((await decide(owner, rep.body[0].id, 'approve', undefined, day(700))).status).toBe(200);
    expect((await pool.one('employee_documents', { id: old }))!.superseded_at).toBeTruthy();
    const latest = await api(app, owner).get(`/documents/center/documents/${s.body.document.id}`);
    expect(latest.body.versions.map((x: { id: string }) => x.id)).toEqual([s.body.document.id, old]);
    expect(latest.body.history.map((h: { action: string }) => h.action)).toEqual(expect.arrayContaining(['expired', 'replacement_requested', 'replaced', 'approved']));
  });

  it('reminds before the deadline and tells both sides when a request is overdue, once', async () => {
    const soon = await ask(hrPuneToken, { target: 'employee', employeeIds: [asha.employeeId], typeKey: 'diploma', dueOn: day(1) });
    const late = await ask(hrPuneToken, { target: 'employee', employeeIds: [asha.employeeId], typeKey: 'postgraduate', dueOn: day(0) });
    const center = app.get(DocumentCenterService);
    await center.sweepAll(day(0));
    expect(await pool.count('notifications', { tenant_id: t.id, membership_id: asha.membershipId, kind: 'document.deadline' })).toBe(2);
    await center.sweepAll(day(1));
    expect(await pool.count('notifications', { tenant_id: t.id, membership_id: asha.membershipId, kind: 'document.overdue' })).toBe(1);
    await center.sweepAll(day(1));
    expect(await pool.count('notifications', { tenant_id: t.id, membership_id: asha.membershipId, kind: 'document.overdue' })).toBe(1);
    expect(await pool.count('notifications', { tenant_id: t.id, membership_id: hrPune.membershipId, kind: 'document.overdue' })).toBe(1);
    expect((await pool.one('document_requests', { id: late.body[0].id }))!.overdue_notified_at).toBeTruthy();
    expect((await pool.one('document_requests', { id: soon.body[0].id }))!.overdue_notified_at ?? null).toBeNull();
    expect((await api(app, hrPuneToken).post(`/document-requests/${soon.body[0].id}/cancel`).send({ reason: 'No longer needed' })).status).toBe(200);
    expect((await pool.one('employee_tasks', { request_id: soon.body[0].id }))!.status).toBe('cancelled');
  });

  it('keeps custom categories and types, exports records only for people allowed to, and keeps the activity append-only', async () => {
    expect((await api(app, hrPuneToken).post('/documents/catalogue/categories').send({ key: 'compliance', name: 'Compliance' })).status).toBe(403);
    expect((await api(app, owner).post('/documents/catalogue/categories').send({ key: 'compliance', name: 'Compliance' })).status).toBe(201);
    const type = await api(app, owner).post('/documents/catalogue/types').send({ key: 'pf_form', name: 'PF Nomination Form', category: 'compliance', owners: ['employee'] });
    expect(type.status, JSON.stringify(type.body)).toBe(201);
    const cat = await api(app, hrPuneToken).get('/documents/catalogue');
    expect(cat.body.types.find((x: { key: string }) => x.key === 'pf_form')).toMatchObject({ category: 'compliance', builtIn: false });
    expect((await ask(hrPuneToken, { target: 'employee', employeeIds: [kunal.employeeId], typeKey: 'pf_form' })).status).toBe(201);

    const csv = await api(app, owner).get('/documents/center/export.csv');
    expect(csv.status).toBe(200);
    expect(csv.text.split('\n')[0]).toContain('Reference,Document');
    expect((await api(app, hrPuneToken).get('/documents/center/export.csv')).status).toBe(403);
    await expect(pool.tenant(t.id, (tx) => tx.collection('document_activity').update({}, { $set: { action: 'x' } }))).rejects.toThrow();
    await expect(pool.tenant(t.id, (tx) => tx.collection('document_activity').delete({}))).rejects.toThrow();
    // The audit trail records downloads and decisions too.
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'document.downloaded' })).toBeGreaterThan(0);
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'document.approved' })).toBeGreaterThan(0);
  });

  it('treats an HR Workspace person whose documents access is only their own record as an employee', async () => {
    const pay = await addMember(pool, t, { name: 'Meera Payroll', roles: ['payroll_admin'] });
    await hire(owner, { firstName: 'Meera', lastName: 'Payroll', membershipId: pay.membershipId, hrWorkspaceId: pune });
    const token = (await login(app, pay.email)).accessToken;
    expect((await api(app, token).get('/documents/access/mine')).body).toMatchObject({ level: 'employee_workspace', access: null });
    const repo = await api(app, token).get('/documents/center/documents');
    expect(repo.status === 403 || repo.body.items.every((d: { employee: { id: string } | null }) => d.employee?.id !== kunal.employeeId)).toBe(true);
    expect([403, 404]).toContain((await api(app, token).get(`/employees/${kunal.employeeId}/documents`)).status);
    expect([403, 404]).toContain((await api(app, token).post(`/documents/${aadhaarDoc}/access-link`).send({ mode: 'preview' })).status);
  });
});
