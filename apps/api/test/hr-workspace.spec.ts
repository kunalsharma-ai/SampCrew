import type { INestApplication } from '@nestjs/common';
import { mongo } from '@crew/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, adminPool, api, createApp, createTenant, login, loginWithMfa, type TestDb, type TestTenant } from './helpers';

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Phase 27, through the HTTP API: background verification (internal and with an agency through its private link),
 * assets (register, assign, acknowledge, return, reports), custom fields, HR Workspace Admin (module switches and
 * the role matrix) and the bulk import of existing employees.
 */
describe('HR workspace: verification, assets, custom fields, admin and import', () => {
  let app: INestApplication;
  let pool: TestDb;
  let t: TestTenant;
  let owner: string;
  let hr: string;
  let staff: { email: string; membershipId: string };
  let staffToken: string;
  let staffEmployee: string;
  let colleague: string;

  const hire = async (token: string, body: Record<string, unknown>) => {
    const r = await api(app, token).post('/employees').send({ legalEntityId: t.legalEntityId, dateOfJoining: today(), probationMonths: 0, onboardingTemplateId: null, ...body });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.employee.id as string;
  };

  beforeAll(async () => {
    app = await createApp();
    pool = adminPool();
    t = await createTenant(pool);
    owner = (await loginWithMfa(app, pool, t.ownerEmail)).accessToken;
    const h = await addMember(pool, t, { roles: ['hr_admin'], name: 'Hina HR' });
    hr = (await loginWithMfa(app, pool, h.email)).accessToken;
    staff = await addMember(pool, t, { name: 'Sam Staff' });
    staffEmployee = await hire(hr, { firstName: 'Sam', lastName: 'Staff', membershipId: staff.membershipId });
    staffToken = (await login(app, staff.email)).accessToken;
    colleague = await hire(hr, { firstName: 'Cora', lastName: 'Colleague' });
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('background verification', () => {
    it('runs an internal case from checks to a verified result, with history and audit', async () => {
      const created = await api(app, hr).post('/bgv/cases').send({
        employeeId: colleague, method: 'internal', checks: [{ type: 'identity' }, { type: 'education' }], dueDate: today(),
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const c = created.body;
      expect(c.status).toBe('pending');
      expect(c.checks).toHaveLength(2);
      expect(c.reference).toMatch(/\w+/);

      // A case cannot be verified while a check is still open.
      const early = await api(app, hr).post(`/bgv/cases/${c.id}/decision`).send({ status: 'verified', remarks: 'All good' });
      expect(early.status).toBe(409);
      expect(early.body.error.code).toBe('checks_open');

      for (const ch of c.checks) {
        const r = await api(app, hr).patch(`/bgv/cases/${c.id}/checks/${ch.id}`).send({ status: 'verified', remarks: 'Checked against the original' });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
      }
      const done = await api(app, hr).post(`/bgv/cases/${c.id}/decision`).send({ status: 'verified', remarks: 'Every check passed' });
      expect(done.status, JSON.stringify(done.body)).toBe(201);
      expect(done.body.status).toBe('verified');
      expect(done.body.completedOn).toBe(today());
      expect(done.body.history.map((x: { action: string }) => x.action)).toEqual(expect.arrayContaining(['created', 'check_status', 'decided']));
      // A closed case no longer changes.
      expect((await api(app, hr).patch(`/bgv/cases/${c.id}/checks/${c.checks[0].id}`).send({ remarks: 'late' })).status).toBe(409);
      expect(await pool.count('audit_events', { tenant_id: t.id, resource_id: c.id, action: { $regex: '^bgv\\.' } })).toBeGreaterThan(1);

      const forEmployee = await api(app, hr).get(`/employees/${colleague}/bgv`);
      expect(forEmployee.status).toBe(200);
      expect(forEmployee.body.map((x: { id: string }) => x.id)).toContain(c.id);
    });

    it('sends a case to an agency, which sees only shared files and sends findings back through its link', async () => {
      const agency = await api(app, hr).post('/bgv/agencies').send({ name: 'Trust Check Services', email: 'desk@trustcheck.example', services: ['employment', 'address'], turnaroundDays: 7 });
      expect(agency.status, JSON.stringify(agency.body)).toBe(201);
      const created = await api(app, hr).post('/bgv/cases').send({ employeeId: colleague, method: 'external', agencyId: agency.body.id, checks: [{ type: 'employment' }] });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const id = created.body.id as string;
      const shared = await api(app, hr).post(`/bgv/cases/${id}/files`).field('title', 'Relieving letter').field('shared', 'true').attach('file', Buffer.from('%PDF-1.4 relieving letter'), { filename: 'relieving.pdf', contentType: 'application/pdf' });
      expect(shared.status, JSON.stringify(shared.body)).toBe(201);
      const hidden = await api(app, hr).post(`/bgv/cases/${id}/files`).field('title', 'Internal note').attach('file', Buffer.from('internal only'), { filename: 'note.txt', contentType: 'text/plain' });
      expect(hidden.status, JSON.stringify(hidden.body)).toBe(201);

      const sent = await api(app, hr).post(`/bgv/cases/${id}/share`).send({ agencyId: agency.body.id, expiresInDays: 10 });
      expect(sent.status, JSON.stringify(sent.body)).toBe(201);
      const token = String(sent.body.url).split('/').pop()!;
      const portal = await api(app).get(`/bgv-portal/${token}`);
      expect(portal.status, JSON.stringify(portal.body)).toBe(200);
      expect(portal.body.files.map((f: { title: string }) => f.title)).toEqual(['Relieving letter']);
      expect(portal.body.checks).toHaveLength(1);

      const findings = await api(app).post(`/bgv-portal/${token}/findings`).send({
        reporterName: 'Ravi from Trust Check', summary: 'Employment confirmed with the previous employer', checks: [{ checkId: portal.body.checks[0].id, status: 'verified', feedback: 'Dates and designation match' }],
      });
      expect(findings.status, JSON.stringify(findings.body)).toBe(201);
      const after = await api(app, hr).get(`/bgv/cases/${id}`);
      expect(after.body.checks[0]).toMatchObject({ status: 'verified', agencyFeedback: 'Dates and designation match' });
      expect(after.body.history.map((x: { action: string }) => x.action)).toContain('agency_submitted');

      // Once the link is switched off it opens nothing.
      const linkId = after.body.agencyLinks[0].id as string;
      expect((await api(app, hr).post(`/bgv/cases/${id}/links/${linkId}/revoke`)).status).toBe(201);
      expect((await api(app).get(`/bgv-portal/${token}`)).status).toBe(404);
    });

    it('is visible only to people given verification access', async () => {
      expect((await api(app, staffToken).get('/bgv/cases')).status).toBe(403);
      expect((await api(app, staffToken).get(`/employees/${staffEmployee}/bgv`)).status).toBe(403);
    });
  });

  describe('assets', () => {
    let assetId: string;
    let assignmentId: string;

    it('starts with the 15 default categories and numbers assets per category', async () => {
      const cats = await api(app, hr).get('/assets/categories');
      expect(cats.status).toBe(200);
      expect(cats.body.filter((c: { isDefault: boolean }) => c.isDefault)).toHaveLength(15);
      const custom = await api(app, hr).post('/assets/categories').send({ name: 'Lab equipment', code: 'LAB' });
      expect(custom.status, JSON.stringify(custom.body)).toBe(201);
      const first = await api(app, hr).post('/assets').send({ name: 'Oscilloscope', categoryId: custom.body.id, serialNumber: 'OSC-1', purchaseDate: '2025-01-10', warrantyExpiry: '2027-01-10', purchasePrice: '45000' });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(first.body.assetCode).toBe('LAB-0001');
      const second = await api(app, hr).post('/assets').send({ name: 'Multimeter', categoryId: custom.body.id });
      expect(second.body.assetCode).toBe('LAB-0002');
      assetId = first.body.id;
    });

    it('assigns an asset, has the employee acknowledge it, and takes it back', async () => {
      const assigned = await api(app, hr).post(`/assets/${assetId}/assign`).send({ employeeId: staffEmployee, assignedOn: today(), condition: 'new' });
      expect(assigned.status, JSON.stringify(assigned.body)).toBe(201);
      expect(assigned.body.status).toBe('assigned');
      // It cannot be given to a second person at the same time.
      expect((await api(app, hr).post(`/assets/${assetId}/assign`).send({ employeeId: colleague, assignedOn: today(), condition: 'new' })).status).toBe(409);

      const mine = await api(app, staffToken).get('/assets/mine');
      expect(mine.status, JSON.stringify(mine.body)).toBe(200);
      const held = mine.body.items.find((x: { assetId?: string; id?: string }) => (x.assetId ?? x.id) === assetId);
      expect(held).toBeTruthy();
      assignmentId = held.assignmentId;
      const ack = await api(app, staffToken).post(`/assets/assignments/${assignmentId}/acknowledge`).send({ fullName: 'Sam Staff', accept: true });
      expect(ack.status, JSON.stringify(ack.body)).toBe(201);
      const row = await pool.one('asset_assignments', { id: assignmentId });
      expect(row!.acknowledged_at).toBeTruthy();
      expect(row!.acknowledged_name).toBe('Sam Staff');

      // An employee sees only their own assets, not the register or someone else's.
      expect((await api(app, staffToken).get(`/assets/${assetId}/assign`)).status).toBeGreaterThanOrEqual(400);
      // Someone else's record is not found for them at all.
      expect([403, 404]).toContain((await api(app, staffToken).get(`/employees/${colleague}/assets`)).status);

      const returned = await api(app, hr).post(`/assets/${assetId}/return`).send({ returnedOn: today(), condition: 'good' });
      expect(returned.status, JSON.stringify(returned.body)).toBe(201);
      expect(returned.body.status).toBe('available');
      const history = await api(app, hr).get(`/employees/${staffEmployee}/assets`);
      expect(history.body.find((x: { assignmentId: string }) => x.assignmentId === assignmentId)).toMatchObject({ status: 'returned', acknowledged: true });
    });

    it('downloads every report as Excel and PDF', async () => {
      for (const kind of ['employee', 'available', 'assigned', 'returned', 'damaged_lost', 'purchases', 'maintenance', 'department']) {
        for (const format of ['xlsx', 'pdf']) {
          const r = await api(app, hr).get(`/assets/reports/${kind}.${format}`).buffer(true);
          expect(r.status, `${kind}.${format}`).toBe(200);
          expect(r.headers['content-type'], `${kind}.${format}`).toMatch(format === 'pdf' ? /pdf/ : /spreadsheet/);
        }
      }
    });

    it('hands over assets when someone already working here is added', async () => {
      const cats = (await api(app, hr).get('/assets/categories')).body as { id: string; code: string }[];
      const laptop = await api(app, hr).post('/assets').send({ name: 'ThinkPad T14', categoryId: cats.find((c) => c.code === 'LAP')?.id ?? cats[0]!.id });
      const id = await hire(hr, { firstName: 'Ola', lastName: 'Oldhand', joinedAs: 'existing', dateOfJoining: '2022-03-01', employeeCode: 'EX-0001', assetIds: [laptop.body.id] });
      const held = await api(app, hr).get(`/employees/${id}/assets`);
      expect(held.body).toEqual([expect.objectContaining({ assetId: laptop.body.id, status: 'active', requiresAcknowledgement: true })]);
      // An asset already held cannot be handed over again.
      const again = await api(app, hr).post('/employees').send({ legalEntityId: t.legalEntityId, firstName: 'Twice', lastName: 'Given', joinedAs: 'existing', dateOfJoining: '2022-03-01', probationMonths: 0, onboardingTemplateId: null, assetIds: [laptop.body.id] });
      expect(again.status).toBe(409);
      expect(await pool.count('employees', { tenant_id: t.id, first_name: 'Twice' })).toBe(0);
    });
  });

  describe('custom fields', () => {
    it('adds typed fields, checks values, keeps archived values and logs every change', async () => {
      const blood = await api(app, hr).post('/custom-fields').send({
        entity: 'employee', label: 'Blood group', type: 'dropdown', options: [{ value: 'a_pos', label: 'A+' }, { value: 'o_pos', label: 'O+' }], employeeEditable: true,
      });
      expect(blood.status, JSON.stringify(blood.body)).toBe(201);
      expect(blood.body.key).toBe('blood_group');
      const salaryBand = await api(app, hr).post('/custom-fields').send({ entity: 'employee', label: 'Band', type: 'number', viewRoles: ['hr_admin'], editRoles: ['hr_admin'] });
      expect(salaryBand.status, JSON.stringify(salaryBand.body)).toBe(201);

      const bad = await api(app, hr).put(`/custom-fields/values/employee/${staffEmployee}`).send({ values: { blood_group: 'z_neg', band: 'high' } });
      expect(bad.status).toBe(422);
      const ok = await api(app, hr).put(`/custom-fields/values/employee/${staffEmployee}`).send({ values: { blood_group: 'o_pos', band: 4 } });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);

      // The employee sees the field they may change, but not the HR-only one.
      const own = await api(app, staffToken).get(`/custom-fields/values/employee/${staffEmployee}`);
      expect(own.status).toBe(200);
      expect(own.body.map((r: { field: { key: string } }) => r.field.key)).toEqual(['blood_group']);
      expect((await api(app, staffToken).put(`/custom-fields/values/employee/${staffEmployee}`).send({ values: { band: 9 } })).status).toBeGreaterThanOrEqual(400);

      // Archiving hides the field from new records but keeps the value already saved.
      expect((await api(app, hr).post(`/custom-fields/${salaryBand.body.id}/archive`).send({ archived: true })).status).toBe(201);
      const values = await api(app, hr).get(`/custom-fields/values/employee/${staffEmployee}`);
      expect(values.body.find((r: { field: { key: string } }) => r.field.key === 'band')?.value).toBe(4);
      expect(await pool.count('custom_field_values', { tenant_id: t.id, record_id: staffEmployee })).toBe(2);

      const log = await api(app, hr).get('/custom-fields/history');
      expect(log.status).toBe(200);
      expect(log.body.length).toBeGreaterThanOrEqual(3);
      expect((await api(app, staffToken).get('/custom-fields/history')).status).toBe(403);
    });
  });

  describe('HR Workspace Admin', () => {
    it('switches a module off for everyone and back on, within the plan', async () => {
      const before = await api(app, owner).get('/hr-admin/modules');
      expect(before.status).toBe(200);
      expect(before.body.find((m: { key: string }) => m.key === 'asset_management')).toMatchObject({ inPlan: true, enabled: true });
      const core = before.body.find((m: { core: boolean }) => m.core);
      if (core) expect((await api(app, owner).put('/hr-admin/modules').send({ changes: [{ key: core.key, enabled: false }] })).status).toBeGreaterThanOrEqual(400);

      const off = await api(app, owner).put('/hr-admin/modules').send({ changes: [{ key: 'asset_management', enabled: false }] });
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      expect(off.body.find((m: { key: string }) => m.key === 'asset_management')).toMatchObject({ enabled: false, switchedOffByAdmin: true });
      const blocked = await api(app, hr).get('/assets');
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('feature_switched_off');
      const me = await api(app, hr).get('/me');
      expect(me.body.features).not.toContain('asset_management');

      expect((await api(app, owner).put('/hr-admin/modules').send({ changes: [{ key: 'asset_management', enabled: true }] })).status).toBe(200);
      expect((await api(app, hr).get('/assets')).status).toBe(200);
      expect(await pool.count('audit_events', { tenant_id: t.id, action: 'workspace.modules_changed' })).toBe(2);
    });

    it('changes what an access level can do, never Super Workspace, and resets it to its defaults', async () => {
      const matrix = await api(app, owner).get('/hr-admin/permissions');
      expect(matrix.status).toBe(200);
      expect(matrix.body.actions.map((a: { label: string }) => a.label)).toEqual(['View', 'Create', 'Edit', 'Delete', 'Approve', 'Export', 'Manage']);
      const roles = matrix.body.roles as { id: string; key: string; grants: Record<string, string>; locked: boolean }[];
      // Only the access levels are listed: the old built-in roles are kept for rollback but never shown.
      expect(roles.map((r) => r.key)).toEqual(['super_workspace', 'hr_workspace', 'employee_workspace']);
      const ownerRole = roles.find((r) => r.key === 'super_workspace')!;
      expect(ownerRole.locked).toBe(true);
      expect((await api(app, owner).put(`/hr-admin/roles/${ownerRole.id}/permissions`).send({ grants: [] })).status).toBe(400);

      const exec = roles.find((r) => r.key === 'employee_workspace')!;
      const defaults = exec.grants;
      expect(defaults['bgv:approve']).toBeUndefined();
      const grants = [...Object.entries(defaults).map(([permission, scope]) => ({ permission, scope })), { permission: 'bgv:approve', scope: 'tenant' }];
      const saved = await api(app, owner).put(`/hr-admin/roles/${exec.id}/permissions`).send({ grants });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      expect(saved.body.grants['bgv:approve']).toBe('tenant');
      const changed = (await api(app, owner).get('/hr-admin/permissions')).body.roles.find((r: { key: string }) => r.key === 'employee_workspace');
      expect(changed.customised).toBe(true);

      const reset = await api(app, owner).post(`/hr-admin/roles/${exec.id}/reset`);
      expect(reset.status, JSON.stringify(reset.body)).toBe(201);
      expect(reset.body.grants).toEqual(defaults);
      expect(await pool.count('audit_events', { tenant_id: t.id, action: { $in: ['role.permissions_changed', 'role.permissions_reset'] }, resource_id: exec.id })).toBe(2);
      // Only people allowed to manage roles can change them.
      expect((await api(app, staffToken).put(`/hr-admin/roles/${exec.id}/permissions`).send({ grants: [] })).status).toBe(403);
    });
  });

  describe('upgrading an existing workspace', () => {
    it('gives built-in roles the new permissions once, and never adds back one HR removed', async () => {
      const role = (await pool.one('roles', { tenant_id: t.id, key: 'hr_executive' }))!;
      // A workspace from before this release: the role has none of the new grants and no remembered template.
      await pool.delete('role_permissions', { role_id: role.id, permission: { $regex: '^(bgv|assets):' } });
      await (await pool.database()).collection('roles').updateOne({ _id: role.id }, { $unset: { template_grants: '' } });
      await pool.platform((tx) => mongo.syncSystemRolesMongo(tx as never));
      const after = await pool.find('role_permissions', { role_id: role.id, permission: { $regex: '^(bgv|assets):' } });
      expect(after.map((g) => g.permission).sort()).toEqual(['assets:create', 'assets:edit', 'assets:view', 'bgv:create', 'bgv:edit', 'bgv:view']);

      // HR takes one away in HR Workspace Admin; the next deploy leaves it away.
      await pool.delete('role_permissions', { role_id: role.id, permission: 'bgv:edit' });
      await pool.platform((tx) => mongo.syncSystemRolesMongo(tx as never));
      expect(await pool.count('role_permissions', { role_id: role.id, permission: 'bgv:edit' })).toBe(0);
      expect(await pool.count('role_permissions', { role_id: role.id, permission: 'bgv:view' })).toBe(1);
    });
  });

  describe('employee import', () => {
    it('checks a file without changing anything, then imports managers first with leave balances and assets', async () => {
      const tpl = await api(app, hr).get('/employees/import/template.xlsx').buffer(true);
      expect(tpl.status).toBe(200);
      expect(tpl.headers['content-type']).toMatch(/spreadsheet/);

      expect((await api(app, hr).post('/org/departments').send({ name: 'Research', legalEntityId: t.legalEntityId })).status).toBe(201);
      const cats = (await api(app, hr).get('/assets/categories')).body as { id: string; code: string }[];
      const phone = await api(app, hr).post('/assets').send({ name: 'Pixel 8', categoryId: cats.find((c) => c.code === 'MOB')?.id ?? cats[0]!.id });
      expect(phone.status, JSON.stringify(phone.body)).toBe(201);
      const csv = [
        'Employee ID,First name,Last name,Personal email,Phone,Department,Designation,Original date of joining,Reporting manager employee ID,Assets held (asset codes separated by ;)',
        `IMP-0002,Ira,Report,ira@mail.example,+91 98201 23456,Research,Research Analyst,2023-06-01,IMP-0001,${phone.body.assetCode}`,
        'IMP-0001,Mo,Manager,mo@mail.example,,Research,Team Lead,2020-01-15,,',
        'IMP-0001,Dup,Licate,dup@mail.example,,,,2020-01-15,,',
        'IMP-0003,,NoFirst,,,,,not-a-date,,',
      ].join('\n');
      const check = await api(app, hr).post('/employees/import?dryRun=true').attach('file', Buffer.from(csv), { filename: 'people.csv', contentType: 'text/csv' });
      expect(check.status, JSON.stringify(check.body)).toBe(201);
      const statuses = check.body.rows.map((r: { employeeCode: string; status: string }) => `${r.employeeCode}:${r.status}`);
      expect(statuses, JSON.stringify(check.body.rows)).toEqual(expect.arrayContaining(['IMP-0002:ok', 'IMP-0001:ok']));
      expect(check.body.rows.filter((r: { status: string }) => r.status !== 'ok')).toHaveLength(2);
      // Every problem on a row is shown at once.
      expect(check.body.rows.find((r: { row: number }) => r.row === 5).errors.map((e: { column: string }) => e.column)).toEqual(expect.arrayContaining(['First name', 'Original date of joining']));
      expect(await pool.count('employees', { tenant_id: t.id, employee_code: { $in: ['IMP-0001', 'IMP-0002'] } })).toBe(0);

      const good = csv.split('\n').slice(0, 3).join('\n');
      const run = await api(app, hr).post('/employees/import?dryRun=false').attach('file', Buffer.from(good), { filename: 'people.csv', contentType: 'text/csv' });
      expect(run.status, JSON.stringify(run.body)).toBe(201);
      expect(run.body.rows.every((r: { status: string }) => r.status === 'created')).toBe(true);
      const ira = await pool.one('employees', { tenant_id: t.id, employee_code: 'IMP-0002' });
      const mo = await pool.one('employees', { tenant_id: t.id, employee_code: 'IMP-0001' });
      expect(ira!.manager_employee_id ?? ira!.current_manager_employee_id).toBe(mo!.id);
      expect(ira!.joined_as).toBe('existing');
      expect(await pool.count('asset_assignments', { tenant_id: t.id, employee_id: ira!.id, status: 'active' })).toBe(1);
      expect(await pool.count('audit_events', { tenant_id: t.id, action: 'employee.imported' })).toBe(1);
      expect(await pool.count('audit_events', { tenant_id: t.id, action: 'employee.created', resource_id: { $in: [ira!.id, mo!.id] } })).toBe(2);

      // Importing the same file again finds the people already there.
      const again = await api(app, hr).post('/employees/import?dryRun=true').attach('file', Buffer.from(good), { filename: 'people.csv', contentType: 'text/csv' });
      expect(again.body.rows.every((r: { status: string }) => r.status === 'duplicate' || r.status === 'error')).toBe(true);
      expect((await api(app, staffToken).post('/employees/import?dryRun=true').attach('file', Buffer.from(good), { filename: 'people.csv', contentType: 'text/csv' })).status).toBe(403);
    });
  });
});
