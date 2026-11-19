import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, adminPool, api, createApp, createTenant, department, login, loginWithMfa, type TestDb, type TestTenant } from './helpers';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

/**
 * The complete employee profile and profile updates: employees submit changes that HR approves, rejects or asks
 * more about; nothing reaches the official record before approval; bank and identity numbers are encrypted, masked
 * and kept encrypted while an update waits; HR edits other people's profiles directly.
 */
describe('employee profile and profile updates', () => {
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
    tokens.hr = (await loginWithMfa(app, pool, people.hr.email)).accessToken;
    const hire = async (who: string, first: string, managerEmployeeId?: string, departmentId: string | null = engineering) => {
      const body = ok(await as('hr').post('/employees').send({
        legalEntityId: t.legalEntityId, firstName: first, lastName: 'Test', dateOfJoining: '2025-01-01', probationMonths: 0, membershipId: people[who]!.membershipId,
        departmentId, managerEmployeeId, onboardingTemplateId: null, workEmail: `${first.toLowerCase()}@work.example`,
      }), 201);
      people[who]!.employeeId = body.employee.id;
    };
    await hire('hr', 'Hana', undefined, null);
    await hire('manager', 'Manu');
    await hire('asha', 'Asha', people.manager.employeeId);
    for (const who of ['manager', 'asha']) tokens[who] = (await login(app, people[who]!.email)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('the employee sees their profile: professional details read only, completeness, what they can do', async () => {
    const p = ok(await as('asha').get('/profile/me'));
    expect(p.self).toBe(true);
    expect(p.professional).toMatchObject({ department: 'Engineering', manager: 'Manu Test', dateOfJoining: '2025-01-01', workEmail: 'asha@work.example' });
    expect(p.professional.workingDays).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']);
    expect(p.can).toMatchObject({ submit: true, editDirect: false, review: false });
    expect(p.completeness).toBeLessThan(50);
    const sections = ok(await as('asha').get('/profile/sections')) as unknown as { key: string }[];
    expect(sections.map((s) => s.key)).toEqual(['personal', 'address', 'emergency', 'education', 'employment', 'skills', 'bank', 'identity']);
  });

  let addressUpdate: string;
  it('an address update waits for HR: the record keeps the old value and HR is told', async () => {
    const address = { current: { line1: '12 MG Road', line2: '', city: 'Pune', state: 'Maharashtra', postalCode: '411001', country: 'India' }, permanentSameAsCurrent: true, permanent: null };
    const u = ok(await as('asha').post(`/profile/${people.asha.employeeId}/updates`).send({ section: 'address', data: address, note: 'Moved last month' }), 201);
    addressUpdate = u.id;
    expect(u).toMatchObject({ status: 'pending', sectionLabel: 'Address', employee: { name: 'Asha Test', department: 'Engineering' } });
    expect(u.changes[0]).toMatchObject({ label: 'Current address', old: null, new: '12 MG Road, Pune, Maharashtra, 411001, India' });
    const p = ok(await as('asha').get('/profile/me'));
    expect(p.sections.address).toBeNull();
    expect(p.updates.address).toMatchObject({ status: 'pending' });
    expect(await notes('hr', 'approval.requested')).toBe(1);
    const inbox = ok(await as('hr').get('/approvals/inbox')) as unknown as Record<string, unknown>[];
    const item = inbox.find((i) => i.resourceType === 'profile_update');
    expect(item).toMatchObject({ label: 'Profile update', link: `/profile/updates/${addressUpdate}` });
    expect(String(item!.summary)).toMatch(/^Asha Test \(.+, Engineering\): Address, 2 changes, submitted \d{4}-\d{2}-\d{2}$/);
    // The same section submitted again replaces the open update.
    expect((await as('asha').post(`/profile/${people.asha.employeeId}/updates`).send({ section: 'address', data: address })).status).toBe(201);
    expect(ok(await as('hr').get(`/profile/updates/${addressUpdate}`)).status).toBe('superseded');
    const pending = ok(await as('hr').get('/profile/updates')) as unknown as { id: string }[];
    expect(pending).toHaveLength(1);
    addressUpdate = pending[0]!.id;
  });

  it('protected and unchanged data is refused; the manager and other employees cannot review', async () => {
    expect((await as('asha').post(`/profile/${people.asha.employeeId}/updates`).send({ section: 'salary', data: {} })).status).toBe(422);
    expect((await as('asha').post(`/profile/${people.manager.employeeId}/updates`).send({ section: 'skills', data: { skills: ['Go'] } })).status).toBe(403);
    expect((await as('asha').post(`/profile/${people.asha.employeeId}/updates`).send({ section: 'skills', data: { skills: [], languages: [], certifications: [] } })).status).toBe(400);
    expect((await as('asha').post(`/profile/${people.asha.employeeId}/updates`).send({ section: 'identity', data: { pan: 'ABC' } })).status).toBe(422);
    expect((await as('manager').get('/profile/updates')).status).toBe(403);
    expect((await as('manager').post(`/profile/updates/${addressUpdate}/decide`).send({ decision: 'approve' })).status).toBe(404);
    expect((await as('asha').post(`/profile/updates/${addressUpdate}/decide`).send({ decision: 'approve' })).status).toBe(403);
  });

  it('HR asks for more information, the employee resubmits, HR approves and the record changes', async () => {
    expect((await as('hr').post(`/profile/updates/${addressUpdate}/decide`).send({ decision: 'request_info' })).status).toBe(422);
    const asked = ok(await as('hr').post(`/profile/updates/${addressUpdate}/decide`).send({ decision: 'request_info', remarks: 'Add the flat number' }));
    expect(asked).toMatchObject({ status: 'info_requested', remarks: 'Add the flat number' });
    expect(await notes('asha', 'profile_update.info_requested')).toBe(1);
    expect((ok(await as('hr').get('/approvals/inbox')) as unknown as { resourceType: string }[]).filter((i) => i.resourceType === 'profile_update')).toHaveLength(0);
    const address = { current: { line1: 'Flat 4B, 12 MG Road', line2: '', city: 'Pune', state: 'Maharashtra', postalCode: '411001', country: 'India' }, permanentSameAsCurrent: true, permanent: null };
    const again = ok(await as('asha').post(`/profile/${people.asha.employeeId}/updates`).send({ section: 'address', data: address }), 201);
    const approved = ok(await as('hr').post(`/profile/updates/${again.id}/decide`).send({ decision: 'approve', remarks: 'Matches the proof' }));
    expect(approved).toMatchObject({ status: 'approved', remarks: 'Matches the proof', decidedBy: 'Hana HR' });
    expect(approved.history.map((h: { action: string }) => h.action)).toEqual(['submitted', 'approved']);
    expect(ok(await as('asha').get('/profile/me')).sections.address.current.line1).toBe('Flat 4B, 12 MG Road');
    expect(await notes('asha', 'approval.approved')).toBe(1);
    expect(await pool.count('audit_events', { tenant_id: t.id, action: 'profile_update.approved' })).toBe(1);
  });

  it('personal details: a rejected update leaves the record alone and gives the reason', async () => {
    const before = ok(await as('asha').get('/profile/me')).sections.personal;
    const u = ok(await as('asha').post(`/profile/${people.asha.employeeId}/updates`).send({ section: 'personal', data: { ...before, firstName: 'Ashaa', dateOfBirth: '1995-04-02', nationality: 'Indian' } }), 201);
    expect(u.changes.map((c: { label: string }) => c.label).sort()).toEqual(['Date of birth', 'First name', 'Nationality']);
    const rejected = ok(await as('hr').post(`/profile/updates/${u.id}/decide`).send({ decision: 'reject', remarks: 'The name must match your ID' }));
    expect(rejected).toMatchObject({ status: 'rejected', remarks: 'The name must match your ID' });
    const p = ok(await as('asha').get('/profile/me'));
    expect(p.sections.personal).toMatchObject({ firstName: 'Asha', dateOfBirth: null });
    expect(p.updates.personal).toMatchObject({ status: 'rejected', remarks: 'The name must match your ID' });
  });

  it('bank and identity numbers stay encrypted while waiting, are masked everywhere and are applied on approval', async () => {
    const bank = { accountHolderName: 'Asha Test', bankName: 'State Bank of India', accountNumber: '123456789012', ifsc: 'SBIN0001234', branchName: 'Pune Camp', accountType: 'salary' };
    const u = ok(await as('asha').post(`/profile/${people.asha.employeeId}/updates`).send({ section: 'bank', data: bank }), 201);
    expect(u.changes.find((c: { field: string }) => c.field === 'accountNumber')).toMatchObject({ old: null, new: '••••••••9012' });
    const raw = (await pool.one('profile_change_requests', { id: u.id }))!;
    expect(raw.new_data).toBeNull();
    expect(JSON.stringify(raw)).not.toContain('123456789012');
    ok(await as('hr').post(`/profile/updates/${u.id}/decide`).send({ decision: 'approve' }));
    expect((await pool.one('profile_change_requests', { id: u.id }))!.new_enc).toBeNull();
    const stored = (await pool.one('employee_sensitive', { employee_id: people.asha.employeeId }))!;
    expect(stored.bank_account_enc).not.toContain('123456789012');
    expect(stored).toMatchObject({ account_holder_name: 'Asha Test', account_type: 'salary', bank_branch: 'Pune Camp' });
    const mine = ok(await as('asha').get('/profile/me')).sections.bank;
    expect(mine).toMatchObject({ accountNumber: '••••••••9012', ifsc: 'SBIN0001234', bankName: 'State Bank of India' });
    // The existing full view (MFA, audited) shows the same number HR approved.
    expect(ok(await as('hr').get(`/employees/${people.asha.employeeId}/sensitive`))).toMatchObject({ bankAccount: '123456789012', bankRouting: 'SBIN0001234' });
    // The manager may read the profile but never bank or identity details.
    const seen = ok(await as('manager').get(`/profile/${people.asha.employeeId}`));
    expect(seen.sections.bank).toEqual({ hidden: true });
    expect(seen.can).toMatchObject({ seeSensitive: false, review: false, editDirect: false });
  });

  it('identity: Aadhaar and PAN with an uploaded proof that HR can open while reviewing', async () => {
    const doc = ok(await as('asha').post(`/employees/${people.asha.employeeId}/documents`).field('category', 'id_proof').field('title', 'PAN card').attach('file', PDF, { filename: 'pan.pdf', contentType: 'application/pdf' }), 201);
    const data = { aadhaar: '1234 5678 9012', pan: 'abcde1234f', otherIdType: null, otherIdNumber: null, identityDocumentId: doc.id, addressProofDocumentId: null };
    const u = ok(await as('asha').post(`/profile/${people.asha.employeeId}/updates`).send({ section: 'identity', data }), 201);
    const review = ok(await as('hr').get(`/profile/updates/${u.id}`));
    expect(review.documents).toEqual([expect.objectContaining({ id: doc.id, fileName: 'pan.pdf' })]);
    expect(review.changes.find((c: { field: string }) => c.field === 'pan')).toMatchObject({ new: '••••••234F' });
    ok(await as('hr').post(`/profile/updates/${u.id}/decide`).send({ decision: 'approve' }));
    expect(ok(await as('asha').get('/profile/me')).sections.identity).toMatchObject({ aadhaar: '••••••••9012', pan: '••••••234F', identityDocumentId: doc.id });
    // Someone else's document cannot be linked.
    const other = ok(await as('hr').post(`/employees/${people.manager.employeeId}/documents`).field('category', 'id_proof').field('title', 'X').attach('file', PDF, { filename: 'x.pdf', contentType: 'application/pdf' }), 201);
    expect((await as('asha').post(`/profile/${people.asha.employeeId}/updates`).send({ section: 'identity', data: { ...data, aadhaar: '999988887777', identityDocumentId: other.id } })).status).toBe(400);
  });

  it('HR edits another person directly (audited, the employee is told) but submits their own changes for approval', async () => {
    const res = ok(await as('hr').put(`/profile/${people.asha.employeeId}/sections/skills`).send({ skills: ['TypeScript', 'MongoDB'], languages: ['English', 'Marathi'], certifications: [] }));
    expect(res.updated.sort()).toEqual(['languages', 'skills']);
    expect(ok(await as('asha').get('/profile/me')).sections.skills.skills).toEqual(['TypeScript', 'MongoDB']);
    expect(await notes('asha', 'profile_update.changed_by_hr')).toBe(1);
    expect((await as('hr').put(`/profile/${people.hr.employeeId}/sections/skills`).send({ skills: ['Payroll'] })).status).toBe(403);
    expect((await as('manager').put(`/profile/${people.asha.employeeId}/sections/skills`).send({ skills: ['X'] })).status).toBe(404);
    expect((await as('hr').put(`/profile/${people.asha.employeeId}/sections/nope`).send({})).status).toBe(404);
  });

  it('the employee withdraws an open update; their list shows every update', async () => {
    const u = ok(await as('asha').post(`/profile/${people.asha.employeeId}/updates`).send({ section: 'emergency', data: { contacts: [{ name: 'Ravi Rao', relationship: 'Brother', phone: '+91 98200 12345' }] } }), 201);
    expect(ok(await as('asha').post(`/profile/updates/${u.id}/cancel`))).toMatchObject({ status: 'cancelled' });
    expect((ok(await as('hr').get('/approvals/inbox')) as unknown as { resourceType: string }[]).filter((i) => i.resourceType === 'profile_update')).toHaveLength(0);
    const mine = ok(await as('asha').get('/profile/updates/mine')) as unknown as { section: string; status: string }[];
    expect(mine.map((m) => `${m.section}:${m.status}`)).toEqual(expect.arrayContaining(['emergency:cancelled', 'identity:approved', 'bank:approved', 'personal:rejected', 'address:approved']));
  });
});
